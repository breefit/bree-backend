/**
 * Daily reminder timing + multi-instance safety — end to end.
 *
 * Production evidence (2026-09-26): a 05:00 reminder was claimed and sent at
 * 04:55 IST (first tick of the old symmetric ±5-minute window), and two
 * backend processes (…:454332, …:929397) were both ticking — one CLAIMED,
 * the other DUPLICATE_SKIPPED.
 *
 * Exercises the REAL path: runDailyReminderScheduler → getEligibleReminders
 * → isWithinReminderTimeWindow → acquireReminderSendGuard →
 * claimReminderSendSlot → sendDailyWellnessReminder → axios → HTTP, against:
 *   - a real MySQL test database (TEST_DATABASE_URL — never production);
 *   - a fake WAPLIFY HTTP server on 127.0.0.1 (the real provider can never
 *     be reached; the fixture process refuses a non-local base URL);
 *   - a controlled clock (node:test mock timers, Date only);
 *   - for the multi-instance tests, TWO SEPARATE OS PROCESSES
 *     (tests/fixtures/runReminderTickProcess.mjs) — separate PIDs, memory
 *     and DB pools, exactly like two Hostinger/PM2 processes.
 *
 * Skipped (not failed) when TEST_DATABASE_URL is not configured.
 */
import test, { before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL?.trim());
const skip = HAS_TEST_DB
  ? false
  : "TEST_DATABASE_URL not configured — reminder timing end-to-end tests need a real (non-production) MySQL";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "runReminderTickProcess.mjs");
const FAKE_API_KEY = "test-fake-waplify-key";
const TEST_PHONE = "9876500003"; // synthetic, not a customer

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
const reminderRequests = () => waplify.requests.filter((r) => r.body.template_name === "daily_reminder");

let server;
let db;
let cron;
let service;

before(async () => {
  if (!HAS_TEST_DB) return;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      waplify.requests.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
      if (waplify.latencyMs) await new Promise((r) => setTimeout(r, waplify.latencyMs));
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
  await db.query("DELETE FROM daily_reminder_sends");
  await db.query("DELETE FROM daily_reminders");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM users");
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const istMs = (istWallClock) => Date.parse(`${istWallClock.replace(" ", "T")}:00+05:30`);
const at = (istWallClock) => {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: istMs(istWallClock) });
};
const realNow = () => performance.timeOrigin + performance.now();

/** Reminder 05:00, delivered 2026-09-24 13:30 IST → window starts 2026-09-25 (same shape as the production reminder). */
const seedReminder = async ({ reminderTime = "05:00" } = {}) => {
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
  assert.equal(activation.startDate, "2026-09-25");
  return { orderId, reminderId };
};

const sendRows = async (reminderId) =>
  (
    await db.query(
      `SELECT DATE_FORMAT(send_date, '%Y-%m-%d') AS send_date, status FROM daily_reminder_sends WHERE reminder_id = ?`,
      [reminderId],
    )
  ).rows;

/** One tick per IST minute; returns [{ minute, result, logs }] with the tick's console lines. */
const tickEachMinute = async (day, minutes) => {
  const out = [];
  for (const minute of minutes) {
    at(`${day} ${minute}`);
    const logs = [];
    const capture = (...args) => logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    const info = mock.method(console, "info", capture);
    const log = mock.method(console, "log", capture);
    try {
      out.push({ minute, result: await cron.runDailyReminderScheduler(), logs });
    } finally {
      info.mock.restore();
      log.mock.restore();
    }
  }
  return out;
};

