// ─────────────────────────────────────────────────────────────────────────────
// bulkOrderService.js
//
// Creates a normal, independent fulfillment order from a Bulk Booking once
// it has a quote, a delivery date, and verified payment. This is the single
// reusable place that turns a `bulk_bookings` row into an `orders` row —
// bulkController.js calls this instead of embedding order-creation SQL
// itself, so the logic exists exactly once.
//
// DESIGN PRINCIPLES (mirrors services/renewalService.js)
// ─────────────────────────────────────────────────────
// 1. Idempotent: if the booking already has order_created = 1, the existing
//    order is returned rather than creating a duplicate. This is checked
//    once before opening a transaction (fast path) and again under a
//    row lock inside the transaction (race-safe path).
//
// 2. One transaction: the order insert, order_items insert, payments insert,
//    order_status_history insert, and the bulk_bookings order_created /
//    created_order_id update all happen atomically via getClient(). Any
//    failure rolls back everything, including the bulk_bookings update.
//
// 3. Fulfillment-first: payment has already been verified via the bulk
//    payment-link flow before this runs, so the order is created directly
//    at order_status = 'paid', payment_status = 'paid' — identical to how
//    createRenewalOrder starts a renewal order at 'paid'.
//
// 4. Hand-off, not duplication: order confirmation email/WhatsApp are sent
//    here using the *existing* sendOrderConfirmationEmail /
//    sendOrderConfirmationWhatsApp functions from the order module — the
//    same functions paymentController.verifyPayment and webhookController
//    already call for a normal checkout. This file does not re-implement
//    those templates; it invokes them once, right after commit, exactly the
//    way the rest of the codebase triggers order-confirmation notifications
//    after a payment is finalized. Everything downstream of that (Delhivery
//    shipment creation, tracking, returns, refunds, further status-driven
//    notifications) is untouched — the order now behaves exactly like any
//    other order and is picked up by the existing admin Orders UI/flow.
//
// 5. Product-agnostic: a Bulk Booking has no real product_id (only a free-
//    text `requirements` field and a plain `quantity`), so a single
//    synthetic order_items row is written summarizing the bulk requirement.
//    order_items.product_id has no FK constraint in the schema, so this is
//    safe; it exists purely so the order displays sensibly in the existing
//    admin order list/detail and tracking pages.
//
// 6. Bulk orders reference a synthetic product_id (see #5), not a real
//    catalog product. Their booking and fulfillment flows remain independent
//    from catalog product availability.
//
// 7. Bulk order metadata: `is_bulk_order`, `bulk_booking_id`,
//    `bulk_booking_number`, `company_name`, and `contact_person` are stored
//    directly on the `orders` row (columns added to the schema) purely for
//    reference/traceability in the existing admin Orders UI. This is metadata
//    only — it does not change order_number generation (still the normal
//    #BREE-100001 sequence via getNextOrderNumber), the order workflow,
//    Razorpay/payment logic, order_items, rewards, Delhivery,
//    notifications, or transaction handling.
//
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import { getClient, query } from "../config/database.js";
import { getNextOrderNumber } from "../utils/orderNumber.js";
import { sendOrderConfirmationEmail } from "./orderEmailService.js";
import { logBulkCommunication } from "../utils/bulkCommunicationLog.js";
import {
  safelySendWhatsApp,
  sendOrderConfirmationWhatsApp,
} from "./whatsappNotificationService.js";

/** Thrown when the booking can't be found at all. */
export class BulkBookingNotFoundError extends Error {
  constructor(bookingId) {
    super(`Bulk booking ${bookingId} not found`);
    this.name = "BulkBookingNotFoundError";
    this.code = "NOT_FOUND";
  }
}

/** Thrown when the booking fails a pre-confirmation business rule. */
export class BulkOrderValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BulkOrderValidationError";
    this.code = "VALIDATION";
  }
}

/**
 * Returns a human-friendly reference for a bulk booking: the dedicated
 * booking number if the project has that column (e.g. "BB-100001"),
 * otherwise falls back to the internal UUID exactly as before. This keeps
 * the fallback fully backward compatible with schemas that don't have
 * `bulk_booking_number` yet — the field is simply absent on the row and we
 * silently fall through to the old behaviour.
 *
 * @param {object} booking - a bulk_bookings row
 * @returns {string}
 */
export const getBookingReference = (booking) =>
  booking?.bulk_booking_number || booking?.id;

