import { getClient, query } from "../../config/database.js";
import { getRazorpay } from "../../config/razorpay.js";
import { appendStatusHistory } from "../../models/Order.js";
import { publishOrderUpdateFromRequest } from "../../services/orderRealtime.js";
import { stopRemindersForCancelledOrder } from "../../services/dailyReminderService.js";
import {
  completeRefund,
  findExistingRazorpayRefund,
  notifyReturnEvent,
} from "./returnController.js";

// ==========================================================================
// Admin "Cancel Order & Refund"
// ==========================================================================
// POST /api/admin/orders/:orderId/cancel-refund
//
// Deliberately SEPARATE from "Cancel Shipment" (shippingController.
// cancelShipment), which only cancels the Delhivery shipment and never
// touches Razorpay. This action never cancels a shipment: an order with a
// live (non-cancelled) AWB is refused until the shipment is cancelled first.
//
// This is NOT a second refund implementation. It only:
//   1. validates that the order can be cancelled and that its payment
//      belongs to it (DB + a live Razorpay payment fetch — captured only),
//   2. computes the refund amount server-side (the request body is ignored),
//   3. under row locks on orders + payments, cancels the order and moves
//      refund_status to 'approved' — the same state approveRefund produces,
//   4. hands off to the existing completeRefund, which owns the refund state
//      machine (approved -> processing -> initiated/completed, 'failed' is
//      retryable), the processing claim, Razorpay reconciliation / adoption
//      of an existing refund (findExistingRazorpayRefund), the orders +
//      payments updates, history and "Refund Initiated/Completed"
//      notifications. refund.processed / refund.failed webhooks
//      (paymentController.handleWebhook) complete or fail it later.
// Repeating the request is safe: once a refund exists or is in flight it
// goes straight to completeRefund (recheck / already-completed / 409).
// ==========================================================================

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

// Order statuses that can still be cancelled by an admin. 'cancelled' is
// included because "Cancel Shipment" already sets order_status='cancelled'
// without refunding — this action is how that order then gets its refund.
export const CANCELLABLE_ORDER_STATUSES = [
  "paid",
  "processing",
  "ready_to_ship",
  "cancelled",
];

// refund_status values meaning a refund already exists or is in flight —
// never approved again, only delegated to completeRefund.
const REFUND_IN_PROGRESS_STATUSES = ["processing", "initiated", "completed"];

const refuse = (status, code, message) => ({ ok: false, status, code, message });

/**
 * Pure eligibility check on the DB rows. Returns { ok: true } or
 * { ok: false, status, code, message }.
 */
export const evaluateCancelRefundEligibility = (order, payment) => {
  if (!order) return refuse(404, "ORDER_NOT_FOUND", "Order not found");

  if (Number(order.is_subscription) === 1 || order.razorpay_subscription_id) {
    return refuse(
      400,
      "ORDER_NOT_CANCELLABLE",
      "Subscription orders are cancelled through subscription cancellation, not Cancel Order & Refund.",
    );
  }

  if (order.return_status) {
    return refuse(
      400,
      "ORDER_NOT_CANCELLABLE",
      "This order is in the return flow — refund it through the return refund actions.",
    );
  }

  if (order.refund_status === "rejected") {
    return refuse(
      400,
      "REFUND_REJECTED",
      "A refund for this order has already been rejected.",
    );
  }

  if (!CANCELLABLE_ORDER_STATUSES.includes(order.order_status)) {
    return refuse(
      400,
      "ORDER_NOT_CANCELLABLE",
      `Order cannot be cancelled in status "${order.order_status}".`,
    );
  }

  const shipmentActive =
    Boolean(String(order.awb_number || "").trim()) &&
    String(order.tracking_status || "").toLowerCase() !== "cancelled";
  if (shipmentActive) {
    return refuse(
      409,
      "SHIPMENT_ACTIVE",
      "This order has an active Delhivery shipment. Use Cancel Shipment first — Cancel Order & Refund never cancels shipments.",
    );
  }

  if (order.payment_status !== "paid" || !order.razorpay_payment_id) {
    return refuse(
      400,
      "NO_CAPTURED_PAYMENT",
      "This order has no successful payment to refund.",
    );
  }

  if (!payment) {
    return refuse(
      409,
      "PAYMENT_MISMATCH",
      "No payment record exists for this order.",
    );
  }

  if (
    String(payment.order_id) !== String(order.id) ||
    (payment.razorpay_payment_id &&
      payment.razorpay_payment_id !== order.razorpay_payment_id) ||
    (payment.razorpay_order_id &&
      order.razorpay_order_id &&
      payment.razorpay_order_id !== order.razorpay_order_id)
  ) {
    return refuse(
      409,
      "PAYMENT_MISMATCH",
      "The payment on record does not belong to this order.",
    );
  }

  return { ok: true };
};

