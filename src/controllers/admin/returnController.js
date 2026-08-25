import { getClient } from "../../config/database.js";
import { getRazorpay } from "../../config/razorpay.js";
import { appendStatusHistory } from "../../models/Order.js";
import { buildDelhiveryShipmentPayload } from "../../utils/delhiveryPayload.js";
import delhiveryService from "../../services/delhiveryService.js";
import { sendOrderStatusUpdateEmail } from "../../services/orderEmailService.js";
import { sendOrderStatusUpdateWhatsApp } from "../../services/whatsappNotificationService.js";
import {
  getWarehouseConfig,
  validateShippingAddress,
  validateWarehouseConfig,
  buildPickupRequestPayload,
  extractDelhiveryShipmentDetails,
} from "../shippingController.js";

// ==========================================================================
// Returns & Refunds Admin Controller
// ==========================================================================
// Returns/refunds are modeled as a side-channel on the `orders` row and
// NEVER mutate `order_status` (order_status stays "delivered" throughout).
// Progress is tracked via the dedicated `return_status` / `refund_status`
// columns already present on `orders`:
//   return_status: approved -> reverse_shipment_created -> pickup_scheduled
//                  -> returned   (or: rejected)
//   refund_status: approved -> completed (or: rejected)
//
// Architecture mirrors controllers/admin/orderController.js (transaction
// shape, response format, order_status_history usage, socket emit) and
// controllers/shippingController.js (Delhivery payload/service reuse,
// warehouse config, address validation). No new helpers are duplicated —
// everything importable from those files is imported, not rewritten.
// ==========================================================================

