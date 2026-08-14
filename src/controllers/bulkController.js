import { randomUUID } from "crypto";
import { query, getClient } from "../config/database.js";
import transporter from "../services/email.js";
import { getRazorpay } from "../config/razorpay.js";
import { verifyPaymentSignature } from "../utils/razorpay.js";
import { getNextBulkBookingNumber } from "../utils/bulkBookingNumber.js";
import { logBulkCommunication } from "../utils/bulkCommunicationLog.js";
import {
  createOrderFromBulkBooking,
  BulkBookingNotFoundError,
  BulkOrderValidationError,
} from "../services/bulkOrderService.js";
import {
  notifyBulkEnquirySubmitted,
  notifyQuoteReady,
  notifyBulkOrderConfirmation,
  notifyBulkDispatch,
} from "../services/bulkNotificationService.js";

// ==========================================================================
// Constants
// ==========================================================================

// Valid statuses for bulk bookings — unchanged from the original list, so
// the existing admin UI's status dropdown keeps working unmodified.
const VALID_STATUSES = [
  "new",
  "in_progress",
  "quoted",
  "confirmed",
  "completed",
  "cancelled",
];

// ==========================================================================
// Helpers
// ==========================================================================

/** Sends a JSON response with the given status and body. */
const sendJson = (res, status, body) => res.status(status).json(body);

/** Trims a string field, returning null for empty/whitespace-only input. */
const trimOrNull = (value) => {
  if (value === undefined || value === null) return value;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
};

/** Basic email format check. */
const isValidEmailFormat = (value) =>
  /^\S+@\S+\.\S+$/.test(String(value || "").trim());

/** Mobile number: digits only, exactly 10 digits. */
const isValidMobileFormat = (value) =>
  /^\d{10}$/.test(String(value || "").trim());

/** Indian PIN code: exactly 6 digits — same rule shippingController.js uses for orders. */
const isValidPincodeFormat = (value) =>
  /^\d{6}$/.test(String(value || "").trim());

/**
 * FIX: Razorpay rejects `receipt` values longer than 40 characters
 * ("the length must be no more than 40"). The previous `bulk_${id}` value
 * used the full 36-character booking UUID, producing a 41-character
 * receipt that failed on every single call. `bulk_booking_number` (e.g.
 * "BB-100001") is short, unique per booking, and deterministic — the ideal
 * receipt value. Falls back to a truncated id only for the (now
 * theoretical, since createBulkBooking always generates one) case where a
 * booking has no number yet.
 */
const buildBulkReceipt = (booking) => {
  const raw = String(booking.bulk_booking_number || booking.id).replace(
    /[^a-zA-Z0-9_-]/g,
    "",
  );
  return `bulk_${raw}`.slice(0, 40);
};

