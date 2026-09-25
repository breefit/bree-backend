/**
 * Daily reminder must stop once an order's return is approved — end to end.
 *
 * Exercises the REAL code path, nothing re-implemented:
 *   returnController.approveReturn (real transaction, SELECT ... FOR UPDATE,
 *   stopRemindersForReturnedOrder) and runDailyReminderScheduler
 *   (getEligibleReminders → acquireReminderSendGuard's LOCK IN SHARE MODE →
 *   claimReminderSendSlot → sendDailyWellnessReminder → axios → HTTP)
 *
 * against:
 *   - a real MySQL test database (TEST_DATABASE_URL — never production;
 *     database.js hard-aborts if it equals DATABASE_URL), so the row locks
 *     that order approval vs. an in-flight send are real InnoDB locks;
 *   - the same fake WAPLIFY HTTP server on 127.0.0.1 as
 *     tests/dailyReminderEndToEnd.test.js (base URL and API key overridden
 *     before the WhatsApp module is imported — the real provider can never
 *     be reached);
 *   - a controlled clock (node:test mock timers, Date only).
 *
 * Skipped (not failed) when TEST_DATABASE_URL is not configured. The
 * in-memory counterparts that always run are in
 * tests/returnReminderStop.test.js.
 */
import test, { before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL?.trim());
const skip = HAS_TEST_DB
  ? false
  : "TEST_DATABASE_URL not configured — return/reminder end-to-end tests need a real (non-production) MySQL";

const FAKE_API_KEY = "test-fake-waplify-key";
const TEST_PHONE = "9876500002"; // synthetic, not a customer
const APPROVED_RETURN_STATUSES = ["approved", "reverse_shipment_created", "pickup_scheduled", "returned"];

// ── Fake WAPLIFY + ordered event log ─────────────────────────────────────────
const events = []; // shared timeline: waplify request/response, approval commit
const waplify = {
  requests: [],
  status: 200,
  latencyMs: 0,
  reset() {
    this.requests = [];
    this.status = 200;
    this.latencyMs = 0;
  },
};
const dailyReminderRequests = () =>
  waplify.requests.filter((r) => r.body.template_name === "daily_reminder");

let server;
let db;
let cron;
let service;
let returns;

before(async () => {
  if (!HAS_TEST_DB) return;

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const parsed = JSON.parse(body || "{}");
      waplify.requests.push({ url: req.url, body: parsed });
      events.push(`waplify_request:${parsed.template_name}`);
      if (waplify.latencyMs) {
        await new Promise((r) => setTimeout(r, waplify.latencyMs));
      }
      events.push(`waplify_response:${parsed.template_name}`);
      const status = waplify.status;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          status === 200
            ? { success: true, data: { message_id: `wamid-${waplify.requests.length}` } }
            : { success: false, message: `fake provider error ${status}` },
        ),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  process.env.WAPLIFY_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.WAPLIFY_API_KEY = FAKE_API_KEY;
  process.env.WAPLIFY_TEMPLATE_DAILY_REMINDER = "daily_reminder";

  db = await import("../src/config/database.js");
  cron = await import("../cron/dailyReminderCron.js");
  service = await import("../src/services/dailyReminderService.js");
  returns = await import("../src/controllers/admin/returnController.js");

  assert.match(process.env.WAPLIFY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
});

after(async () => {
  mock.timers.reset();
  if (db) await db.closePool();
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  if (!HAS_TEST_DB) return;
  mock.timers.reset();
  waplify.reset();
  events.length = 0;
  await db.query("DELETE FROM daily_reminder_sends");
  await db.query("DELETE FROM daily_reminders");
  await db.query("DELETE FROM order_status_history");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM users");
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const at = (istWallClock) => {
  const ms = Date.parse(`${istWallClock.replace(" ", "T")}:00+05:30`);
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: ms });
};

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await realSleep(10);
  }
};

/**
 * Customer + order + purchased reminder, delivered at 2026-09-24 13:30 IST
 * (reminder window starts 2026-09-25). No contact email/phone on the order,
 * so approveReturn's own "Return Approved" notification sends nothing — the
 * only WAPLIFY traffic in these tests is the daily reminder itself.
 */