// ──────────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────────
// Same lightweight structured logger used in controllers/orderController.js.
// No shared `utils/logger.js` exists in this project yet, so each controller
// defines its own copy of this exact shape rather than inventing a new one.
const log = (level, event, meta = {}) => {
  try {
    const entry = {
      level,
      event,
      timestamp: new Date().toISOString(),
      ...meta,
    };
    if (level === "error") {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  } catch {
    // Never let logging break the request.
  }
};

// ──────────────────────────────────────────────────────────────────────────
// Socket helper — mirrors the try/catch-and-ignore pattern used in
// admin/orderController.js and shippingController.js.
// ──────────────────────────────────────────────────────────────────────────
const emitOrderUpdated = (req, order) => {
  try {
    const io = req.app?.locals?.io;
    if (io) io.emit("order:updated", order);
  } catch {
    // Socket failures must never affect the API response.
  }
};

// ──────────────────────────────────────────────────────────────────────────
// Notifications — fire-and-forget, never awaited, never allowed to throw
// into the request. Reuses the existing generic order-status notification
// senders (sendOrderStatusUpdateEmail / sendOrderStatusUpdateWhatsApp).
// Those senders only look up their status->label/message maps for known
// order_status values and fall back to the raw string otherwise, so passing
// an already human-readable label (e.g. "Return Approved") degrades
// gracefully instead of requiring new template/label entries.
// ──────────────────────────────────────────────────────────────────────────
const notifyReturnEvent = (order, label, notes) => {
  const recipientEmail = order.contact_email || order.email;
  const recipientPhone = order.contact_phone || order.mobile_number;
  const recipientName = order.contact_name || order.customer_name || "Customer";

  if (recipientEmail) {
    sendOrderStatusUpdateEmail({
      to: recipientEmail,
      name: recipientName,
      orderId: order.id,
      status: label,
      notes,
    }).catch((error) => {
      log("error", "return.email_failed", {
        orderId: order.id,
        error: error?.message || error,
      });
    });
  }

  if (recipientPhone) {
    sendOrderStatusUpdateWhatsApp({
      customerName: recipientName,
      mobile: recipientPhone,
      orderNumber: order.order_number,
      orderUuid: order.id,
      status: label,
    }).catch((error) => {
      log("error", "return.whatsapp_failed", {
        orderId: order.id,
        error: error?.message || error,
      });
    });
  }
};

const isPositiveNumber = (value) =>
  value !== undefined &&
  value !== null &&
  Number.isFinite(Number(value)) &&
  Number(value) > 0;

// ──────────────────────────────────────────────────────────────────────────
// 48-hour return eligibility — the single shared source of truth for this
// rule, used by every endpoint that can create/approve a return so the
// window is never checked (or miscalculated) more than one way.
//
// return_deadline = delivered_at + 48 hours. delivered_at always comes from
// the DB row passed in (order_status_history-derived — see database.js's
// ensureDeliveredAtBackfill/the trackShipment and updateOrderStatus/
// bulkUpdateStatus stamping) — NEVER from anything the frontend supplies.
//
// Returns { eligible: boolean, reason: string|null, deadline: Date|null }.
// `reason` is set whenever eligible is false, so callers can turn it
// straight into a 400 message without re-deriving why.
// ──────────────────────────────────────────────────────────────────────────
const RETURN_WINDOW_HOURS = 48;

const isReturnWindowOpen = (order) => {
  if (order.order_status !== "delivered") {
    return {
      eligible: false,
      reason: "Returns can only be requested for delivered orders.",
      deadline: null,
    };
  }

  if (!order.delivered_at) {
    return {
      eligible: false,
      reason:
        "This order has no recorded delivery timestamp, so return eligibility cannot be determined.",
      deadline: null,
    };
  }

  const deadline = new Date(
    new Date(order.delivered_at).getTime() + RETURN_WINDOW_HOURS * 60 * 60 * 1000,
  );

  if (Date.now() > deadline.getTime()) {
    return {
      eligible: false,
      reason: "The 48-hour return window has expired.",
      deadline,
    };
  }

  if (
    order.return_status &&
    ["rejected", "returned"].includes(order.return_status)
  ) {
    return {
      eligible: false,
      reason: `This return has already been ${order.return_status}.`,
      deadline,
    };
  }

  return { eligible: true, reason: null, deadline };
};

// ──────────────────────────────────────────────────────────────────────────
// Resolves the customer's structured shipping address for an order.
// This duplicates the address-resolution block inside
// shippingController.createShipment() (user_addresses -> legacy addresses
// fallback), since that logic is inline there and not factored into an
// exported helper. Flagged here rather than silently copied: if this
// lookup needs to change, it now needs to change in two places.
// ──────────────────────────────────────────────────────────────────────────
const resolveCustomerAddress = async (client, order) => {
  if (!order.address_id) return null;

  const { rows: userAddressRows } = await client.query(
    `SELECT id, full_name, phone, address_line_1, address_line_2, city, state, pincode, country
     FROM user_addresses
     WHERE id = ?
     LIMIT 1`,
    [order.address_id],
  );

  if (userAddressRows.length) {
    return {
      full_name: userAddressRows[0].full_name,
      mobile: userAddressRows[0].phone,
      address_line_1: userAddressRows[0].address_line_1,
      address_line_2: userAddressRows[0].address_line_2,
      city: userAddressRows[0].city,
      state: userAddressRows[0].state,
      pincode: userAddressRows[0].pincode,
      country: userAddressRows[0].country || "India",
    };
  }

  const { rows: legacyAddressRows } = await client.query(
    `SELECT id, label, address_line1, address_line2, city, state, pincode, country
     FROM addresses
     WHERE id = ?
     LIMIT 1`,
    [order.address_id],
  );

  if (!legacyAddressRows.length) return null;

  return {
    full_name: order.contact_name || legacyAddressRows[0].label,
    mobile: order.contact_phone || "",
    address_line_1: legacyAddressRows[0].address_line1,
    address_line_2: legacyAddressRows[0].address_line2,
    city: legacyAddressRows[0].city,
    state: legacyAddressRows[0].state,
    pincode: legacyAddressRows[0].pincode,
    country: legacyAddressRows[0].country || "India",
  };
};

// ──────────────────────────────────────────────────────────────────────────
// Maps the customer's address and our warehouse into the *swapped* address
// roles required to model a reverse-pickup shipment on top of the existing
// forward-shipment payload builder (buildDelhiveryShipmentPayload).
//
// buildDelhiveryShipmentPayload always treats its `shippingAddress` argument
// as the delivery destination (consignee) and its `warehouse` argument as
// the origin/seller + RTO-fallback address. A reverse shipment inverts the
// physical flow — Delhivery picks up FROM the customer and delivers TO our
// warehouse — so swapping which real-world party is passed into each
// argument reuses the exact same, already-tested payload construction and
// the same delhiveryService.createShipment() call, with no new fields.
//
// ASSUMPTION FLAGGED: this project has no existing integration with
// Delhivery's dedicated reverse-pickup contract (e.g. an `is_reversed`
// flag, a separately registered reverse pickup_location, or reverse-
// specific invoicing rules) — none of that exists anywhere in this
// codebase today. This mapping is a best-effort adaptation of the forward
// flow and should be validated against Delhivery's reverse-logistics
// docs/sandbox before relying on it in production.
// ──────────────────────────────────────────────────────────────────────────
const buildReverseShipmentRoles = (customerAddress, warehouse) => {
  const destinationAddress = {
    full_name: warehouse.name,
    mobile: warehouse.phone,
    address_line_1: warehouse.address,
    address_line_2: "",
    city: warehouse.city,
    state: warehouse.state,
    pincode: warehouse.pincode,
    country: warehouse.country || "India",
  };

  const originAsWarehouse = {
    name: customerAddress.full_name,
    address: [customerAddress.address_line_1, customerAddress.address_line_2]
      .filter(Boolean)
      .join(", "),
    city: customerAddress.city,
    state: customerAddress.state,
    pincode: customerAddress.pincode,
    country: customerAddress.country || "India",
    phone: customerAddress.mobile,
    gst: "",
  };

  return { destinationAddress, originAsWarehouse };
};

// ==========================================================================
// 1. Approve Return
// ==========================================================================
/**
 * PATCH /api/admin/orders/:orderId/return/approve
 *
 * Approves a return request for a delivered order. Validates the order
 * exists, is delivered, and has no return already in progress, then records
 * the approval on the orders row and logs the event to
 * order_status_history (order_status itself is left untouched).
 *
 * @param {import('express').Request} req - Expects `orderId` param and
 * `{ reason, notes }` in the body.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order }` on success.
 */
export const approveReturn = async (req, res) => {
  const { orderId } = req.params;
  const { reason, notes } = req.body;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    if (order.order_status !== "delivered") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Returns can only be approved for delivered orders. Current status is "${order.order_status}".`,
      });
    }

    if (order.return_status) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `A return is already in progress for this order (status: "${order.return_status}").`,
      });
    }

    // FIX (Return/Refund audit — 48-hour window): previously unenforced
    // anywhere. delivered_at is read straight off the locked DB row — never
    // trusted from the request — so this can't be bypassed by a stale
    // frontend or a direct API call.
    const eligibility = isReturnWindowOpen(order);
    if (!eligibility.eligible) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ success: false, message: eligibility.reason });
    }

    await client.query(
      `UPDATE orders
       SET return_status = 'approved',
           return_reason = ?,
           return_notes = ?,
           return_requested_at = NOW(),
           return_approved_at = NOW(),
           return_approved_by = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [reason || null, notes || null, req.admin?.id || null, orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");

    // order_status is unchanged by design; previous/new status are recorded
    // identically so the event still appears in the timeline, matching the
    // same trick used by shippingController.schedulePickup() for
    // non-order_status-changing events.
    appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: req.admin?.id || null,
      notes: `Return approved. Reason: ${reason || "N/A"}`,
    }).catch((error) => {
      log("error", "return.history_failed", {
        orderId,
        error: error?.message || error,
      });
    });

    emitOrderUpdated(req, updated);
    notifyReturnEvent(updated, "Return Approved", notes);

    log("info", "return.approved", { orderId });
    res.json({ success: true, message: "Return approved", order: updated });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.approve_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to approve return" });
  } finally {
    client.release();
  }
};