/** True if value is a finite number strictly greater than 0. */
const isValidPositiveNumber = (value) => {
  if (value === undefined || value === null || value === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
};

/** True if value is a finite integer strictly greater than 0. */
const isValidPositiveInteger = (value) => {
  if (value === undefined || value === null || value === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0;
};

/** Minimal HTML-escaping for user-supplied strings interpolated into email templates. */
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );

/**
 * Loads a bulk_bookings row by id, or null. Centralized so every handler
 * that needs the current row (for read-only checks, notifications, etc.)
 * fetches it the same way.
 */
const findBulkBooking = async (id) => {
  const { rows } = await query("SELECT * FROM bulk_bookings WHERE id = ?", [
    id,
  ]);
  return rows[0] || null;
};

/**
 * Loads a bulk_bookings row plus its communication_history array, for every
 * response that feeds the admin detail modal.
 */
const findBulkBookingWithHistory = async (id) => {
  const booking = await findBulkBooking(id);
  if (!booking) return null;

  try {
    const { rows } = await query(
      `SELECT type, label, sent_by, sent_at
       FROM bulk_booking_communications
       WHERE bulk_booking_id = ?
       ORDER BY sent_at ASC`,
      [id],
    );
    booking.communication_history = rows;
  } catch (err) {
    console.error("[BULK] Failed to load communication history", {
      bulkBookingId: id,
      error: err?.message,
    });
    booking.communication_history = [];
  }

  return booking;
};

// FIX (audit): server-side status-transition validation previously didn't
// exist at all — only the admin frontend's dropdown (isValidTransition in
// admin/BulkOrders.js) blocked non-adjacent jumps, and only for THAT one
// code path. A direct API call (or the frontend's own "Send Quote" /
// "Quick Actions" buttons, which call the PUT endpoint through separate
// code paths) had nothing stopping it from setting status="completed" on a
// booking that was never quoted, paid, or confirmed.
//
// This does NOT copy the frontend's strict "exactly one step forward" rule
// verbatim — that rule is stricter than the frontend's own actual behavior.
// admin/BulkOrders.js's handleSendQuote() intentionally moves status
// directly from "new" OR "in_progress" to "quoted" (STATUS_VISIBLE_ACTIONS
// exposes "Send Quote" for both), bypassing isValidTransition entirely. A
// verbatim adjacent-only copy would have made that legitimate, commonly-used
// action fail. This mirrors what the UI actually *does*, not what one of its
// two enforcement paths (the manual status dropdown) claims the rule is.
//
// "confirmed" needs no entry here: it's already fully gated by the
// quote_approved / payment_status === 'paid' checks in the status ===
// "confirmed" branch below, regardless of the prior status.
const STATUS_ORDER_INDEX = {
  new: 0,
  in_progress: 1,
  quoted: 2,
  confirmed: 3,
  completed: 4,
};

const isValidStatusTransition = (current, next) => {
  if (!current || !next || next === current) return true;

  if (next === "cancelled") {
    return current !== "completed" && current !== "cancelled";
  }

  if (current === "cancelled" || current === "completed") return false;

  if (next === "confirmed") return true; // gated separately below
  if (next === "quoted") return ["new", "in_progress"].includes(current);

  // Everything else ("in_progress", "completed") must move forward exactly
  // one step — this also rejects any backward move (e.g. "quoted" -> "new").
  const currentIdx = STATUS_ORDER_INDEX[current];
  const nextIdx = STATUS_ORDER_INDEX[next];
  if (currentIdx === undefined || nextIdx === undefined) return false;

  return nextIdx === currentIdx + 1;
};

/**
 * Bulk Booking read-only guard: once an order has been created from a
 * booking (order_created = 1), the booking must not be mutated further —
 * only viewed. Returns true (and sends the 409 response) if the booking is
 * locked; the caller should stop processing in that case.
 */
const rejectIfReadOnly = (res, booking) => {
  if (booking?.order_created) {
    sendJson(res, 409, {
      success: false,
      message:
        "This bulk booking is read-only — an order has already been created from it.",
      data: { bulkBookingId: booking.id, orderId: booking.created_order_id },
    });
    return true;
  }
  return false;
};

// ==========================================================================
// CREATE BULK BOOKING (customer, public)
// ==========================================================================

/**
 * Create a new bulk booking from customer form.
 * Unchanged behavior/response, plus a customer-facing "enquiry submitted"
 * notification (email + WhatsApp) alongside the existing internal
 * admin-notification email.
 *
 * companyName / contactPerson / location / requirements are trimmed before
 * validation, persistence, and notification. email and mobileNumber are
 * normalized (trimmed, email lowercased) before validation and saving.
 * quantity (if supplied) must be a positive integer.
 */
export const createBulkBooking = async (req, res) => {
  try {
    const {
      companyName: companyNameRaw,
      contactPerson: contactPersonRaw,
      email,
      mobileNumber,
      location: locationRaw,
      quantity,
      requirements: requirementsRaw,
      addressLine1: addressLine1Raw,
      addressLine2: addressLine2Raw,
      city: cityRaw,
      state: stateRaw,
      pincode: pincodeRaw,
      country: countryRaw,
    } = req.body;

    const companyName = trimOrNull(companyNameRaw);
    const contactPerson = trimOrNull(contactPersonRaw);
    // `location` is kept as-is for backward compatibility (free-text,
    // optional) — it is no longer the delivery address of record; the
    // structured fields below are.
    const location = trimOrNull(locationRaw);
    const requirements = trimOrNull(requirementsRaw);

    // The delivery address is collected once, here, at submission time —
    // it's the sole source of truth for delivery. Razorpay Standard
    // Checkout (the bulk payment flow) never asks for it again.
    const addressLine1 = trimOrNull(addressLine1Raw);
    const addressLine2 = trimOrNull(addressLine2Raw);
    const city = trimOrNull(cityRaw);
    const state = trimOrNull(stateRaw);
    const pincode = trimOrNull(pincodeRaw);
    const country = trimOrNull(countryRaw) || "India";

    if (
      !companyName ||
      !contactPerson ||
      !email ||
      !mobileNumber ||
      !addressLine1 ||
      !city ||
      !state ||
      !pincode
    ) {
      return res.status(400).json({
        message: "Please fill all required fields",
      });
    }

    if (!isValidPincodeFormat(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid pincode. Must be a 6-digit PIN code.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedMobile = mobileNumber.trim();

    // Quantity remains optional — only validated when supplied.
    if (
      quantity !== undefined &&
      quantity !== null &&
      quantity !== "" &&
      !isValidPositiveInteger(quantity)
    ) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be greater than 0.",
      });
    }

    if (!isValidEmailFormat(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address.",
      });
    }

    if (!isValidMobileFormat(normalizedMobile)) {
      return res.status(400).json({
        success: false,
        message: "Invalid mobile number.",
      });
    }

    const bookingId = randomUUID();

    // FIX (audit): bulk_booking_number was referenced throughout the codebase
    // (bulkOrderService, the payment-details response) but never generated —
    // every read fell back silently to the raw UUID. Generated the same
    // race-safe way as orders.order_number: LAST_INSERT_ID() on a dedicated
    // connection, so it must run on the same client as the counter UPDATE.
    const client = await getClient();
    let bookingNumber;
    try {
      bookingNumber = await getNextBulkBookingNumber(client);

      await client.query(
        `INSERT INTO bulk_bookings
        (
          id,
          bulk_booking_number,
          company_name,
          contact_person,
          email,
          mobile_number,
          location,
          quantity,
          requirements,
          status,
          address_line1,
          address_line2,
          city,
          state,
          pincode,
          country
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bookingId,
          bookingNumber,
          companyName,
          contactPerson,
          normalizedEmail,
          normalizedMobile,
          location,
          quantity || null,
          requirements || null,
          "new",
          addressLine1,
          addressLine2,
          city,
          state,
          pincode,
          country,
        ],
      );
    } finally {
      client.release();
    }

    // Existing internal admin-notification email — template unchanged aside
    // from HTML-escaping the user-supplied fields; wrapped so a failure here
    // never fails booking creation.
    try {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: "bree.fit.india@gmail.com",
        subject: "New Bulk Booking Request",
        html: `
        <h2>New Bulk Booking Request</h2>

        <p><strong>Company:</strong> ${escapeHtml(companyName)}</p>
        <p><strong>Contact Person:</strong> ${escapeHtml(contactPerson)}</p>
        <p><strong>Email:</strong> ${normalizedEmail}</p>
        <p><strong>Mobile:</strong> ${normalizedMobile}</p>
        <p><strong>Location:</strong> ${escapeHtml(location)}</p>
        <p><strong>Quantity:</strong> ${quantity}</p>
        <p><strong>Requirements:</strong> ${escapeHtml(requirements)}</p>
      `,
      });
    } catch (err) {
      console.error("❌ Bulk booking admin notification email failed:", err);
    }

    // New: customer-facing "enquiry submitted" notification. Fire-and-forget
    // — a notification failure must never fail the enquiry submission.
    notifyBulkEnquirySubmitted({
      email: normalizedEmail,
      mobileNumber: normalizedMobile,
      contactPerson,
      companyName,
    }).catch((err) =>
      console.error(
        "[BULK] enquiry-submitted notification failed",
        err?.message,
      ),
    );

    res.status(201).json({
      success: true,
      message:
        "Quote request submitted successfully. Our team will contact you soon.",
      bookingId,
      bookingNumber,
    });
  } catch (error) {
    console.error("❌ Error creating bulk booking:", error);

    res.status(500).json({
      message: "Internal server error",
    });
  }
};

// ==========================================================================
// GET BULK BOOKINGS (admin)
// ==========================================================================

/**
 * Get all bulk bookings with pagination and search. Unchanged.
 */
export const getBulkBookings = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const search = req.query.search?.trim() || "";

    const offset = (page - 1) * limit;

    let whereClause = "1=1";
    const params = [];

    // Search in company_name, contact_person, email, mobile_number
    if (search) {
      whereClause += ` AND (
        company_name LIKE ? OR 
        contact_person LIKE ? OR 
        email LIKE ? OR 
        mobile_number LIKE ?
      )`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Get total count
    const countResult = await query(
      `
      SELECT COUNT(*) as total
      FROM bulk_bookings
      WHERE ${whereClause}
    `,
      params,
    );

    const total = countResult.rows[0]?.total || 0;

    // Get paginated results
    const result = await query(
      `
      SELECT *
      FROM bulk_bookings
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
      [...params, limit, offset],
    );

    const bookings = result.rows;

    res.status(200).json({
      success: true,
      data: bookings,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("❌ Error fetching bulk bookings:", error.message);
    console.error("Stack:", error.stack);

    res.status(500).json({
      success: false,
      message: "Failed to fetch bulk bookings",
    });
  }
};

// ==========================================================================
// GET SINGLE BULK BOOKING (admin)
// ==========================================================================

/**
 * Get single bulk booking details. Unchanged response shape; if an order
 * has been created from this booking, the linked order's number/status is
 * attached so the admin can open it without a second lookup.
 */
export const getBulkBooking = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID required",
      });
    }

    const booking = await findBulkBookingWithHistory(id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Bulk booking not found",
      });
    }

    // Best-effort: attach the linked order's summary for admin convenience.
    // Never fails the request — the booking row itself is always returned.
    let linkedOrder = null;
    if (booking.order_created && booking.created_order_id) {
      try {
        const { rows: orderRows } = await query(
          "SELECT id, order_number, order_status, payment_status, total FROM orders WHERE id = ?",
          [booking.created_order_id],
        );
        linkedOrder = orderRows[0] || null;
      } catch (lookupErr) {
        console.error(
          "[BULK] Failed to load linked order summary",
          lookupErr?.message,
        );
      }
    }

    res.status(200).json({
      success: true,
      data: booking,
      linkedOrder,
    });
  } catch (error) {
    console.error("❌ Error fetching bulk booking:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch bulk booking",
    });
  }
};