/**
 * Re-validates the fields required to confirm a bulk booking and create an
 * order from it. Used both by the controller (for a fast pre-check with a
 * friendly error) and again here under a row lock (defense in depth against
 * a race between two concurrent confirm requests).
 *
 * @param {object} booking - a bulk_bookings row
 * @returns {number} the validated quote price
 * @throws {BulkOrderValidationError}
 */
const assertBookingConfirmable = (booking) => {
  if (booking.status === "cancelled") {
    throw new BulkOrderValidationError(
      "Cannot confirm booking: this booking has been cancelled.",
    );
  }

  // Only enforced when the column exists on the row (SELECT * will surface
  // it once the schema has it). This keeps the check backward compatible
  // with any deployment that hasn't added `quote_approved` yet.
  if (
    Object.prototype.hasOwnProperty.call(booking, "quote_approved") &&
    !booking.quote_approved
  ) {
    throw new BulkOrderValidationError(
      "Cannot confirm booking: the customer has not approved the quote yet.",
    );
  }

  const quotePrice = Number(booking.quote_price);
  if (!booking.quote_price || !Number.isFinite(quotePrice) || quotePrice <= 0) {
    throw new BulkOrderValidationError(
      "Cannot confirm booking: a valid quote price is required.",
    );
  }
  if (!booking.delivery_date) {
    throw new BulkOrderValidationError(
      "Cannot confirm booking: a delivery date is required.",
    );
  }
  if (booking.payment_status !== "paid") {
    throw new BulkOrderValidationError(
      "Cannot confirm booking: payment has not been verified yet.",
    );
  }
  return quotePrice;
};

/**
 * Builds the single synthetic order_items row representing the bulk
 * requirement (no real product is tied to a bulk enquiry).
 *
 * The item name prefers the human booking reference (e.g. "Bulk Order —
 * BB-100001") so admins can identify the order at a glance in the existing
 * admin order list/detail views; falls back to the company name when no
 * booking number exists yet, matching prior behaviour.
 */
export const buildBulkOrderItem = (booking, quotePrice, bookingRef) => {
  const quantity = Number(booking.quantity) > 0 ? Number(booking.quantity) : 1;
  const rawName = booking.bulk_booking_number
    ? `Bulk Order — ${bookingRef}`
    : `Bulk Order — ${booking.company_name}`;

  return {
    id: randomUUID(),
    // Synthetic product id: order_items.product_id has no FK constraint in
    // the schema, so this is safe. It only needs to be a valid 36-char id.
    productId: randomUUID(),
    name: rawName.slice(0, 255),
    price: Number((quotePrice / quantity).toFixed(2)),
    quantity,
    subtotal: quotePrice,
  };
};

/**
 * Creates a normal order from a confirmed, paid Bulk Booking. Idempotent —
 * calling this twice for the same booking returns the same order both times
 * without creating a duplicate.
 *
 * @param {string} bookingId - bulk_bookings.id
 * @param {object} [options]
 * @param {string|null} [options.changedBy] - admin id, recorded on order_status_history
 * @param {object|null} [options.magicCheckoutAddress] - the final shipping
 *   address collected by Razorpay Magic Checkout ({ name, mobile, line1,
 *   line2, city, state, pincode, country }), passed in by
 *   bulkController.verifyBulkPayment. Preferred over the booking's own
 *   (legacy) structured address columns when present and valid.
 * @returns {Promise<{orderId: string, orderNumber: string|null, alreadyExists: boolean}>}
 */
/**
 * Resolves the address to persist on the created Order.
 *
 * MIGRATION (Standard Checkout → Magic Checkout): the FINAL delivery
 * address is now collected by Razorpay Magic Checkout during payment
 * (bulkController.verifyBulkPayment fetches it and passes it in as
 * `magicCheckoutAddress`) — that is always preferred when present and
 * valid. The booking's own legacy structured columns
 * (address_line1/city/state/pincode/country) are kept only as a fallback
 * for OLD bookings created before this migration; new bookings never
 * populate those columns (they use the single `enquiry_address` field
 * instead, which is reference-only and never used as a shipping address).
 *
 * Returns null (not a partial address) when neither candidate has line1,
 * city, and pincode — a partially-populated address is worse than none: it
 * would pass the "was an address found at all" check in
 * shippingController.js but still fail Delhivery's own field validation
 * with a less obvious error.
 */