// ==========================================================================
// 2. Reject Return
// ==========================================================================
/**
 * PATCH /api/admin/orders/:orderId/return/reject
 *
 * Rejects a return request for a delivered order. Same validation as
 * approveReturn(), but writes return_status = "rejected".
 *
 * @param {import('express').Request} req - Expects `orderId` param and
 * `{ reason, notes }` in the body.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order }` on success.
 */
export const rejectReturn = async (req, res) => {
  const { orderId } = req.params;
  const { reason, notes } = req.body;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    if (order.order_status !== "delivered") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Returns can only be rejected for delivered orders. Current status is "${order.order_status}".`,
      });
    }

    if (order.return_status) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `A return is already in progress for this order (status: "${order.return_status}").`,
      });
    }

    await client.query(
      `UPDATE orders
       SET return_status = 'rejected',
           return_reason = ?,
           return_notes = ?,
           return_requested_at = NOW(),
           return_approved_at = NOW(),
           return_approved_by = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [reason || null, notes || null, req.admin?.id || null, orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");

    appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: req.admin?.id || null,
      notes: `Return rejected. Reason: ${reason || "N/A"}`,
    }).catch((error) => {
      log("error", "return.history_failed", {
        orderId,
        error: error?.message || error,
      });
    });

    emitOrderUpdated(req, updated);
    notifyReturnEvent(updated, "Return Rejected", notes);

    log("info", "return.rejected", { orderId });
    res.json({ success: true, message: "Return rejected", order: updated });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.reject_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to reject return" });
  } finally {
    client.release();
  }
};

// ==========================================================================
// 3. Create Reverse Shipment
// ==========================================================================
/**
 * POST /api/admin/orders/:orderId/return/reverse-shipment
 *
 * Creates a reverse-pickup Delhivery shipment for an approved return —
 * pickup at the customer's address, delivery to our warehouse — by reusing
 * delhiveryService.createShipment() and buildDelhiveryShipmentPayload()
 * with swapped address roles (see buildReverseShipmentRoles() above).
 *
 * @param {import('express').Request} req - Expects `orderId` param.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order, delhivery }` on success.
 */