// ==========================================================================
// UPDATE BULK BOOKING (admin only)
// ==========================================================================

/**
 * Update bulk booking (admin only).
 *
 * Behavior additions over the original:
 *  - Read-only guard: once order_created = 1, no further updates are
 *    accepted (view only).
 *  - status = 'confirmed' is no longer a plain field update. It validates
 *    and locks the booking row inside a transaction (BEGIN → FOR UPDATE →
 *    pre-confirm field updates → COMMIT) to prevent two admins from
 *    confirming the same booking concurrently, then — once that
 *    transaction has committed and released its lock — creates the order
 *    via the reusable bulkOrderService (unchanged; that call manages its
 *    own transaction and idempotency).
 *  - status = 'quoted' with a valid positive numeric quote_price triggers
 *    the "quote ready" customer notification and a "Quote shared
 *    successfully" response instead of the generic update message.
 */
export const updateBulkBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, quote_price, delivery_date, admin_notes } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID required",
      });
    }

    // Validate status if provided
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    // Validate delivery_date format if provided
    if (delivery_date) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(delivery_date)) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format. Use YYYY-MM-DD",
        });
      }

      // Delivery date cannot be earlier than today's date
      const todayStr = new Date().toISOString().slice(0, 10);
      if (delivery_date < todayStr) {
        return res.status(400).json({
          success: false,
          message: "Delivery date cannot be in the past.",
        });
      }
    }

    // Validate quote_price if provided (must be a valid number greater than 0)
    if (quote_price !== undefined && quote_price !== null) {
      if (typeof quote_price === "string" && quote_price.trim() === "") {
        return res.status(400).json({
          success: false,
          message: "Invalid quote price",
        });
      }

      if (!isValidPositiveNumber(quote_price)) {
        return res.status(400).json({
          success: false,
          message: "Invalid quote price. Quote price must be greater than 0.",
        });
      }
    }

    // Check if booking exists
    const existing = await findBulkBooking(id);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Bulk booking not found",
      });
    }

    // Read-only guard: block ALL updates once an order exists for this booking.
    if (rejectIfReadOnly(res, existing)) return;

    // FIX (audit): status-sequence validation previously existed only in the
    // admin frontend (isValidTransition in admin/BulkOrders.js) — a direct
    // API call could skip stages (e.g. "new" straight to "completed") or move
    // backward. Enforced here too so the rule can't be bypassed off-UI.
    if (
      status !== undefined &&
      !isValidStatusTransition(existing.status, status)
    ) {
      return res.status(400).json({
        success: false,
        message: `Cannot move from "${existing.status}" to "${status}" directly.`,
      });
    }

    // ── Special path: confirming the booking creates a normal Order ────────
    // Validation + row lock + pre-confirm field updates happen inside a
    // transaction to prevent two admins from confirming the same booking at
    // once. Order creation itself (createOrderFromBulkBooking) runs AFTER
    // this transaction commits and releases its lock — it owns its own
    // transaction/connection and is already idempotent, so calling it while
    // still holding this lock would deadlock against itself.
    if (status === "confirmed") {
      const client = await getClient();
      let earlyResponse = null;

      try {
        await client.query("BEGIN");

        const { rows: lockedRows } = await client.query(
          "SELECT * FROM bulk_bookings WHERE id = ? FOR UPDATE",
          [id],
        );
        const locked = lockedRows[0];

        if (!locked) {
          await client.query("ROLLBACK");
          earlyResponse = {
            status: 404,
            body: { success: false, message: "Bulk booking not found" },
          };
        } else if (locked.order_created) {
          await client.query("ROLLBACK");
          earlyResponse = {
            status: 409,
            body: {
              success: false,
              message:
                "This bulk booking is read-only — an order has already been created from it.",
              data: {
                bulkBookingId: locked.id,
                orderId: locked.created_order_id,
              },
            },
          };
        } else {
          const effectiveQuotePrice =
            quote_price !== undefined && quote_price !== null
              ? parseFloat(quote_price)
              : locked.quote_price !== null
                ? Number(locked.quote_price)
                : null;
          const effectiveDeliveryDate = delivery_date ?? locked.delivery_date;

          if (!isValidPositiveNumber(effectiveQuotePrice)) {
            await client.query("ROLLBACK");
            earlyResponse = {
              status: 400,
              body: {
                success: false,
                message: "Cannot confirm booking without a valid quote price.",
              },
            };
          } else if (!effectiveDeliveryDate) {
            await client.query("ROLLBACK");
            earlyResponse = {
              status: 400,
              body: {
                success: false,
                message: "Cannot confirm booking without a delivery date.",
              },
            };
          } else if (!locked.quote_approved) {
            await client.query("ROLLBACK");
            earlyResponse = {
              status: 400,
              body: {
                success: false,
                message:
                  "Cannot confirm booking before the customer approves the quotation.",
              },
            };
          } else if (locked.payment_status !== "paid") {
            await client.query("ROLLBACK");
            earlyResponse = {
              status: 400,
              body: {
                success: false,
                message: "Cannot confirm booking before payment is verified.",
              },
            };
          } else {
            // Persist any quote_price/delivery_date/admin_notes changes sent
            // alongside the confirm request *before* attempting order
            // creation, so the order is built from the latest values.
            const preConfirmUpdates = [];
            const preConfirmParams = [];
            if (quote_price !== undefined) {
              preConfirmUpdates.push("quote_price = ?");
              preConfirmParams.push(parseFloat(quote_price));
            }
            if (delivery_date !== undefined) {
              preConfirmUpdates.push("delivery_date = ?");
              preConfirmParams.push(delivery_date);
            }
            if (admin_notes !== undefined) {
              const trimmedNotes =
                admin_notes === null ? null : String(admin_notes).trim();
              preConfirmUpdates.push("admin_notes = ?");
              preConfirmParams.push(trimmedNotes === "" ? null : trimmedNotes);
            }
            if (preConfirmUpdates.length) {
              preConfirmUpdates.push("updated_at = NOW()");
              preConfirmParams.push(id);
              await client.query(
                `UPDATE bulk_bookings SET ${preConfirmUpdates.join(", ")} WHERE id = ?`,
                preConfirmParams,
              );
            }

            await client.query("COMMIT");
          }
        }
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(
          "❌ Error validating/locking bulk booking for confirmation:",
          err,
        );
        return res.status(500).json({
          success: false,
          message: "Failed to confirm booking",
        });
      } finally {
        client.release();
      }

      if (earlyResponse) {
        return res.status(earlyResponse.status).json(earlyResponse.body);
      }

      try {
        const result = await createOrderFromBulkBooking(id, {
          changedBy: req.admin?.id || null,
        });

        if (result.alreadyExists) {
          return res.status(200).json({
            success: true,
            message: "Order already exists for this Bulk Booking",
            data: { bulkBookingId: id, orderId: result.orderId },
          });
        }

        const updatedBooking = await findBulkBookingWithHistory(id);

        console.info("[BULK] Order created", {
          bulkBookingId: id,
          orderId: result.orderId,
          orderNumber: result.orderNumber,
        });

        return res.status(200).json({
          success: true,
          message: "Bulk Booking confirmed and Order created successfully",
          data: updatedBooking,
          order: { id: result.orderId, orderNumber: result.orderNumber },
        });
      } catch (err) {
        if (err instanceof BulkBookingNotFoundError) {
          return res.status(404).json({ success: false, message: err.message });
        }
        if (err instanceof BulkOrderValidationError) {
          return res.status(400).json({ success: false, message: err.message });
        }

        console.error("❌ Error creating order from bulk booking:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to create Order",
        });
      }
    }

    // ── Generic field update path (status !== 'confirmed') ─────────────────
    const updates = [];
    const params = [];

    if (status !== undefined) {
      updates.push("status = ?");
      params.push(status);
    }

    if (quote_price !== undefined) {
      updates.push("quote_price = ?");
      params.push(quote_price === null ? null : parseFloat(quote_price));
    }

    if (delivery_date !== undefined) {
      updates.push("delivery_date = ?");
      params.push(delivery_date === null ? null : delivery_date);
    }

    if (admin_notes !== undefined) {
      // Trim whitespace; store NULL if the trimmed value is empty
      const trimmedNotes =
        admin_notes === null ? null : String(admin_notes).trim();
      updates.push("admin_notes = ?");
      params.push(
        trimmedNotes === null || trimmedNotes === "" ? null : trimmedNotes,
      );
    }

    // Sharing a quote: status moves to 'quoted' with an explicit, valid,
    // positive numeric quote price present (replaces the previous truthy
    // check, which would have treated e.g. "0" or non-numeric strings
    // inconsistently).
    const quotePriceCandidate =
      quote_price !== undefined ? quote_price : existing.quote_price;
    const isSharingQuote =
      status === "quoted" && isValidPositiveNumber(quotePriceCandidate);

    if (isSharingQuote) {
      updates.push("quote_shared_at = NOW()");
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    // Always update updated_at
    updates.push("updated_at = NOW()");
    params.push(id);

    try {
      await query(
        `
        UPDATE bulk_bookings
        SET ${updates.join(", ")}
        WHERE id = ?
      `,
        params,
      );
    } catch (updateErr) {
      // If update fails due to missing columns (migration not applied)
      if (updateErr.message && updateErr.message.includes("Unknown column")) {
        console.warn(
          "⚠️ CRM workflow columns not available (migration pending)",
        );
        return res.status(400).json({
          success: false,
          message:
            "CRM workflow features require database migration. Please apply migration 006_bulk_bookings_workflow.sql",
        });
      }
      throw updateErr;
    }

    // Fetch updated booking
    const updated = await findBulkBookingWithHistory(id);

    if (isSharingQuote) {
      notifyQuoteReady({
        email: updated.email,
        mobileNumber: updated.mobile_number,
        contactPerson: updated.contact_person,
        quotePrice: updated.quote_price,
        deliveryDate: updated.delivery_date,
        bookingId: id,
      }).catch((err) =>
        console.error("[BULK] quote-ready notification failed", err?.message),
      );
      logBulkCommunication(id, "quote", "Quote Sent", req.admin?.id);

      return res.status(200).json({
        success: true,
        message: "Quote shared successfully",
        data: updated,
      });
    }

    res.status(200).json({
      success: true,
      message: "Bulk booking updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("❌ Error updating bulk booking:", error);

    res.status(500).json({
      success: false,
      message: "Failed to update bulk booking",
    });
  }
};

// ==========================================================================
// APPROVE QUOTATION (customer, public)
// ==========================================================================

/**
 * Customer approves the shared quotation, unlocking the payment-link step.
 * Idempotent: if the quote is already approved, returns success without
 * touching quote_approved_at again.
 *
 * @route POST /api/bulk-bookings/:id/approve-quote
 */
export const approveBulkQuote = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await findBulkBooking(id);

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Bulk booking not found" });
    }
    if (rejectIfReadOnly(res, booking)) return;

    if (!booking.quote_price || booking.status !== "quoted") {
      return res.status(400).json({
        success: false,
        message: "No quote is available to approve for this booking yet.",
      });
    }

    // Already approved — return success as-is, don't re-stamp quote_approved_at.
    if (booking.quote_approved) {
      return res.status(200).json({
        success: true,
        message: "Quotation approved successfully",
        data: booking,
      });
    }

    await query(
      "UPDATE bulk_bookings SET quote_approved = 1, quote_approved_at = NOW(), updated_at = NOW() WHERE id = ?",
      [id],
    );

    const updated = await findBulkBooking(id);

    console.info("[BULK] Quote Approved", { bulkBookingId: id });

    res.status(200).json({
      success: true,
      message: "Quotation approved successfully",
      data: updated,
    });
  } catch (error) {
    console.error("❌ Error approving bulk quote:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to approve quotation" });
  }
};