/**
 * Server-side refund amount (rupees) — the full amount paid for this order.
 * Same source approveRefund uses (orders.total, falling back to amount),
 * never anything from the request.
 */
export const computeCancellationRefundAmount = (order) => {
  const amount = Number(order.total ?? order.amount ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

/**
 * Validates the live Razorpay payment entity against this order.
 * Returns { ok: true, alreadyRefundedAtRazorpay } or a refusal.
 */
export const verifyRazorpayPaymentForOrder = (order, rzpPayment, refundAmount) => {
  if (!rzpPayment || rzpPayment.id !== order.razorpay_payment_id) {
    return refuse(409, "PAYMENT_MISMATCH", "Razorpay payment does not match this order.");
  }
  if (order.razorpay_order_id && rzpPayment.order_id !== order.razorpay_order_id) {
    return refuse(
      409,
      "PAYMENT_MISMATCH",
      "Razorpay payment belongs to a different Razorpay order.",
    );
  }

  const amountRefunded = Number(rzpPayment.amount_refunded || 0);
  if (rzpPayment.status === "refunded" || amountRefunded > 0) {
    // Something was refunded already — only acceptable if it is our own
    // refund (checked by the caller via findExistingRazorpayRefund).
    return { ok: true, alreadyRefundedAtRazorpay: true };
  }

  if (rzpPayment.status !== "captured") {
    return refuse(
      409,
      "PAYMENT_NOT_CAPTURED",
      `Razorpay payment is "${rzpPayment.status}", not captured — nothing to refund.`,
    );
  }

  if (Math.round(refundAmount * 100) > Number(rzpPayment.amount || 0)) {
    return refuse(
      409,
      "REFUND_AMOUNT_EXCEEDS_PAYMENT",
      "The order total exceeds the captured Razorpay amount — refund needs manual review.",
    );
  }

  return { ok: true, alreadyRefundedAtRazorpay: false };
};

const loadOrderAndPayment = async (executor, orderId, { lock = false } = {}) => {
  const suffix = lock ? " FOR UPDATE" : " LIMIT 1";
  const { rows: orderRows } = await executor(
    `SELECT * FROM orders WHERE id = ?${suffix}`,
    [orderId],
  );
  const { rows: paymentRows } = await executor(
    `SELECT * FROM payments WHERE order_id = ?${suffix}`,
    [orderId],
  );
  return { order: orderRows[0] || null, payment: paymentRows[0] || null };
};

// Tags the delegated completeRefund response as coming from this action.
const withCancellationContext = (res, extra) => ({
  status(code) {
    res.status(code);
    return this;
  },
  json(body) {
    return res.json({ ...body, ...extra });
  },
});

export const cancelOrderAndRefund = async (
  req,
  res,
  {
    getClientFn = getClient,
    queryFn = query,
    getRazorpayFn = getRazorpay,
    notifyFn = notifyReturnEvent,
  } = {},
) => {
  const { orderId } = req.params;
  if (!orderId) {
    return res
      .status(400)
      .json({ success: false, message: "Order ID is required" });
  }

  const delegate = (extra = {}) =>
    completeRefund(
      req,
      withCancellationContext(res, { action: "cancel_order_refund", ...extra }),
      { getClientFn, queryFn, getRazorpayFn },
    );

  // ── 1. Unlocked read: already in flight? eligible at all? ───────────────
  let snapshot;
  try {
    snapshot = await loadOrderAndPayment(queryFn, orderId);
  } catch (err) {
    log("error", "cancel_refund.load_failed", { orderId, error: err?.message || err });
    return res
      .status(500)
      .json({ success: false, message: "Failed to cancel order." });
  }

  if (!snapshot.order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  if (snapshot.order.return_status) {
    // Return-flow refunds have their own actions (approve/initiate refund).
    return res.status(400).json({
      success: false,
      code: "ORDER_NOT_CANCELLABLE",
      message: "This order is in the return flow — refund it through the return refund actions.",
    });
  }

  if (REFUND_IN_PROGRESS_STATUSES.includes(snapshot.order.refund_status)) {
    // Never approve twice — completeRefund rechecks/adopts/refuses.
    return delegate({ orderCancelled: snapshot.order.order_status === "cancelled" });
  }
  if (
    snapshot.order.refund_status === "approved" &&
    snapshot.order.order_status === "cancelled"
  ) {
    // A previous attempt cancelled + approved but did not reach Razorpay.
    return delegate({ orderCancelled: true });
  }

  const eligibility = evaluateCancelRefundEligibility(
    snapshot.order,
    snapshot.payment,
  );
  if (!eligibility.ok) {
    return res.status(eligibility.status).json({
      success: false,
      code: eligibility.code,
      message: eligibility.message,
    });
  }

  const refundAmount = computeCancellationRefundAmount(snapshot.order);
  if (!refundAmount) {
    return res.status(400).json({
      success: false,
      code: "NO_REFUNDABLE_AMOUNT",
      message: "This order has no refundable amount on record.",
    });
  }

  // ── 2. Verify the live Razorpay payment (no DB lock held) ───────────────
  const razorpay = getRazorpayFn();
  let rzpPayment;
  try {
    rzpPayment = await razorpay.payments.fetch(snapshot.order.razorpay_payment_id);
  } catch (err) {
    log("error", "cancel_refund.payment_fetch_failed", {
      orderId,
      error: err?.message || err,
    });
    return res.status(502).json({
      success: false,
      code: "RAZORPAY_UNAVAILABLE",
      message: "Could not verify the payment with Razorpay. Nothing was changed — please try again.",
    });
  }

  const verification = verifyRazorpayPaymentForOrder(
    snapshot.order,
    rzpPayment,
    refundAmount,
  );
  if (!verification.ok) {
    return res.status(verification.status).json({
      success: false,
      code: verification.code,
      message: verification.message,
    });
  }

  if (verification.alreadyRefundedAtRazorpay) {
    // Only proceed if the existing refund is ours (notes.order_id) — then
    // completeRefund adopts it instead of creating another.
    let ownRefund = null;
    try {
      ownRefund = await findExistingRazorpayRefund(razorpay, snapshot.order);
    } catch (err) {
      log("error", "cancel_refund.refund_lookup_failed", {
        orderId,
        error: err?.message || err,
      });
      return res.status(502).json({
        success: false,
        code: "RAZORPAY_UNAVAILABLE",
        message: "Could not check existing refunds with Razorpay. Nothing was changed — please try again.",
      });
    }
    if (!ownRefund) {
      return res.status(409).json({
        success: false,
        code: "EXTERNAL_REFUND_EXISTS",
        message: "Razorpay shows this payment was already refunded outside BREE. Reconcile it manually — no new refund was created.",
      });
    }
  }

  // ── 3. Lock order + payment, re-validate, cancel + approve atomically ───
  const client = await getClientFn();
  let order;
  let delegateOnly = false;
  try {
    await client.query("BEGIN");
    const locked = await loadOrderAndPayment(
      (sql, params) => client.query(sql, params),
      orderId,
      { lock: true },
    );
    order = locked.order;

    if (
      order &&
      (REFUND_IN_PROGRESS_STATUSES.includes(order.refund_status) ||
        (order.refund_status === "approved" && order.order_status === "cancelled"))
    ) {
      // A concurrent request got here first.
      await client.query("COMMIT");
      delegateOnly = true;
    } else {
      const lockedEligibility = evaluateCancelRefundEligibility(
        order,
        locked.payment,
      );
      if (!lockedEligibility.ok) {
        await client.query("ROLLBACK");
        return res.status(lockedEligibility.status).json({
          success: false,
          code: lockedEligibility.code,
          message: lockedEligibility.message,
        });
      }

      await client.query(
        `UPDATE orders
         SET order_status = 'cancelled',
             refund_status = 'approved',
             refund_amount = ?,
             refund_approved_at = NOW(),
             updated_at = NOW()
         WHERE id = ?`,
        [refundAmount, orderId],
      );

      await appendStatusHistory({
        orderId,
        previousStatus: order.order_status,
        newStatus: "cancelled",
        changedBy: req.admin?.id || null,
        notes: `Order cancelled by admin (Cancel Order & Refund) — refund of ₹${refundAmount} approved.${
          order.refund_status === "failed" ? " Retrying a previously failed refund." : ""
        }`,
        queryExecutor: client.query.bind(client),
      });

      // The cancelled order's daily reminders stop in this same transaction.
      await stopRemindersForCancelledOrder(orderId, {
        queryFn: (text, params) => client.query(text, params),
      });

      await client.query("COMMIT");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    log("error", "cancel_refund.cancel_failed", { orderId, error: err?.message || err });
    return res
      .status(500)
      .json({ success: false, message: "Failed to cancel order." });
  } finally {
    client.release();
  }

  if (!delegateOnly) {
    log("info", "cancel_refund.order_cancelled", { orderId, refundAmount });
    try {
      publishOrderUpdateFromRequest(req, {
        ...order,
        order_status: "cancelled",
        refund_status: "approved",
        refund_amount: refundAmount,
      });
    } catch {
      // Realtime is best-effort.
    }
    // Exactly-once per order/channel via order_status_notifications
    // (key order:{id}:status:cancelled:channel:*). "Refund Initiated"/
    // "Refund Processed" follow from completeRefund / the webhook. The
    // customer copy (including the refund amount) comes from the "cancelled"
    // event in services/customerOrderEvents.js — callers pass no free text.
    notifyFn({ ...order, refund_amount: refundAmount }, "cancelled");
  }

  // ── 4. Existing refund state machine does the Razorpay work ─────────────
  return delegate({ orderCancelled: true });
};

export default { cancelOrderAndRefund };