export const createReverseShipment = async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];
    order.total_amount = order.total;

    // FIX (idempotency): a second click (or a race between two admin tabs)
    // previously hit the generic "must be approved" error below once
    // return_status had already moved to "reverse_shipment_created" —
    // confusing, and not what "repeated clicks must not create a duplicate
    // shipment" requires. Recognize this exact case and hand back the
    // shipment that already exists instead of erroring.
    if (order.return_status === "reverse_shipment_created") {
      await client.query("ROLLBACK");
      return res.status(200).json({
        success: true,
        message: "Return shipment already exists for this order.",
        order,
        delhivery: {
          awb: order.reverse_awb,
          trackingUrl: order.reverse_tracking_url,
        },
      });
    }

    if (order.return_status !== "approved") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `A reverse shipment can only be created for an approved return. Current return status is "${order.return_status || "none"}".`,
      });
    }

    // FIX (Return/Refund audit — 48-hour window): re-verified here too, not
    // just at approveReturn time — an admin could approve a return right at
    // the edge of the window and only click "Return Order" (create the
    // actual shipment) after it has since expired. Never create a Delhivery
    // shipment past the deadline, no matter how the order got here.
    const eligibility = isReturnWindowOpen(order);
    if (!eligibility.eligible) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ success: false, message: eligibility.reason });
    }

    const customerAddress = await resolveCustomerAddress(client, order);
    if (!customerAddress) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Customer address record not found.",
      });
    }

    const addressValidation = validateShippingAddress(customerAddress);
    if (!addressValidation.valid) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message:
          "Customer address is incomplete. City, State and Pincode are required.",
      });
    }

    const { rows: items } = await client.query(
      `SELECT id, product_id, product_name, product_price, quantity
       FROM order_items
       WHERE order_id = ?`,
      [orderId],
    );
    if (!items.length) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ success: false, message: "No items found for this order" });
    }

    const warehouse = getWarehouseConfig();
    const warehouseValidation = validateWarehouseConfig(warehouse);
    if (!warehouseValidation.valid) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Warehouse configuration is incomplete.",
      });
    }

    const { destinationAddress, originAsWarehouse } = buildReverseShipmentRoles(
      customerAddress,
      warehouse,
    );

    let payload;
    try {
      payload = buildDelhiveryShipmentPayload({
        order: { ...order, payment_method: "Prepaid" }, // reverse shipments are never COD
        customer: {
          name: customerAddress.full_name,
          email: order.contact_email,
          phone: customerAddress.mobile,
        },
        shippingAddress: destinationAddress,
        items,
        warehouse: originAsWarehouse,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Failed to build reverse shipment payload: ${error.message}`,
      });
    }

    // console.log("Warehouse Config:", {
    //   name: originAsWarehouse.name,
    //   address: originAsWarehouse.address,
    //   city: originAsWarehouse.city,
    //   state: originAsWarehouse.state,
    //   pincode: originAsWarehouse.pincode,
    //   phone: originAsWarehouse.phone,
    //   gst: originAsWarehouse.gst,
    // });
    // console.log("Pickup Location Sent:", payload.pickup_location);
    // console.log("Seller Name Sent:", payload.shipments?.[0]?.seller_name);

    let delhiveryResponse;
    try {
      delhiveryResponse = await delhiveryService.createShipment(payload);
    } catch (error) {
      await client.query("ROLLBACK");
      log("error", "return.reverse_shipment_delhivery_error", {
        orderId,
        error: error?.message || error,
      });
      return res.status(500).json({
        success: false,
        message: "Unable to create Delhivery reverse shipment.",
        error: error.message || error,
      });
    }

    if (!delhiveryResponse || delhiveryResponse.success === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message:
          delhiveryResponse?.message ||
          "Unable to create Delhivery reverse shipment.",
        delhiveryError: delhiveryResponse,
      });
    }

    const parsedShipment = extractDelhiveryShipmentDetails(delhiveryResponse);
    if (!parsedShipment.success) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: parsedShipment.message,
        delhiveryResponse,
      });
    }

    const { awbNumber, trackingUrl } = parsedShipment;

    await client.query(
      `UPDATE orders
       SET reverse_awb = ?,
           reverse_tracking_url = ?,
           reverse_shipment_created_at = NOW(),
           return_status = 'reverse_shipment_created',
           updated_at = NOW()
       WHERE id = ?`,
      [awbNumber, trackingUrl, orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");

    appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: req.admin?.id || null,
      notes: `Reverse shipment created with Delhivery. AWB: ${awbNumber}`,
    }).catch((error) => {
      log("error", "return.history_failed", {
        orderId,
        error: error?.message || error,
      });
    });

    emitOrderUpdated(req, updated);
    notifyReturnEvent(updated, "Return Shipment Created", null);

    log("info", "return.reverse_shipment_created", { orderId, awbNumber });
    res.json({
      success: true,
      message: "Reverse shipment created successfully",
      order: updated,
      delhivery: { awb: awbNumber, trackingUrl },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.reverse_shipment_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to create reverse shipment" });
  } finally {
    client.release();
  }
};

// ==========================================================================
// 4. Schedule Reverse Pickup
// ==========================================================================
/**
 * PATCH /api/admin/orders/:orderId/return/schedule-pickup
 *
 * Requests a Delhivery courier pickup run for an already-created reverse
 * shipment, reusing delhiveryService.requestPickup() and
 * buildPickupRequestPayload() exactly as shippingController.schedulePickup()
 * does for forward shipments.
 *
 * @param {import('express').Request} req - Expects `orderId` param and
 * optional `{ expected_package_count, pickup_date, pickup_time }` overrides.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order, delhivery }` on success.
 */
export const scheduleReversePickup = async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    if (
      order.return_status !== "reverse_shipment_created" ||
      !order.reverse_awb
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `A reverse shipment must exist before scheduling pickup. Current return status is "${order.return_status || "none"}".`,
      });
    }

    if (order.reverse_pickup_request_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "A reverse pickup has already been scheduled for this order",
        pickupRequestId: order.reverse_pickup_request_id,
      });
    }

    const { rows: itemCountRows } = await client.query(
      `SELECT COALESCE(SUM(quantity), 1) AS total_quantity
       FROM order_items
       WHERE order_id = ?`,
      [orderId],
    );
    const expectedPackageCount = Number(itemCountRows[0]?.total_quantity) || 1;

    const warehouse = getWarehouseConfig();
    const pickupPayload = buildPickupRequestPayload(
      warehouse,
      {
        expected_package_count: req.body?.expected_package_count,
        pickup_date: req.body?.pickup_date,
        pickup_time: req.body?.pickup_time,
      },
      expectedPackageCount,
    );

    let pickupResponse;
    try {
      pickupResponse = await delhiveryService.requestPickup(pickupPayload);
    } catch (error) {
      await client.query("ROLLBACK");
      log("error", "return.pickup_delhivery_error", {
        orderId,
        error: error?.message || error,
      });
      return res.status(500).json({
        success: false,
        message: "Failed to schedule reverse pickup with Delhivery",
        error: error.message || error,
      });
    }

    if (!pickupResponse || pickupResponse.success === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: pickupResponse?.message || "Delhivery API returned an error",
        delhiveryError: pickupResponse,
      });
    }

    // Same extraction shape as shippingController.schedulePickup() — not
    // factored into a shared helper there, so duplicated here.
    const pickupRequestId =
      pickupResponse.pickup_id ||
      pickupResponse.request_id ||
      pickupResponse.pickup_request_id ||
      pickupResponse.pickup_request_ids?.[0] ||
      pickupResponse.data?.pickup_id ||
      pickupResponse.data?.request_id ||
      pickupResponse.data?.pickup_request_id ||
      pickupResponse.data?.pickup_request_ids?.[0] ||
      null;

    if (!pickupRequestId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Delhivery response did not include a pickup request ID",
        delhiveryResponse: pickupResponse,
      });
    }

    await client.query(
      `UPDATE orders
       SET reverse_pickup_request_id = ?,
           return_status = 'pickup_scheduled',
           updated_at = NOW()
       WHERE id = ?`,
      [pickupRequestId, orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");

    appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: req.admin?.id || null,
      notes: `Reverse pickup scheduled with Delhivery. Pickup Request ID: ${pickupRequestId}`,
    }).catch((error) => {
      log("error", "return.history_failed", {
        orderId,
        error: error?.message || error,
      });
    });

    emitOrderUpdated(req, updated);
    notifyReturnEvent(updated, "Return Pickup Scheduled", null);

    log("info", "return.pickup_scheduled", { orderId, pickupRequestId });
    res.json({
      success: true,
      message: "Reverse pickup scheduled successfully",
      order: updated,
      delhivery: { pickupRequestId },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.schedule_pickup_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to schedule reverse pickup" });
  } finally {
    client.release();
  }
};