const seedDeliveredReminder = async ({ reminderTime = "05:00" } = {}) => {
  const userId = randomUUID();
  const orderId = randomUUID();
  await db.query(`INSERT INTO users (id, name, phone) VALUES (?, ?, ?)`, [userId, "Test Customer", TEST_PHONE]);
  await db.query(`INSERT INTO orders (id, user_id, order_status) VALUES (?, ?, 'shipped')`, [orderId, userId]);
  const { reminderId } = await service.createDailyReminder({
    userId,
    orderId,
    productId: randomUUID(),
    reminderTime,
    reminderPricePaid: 9,
    reminderOriginalPrice: 59,
  });

  at("2026-09-24 13:30");
  await db.query(`UPDATE orders SET order_status = 'delivered', delivered_at = ? WHERE id = ?`, [new Date(), orderId]);
  const activation = await service.activateReminderFromDelivery({
    reminderId,
    deliveryDate: new Date().toISOString().split("T")[0],
  });
  assert.equal(activation.success, true, activation.error);
  assert.equal(activation.startDate, "2026-09-25");
  return { userId, orderId, reminderId };
};

const reminderRow = async (reminderId) =>
  (await db.query(`SELECT reminder_enabled, status FROM daily_reminders WHERE id = ?`, [reminderId])).rows[0];

const sendRows = async (reminderId) =>
  (
    await db.query(
      `SELECT DATE_FORMAT(send_date, '%Y-%m-%d') AS send_date, status FROM daily_reminder_sends WHERE reminder_id = ?`,
      [reminderId],
    )
  ).rows;

/** Wraps the real getClient so COMMIT is recorded on the shared timeline and can be held open. */
const recordingGetClient = ({ holdCommit } = {}) => async () => {
  const client = await db.getClient();
  const originalQuery = client.query;
  client.query = async (text, params, options) => {
    if (String(text).trim() === "COMMIT") {
      if (holdCommit) {
        holdCommit.reached();
        await holdCommit.gate;
      }
      const result = await originalQuery(text, params, options);
      events.push("approval_commit");
      return result;
    }
    return originalQuery(text, params, options);
  };
  return client;
};

const approveViaController = async (orderId, { getClientFn } = {}) => {
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
  await returns.approveReturn(
    { params: { orderId }, body: { reason: "damaged" }, admin: { id: null }, app: { locals: {} } },
    res,
    { getClientFn: getClientFn || recordingGetClient() },
  );
  return res;
};

