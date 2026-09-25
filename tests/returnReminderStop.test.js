import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { closePool } from "../src/config/database.js";
import { approveReturn } from "../src/controllers/admin/returnController.js";
import {
  isReminderBlockedByReturnStatus,
  stopRemindersForReturnedOrder,
  resumeReminderForOrder,
  REMINDER_BLOCKING_RETURN_STATUSES,
} from "../src/services/dailyReminderService.js";
import {
  acquireReminderSendGuard,
  claimReminderSendSlot,
} from "../cron/dailyReminderCron.js";

/**
 * Daily reminder must stop once an order's return is approved.
 *
 * Drives the REAL approveReturn / stopRemindersForReturnedOrder /
 * acquireReminderSendGuard / resumeReminderForOrder against in-memory
 * fakes — no database, no WAPLIFY. The same behavior against a real MySQL
 * (row locks, concurrent approval vs. scheduler tick, the fake WAPLIFY HTTP
 * server) is covered by tests/returnReminderEndToEnd.test.js.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// approveReturn's fire-and-forget appendStatusHistory goes through the real
// pool; close it so this file exits even when TEST_DATABASE_URL is set.
after(() => closePool().catch(() => {}));

const norm = (sql) => sql.replace(/\s+/g, " ").trim();

// 48h return window is measured from delivered_at — keep it fresh.
const recentlyDelivered = () => new Date(Date.now() - 60 * 60 * 1000);

// ── Fake transactional orders + daily_reminders store ───────────────────────
// BEGIN snapshots the committed state, COMMIT publishes it, ROLLBACK drops
// it — enough to prove the approval and the reminder stop are atomic.
const makeFakeReturnDb = ({ orders = [], reminders = [] } = {}) => {
  const clone = (m) => new Map([...m].map(([k, v]) => [k, { ...v }]));
  const committed = {
    orders: new Map(orders.map((o) => [o.id, { ...o }])),
    reminders: new Map(reminders.map((r) => [r.id, { ...r }])),
  };
  const stats = { released: 0, commits: 0, rollbacks: 0 };
  let failReminderUpdate = false;

  const makeClient = () => {
    let tx = null;
    const state = () => tx || committed;
    return {
      async query(sql, params = []) {
        const q = norm(sql);
        if (q === "BEGIN") {
          tx = { orders: clone(committed.orders), reminders: clone(committed.reminders) };
          return { rows: [], rowCount: 0 };
        }
        if (q === "COMMIT") {
          committed.orders = tx.orders;
          committed.reminders = tx.reminders;
          tx = null;
          stats.commits++;
          return { rows: [], rowCount: 0 };
        }
        if (q === "ROLLBACK") {
          tx = null;
          stats.rollbacks++;
          return { rows: [], rowCount: 0 };
        }
        if (q === "SELECT * FROM orders WHERE id = ? FOR UPDATE" || q === "SELECT * FROM orders WHERE id = ? LIMIT 1") {
          const o = state().orders.get(params[0]);
          return { rows: o ? [{ ...o }] : [], rowCount: o ? 1 : 0 };
        }
        if (q.startsWith("UPDATE orders SET return_status = 'approved'")) {
          const [reason, notes, adminId, id] = params;
          const o = state().orders.get(id);
          Object.assign(o, {
            return_status: "approved",
            return_reason: reason,
            return_notes: notes,
            return_approved_by: adminId,
          });
          return { rows: [], rowCount: 1 };
        }
        if (q.startsWith("UPDATE daily_reminders SET reminder_enabled = 0, status = 'ended'")) {
          if (failReminderUpdate) throw new Error("simulated daily_reminders failure");
          let n = 0;
          for (const r of state().reminders.values()) {
            if (
              r.order_id === params[0] &&
              (r.reminder_enabled === 1 || ["active", "paused"].includes(r.status))
            ) {
              r.reminder_enabled = 0;
              r.status = "ended";
              n++;
            }
          }
          return { rows: [], rowCount: n };
        }
        throw new Error(`Unhandled fake SQL in returnReminderStop test: ${q}`);
      },
      release() {
        stats.released++;
      },
    };
  };

  return {
    getClientFn: async () => makeClient(),
    queryFn: (sql, params) => makeClient().query(sql, params),
    committed,
    stats,
    failNextReminderUpdate() {
      failReminderUpdate = true;
    },
  };
};

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

const approve = async (db, orderId) => {
  const res = makeRes();
  await approveReturn(
    { params: { orderId }, body: { reason: "damaged" }, admin: { id: null }, app: { locals: {} } },
    res,
    { getClientFn: db.getClientFn },
  );
  return res;
};

// No contact email/phone → notifyReturnEvent sends nothing; appendStatusHistory
// is fire-and-forget with its own .catch (no DB in unit-test mode).
const deliveredOrder = (id, extra = {}) => ({
  id,
  order_status: "delivered",
  delivered_at: recentlyDelivered(),
  return_status: null,
  ...extra,
});

const reminder = (id, orderId, extra = {}) => ({
  id,
  order_id: orderId,
  reminder_enabled: 1,
  status: "active",
  ...extra,
});

// ── Fake guard connection (orders.return_status + daily_reminders row) ──────
const makeGuardDb = ({ returnStatus = null, orderExists = true, reminderRow, failOn } = {}) => {
  const log = [];
  const stats = { released: 0 };
  const client = {
    async query(sql, params = []) {
      const q = norm(sql);
      log.push(q);
      if (failOn && q.startsWith(failOn)) throw new Error("simulated DB failure");
      if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (q === "SELECT return_status FROM orders WHERE id = ? LOCK IN SHARE MODE") {
        return orderExists
          ? { rows: [{ return_status: returnStatus }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (q === "SELECT reminder_enabled, status FROM daily_reminders WHERE id = ?") {
        const row = reminderRow === undefined ? { reminder_enabled: 1, status: "active" } : reminderRow;
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error(`Unhandled fake guard SQL: ${q}`);
    },
    release() {
      stats.released++;
    },
  };
  return { getClientFn: async () => client, log, stats };
};

const guardFor = (db) =>
  acquireReminderSendGuard({ reminderId: "rem-1", orderId: "order-1" }, { getClientFn: db.getClientFn });

// ── TEST A ───────────────────────────────────────────────────────────────────
test("A: active reminder + normal order (no return) → scheduler guard allows the send", async () => {
  assert.equal(isReminderBlockedByReturnStatus(null), false);
  const db = makeGuardDb({ returnStatus: null });
  const guard = await guardFor(db);
  assert.equal(guard.allowed, true);
  await guard.release();
  assert.equal(db.stats.released, 1);
});

test("A: a REJECTED return does not stop the reminder (the customer keeps the product)", async () => {
  assert.equal(isReminderBlockedByReturnStatus("rejected"), false);
  const guard = await guardFor(makeGuardDb({ returnStatus: "rejected" }));
  assert.equal(guard.allowed, true);
  await guard.release();
});

// ── TEST B ───────────────────────────────────────────────────────────────────
test("B: approving a return stops every active/paused reminder on that order, in the same transaction", async () => {
  const db = makeFakeReturnDb({
    orders: [deliveredOrder("order-1"), deliveredOrder("order-2")],
    reminders: [
      reminder("rem-active", "order-1"),
      reminder("rem-paused", "order-1", { status: "paused" }),
      reminder("rem-other-order", "order-2"),
    ],
  });

  const res = await approve(db, "order-1");

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(db.committed.orders.get("order-1").return_status, "approved");
  for (const id of ["rem-active", "rem-paused"]) {
    assert.equal(db.committed.reminders.get(id).reminder_enabled, 0, id);
    assert.equal(db.committed.reminders.get(id).status, "ended", id);
  }
  // A different order's reminder is untouched.
  assert.deepEqual(db.committed.reminders.get("rem-other-order"), reminder("rem-other-order", "order-2"));
  assert.equal(db.stats.commits, 1);
  assert.equal(db.stats.released, 1);
});

test("B: if stopping the reminder fails, the return approval rolls back too (never approved-with-reminder-still-running)", async () => {
  const db = makeFakeReturnDb({
    orders: [deliveredOrder("order-1")],
    reminders: [reminder("rem-1", "order-1")],
  });
  db.failNextReminderUpdate();

  const res = await approve(db, "order-1");

  assert.equal(res.statusCode, 500);
  assert.equal(db.committed.orders.get("order-1").return_status, null);
  assert.equal(db.committed.reminders.get("rem-1").status, "active");
  assert.equal(db.stats.commits, 0);
  assert.equal(db.stats.rollbacks, 1);
  assert.equal(db.stats.released, 1);
});

test("B: approving a return on an order with no reminder is unaffected", async () => {
  const db = makeFakeReturnDb({ orders: [deliveredOrder("order-1")] });
  const res = await approve(db, "order-1");
  assert.equal(res.statusCode, 200);
  assert.equal(db.committed.orders.get("order-1").return_status, "approved");
});

// ── TEST C / D ───────────────────────────────────────────────────────────────
test("C: once the return is approved, the scheduler guard refuses the send", async () => {
  const guard = await guardFor(makeGuardDb({ returnStatus: "approved", reminderRow: { reminder_enabled: 0, status: "ended" } }));
  assert.equal(guard.allowed, false);
  assert.equal(guard.reason, "return_approved");
});

test("D: STALE reminder_enabled=1/status='active' but order return approved → guard still refuses, for every approved-return status", async () => {
  assert.deepEqual([...REMINDER_BLOCKING_RETURN_STATUSES], [
    "approved",
    "reverse_shipment_created",
    "pickup_scheduled",
    "returned",
  ]);
  for (const returnStatus of REMINDER_BLOCKING_RETURN_STATUSES) {
    const db = makeGuardDb({ returnStatus, reminderRow: { reminder_enabled: 1, status: "active" } });
    const guard = await guardFor(db);
    assert.equal(guard.allowed, false, returnStatus);
    assert.equal(guard.reason, "return_approved", returnStatus);
    assert.equal(guard.returnStatus, returnStatus);
    assert.equal(db.stats.released, 1, "a refused guard releases its connection immediately");
  }
});

test("guard reads the order under a shared lock BEFORE the reminder row (same lock order as approveReturn → no deadlock)", async () => {
  const db = makeGuardDb();
  const guard = await guardFor(db);
  await guard.release();
  assert.deepEqual(db.log, [
    "BEGIN",
    "SELECT return_status FROM orders WHERE id = ? LOCK IN SHARE MODE",
    "SELECT reminder_enabled, status FROM daily_reminders WHERE id = ?",
    "COMMIT",
  ]);
});

test("guard refuses a reminder disabled/paused/ended after the eligibility query ran (manual disable race)", async () => {
  for (const reminderRow of [
    { reminder_enabled: 0, status: "active" },
    { reminder_enabled: 1, status: "paused" },
    { reminder_enabled: 1, status: "ended" },
    null,
  ]) {
    const guard = await guardFor(makeGuardDb({ reminderRow }));
    assert.equal(guard.allowed, false, JSON.stringify(reminderRow));
    assert.equal(guard.reason, "reminder_no_longer_active");
  }
});

test("guard fails closed: a DB error while checking throws (scheduler counts it failed, never sends) and the connection is released", async () => {
  const db = makeGuardDb({ failOn: "SELECT return_status" });
  await assert.rejects(guardFor(db), /simulated DB failure/);
  assert.equal(db.stats.released, 1);
  assert.ok(db.log.includes("ROLLBACK"));
});

test("guard release() is idempotent (one COMMIT, one connection release)", async () => {
  const db = makeGuardDb();
  const guard = await guardFor(db);
  await guard.release();
  await guard.release();
  assert.equal(db.stats.released, 1);
  assert.equal(db.log.filter((q) => q === "COMMIT").length, 1);
});

// ── TEST E ───────────────────────────────────────────────────────────────────
test("E: repeating the approval is refused and has no further effect", async () => {
  const db = makeFakeReturnDb({
    orders: [deliveredOrder("order-1")],
    reminders: [reminder("rem-1", "order-1")],
  });

  const first = await approve(db, "order-1");
  const snapshot = JSON.stringify([...db.committed.reminders.values()]);
  const second = await approve(db, "order-1");

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 400);
  assert.match(second.body.message, /already in progress/);
  assert.equal(JSON.stringify([...db.committed.reminders.values()]), snapshot);
  assert.equal(db.stats.commits, 1, "only the first approval ever commits");
});

test("E: stopRemindersForReturnedOrder is idempotent — a second run changes nothing", async () => {
  const db = makeFakeReturnDb({ reminders: [reminder("rem-1", "order-1")] });
  const first = await stopRemindersForReturnedOrder("order-1", { queryFn: db.queryFn });
  const second = await stopRemindersForReturnedOrder("order-1", { queryFn: db.queryFn });
  assert.equal(first.stopped, 1);
  assert.equal(second.stopped, 0);
  assert.equal(db.committed.reminders.get("rem-1").status, "ended");
});

// ── TEST I ───────────────────────────────────────────────────────────────────
const makeResumeDb = ({ reminderRow, returnStatus }) => {
  const row = { ...reminderRow };
  const queryFn = async (sql, params = []) => {
    const q = norm(sql);
    if (q.startsWith("SELECT id, user_id, reminder_enabled")) {
      return row.order_id === params[0] ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (q === "SELECT return_status FROM orders WHERE id = ? LIMIT 1") {
      return { rows: [{ return_status: returnStatus }], rowCount: 1 };
    }
    if (q === "UPDATE daily_reminders SET status = 'active', updated_at = NOW() WHERE id = ?") {
      row.status = "active";
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unhandled fake resume SQL: ${q}`);
  };
  return { queryFn, row };
};

test("I: a reminder stopped by return approval is never reactivated by a subscription resume", async () => {
  const db = makeResumeDb({
    reminderRow: reminder("rem-1", "order-1", { reminder_enabled: 0, status: "ended" }),
    returnStatus: "approved",
  });
  const result = await resumeReminderForOrder("order-1", { queryFn: db.queryFn });
  assert.equal(result.skipped, true);
  assert.equal(db.row.status, "ended");
});

test("I: a legacy PAUSED reminder on an order with an approved return is NOT resumed", async () => {
  for (const returnStatus of REMINDER_BLOCKING_RETURN_STATUSES) {
    const db = makeResumeDb({
      reminderRow: reminder("rem-1", "order-1", { status: "paused" }),
      returnStatus,
    });
    const result = await resumeReminderForOrder("order-1", { queryFn: db.queryFn });
    assert.equal(result.blockedByReturn, true, returnStatus);
    assert.equal(db.row.status, "paused", returnStatus);
  }
});

test("I (regression): a paused reminder on a normal / rejected-return order still resumes", async () => {
  for (const returnStatus of [null, "rejected"]) {
    const db = makeResumeDb({
      reminderRow: reminder("rem-1", "order-1", { status: "paused" }),
      returnStatus,
    });
    const result = await resumeReminderForOrder("order-1", { queryFn: db.queryFn });
    assert.equal(result.success, true);
    assert.equal(db.row.status, "active", String(returnStatus));
  }
});

// ── TEST J ───────────────────────────────────────────────────────────────────
test("J: duplicate-send protection unchanged — the second claim for the same reminder+day is refused", async () => {
  const rows = new Map();
  const queryExecutor = async (sql, params) => {
    const q = norm(sql);
    if (q.startsWith("INSERT IGNORE INTO daily_reminder_sends")) {
      const [, reminderId, sendDate] = params;
      const key = `${reminderId}:${sendDate}`;
      if (!rows.has(key)) rows.set(key, { status: "pending" });
      return { rows: [], rowCount: 0 };
    }
    if (q.includes("SET status = 'sending'")) {
      const row = rows.get(`${params[0]}:${params[1]}`);
      if (!row || !["pending", "failed"].includes(row.status)) return { rows: [], rowCount: 0 };
      row.status = "sending";
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unhandled: ${q}`);
  };
  const [a, b] = await Promise.all([
    claimReminderSendSlot("rem-1", "2026-09-25", queryExecutor),
    claimReminderSendSlot("rem-1", "2026-09-25", queryExecutor),
  ]);
  assert.equal([a, b].filter((r) => r.claimed).length, 1);
});

// ── Refund / other return steps never re-enable a reminder ──────────────────
test("no code path re-enables reminder_enabled after creation, and only approveReturn touches reminders in the return/refund controller", () => {
  const srcDir = path.join(__dirname, "..", "src");
  const cronDir = path.join(__dirname, "..", "cron");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(srcDir);
  walk(cronDir);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, setClause] of source.matchAll(/UPDATE\s+daily_reminders\s+SET\s+([\s\S]*?)\s+WHERE/gi)) {
      assert.doesNotMatch(setClause, /reminder_enabled\s*=\s*1/i, file);
    }
  }

  const returnSource = fs.readFileSync(
    path.join(srcDir, "controllers", "admin", "returnController.js"),
    "utf8",
  );
  assert.equal((returnSource.match(/stopRemindersForReturnedOrder\(/g) || []).length, 1);
  assert.doesNotMatch(returnSource, /enableReminder|resumeReminderForOrder|UPDATE\s+daily_reminders/);
});