// ==========================================================================
// GET QUOTE FOR APPROVAL (customer, public)
// ==========================================================================

/**
 * FIX (audit): bulkNotificationService.notifyQuoteReady emails the customer
 * a link to `/bulk-order/:id` so they can review and approve the quote, but
 * no public endpoint ever existed to fetch the quote for that page — the
 * only GET for a single booking was the admin-only getBulkBooking, and the
 * customer-facing getBulkPaymentDetails requires quote_approved to already
 * be true (a chicken-and-egg problem). This is the missing piece: a public,
 * read-only endpoint exposing just enough for the approval page, gated the
 * same way approveBulkQuote is (quote must exist and status must be
 * "quoted").
 *
 * @route GET /api/bulk-bookings/:id/quote
 */
export const getBulkQuoteForApproval = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await findBulkBooking(id);

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Bulk booking not found" });
    }

    if (booking.order_created) {
      return res.status(409).json({
        success: false,
        message: "This booking has already been converted into an Order.",
        data: { bulkBookingId: booking.id, orderId: booking.created_order_id },
      });
    }

    if (!booking.quote_price || Number(booking.quote_price) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quotation has not been shared yet.",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        bookingId: booking.id,
        bookingNumber: booking.bulk_booking_number,
        companyName: booking.company_name,
        contactPerson: booking.contact_person,
        email: booking.email,
        mobileNumber: booking.mobile_number,
        location: booking.location,
        quantity: booking.quantity,
        requirements: booking.requirements,
        status: booking.status,
        quotePrice: booking.quote_price,
        deliveryDate: booking.delivery_date,
        quoteApproved: Boolean(booking.quote_approved),
        quoteApprovedAt: booking.quote_approved_at,
        quoteSharedAt: booking.quote_shared_at,
        paymentStatus: booking.payment_status,
        // Lets the page skip straight to "already approved" / "go to
        // payment" messaging instead of re-showing the Approve button.
        canApprove: booking.status === "quoted" && !booking.quote_approved,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching bulk quote for approval:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch quote details" });
  }
};