const isUsableAddress = (addr) =>
  Boolean(addr && addr.line1 && addr.city && addr.pincode);

const resolveOrderAddress = (booking, magicCheckoutAddress) => {
  if (isUsableAddress(magicCheckoutAddress)) {
    return {
      name: magicCheckoutAddress.name || booking.contact_person,
      mobile: magicCheckoutAddress.mobile || booking.mobile_number,
      line1: magicCheckoutAddress.line1,
      line2: magicCheckoutAddress.line2 || null,
      city: magicCheckoutAddress.city,
      state: magicCheckoutAddress.state || null,
      pincode: magicCheckoutAddress.pincode,
      country: magicCheckoutAddress.country || "India",
    };
  }

  // Legacy fallback — only ever populated on bookings created before the
  // single-field Enquiry Address migration.
  if (!booking.address_line1 || !booking.city || !booking.pincode) {
    return null;
  }

  return {
    name: booking.contact_person,
    mobile: booking.mobile_number,
    line1: booking.address_line1,
    line2: booking.address_line2,
    city: booking.city,
    state: booking.state,
    pincode: booking.pincode,
    country: booking.country || "India",
  };
};

/** Flattens a resolved structured address into the single-string format
 * orders.shipping_address already expects (unchanged column, used for
 * display everywhere the order is shown today). */
const flattenAddress = (addr) => {
  if (!addr) return null;
  return (
    [
      addr.name,
      addr.line1,
      addr.line2,
      addr.city,
      addr.state,
      addr.pincode,
      addr.country,
    ]
      .filter(Boolean)
      .join(", ") || null
  );
};

