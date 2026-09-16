import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { ensureDailyReminderOrderProductUnique } from "../src/config/database.js";

/**
 * PHASE 3 — Medium Issue #24: ensureDailyReminderOrderProductUnique used to
 * skip adding the unique index with a bare one-line console.warn whenever
 * pre-existing duplicate (order_id, product_id) rows were found — repeated
 * identically on every restart forever, easy to lose in normal log volume,
 * with no detail an operator could act on. Escalated to console.error with
 * the actual duplicate-group count/ids; the skip itself is still
 * deliberately non-destructive (no automatic cleanup).
 *
 * Drives the REAL function against a fake information_schema-aware query
 * function — no production database.
 */

const makeFakeDb = ({ hasIndex = false, duplicateGroups = [] } = {}) => {
  const alterCalls = [];

  const queryFn = async (sql) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "SELECT DATABASE() AS db") {
      return [[{ db: "bree_test" }]];
    }

    if (normalized.startsWith("SELECT DISTINCT index_name")) {
      return [hasIndex ? [{ index_name: "uq_daily_reminders_order_product" }] : []];
    }

    if (normalized.startsWith("SELECT order_id, product_id, COUNT(*) AS occurrences")) {
      return [duplicateGroups];
    }

    if (normalized.startsWith("ALTER TABLE daily_reminders")) {
      alterCalls.push(normalized);
      return [{}];
    }

    throw new Error(`Unhandled fake SQL in dailyReminderUniqueIndexEscalation test: ${normalized}`);
  };

  return { queryFn, alterCalls };
};

test("ISSUE-024: duplicates present — logs at error level with the duplicate-group count, and does NOT add the index", async () => {
  const db = makeFakeDb({
    duplicateGroups: [
      { order_id: "order-1", product_id: "prod-1", occurrences: 2 },
      { order_id: "order-2", product_id: "prod-5", occurrences: 3 },
    ],
  });

  const errorCalls = [];
  mock.method(console, "error", (...args) => errorCalls.push(args));
  try {
    await ensureDailyReminderOrderProductUnique({ queryFn: db.queryFn });
  } finally {
    mock.restoreAll();
  }

  assert.equal(db.alterCalls.length, 0, "must not add the unique index while duplicates exist");
  assert.ok(errorCalls.length >= 1, "must log at error level, not just warn");
  const [message, detail] = errorCalls[0];
  assert.match(message, /2 duplicate/);
  assert.equal(detail.duplicateGroups.length, 2);
});

test("ISSUE-024 regression: no duplicates — the unique index IS added", async () => {
  const db = makeFakeDb({ duplicateGroups: [] });

  await ensureDailyReminderOrderProductUnique({ queryFn: db.queryFn });

  assert.equal(db.alterCalls.length, 1);
  assert.match(db.alterCalls[0], /ADD UNIQUE INDEX uq_daily_reminders_order_product/);
});

test("ISSUE-024 regression: the index already existing is a safe no-op (never re-checks for duplicates or re-alters)", async () => {
  const db = makeFakeDb({ hasIndex: true, duplicateGroups: [{ order_id: "x", product_id: "y", occurrences: 5 }] });

  await ensureDailyReminderOrderProductUnique({ queryFn: db.queryFn });

  assert.equal(db.alterCalls.length, 0);
});
