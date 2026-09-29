import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { handleWebhook } from "../src/controllers/paymentController.js";

/**
 * PHASE 3 — Medium Issue #11: no automated path ever transitioned a refund
 * from 'initiated' to 'completed' — only a manual admin recheck
 * (admin/returnController.js's completeRefund "recheck" mode) did, so a
 * refund could stay 'initiated' in the DB forever even after Razorpay
 * actually completed it externally. Added refund.processed/refund.failed
 * webhook handling, looked up by orders.refund_reference (the Razorpay
 * refund id completeRefund already stores there), guarded so it can only
 * move a refund FORWARD (initiated -> completed) and never touches an
 * order whose refund wasn't already tracked through this app.
 *
 * Drives the REAL handleWebhook function directly (not via HTTP — a real
 * HMAC signature is computed the same way utils/razorpay.js's
 * verifyWebhookSignature does, using the real RAZORPAY_WEBHOOK_SECRET
 * already loaded from .env in this test environment) with a fake queryFn.
 * No production database, no real Razorpay call.
 */

const buildSignedRequest = (payload) => {
  const rawBody = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  return {
    headers: { "x-razorpay-signature": signature },
    rawBody,
    body: payload,
    app: {},
  };
};

const makeRes = () => {
  const res = {
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
  };
  return res;
};

const refundProcessedPayload = (refundId, paymentId = "pay_abc123") => ({
  event: "refund.processed",
  payload: { refund: { entity: { id: refundId, payment_id: paymentId, status: "processed" } } },
});

const refundFailedPayload = (refundId, paymentId = "pay_abc123") => ({
  event: "refund.failed",
  payload: { refund: { entity: { id: refundId, payment_id: paymentId, status: "failed" } } },
});

