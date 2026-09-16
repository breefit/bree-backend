import test from "node:test";
import assert from "node:assert/strict";
import {
  pauseReminderForOrder,
  endReminderForOrder,
  resumeReminderForOrder,
} from "../src/services/dailyReminderService.js";

/**
 * PHASE 3 — Medium Issue #12: disableReminder/enableReminder/endReminder
 * always existed in dailyReminderService.js but nothing ever called them —
 * pausing, cancelling, or resuming a subscription left its daily WhatsApp
 * reminder (if the order had one) running/stopped independently of the
 * subscription's own state, since cron/dailyReminderCron.js's eligibility
 * query filters purely on daily_reminders.status. Added
 * pauseReminderForOrder/endReminderForOrder/resumeReminderForOrder as the
 * order-id-in entry points subscriptionController.js and
 * admin/subscriptionAdminController.js's pause/cancel/resume handlers now
 * call.
 *
 * Drives the REAL functions (not a regex over the source) against a fake
 * in-memory daily_reminders table. No production database.
 */

const makeFakeReminderDb = (initialReminders = []) => {
  const rows = new Map(initialReminders.map((r) => [r.id, { ...r }]));

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT id, user_id, reminder_enabled")) {
      const [orderId] = params;
      const match = [...rows.values()].find((r) => r.order_id === orderId);
      return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0 };
    }

    if (normalized === "UPDATE daily_reminders SET status = 'paused', updated_at = NOW() WHERE id = ?") {
      const [id] = params;
      const row = rows.get(id);
      if (row) row.status = "paused";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized === "UPDATE daily_reminders SET status = 'active', updated_at = NOW() WHERE id = ?") {
      const [id] = params;
      const row = rows.get(id);
      if (row) row.status = "active";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized === "UPDATE daily_reminders SET status = 'ended', updated_at = NOW() WHERE id = ?") {
      const [id] = params;
      const row = rows.get(id);
      if (row) row.status = "ended";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`Unhandled fake SQL in reminderSubscriptionWiring test: ${normalized}`);
  };

  return { queryFn, rows };
};

test("ISSUE-012: pauseReminderForOrder sets the order's active reminder to 'paused'", async () => {
  const db = makeFakeReminderDb([
    { id: "reminder-1", order_id: "order-1", status: "active" },
  ]);

  const result = await pauseReminderForOrder("order-1", { queryFn: db.queryFn });

  assert.equal(result.success, true);
  assert.equal(db.rows.get("reminder-1").status, "paused");
});

test("ISSUE-012: endReminderForOrder sets the order's reminder to 'ended' (cancellation — permanent)", async () => {
  const db = makeFakeReminderDb([
    { id: "reminder-1", order_id: "order-1", status: "active" },
  ]);

  const result = await endReminderForOrder("order-1", { queryFn: db.queryFn });

  assert.equal(result.success, true);
  assert.equal(db.rows.get("reminder-1").status, "ended");
});

test("ISSUE-012: resumeReminderForOrder re-activates a PAUSED reminder", async () => {
  const db = makeFakeReminderDb([
    { id: "reminder-1", order_id: "order-1", status: "paused" },
  ]);

  const result = await resumeReminderForOrder("order-1", { queryFn: db.queryFn });

  assert.equal(result.success, true);
  assert.equal(db.rows.get("reminder-1").status, "active");
});

test("ISSUE-012: resumeReminderForOrder does NOT resurrect an ENDED (cancelled) reminder", async () => {
  const db = makeFakeReminderDb([
    { id: "reminder-1", order_id: "order-1", status: "ended" },
  ]);

  const result = await resumeReminderForOrder("order-1", { queryFn: db.queryFn });

  assert.equal(result.skipped, true);
  assert.equal(db.rows.get("reminder-1").status, "ended", "an ended reminder must never be reactivated by a resume");
});

test("ISSUE-012: resumeReminderForOrder is a safe no-op for a reminder that's already active", async () => {
  const db = makeFakeReminderDb([
    { id: "reminder-1", order_id: "order-1", status: "active" },
  ]);

  const result = await resumeReminderForOrder("order-1", { queryFn: db.queryFn });

  assert.equal(result.skipped, true);
  assert.equal(db.rows.get("reminder-1").status, "active");
});

test("ISSUE-012 regression: an order with NO reminder at all is a safe no-op, not an error, for all three actions", async () => {
  const db = makeFakeReminderDb([]);

  const pauseResult = await pauseReminderForOrder("order-no-reminder", { queryFn: db.queryFn });
  const endResult = await endReminderForOrder("order-no-reminder", { queryFn: db.queryFn });
  const resumeResult = await resumeReminderForOrder("order-no-reminder", { queryFn: db.queryFn });

  assert.equal(pauseResult.skipped, true);
  assert.equal(endResult.skipped, true);
  assert.equal(resumeResult.skipped, true);
});

test("ISSUE-012 regression: pausing/ending one order's reminder never touches a different order's reminder", async () => {
  const db = makeFakeReminderDb([
    { id: "reminder-1", order_id: "order-1", status: "active" },
    { id: "reminder-2", order_id: "order-2", status: "active" },
  ]);

  await pauseReminderForOrder("order-1", { queryFn: db.queryFn });

  assert.equal(db.rows.get("reminder-1").status, "paused");
  assert.equal(db.rows.get("reminder-2").status, "active", "an unrelated order's reminder must be untouched");
});