// ==========================================================================
// SHARE PAYMENT LINK (admin only)
// ==========================================================================

/**
 * Admin generates a Razorpay order (Standard Checkout — a plain Razorpay
 * Order, no Magic Checkout) for the approved quote and notifies the
 * customer. The frontend uses the returned razorpay_order_id to open
 * Razorpay Checkout; the customer's browser then calls verifyBulkPayment.
 * No address is collected here or in the checkout popup — the bulk
 * booking's own delivery address (collected at submission time) is what
 * the created Order uses.
 *
 * If a Razorpay order already exists for this booking (payment still
 * pending), it's reused instead of creating a new one — and the
 * notification isn't re-sent, to avoid spamming the customer with repeat
 * "complete your payment" messages every time admin re-opens this action.
 *
 * @route POST /api/admin/bulk-bookings/:id/share-payment-link
 */
/**
 * FIX (customer payment page 400): the only way a Razorpay order ever got
 * created for a bulk booking was the admin's explicit "Send Payment Link"
 * click — getBulkPaymentDetails (the customer-facing GET the payment page
 * calls) just hard-failed with "Payment link has not been shared yet." if
 * razorpay_order_id was still null. That's exactly the 400 a customer hits
 * landing on /bulk-order/:id/pay right after approving a quote, before any
 * admin has touched it.
 *
 * This is the shared "create-the-Razorpay-order-if-one-doesn't-exist-yet"
 * logic so BOTH callers — the admin's explicit action AND the customer's
 * page load — go through the exact same Razorpay Standard Checkout
 * mechanism (a plain Razorpay Order; no Magic Checkout, no line_items — the
 * delivery address comes from the bulk booking itself, collected once at
 * submission time, not from anything Razorpay's checkout UI collects).
 *
 * Returns `{ ok: true, booking, razorpayOrderId, created }` on success —
 * `created` is true only when THIS call is the one that made a new Razorpay
 * order (false when an existing one was reused), so callers can decide
 * whether to fire a "payment link shared" notification.
 *
 * Returns `{ ok: false, code, booking }` on a validation failure — `code` is
 * one of NOT_FOUND / READ_ONLY / INVALID_QUOTE / NOT_APPROVED / ALREADY_PAID
 * so each caller can render its own wording for the same underlying
 * condition (an admin sharing a link and a customer loading a page warrant
 * different phrasing for "you can't pay yet").
 *
 * Throws only on an unexpected DB/Razorpay error — callers should still
 * wrap calls in their own try/catch for a 500 response.
 */
const ensureBulkRazorpayOrder = async (id) => {
  // ── Phase 1 transaction: lock the row, validate, and decide whether a
  // *new* Razorpay order is needed. Released immediately afterward — the
  // external Razorpay call below must never run while this lock (and the
  // pooled connection) is held. ─────────────────────────────────────────
  const phase1 = await getClient();
  let razorpayOrderId;
  let needsRazorpayOrder = false;
  let lockedQuotePrice;
  let lockedBookingSnapshot;

  try {
    await phase1.query("BEGIN");

    const { rows: lockedRows } = await phase1.query(
      "SELECT * FROM bulk_bookings WHERE id = ? FOR UPDATE",
      [id],
    );
    const locked = lockedRows[0];

    if (!locked) {
      await phase1.query("ROLLBACK");
      return { ok: false, code: "NOT_FOUND" };
    }
    if (locked.order_created) {
      await phase1.query("ROLLBACK");
      return { ok: false, code: "READ_ONLY", booking: locked };
    }
    if (!locked.quote_price || Number(locked.quote_price) <= 0) {
      await phase1.query("ROLLBACK");
      return { ok: false, code: "INVALID_QUOTE" };
    }
    if (!locked.quote_approved) {
      await phase1.query("ROLLBACK");
      return { ok: false, code: "NOT_APPROVED" };
    }
    if (locked.payment_status === "paid") {
      await phase1.query("ROLLBACK");
      return { ok: false, code: "ALREADY_PAID", booking: locked };
    }

    razorpayOrderId = locked.razorpay_order_id;
    lockedQuotePrice = locked.quote_price;
    lockedBookingSnapshot = locked;
    if (!razorpayOrderId) needsRazorpayOrder = true;

    await phase1.query("COMMIT");
  } catch (err) {
    await phase1.query("ROLLBACK");
    throw err;
  } finally {
    phase1.release();
  }

  let created = false;

  // The Razorpay order-create HTTP call runs with NO DB transaction open —
  // holding a row lock/pooled connection across a third-party network round
  // trip blocks any other request touching this booking row for no reason.
  // The result is persisted in a short phase-2 transaction below.
  if (needsRazorpayOrder) {
    const amountPaise = Math.round(Number(lockedQuotePrice) * 100);
    const razorpay = getRazorpay();

    // FIX (Standard Checkout for Bulk Orders): the customer already supplies
    // the complete delivery address at booking-submission time — there is
    // nothing for Razorpay's checkout UI to collect, so this is a plain
    // Razorpay Order (Standard Checkout), not Magic Checkout. No line_items
    // / line_items_total — those only mattered for Magic Checkout's
    // in-popup order summary and its account-wide Shipping Info webhook
    // dependency, neither of which applies here.
    const rzpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: buildBulkReceipt(lockedBookingSnapshot),
      notes: { bulk_booking_id: id },
    });

    // ── Phase 2 transaction: persist it, guarding against a concurrent
    // caller (admin AND/OR customer page load) having done the same thing
    // between phase 1 and now — this is exactly what makes a page refresh
    // safe to call this repeatedly without ever creating two orders. ──────
    const phase2 = await getClient();
    try {
      await phase2.query("BEGIN");

      const { rows: relockedRows } = await phase2.query(
        "SELECT razorpay_order_id FROM bulk_bookings WHERE id = ? FOR UPDATE",
        [id],
      );
      const relocked = relockedRows[0];

      if (relocked?.razorpay_order_id) {
        // Another concurrent request already wrote one first. Use theirs;
        // ours simply goes unused on Razorpay's side (it expires untouched
        // — no charge, no cleanup needed).
        razorpayOrderId = relocked.razorpay_order_id;
        await phase2.query("COMMIT");
      } else {
        razorpayOrderId = rzpOrder.id;
        await phase2.query(
          "UPDATE bulk_bookings SET razorpay_order_id = ?, payment_link_shared_at = NOW(), updated_at = NOW() WHERE id = ?",
          [razorpayOrderId, id],
        );
        await phase2.query("COMMIT");
        created = true;
      }
    } catch (err) {
      await phase2.query("ROLLBACK");
      throw err;
    } finally {
      phase2.release();
    }
  } else {
    console.info("[BULK] Reusing existing Razorpay order", {
      bookingId: id,
      razorpayOrderId,
    });
  }

  const booking = await findBulkBooking(id);
  return { ok: true, booking, razorpayOrderId, created };
};



