import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";

const { cancelShipment } = await import("../src/controllers/shippingController.js");
const { acquireReminderSendGuard } = await import("../cron/dailyReminderCron.js");
const { stopRemindersForCancelledOrder, stopRemindersForReturnedOrder } = await import(
  "../src/services/dailyReminderService.js"
);

/**
 * Order cancellation stops the order's daily reminders, in the same
 * transaction, using the return-approval mechanism (reminder_enabled = 0,
 * status = 'ended'). Incident: BREE-100019 was cancelled via Cancel Shipment
 * and its reminder stayed enabled/active, evaluated every minute forever.
 *
 * Drives the REAL cancelShipment and acquireReminderSendGuard against a fake
 * MySQL with genuine row-lock semantics on the order row (FOR UPDATE =
 * exclusive, LOCK IN SHARE MODE = shared) and transactional writes that only
 * become visible at COMMIT. No DB, Delhivery or WhatsApp call.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const norm = (sql) => sql.replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reader/writer lock per order row.
const createRowLock = () => {
  let writer = false;
  let readers = 0;
  const waiters = [];
  const wake = () => {
    for (let i = 0; i < waiters.length; ) {
      const w = waiters[i];
      if (w.mode === "S" && !writer) {
        readers++;
        waiters.splice(i, 1);
        w.resolve();
      } else if (w.mode === "X" && !writer && readers === 0) {
        writer = true;
        waiters.splice(i, 1);
        w.resolve();
        return;
      } else i++;
    }
  };
  return {
    acquire(mode) {
      return new Promise((resolve) => {
        waiters.push({ mode, resolve });
        wake();
      });
    },
    release(mode) {
      if (mode === "X") writer = false;
      else readers--;
      wake();
    },
  };
};

const createDb = ({ orders = [], reminders = [] } = {}) => {
  const committed = {
    orders: new Map(orders.map((o) => [o.id, { ...o }])),
    reminders: new Map(reminders.map((r) => [r.id, { ...r }])),
  };
  const locks = new Map();
  const lockFor = (id) => {
    if (!locks.has(id)) locks.set(id, createRowLock());
    return locks.get(id);
  };
  const events = [];
  const history = [];
  const hooks = { beforeReminderStop: null, failReminderStop: false };

  const makeClient = () => {
    let pending = null; // { orders: Map id->patch, reminders: Map id->patch }
    const held = [];
    const releaseLocks = () => {
      while (held.length) {
        const { id, mode } = held.pop();
        lockFor(id).release(mode);
      }
    };
    const readOrder = (id) => {
      const base = committed.orders.get(id);
      return base ? { ...base, ...(pending?.orders.get(id) || {}) } : null;
    };
    const readReminder = (id) => {
      const base = committed.reminders.get(id);
      return base ? { ...base, ...(pending?.reminders.get(id) || {}) } : null;
    };
    const write = (table, id, patch) => {
      const map = pending[table];
      map.set(id, { ...(map.get(id) || {}), ...patch });
    };

    return {
      async query(sql, params = []) {
        const q = norm(sql);
        if (q === "BEGIN") {
          pending = { orders: new Map(), reminders: new Map() };
          return { rows: [], rowCount: 0 };
        }
        if (q === "COMMIT") {
          for (const [id, patch] of pending?.orders || []) Object.assign(committed.orders.get(id), patch);
          for (const [id, patch] of pending?.reminders || []) Object.assign(committed.reminders.get(id), patch);
          if (pending?.orders.size) events.push("cancel_committed");
          pending = null;
          releaseLocks();
          return { rows: [], rowCount: 0 };
        }
        if (q === "ROLLBACK") {
          pending = null;
          releaseLocks();
          return { rows: [], rowCount: 0 };
        }

        // cancelShipment
        if (q.startsWith("SELECT id, order_number, order_status, tracking_status, awb_number, contact_name, contact_email FROM orders WHERE id = ?")) {
          const row = readOrder(params[0]);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (q === "SELECT id FROM orders WHERE id = ? FOR UPDATE") {
          await lockFor(params[0]).acquire("X");
          held.push({ id: params[0], mode: "X" });
          return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        if (q.startsWith("UPDATE orders SET tracking_status = ?, order_status = ?, delhivery_response = ?")) {
          const [trackingStatus, orderStatus, , id] = params;
          write("orders", id, { tracking_status: trackingStatus, order_status: orderStatus });
          return { rows: [], rowCount: 1 };
        }
        if (q.startsWith("INSERT INTO order_status_history")) {
          history.push(params);
          return { rows: [], rowCount: 1 };
        }
        if (q.startsWith("UPDATE daily_reminders SET reminder_enabled = 0, status = 'ended'")) {
          if (hooks.beforeReminderStop) await hooks.beforeReminderStop();
          if (hooks.failReminderStop) throw new Error("simulated daily_reminders failure");
          let n = 0;
          for (const id of committed.reminders.keys()) {
            const r = readReminder(id);
            if (r.order_id === params[0] && (r.reminder_enabled === 1 || ["active", "paused"].includes(r.status))) {
              write("reminders", id, { reminder_enabled: 0, status: "ended" });
              n++;
            }
          }
          return { rows: [], rowCount: n };
        }

        // Reminder scheduler send guard
        if (q === "SELECT return_status, order_status FROM orders WHERE id = ? LOCK IN SHARE MODE") {
          await lockFor(params[0]).acquire("S");
          held.push({ id: params[0], mode: "S" });
          const row = readOrder(params[0]);
          return row
            ? { rows: [{ return_status: row.return_status ?? null, order_status: row.order_status }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (q === "SELECT reminder_enabled, status FROM daily_reminders WHERE id = ?") {
          const r = readReminder(params[0]);
          return r ? { rows: [{ reminder_enabled: r.reminder_enabled, status: r.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        throw new Error(`Unhandled fake SQL in cancelReminderStop test: ${q}`);
      },
      release: releaseLocks,
    };
  };

  return {
    getClientFn: async () => makeClient(),
    queryFn: (sql, params) => makeClient().query(sql, params),
    committed,
    events,
    history,
    hooks,
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

const ORDER_ID = "0efc2f64-ab4f-4462-8cc2-202a9c80012d";
const shippedOrder = (extra = {}) => ({
  id: ORDER_ID,
  order_number: "BREE-100019",
  order_status: "ready_to_ship",
  tracking_status: "Manifested",
  awb_number: "58045510000055",
  return_status: null,
  contact_name: null,
  contact_email: null, // no email is ever sent
  ...extra,
});
const reminder = (id, orderId = ORDER_ID, extra = {}) => ({
  id,
  order_id: orderId,
  reminder_enabled: 1,
  status: "active",
  ...extra,
});

const delhivery = () => {
  const calls = [];
  return {
    calls,
    cancelShipment: async (awb) => {
      calls.push(awb);
      return { status: true, remark: "Shipment has been cancelled" };
    },
  };
};

const cancel = async (db, service = delhivery()) => {
  const res = makeRes();
  await cancelShipment({ params: { orderId: ORDER_ID }, body: {}, app: {} }, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: service,
  });
  return res;
};

const guard = (db, reminderId = "rem-1", orderId = ORDER_ID) =>
  acquireReminderSendGuard({ reminderId, orderId }, { getClientFn: db.getClientFn });

// ── cancelling an order disables its active reminder ─────────────────────

test("cancelling an order ends every active/paused reminder on it, in the cancellation transaction; other orders untouched", async () => {
  const db = createDb({
    orders: [shippedOrder(), { id: "other-order", order_status: "delivered", return_status: null }],
    reminders: [
      reminder("rem-1"),
      reminder("rem-2", ORDER_ID, { status: "paused" }),
      reminder("rem-other", "other-order"),
    ],
  });

  const res = await cancel(db);

  assert.equal(res.statusCode, 200);
  assert.equal(db.committed.orders.get(ORDER_ID).order_status, "cancelled");
  for (const id of ["rem-1", "rem-2"]) {
    assert.equal(db.committed.reminders.get(id).reminder_enabled, 0, id);
    assert.equal(db.committed.reminders.get(id).status, "ended", id);
  }
  // Delivered order's active reminder is not affected.
  assert.equal(db.committed.reminders.get("rem-other").reminder_enabled, 1);
  assert.equal(db.committed.reminders.get("rem-other").status, "active");
  const other = await guard(db, "rem-other", "other-order");
  assert.equal(other.allowed, true);
  await other.release();
});

test("cancellation and reminder stop commit together: if the reminder stop fails, the order is not cancelled either", async () => {
  const db = createDb({ orders: [shippedOrder()], reminders: [reminder("rem-1")] });
  db.hooks.failReminderStop = true;

  const res = await cancel(db);

  assert.equal(res.statusCode, 500);
  assert.equal(db.committed.orders.get(ORDER_ID).order_status, "ready_to_ship");
  assert.equal(db.committed.reminders.get("rem-1").status, "active");
});

// ── race with the reminder scheduler ────────────────────────────────────

test("race (cancel first): a send guard arriving mid-cancellation waits for the lock, then refuses the send", async () => {
  const db = createDb({ orders: [shippedOrder()], reminders: [reminder("rem-1")] });
  let guardPromise;
  db.hooks.beforeReminderStop = async () => {
    // Scheduler tick lands while the cancellation holds the row lock.
    guardPromise = guard(db).then((g) => {
      db.events.push(`guard_${g.allowed ? "allowed" : g.reason}`);
      return g;
    });
    await sleep(20);
  };

  const res = await cancel(db);
  const g = await guardPromise;

  assert.equal(res.statusCode, 200);
  assert.equal(g.allowed, false);
  assert.ok(["order_cancelled", "reminder_no_longer_active"].includes(g.reason), g.reason);
  assert.deepEqual(db.events, ["cancel_committed", g.allowed ? "guard_allowed" : `guard_${g.reason}`]);
});

test("race (send first): a cancellation arriving while a reminder send is in flight commits only after that send finishes", async () => {
  const db = createDb({ orders: [shippedOrder()], reminders: [reminder("rem-1")] });

  const g = await guard(db);
  assert.equal(g.allowed, true);

  const cancelPromise = cancel(db);
  await sleep(20);
  assert.deepEqual(db.events, [], "cancellation must be blocked by the in-flight send's shared lock");

  db.events.push("send_finished");
  await g.release();
  const res = await cancelPromise;

  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.events, ["send_finished", "cancel_committed"]);
  assert.equal(db.committed.reminders.get("rem-1").status, "ended");

  const next = await guard(db);
  assert.equal(next.allowed, false, "no send after the cancellation commits");
});

// ── stale active reminder on a cancelled order ──────────────────────────

test("cancelled order with a STALE enabled/active reminder (BREE-100019 today) is skipped by the scheduler", async () => {
  const db = createDb({
    orders: [shippedOrder({ order_status: "cancelled", tracking_status: "Not Picked" })],
    reminders: [reminder("rem-1")],
  });

  const g = await guard(db);

  assert.equal(g.allowed, false);
  assert.equal(g.reason, "order_cancelled");
  assert.equal(db.committed.reminders.get("rem-1").status, "active", "guard only skips; it never mutates");
});

test("both scheduler queries (eligibility + per-minute diagnostic) exclude cancelled orders", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "cron", "dailyReminderCron.js"), "utf8");
  const exclusions = source.match(/AND COALESCE\(o\.order_status, ''\) <> 'cancelled'/g) || [];
  assert.equal(exclusions.length, 2);
  assert.match(source, /const logSkippedReminders[\s\S]*?INNER JOIN orders o ON dr\.order_id = o\.id[\s\S]*?<> 'cancelled'/);
});

// ── no reminder / idempotent ────────────────────────────────────────────

test("cancelling an order with no reminder succeeds normally", async () => {
  const db = createDb({ orders: [shippedOrder()], reminders: [] });
  const res = await cancel(db);
  assert.equal(res.statusCode, 200);
  assert.equal(db.committed.orders.get(ORDER_ID).order_status, "cancelled");
  assert.equal(db.history.length, 1);
});

test("an already-cancelled order is idempotent: repeat cancel is refused with no further changes", async () => {
  const db = createDb({ orders: [shippedOrder()], reminders: [reminder("rem-1")] });
  const service = delhivery();

  assert.equal((await cancel(db, service)).statusCode, 200);
  const again = await cancel(db, service);

  assert.equal(again.statusCode, 400);
  assert.match(again.body.message, /already been cancelled/);
  assert.equal(service.calls.length, 1, "Delhivery is not called again");
  assert.equal(db.history.length, 1);
  assert.equal(db.committed.reminders.get("rem-1").status, "ended");

  // The shared helper itself is idempotent too.
  const { stopped } = await stopRemindersForCancelledOrder(ORDER_ID, { queryFn: db.queryFn });
  assert.equal(stopped, 0);
});

test("cancellation and return approval share ONE reminder-stop mechanism (same SQL, same end state)", async () => {
  const calls = [];
  const queryFn = async (sql, params) => {
    calls.push([norm(sql), params]);
    return { rowCount: 1 };
  };
  await stopRemindersForCancelledOrder("o1", { queryFn });
  await stopRemindersForReturnedOrder("o1", { queryFn });
  assert.equal(calls[0][0], calls[1][0]);
  assert.match(calls[0][0], /SET reminder_enabled = 0, status = 'ended'/);
});