// ==========================================================================
// 5. Mark Returned
// ==========================================================================
/**
 * PATCH /api/admin/orders/:orderId/return/mark-returned
 *
 * Marks a return as physically received back at the warehouse.
 *
 * @param {import('express').Request} req - Expects `orderId` param and
 * optional `{ notes }` in the body.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order }` on success.
 */
export const markReturned = async (req, res) => {
  const { orderId } = req.params;
  const { notes } = req.body;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    // FIX (idempotency): a repeated click once already marked returned must
    // not re-fire history/notifications — hand back current state instead.
    if (order.return_status === "returned") {
      await client.query("ROLLBACK");
      return res.json({
        success: true,
        message: "Order has already been marked as returned",
        order,
      });
    }

    if (
      !["reverse_shipment_created", "pickup_scheduled"].includes(
        order.return_status,
      )
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Order cannot be marked returned from return status "${order.return_status || "none"}".`,
      });
    }

    // FIX (QC step, requirement 10): returned_at was referenced by the
    // frontend but never written; inspection_status starts "pending" here —
    // this is the point the QC step becomes available, matching "After:
    // return_status = returned, Admin should see Quality Check".
    await client.query(
      `UPDATE orders
       SET return_status = 'returned',
           returned_at = NOW(),
           inspection_status = 'pending',
           updated_at = NOW()
       WHERE id = ?`,
      [orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");

    appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: req.admin?.id || null,
      notes: notes || "Returned item received at warehouse.",
    }).catch((error) => {
      log("error", "return.history_failed", {
        orderId,
        error: error?.message || error,
      });
    });

    emitOrderUpdated(req, updated);
    notifyReturnEvent(updated, "Return Received", notes);

    log("info", "return.marked_returned", { orderId });
    res.json({
      success: true,
      message: "Order marked as returned",
      order: updated,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.mark_returned_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to mark order as returned" });
  } finally {
    client.release();
  }
};

// ==========================================================================
// 5a. Quality Check / Inspection (requirement 10 — new)
// ==========================================================================
// Backend never had this step at all: approveRefund used to be reachable
// directly off return_status = "returned", meaning a refund could be
// approved merely because the courier delivered the parcel back, without
// anyone at BREE ever looking at it. inspection_status (pending -> approved
// / rejected) is the missing gate — approveRefund below now requires
// inspection_status = "approved" before it will do anything.
// ==========================================================================

/**
 * PATCH /api/admin/orders/:orderId/return/inspection/approve
 *
 * Records that BREE physically inspected the returned item and it's fit for
 * a refund. Only valid once the item has actually been received
 * (return_status = "returned", set by markReturned).
 *
 * @param {import('express').Request} req - Expects `orderId` param and
 * optional `{ notes }` in the body.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order }` on success.
 */
export const approveInspection = async (req, res) => {
  const { orderId } = req.params;
  const { notes } = req.body;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    // Idempotent: a repeated click just returns the already-approved state.
    if (order.inspection_status === "approved") {
      await client.query("ROLLBACK");
      return res.json({
        success: true,
        message: "Quality check has already been completed.",
        order,
      });
    }

    if (order.return_status !== "returned") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Quality check is only available once the item has been received. Current return status is "${order.return_status || "none"}".`,
      });
    }

    if (order.inspection_status === "rejected") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "This return already failed quality check and cannot be re-approved.",
      });
    }

    await client.query(
      `UPDATE orders SET inspection_status = 'approved', updated_at = NOW() WHERE id = ?`,
      [orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");

    appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: req.admin?.id || null,
      notes: notes || "Quality check passed — approved for refund.",
    }).catch((error) => {
      log("error", "return.history_failed", {
        orderId,
        error: error?.message || error,
      });
    });

    emitOrderUpdated(req, updated);
    notifyReturnEvent(updated, "Return Inspection Approved", notes);

    log("info", "return.inspection_approved", { orderId });
    res.json({
      success: true,
      message: "Quality check completed.",
      order: updated,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.inspection_approve_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to record quality check" });
  } finally {
    client.release();
  }
};

/**
 * PATCH /api/admin/orders/:orderId/return/inspection/reject
 *
 * Records that the returned item failed inspection — no refund will follow.
 * Blocks a refund from ever being approved for this order.
 *
 * @param {import('express').Request} req - Expects `orderId` param and
 * `{ reason, notes }` in the body.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order }` on success.
 */
export const rejectInspection = async (req, res) => {
  const { orderId } = req.params;
  const { reason, notes } = req.body;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    if (order.inspection_status === "rejected") {
      await client.query("ROLLBACK");
      return res.json({
        success: true,
        message: "This return has already been rejected at quality check.",
        order,
      });
    }

    if (order.return_status !== "returned") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Quality check is only available once the item has been received. Current return status is "${order.return_status || "none"}".`,
      });
    }

    if (order.refund_status) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Cannot reject at quality check: a refund is already "${order.refund_status}" for this return.`,
      });
    }

    await client.query(
      `UPDATE orders
       SET inspection_status = 'rejected', updated_at = NOW()
       WHERE id = ?`,
      [orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");

    appendStatusHistory({
      orderId,
      previousStatus: order.order_status,
      newStatus: order.order_status,
      changedBy: req.admin?.id || null,
      notes: `Quality check failed. Reason: ${reason || notes || "N/A"}`,
    }).catch((error) => {
      log("error", "return.history_failed", {
        orderId,
        error: error?.message || error,
      });
    });

    emitOrderUpdated(req, updated);
    notifyReturnEvent(updated, "Return Rejected", notes || reason);

    log("info", "return.inspection_rejected", { orderId });
    res.json({
      success: true,
      message: "Return rejected at quality check.",
      order: updated,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.inspection_reject_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to record quality check" });
  } finally {
    client.release();
  }
};

// ==========================================================================
// 6. Approve Refund
// ==========================================================================
/**
 * PATCH /api/admin/orders/:orderId/refund/approve
 *
 * Approves a refund amount for a returned order. This records the decision
 * only — it does not call Razorpay. This project has no existing Razorpay
 * refund integration (no refund-related code anywhere in paymentController.js
 * or the razorpay utils/config), so none is invented here; the admin
 * processes the actual refund separately and records it via completeRefund().
 *
 * @param {import('express').Request} req - Expects `orderId` param and
 * `{ refund_amount }` in the body.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order }` on success.
 */
export const approveRefund = async (req, res) => {
  const { orderId } = req.params;
  const { refund_amount } = req.body;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }
  if (!isPositiveNumber(refund_amount)) {
    return res.status(400).json({
      success: false,
      message: "refund_amount is required and must be a positive number",
    });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    // FIX (idempotency): a repeated click with refund_status already
    // "approved" just returns the current state rather than silently
    // re-approving with whatever amount was submitted this time.
    if (order.refund_status === "approved") {
      await client.query("ROLLBACK");
      return res.json({
        success: true,
        message: "Refund has already been approved for this order.",
        order,
      });
    }

    if (order.refund_status) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Refund has already been ${order.refund_status} for this order.`,
      });
    }

    if (order.return_status !== "returned") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `A refund can only be approved once the order is returned. Current return status is "${order.return_status || "none"}".`,
      });
    }

    // FIX (QC gate, requirement 10): a refund could previously be approved
    // the moment the courier delivered the parcel back — nobody at BREE had
    // actually looked at the product yet. Now requires the explicit
    // approveInspection step first.
    if (order.inspection_status !== "approved") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `A refund can only be approved after quality check has passed. Current inspection status is "${order.inspection_status || "none"}".`,
      });
    }

    // FIX (requirement 11 — refundable amount): payment must actually have
    // succeeded, and the requested amount can never exceed what was paid.
    if (order.payment_status !== "paid" || !order.razorpay_payment_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "This order has no successful payment to refund.",
      });
    }

    const refundableAmount = Number(order.total ?? order.amount ?? 0);
    if (Number(refund_amount) > refundableAmount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `refund_amount cannot exceed the refundable amount of ₹${refundableAmount}.`,
      });
    }

    await client.query(
      `UPDATE orders SET refund_status = 'approved', refund_amount = ?, updated_at = NOW() WHERE id = ?`,
      [Number(refund_amount), orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");
    emitOrderUpdated(req, updated);

    log("info", "return.refund_approved", { orderId, refund_amount });
    res.json({
      success: true,
      message: "Refund approved successfully.",
      order: updated,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.refund_approve_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to approve refund" });
  } finally {
    client.release();
  }
};

// ==========================================================================
// 7. Reject Refund
// ==========================================================================
/**
 * PATCH /api/admin/orders/:orderId/refund/reject
 *
 * Rejects a refund request for a returned order.
 *
 * @param {import('express').Request} req - Expects `orderId` param.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order }` on success.
 */
export const rejectRefund = async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const order = rows[0];

    if (order.refund_status === "completed") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "A completed refund cannot be rejected.",
      });
    }

    await client.query(
      `UPDATE orders SET refund_status = 'rejected', updated_at = NOW() WHERE id = ?`,
      [orderId],
    );

    const {
      rows: [updated],
    } = await client.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
      orderId,
    ]);

    await client.query("COMMIT");
    emitOrderUpdated(req, updated);

    log("info", "return.refund_rejected", { orderId });
    res.json({ success: true, message: "Refund rejected", order: updated });
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "return.refund_reject_failed", {
      orderId,
      error: err?.message || err,
    });
    res
      .status(500)
      .json({ success: false, message: "Failed to reject refund" });
  } finally {
    client.release();
  }
};

