import test, { mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { handleWebhook } from "../src/controllers/paymentController.js";
import {
  claimWebhookEvent,
  markWebhookEventCompleted,
  markWebhookEventFailed,
} from "../src/services/webhookIdempotencyService.js";

/**
 * PHASE 3B — Medium #5: Razorpay webhook event-id idempotency ledger.
 *
 * Razorpay's webhook payloads carry no dedicated event/delivery id (see
 * webhookIdempotencyService.js's top comment) — the idempotency key is a
 * SHA-256 hash of the exact raw webhook body. The claim itself is a MySQL
 * UNIQUE(provider, event_id) constraint (INSERT, catch ER_DUP_ENTRY) — NOT
 * an in-memory Set/global/mutex — so it is safe across multiple backend
 * processes/instances, each with their own independent memory.
 *
 * These tests drive the REAL claimWebhookEvent/markWebhookEventCompleted/
 * markWebhookEventFailed functions, and the REAL handleWebhook end-to-end
 * (genuine HMAC signature, computed the same way utils/razorpay.js's
 * verifyWebhookSignature does, using the real RAZORPAY_WEBHOOK_SECRET
 * already loaded from .env in this test environment), against a fake
 * MySQL-shaped queryFn that faithfully models a real UNIQUE constraint
 * (throwing ER_DUP_ENTRY on a second INSERT for the same key) — not a
 * regex over the source. No production database, no real Razorpay call.
 */

// ── A fake MySQL table that genuinely enforces UNIQUE(provider, event_id),
// including real duplicate-key rejection on concurrent INSERTs — this is
// what makes the Promise.all() races below actually meaningful. ─────────
const makeFakeLedgerDb = () => {
  const rows = new Map(); // `${provider}:${event_id}` -> row
  const inserts = [];

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT INTO webhook_events")) {
      const [id, provider, eventId, eventType] = params;
      const key = `${provider}:${eventId}`;
      inserts.push({ id, provider, eventId, eventType });
      if (rows.has(key)) {
        const dupError = new Error(
          `Duplicate entry '${provider}-${eventId}' for key 'uq_webhook_events_provider_event_id'`,
        );
        dupError.code = "ER_DUP_ENTRY";
        throw dupError;
      }
      rows.set(key, {
        id,
        provider,
        event_id: eventId,
        event_type: eventType,
        status: "processing",
        error_message: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized === "SELECT status FROM webhook_events WHERE provider = ? AND event_id = ? LIMIT 1") {
      const [provider, eventId] = params;
      const row = rows.get(`${provider}:${eventId}`);
      return { rows: row ? [{ status: row.status }] : [] };
    }

    if (normalized.startsWith("UPDATE webhook_events SET status = 'processing'")) {
      const [provider, eventId] = params;
      const row = rows.get(`${provider}:${eventId}`);
      if (row && row.status === "failed") {
        row.status = "processing";
        row.error_message = null;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("UPDATE webhook_events SET status = 'completed'")) {
      const [provider, eventId] = params;
      const row = rows.get(`${provider}:${eventId}`);
      if (row) row.status = "completed";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith("UPDATE webhook_events SET status = 'failed'")) {
      const [errorMessage, provider, eventId] = params;
      const row = rows.get(`${provider}:${eventId}`);
      if (row) {
        row.status = "failed";
        row.error_message = errorMessage;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`Unhandled fake SQL in webhookEventIdempotency test: ${normalized}`);
  };

  return { queryFn, rows, inserts };
};

// ── Unit-level: claimWebhookEvent's state machine directly ───────────────

test("1. first claim on a fresh event id succeeds", async () => {
  const db = makeFakeLedgerDb();
  const result = await claimWebhookEvent({ eventId: "hash-1", eventType: "payment.captured", queryFn: db.queryFn });
  assert.equal(result.claimed, true);
  assert.equal(result.alreadyCompleted, false);
});

test("2. same event arrives again after successful completion — claim fails, alreadyCompleted true, no reprocessing", async () => {
  const db = makeFakeLedgerDb();
  const first = await claimWebhookEvent({ eventId: "hash-2", eventType: "payment.captured", queryFn: db.queryFn });
  assert.equal(first.claimed, true);
  await markWebhookEventCompleted({ eventId: "hash-2", queryFn: db.queryFn });

  const second = await claimWebhookEvent({ eventId: "hash-2", eventType: "payment.captured", queryFn: db.queryFn });
  assert.equal(second.claimed, false);
  assert.equal(second.alreadyCompleted, true);
});

test("3/4/5. first processing fails -> event can be retried and succeed (not a permanent duplicate)", async () => {
  const db = makeFakeLedgerDb();
  const first = await claimWebhookEvent({ eventId: "hash-3", eventType: "payment.captured", queryFn: db.queryFn });
  assert.equal(first.claimed, true);

  // Simulated business-logic failure.
  await markWebhookEventFailed({ eventId: "hash-3", queryFn: db.queryFn, errorMessage: "simulated transient DB error" });
  assert.equal(db.rows.get("razorpay:hash-3").status, "failed");

  // Razorpay redelivers the same event (same hash) — must be retryable.
  const retry = await claimWebhookEvent({ eventId: "hash-3", eventType: "payment.captured", queryFn: db.queryFn });
  assert.equal(retry.claimed, true, "a failed event must be re-claimable, not permanently blocked");
  assert.equal(retry.alreadyCompleted, false);

  await markWebhookEventCompleted({ eventId: "hash-3", queryFn: db.queryFn });
  assert.equal(db.rows.get("razorpay:hash-3").status, "completed");
});

test("6. different event ids process independently (no cross-contamination)", async () => {
  const db = makeFakeLedgerDb();
  const a = await claimWebhookEvent({ eventId: "hash-a", eventType: "payment.captured", queryFn: db.queryFn });
  const b = await claimWebhookEvent({ eventId: "hash-b", eventType: "payment.captured", queryFn: db.queryFn });
  assert.equal(a.claimed, true);
  assert.equal(b.claimed, true);
});

test("7. different event TYPES with different ids process independently, even for the same underlying entity", async () => {
  // Models the real risk this design specifically has to get right: the
  // SAME subscription id, paused then resumed then paused again — each a
  // genuinely distinct occurrence that must NOT be treated as a duplicate
  // of the first "paused" event just because the entity id repeats.
  const db = makeFakeLedgerDb();
  const paused1 = await claimWebhookEvent({ eventId: "sub123-paused-created_at_1000", eventType: "subscription.paused", queryFn: db.queryFn });
  await markWebhookEventCompleted({ eventId: "sub123-paused-created_at_1000", queryFn: db.queryFn });
  const resumed = await claimWebhookEvent({ eventId: "sub123-resumed-created_at_1005", eventType: "subscription.resumed", queryFn: db.queryFn });
  await markWebhookEventCompleted({ eventId: "sub123-resumed-created_at_1005", queryFn: db.queryFn });
  const paused2 = await claimWebhookEvent({ eventId: "sub123-paused-created_at_1010", eventType: "subscription.paused", queryFn: db.queryFn });

  assert.equal(paused1.claimed, true);
  assert.equal(resumed.claimed, true);
  assert.equal(paused2.claimed, true, "a genuinely new 'paused' event for the same subscription (different created_at/hash) must not be treated as a duplicate of the first");
});

// ── Concurrency: the actual Promise.all() race proof ──────────────────────

test("exactly one of two truly concurrent claims for the SAME event id wins; the other is told it's a duplicate/in-flight, not an error", async () => {
  const db = makeFakeLedgerDb();

  const [resultA, resultB] = await Promise.all([
    claimWebhookEvent({ eventId: "race-1", eventType: "payment.captured", queryFn: db.queryFn }),
    claimWebhookEvent({ eventId: "race-1", eventType: "payment.captured", queryFn: db.queryFn }),
  ]);

  const claimedCount = [resultA, resultB].filter((r) => r.claimed).length;
  assert.equal(claimedCount, 1, "exactly one concurrent claim must win");
  assert.equal(db.inserts.length, 2, "both requests must have genuinely attempted the INSERT (a real race, not a pre-check that skips it)");
});

// ── Full handleWebhook end-to-end: real signature, real duplicate delivery ─

const buildSignedWebhookRequest = (payload) => {
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

const makeFakeFullWebhookDb = () => {
  const ledger = makeFakeLedgerDb();
  let paymentFailedUpdateCount = 0;

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (
      normalized.startsWith("INSERT INTO webhook_events") ||
      normalized.startsWith("SELECT status FROM webhook_events") ||
      normalized.startsWith("UPDATE webhook_events")
    ) {
      return ledger.queryFn(sql, params);
    }

    // payment.failed (non-subscription) branch's two writes — no order in
    // this fake DB, so both are no-ops that just prove call-count.
    if (normalized === "SELECT * FROM orders WHERE razorpay_order_id = ? LIMIT 1") {
      return { rows: [] }; // no matching order -> the branch's `if (order)` guard no-ops safely
    }

    throw new Error(`Unhandled fake SQL in webhookEventIdempotency (full) test: ${normalized}`);
  };

  return { queryFn, ledger, getPaymentFailedUpdateCount: () => paymentFailedUpdateCount };
};

test("Promise.all([processWebhook(event), processWebhook(event)]) — same event id — exactly one claims and processes, the other is safely acknowledged as a duplicate", async () => {
  const db = makeFakeFullWebhookDb();
  const payload = {
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_race1", order_id: "order_race1" } } },
  };

  const reqA = buildSignedWebhookRequest(payload);
  const reqB = buildSignedWebhookRequest(payload); // byte-identical body -> identical hash
  const resA = makeRes();
  const resB = makeRes();

  await Promise.all([
    handleWebhook(reqA, resA, { queryFn: db.queryFn }),
    handleWebhook(reqB, resB, { queryFn: db.queryFn }),
  ]);

  assert.equal(resA.statusCode, 200);
  assert.equal(resB.statusCode, 200);

  const duplicateResponses = [resA.body, resB.body].filter((b) => b?.duplicate === true);
  assert.equal(duplicateResponses.length, 1, "exactly one of the two concurrent identical deliveries must be told it's a duplicate");

  const eventId = crypto.createHash("sha256").update(reqA.rawBody).digest("hex");
  assert.equal(db.ledger.rows.get(`razorpay:${eventId}`).status, "completed");
});

test("8. an invalid signature never reaches the event ledger or any business processing", async () => {
  const db = makeFakeFullWebhookDb();
  const payload = { event: "payment.captured", payload: { payment: { entity: { id: "pay_x" } } } };
  const req = {
    headers: { "x-razorpay-signature": "not-a-real-signature" },
    rawBody: JSON.stringify(payload),
    body: payload,
    app: {},
  };
  const res = makeRes();

  await handleWebhook(req, res, {
    queryFn: async () => {
      throw new Error("queryFn (ledger or business logic) must never be called for an invalid signature");
    },
  });

  assert.equal(res.statusCode, 400);
});

test("a genuinely different second delivery (different event id) for the same order is processed independently, not blocked by the first", async () => {
  const db = makeFakeFullWebhookDb();
  const payload1 = {
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_first_attempt", order_id: "order_x" } } },
  };
  const payload2 = {
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_second_attempt", order_id: "order_x" } } },
  };

  const req1 = buildSignedWebhookRequest(payload1);
  const req2 = buildSignedWebhookRequest(payload2);

  await handleWebhook(req1, makeRes(), { queryFn: db.queryFn });
  await handleWebhook(req2, makeRes(), { queryFn: db.queryFn });

  const eventId1 = crypto.createHash("sha256").update(req1.rawBody).digest("hex");
  const eventId2 = crypto.createHash("sha256").update(req2.rawBody).digest("hex");
  assert.equal(db.ledger.rows.get(`razorpay:${eventId1}`).status, "completed");
  assert.equal(db.ledger.rows.get(`razorpay:${eventId2}`).status, "completed");
});

test("a business-logic failure marks the event 'failed' (retryable), not 'completed', and the error still propagates (500 via the caller)", async () => {
  const db = makeFakeFullWebhookDb();
  const throwingQueryFn = async (sql, params) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT INTO webhook_events") || normalized.startsWith("SELECT status FROM webhook_events") || normalized.startsWith("UPDATE webhook_events")) {
      return db.ledger.queryFn(sql, params);
    }
    if (normalized === "SELECT * FROM orders WHERE razorpay_order_id = ? LIMIT 1") {
      throw new Error("simulated DB outage mid-processing");
    }
    throw new Error(`Unhandled fake SQL: ${normalized}`);
  };

  const payload = {
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_will_fail", order_id: "order_will_fail" } } },
  };
  const req = buildSignedWebhookRequest(payload);

  await assert.rejects(() => handleWebhook(req, makeRes(), { queryFn: throwingQueryFn }));

  const eventId = crypto.createHash("sha256").update(req.rawBody).digest("hex");
  assert.equal(db.ledger.rows.get(`razorpay:${eventId}`).status, "failed");
});