export const createOrderFromBulkBooking = async (
  bookingId,
  { changedBy = null, magicCheckoutAddress = null } = {},
) => {
  // ── 0. Fast idempotency pre-check (outside any transaction) ──────────────
  const { rows: preRows } = await query(
    "SELECT id, order_created, created_order_id FROM bulk_bookings WHERE id = ?",
    [bookingId],
  );
  const preBooking = preRows[0];
  if (!preBooking) throw new BulkBookingNotFoundError(bookingId);

  if (preBooking.order_created) {
    return {
      orderId: preBooking.created_order_id,
      orderNumber: null,
      alreadyExists: true,
    };
  }

  // ── 1. Transaction: lock the booking, re-validate, create the order ──────
  const client = await getClient();
  let orderId;
  let orderNumber;
  let notificationPayload = null;
  // Resolved once the booking row is fetched below; defaults to the raw id
  // so error logs before that point still have something useful to print.
  let bookingRef = bookingId;

  try {
    await client.query("BEGIN");

    const { rows: lockedRows } = await client.query(
      "SELECT * FROM bulk_bookings WHERE id = ? FOR UPDATE",
      [bookingId],
    );
    const booking = lockedRows[0];

    if (!booking) {
      await client.query("ROLLBACK");
      throw new BulkBookingNotFoundError(bookingId);
    }

    // Race-safe duplicate guard: another confirm request may have committed
    // between our pre-check and this lock.
    if (booking.order_created) {
      await client.query("COMMIT");
      return {
        orderId: booking.created_order_id,
        orderNumber: null,
        alreadyExists: true,
      };
    }

    const quotePrice = assertBookingConfirmable(booking);
    bookingRef = getBookingReference(booking);

    orderId = randomUUID();
    orderNumber = await getNextOrderNumber(client);

    // Magic Checkout's final shipping address is the delivery address of
    // record; the legacy structured columns are only a fallback for
    // bookings created before this migration. booking.enquiry_address /
    // booking.location are last-resort text for the flattened snapshot only
    // — never treated as a structured, shippable address.
    const resolvedAddress = resolveOrderAddress(booking, magicCheckoutAddress);
    const shippingAddressSnapshot =
      flattenAddress(resolvedAddress) ||
      booking.enquiry_address ||
      booking.location ||
      null;
    const orderItem = buildBulkOrderItem(booking, quotePrice, bookingRef);

    // ── 1a. Insert the order row ────────────────────────────────────────────
    // Copies: contact person -> customer name, email, mobile number,
    // location -> shipping_address snapshot, quote_price -> total.
    // New: order id/number, is_bulk_order=1, bulk_booking_id, order_status
    // and payment_status both 'paid' (payment already verified upstream).
    // Bulk metadata: bulk_booking_number, company_name, contact_person are
    // persisted for reference/traceability only — order_number generation
    // below is untouched, and these three columns are appended at the end
    // of the column/placeholder/param lists so nothing existing shifts.
    // shipping_address_line1..country: the structured address Delhivery
    // shipment creation actually needs (shippingController.js's fallback
    // branch) — NULL when resolvedAddress is null, same as any other order
    // with no structured address on file today.
    await client.query(
      `INSERT INTO orders (
         id, order_number, user_id, address_id,
         customer_name, email, mobile_number,
         contact_name, contact_email, contact_phone,
         shipping_address, subtotal, total,
         order_status, payment_status,
         is_bulk_order, bulk_booking_id,
         razorpay_order_id, razorpay_payment_id, transaction_id,
         paid_at, created_at, updated_at,
         bulk_booking_number, company_name, contact_person,
         shipping_address_line1, shipping_address_line2,
         shipping_city, shipping_state, shipping_pincode, shipping_country
       ) VALUES (
         ?, ?, ?, NULL,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         'paid', 'paid',
         1, ?,
         ?, ?, ?,
         NOW(), NOW(), NOW(),
         ?, ?, ?,
         ?, ?, ?, ?, ?, ?
       )`,
      [
        orderId,
        orderNumber,
        // FIX (Profile → Orders visibility bug): this was hardcoded to the
        // literal NULL — bulk_bookings.user_id (added when bulk bookings
        // were first linked to the account that submitted them; booking
        // creation is already behind `auth`) was never propagated onto the
        // order this creates. getMyOrders filters strictly by
        // `WHERE o.user_id = ?`, so every bulk-generated order was
        // structurally invisible to its own customer's Profile → Orders,
        // even though it's fully visible admin-side (admin's order list has
        // no user_id filter at all).
        booking.user_id || null,
        booking.contact_person,
        booking.email,
        booking.mobile_number,
        booking.contact_person,
        booking.email,
        booking.mobile_number,
        shippingAddressSnapshot,
        quotePrice,
        quotePrice,
        bookingId,
        booking.razorpay_order_id || null,
        booking.razorpay_payment_id || null,
        booking.razorpay_payment_id || null,
        booking.bulk_booking_number || null,
        booking.company_name,
        booking.contact_person,
        resolvedAddress?.line1 || null,
        resolvedAddress?.line2 || null,
        resolvedAddress?.city || null,
        resolvedAddress?.state || null,
        resolvedAddress?.pincode || null,
        resolvedAddress?.country || null,
      ],
    );

    // ── 1b. Insert the synthetic order_items row ──────────────────────────────
    await client.query(
      `INSERT INTO order_items (
         id, order_id, product_id, product_name, product_image,
         product_price, quantity, subtotal
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        orderItem.id,
        orderId,
        orderItem.productId,
        orderItem.name,
        orderItem.price,
        orderItem.quantity,
        orderItem.subtotal,
      ],
    );

    // ── 1c. Insert the payment record ──────────────────────────────────────
    await client.query(
      `INSERT INTO payments (
         id, order_id, razorpay_order_id, razorpay_payment_id,
         razorpay_signature, amount, currency, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'INR', 'captured')`,
      [
        randomUUID(),
        orderId,
        booking.razorpay_order_id || null,
        booking.razorpay_payment_id || null,
        booking.razorpay_signature || null,
        quotePrice,
      ],
    );

    // ── 1d. Order status history ────────────────────────────────────────────
    // Uses the booking's display reference (booking number if the schema
    // has one, otherwise the same UUID as before) so admins never see a raw
    // UUID in this note once bulk_booking_number exists.
    await client.query(
      `INSERT INTO order_status_history
         (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, NULL, 'paid', ?, ?)`,
      [orderId, changedBy, `Order created from Bulk Booking ${bookingRef}`],
    );

    // ── 1e. Update the bulk booking: mark confirmed + order-created guard ────
    // This is the same transaction as the order insert above, so if
    // anything fails, the booking is never left pointing at a
    // half-created order.
    await client.query(
      `UPDATE bulk_bookings
       SET status = 'confirmed', order_created = 1, created_order_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [orderId, bookingId],
    );

    await client.query("COMMIT");

    // Structured, non-sensitive success log — booking reference, order id,
    // and order number only, no contact details or amounts.
    console.log("[BULK_ORDER] Order created successfully", {
      bookingRef,
      orderId,
      orderNumber,
    });

    notificationPayload = {
      mobile: booking.mobile_number,
      name: booking.contact_person,
      email: booking.email,
      orderId,
      orderNumber,
      // Available for future notification templates that want to show
      // "BB-100001" instead of the order UUID; not consumed by the
      // existing Email/WhatsApp calls below, so current behaviour is
      // unchanged.
      bookingRef,
      amount: quotePrice,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // Don't let a rollback failure mask the original error, but do make
      // sure it's visible in logs — a silently swallowed rollback failure
      // is exactly the kind of thing that turns into an unexplained
      // half-committed row later.
      console.error("[BULK_ORDER] Rollback failed", {
        bookingId,
        bookingRef,
        originalError: err?.message,
        rollbackError: rollbackErr?.message,
      });
    }
    throw err;
  } finally {
    client.release();
  }

  // ── 2. Order confirmation email/WhatsApp ──────────────────────────────────
  // Reuses the exact same functions the order module already uses for a
  // normal checkout's order confirmation (paymentController.verifyPayment /
  // webhookController) — not new logic, just the same hand-off trigger,
  // fired once, after commit, and never allowed to fail — or *block* — the
  // request.
  //
  // FIX (stuck-on-"Processing payment" bug): this used to `await` the email
  // send and the communication-log insert (on top of the WhatsApp send,
  // which normal orders also await). verifyBulkPayment awaits this whole
  // function before sending its HTTP response, so all three ran serially
  // in the request/response cycle — unlike paymentController.verifyPayment,
  // where sendOrderConfirmationEmail (and createPackagePurchaseFromOrder)
  // are fire-and-forget and only the single WhatsApp call is awaited. Under
  // any real-world SMTP/Waplify slowness that combined latency could exceed
  // the frontend's global 20s axios timeout (lib/api.js) — the browser then
  // aborts the still-in-flight request (shows as "(cancelled)" in DevTools)
  // while the server keeps running to completion and genuinely finishes the
  // payment/order successfully. The customer is just never told, so the
  // page is stuck on "Processing payment" forever even though Razorpay
  // shows the payment captured. Making email + the comm-log insert
  // fire-and-forget — matching the email precedent normal orders already
  // use — brings bulk's blocking footprint down to the same single awaited
  // WhatsApp call normal orders already rely on, so the response goes back
  // to the browser promptly regardless of notification latency.
  // `bookingRef` is passed through as an optional field on both payloads so
  // future templates can show "BB-100001"; neither service is required to
  // read it, so this stays fully backward compatible.
  if (notificationPayload) {
    sendOrderConfirmationEmail({
      to: notificationPayload.email,
      name: notificationPayload.name,
      orderId: notificationPayload.orderId,
      bookingRef: notificationPayload.bookingRef,
      amount: notificationPayload.amount,
      items: [
        {
          name: `Bulk Order (${notificationPayload.bookingRef})`,
          quantity: 1,
          price: notificationPayload.amount,
        },
      ],
      shippingAddress: null,
    }).catch((emailErr) => {
      console.error("[BULK_ORDER] Confirmation email failed", {
        orderId: notificationPayload.orderId,
        bookingRef: notificationPayload.bookingRef,
        error: emailErr?.message,
      });
    });

    await safelySendWhatsApp("bulk-order-confirmed", () =>
      sendOrderConfirmationWhatsApp({
        mobile: notificationPayload.mobile,
        customerName: notificationPayload.name,
        orderNumber: notificationPayload.orderNumber,
        bookingRef: notificationPayload.bookingRef,
        orderAmount: notificationPayload.amount,
        orderDate: new Date().toLocaleDateString("en-IN"),
        orderUuid: notificationPayload.orderId,
      }),
    );

    // FIX (audit): communication_history had no backing table before this
    // audit — see logBulkCommunication for the shared insert both this file
    // and bulkController.js write through. Fire-and-forget (see note above)
    // — a logging failure must never delay the response.
    logBulkCommunication(
      bookingId,
      "order_confirmation",
      "Order Confirmation Sent",
      changedBy,
    ).catch((logErr) => {
      console.error("[BULK_ORDER] Communication log insert failed", {
        bookingId,
        error: logErr?.message,
      });
    });
  }

  return { orderId, orderNumber, alreadyExists: false };
};
