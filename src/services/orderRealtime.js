/**
 * Order / product real-time events (Socket.IO) — the ONLY place the backend
 * may emit them.
 *
 * FIX (Socket.IO security audit): every controller used to call
 * `io.emit("order:updated", …)` — a broadcast to EVERY connected socket,
 * and the socket server authenticated nobody. Two admin sites sent the full
 * `SELECT * FROM orders` row (customer name, phone, email, address,
 * Razorpay order/payment/refund ids, internal notes). Even the "minimal"
 * `{ id, order_status }` events were a leak: the order UUID is the
 * credential for the public GET /api/orders/:id/tracking page, so any
 * anonymous listener could harvest ids and read each customer's tracking
 * page (name, address, items).
 *
 * Now:
 *   - Order events go ONLY to rooms the server assigned at handshake time
 *     (see services/socketAuth.js); there is no client-controlled join for
 *     admin or customer rooms at all.
 *       admins             → verified admin JWT + admins row
 *       customer:<userId>  → verified customer JWT + users row (own orders)
 *       order:<orderId>    → a socket that presented the order's UUID via
 *                            "order:track" (the public tracking page). It
 *                            receives `{ id }` only — the same capability
 *                            the UUID already grants over HTTP, nothing more.
 *   - Payloads are built by whitelisting (toSafeOrderEvent), never by
 *     spreading an order row, and only keys the caller actually had are
 *     sent (so a listener merging the payload never blanks other fields).
 */
import { query } from "../config/database.js";

export const ADMIN_ROOM = "admins";
export const customerRoom = (userId) => `customer:${userId}`;
export const orderTrackingRoom = (orderId) => `order:${orderId}`;

// Status-only fields. Justification per field: the admin Orders table and
// the customer "My Orders" list merge these into rows they already loaded
// through their authorized APIs (order_status / payment_status badges,
// return/refund/QC/reverse-tracking state in Return Management);
// updated_at orders the merge. No names, contact details, addresses,
// amounts, AWBs, payment/refund identifiers or notes — every consumer
// refetches through its normal authorized API when it needs more.
export const SAFE_ORDER_EVENT_FIELDS = Object.freeze([
  "id",
  "order_status",
  "payment_status",
  "return_status",
  "inspection_status",
  "refund_status",
  "reverse_tracking_status",
  "updated_at",
]);

export const toSafeOrderEvent = (order) => {
  const event = {};
  for (const field of SAFE_ORDER_EVENT_FIELDS) {
    if (order && Object.prototype.hasOwnProperty.call(order, field) && order[field] !== undefined) {
      event[field] = order[field];
    }
  }
  return event;
};

const log = (level, event, meta = {}) => {
  const line = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...meta });
  if (level === "error") console.error(line);
  else console.log(line);
};

const defaultLookupUserId = async (orderId) => {
  const { rows } = await query("SELECT user_id FROM orders WHERE id = ? LIMIT 1", [orderId]);
  return rows[0]?.user_id ?? null;
};

/**
 * Publishes one order change. Never throws and never blocks the caller —
 * a socket problem must not affect an order/payment/refund that has
 * already committed.
 *
 * @param {import('socket.io').Server|undefined} io
 * @param {object} order  - at least `{ id }`; any SAFE_ORDER_EVENT_FIELDS
 *                          present are forwarded, everything else dropped.
 * @param {object} [options]
 * @param {string|null} [options.userId] - the order owner, when the caller
 *   knows it (null = guest order). Defaults to order.user_id, and is looked
 *   up by id only when neither is available.
 */
export const publishOrderUpdate = (io, order, { userId, lookupUserId = defaultLookupUserId } = {}) => {
  if (!io || !order?.id) return Promise.resolve();
  try {
    const event = toSafeOrderEvent(order);
    io.to(ADMIN_ROOM).emit("order:updated", event);
    io.to(orderTrackingRoom(order.id)).emit("order:updated", { id: order.id });

    const knownUserId = userId !== undefined ? userId : order.user_id;
    const ownerPromise =
      knownUserId !== undefined ? Promise.resolve(knownUserId) : lookupUserId(order.id);

    return ownerPromise
      .then((ownerId) => {
        if (ownerId) io.to(customerRoom(ownerId)).emit("order:updated", event);
      })
      .catch((error) => {
        log("error", "realtime.order_owner_lookup_failed", { orderId: order.id, error: error?.message });
      });
  } catch (error) {
    log("error", "realtime.order_emit_failed", { orderId: order?.id, error: error?.message });
    return Promise.resolve();
  }
};

/** Convenience for Express handlers: `publishOrderUpdateFromRequest(req, order)`. */
export const publishOrderUpdateFromRequest = (req, order, options) =>
  publishOrderUpdate(req?.app?.locals?.io, order, options);

// product:* events go to every socket (the storefront refetches on them),
// so they carry `{ id }` only. Shop/Home only use the event as a "refetch"
// signal; the full products row also carried razorpay_plan_id, is_active,
// is_visible, display_order, discount and recommended_product_ids — fields
// the public catalog API (controllers/productController.js PRODUCT_SELECT)
// deliberately does not expose.
export const publishProductEvent = (io, eventType, product) => {
  if (!io || !product?.id) return;
  try {
    io.emit(`product:${eventType}`, { id: product.id });
  } catch (error) {
    log("error", "realtime.product_emit_failed", { productId: product?.id, error: error?.message });
  }
};
