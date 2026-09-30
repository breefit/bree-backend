import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";
process.env.RAZORPAY_WEBHOOK_SECRET ||= "test_webhook_secret";

const { cancelOrderAndRefund, evaluateCancelRefundEligibility } = await import(
  "../src/controllers/admin/orderCancellationController.js"
);
const { completeRefund } = await import("../src/controllers/admin/returnController.js");
const { cancelShipment } = await import("../src/controllers/shippingController.js");
const { handleWebhook } = await import("../src/controllers/paymentController.js");
const { reconcilePendingRefunds, reconcileOrderRefund } = await import(
  "../cron/refundReconciliationCron.js"
);

/**
 * Admin "Cancel Order & Refund" — separate from "Cancel Shipment", reusing
 * the existing completeRefund state machine and the refund webhooks.
 *
 * Drives the REAL controllers against:
 *  - a fake MySQL that models `SELECT ... FOR UPDATE` with a genuine async
 *    mutex per row (orders AND payments), so concurrency results mean
 *    something;
 *  - a fake Razorpay whose per-payment refund ledger behaves like the real
 *    one: a refund accepted before a timeout still exists, payment
 *    amount_refunded/status reflect non-failed refunds.
 * Orders carry no contact email/phone, so the real notifyReturnEvent that
 * completeRefund uses no-ops; the cancellation notification is injected and
 * counted. No real DB, Razorpay, or Delhivery call.
 */