// ==========================================================================
// SEND CONFIRMATION (admin only)
// ==========================================================================

/**
 * FIX (audit — missing integration): admin/BulkOrders.js has always posted to
 * this endpoint for the "Send Confirmation" action (visible once status is
 * "confirmed" or "completed"), but the endpoint never existed on the
 * backend — every click 404'd. Deliberately allowed even though the booking
 * is read-only (order_created = 1) by that point: this only sends a
 * notification and logs it, it does not mutate the booking's business
 * fields, so the same read-only guard that protects those fields doesn't
 * apply here.
 *
 * @route POST /api/admin/bulk-bookings/:id/send-confirmation
 */
export const sendBulkConfirmation = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await findBulkBooking(id);

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Bulk booking not found" });
    }

    if (!["confirmed", "completed"].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `Confirmation isn't applicable for a booking that's "${booking.status}".`,
      });
    }

    let orderNumber = null;
    if (booking.created_order_id) {
      const { rows } = await query(
        "SELECT order_number FROM orders WHERE id = ?",
        [booking.created_order_id],
      );
      orderNumber = rows[0]?.order_number || null;
    }

    await notifyBulkOrderConfirmation({
      email: booking.email,
      mobileNumber: booking.mobile_number,
      contactPerson: booking.contact_person,
      orderNumber,
      quotePrice: booking.quote_price,
    });
    await logBulkCommunication(id, "confirmation", "Confirmation Sent", req.admin?.id);

    const updated = await findBulkBookingWithHistory(id);

    res.status(200).json({
      success: true,
      message: "Confirmation sent successfully",
      data: updated,
    });
  } catch (error) {
    console.error("❌ Error sending bulk confirmation:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to send confirmation" });
  }
};

// ==========================================================================
// SEND DISPATCH DETAILS (admin only)
// ==========================================================================

/**
 * Same gap as sendBulkConfirmation above, for the "Send Dispatch Details"
 * action (visible once status is "completed").
 *
 * @route POST /api/admin/bulk-bookings/:id/send-dispatch
 */
export const sendBulkDispatch = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await findBulkBooking(id);

    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Bulk booking not found" });
    }

    if (booking.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: `Dispatch details aren't applicable for a booking that's "${booking.status}".`,
      });
    }

    let orderNumber = null;
    if (booking.created_order_id) {
      const { rows } = await query(
        "SELECT order_number FROM orders WHERE id = ?",
        [booking.created_order_id],
      );
      orderNumber = rows[0]?.order_number || null;
    }

    await notifyBulkDispatch({
      email: booking.email,
      mobileNumber: booking.mobile_number,
      contactPerson: booking.contact_person,
      orderNumber,
    });
    await logBulkCommunication(id, "dispatch", "Dispatch Details Sent", req.admin?.id);

    const updated = await findBulkBookingWithHistory(id);

    res.status(200).json({
      success: true,
      message: "Dispatch details sent successfully",
      data: updated,
    });
  } catch (error) {
    console.error("❌ Error sending bulk dispatch details:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to send dispatch details" });
  }
};

// ==========================================================================
// VERIFY PAYMENT (customer, public)
// ==========================================================================

