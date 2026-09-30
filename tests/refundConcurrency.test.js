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
  const paymentUpdates = [];
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

        if (normalized.startsWith("UPDATE payments SET refund_id = ?")) {
          const [refundId, refundAmount, , , id] = params;
          paymentUpdates.push({ orderId: id, refundId, refundAmount, processed: params[2] === 1 });
          return { rows: [], rowCount: 1 };
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

        if (
          normalized ===
          "UPDATE orders SET refund_status = 'failed', updated_at = NOW() WHERE id = ? AND refund_status = 'initiated' AND refund_reference = ?"
        ) {
          const [id, reference] = params;
          const row = orders.get(id);
          if (row?.refund_status !== "initiated" || row.refund_reference !== reference) {
            return { rows: [], rowCount: 0 };
          }
          row.refund_status = "failed";
          return { rows: [], rowCount: 1 };
        }

        if (normalized.startsWith("UPDATE orders SET refund_gateway_status = COALESCE(?, refund_gateway_status)")) {
          const [gatewayStatus, rrn, id] = params;
          const row = orders.get(id);
          if (row) {
            if (gatewayStatus != null) row.refund_gateway_status = gatewayStatus;
            if (rrn != null) row.refund_rrn = rrn;
          }
          return { rows: [], rowCount: row ? 1 : 0 };
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
    paymentUpdates,
  };
};

// Models Razorpay's per-payment refund ledger too: every refund() that
// Razorpay accepted (including one whose response was then lost —
// `acceptThenError`) shows up in payments.fetchMultipleRefund(), which is
// what completeRefund now consults before ever creating a refund.
const createFakeRazorpay = ({
  refundResult = { id: "rfnd_test1", status: "processed" },
  refundError = null,
  acceptThenError = null,
  refundDelayMs = 15,
  fetchResult = null,
  existingRefunds = [],
  listError = null,
} = {}) => {
  let refundCalls = 0;
  let fetchCalls = 0;
  let listCalls = 0;
  const ledger = [...existingRefunds];
  const fn = () => ({
    payments: {
      refund: async (paymentId, params) => {
        refundCalls += 1;
        await sleep(refundDelayMs);
        if (refundError) throw refundError;
        const created = { ...refundResult, payment_id: paymentId, notes: params?.notes };
        ledger.push(created);
        if (acceptThenError) throw acceptThenError;
        return created;
      },
      fetchMultipleRefund: async () => {
        listCalls += 1;
        if (listError) throw listError;
        return { entity: "collection", count: ledger.length, items: ledger.map((r) => ({ ...r })) };
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
    getListCalls: () => listCalls,
    ledger,
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

  // Refund lifecycle fix (BREE-100020): creating a refund records
  // 'initiated' even when Razorpay's create response already says
  // "processed" — completed only via refund.processed / a status recheck.
  const finalOrder = db.orders.get("order-refund-1");
  assert.equal(finalOrder.refund_status, "initiated");
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
  assert.equal(db.orders.get("order-refund-1").refund_status, "initiated");
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
  assert.equal(db.orders.get("order-refund-1").refund_status, "initiated");
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
  // Razorpay's create response already says "processed" — still only
  // 'initiated' (and payment 'paid') until a verified status check.
  const rzp = createFakeRazorpay({ fetchResult: { id: "rfnd_test1", status: "processed" } });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });
  assert.equal(res.body.success, true);
  assert.equal(db.orders.get("order-refund-1").refund_status, "initiated");
  assert.equal(db.orders.get("order-refund-1").payment_status, "paid");

  const { req: req2, res: res2 } = makeReqRes("order-refund-1");
  await completeRefund(req2, res2, { ...db, ...rzp });
  assert.equal(res2.body.success, true);
  assert.equal(rzp.getRefundCalls(), 1);
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

// ── Return/refund E2E audit: never a second Razorpay refund on retry ────────
const ourRefund = (overrides = {}) => ({
  id: "rfnd_already",
  status: "processed",
  payment_id: "pay_test1",
  notes: { order_id: "order-refund-1", order_number: "BRE-5001" },
  ...overrides,
});

test("audit: a stale 'processing' claim whose refund Razorpay DID create (DB write lost) is reconciled — payments.refund() is NOT called again", async () => {
  const db = createFakeReturnDb(
    baseOrder({ refund_status: "processing", updated_at: new Date(Date.now() - 10 * 60 * 1000) }),
  );
  const rzp = createFakeRazorpay({ existingRefunds: [ourRefund()] });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(res.body.success, true);
  assert.equal(rzp.getRefundCalls(), 0, "no second refund");
  const row = db.orders.get("order-refund-1");
  assert.equal(row.refund_status, "initiated", "adopted refund waits for a verified final state");
  assert.equal(row.refund_reference, "rfnd_already");
  assert.equal(row.payment_status, "paid");
});

test("audit: Razorpay accepts the refund but the response is lost (timeout) → the refund is adopted, not reverted to 'approved' — a retry can never create a second one", async () => {
  const db = createFakeReturnDb(baseOrder());
  const rzp = createFakeRazorpay({
    refundResult: { id: "rfnd_lost_response", status: "pending" },
    acceptThenError: Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" }),
  });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });
  assert.equal(res.body.success, true);
  assert.equal(db.orders.get("order-refund-1").refund_status, "initiated");
  assert.equal(db.orders.get("order-refund-1").refund_reference, "rfnd_lost_response");

  // Admin clicks again: recheck mode, never another create.
  const { req: req2, res: res2 } = makeReqRes("order-refund-1");
  await completeRefund(req2, res2, { ...db, ...rzp });
  assert.equal(rzp.getRefundCalls(), 1, "exactly one Razorpay refund across both clicks");
  assert.equal(rzp.ledger.length, 1);
});

test("audit: if Razorpay cannot even be asked whether a refund exists, NO refund is created and the claim is left for the stale-claim recheck", async () => {
  const db = createFakeReturnDb(baseOrder());
  const rzp = createFakeRazorpay({ listError: new Error("Razorpay 500") });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(res.statusCode, 502);
  assert.equal(rzp.getRefundCalls(), 0);
  assert.equal(db.orders.get("order-refund-1").refund_status, "processing");
});

test("audit: a genuine Razorpay rejection (nothing created) still reverts to 'approved' for an immediate retry", async () => {
  const db = createFakeReturnDb(baseOrder());
  const rzp = createFakeRazorpay({ refundError: Object.assign(new Error("BAD_REQUEST_ERROR"), { statusCode: 400 }) });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(res.statusCode, 502);
  assert.equal(db.orders.get("order-refund-1").refund_status, "approved");
});

test("audit: a refund belonging to a different order on the same payment (or one that failed) is never adopted", async () => {
  const db = createFakeReturnDb(baseOrder());
  const rzp = createFakeRazorpay({
    existingRefunds: [
      ourRefund({ id: "rfnd_other", notes: { order_id: "some-other-order" } }),
      ourRefund({ id: "rfnd_failed", status: "failed" }),
    ],
    refundResult: { id: "rfnd_new", status: "processed" },
  });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(rzp.getRefundCalls(), 1);
  assert.equal(db.orders.get("order-refund-1").refund_reference, "rfnd_new");
});

test("audit: recheck of a refund Razorpay reports FAILED tells the admin (409) and records the recoverable 'failed' state — no new refund", async () => {
  const db = createFakeReturnDb(baseOrder({ refund_status: "initiated", refund_reference: "rfnd_x" }));
  const rzp = createFakeRazorpay({ fetchResult: { id: "rfnd_x", status: "failed" } });

  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "RAZORPAY_REFUND_FAILED");
  assert.equal(rzp.getRefundCalls(), 0);
  assert.equal(db.orders.get("order-refund-1").refund_status, "failed");
});

