/**
 * End-to-end reproduction of the Sep 25 2026 missed daily reminder
 * (order 24bbb460-…, reminder e38b2323-…) — see
 * docs/DAILY_REMINDER_END_TO_END_DEBUG_REPORT.md.
 *
 * Exercises the REAL code path end to end, nothing re-implemented:
 *   activateReminderFromDelivery → runDailyReminderScheduler →
 *   getEligibleReminders SQL → isWithinReminderTimeWindow →
 *   claimReminderSendSlot (INSERT IGNORE + conditional UPDATE) →
 *   sendDailyWellnessReminder → axios → HTTP POST /api/v1/messages/send →
 *   resolveReminderSendSuccess / resolveReminderSendFailure
 *
 * against:
 *   - a real MySQL test database (TEST_DATABASE_URL — never production;
 *     database.js hard-aborts if it equals DATABASE_URL), created from the
 *     production tables' own SHOW CREATE TABLE output so the
 *     unique_reminder_send(reminder_id, send_date) constraint is the real one;
 *   - a fake WAPLIFY HTTP server on 127.0.0.1 (WAPLIFY_BASE_URL/API_KEY are
 *     overridden BEFORE the WhatsApp module is imported, so no request can
 *     ever reach the real provider and the real API key is never used);
 *   - a controlled clock (node:test mock timers, Date only — real
 *     setTimeout so mysql2/axios keep working).
 *
 * Skipped (not failed) when TEST_DATABASE_URL is not configured, matching
 * this repo's rule that tests never fall back to the production database.
 */
import test, { before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL?.trim());
const skip = HAS_TEST_DB
  ? false
  : "TEST_DATABASE_URL not configured — end-to-end reminder tests need a real (non-production) MySQL";

const FAKE_API_KEY = "test-fake-waplify-key";
const REMINDER_TIME = "05:00";
const TEST_PHONE = "9876500001"; // synthetic, not a customer

// ── Fake WAPLIFY ─────────────────────────────────────────────────────────────
const waplify = {
  requests: [],
  status: 200,
  latencyMs: 0,
  retryAfter: null,
  reset() {
    this.requests = [];
    this.status = 200;
    this.latencyMs = 0;
    this.retryAfter = null;
  },
};

let server;
let db; // { query, closePool }
let cron; // dailyReminderCron exports
let service; // dailyReminderService exports

before(async () => {
  if (!HAS_TEST_DB) return;

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      waplify.requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(body || "{}"),
      });
      if (waplify.latencyMs) {
        await new Promise((r) => setTimeout(r, waplify.latencyMs));
      }
      const status = waplify.status;
      const headers = { "Content-Type": "application/json" };
      if (waplify.retryAfter !== null) headers["Retry-After"] = String(waplify.retryAfter);
      res.writeHead(status, headers);
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

  // Must be set before the WhatsApp module is first imported (it reads
  // these at module load). dotenv never overrides an already-set var.
  process.env.WAPLIFY_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.WAPLIFY_API_KEY = FAKE_API_KEY;
  process.env.WAPLIFY_TEMPLATE_DAILY_REMINDER = "daily_reminder";

  db = await import("../src/config/database.js");
  cron = await import("../cron/dailyReminderCron.js");
  service = await import("../src/services/dailyReminderService.js");

  // Belt and braces: the fake must be what the client is actually wired to.
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
/** Pins Date to an IST wall-clock time, e.g. at("2026-09-25 05:00"). */
const at = (istWallClock) => {
  const ms = Date.parse(`${istWallClock.replace(" ", "T")}:00+05:30`);
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: ms });
};

/** Customer + delivered-pending order + purchased reminder, via the real service. */
const seedReminder = async ({ reminderTime = REMINDER_TIME } = {}) => {
  const userId = randomUUID();
  const orderId = randomUUID();
  await db.query(`INSERT INTO users (id, name, phone) VALUES (?, ?, ?)`, [
    userId,
    "Test Customer",
    TEST_PHONE,
  ]);
  await db.query(
    `INSERT INTO orders (id, user_id, order_status, awb_number) VALUES (?, ?, 'shipped', 'TESTAWB1')`,
    [orderId, userId],
  );
  const { reminderId } = await service.createDailyReminder({
    userId,
    orderId,
    productId: randomUUID(),
    reminderTime,
    reminderPricePaid: 9,
    reminderOriginalPrice: 59,
  });
  return { userId, orderId, reminderId };
};

/**
 * Delivery detected by shippingTrackingCron at the current (mocked) time.
 * Uses the exact deliveryDate expression shippingTrackingCron.js passes
 * (`new Date().toISOString().split("T")[0]`) and stamps delivered_at the
 * way its UPDATE does.
 */