/**
 * Verifies the Razorpay payment for a bulk booking (called by the frontend
 * after Razorpay Checkout succeeds). Reuses the same verifyPaymentSignature
 * utility paymentController.verifyPayment uses — the signature check itself
 * is not bulk-specific and isn't duplicated, just invoked here.
 *
 * Beyond the signature, this also fetches the payment from Razorpay itself
 * and checks status/amount/currency before writing anything — signature
 * verification alone only proves the payload wasn't tampered with in
 * transit, not that Razorpay actually captured the expected amount.
 *
 * Order creation: once payment is confirmed paid, this automatically calls
 * the same createOrderFromBulkBooking() service the admin "confirm" action
 * uses — no duplicated order-creation logic. Reused, not reimplemented. If
 * order creation itself fails for any reason (e.g. delivery_date was never
 * set), the payment is still recorded as paid and the failure is logged;
 * the pre-existing manual admin "confirm" path (updateBulkBooking,
 * status="confirmed") remains as a fallback — createOrderFromBulkBooking is
 * idempotent, so retrying it there is always safe.
 *
 * @route POST /api/bulk-bookings/:id/verify-payment
 * @body { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
export const verifyBulkPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res
        .status(400)
        .json({ success: false, message: "Missing payment fields" });
    }

    const booking = await findBulkBooking(id);
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, message: "Bulk booking not found" });
    }

    // Idempotency fast-path: already verified with this exact payment id.
    // FIX (audit): moved ahead of the read-only guard below. Order creation
    // now happens automatically right after payment succeeds, so by the time
    // a duplicate verify-payment call arrives (Razorpay Checkout firing its
    // success handler twice, a refreshed tab, etc.) the booking is very
    // likely already order_created = 1. Checking this first means that
    // legitimate re-call still returns "Payment verified successfully"
    // instead of the 409 read-only response below — which the frontend
    // would otherwise treat as a failure and redirect to the Payment Failed
    // page for a payment that actually succeeded.
    if (
      booking.payment_status === "paid" &&
      booking.razorpay_payment_id === razorpay_payment_id
    ) {
      return res.status(200).json({
        success: true,
        message: "Payment verified successfully",
        data: booking,
        orderId: booking.created_order_id || null,
        order: booking.order_created
          ? { id: booking.created_order_id }
          : null,
      });
    }

    if (rejectIfReadOnly(res, booking)) return;

    // Block payment verification (including via direct API/Postman calls)
    // if the customer has not approved the quotation yet.
    if (!booking.quote_approved) {
      return res.status(400).json({
        success: false,
        message: "Quotation must be approved before payment.",
      });
    }

    if (
      !booking.razorpay_order_id ||
      booking.razorpay_order_id !== razorpay_order_id
    ) {
      return res.status(400).json({
        success: false,
        message:
          "This payment does not match the payment link shared for this booking.",
      });
    }

    const isValid = verifyPaymentSignature({
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isValid) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment signature" });
    }

    // ── Verify the payment itself with Razorpay (status/amount/currency) ───
    let rzpPayment;
    try {
      const razorpay = getRazorpay();
      rzpPayment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (err) {
      console.error("[BULK] Razorpay payment fetch failed", err?.message);
      return res.status(502).json({
        success: false,
        message: "Could not verify payment with Razorpay. Please try again.",
      });
    }

    const expectedPaise = Math.round(Number(booking.quote_price) * 100);

    if (rzpPayment.status !== "captured") {
      return res.status(400).json({
        success: false,
        message: "Payment has not been captured by Razorpay.",
      });
    }
    if (Number(rzpPayment.amount) !== expectedPaise) {
      return res.status(400).json({
        success: false,
        message: "Payment amount does not match the quoted amount.",
      });
    }
    if (rzpPayment.currency !== "INR") {
      return res.status(400).json({
        success: false,
        message: "Unexpected payment currency.",
      });
    }

    // FIX (Standard Checkout for Bulk Orders): no Magic Checkout
    // customer_details fetch here anymore — the delivery address is the one
    // the customer already supplied at booking time
    // (bulk_bookings.address_line1..country), which createOrderFromBulkBooking
    // below reads directly. Razorpay's Standard Checkout collects no address
    // at all, so there is nothing to read back from the paid Order.

    // ── Transaction: mark payment paid under a row lock, guarding against
    // concurrent/duplicate verification calls and a mid-flight admin confirm.
    const client = await getClient();
    let updatedBooking;
    try {
      await client.query("BEGIN");

      const { rows: lockedRows } = await client.query(
        "SELECT * FROM bulk_bookings WHERE id = ? FOR UPDATE",
        [id],
      );
      const locked = lockedRows[0];

      if (!locked) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ success: false, message: "Bulk booking not found" });
      }

      if (locked.order_created) {
        if (locked.razorpay_payment_id === razorpay_payment_id) {
          // Same payment, order already created by a concurrent request —
          // idempotent success, not an error (see FIX note above).
          await client.query("COMMIT");
          updatedBooking = locked;
        } else {
          await client.query("ROLLBACK");
          return res.status(409).json({
            success: false,
            message:
              "This bulk booking is read-only — an order has already been created from it.",
            data: {
              bulkBookingId: locked.id,
              orderId: locked.created_order_id,
            },
          });
        }
      } else if (locked.payment_status === "paid") {
        // Another concurrent call already finished this — nothing to do.
        await client.query("COMMIT");
        updatedBooking = locked;
      } else {
        await client.query(
          `UPDATE bulk_bookings
           SET payment_status = 'paid', razorpay_payment_id = ?, razorpay_signature = ?, paid_at = NOW(), updated_at = NOW()
           WHERE id = ?`,
          [razorpay_payment_id, razorpay_signature, id],
        );
        await client.query("COMMIT");
        updatedBooking = await findBulkBooking(id);
      }
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("❌ Error verifying bulk payment (transaction):", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to verify payment" });
    } finally {
      client.release();
    }

    console.info("[BULK] Payment Verified", {
      bulkBookingId: id,
      razorpay_payment_id,
    });

    // FIX (audit — missing integration): the Order was previously never
    // created automatically here; an admin had to separately open the
    // booking and set status="confirmed". Now that payment is verified,
    // immediately hand off to the existing, already-idempotent
    // createOrderFromBulkBooking() service — same function the manual admin
    // "confirm" action calls, so there is exactly one order-creation
    // implementation either way. A failure here (e.g. delivery_date was
    // never set) must never turn a successful payment into an error
    // response — it's logged, and the manual admin "confirm" action remains
    // as a fallback since the service is idempotent.
    let orderResult = null;
    if (!updatedBooking.order_created) {
      try {
        orderResult = await createOrderFromBulkBooking(id, {
          changedBy: null,
        });
      } catch (orderErr) {
        console.error(
          "[BULK] Automatic order creation after payment failed — admin can retry via the Confirm action",
          { bulkBookingId: id, error: orderErr?.message },
        );
      }
    }

    const finalBooking = orderResult
      ? await findBulkBooking(id)
      : updatedBooking;

    res.status(200).json({
      success: true,
      message: "Payment verified successfully",
      data: finalBooking,
      orderId: orderResult?.orderId || finalBooking.created_order_id || null,
      order: orderResult
        ? { id: orderResult.orderId, orderNumber: orderResult.orderNumber }
        : null,
    });
  } catch (error) {
    console.error("❌ Error verifying bulk payment:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to verify payment" });
  }
};

// ==========================================================================
// GET BULK PAYMENT DETAILS (customer, public)
// ==========================================================================

/**
 * Returns the payment details required by the public frontend payment page
 * to open Razorpay Checkout for a bulk booking.
 *
 * This endpoint is READ ONLY. It never creates or mutates a Razorpay order,
 * never updates payment_status, and never exposes the Razorpay secret.
 *
 * @route GET /api/bulk-bookings/:id/payment
 */