test("audit: rejectRefund is refused on an order with no received return or before QC passed, and is idempotent once rejected", async () => {
  for (const overrides of [
    { return_status: null, inspection_status: null, refund_status: null },
    { return_status: "returned", inspection_status: "pending", refund_status: null },
  ]) {
    const db = createFakeReturnDb(baseOrder(overrides));
    const { req, res } = makeReqRes("order-refund-1");
    req.body = { reason: "Damaged", notes: "n" };
    await rejectRefund(req, res, db);
    assert.equal(res.statusCode, 400);
    assert.equal(db.orders.get("order-refund-1").refund_status, overrides.refund_status);
  }

  const db = createFakeReturnDb(baseOrder({ refund_status: "rejected" }));
  const before = db.orders.get("order-refund-1").updated_at;
  const { req, res } = makeReqRes("order-refund-1");
  req.body = {};
  await rejectRefund(req, res, db);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /already been rejected/);
  assert.equal(db.orders.get("order-refund-1").updated_at, before, "no second write");
});

test("audit: a completed refund also records refund_id/refund_amount on the payments row (and flags it refunded) in the same transaction", async () => {
  const db = createFakeReturnDb(baseOrder());
  const rzp = createFakeRazorpay({
    refundResult: { id: "rfnd_pay", status: "processed" },
    fetchResult: { id: "rfnd_pay", status: "processed" },
  });
  const { req, res } = makeReqRes("order-refund-1");
  await completeRefund(req, res, { ...db, ...rzp });
  // Creation: refund id/amount recorded, payments row NOT flagged refunded.
  assert.deepEqual(db.paymentUpdates, [{ orderId: "order-refund-1", refundId: "rfnd_pay", refundAmount: 500, processed: false }]);
  // Verified completion (status recheck) flags it refunded.
  const { req: req2, res: res2 } = makeReqRes("order-refund-1");
  await completeRefund(req2, res2, { ...db, ...rzp });
  assert.deepEqual(db.paymentUpdates[1], { orderId: "order-refund-1", refundId: "rfnd_pay", refundAmount: 500, processed: true });
});