// ==========================================================================
// 8. Complete Refund
// ==========================================================================
/**
 * PATCH /api/admin/orders/:orderId/refund/complete
 *
 * FIX (requirement 11 — this project had NO Razorpay refund implementation
 * at all; this endpoint used to just record a manually-typed reference
 * string. It now actually calls Razorpay's refund API, reusing the single
 * existing initialized client (getRazorpay()) — no second Razorpay client,
 * no new config.
 *
 * Idempotent across three states, using the exact same
 * lock-off-transaction-lock shape as bulk's ensureBulkRazorpayOrder (never
 * hold a row lock across a third-party HTTP call):
 *  - refund_status === "approved"  -> creates the Razorpay refund (mode: create)
 *  - refund_status === "initiated" -> re-fetches the existing refund's
 *    status instead of creating a second one (mode: recheck) — this is what
 *    makes a repeated click, or Razorpay taking a moment to process, safe:
 *    no duplicate refund is ever created.
 *  - refund_status === "completed" -> returns current state, no Razorpay
 *    call at all.
 *
 * Razorpay refunds report status "pending" or "processed" — only
 * "processed" is treated as refund_status = "completed" here (requirement
 * 11: never mark completed just because initiation succeeded). A "pending"
 * result is stored as refund_status = "initiated"; re-calling this same
 * endpoint later re-checks it and upgrades to "completed" once Razorpay
 * confirms — there is no refund-status webhook in this codebase to do that
 * automatically, so a later admin visit is what closes the loop.
 *
 * @param {import('express').Request} req - Expects `orderId` param.
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON `{ success, message, order }` on success.
 */