export const getBulkPaymentDetails = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID required",
      });
    }

    const booking = await findBulkBooking(id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Bulk booking not found",
      });
    }

    // Booking already converted into an order — no further payment allowed.
    if (booking.order_created) {
      return res.status(409).json({
        success: false,
        message: "This booking has already been converted into an Order.",
      });
    }

    // Quote must have been shared and approved before payment can proceed.
    if (!booking.quote_price || Number(booking.quote_price) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quotation has not been shared yet.",
      });
    }

    if (!booking.quote_approved) {
      return res.status(400).json({
        success: false,
        message: "Quotation has not been approved yet.",
      });
    }

    // Already paid — frontend should redirect to the Payment Success page.
    if (booking.payment_status === "paid") {
      return res.status(200).json({
        success: true,
        alreadyPaid: true,
        data: {
          bookingId: booking.id,
          bookingNumber: booking.bulk_booking_number,
          companyName: booking.company_name,
          contactPerson: booking.contact_person,
          email: booking.email,
          mobileNumber: booking.mobile_number,
          location: booking.location,
          quantity: booking.quantity,
          requirements: booking.requirements,
          quotePrice: booking.quote_price,
          deliveryDate: booking.delivery_date,
          currency: "INR",
          paymentStatus: booking.payment_status,
          razorpayOrderId: booking.razorpay_order_id,
          keyId: process.env.RAZORPAY_KEY_ID,
          quoteApproved: booking.quote_approved,
          quoteApprovedAt: booking.quote_approved_at,
          paymentSharedAt: booking.payment_link_shared_at,
          createdAt: booking.created_at,
        },
      });
    }

    // FIX (root cause of the 400 after approve-quote): a Razorpay order
    // previously had to already exist — created only by the admin's "Send
    // Payment Link" click — or this endpoint hard-failed with "Payment link
    // has not been shared yet." A customer landing here right after
    // approving their own quote, before any admin action, always hit that
    // 400. Now creates the Razorpay order on the fly via the same
    // race-safe, idempotent helper sharePaymentLink uses — a page
    // refresh (or two open tabs) re-locks and finds razorpay_order_id
    // already set, so it's reused, never duplicated.
    let effectiveBooking = booking;
    if (!booking.razorpay_order_id) {
      let result;
      try {
        result = await ensureBulkRazorpayOrder(id);
      } catch (err) {
        console.error("❌ Error preparing bulk payment details:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch payment details",
        });
      }

      if (!result.ok) {
        // NOT_FOUND / INVALID_QUOTE / NOT_APPROVED were already ruled out
        // above against this same booking row, so in practice only
        // READ_ONLY or ALREADY_PAID (a concurrent request finishing first)
        // can reach here — handled defensively either way.
        if (result.code === "READ_ONLY") {
          return res.status(409).json({
            success: false,
            message: "This booking has already been converted into an Order.",
          });
        }
        if (result.code === "ALREADY_PAID") {
          const paidBooking = await findBulkBooking(id);
          return res.status(200).json({
            success: true,
            alreadyPaid: true,
            data: {
              bookingId: paidBooking.id,
              bookingNumber: paidBooking.bulk_booking_number,
              companyName: paidBooking.company_name,
              contactPerson: paidBooking.contact_person,
              email: paidBooking.email,
              mobileNumber: paidBooking.mobile_number,
              location: paidBooking.location,
              quantity: paidBooking.quantity,
              requirements: paidBooking.requirements,
              quotePrice: paidBooking.quote_price,
              deliveryDate: paidBooking.delivery_date,
              currency: "INR",
              paymentStatus: paidBooking.payment_status,
              razorpayOrderId: paidBooking.razorpay_order_id,
              keyId: process.env.RAZORPAY_KEY_ID,
              quoteApproved: paidBooking.quote_approved,
              quoteApprovedAt: paidBooking.quote_approved_at,
              paymentSharedAt: paidBooking.payment_link_shared_at,
              createdAt: paidBooking.created_at,
            },
          });
        }
        return res.status(400).json({
          success: false,
          message: "Unable to prepare payment details for this booking.",
        });
      }

      effectiveBooking = result.booking;
    }

    // FIX (Standard Checkout for Bulk Orders): the address the customer
    // already supplied at booking time is authoritative — returned here
    // purely for the payment page to display "delivering to:", not for
    // Razorpay to collect/confirm (that was the Magic Checkout behavior;
    // this is a plain Razorpay Order now).
    const defaultAddress = effectiveBooking.address_line1
      ? {
          line1: effectiveBooking.address_line1,
          line2: effectiveBooking.address_line2,
          city: effectiveBooking.city,
          state: effectiveBooking.state,
          zipcode: effectiveBooking.pincode,
          country: effectiveBooking.country || "India",
        }
      : null;

    // Standard success response with details needed for Razorpay Checkout.
    res.status(200).json({
      success: true,
      alreadyPaid: false,
      data: {
        bookingId: effectiveBooking.id,
        bookingNumber: effectiveBooking.bulk_booking_number,
        companyName: effectiveBooking.company_name,
        contactPerson: effectiveBooking.contact_person,
        email: effectiveBooking.email,
        mobileNumber: effectiveBooking.mobile_number,
        location: effectiveBooking.location,
        quantity: effectiveBooking.quantity,
        requirements: effectiveBooking.requirements,
        quotePrice: effectiveBooking.quote_price,
        deliveryDate: effectiveBooking.delivery_date,
        currency: "INR",
        paymentStatus: effectiveBooking.payment_status,
        razorpayOrderId: effectiveBooking.razorpay_order_id,
        keyId: process.env.RAZORPAY_KEY_ID,
        quoteApproved: effectiveBooking.quote_approved,
        quoteApprovedAt: effectiveBooking.quote_approved_at,
        paymentSharedAt: effectiveBooking.payment_link_shared_at,
        createdAt: effectiveBooking.created_at,
        defaultAddress,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching bulk payment details:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch payment details",
    });
  }
};

// ==========================================================================
// BULK BOOKING STATISTICS (admin only)
// ==========================================================================

/**
 * Get bulk booking statistics (admin only).
 * Works with or without migration (graceful fallback). Unchanged existing
 * fields; ordersCreated added additively.
 */
export const getBulkBookingStats = async (req, res) => {
  try {
    // Try to get detailed stats with status breakdown (requires migration)
    let stats = {};

    try {
      const result = await query(`
        SELECT 
          COUNT(*) as totalBookings,
          SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as newBookings,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as inProgressBookings,
          SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) as quotedBookings,
          SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmedBookings,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completedBookings,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelledBookings,
          SUM(quantity) as totalQuantity,
          SUM(CASE WHEN status IN ('quoted', 'confirmed', 'completed') AND quote_price IS NOT NULL THEN quote_price ELSE 0 END) as totalQuoteValue,
          SUM(CASE WHEN order_created = 1 THEN 1 ELSE 0 END) as ordersCreated
        FROM bulk_bookings
      `);

      stats = result.rows[0] || {};
    } catch (detailError) {
      // If detailed stats fail, fall back to basic stats
      console.warn(
        "⚠️ Detailed stats not available (migration may not be applied), using basic stats",
      );

      const result = await query(`
        SELECT 
          COUNT(*) as totalBookings,
          SUM(quantity) as totalQuantity
        FROM bulk_bookings
      `);

      stats = result.rows[0] || {};
    }

    res.status(200).json({
      success: true,
      data: {
        totalBookings: stats.totalBookings || 0,
        newBookings: stats.newBookings || 0,
        inProgressBookings: stats.inProgressBookings || 0,
        quotedBookings: stats.quotedBookings || 0,
        confirmedBookings: stats.confirmedBookings || 0,
        completedBookings: stats.completedBookings || 0,
        cancelledBookings: stats.cancelledBookings || 0,
        totalQuantity: stats.totalQuantity || 0,
        totalQuoteValue: parseFloat(stats.totalQuoteValue) || 0,
        ordersCreated: stats.ordersCreated || 0,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching bulk booking statistics:", error.message);
    console.error("Stack:", error.stack);

    res.status(500).json({
      success: false,
      message: "Failed to fetch bulk booking statistics",
    });
  }
};