const createMutex = () => {
  let locked = false;
  const waiters = [];
  return {
    acquire() {
      if (!locked) {
        locked = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else locked = false;
    },
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (sql) => sql.replace(/\s+/g, " ").trim();

const createFakeDb = ({ order, payment }) => {
  const orders = new Map([[order.id, { ...order }]]);
  const payments = new Map(payment ? [[payment.order_id, { ...payment }]] : []);
  const history = [];
  const remindersStopped = [];
  const webhookEvents = new Map();
  const locks = new Map();
  const lockFor = (key) => {
    if (!locks.has(key)) locks.set(key, createMutex());
    return locks.get(key);
  };

  const makeClient = () => {
    const held = [];
    const releaseAll = () => {
      while (held.length) lockFor(held.pop()).release();
    };

    const run = async (sql, params = []) => {
      const q = norm(sql);

      if (q === "BEGIN") return { rows: [], rowCount: 0 };
      if (q === "COMMIT" || q === "ROLLBACK") {
        releaseAll();
        return { rows: [], rowCount: 0 };
      }

      // ── orders ────────────────────────────────────────────────────────
      if (q === "SELECT * FROM orders WHERE id = ? FOR UPDATE") {
        await lockFor(`orders:${params[0]}`).acquire();
        held.push(`orders:${params[0]}`);
        const row = orders.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (q === "SELECT * FROM orders WHERE id = ? LIMIT 1") {
        const row = orders.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (
        q.startsWith(
          "SELECT id, order_number, order_status, tracking_status, awb_number, contact_name, contact_email FROM orders WHERE id = ?",
        )
      ) {
        const row = orders.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (
        q.startsWith(
          "UPDATE orders SET order_status = 'cancelled', refund_status = 'approved', refund_amount = ?",
        )
      ) {
        const [amount, id] = params;
        const row = orders.get(id);
        Object.assign(row, {
          order_status: "cancelled",
          refund_status: "approved",
          refund_amount: amount,
          refund_approved_at: new Date(),
          updated_at: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (q === "UPDATE orders SET refund_status = 'processing', updated_at = NOW() WHERE id = ?") {
        const row = orders.get(params[0]);
        row.refund_status = "processing";
        row.updated_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (
        q ===
        "UPDATE orders SET refund_status = 'approved', updated_at = NOW() WHERE id = ? AND refund_status = 'processing'"
      ) {
        const row = orders.get(params[0]);
        if (row?.refund_status !== "processing") return { rows: [], rowCount: 0 };
        row.refund_status = "approved";
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE orders SET refund_status = ?, refund_reference = ?")) {
        const [nextStatus, reference, id] = params;
        const row = orders.get(id);
        row.refund_status = nextStatus;
        row.refund_reference = reference;
        if (nextStatus === "completed") {
          row.payment_status = "refunded";
          row.refund_completed_at = new Date();
        }
        return { rows: [], rowCount: 1 };
      }
      if (
        q.startsWith("UPDATE orders SET refund_status = 'failed', updated_at = NOW() WHERE id = ? AND refund_status = 'initiated'")
      ) {
        const [id, reference] = params;
        const row = orders.get(id);
        if (row?.refund_status !== "initiated" || row.refund_reference !== reference) {
          return { rows: [], rowCount: 0 };
        }
        row.refund_status = "failed";
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE orders SET tracking_status = ?, order_status = ?")) {
        const [trackingStatus, orderStatus, , id] = params;
        Object.assign(orders.get(id), {
          tracking_status: trackingStatus,
          order_status: orderStatus,
        });
        return { rows: [], rowCount: 1 };
      }

      // ── payments ──────────────────────────────────────────────────────
      if (q === "SELECT * FROM payments WHERE order_id = ? FOR UPDATE") {
        await lockFor(`payments:${params[0]}`).acquire();
        held.push(`payments:${params[0]}`);
        const row = payments.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (q === "SELECT * FROM payments WHERE order_id = ? LIMIT 1") {
        const row = payments.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (q.startsWith("UPDATE payments SET refund_id = ?, refund_amount = ?, status = CASE WHEN ? = 1")) {
        // completeRefund Phase 3
        const [refundId, amount, processed, , orderId] = params;
        const row = payments.get(orderId);
        row.refund_id = refundId;
        row.refund_amount = amount;
        if (processed === 1 && amount >= row.amount) row.status = "refunded";
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE payments SET refund_id = ?, refund_amount = ?, status = CASE WHEN ? >= amount")) {
        // refund.processed webhook
        const [refundId, amount, , orderId] = params;
        const row = payments.get(orderId);
        row.refund_id = refundId;
        row.refund_amount = amount;
        if (amount >= row.amount) row.status = "refunded";
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE payments SET refund_id = NULL, refund_amount = NULL")) {
        const [orderId, refundId] = params;
        const row = payments.get(orderId);
        if (row?.refund_id !== refundId) return { rows: [], rowCount: 0 };
        row.refund_id = null;
        row.refund_amount = null;
        return { rows: [], rowCount: 1 };
      }

      // ── history ───────────────────────────────────────────────────────
      if (q.startsWith("INSERT INTO order_status_history")) {
        history.push(params);
        return { rows: [], rowCount: 1 };
      }

      // ── webhook ledger + refund webhook statements ────────────────────
      if (q.startsWith("INSERT INTO webhook_events")) {
        const [, provider, eventId] = params;
        const key = `${provider}:${eventId}`;
        if (webhookEvents.has(key)) {
          const dup = new Error("Duplicate entry");
          dup.code = "ER_DUP_ENTRY";
          throw dup;
        }
        webhookEvents.set(key, "processing");
        return { rows: [], rowCount: 1 };
      }
      if (q === "SELECT status FROM webhook_events WHERE provider = ? AND event_id = ? LIMIT 1") {
        const status = webhookEvents.get(`${params[0]}:${params[1]}`);
        return { rows: status ? [{ status }] : [] };
      }
      if (q.startsWith("UPDATE webhook_events SET status = 'processing'")) {
        return { rows: [], rowCount: 0 };
      }
      if (q.startsWith("UPDATE webhook_events SET status = 'completed'")) {
        webhookEvents.set(`${params[0]}:${params[1]}`, "completed");
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE webhook_events SET status = 'failed'")) {
        webhookEvents.set(`${params[1]}:${params[2]}`, "failed");
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("SELECT * FROM orders WHERE refund_reference = ? OR (refund_reference IS NULL")) {
        const [reference, paymentId] = params;
        const rows = [...orders.values()].filter(
          (r) =>
            r.refund_reference === reference ||
            (r.refund_reference == null &&
              r.refund_status === "processing" &&
              r.razorpay_payment_id === paymentId),
        );
        return { rows: rows.map((r) => ({ ...r })) };
      }
      if (q.startsWith("UPDATE orders SET refund_status = 'completed'")) {
        const [reference, id, guard] = params;
        const row = orders.get(id);
        if (
          !row ||
          !["initiated", "processing"].includes(row.refund_status) ||
          !(row.refund_reference === guard || row.refund_reference == null)
        ) {
          return { rows: [], rowCount: 0 };
        }
        Object.assign(row, {
          refund_status: "completed",
          payment_status: "refunded",
          refund_reference: row.refund_reference ?? reference,
          refund_completed_at: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE orders SET refund_status = 'failed', refund_reference = COALESCE")) {
        const [reference, id, guard] = params;
        const row = orders.get(id);
        if (
          !row ||
          !["initiated", "processing"].includes(row.refund_status) ||
          !(row.refund_reference === guard || row.refund_reference == null)
        ) {
          return { rows: [], rowCount: 0 };
        }
        row.refund_status = "failed";
        row.refund_reference = row.refund_reference ?? reference;
        return { rows: [], rowCount: 1 };
      }

if (q.startsWith("UPDATE orders SET refund_gateway_status = COALESCE(?, refund_gateway_status)")) {
  const [gatewayStatus, rrn, id] = params;
  const row = orders.get(id);
  if (row) {
    if (gatewayStatus != null) row.refund_gateway_status = gatewayStatus;
    if (rrn != null) row.refund_rrn = rrn;
  }
  return { rows: [], rowCount: row ? 1 : 0 };
}

      // Refund reconciliation cron's candidate query.
      if (q.startsWith("SELECT id, refund_status FROM orders WHERE refund_status IN ('initiated', 'processing')")) {
        const rows = [...orders.values()]
          .filter((r) => ["initiated", "processing"].includes(r.refund_status))
          .map((r) => ({ id: r.id, refund_status: r.refund_status }));
        return { rows, rowCount: rows.length };
      }

      // Cancellation also locks the row (Cancel Shipment) and stops reminders.
      if (q === "SELECT id FROM orders WHERE id = ? FOR UPDATE") {
        await lockFor(`orders:${params[0]}`).acquire();
        held.push(`orders:${params[0]}`);
        return { rows: orders.has(params[0]) ? [{ id: params[0] }] : [], rowCount: 1 };
      }
      if (q.startsWith("UPDATE daily_reminders SET reminder_enabled = 0, status = 'ended'")) {
        remindersStopped.push(params[0]);
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unhandled fake SQL in cancelOrderRefund test: ${q}`);
    };

    return { query: run, release: releaseAll };
  };

  return {
    getClientFn: async () => makeClient(),
    queryFn: (sql, params) => makeClient().query(sql, params),
    orders,
    payments,
    history,
    remindersStopped,
  };
};

const createFakeRazorpay = ({
  payment = {},
  paymentFetchError = null,
  refundStatus = "pending",
  refundDelayMs = 15,
  // "accept_then_timeout": Razorpay creates the refund, response is lost.
  // "timeout": request never reached Razorpay.
  failFirstRefund = null,
  existingRefunds = [],
} = {}) => {
  const ledger = [...existingRefunds];
  const counts = { refund: 0, paymentFetch: 0, refundFetch: 0 };
  let seq = 0;

  const paymentEntity = () => {
    const refunded = ledger
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amount, 0);
    const base = {
      id: "pay_1",
      order_id: "order_rzp_1",
      amount: 50000,
      currency: "INR",
      status: "captured",
      ...payment,
    };
    return {
      ...base,
      amount_refunded: refunded,
      status: refunded >= base.amount ? "refunded" : base.status,
    };
  };

  const getRazorpayFn = () => ({
    payments: {
      fetch: async (id) => {
        counts.paymentFetch += 1;
        if (paymentFetchError) throw paymentFetchError;
        return { ...paymentEntity(), id: payment.id ?? id };
      },
      refund: async (paymentId, params) => {
        counts.refund += 1;
        await sleep(refundDelayMs);
        const attempt = counts.refund;
        if (attempt === 1 && failFirstRefund === "timeout") {
          const err = new Error("timeout of 30000ms exceeded");
          err.code = "ECONNABORTED";
          throw err;
        }
        seq += 1;
        const created = {
          id: `rfnd_${seq}`,
          payment_id: paymentId,
          amount: params.amount,
          status: refundStatus,
          notes: params.notes,
        };
        ledger.push(created);
        if (attempt === 1 && failFirstRefund === "accept_then_timeout") {
          const err = new Error("timeout of 30000ms exceeded");
          err.code = "ECONNABORTED";
          throw err;
        }
        return { ...created };
      },
      fetchMultipleRefund: async () => ({
        entity: "collection",
        count: ledger.length,
        items: ledger.map((r) => ({ ...r })),
      }),
    },
    refunds: {
      fetch: async (id) => {
        counts.refundFetch += 1;
        const r = ledger.find((x) => x.id === id);
        return r ? { ...r } : { id, status: "pending" };
      },
    },
  });

  return { getRazorpayFn, counts, ledger };
};

const ORDER_ID = "order-cancel-1";

const baseOrder = (overrides = {}) => ({
  id: ORDER_ID,
  order_number: "BREE-100500",
  order_status: "processing",
  payment_status: "paid",
  razorpay_payment_id: "pay_1",
  razorpay_order_id: "order_rzp_1",
  is_subscription: 0,
  razorpay_subscription_id: null,
  total: 500,
  amount: 500,
  awb_number: null,
  tracking_status: null,
  return_status: null,
  refund_status: null,
  refund_amount: null,
  refund_reference: null,
  updated_at: new Date(),
  ...overrides,
});

const basePayment = (overrides = {}) => ({
  id: "payment-row-1",
  order_id: ORDER_ID,
  razorpay_order_id: "order_rzp_1",
  razorpay_payment_id: "pay_1",
  amount: 500,
  status: "captured",
  refund_id: null,
  refund_amount: null,
  ...overrides,
});

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const setup = ({ order = {}, payment = {}, rzp = {} } = {}) => {
  const db = createFakeDb({ order: baseOrder(order), payment: basePayment(payment) });
  const razorpay = createFakeRazorpay(rzp);
  const notifications = [];
  const deps = {
    getClientFn: db.getClientFn,
    queryFn: db.queryFn,
    getRazorpayFn: razorpay.getRazorpayFn,
    notifyFn: (o, label) => notifications.push([o.id, label]),
  };
  const cancel = async (body = {}) => {
    const res = makeRes();
    await cancelOrderAndRefund({ params: { orderId: ORDER_ID }, body, app: {} }, res, deps);
    return res;
  };
  return { db, razorpay, notifications, deps, cancel };
};

const signedWebhook = (event, refund) => {
  const payload = { event, payload: { refund: { entity: refund } } };
  const rawBody = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return { headers: { "x-razorpay-signature": signature }, rawBody, body: payload, app: {} };
};

const historyMatching = (db, pattern) =>
  db.history.filter((params) => params.some((p) => pattern.test(String(p))));
const cancelHistory = (db) => historyMatching(db, /Cancel Order & Refund/);

// ── 1. Cancel Shipment never refunds ─────────────────────────────────────

test("Cancel Shipment only cancels the shipment — no refund, payment untouched; Cancel Order & Refund is a separate later action", async () => {
  const { db, razorpay, cancel } = setup({
    order: { order_status: "shipped", awb_number: "58045510000055", tracking_status: "Manifested" },
  });
  let delhiveryCalls = 0;
  const res = makeRes();
  await cancelShipment({ params: { orderId: ORDER_ID }, body: {}, app: {} }, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: {
      cancelShipment: async () => {
        delhiveryCalls += 1;
        return { status: true, remark: "Shipment has been cancelled" };
      },
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(delhiveryCalls, 1);
  const order = db.orders.get(ORDER_ID);
  assert.equal(order.order_status, "cancelled");
  assert.equal(order.tracking_status, "Cancelled");
  assert.equal(order.refund_status, null, "shipment cancellation must not start a refund");
  assert.equal(order.payment_status, "paid");
  assert.equal(db.payments.get(ORDER_ID).status, "captured");
  assert.equal(db.payments.get(ORDER_ID).refund_id, null);
  assert.equal(razorpay.counts.refund, 0);
  assert.equal(razorpay.counts.paymentFetch, 0);

  // The explicit, separate action then refunds the already-cancelled order.
  const refundRes = await cancel();
  assert.equal(refundRes.statusCode, 200);
  assert.equal(razorpay.counts.refund, 1);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
});

test("Cancel Order & Refund never cancels a live shipment — refused until Cancel Shipment is used", async () => {
  const { db, razorpay, cancel, notifications } = setup({
    order: { order_status: "ready_to_ship", awb_number: "58045510000055", tracking_status: "Manifested" },
  });
  const res = await cancel();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "SHIPMENT_ACTIVE");
  assert.equal(razorpay.counts.refund, 0);
  assert.equal(db.orders.get(ORDER_ID).order_status, "ready_to_ship");
  assert.equal(db.orders.get(ORDER_ID).refund_status, null);
  assert.equal(notifications.length, 0);
});

// ── 2. Captured payment → refund initiated ───────────────────────────────

test("cancel order + captured payment → order cancelled, refund initiated through completeRefund with a server-side amount", async () => {
  const { db, razorpay, cancel, notifications } = setup();
  // A client-supplied amount must be ignored.
  const res = await cancel({ refund_amount: 1, amount: 1 });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.orderCancelled, true);
  assert.equal(res.body.action, "cancel_order_refund");
  assert.equal(razorpay.counts.paymentFetch, 1, "payment verified with Razorpay first");
  assert.equal(razorpay.counts.refund, 1);
  assert.equal(razorpay.ledger[0].amount, 50000, "full order total in paise, never the body's amount");
  assert.equal(razorpay.ledger[0].notes.order_id, ORDER_ID);

  const order = db.orders.get(ORDER_ID);
  assert.equal(order.order_status, "cancelled");
  assert.equal(order.refund_status, "initiated");
  assert.equal(order.refund_amount, 500);
  assert.equal(order.refund_reference, "rfnd_1");
  assert.equal(order.payment_status, "paid", "not refunded until Razorpay reports processed");

  const payment = db.payments.get(ORDER_ID);
  assert.equal(payment.refund_id, "rfnd_1");
  assert.equal(payment.refund_amount, 500);
  assert.equal(payment.status, "captured");

  assert.equal(cancelHistory(db).length, 1);
  assert.deepEqual(notifications, [[ORDER_ID, "cancelled"]]);
  assert.deepEqual(db.remindersStopped, [ORDER_ID], "cancellation stops the order's reminders in its transaction");
});

// BREE-100020 regression: Razorpay's create-refund response already said
// "processed" (UPI) and BREE marked the refund Completed one second after
// creating it. Creation now always stops at 'initiated'.
test("Cancel Order & Refund where Razorpay's create response already says 'processed' → cancelled + initiated, NOT completed", async () => {
  const { db, cancel } = setup({ rzp: { refundStatus: "processed" } });
  const res = await cancel();
  assert.equal(res.statusCode, 200);
  const order = db.orders.get(ORDER_ID);
  assert.equal(order.order_status, "cancelled");
  assert.equal(order.refund_status, "initiated");
  assert.equal(order.payment_status, "paid");
  assert.equal(order.refund_gateway_status, "processed", "Razorpay's own status is recorded for admins");
  assert.equal(db.payments.get(ORDER_ID).status, "captured");
  assert.equal(db.payments.get(ORDER_ID).refund_id, "rfnd_1");
});

// ── 3. Verification before refunding ─────────────────────────────────────

test("refuses — with no state change and no refund — when the payment is not captured, not this order's, or Razorpay can't be reached", async () => {
  const cases = [
    { name: "authorized only", rzp: { payment: { status: "authorized" } }, status: 409, code: "PAYMENT_NOT_CAPTURED" },
    { name: "different Razorpay order", rzp: { payment: { order_id: "order_rzp_OTHER" } }, status: 409, code: "PAYMENT_MISMATCH" },
    { name: "payments row has another payment id", payment: { razorpay_payment_id: "pay_OTHER" }, status: 409, code: "PAYMENT_MISMATCH" },
    { name: "Razorpay fetch fails", rzp: { paymentFetchError: new Error("ETIMEDOUT") }, status: 502, code: "RAZORPAY_UNAVAILABLE" },
    { name: "delivered order", order: { order_status: "delivered" }, status: 400, code: "ORDER_NOT_CANCELLABLE" },
    { name: "return-flow order", order: { order_status: "delivered", return_status: "returned" }, status: 400, code: "ORDER_NOT_CANCELLABLE" },
    { name: "unpaid order", order: { payment_status: "pending" }, status: 400, code: "NO_CAPTURED_PAYMENT" },
    { name: "subscription order", order: { is_subscription: 1 }, status: 400, code: "ORDER_NOT_CANCELLABLE" },
  ];

  for (const c of cases) {
    const { db, razorpay, cancel, notifications } = setup(c);
    const before = { ...db.orders.get(ORDER_ID) };
    const res = await cancel();
    assert.equal(res.statusCode, c.status, c.name);
    assert.equal(res.body.code, c.code, c.name);
    assert.equal(razorpay.counts.refund, 0, c.name);
    assert.equal(db.orders.get(ORDER_ID).order_status, before.order_status, c.name);
    assert.equal(db.orders.get(ORDER_ID).refund_status, before.refund_status, c.name);
    assert.equal(notifications.length, 0, c.name);
  }
});

test("eligibility helper: cancelled-by-shipment orders stay eligible; rejected refunds do not", () => {
  const payment = basePayment();
  assert.equal(
    evaluateCancelRefundEligibility(baseOrder({ order_status: "cancelled", awb_number: "1", tracking_status: "Cancelled" }), payment).ok,
    true,
  );
  assert.equal(evaluateCancelRefundEligibility(baseOrder({ refund_status: "rejected" }), payment).code, "REFUND_REJECTED");
  assert.equal(evaluateCancelRefundEligibility(baseOrder(), null).code, "PAYMENT_MISMATCH");
});

// ── 4. No duplicate refunds ──────────────────────────────────────────────

test("already refunded → repeating Cancel Order & Refund never creates a second refund", async () => {
  // (a) initiated: repeat → recheck only
  const a = setup();
  await a.cancel();
  const again = await a.cancel();
  assert.equal(again.statusCode, 200);
  assert.equal(a.razorpay.counts.refund, 1);
  assert.equal(a.razorpay.counts.refundFetch, 1, "second call only rechecks the existing refund");
  assert.equal(cancelHistory(a.db).length, 1);
  assert.equal(a.notifications.length, 1);

  // (b) completed: repeat → already completed, no Razorpay call at all
  const b = setup({ order: { order_status: "cancelled", refund_status: "completed", refund_reference: "rfnd_old", refund_amount: 500, payment_status: "refunded" } });
  const done = await b.cancel();
  assert.equal(done.statusCode, 200);
  assert.match(done.body.message, /already/i);
  assert.equal(b.razorpay.counts.refund, 0);
  assert.equal(b.razorpay.counts.paymentFetch, 0);

  // (c) Razorpay already holds OUR refund but BREE lost it → adopted
  const c = setup({
    rzp: { existingRefunds: [{ id: "rfnd_ours", amount: 50000, status: "pending", notes: { order_id: ORDER_ID } }] },
  });
  const adopted = await c.cancel();
  assert.equal(adopted.statusCode, 200);
  assert.equal(c.razorpay.counts.refund, 0, "existing refund adopted, not duplicated");
  assert.equal(c.db.orders.get(ORDER_ID).refund_reference, "rfnd_ours");
  assert.equal(c.db.payments.get(ORDER_ID).refund_id, "rfnd_ours");

  // (d) refunded outside BREE → refused, nothing changed
  const d = setup({
    rzp: { existingRefunds: [{ id: "rfnd_dashboard", amount: 50000, status: "processed", notes: {} }] },
  });
  const external = await d.cancel();
  assert.equal(external.statusCode, 409);
  assert.equal(external.body.code, "EXTERNAL_REFUND_EXISTS");
  assert.equal(d.razorpay.counts.refund, 0);
  assert.equal(d.db.orders.get(ORDER_ID).refund_status, null);
});

// ── 5. Timeout → reconcile ──────────────────────────────────────────────

test("refund API timeout after Razorpay accepted the refund → reconciled and adopted, never re-created", async () => {
  const { db, razorpay, cancel } = setup({ rzp: { failFirstRefund: "accept_then_timeout" } });
  const res = await cancel();

  assert.equal(res.statusCode, 200);
  assert.equal(razorpay.counts.refund, 1);
  assert.equal(razorpay.ledger.length, 1);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
  assert.equal(db.orders.get(ORDER_ID).refund_reference, "rfnd_1");

  // A retry afterwards only rechecks.
  await cancel();
  assert.equal(razorpay.counts.refund, 1);
});

test("refund API timeout where Razorpay created nothing → back to 'approved' (retryable); the retry creates exactly one refund", async () => {
  const { db, razorpay, cancel } = setup({ rzp: { failFirstRefund: "timeout" } });
  const first = await cancel();
  assert.equal(first.statusCode, 502);
  assert.equal(db.orders.get(ORDER_ID).order_status, "cancelled");
  assert.equal(db.orders.get(ORDER_ID).refund_status, "approved");
  assert.equal(razorpay.ledger.length, 0);

  const retry = await cancel();
  assert.equal(retry.statusCode, 200);
  assert.equal(razorpay.ledger.length, 1);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
  assert.equal(cancelHistory(db).length, 1, "the order is cancelled once, not per attempt");
});

// ── 6. Webhooks ──────────────────────────────────────────────────────────

test("refund.processed webhook → refund completed, orders.payment_status and payments.status refunded", async () => {
  const { db, cancel } = setup();
  await cancel();
  const notified = [];
  const res = makeRes();
  await handleWebhook(
    signedWebhook("refund.processed", {
      id: "rfnd_1",
      payment_id: "pay_1",
      status: "processed",
      notes: { order_id: ORDER_ID },
    }),
    res,
    { queryFn: db.queryFn, notifyRefundEvent: (o, label) => notified.push(label) },
  );

  assert.equal(res.statusCode, 200);
  const order = db.orders.get(ORDER_ID);
  assert.equal(order.refund_status, "completed");
  assert.equal(order.payment_status, "refunded");
  const payment = db.payments.get(ORDER_ID);
  assert.equal(payment.status, "refunded");
  assert.equal(payment.refund_id, "rfnd_1");
  assert.equal(payment.refund_amount, 500);
  assert.deepEqual(notified, ["Refund Completed"]);
});

test("refund.failed webhook → recoverable 'failed' state; retry creates exactly one new refund; a late webhook for the old refund changes nothing", async () => {
  const { db, razorpay, cancel } = setup();
  await cancel();
  razorpay.ledger[0].status = "failed";

  await handleWebhook(
    signedWebhook("refund.failed", { id: "rfnd_1", payment_id: "pay_1", status: "failed", notes: { order_id: ORDER_ID } }),
    makeRes(),
    { queryFn: db.queryFn, notifyRefundEvent: () => assert.fail("no completion notification on failure") },
  );

  let order = db.orders.get(ORDER_ID);
  assert.equal(order.refund_status, "failed");
  assert.equal(order.payment_status, "paid", "no money moved");
  assert.equal(db.payments.get(ORDER_ID).status, "captured");
  assert.equal(db.payments.get(ORDER_ID).refund_id, "rfnd_1", "failed refund id preserved for audit");
  assert.equal(historyMatching(db, /FAILED — refund status set to failed/).length, 1);

  // Recover: the admin retries.
  const retry = await cancel();
  assert.equal(retry.statusCode, 200);
  assert.equal(razorpay.counts.refund, 2);
  order = db.orders.get(ORDER_ID);
  assert.equal(order.refund_status, "initiated");
  assert.equal(order.refund_reference, "rfnd_2");
  assert.equal(db.payments.get(ORDER_ID).refund_id, "rfnd_2");

  // A late failure event for the OLD refund id (distinct payload, so the
  // webhook_events de-dup does not short-circuit it) must not touch the retry.
  await handleWebhook(
    signedWebhook("refund.failed", { id: "rfnd_1", payment_id: "pay_1", status: "failed", notes: { order_id: ORDER_ID }, created_at: 2 }),
    makeRes(),
    { queryFn: db.queryFn },
  );
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
  assert.equal(db.orders.get(ORDER_ID).refund_reference, "rfnd_2");
});

test("existing 'Initiate Refund' (completeRefund) also retries a failed refund, and a recheck that finds Razorpay FAILED records 'failed'", async () => {
  const { db, razorpay, cancel, deps } = setup();
  await cancel();
  razorpay.ledger[0].status = "failed";

  const recheck = makeRes();
  await completeRefund({ params: { orderId: ORDER_ID }, app: {} }, recheck, deps);
  assert.equal(recheck.statusCode, 409);
  assert.equal(recheck.body.code, "RAZORPAY_REFUND_FAILED");
  assert.equal(db.orders.get(ORDER_ID).refund_status, "failed");

  const retry = makeRes();
  await completeRefund({ params: { orderId: ORDER_ID }, app: {} }, retry, deps);
  assert.equal(retry.statusCode, 200);
  assert.equal(razorpay.counts.refund, 2);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
});

// ── 7. Concurrency ──────────────────────────────────────────────────────

test("concurrent Cancel Order & Refund requests (plus a concurrent Initiate Refund) → exactly one Razorpay refund, one cancellation, one notification", async () => {
  const { db, razorpay, cancel, deps, notifications } = setup({ rzp: { refundDelayMs: 25 } });

  const initiate = async () => {
    const res = makeRes();
    await completeRefund({ params: { orderId: ORDER_ID }, app: {} }, res, deps);
    return res;
  };
  const responses = await Promise.all([cancel(), cancel(), cancel(), initiate()]);

  assert.equal(razorpay.counts.refund, 1, "exactly one refund created");
  assert.equal(razorpay.ledger.length, 1);
  assert.equal(cancelHistory(db).length, 1, "order cancelled exactly once");
  assert.deepEqual(notifications, [[ORDER_ID, "cancelled"]]);

  const order = db.orders.get(ORDER_ID);
  assert.equal(order.order_status, "cancelled");
  assert.equal(order.refund_status, "initiated");
  assert.equal(order.refund_reference, "rfnd_1");

  const ok = responses.filter((r) => r.statusCode === 200);
  const refused = responses.filter((r) => r.statusCode !== 200);
  assert.ok(ok.length >= 1);
  for (const r of refused) {
    assert.ok([400, 409].includes(r.statusCode), `unexpected ${r.statusCode}: ${r.body?.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// Refund lifecycle (BREE-100020): processing → initiated → completed/failed.
// Creating a refund never completes it; refund.processed or a verified
// Razorpay status check does. Reconciliation never creates a refund.
// ════════════════════════════════════════════════════════════════════════

const processedWebhook = (refundId, extra = {}) =>
  signedWebhook("refund.processed", {
    id: refundId,
    payment_id: "pay_1",
    status: "processed",
    notes: { order_id: ORDER_ID },
    acquirer_data: { rrn: "627320498946" },
    ...extra,
  });

test("lifecycle: refund creation → 'processing' while Razorpay is called → 'initiated' afterwards, never 'completed'", async () => {
  const { db, cancel } = setup({ rzp: { refundStatus: "processed", refundDelayMs: 30 } });
  const pending = cancel();
  await sleep(10);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "processing", "claimed while Razorpay is being called");
  const res = await pending;
  assert.equal(res.statusCode, 200);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
  assert.notEqual(db.orders.get(ORDER_ID).refund_status, "completed");
  assert.equal(historyMatching(db, /Refund completed/).length, 0);
});

test("lifecycle: verified refund.processed → initiated → completed, stores RRN and Razorpay status, payments refunded, one history row + one notification", async () => {
  const { db, cancel } = setup();
  await cancel();
  const notified = [];
  await handleWebhook(processedWebhook("rfnd_1"), makeRes(), {
    queryFn: db.queryFn,
    notifyRefundEvent: (o, label) => notified.push(label),
  });

  const order = db.orders.get(ORDER_ID);
  assert.equal(order.refund_status, "completed");
  assert.equal(order.payment_status, "refunded");
  assert.equal(order.refund_rrn, "627320498946");
  assert.equal(order.refund_gateway_status, "processed");
  assert.equal(db.payments.get(ORDER_ID).status, "refunded");
  assert.deepEqual(notified, ["Refund Completed"]);
  assert.equal(historyMatching(db, /confirmed completed via webhook/).length, 1);
});

test("lifecycle: duplicate refund.processed (same event, and a distinct re-delivery) → no duplicate history, notification or state change", async () => {
  const { db, razorpay, cancel } = setup();
  await cancel();
  const notified = [];
  const deps = { queryFn: db.queryFn, notifyRefundEvent: (o, label) => notified.push(label) };
  await handleWebhook(processedWebhook("rfnd_1"), makeRes(), deps);
  const dup = makeRes();
  await handleWebhook(processedWebhook("rfnd_1"), dup, deps); // ledger duplicate
  await handleWebhook(processedWebhook("rfnd_1", { created_at: 2 }), makeRes(), deps); // new event id, stale
  assert.equal(dup.body.duplicate, true);
  assert.deepEqual(notified, ["Refund Completed"]);
  assert.equal(historyMatching(db, /confirmed completed via webhook/).length, 1);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "completed");
  assert.equal(razorpay.counts.refund, 1, "never a second refund");
});

test("lifecycle: refund.processed whose payment belongs to a different order is ignored", async () => {
  const { db, cancel } = setup();
  await cancel();
  await handleWebhook(processedWebhook("rfnd_1", { payment_id: "pay_SOMEONE_ELSE" }), makeRes(), {
    queryFn: db.queryFn,
    notifyRefundEvent: () => assert.fail("must not notify"),
  });
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
});

test("lifecycle: refund.failed from 'processing' (webhook raced the create call) → failed, refund id kept for audit", async () => {
  const { db, cancel } = setup({ rzp: { refundDelayMs: 40 } });
  const pending = cancel();
  await sleep(10);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "processing");
  // Razorpay created rfnd_1 and failed it before BREE saved the id.
  await sleep(35);
  await handleWebhook(
    signedWebhook("refund.failed", { id: "rfnd_1", payment_id: "pay_1", status: "failed", notes: { order_id: ORDER_ID } }),
    makeRes(),
    { queryFn: db.queryFn },
  );
  await pending;
  const order = db.orders.get(ORDER_ID);
  assert.equal(order.refund_status, "failed", "the in-flight create never overwrites the failure");
  assert.equal(order.refund_reference, "rfnd_1");
  assert.equal(order.payment_status, "paid");
});

test("lifecycle: a stale refund.failed after the refund completed → completed remains completed", async () => {
  const { db, cancel } = setup();
  await cancel();
  await handleWebhook(processedWebhook("rfnd_1"), makeRes(), { queryFn: db.queryFn, notifyRefundEvent: () => {} });
  await handleWebhook(
    signedWebhook("refund.failed", { id: "rfnd_1", payment_id: "pay_1", status: "failed", notes: { order_id: ORDER_ID } }),
    makeRes(),
    { queryFn: db.queryFn },
  );
  const order = db.orders.get(ORDER_ID);
  assert.equal(order.refund_status, "completed");
  assert.equal(order.payment_status, "refunded");
  assert.equal(db.payments.get(ORDER_ID).status, "refunded");
});

test("lifecycle: retry after failure → failed → processing → initiated → completed, exactly one new refund", async () => {
  const { db, razorpay, cancel } = setup({ rzp: { refundDelayMs: 25 } });
  await cancel();
  razorpay.ledger[0].status = "failed";
  await handleWebhook(
    signedWebhook("refund.failed", { id: "rfnd_1", payment_id: "pay_1", status: "failed", notes: { order_id: ORDER_ID } }),
    makeRes(),
    { queryFn: db.queryFn },
  );
  assert.equal(db.orders.get(ORDER_ID).refund_status, "failed");

  const retry = cancel();
  await sleep(10);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "processing");
  await retry;
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
  assert.equal(db.orders.get(ORDER_ID).refund_reference, "rfnd_2");

  await handleWebhook(processedWebhook("rfnd_2"), makeRes(), { queryFn: db.queryFn, notifyRefundEvent: () => {} });
  assert.equal(db.orders.get(ORDER_ID).refund_status, "completed");
  assert.equal(razorpay.counts.refund, 2, "one original + one retry, nothing more");
});

// ── Reconciliation ─────────────────────────────────────────────────────

test("reconciliation: Razorpay 'processed' → completed (payments refunded, RRN stored)", async () => {
  const { db, razorpay, cancel, deps } = setup();
  await cancel();
  Object.assign(razorpay.ledger[0], { status: "processed", acquirer_data: { rrn: "RRN-TEST-1" } });

  const results = await reconcilePendingRefunds(deps);

  assert.equal(results.length, 1);
  const order = db.orders.get(ORDER_ID);
  assert.equal(order.refund_status, "completed");
  assert.equal(order.payment_status, "refunded");
  assert.equal(order.refund_rrn, "RRN-TEST-1");
  assert.equal(db.payments.get(ORDER_ID).status, "refunded");
  assert.equal(razorpay.counts.refund, 1, "reconciliation never creates a refund");
});

test("reconciliation: Razorpay 'pending' → stays initiated; idempotent across runs", async () => {
  const { db, razorpay, cancel, deps } = setup();
  await cancel();
  await reconcilePendingRefunds(deps);
  await reconcilePendingRefunds(deps);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
  assert.equal(db.orders.get(ORDER_ID).payment_status, "paid");
  assert.equal(razorpay.counts.refund, 1);
  assert.equal(razorpay.counts.refundFetch, 2, "status checked each run, nothing created");
});

test("reconciliation: Razorpay 'failed' → failed (recoverable), no new refund", async () => {
  const { db, razorpay, cancel, deps } = setup();
  await cancel();
  razorpay.ledger[0].status = "failed";
  await reconcilePendingRefunds(deps);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "failed");
  assert.equal(db.orders.get(ORDER_ID).payment_status, "paid");
  assert.equal(razorpay.counts.refund, 1);
});

test("reconciliation never creates a refund: approved / failed / fresh processing are left alone; a stale claim only adopts an existing refund", async () => {
  for (const refund_status of ["approved", "failed"]) {
    const { db, razorpay, deps } = setup({ order: { order_status: "cancelled", refund_status, refund_amount: 500 } });
    const result = await reconcileOrderRefund(ORDER_ID, deps);
    assert.equal(result.body.reconciled, false, refund_status);
    assert.equal(razorpay.counts.refund, 0, refund_status);
    assert.equal(db.orders.get(ORDER_ID).refund_status, refund_status);
  }

  const stale = new Date(Date.now() - 10 * 60 * 1000);
  const none = setup({ order: { order_status: "cancelled", refund_status: "processing", refund_amount: 500, updated_at: stale } });
  await reconcileOrderRefund(ORDER_ID, none.deps);
  assert.equal(none.razorpay.counts.refund, 0);
  assert.equal(none.db.orders.get(ORDER_ID).refund_status, "processing", "no refund at Razorpay → left for an admin retry");

  const adopt = setup({
    order: { order_status: "cancelled", refund_status: "processing", refund_amount: 500, updated_at: stale },
    rzp: { existingRefunds: [{ id: "rfnd_ours", amount: 50000, status: "processed", notes: { order_id: ORDER_ID } }] },
  });
  await reconcileOrderRefund(ORDER_ID, adopt.deps);
  assert.equal(adopt.razorpay.counts.refund, 0);
  assert.equal(adopt.db.orders.get(ORDER_ID).refund_status, "initiated", "adopted; completion needs a verified status check");
  assert.equal(adopt.db.orders.get(ORDER_ID).refund_reference, "rfnd_ours");
  await reconcileOrderRefund(ORDER_ID, adopt.deps);
  assert.equal(adopt.db.orders.get(ORDER_ID).refund_status, "completed");
});

test("reconciliation: a Razorpay error keeps the existing state", async () => {
  const { db, cancel, deps } = setup();
  await cancel();
  const brokenDeps = {
    ...deps,
    getRazorpayFn: () => ({
      refunds: { fetch: async () => { throw new Error("Razorpay 503"); } },
      payments: { refund: async () => assert.fail("never create") },
    }),
  };
  const result = await reconcileOrderRefund(ORDER_ID, brokenDeps);
  assert.equal(result.statusCode, 502);
  assert.equal(db.orders.get(ORDER_ID).refund_status, "initiated");
});