const deliverNow = async ({ orderId, reminderId }) => {
  await db.query(
    `UPDATE orders SET order_status = 'delivered', tracking_status = 'Delivered', delivered_at = UTC_TIMESTAMP() WHERE id = ?`,
    [orderId],
  );
  const result = await service.activateReminderFromDelivery({
    reminderId,
    deliveryDate: new Date().toISOString().split("T")[0],
  });
  assert.equal(result.success, true, result.error);
  return result;
};

const sends = async (reminderId) =>
  (
    await db.query(
      `SELECT DATE_FORMAT(send_date, '%Y-%m-%d') AS send_date, status, waplify_message_id, error_message
       FROM daily_reminder_sends WHERE reminder_id = ? ORDER BY send_date`,
      [reminderId],
    )
  ).rows;

/** Runs one scheduler tick per IST minute in [from, to] on the same day. */
const tickEveryMinute = async (day, fromHHMM, toHHMM) => {
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const results = [];
  for (let m = toMin(fromHHMM); m <= toMin(toHHMM); m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    at(`${day} ${hh}:${mm}`);
    results.push(await cron.runDailyReminderScheduler());
  }
  return results;
};

// ── The incident, reproduced ─────────────────────────────────────────────────
test("INCIDENT REPRO: delivered Sep 24 13:30 IST, no scheduler alive 04:55–05:05 IST Sep 25, process starts 09:22 → reminder is lost for the day with NO send record and NO WAPLIFY call", { skip }, async () => {
  const r = await seedReminder();

  at("2026-09-24 13:30"); // delivered_at 2026-09-24 08:00:00 UTC in production
  const activation = await deliverNow(r);
  assert.equal(activation.startDate, "2026-09-25");
  assert.equal(activation.endDate, "2026-10-24"); // matches the live log window

  // Production process (re)started 09:22:15 IST; first tick 09:23.
  const results = await tickEveryMinute("2026-09-25", "09:23", "09:40");

  assert.deepEqual(results[0], { processed: 1, sent: 0, skipped: 1, failed: 0 }); // == live log
  assert.equal(waplify.requests.length, 0);
  assert.deepEqual(await sends(r.reminderId), []); // == production: zero rows
});

test("same reminder, same data: had ANY scheduler tick run between 05:00 and 05:05 IST on Sep 25, it would have been claimed and sent exactly once", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  const results = await tickEveryMinute("2026-09-25", "04:50", "05:10");

  const sentTicks = results.filter((x) => x.sent === 1);
  assert.equal(sentTicks.length, 1);
  // 05:00 — the configured minute. The window no longer opens early (it
  // used to send at 04:55, the first tick of a symmetric ±5 window).
  assert.equal(results.find((x) => x.sent === 1), results[10]);
  assert.equal(waplify.requests.length, 1);
  assert.deepEqual(await sends(r.reminderId), [
    { send_date: "2026-09-25", status: "success", waplify_message_id: "wamid-1", error_message: null },
  ]);
});

test("window edges: a process that only comes up at 05:05 still sends; one that comes up at 05:06 has lost the day (no catch-up)", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  await tickEveryMinute("2026-09-25", "05:06", "05:30");
  assert.equal(waplify.requests.length, 0);
  assert.deepEqual(await sends(r.reminderId), []);

  await tickEveryMinute("2026-09-26", "05:05", "05:10");
  assert.equal(waplify.requests.length, 1);
  assert.deepEqual((await sends(r.reminderId)).map((s) => [s.send_date, s.status]), [
    ["2026-09-26", "success"],
  ]);
});

// ── Scenarios A–F ────────────────────────────────────────────────────────────
test("Scenario A: delivered BEFORE the configured time on the same day → documented rule is next calendar day (no same-day send)", { skip }, async () => {
  // Latest allowed reminder time is 06:00; deliveries detected after 05:30
  // IST fall on the same UTC date, so this exercises the documented rule.
  const r = await seedReminder({ reminderTime: "06:00" });
  at("2026-09-24 05:45");
  const activation = await deliverNow(r);
  assert.equal(activation.startDate, "2026-09-25");

  await tickEveryMinute("2026-09-24", "05:55", "06:05");
  assert.equal(waplify.requests.length, 0);

  await tickEveryMinute("2026-09-25", "05:55", "06:05");
  assert.equal(waplify.requests.length, 1);
});

test("Scenario A (characterization, latent — NOT the Sep 25 cause): delivery detected 00:00–05:29 IST is dated by its UTC date, so the reminder starts the SAME day", { skip }, async () => {
  const r = await seedReminder({ reminderTime: "05:00" });
  at("2026-09-24 04:30"); // = 2026-09-23T23:00Z
  const activation = await deliverNow(r);
  assert.equal(activation.deliveryDate, "2026-09-23");
  assert.equal(activation.startDate, "2026-09-24");

  await tickEveryMinute("2026-09-24", "04:58", "05:02");
  assert.equal(waplify.requests.length, 1);
});