const makeFakeOrdersDb = (initialOrder) => {
  const orders = new Map([[initialOrder.id, { ...initialOrder }]]);
  const historyInserts = [];
  const paymentUpdates = [];
  // Phase 3B — every handleWebhook call now claims an event id first (see
  // webhookIdempotencyService.js); model that same ledger table here so
  // these pre-existing ISSUE-011 tests keep exercising the real function
  // end-to-end instead of stubbing the claim step away.
  const webhookEvents = new Map();

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT INTO webhook_events")) {
      const [id, provider, eventId, eventType] = params;
      const key = `${provider}:${eventId}`;
      if (webhookEvents.has(key)) {
        const dupError = new Error(`Duplicate entry '${eventId}' for key 'uq_webhook_events_provider_event_id'`);
        dupError.code = "ER_DUP_ENTRY";
        throw dupError;
      }
      webhookEvents.set(key, { id, provider, eventId, eventType, status: "processing" });
      return { rows: [], rowCount: 1 };
    }

    if (normalized === "SELECT status FROM webhook_events WHERE provider = ? AND event_id = ? LIMIT 1") {
      const [provider, eventId] = params;
      const row = webhookEvents.get(`${provider}:${eventId}`);
      return { rows: row ? [{ status: row.status }] : [] };
    }

    if (normalized.startsWith("UPDATE webhook_events SET status = 'processing'")) {
      const [provider, eventId] = params;
      const row = webhookEvents.get(`${provider}:${eventId}`);
      if (row && row.status === "failed") {
        row.status = "processing";
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("UPDATE webhook_events SET status = 'completed'")) {
      const [provider, eventId] = params;
      const row = webhookEvents.get(`${provider}:${eventId}`);
      if (row) row.status = "completed";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith("UPDATE webhook_events SET status = 'failed'")) {
      const [, provider, eventId] = params;
      const row = webhookEvents.get(`${provider}:${eventId}`);
      if (row) row.status = "failed";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith("SELECT * FROM orders WHERE refund_reference = ? OR (refund_reference IS NULL")) {
      const [refundReference, paymentId] = params;
      const matches = [...orders.values()].filter(
        (r) =>
          r.refund_reference === refundReference ||
          (r.refund_reference == null && r.refund_status === "processing" && r.razorpay_payment_id === paymentId),
      );
      return { rows: matches.map((r) => ({ ...r })) };
    }

    if (normalized.startsWith("UPDATE orders SET refund_status = 'completed'")) {
      const [refundReference, id, guardReference] = params;
      const row = orders.get(id);
      if (
        row &&
        ["initiated", "processing"].includes(row.refund_status) &&
        (row.refund_reference === guardReference || row.refund_reference == null)
      ) {
        row.refund_status = "completed";
        row.payment_status = "refunded";
        row.refund_reference = row.refund_reference ?? refundReference;
        row.refund_completed_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("UPDATE payments SET refund_id = ?")) {
      paymentUpdates.push(params);
      return { rows: [], rowCount: 1 };
    }

    if (normalized === "SELECT * FROM orders WHERE id = ? LIMIT 1") {
      const row = orders.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (normalized === "SELECT id, order_status FROM orders WHERE refund_reference = ? LIMIT 1") {
      const [refundReference] = params;
      const match = [...orders.values()].find((r) => r.refund_reference === refundReference);
      return { rows: match ? [{ id: match.id, order_status: match.order_status }] : [] };
    }

    if (normalized.startsWith("INSERT INTO order_status_history")) {
      historyInserts.push(params);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake SQL in refundWebhookReconciliation test: ${normalized}`);
  };

  return { queryFn, orders, historyInserts, paymentUpdates };
};

test("ISSUE-011 (Medium): refund.processed webhook reconciles an 'initiated' refund to 'completed', and sets payment_status='refunded'", async () => {
  const db = makeFakeOrdersDb({
    id: "order-1",
    order_status: "delivered",
    refund_status: "initiated",
    refund_reference: "rfnd_test1",
    payment_status: "paid",
  });

  const req = buildSignedRequest(refundProcessedPayload("rfnd_test1"));
  const res = makeRes();

  await handleWebhook(req, res, { queryFn: db.queryFn });

  assert.equal(res.statusCode, 200);
  const order = db.orders.get("order-1");
  assert.equal(order.refund_status, "completed");
  assert.equal(order.payment_status, "refunded");
  assert.equal(db.historyInserts.length, 1);
});

test("ISSUE-011 (Medium) regression: refund.processed for an order NOT in 'initiated' state is a no-op — never moves a refund backward or double-processes", async () => {
  const db = makeFakeOrdersDb({
    id: "order-1",
    order_status: "delivered",
    refund_status: "completed", // already completed by some other path
    refund_reference: "rfnd_test1",
    payment_status: "refunded",
  });

  const req = buildSignedRequest(refundProcessedPayload("rfnd_test1"));
  const res = makeRes();

  await handleWebhook(req, res, { queryFn: db.queryFn });

  assert.equal(db.orders.get("order-1").refund_status, "completed");
  assert.equal(db.historyInserts.length, 0, "an already-completed refund must not get a duplicate history entry");
});

test("ISSUE-011 (Medium) regression: refund.processed for an unknown refund id (never tracked through this app) touches nothing", async () => {
  const db = makeFakeOrdersDb({
    id: "order-1",
    order_status: "delivered",
    refund_status: "initiated",
    refund_reference: "rfnd_different",
    payment_status: "paid",
  });

  const req = buildSignedRequest(refundProcessedPayload("rfnd_unknown_id"));
  const res = makeRes();

  await handleWebhook(req, res, { queryFn: db.queryFn });

  assert.equal(db.orders.get("order-1").refund_status, "initiated", "an unrelated order must be untouched");
});

test("ISSUE-011 (Medium): refund.failed does NOT change any order state (surfaced for manual review only)", async () => {
  const db = makeFakeOrdersDb({
    id: "order-1",
    order_status: "delivered",
    refund_status: "initiated",
    refund_reference: "rfnd_test1",
    payment_status: "paid",
  });

  const req = buildSignedRequest(refundFailedPayload("rfnd_test1"));
  const res = makeRes();

  await handleWebhook(req, res, { queryFn: db.queryFn });

  const order = db.orders.get("order-1");
  assert.equal(order.refund_status, "initiated", "refund_status must not be silently changed on a failure event");
  assert.equal(order.payment_status, "paid");
});

test("ISSUE-011 (Medium) regression: an invalid webhook signature is still rejected before any refund reconciliation logic runs", async () => {
  const payload = refundProcessedPayload("rfnd_test1");
  const req = {
    headers: { "x-razorpay-signature": "not-a-real-signature" },
    rawBody: JSON.stringify(payload),
    body: payload,
    app: {},
  };
  const res = makeRes();

  await handleWebhook(req, res, {
    queryFn: async () => {
      throw new Error("queryFn must never be called for an invalid signature");
    },
  });

  assert.equal(res.statusCode, 400);
});

// ── Return/refund E2E audit regressions ─────────────────────────────────────
const refundPayloadWithNotes = (event, refundId, paymentId, orderId) => ({
  event,
  payload: {
    refund: {
      entity: {
        id: refundId,
        payment_id: paymentId,
        status: event === "refund.failed" ? "failed" : "processed",
        notes: { order_id: orderId, order_number: "BREE-100900" },
      },
    },
  },
});

test("audit: refund.processed completing an 'initiated' refund sends 'Refund Completed' exactly once, even when the webhook is delivered twice", async () => {
  const db = makeFakeOrdersDb({
    id: "order-1",
    order_status: "delivered",
    refund_status: "initiated",
    refund_reference: "rfnd_test1",
    payment_status: "paid",
    razorpay_payment_id: "pay_abc123",
  });
  const notified = [];
  const notifyRefundEvent = (order, label) => notified.push([order.id, label, order.refund_status]);

  const payload = refundProcessedPayload("rfnd_test1");
  await handleWebhook(buildSignedRequest(payload), makeRes(), { queryFn: db.queryFn, notifyRefundEvent });
  const dup = makeRes();
  await handleWebhook(buildSignedRequest(payload), dup, { queryFn: db.queryFn, notifyRefundEvent });

  assert.deepEqual(notified, [["order-1", "Refund Completed", "completed"]]);
  assert.equal(dup.body.duplicate, true);
  assert.equal(db.historyInserts.length, 1);
});

test("audit: a refund.processed that arrives while completeRefund is still 'processing' (no refund_reference saved yet) completes the refund and records the refund id instead of being dropped", async () => {
  const db = makeFakeOrdersDb({
    id: "order-1",
    order_status: "delivered",
    refund_status: "processing",
    refund_reference: null,
    payment_status: "paid",
    razorpay_payment_id: "pay_abc123",
  });
  const notified = [];

  await handleWebhook(
    buildSignedRequest(refundPayloadWithNotes("refund.processed", "rfnd_race1", "pay_abc123", "order-1")),
    makeRes(),
    { queryFn: db.queryFn, notifyRefundEvent: (o, label) => notified.push(label) },
  );

  const order = db.orders.get("order-1");
  assert.equal(order.refund_status, "completed");
  assert.equal(order.refund_reference, "rfnd_race1");
  assert.equal(order.payment_status, "refunded");
  assert.deepEqual(notified, ["Refund Completed"]);
});

test("audit: a 'processing' order on the same payment is NOT completed by a refund whose notes name a different order (or no order)", async () => {
  for (const notedOrder of ["order-OTHER", undefined]) {
    const db = makeFakeOrdersDb({
      id: "order-1",
      order_status: "delivered",
      refund_status: "processing",
      refund_reference: null,
      payment_status: "paid",
      razorpay_payment_id: "pay_abc123",
    });
    const payload = refundPayloadWithNotes("refund.processed", "rfnd_dash", "pay_abc123", notedOrder);
    if (!notedOrder) delete payload.payload.refund.entity.notes;
    await handleWebhook(buildSignedRequest(payload), makeRes(), {
      queryFn: db.queryFn,
      notifyRefundEvent: () => assert.fail("must not notify"),
    });
    assert.equal(db.orders.get("order-1").refund_status, "processing");
    assert.equal(db.orders.get("order-1").refund_reference, null);
  }
});

test("audit: refund.failed leaves refund state unchanged but records an admin history row", async () => {
  const db = makeFakeOrdersDb({
    id: "order-1",
    order_status: "delivered",
    refund_status: "initiated",
    refund_reference: "rfnd_test1",
    payment_status: "paid",
  });
  await handleWebhook(buildSignedRequest(refundFailedPayload("rfnd_test1")), makeRes(), { queryFn: db.queryFn });
  assert.equal(db.orders.get("order-1").refund_status, "initiated");
  assert.equal(db.historyInserts.length, 1);
  assert.match(db.historyInserts[0][3], /FAILED — needs manual review/);
});
