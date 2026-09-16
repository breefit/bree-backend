import test from "node:test";
import assert from "node:assert/strict";
import { completeRefund, rejectRefund } from "../src/controllers/admin/returnController.js";

/**
 * ISSUE-011 — Refund completion TOCTOU (possible double-refund), and
 * ISSUE-010 — rejectRefund can contradict an already-initiated Razorpay
 * refund.
 *
 * completeRefund's row lock is deliberately released before it calls
 * Razorpay (never hold a lock across a third-party HTTP call) — that used
 * to leave a real window where two concurrent requests could both read
 * refund_status='approved' and both call razorpay.payments.refund() for
 * the same payment: a genuine double-refund, direct money loss. The fix
 * atomically claims an intermediate refund_status='processing' inside the
 * still-locked transaction before releasing it, so a second request sees
 * 'processing' — not 'approved' — and is refused outright.
 *
 * This drives the REAL completeRefund/rejectRefund functions (not a
 * regex over the source) against a fake DB that models real MySQL
 * `SELECT ... FOR UPDATE` row-locking with a genuine per-row async mutex —
 * an unlocked fake could not prove anything about a concurrency fix — and
 * a fake Razorpay client that counts calls and can simulate latency to
 * create a real race window. No production database, no real Razorpay
 * call, anywhere in this file.
 */

// ── A per-row mutex, exactly modeling what a real `SELECT ... FOR UPDATE`
// + COMMIT/ROLLBACK does: the second concurrent transaction blocks until
// the first releases the row. ──────────────────────────────────────────
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

/**
 * In-memory `orders` table + real row-lock semantics, driven through the
 * exact SQL statement shapes completeRefund/rejectRefund issue.
 */