const tickEveryMinute = async (day, fromHHMM, toHHMM) => {
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const results = [];
  for (let m = toMin(fromHHMM); m <= toMin(toHHMM); m++) {
    at(`${day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    results.push(await cron.runDailyReminderScheduler());
  }
  return results;
};

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

// ── TEST H / A: normal order ─────────────────────────────────────────────────
test("H: normal (non-returned) order + scheduler ticks → exactly one DAILY_REMINDER, recorded success", { skip }, async () => {
  const r = await seedDeliveredReminder();
  await tickEveryMinute("2026-09-25", "04:50", "05:10");
  assert.equal(dailyReminderRequests().length, 1);
  assert.deepEqual(await sendRows(r.reminderId), [{ send_date: "2026-09-25", status: "success" }]);
});

test("H: a REJECTED return leaves the reminder running", { skip }, async () => {
  const r = await seedDeliveredReminder();
  await db.query(`UPDATE orders SET return_status = 'rejected' WHERE id = ?`, [r.orderId]);
  at("2026-09-25 05:00");
  const result = await cron.runDailyReminderScheduler();
  assert.equal(result.sent, 1);
  assert.equal(dailyReminderRequests().length, 1);
});

test("regression: outside the scheduled time, manually disabled, or expired → no send (unchanged)", { skip }, async () => {
  const r = await seedDeliveredReminder();
  await tickEveryMinute("2026-09-25", "05:06", "05:10");
  assert.equal(dailyReminderRequests().length, 0, "outside time window");

  await db.query(`UPDATE daily_reminders SET reminder_enabled = 0 WHERE id = ?`, [r.reminderId]);
  await tickEveryMinute("2026-09-25", "05:00", "05:00");
  assert.equal(dailyReminderRequests().length, 0, "manually disabled");

  await db.query(`UPDATE daily_reminders SET reminder_enabled = 1, reminder_end_date = '2026-09-24' WHERE id = ?`, [r.reminderId]);
  await tickEveryMinute("2026-09-25", "05:00", "05:00");
  assert.equal(dailyReminderRequests().length, 0, "expired");
});

// ── TEST B / C / G ───────────────────────────────────────────────────────────
test("B + C + G: approving the return stops the reminder in the DB, and the scheduler sends no DAILY_REMINDER afterwards", { skip }, async () => {
  const r = await seedDeliveredReminder();

  at("2026-09-25 02:00");
  const res = await approveViaController(r.orderId);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.order.return_status, "approved");
  assert.deepEqual(await reminderRow(r.reminderId), { reminder_enabled: 0, status: "ended" });

  const results = await tickEveryMinute("2026-09-25", "04:50", "05:10");
  assert.equal(dailyReminderRequests().length, 0);
  assert.deepEqual(await sendRows(r.reminderId), []);
  assert.ok(results.every((x) => x.sent === 0));

  await tickEveryMinute("2026-09-26", "05:00", "05:00");
  assert.equal(dailyReminderRequests().length, 0, "stays stopped on later days too");
});

test("B: a reminder that already sent earlier is stopped for all later days once the return is approved", { skip }, async () => {
  const r = await seedDeliveredReminder();
  await tickEveryMinute("2026-09-25", "05:00", "05:00");
  assert.equal(dailyReminderRequests().length, 1);

  at("2026-09-25 09:00");
  assert.equal((await approveViaController(r.orderId)).statusCode, 200);

  await tickEveryMinute("2026-09-26", "04:55", "05:05");
  assert.equal(dailyReminderRequests().length, 1, "no DAILY_REMINDER after approval");
});

// ── TEST D ───────────────────────────────────────────────────────────────────
test("D: STALE reminder (enabled=1, active) on an order whose return is approved → scheduler refuses before claiming, logs the block without PII", { skip }, async () => {
  for (const returnStatus of APPROVED_RETURN_STATUSES) {
    await db.query("DELETE FROM daily_reminder_sends");
    await db.query("DELETE FROM daily_reminders");
    await db.query("DELETE FROM orders");
    const r = await seedDeliveredReminder();
    // Legacy/inconsistent data: return approved but reminder never stopped.
    await db.query(`UPDATE orders SET return_status = ? WHERE id = ?`, [returnStatus, r.orderId]);
    assert.deepEqual(await reminderRow(r.reminderId), { reminder_enabled: 1, status: "active" });

    const warn = mock.method(console, "warn");
    try {
      at("2026-09-25 05:00");
      const result = await cron.runDailyReminderScheduler();
      assert.deepEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0 }, returnStatus);

      const blocked = warn.mock.calls.find(
        (c) => c.arguments[0] === "[Reminder Scheduler] Reminder blocked because order return is approved",
      );
      assert.ok(blocked, `blocked log for ${returnStatus}`);
      assert.deepEqual(blocked.arguments[1], { orderId: r.orderId, reminderId: r.reminderId, returnStatus });
      assert.doesNotMatch(JSON.stringify(warn.mock.calls.map((c) => c.arguments)), new RegExp(TEST_PHONE));
    } finally {
      warn.mock.restore();
    }

    assert.equal(dailyReminderRequests().length, 0, returnStatus);
    assert.deepEqual(await sendRows(r.reminderId), [], "no claim row is ever created");
  }
});

// ── TEST E ───────────────────────────────────────────────────────────────────
test("E: repeating the approval (sequential and concurrent double-click) → one approval, no duplicate effects", { skip }, async () => {
  const r = await seedDeliveredReminder();
  at("2026-09-25 02:00");

  const [a, b] = await Promise.all([approveViaController(r.orderId), approveViaController(r.orderId)]);
  const third = await approveViaController(r.orderId);

  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 400]);
  assert.equal(third.statusCode, 400);
  assert.equal(events.filter((e) => e === "approval_commit").length, 1);
  assert.deepEqual(await reminderRow(r.reminderId), { reminder_enabled: 0, status: "ended" });
  const { rows } = await db.query(`SELECT COUNT(*) AS n FROM daily_reminders WHERE order_id = ?`, [r.orderId]);
  assert.equal(Number(rows[0].n), 1);

  const again = await service.stopRemindersForReturnedOrder(r.orderId);
  assert.equal(again.stopped, 0);
});

// ── TEST F: the race ─────────────────────────────────────────────────────────
test("F (approval first): scheduler finds the reminder eligible while approval is uncommitted → blocks on the order lock → sees the approval → no DAILY_REMINDER", { skip }, async () => {
  const r = await seedDeliveredReminder();
  at("2026-09-25 05:00");

  const commitReached = deferred();
  const commitGate = deferred();
  const approval = approveViaController(r.orderId, {
    getClientFn: recordingGetClient({
      holdCommit: { reached: commitReached.resolve, gate: commitGate.promise },
    }),
  });
  await commitReached.promise; // T1: order row locked FOR UPDATE, return approved + reminder stopped, NOT committed

  let tickSettled = false;
  const tick = cron.runDailyReminderScheduler().finally(() => (tickSettled = true)); // T2
  let tickWasBlocked;
  let requestsWhileBlocked;
  try {
    await realSleep(400);
    tickWasBlocked = !tickSettled;
    requestsWhileBlocked = dailyReminderRequests().length;
  } finally {
    commitGate.resolve(); // T1 commits — always, so a failure can't leave the row locked
  }
  const [approvalRes, result] = await Promise.all([approval, tick]);

  assert.equal(tickWasBlocked, true, "the scheduler must be waiting on the order row lock");
  assert.equal(requestsWhileBlocked, 0);

  assert.equal(approvalRes.statusCode, 200);
  // processed:1 proves T2's eligibility query DID see the reminder as eligible.
  assert.deepEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0 });
  assert.equal(dailyReminderRequests().length, 0);
  assert.deepEqual(await sendRows(r.reminderId), []);
});

test("F (send first): approval arriving while a DAILY_REMINDER is in flight waits for it — the approval commits only after the send completed", { skip }, async () => {
  const r = await seedDeliveredReminder();
  at("2026-09-25 05:00");
  waplify.latencyMs = 700;

  const tick = cron.runDailyReminderScheduler();
  await waitFor(() => dailyReminderRequests().length === 1, "reminder request to reach WAPLIFY");

  const approvalStartedAt = performance.now();
  const approval = approveViaController(r.orderId);
  const [result, approvalRes] = await Promise.all([tick, approval]);
  const approvalMs = performance.now() - approvalStartedAt;

  assert.equal(result.sent, 1);
  assert.equal(approvalRes.statusCode, 200);
  assert.ok(approvalMs >= 300, `approval should have waited for the in-flight send (took ${approvalMs.toFixed(0)}ms)`);
  assert.ok(
    events.indexOf("waplify_response:daily_reminder") < events.indexOf("approval_commit"),
    `timeline: ${events.join(" → ")}`,
  );

  await tickEveryMinute("2026-09-25", "05:01", "05:05");
  await tickEveryMinute("2026-09-26", "05:00", "05:00");
  assert.equal(dailyReminderRequests().length, 1, "nothing after the approval committed");
});

test("F (fuzz): approval and scheduler racing with random offsets — no DAILY_REMINDER request ever starts after the approval commit", { skip }, async () => {
  for (let i = 0; i < 12; i++) {
    await db.query("DELETE FROM daily_reminder_sends");
    const r = await seedDeliveredReminder();
    events.length = 0;
    waplify.reset();
    waplify.latencyMs = 50 + ((i * 37) % 150);
    at("2026-09-25 05:00");

    const approvalDelay = (i * 23) % 120;
    const tickDelay = (i * 41) % 120;
    const [, approvalRes] = await Promise.all([
      realSleep(tickDelay).then(() => cron.runDailyReminderScheduler()),
      realSleep(approvalDelay).then(() => approveViaController(r.orderId)),
    ]);
    assert.equal(approvalRes.statusCode, 200);

    const commitIdx = events.indexOf("approval_commit");
    const lateRequests = events.slice(commitIdx).filter((e) => e === "waplify_request:daily_reminder");
    assert.deepEqual(lateRequests, [], `iteration ${i}: ${events.join(" → ")}`);
    const responseIdx = events.indexOf("waplify_response:daily_reminder");
    if (responseIdx !== -1) assert.ok(responseIdx < commitIdx, `iteration ${i}: ${events.join(" → ")}`);

    // After the commit, nothing more — ever.
    await tickEveryMinute("2026-09-25", "05:01", "05:02");
    assert.ok(dailyReminderRequests().length <= 1);
    assert.deepEqual(await reminderRow(r.reminderId), { reminder_enabled: 0, status: "ended" });
  }
});

// ── TEST I ───────────────────────────────────────────────────────────────────
test("I: reminder paused (subscription paused) → return approved → subscription resumed → reminder stays stopped, no send", { skip }, async () => {
  const r = await seedDeliveredReminder();
  await service.pauseReminderForOrder(r.orderId);
  assert.equal((await reminderRow(r.reminderId)).status, "paused");

  at("2026-09-25 02:00");
  assert.equal((await approveViaController(r.orderId)).statusCode, 200);
  assert.deepEqual(await reminderRow(r.reminderId), { reminder_enabled: 0, status: "ended" });

  const resumed = await service.resumeReminderForOrder(r.orderId);
  assert.equal(resumed.skipped, true);
  assert.deepEqual(await reminderRow(r.reminderId), { reminder_enabled: 0, status: "ended" });

  await tickEveryMinute("2026-09-25", "05:00", "05:05");
  assert.equal(dailyReminderRequests().length, 0);
});

test("I (legacy): paused reminder on an order whose return was approved before this fix → resume is refused; even a forced re-activation never sends", { skip }, async () => {
  const r = await seedDeliveredReminder();
  await service.pauseReminderForOrder(r.orderId);
  await db.query(`UPDATE orders SET return_status = 'returned' WHERE id = ?`, [r.orderId]);

  const resumed = await service.resumeReminderForOrder(r.orderId);
  assert.equal(resumed.blockedByReturn, true);
  assert.equal((await reminderRow(r.reminderId)).status, "paused");

  // Generic enableReminder bypassing resume's guard — scheduler still refuses.
  await service.enableReminder(r.reminderId);
  await tickEveryMinute("2026-09-25", "05:00", "05:05");
  assert.equal(dailyReminderRequests().length, 0);
});

// ── TEST J ───────────────────────────────────────────────────────────────────
test("J: duplicate-send protection unchanged with the guard in place — 3 concurrent ticks, slow provider → exactly one message", { skip }, async () => {
  const r = await seedDeliveredReminder();
  waplify.latencyMs = 400;
  at("2026-09-25 05:00");

  const results = await Promise.all([
    cron.runDailyReminderScheduler(),
    cron.runDailyReminderScheduler(),
    cron.runDailyReminderScheduler(),
  ]);

  assert.equal(results.reduce((n, x) => n + x.sent, 0), 1);
  assert.equal(results.reduce((n, x) => n + x.skipped, 0), 2);
  assert.equal(dailyReminderRequests().length, 1);
  assert.deepEqual(await sendRows(r.reminderId), [{ send_date: "2026-09-25", status: "success" }]);
});

test("J: 12 overlapping ticks (more than the pool could serve if each held a guard + claim connection) all complete — no pool exhaustion hang", { skip }, async () => {
  await seedDeliveredReminder();
  waplify.latencyMs = 150;
  at("2026-09-25 05:00");

  const results = await Promise.all(Array.from({ length: 12 }, () => cron.runDailyReminderScheduler()));
  assert.equal(results.reduce((n, x) => n + x.sent, 0), 1);
  assert.equal(dailyReminderRequests().length, 1);
});