export const completeRefund = async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  // ── Phase 1: lock, validate, decide create vs. recheck vs. already-done.
  const phase1 = await getClient();
  let order;
  let mode;
  try {
    await phase1.query("BEGIN");

    const { rows } = await phase1.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if (!rows.length) {
      await phase1.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    order = rows[0];

    if (order.refund_status === "completed") {
      await phase1.query("COMMIT");
      mode = "already_completed";
    } else if (order.refund_status === "initiated" && order.refund_reference) {
      await phase1.query("COMMIT");
      mode = "recheck";
    } else if (order.refund_status === "approved") {
      if (order.payment_status !== "paid" || !order.razorpay_payment_id) {
        await phase1.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "This order has no successful payment to refund.",
        });
      }
      if (!isPositiveNumber(order.refund_amount)) {
        await phase1.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "No approved refund amount found for this order.",
        });
      }
      await phase1.query("COMMIT");
      mode = "create";
    } else {
      await phase1.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Refund must be approved before it can be initiated. Current refund status is "${order.refund_status || "none"}".`,
      });
    }
  } catch (err) {
    await phase1.query("ROLLBACK");
    log("error", "return.refund_complete_failed", {
      orderId,
      error: err?.message || err,
    });
    return res
      .status(500)
      .json({ success: false, message: "Unable to initiate refund. Please try again." });
  } finally {
    phase1.release();
  }

  if (mode === "already_completed") {
    return res.json({
      success: true,
      message: "Refund has already been initiated for this order.",
      order,
    });
  }

  // ── Phase 2: talk to Razorpay with no DB transaction open. ──────────────
  const razorpay = getRazorpay();
  let razorpayRefund;
  try {
    if (mode === "create") {
      razorpayRefund = await razorpay.payments.refund(
        order.razorpay_payment_id,
        {
          amount: Math.round(Number(order.refund_amount) * 100),
          speed: "normal",
          notes: {
            order_id: order.id,
            order_number: order.order_number || "",
          },
        },
      );
    } else {
      // mode === "recheck" — check status of the refund already created;
      // never call payments.refund() a second time for the same order.
      razorpayRefund = await razorpay.refunds.fetch(order.refund_reference);
    }
  } catch (error) {
    log("error", "return.refund_razorpay_error", {
      orderId,
      mode,
      error: error?.message || error,
    });
    return res.status(502).json({
      success: false,
      message: "Unable to initiate refund. Please try again.",
    });
  }

  const isProcessed = razorpayRefund?.status === "processed";

  // ── Phase 3: short transaction to persist the result. ────────────────────
  const phase3 = await getClient();
  let updated;
  let didTransition = false;
  try {
    await phase3.query("BEGIN");

    const { rows: relockedRows } = await phase3.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    const relocked = relockedRows[0];

    if (relocked.refund_status === "completed") {
      // Another concurrent request already finished this.
      await phase3.query("COMMIT");
      updated = relocked;
    } else {
      const nextStatus = isProcessed ? "completed" : "initiated";
      didTransition = relocked.refund_status !== nextStatus;

      await phase3.query(
        `UPDATE orders
         SET refund_status = ?,
             refund_reference = ?,
             refund_completed_at = ${isProcessed ? "NOW()" : "refund_completed_at"},
             updated_at = NOW()
         WHERE id = ?`,
        [nextStatus, razorpayRefund.id, orderId],
      );
      await phase3.query("COMMIT");

      const {
        rows: [fresh],
      } = await phase3.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
        orderId,
      ]);
      updated = fresh;
    }
  } catch (err) {
    await phase3.query("ROLLBACK");
    log("error", "return.refund_persist_failed", {
      orderId,
      razorpayRefundId: razorpayRefund?.id,
      error: err?.message || err,
    });
    return res.status(500).json({
      success: false,
      message: `Refund was initiated with Razorpay (reference: ${razorpayRefund?.id}) but could not be saved. Please contact support with this reference.`,
    });
  } finally {
    phase3.release();
  }

  emitOrderUpdated(req, updated);

  // Only notify on an actual state transition — a recheck that finds the
  // refund still pending must not re-send "Refund Initiated" every time an
  // admin revisits the order.
  if (didTransition) {
    notifyReturnEvent(
      updated,
      isProcessed ? "Refund Completed" : "Refund Initiated",
      null,
    );
  }

  log("info", isProcessed ? "return.refund_completed" : "return.refund_initiated", {
    orderId,
    refundId: razorpayRefund.id,
  });

  res.json({
    success: true,
    message: isProcessed
      ? "Refund completed successfully."
      : "Refund initiated successfully.",
    order: updated,
  });
};

export default {
  approveReturn,
  rejectReturn,
  createReverseShipment,
  scheduleReversePickup,
  markReturned,
  approveInspection,
  rejectInspection,
  approveRefund,
  rejectRefund,
  completeRefund,
};
