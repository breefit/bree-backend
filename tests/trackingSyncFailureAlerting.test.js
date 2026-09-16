import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  recordTrackingSyncFailure,
  resetTrackingSyncFailure,
} from "../cron/shippingTrackingCron.js";

/**
 * PHASE 3 — Medium Issue #17: a persistently-failing Delhivery tracking API
 * call for a given order used to be only console.error'd and silently
 * retried on the next 30-minute cron tick, indefinitely — no counter, no
 * escalation. recordTrackingSyncFailure increments a per-order counter and
 * logs a distinct high-visibility ALERT once it crosses a threshold;
 * resetTrackingSyncFailure clears it back to 0 on the next success.
 *
 * Drives the REAL functions against a fake in-memory orders table. No
 * production database, no real Delhivery call.
 */

const makeFakeOrdersDb = (initialOrder) => {
  const orders = new Map([[initialOrder.id, { ...initialOrder }]]);

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("UPDATE orders SET tracking_sync_failure_count = tracking_sync_failure_count + 1")) {
      const [id] = params;
      const row = orders.get(id);
      if (row) {
        row.tracking_sync_failure_count = (row.tracking_sync_failure_count || 0) + 1;
        row.tracking_sync_last_failure_at = new Date();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized === "SELECT tracking_sync_failure_count FROM orders WHERE id = ?") {
      const [id] = params;
      const row = orders.get(id);
      return { rows: row ? [{ tracking_sync_failure_count: row.tracking_sync_failure_count }] : [] };
    }

    if (normalized === "UPDATE orders SET tracking_sync_failure_count = 0 WHERE id = ?") {
      const [id] = params;
      const row = orders.get(id);
      if (row) row.tracking_sync_failure_count = 0;
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`Unhandled fake SQL in trackingSyncFailureAlerting test: ${normalized}`);
  };

  return { queryFn, orders };
};

const baseOrder = (overrides = {}) => ({
  id: "order-1",
  awb_number: "AWB123456",
  tracking_sync_failure_count: 0,
  ...overrides,
});

test("ISSUE-017: each failure increments the counter by exactly 1", async () => {
  const db = makeFakeOrdersDb(baseOrder());

  await recordTrackingSyncFailure(db.orders.get("order-1"), { queryFn: db.queryFn });
  await recordTrackingSyncFailure(db.orders.get("order-1"), { queryFn: db.queryFn });

  assert.equal(db.orders.get("order-1").tracking_sync_failure_count, 2);
});

test("ISSUE-017: crossing the alert threshold logs a distinct high-visibility ALERT", async () => {
  const db = makeFakeOrdersDb(baseOrder({ tracking_sync_failure_count: 4 }));

  const errorCalls = [];
  mock.method(console, "error", (...args) => errorCalls.push(args));
  try {
    await recordTrackingSyncFailure(db.orders.get("order-1"), { queryFn: db.queryFn, alertThreshold: 5 });
  } finally {
    mock.restoreAll();
  }

  assert.equal(db.orders.get("order-1").tracking_sync_failure_count, 5);
  const alertLogged = errorCalls.some(([msg]) => typeof msg === "string" && msg.includes("ALERT"));
  assert.ok(alertLogged, "must log a distinct ALERT once the threshold is crossed");
});

test("ISSUE-017 regression: below the threshold, no ALERT is logged", async () => {
  const db = makeFakeOrdersDb(baseOrder({ tracking_sync_failure_count: 1 }));

  const errorCalls = [];
  mock.method(console, "error", (...args) => errorCalls.push(args));
  try {
    await recordTrackingSyncFailure(db.orders.get("order-1"), { queryFn: db.queryFn, alertThreshold: 5 });
  } finally {
    mock.restoreAll();
  }

  const alertLogged = errorCalls.some(([msg]) => typeof msg === "string" && msg.includes("ALERT"));
  assert.equal(alertLogged, false);
});

test("ISSUE-017: resetTrackingSyncFailure clears the counter back to 0 after a run of failures", async () => {
  const db = makeFakeOrdersDb(baseOrder({ tracking_sync_failure_count: 7 }));

  await resetTrackingSyncFailure(db.orders.get("order-1"), { queryFn: db.queryFn });

  assert.equal(db.orders.get("order-1").tracking_sync_failure_count, 0);
});

test("ISSUE-017 regression: resetting an order that never failed is a safe no-op (no UPDATE issued)", async () => {
  const db = makeFakeOrdersDb(baseOrder({ tracking_sync_failure_count: 0 }));
  let updateCalled = false;
  const queryFn = async (sql, params) => {
    if (sql.includes("tracking_sync_failure_count = 0")) updateCalled = true;
    return db.queryFn(sql, params);
  };

  await resetTrackingSyncFailure(db.orders.get("order-1"), { queryFn });

  assert.equal(updateCalled, false);
});