/** Spawns one separate Node process that runs a single scheduler tick at `tickAtMs`. */
const spawnTickProcess = ({ tickAtMs, startAtMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        TICK_AT_MS: String(tickAtMs),
        START_AT_MS: String(startAtMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killTimer);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
      if (code !== 0 || !line) {
        reject(new Error(`tick process exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve({ pid: child.pid, result: JSON.parse(line.slice(7)), stdout });
    });
  });

const MINUTES_0450_TO_0510 = Array.from({ length: 21 }, (_, i) => {
  const m = 4 * 60 + 50 + i;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});

// ── Tests 1–6: exact send minute on a real tick sequence ────────────────────
test("1–6: reminder 05:00, ticks every minute 04:50–05:10 → nothing before 05:00, ONE send at the 05:00 tick, then already_sent_today", { skip }, async () => {
  const r = await seedReminder();
  const ticks = await tickEachMinute("2026-09-25", MINUTES_0450_TO_0510);
  const byMinute = Object.fromEntries(ticks.map((t) => [t.minute, t]));

  for (const minute of ["04:50", "04:54", "04:55", "04:59"]) {
    assert.deepEqual(byMinute[minute].result, { processed: 1, sent: 0, skipped: 1, failed: 0 }, minute);
    assert.ok(byMinute[minute].logs.some((l) => l.includes("outside time window (not_yet_due)")), minute);
    assert.ok(!byMinute[minute].logs.some((l) => l.includes("[DAILY_REMINDER] CLAIMED")), minute);
  }

  assert.deepEqual(byMinute["05:00"].result, { processed: 1, sent: 1, skipped: 0, failed: 0 });
  assert.ok(byMinute["05:00"].logs.some((l) => l.includes("[DAILY_REMINDER] CLAIMED")));

  for (const minute of ["05:01", "05:02", "05:05", "05:10"]) {
    assert.deepEqual(byMinute[minute].result, { processed: 0, sent: 0, skipped: 0, failed: 0 }, minute);
    assert.ok(byMinute[minute].logs.some((l) => l.includes("reason=already_sent_today")), minute);
  }

  const sentAt = ticks.filter((t) => t.result.sent === 1).map((t) => t.minute);
  assert.deepEqual(sentAt, ["05:00"]);
  assert.equal(reminderRequests().length, 1);
  assert.equal(reminderRequests()[0].method, "POST");
  assert.equal(reminderRequests()[0].url, "/api/v1/messages/send");
  assert.deepEqual(await sendRows(r.reminderId), [{ send_date: "2026-09-25", status: "success" }]);
});

test("5: late-tick policy — a process whose first tick is 05:03 still sends once; one first ticking at 05:06 does not (unchanged)", { skip }, async () => {
  const r = await seedReminder();
  await tickEachMinute("2026-09-25", ["05:03", "05:04"]);
  assert.equal(reminderRequests().length, 1);

  await tickEachMinute("2026-09-26", ["05:06", "05:07"]);
  assert.equal(reminderRequests().length, 1, "no send after the late window on the next day");
  assert.deepEqual((await sendRows(r.reminderId)).map((s) => s.send_date), ["2026-09-25"]);
});

test("5: a failed send at 05:00 is retried on the 05:01 tick (existing retry behavior, now only forward in time)", { skip }, async () => {
  const r = await seedReminder();
  waplify.status = 400;
  await tickEachMinute("2026-09-25", ["05:00"]);
  assert.deepEqual(await sendRows(r.reminderId), [{ send_date: "2026-09-25", status: "failed" }]);

  waplify.status = 200;
  const [retry] = await tickEachMinute("2026-09-25", ["05:01"]);
  assert.equal(retry.result.sent, 1);
  assert.deepEqual(await sendRows(r.reminderId), [{ send_date: "2026-09-25", status: "success" }]);
  assert.equal(reminderRequests().length, 2);
});

test("7: IST date boundary — 05:00 IST Sep 25 is Sep 24 in UTC; the send is recorded for IST 2026-09-25 and the day before is not touched", { skip }, async () => {
  const r = await seedReminder();
  // 2026-09-24 23:30Z == 2026-09-25 05:00 IST
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-24T23:30:00Z") });
  const result = await cron.runDailyReminderScheduler();
  assert.equal(result.sent, 1);
  assert.deepEqual(await sendRows(r.reminderId), [{ send_date: "2026-09-25", status: "success" }]);

  // 05:00 IST on Sep 24 (before the reminder window starts) never sends.
  await db.query("DELETE FROM daily_reminder_sends");
  waplify.reset();
  await tickEachMinute("2026-09-24", ["05:00"]);
  assert.equal(reminderRequests().length, 0);
});

// ── Tests 13–17: two real OS processes ──────────────────────────────────────
test("13–17: TWO separate OS processes tick at 05:00 at the same instant, slow WAPLIFY → exactly one CLAIMED, the other DUPLICATE_SKIPPED, exactly one WAPLIFY request", { skip }, async () => {
  const r = await seedReminder();
  waplify.latencyMs = 800; // the first send is still in flight when the second process tries to claim

  const startAtMs = realNow() + 2500; // both processes have loaded before this real instant
  const tickAtMs = istMs("2026-09-25 05:00");
  const [a, b] = await Promise.all([
    spawnTickProcess({ tickAtMs, startAtMs }),
    spawnTickProcess({ tickAtMs, startAtMs }),
  ]);

  assert.notEqual(a.pid, b.pid);
  assert.equal(a.result.sent + b.result.sent, 1);
  assert.equal(a.result.skipped + b.result.skipped, 1);

  const all = [a, b];
  const claimed = all.filter((p) => p.stdout.includes("[DAILY_REMINDER] CLAIMED"));
  const duplicate = all.filter((p) => p.stdout.includes("[DAILY_REMINDER] DUPLICATE_SKIPPED"));
  assert.equal(claimed.length, 1);
  assert.equal(duplicate.length, 1);
  assert.notEqual(claimed[0].pid, duplicate[0].pid);
  for (const p of all) {
    assert.ok(p.stdout.includes(`instance=`) && p.stdout.includes(`:${p.pid}`), "each process logs its own host:pid");
  }

  assert.equal(reminderRequests().length, 1);
  assert.deepEqual(await sendRows(r.reminderId), [{ send_date: "2026-09-25", status: "success" }]);
});

test("13: TWO separate OS processes ticking at 04:55 → neither sends (the early window is gone in every instance)", { skip }, async () => {
  const r = await seedReminder();
  const startAtMs = realNow() + 2500;
  const tickAtMs = istMs("2026-09-25 04:55");
  const results = await Promise.all([
    spawnTickProcess({ tickAtMs, startAtMs }),
    spawnTickProcess({ tickAtMs, startAtMs }),
  ]);
  assert.deepEqual(results.map((p) => p.result.sent), [0, 0]);
  assert.equal(reminderRequests().length, 0);
  assert.deepEqual(await sendRows(r.reminderId), []);
});

test("16: two processes, every minute 04:58–05:02 → one message total, sent in the 05:00 minute", { skip }, async () => {
  const r = await seedReminder();
  waplify.latencyMs = 200;
  const sentAt = [];
  for (const minute of ["04:58", "04:59", "05:00", "05:01", "05:02"]) {
    const startAtMs = realNow() + 2000;
    const tickAtMs = istMs(`2026-09-25 ${minute}`);
    const [a, b] = await Promise.all([
      spawnTickProcess({ tickAtMs, startAtMs }),
      spawnTickProcess({ tickAtMs, startAtMs }),
    ]);
    if (a.result.sent + b.result.sent > 0) sentAt.push([minute, a.result.sent + b.result.sent]);
  }
  assert.deepEqual(sentAt, [["05:00", 1]]);
  assert.equal(reminderRequests().length, 1);
  assert.deepEqual(await sendRows(r.reminderId), [{ send_date: "2026-09-25", status: "success" }]);
});

// ── send_date = the IST calendar date of the tick (not UTC, not the window) ─
// send_date is runDailyReminderScheduler's `today` = getISTClock().date for
// the tick instant, bound as a 'YYYY-MM-DD' string into a DATE column (no
// timezone conversion applies to a string DATE value).
const storedSendDates = async (reminderId) =>
  (
    await db.query(
      `SELECT CAST(send_date AS CHAR) AS send_date, status FROM daily_reminder_sends WHERE reminder_id = ? ORDER BY send_date`,
      [reminderId],
    )
  ).rows.map((r) => [r.send_date, r.status]);

// Window set directly (2026-09-25 .. 2026-10-24) so these tests isolate
// send_date from activateReminderFromDelivery's own date math.
const seedActiveReminder = async () => {
  const userId = randomUUID();
  const orderId = randomUUID();
  await db.query(`INSERT INTO users (id, name, phone) VALUES (?, ?, ?)`, [userId, "Test Customer", TEST_PHONE]);
  await db.query(`INSERT INTO orders (id, user_id, order_status) VALUES (?, ?, 'delivered')`, [orderId, userId]);
  const { reminderId } = await service.createDailyReminder({
    userId,
    orderId,
    productId: randomUUID(),
    reminderTime: "05:00",
    reminderPricePaid: 9,
    reminderOriginalPrice: 59,
  });
  await db.query(
    `UPDATE daily_reminders SET delivery_date = '2026-09-24', reminder_start_date = '2026-09-25', reminder_end_date = '2026-10-24' WHERE id = ?`,
    [reminderId],
  );
  return { orderId, reminderId };
};

const tickAtInstant = async (isoInstant) => {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: Date.parse(isoInstant) });
  return cron.runDailyReminderScheduler();
};

test("send_date: a send at exactly 2026-09-26 05:00 IST (= 2026-09-25T23:30Z) is stored as 2026-09-26, not the UTC date 2026-09-25", { skip }, async () => {
  const r = await seedActiveReminder(); // window 2026-09-25 .. 2026-10-24

  assert.equal((await tickAtInstant("2026-09-25T23:29:59.999Z")).sent, 0, "04:59:59.999 IST is not due");
  assert.equal((await tickAtInstant("2026-09-25T23:30:00.000Z")).sent, 1, "05:00:00.000 IST sends");
  assert.deepEqual(await storedSendDates(r.reminderId), [["2026-09-26", "success"]]);

  // The rest of the 05:00 minute and 05:01 see the same IST date → already sent.
  assert.equal((await tickAtInstant("2026-09-25T23:30:59.999Z")).sent, 0);
  assert.equal((await tickAtInstant("2026-09-25T23:31:00.000Z")).processed, 0);
  assert.equal(reminderRequests().length, 1);

  // Next IST day gets its own row.
  assert.equal((await tickAtInstant("2026-09-26T23:30:00.000Z")).sent, 1);
  assert.deepEqual(await storedSendDates(r.reminderId), [
    ["2026-09-26", "success"],
    ["2026-09-27", "success"],
  ]);
});

test("send_date around IST midnight: a 23:59 send stays on its own day; a 00:00 send is the new day; neither leaks into the other", { skip }, async () => {
  // Allowed purchase times are 04:00–06:00; midnight times are forced here
  // directly to prove the date logic itself, not the purchase validation.
  const late = await seedActiveReminder();
  await db.query(`UPDATE daily_reminders SET reminder_time = '23:59' WHERE id = ?`, [late.reminderId]);

  assert.equal((await tickAtInstant("2026-09-25T18:29:00Z")).sent, 1); // 2026-09-25 23:59 IST
  assert.equal((await tickAtInstant("2026-09-25T18:30:00Z")).sent, 0); // 2026-09-26 00:00 IST — no wrap, no send for 09-26
  assert.equal((await tickAtInstant("2026-09-25T18:34:00Z")).sent, 0); // 00:04 IST
  assert.deepEqual(await storedSendDates(late.reminderId), [["2026-09-25", "success"]]);

  await db.query("DELETE FROM daily_reminder_sends");
  await db.query("DELETE FROM daily_reminders");
  waplify.reset();

  const early = await seedActiveReminder();
  await db.query(`UPDATE daily_reminders SET reminder_time = '00:00' WHERE id = ?`, [early.reminderId]);

  assert.equal((await tickAtInstant("2026-09-25T18:29:59Z")).sent, 0); // 2026-09-25 23:59:59 IST — never early
  assert.equal((await tickAtInstant("2026-09-25T18:30:00Z")).sent, 1); // 2026-09-26 00:00 IST
  assert.equal((await tickAtInstant("2026-09-25T18:31:00Z")).processed, 0); // 00:01 — already sent for 09-26
  assert.deepEqual(await storedSendDates(early.reminderId), [["2026-09-26", "success"]]);
  assert.equal(reminderRequests().length, 1);
});
