import test, { mock } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ||= "test";

const { runQuery } = await import("../src/config/database.js");
const { claimWebhookEvent } = await import("../src/services/webhookIdempotencyService.js");

/**
 * LIVE PRODUCTION VERIFICATION — Issue 3 (webhook duplicate looked like an
 * unhandled DB error).
 *
 * Root cause: runQuery() (config/database.js) logged every query failure at
 * the same "❌ Database Query Error" severity, including ER_DUP_ENTRY from
 * webhookIdempotencyService.claimWebhookEvent's INSERT — which is the
 * EXPECTED, correct result of the atomic idempotency claim racing
 * UNIQUE(provider, event_id), not a bug. Fixed with an opt-in
 * `isExpectedError` predicate a caller passes per-query: it only changes
 * log verbosity for a query whose thrown error matches that exact
 * predicate — every other failure (including a non-matching error on that
 * SAME query) still logs at full "❌ Database Query Error" severity, so no
 * real error can be masked by this.
 *
 * These tests drive the REAL runQuery/claimWebhookEvent functions against a
 * fake connection/queryFn — no production database.
 */

const duplicateKeyError = () => {
  const err = new Error(
    "Duplicate entry 'razorpay-hash-1' for key 'uq_webhook_events_provider_event_id'",
  );
  err.code = "ER_DUP_ENTRY";
  return err;
};

const lockTimeoutError = () => {
  const err = new Error("Lock wait timeout exceeded; try restarting transaction");
  err.code = "ER_LOCK_WAIT_TIMEOUT";
  return err;
};

const fakeThrowingConnection = (err) => ({
  query: async () => {
    throw err;
  },
});

test("an unclassified query error still logs at full '❌ Database Query Error' severity (default, unchanged behavior)", async () => {
  const errorCalls = [];
  const restore = mock.method(console, "error", (...args) => errorCalls.push(args));
  try {
    await assert.rejects(() =>
      runQuery(fakeThrowingConnection(lockTimeoutError()), "SELECT 1", []),
    );
    assert.ok(
      errorCalls.some((call) => call[0] === "❌ Database Query Error"),
      "an unexpected error must still be logged loudly by default",
    );
  } finally {
    restore.mock.restore();
  }
});

test("an error the caller classifies as expected is logged quietly, not as '❌ Database Query Error', but still propagates", async () => {
  const errorCalls = [];
  const infoCalls = [];
  const restoreError = mock.method(console, "error", (...args) => errorCalls.push(args));
  const restoreInfo = mock.method(console, "info", (...args) => infoCalls.push(args));
  try {
    await assert.rejects(
      () =>
        runQuery(fakeThrowingConnection(duplicateKeyError()), "INSERT INTO webhook_events ...", [], {
          isExpectedError: (err) => err.code === "ER_DUP_ENTRY",
        }),
      (err) => err.code === "ER_DUP_ENTRY",
      "the original error must still propagate — only logging changes",
    );
    assert.equal(
      errorCalls.some((call) => call[0] === "❌ Database Query Error"),
      false,
      "an expected/classified error must not be logged as an unhandled DB error",
    );
    assert.ok(
      infoCalls.some((call) => String(call[0]).includes("[DB] Expected constraint rejection")),
      "an expected/classified error must still be logged, just quietly",
    );
  } finally {
    restoreError.mock.restore();
    restoreInfo.mock.restore();
  }
});

test("isExpectedError only quiets the EXACT classified shape — a different error on the same query still logs loudly", async () => {
  const errorCalls = [];
  const restore = mock.method(console, "error", (...args) => errorCalls.push(args));
  try {
    await assert.rejects(() =>
      runQuery(fakeThrowingConnection(lockTimeoutError()), "INSERT INTO webhook_events ...", [], {
        isExpectedError: (err) => err.code === "ER_DUP_ENTRY",
      }),
    );
    assert.ok(
      errorCalls.some((call) => call[0] === "❌ Database Query Error"),
      "a genuine, unclassified failure on the same query must never be silently downgraded",
    );
  } finally {
    restore.mock.restore();
  }
});

test("claimWebhookEvent's real duplicate-claim path is wired to the quiet classification, not the default logger", async () => {
  let capturedOptions = null;
  const queryFn = async (sql, params, options) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT INTO webhook_events")) {
      capturedOptions = options;
      throw duplicateKeyError();
    }
    if (normalized.startsWith("SELECT status FROM webhook_events")) {
      return { rows: [{ status: "processing" }] };
    }
    throw new Error(`Unhandled fake SQL: ${normalized}`);
  };

  const result = await claimWebhookEvent({
    eventId: "hash-classification-test",
    eventType: "payment.captured",
    queryFn,
  });

  assert.equal(result.claimed, false);
  assert.equal(result.alreadyCompleted, false);
  assert.equal(typeof capturedOptions?.isExpectedError, "function");
  assert.equal(capturedOptions.isExpectedError(duplicateKeyError()), true);
  assert.equal(capturedOptions.isExpectedError(lockTimeoutError()), false);
});