const createFakeReturnDb = (initialOrder) => {
  const orders = new Map([[initialOrder.id, { ...initialOrder }]]);
  const rowLocks = new Map();
  const getLock = (id) => {
    if (!rowLocks.has(id)) rowLocks.set(id, createMutex());
    return rowLocks.get(id);
  };

  const makeClient = () => {
    let heldOrderId = null;
    return {
      query: async (sql, params = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();

        if (normalized === "BEGIN") return { rows: [], rowCount: 0 };

        if (normalized === "COMMIT" || normalized === "ROLLBACK") {
          if (heldOrderId) {
            getLock(heldOrderId).release();
            heldOrderId = null;
          }
          return { rows: [], rowCount: 0 };
        }

        if (normalized.includes("FOR UPDATE")) {
          const [id] = params;
          await getLock(id).acquire();
          heldOrderId = id;
          const row = orders.get(id);
          return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (
          normalized ===
          "UPDATE orders SET refund_status = 'processing', updated_at = NOW() WHERE id = ?"
        ) {
          const [id] = params;
          const row = orders.get(id);
          if (row) {
            row.refund_status = "processing";
            row.updated_at = new Date();
          }
          return { rows: [], rowCount: row ? 1 : 0 };
        }

        if (
          normalized ===
          "UPDATE orders SET refund_status = 'approved', updated_at = NOW() WHERE id = ? AND refund_status = 'processing'"
        ) {
          const [id] = params;
          const row = orders.get(id);
          if (row && row.refund_status === "processing") {
            row.refund_status = "approved";
            row.updated_at = new Date();
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }

        if (normalized.startsWith("UPDATE orders SET refund_status = ?, refund_reference = ?")) {
          const [nextStatus, refundReference, id] = params;
          const row = orders.get(id);
          if (row) {
            row.refund_status = nextStatus;
            row.refund_reference = refundReference;
            if (nextStatus === "completed") {
              row.refund_completed_at = new Date();
              // FIX (Medium #21): mirrors the real UPDATE's
              // `payment_status = ${isProcessed ? "'refunded'" : ...}`
              // static SQL fragment (not a bound param, so it can't be
              // read out of `params` — inferred here the same way the real
              // query conditions it, off nextStatus === "completed").
              row.payment_status = "refunded";
            }
            row.updated_at = new Date();
          }
          return { rows: [], rowCount: row ? 1 : 0 };
        }

        if (normalized === "UPDATE orders SET refund_status = 'rejected', updated_at = NOW() WHERE id = ?") {
          const [id] = params;
          const row = orders.get(id);
          if (row) {
            row.refund_status = "rejected";
            row.updated_at = new Date();
          }
          return { rows: [], rowCount: row ? 1 : 0 };
        }

        if (normalized === "SELECT * FROM orders WHERE id = ? LIMIT 1") {
          const [id] = params;
          const row = orders.get(id);
          return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        throw new Error(`Unhandled fake SQL in refundConcurrency test: ${normalized}`);
      },
      release: () => {
        if (heldOrderId) {
          getLock(heldOrderId).release();
          heldOrderId = null;
        }
      },
    };
  };

  return {
    getClientFn: async () => makeClient(),
    // The Phase-2-failure revert uses the plain (non-transactional) query
    // helper — a single WHERE-guarded UPDATE is atomic on its own, so a
    // throwaway client is a faithful stand-in.
    queryFn: async (sql, params) => makeClient().query(sql, params),
    orders,
  };
};

const createFakeRazorpay = ({
  refundResult = { id: "rfnd_test1", status: "processed" },
  refundError = null,
  refundDelayMs = 15,
  fetchResult = null,
} = {}) => {
  let refundCalls = 0;
  let fetchCalls = 0;
  const fn = () => ({
    payments: {
      refund: async () => {
        refundCalls += 1;
        await sleep(refundDelayMs);
        if (refundError) throw refundError;
        return refundResult;
      },
    },
    refunds: {
      fetch: async (refundId) => {
        fetchCalls += 1;
        return fetchResult || { id: refundId, status: "processed" };
      },
    },
  });
  return {
    getRazorpayFn: fn,
    getRefundCalls: () => refundCalls,
    getFetchCalls: () => fetchCalls,
  };
};

const baseOrder = (overrides = {}) => ({
  id: "order-refund-1",
  order_number: "BRE-5001",
  return_status: "returned",
  inspection_status: "approved",
  refund_status: "approved",
  refund_amount: 500,
  refund_reference: null,
  refund_completed_at: null,
  total: 500,
  amount: 500,
  payment_status: "paid",
  razorpay_payment_id: "pay_test1",
  updated_at: new Date(),
  // Deliberately no contact_email/contact_phone — notifyReturnEvent then
  // no-ops instead of attempting a real notification send.
  ...overrides,
});

const makeReqRes = (orderId) => {
  const req = { params: { orderId }, app: {} };
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
  return { req, res };
};

test("ISSUE-011: two concurrent completeRefund calls on the same order result in exactly ONE Razorpay refund call and one consistent final DB state", async () => {
  const db = createFakeReturnDb(baseOrder());
  const rzp = createFakeRazorpay({ refundDelayMs: 20 });

  const { req: reqA, res: resA } = makeReqRes("order-refund-1");
  const { req: reqB, res: resB } = makeReqRes("order-refund-1");

  await Promise.all([
    completeRefund(reqA, resA, { ...db, ...rzp }),
    completeRefund(reqB, resB, { ...db, ...rzp }),
  ]);

  assert.equal(rzp.getRefundCalls(), 1, "razorpay.payments.refund() must be called exactly once");
  assert.equal(rzp.getFetchCalls(), 0);

  const finalOrder = db.orders.get("order-refund-1");
  assert.equal(finalOrder.refund_status, "completed");
  assert.equal(finalOrder.refund_reference, "rfnd_test1");

  const responses = [resA, resB];
  const successes = responses.filter((r) => r.body?.success === true);
  const blocked = responses.filter((r) => r.statusCode === 409);
  assert.equal(successes.length, 1, "exactly one request completes the refund");
  assert.equal(blocked.length, 1, "the other request is refused with 409, not allowed to also call Razorpay");
  assert.match(blocked[0].body.message, /already being processed/i);
});

test("ISSUE-011: a third request arriving while a refund is still processing is also refused, not just the second", async () => {
  const db = createFakeReturnDb(baseOrder());
  const rzp = createFakeRazorpay({ refundDelayMs: 30 });

  const requests = [
    makeReqRes("order-refund-1"),
    makeReqRes("order-refund-1"),
    makeReqRes("order-refund-1"),
  ];

  await Promise.all(
    requests.map(({ req, res }) => completeRefund(req, res, { ...db, ...rzp })),
  );

  assert.equal(rzp.getRefundCalls(), 1);
  const successes = requests.filter((r) => r.res.body?.success === true);
  const blocked = requests.filter((r) => r.res.statusCode === 409);
  assert.equal(successes.length, 1);
  assert.equal(blocked.length, 2);
});

test("ISSUE-011: when Razorpay itself fails, the 'processing' claim is reverted back to 'approved' so the refund is immediately retryable", async () => {
  const db = createFakeReturnDb(baseOrder());
  const rzp = createFakeRazorpay({ refundError: new Error("razorpay outage"), refundDelayMs: 5 });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(res.statusCode, 502);
  const afterFailure = db.orders.get("order-refund-1");
  assert.equal(
    afterFailure.refund_status,
    "approved",
    "a Razorpay failure must not leave the order stuck in 'processing'",
  );

  // Retry now succeeds normally.
  const rzpRetry = createFakeRazorpay({ refundDelayMs: 5 });
  const { req: req2, res: res2 } = makeReqRes("order-refund-1");
  await completeRefund(req2, res2, { ...db, ...rzpRetry });
  assert.equal(res2.body.success, true);
  assert.equal(db.orders.get("order-refund-1").refund_status, "completed");
});

test("ISSUE-011: a 'processing' claim stuck from a crashed prior attempt (stale updated_at) is reclaimed and retried, not permanently stuck", async () => {
  const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
  const db = createFakeReturnDb(
    baseOrder({ refund_status: "processing", updated_at: staleTimestamp }),
  );
  const rzp = createFakeRazorpay({ refundDelayMs: 5 });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(res.body.success, true);
  assert.equal(rzp.getRefundCalls(), 1);
  assert.equal(db.orders.get("order-refund-1").refund_status, "completed");
});

test("ISSUE-011: a 'processing' claim that is still fresh (well within the staleness window) is NOT reclaimed — refused instead", async () => {
  const db = createFakeReturnDb(
    baseOrder({ refund_status: "processing", updated_at: new Date() }),
  );
  const rzp = createFakeRazorpay();

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(res.statusCode, 409);
  assert.equal(rzp.getRefundCalls(), 0);
});

test("ISSUE-011 regression: completeRefund on an 'initiated' refund still only rechecks status (mode: recheck) and never calls payments.refund() again", async () => {
  const db = createFakeReturnDb(
    baseOrder({ refund_status: "initiated", refund_reference: "rfnd_existing" }),
  );
  const rzp = createFakeRazorpay({ fetchResult: { id: "rfnd_existing", status: "processed" } });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(rzp.getRefundCalls(), 0, "recheck must never create a second refund");
  assert.equal(rzp.getFetchCalls(), 1);
  assert.equal(db.orders.get("order-refund-1").refund_status, "completed");
});

// ── ISSUE-010 — rejectRefund must never contradict a refund Razorpay has
// already been asked to process. ──────────────────────────────────────────

for (const blockedStatus of ["initiated", "processing", "completed"]) {
  test(`ISSUE-010: rejectRefund is blocked once refund_status is '${blockedStatus}' — a refund already touching Razorpay can never be contradicted`, async () => {
    const db = createFakeReturnDb(baseOrder({ refund_status: blockedStatus }));
    const { req, res } = makeReqRes("order-refund-1");

    await rejectRefund(req, res, { getClientFn: db.getClientFn });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(
      db.orders.get("order-refund-1").refund_status,
      blockedStatus,
      "rejectRefund must not change the status once it is unrejectable",
    );
  });
}

test("ISSUE-010 regression: rejectRefund still succeeds for a refund that was approved but never sent to Razorpay", async () => {
  const db = createFakeReturnDb(baseOrder({ refund_status: "approved" }));
  const { req, res } = makeReqRes("order-refund-1");

  await rejectRefund(req, res, { getClientFn: db.getClientFn });

  assert.equal(res.body.success, true);
  assert.equal(db.orders.get("order-refund-1").refund_status, "rejected");
});

// ── Medium #21 (Phase 3) — payment_status='refunded' was a documented
// enum value never actually written anywhere; a fully refunded order's
// payment_status stayed 'paid' forever, with only refund_status reflecting
// the refund. ─────────────────────────────────────────────────────────────

test("ISSUE-021: a completed refund also sets payment_status to 'refunded', not just refund_status", async () => {
  const db = createFakeReturnDb(baseOrder({ payment_status: "paid" }));
  const rzp = createFakeRazorpay();

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(res.body.success, true);
  const finalOrder = db.orders.get("order-refund-1");
  assert.equal(finalOrder.refund_status, "completed");
  assert.equal(
    finalOrder.payment_status,
    "refunded",
    "payment_status must reflect a fully completed refund, not stay 'paid' forever",
  );
});

test("ISSUE-021 regression: an 'initiated' (not yet processed) refund does NOT set payment_status to 'refunded' prematurely", async () => {
  const db = createFakeReturnDb(baseOrder({ payment_status: "paid" }));
  // A refund result that is NOT "processed" yet keeps refund_status at
  // 'initiated' (see completeRefund's isProcessed check) — payment_status
  // must stay 'paid' until the refund is actually confirmed complete.
  const rzp = createFakeRazorpay({
    refundResult: { id: "rfnd_test1", status: "processing" },
  });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  const finalOrder = db.orders.get("order-refund-1");
  assert.equal(finalOrder.refund_status, "initiated");
  assert.equal(finalOrder.payment_status, "paid");
});