test("Scenario B: delivered AFTER the configured time → first send is the next day at the configured time", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  await tickEveryMinute("2026-09-24", "13:31", "13:35");
  at("2026-09-24 23:59");
  await cron.runDailyReminderScheduler();
  assert.equal(waplify.requests.length, 0);

  at("2026-09-25 05:00");
  const result = await cron.runDailyReminderScheduler();
  assert.equal(result.sent, 1);
  assert.equal(waplify.requests.length, 1);
});

test("Scenario C: at the configured time the claim succeeds and WAPLIFY is called exactly once with the daily_reminder payload", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  await tickEveryMinute("2026-09-25", "05:00", "05:05");

  assert.equal(waplify.requests.length, 1);
  const [reqSeen] = waplify.requests;
  assert.equal(reqSeen.method, "POST");
  assert.equal(reqSeen.url, "/api/v1/messages/send");
  assert.equal(reqSeen.authorization, `Bearer ${FAKE_API_KEY}`);
  assert.equal(reqSeen.body.template_name, "daily_reminder");
  assert.equal(reqSeen.body.contact_phone, `91${TEST_PHONE}`);
  assert.equal(reqSeen.body.contact_name, "Test Customer");
});

test("Scenario D: WAPLIFY 200 → send row is 'success' with the provider message id, and is never re-sent that day", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  await tickEveryMinute("2026-09-25", "05:00", "05:05");
  await tickEveryMinute("2026-09-25", "05:00", "05:00"); // e.g. a restart replaying 05:00

  assert.equal(waplify.requests.length, 1);
  assert.deepEqual(await sends(r.reminderId), [
    { send_date: "2026-09-25", status: "success", waplify_message_id: "wamid-1", error_message: null },
  ]);
});

test("Scenario E: WAPLIFY failure → 'failed' recorded; the next in-window tick retries and succeeds; nothing retries after the window", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  waplify.status = 400; // non-retryable inside sendTemplateMessage
  at("2026-09-25 05:00");
  const first = await cron.runDailyReminderScheduler();
  assert.deepEqual(first, { processed: 1, sent: 0, skipped: 0, failed: 1 });
  const [failedRow] = await sends(r.reminderId);
  assert.equal(failedRow.status, "failed");
  assert.match(failedRow.error_message, /400/);

  waplify.status = 200;
  at("2026-09-25 05:01");
  const second = await cron.runDailyReminderScheduler();
  assert.equal(second.sent, 1);
  assert.equal((await sends(r.reminderId))[0].status, "success");
  assert.equal(waplify.requests.length, 2);
});

test("Scenario E (after window): a failure on the last in-window tick stays 'failed' — no out-of-window retry that day, next day unaffected", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  waplify.status = 400;
  await tickEveryMinute("2026-09-25", "05:05", "05:05");
  waplify.status = 200;
  await tickEveryMinute("2026-09-25", "05:06", "05:15");
  assert.deepEqual((await sends(r.reminderId)).map((s) => s.status), ["failed"]);

  await tickEveryMinute("2026-09-26", "05:00", "05:00");
  assert.deepEqual((await sends(r.reminderId)).map((s) => [s.send_date, s.status]), [
    ["2026-09-25", "failed"],
    ["2026-09-26", "success"],
  ]);
});

test("Scenario E (retryable): WAPLIFY 503 is retried inside the same send and succeeds without a duplicate row", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  let calls = 0;
  const origStatus = Object.getOwnPropertyDescriptor(waplify, "status");
  Object.defineProperty(waplify, "status", {
    configurable: true,
    get: () => (++calls === 1 ? 503 : 200),
    set: () => {},
  });
  waplify.retryAfter = 0;
  try {
    at("2026-09-25 05:00");
    const result = await cron.runDailyReminderScheduler();
    assert.equal(result.sent, 1);
  } finally {
    Object.defineProperty(waplify, "status", origStatus);
  }
  assert.equal(waplify.requests.length, 2); // 503 then 200
  assert.deepEqual((await sends(r.reminderId)).map((s) => s.status), ["success"]);
});

test("Scenario F: three scheduler processes ticking at the same instant (slow provider) → exactly one WhatsApp message", { skip }, async () => {
  const r = await seedReminder();
  at("2026-09-24 13:30");
  await deliverNow(r);

  waplify.latencyMs = 400;
  at("2026-09-25 05:00");
  const results = await Promise.all([
    cron.runDailyReminderScheduler(),
    cron.runDailyReminderScheduler(),
    cron.runDailyReminderScheduler(),
  ]);

  assert.equal(results.reduce((n, x) => n + x.sent, 0), 1);
  assert.equal(results.reduce((n, x) => n + x.skipped, 0), 2);
  assert.equal(waplify.requests.length, 1);
  assert.deepEqual((await sends(r.reminderId)).map((s) => s.status), ["success"]);
});
