/**
 * WhatsApp retry idempotency (FIX: WhatsApp retry idempotency audit).
 *
 * Waplify's send API (POST /api/v1/messages/send, docs.waplify.io) has no
 * idempotency key, client reference or dedupe, and no endpoint to look a
 * message up afterwards. So exactly-once delivery is impossible; the
 * guarantee is instead: a request is only re-sent automatically when it
 * provably was not accepted, and an uncertain outcome is recorded as
 * 'unknown' and never re-sent by any claim layer.
 *
 * A–F drive the REAL sendTemplateMessage over HTTP against a fake Waplify
 * server on 127.0.0.1 that can "accept" a message (record it as delivered
 * to the customer) and THEN fail — exactly the dangerous case. `accepted`
 * counts messages the customer would receive; `requests` counts POSTs.
 *
 * G–I run the REAL claim layers (order_status_notifications,
 * subscription_email_notifications, daily_reminder_sends) against a real
 * throwaway MySQL (TEST_DATABASE_URL — never production); skipped without it.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL?.trim());
const dbSkip = HAS_TEST_DB ? false : "TEST_DATABASE_URL not configured — claim-layer tests need a real (non-production) MySQL";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake Waplify ─────────────────────────────────────────────────────────────
// mode per request (queue; the last one repeats):
//   ok | 400 | 500_before | 500_after | timeout_before | timeout_after | reset_after | 429
const waplify = { requests: 0, accepted: [], modes: ["ok"] };
const nextMode = () => (waplify.modes.length > 1 ? waplify.modes.shift() : waplify.modes[0]);
const HANG_MS = 700;

let server;
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      waplify.requests += 1;
      const mode = nextMode();
      const accept = () => waplify.accepted.push(JSON.parse(body || "{}"));
      const send = (status, json, headers = {}) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(json));
      };
      switch (mode) {
        case "ok":
          accept();
          return send(200, { status: "success", message_id: `wamid.${waplify.accepted.length}` });
        case "400":
          return send(400, { status: "error", message: "Template not approved" });
        case "429":
          return send(429, { status: "error", message: "Rate limit exceeded" }, { "retry-after": "0" });
        case "500_before":
          return send(500, { status: "error", message: "internal" });
        case "500_after":
          accept();
          return send(502, { status: "error", message: "bad gateway" });
        case "timeout_before":
          await sleep(HANG_MS);
          return send(500, { status: "error" });
        case "timeout_after":
          accept();
          await sleep(HANG_MS);
          return send(200, { status: "success" });
        case "reset_after":
          accept();
          return req.socket.destroy();
        default:
          return send(500, {});
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    WAPLIFY_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    WAPLIFY_API_KEY: "wapl_test_only_key",
    WAPLIFY_REQUEST_TIMEOUT_MS: "250",
    WAPLIFY_TEMPLATE_ORDER_STATUS: "order_status_test",
    WAPLIFY_TEMPLATE_SUBSCRIPTION_STATUS: "subscription_status_test",
    WAPLIFY_TEMPLATE_DAILY_REMINDER: "daily_reminder_test",
  });
  wa = await import("../src/services/whatsappNotificationService.js");
  assert.match(process.env.WAPLIFY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
});
after(async () => {
  if (db) await db.closePool();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  waplify.requests = 0;
  waplify.accepted = [];
  waplify.modes = ["ok"];
});

let wa;
const send = () =>
  wa.sendTemplateMessage({ mobile: "9876500011", templateName: "order_status_test", parameters: ["Asha", "BREE-1"] });
const outcomeOf = async () => {
  try {
    await send();
    return "sent";
  } catch (error) {
    return error.deliveryOutcome || "no-outcome";
  }
};

// ════════════════════════════════════════════════════════════════════════════
// Sender (no DB)
// ════════════════════════════════════════════════════════════════════════════
test("A. HTTP 200 → sent, one request, one message", async () => {
  assert.equal(await outcomeOf(), "sent");
  assert.equal(waplify.requests, 1);
  assert.equal(waplify.accepted.length, 1);
});

test("B. HTTP 400 → known failure ('failed'), not retried, nothing delivered", async () => {
  waplify.modes = ["400"];
  assert.equal(await outcomeOf(), "failed");
  assert.equal(waplify.requests, 1);
  assert.equal(waplify.accepted.length, 0);
});

test("C. HTTP 500 before acceptance → 'unknown', NOT retried (the client cannot tell C from D)", async () => {
  waplify.modes = ["500_before", "ok"];
  assert.equal(await outcomeOf(), "unknown");
  assert.equal(waplify.requests, 1, "no automatic re-POST");
  assert.equal(waplify.accepted.length, 0);
});

test("D. HTTP 5xx AFTER Waplify accepted → 'unknown', NOT retried → the customer gets exactly one message (was: up to 4)", async () => {
  waplify.modes = ["500_after", "ok"];
  assert.equal(await outcomeOf(), "unknown");
  assert.equal(waplify.requests, 1);
  assert.equal(waplify.accepted.length, 1, "exactly one message — no duplicate");
});

test("E. timeout before acceptance → 'unknown', NOT retried", async () => {
  waplify.modes = ["timeout_before", "ok"];
  assert.equal(await outcomeOf(), "unknown");
  assert.equal(waplify.requests, 1);
  assert.equal(waplify.accepted.length, 0);
});

test("F. timeout AFTER acceptance → 'unknown', NOT retried → exactly one message", async () => {
  waplify.modes = ["timeout_after", "ok"];
  assert.equal(await outcomeOf(), "unknown");
  await sleep(HANG_MS);
  assert.equal(waplify.requests, 1);
  assert.equal(waplify.accepted.length, 1);
});

test("F2. connection reset AFTER acceptance → 'unknown', NOT retried → exactly one message", async () => {
  waplify.modes = ["reset_after", "ok"];
  assert.equal(await outcomeOf(), "unknown");
  assert.equal(waplify.requests, 1);
  assert.equal(waplify.accepted.length, 1);
});

test("429 (documented rate-limit rejection) is still retried — provably not accepted — and delivers once", async () => {
  waplify.modes = ["429", "ok"];
  assert.equal(await outcomeOf(), "sent");
  assert.equal(waplify.requests, 2);
  assert.equal(waplify.accepted.length, 1);
});

test("classifier: connection never established (ECONNREFUSED/DNS) is retry-safe; reset/timeout/5xx are unknown; 4xx failed", () => {
  const c = wa.classifyWaplifyError;
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
    assert.deepEqual(c({ code }), { retrySafe: true, outcome: "failed" }, code);
  }
  for (const code of ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EPIPE", undefined]) {
    assert.deepEqual(c({ code }), { retrySafe: false, outcome: "unknown" }, String(code));
  }
  for (const status of [500, 502, 503, 504]) {
    assert.deepEqual(c({ response: { status } }), { retrySafe: false, outcome: "unknown" }, String(status));
  }
  for (const status of [400, 401, 403, 404]) {
    assert.deepEqual(c({ response: { status } }), { retrySafe: false, outcome: "failed" }, String(status));
  }
  assert.deepEqual(c({ response: { status: 429 } }), { retrySafe: true, outcome: "failed" });
});

// ════════════════════════════════════════════════════════════════════════════
// Claim layers (real MySQL)
// ════════════════════════════════════════════════════════════════════════════
let db;
let orderNotif;
let subNotif;
let reminderCron;
const ensureDb = async () => {
  if (db) return;
  db = await import("../src/config/database.js");
  orderNotif = await import("../src/services/orderStatusNotificationService.js");
  subNotif = await import("../src/services/subscriptionEmailNotificationService.js");
  reminderCron = await import("../cron/dailyReminderCron.js");
  // Same shape as mysql-schema.sql (created here too so this file is self-contained).
  await db.query(`CREATE TABLE IF NOT EXISTS subscription_email_notifications (
    notification_key VARCHAR(255) NOT NULL PRIMARY KEY, status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0, last_attempt_at DATETIME NULL, sent_at DATETIME NULL,
    last_error VARCHAR(1000) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
};
const orderRow = async (key) =>
  (await db.query(`SELECT status, attempts FROM order_status_notifications WHERE notification_key = ?`, [key])).rows[0];
const subRow = async (key) =>
  (await db.query(`SELECT status, attempts FROM subscription_email_notifications WHERE notification_key = ?`, [key])).rows[0];

const sendOrderStatusOnce = (key, extra = {}) =>
  orderNotif
    .sendOrderStatusNotificationOnce({
      notificationKey: key,
      send: () =>
        wa.sendOrderStatusUpdateWhatsApp({
          customerName: "Asha",
          mobile: "9876500011",
          orderNumber: "BREE-100900",
          status: "delivered",
        }),
      ...extra,
    })
    .then((r) => (r.sent ? "sent" : r.duplicate ? "duplicate_skipped" : "other"))
    .catch((e) => `threw:${e.deliveryOutcome || "failed"}`);

test("I. duplicate admin request: uncertain first send → row 'unknown', attempts 1; repeat clicks (and even retryFailed) send nothing more", { skip: dbSkip }, async () => {
  await ensureDb();
  const key = `order:${randomUUID()}:status:delivered:channel:whatsapp`;
  waplify.modes = ["500_after", "ok"];

  assert.equal(await sendOrderStatusOnce(key), "threw:unknown");
  assert.deepEqual({ ...(await orderRow(key)) }, { status: "unknown", attempts: 1 });

  const repeats = await Promise.all([sendOrderStatusOnce(key), sendOrderStatusOnce(key), sendOrderStatusOnce(key, { retryFailed: true })]);
  assert.deepEqual(repeats, ["duplicate_skipped", "duplicate_skipped", "duplicate_skipped"]);
  assert.deepEqual({ ...(await orderRow(key)) }, { status: "unknown", attempts: 1 });
  assert.equal(waplify.requests, 1);
  assert.equal(waplify.accepted.length, 1, "the customer received exactly one message");
});

test("I (contrast). a KNOWN failure (400) is 'failed' and an explicit retryFailed re-send is safe and happens exactly once", { skip: dbSkip }, async () => {
  await ensureDb();
  const key = `order:${randomUUID()}:status:delivered:channel:whatsapp`;
  waplify.modes = ["400", "ok"];
  assert.equal(await sendOrderStatusOnce(key), "threw:failed");
  assert.deepEqual({ ...(await orderRow(key)) }, { status: "failed", attempts: 1 });
  assert.equal(await sendOrderStatusOnce(key), "duplicate_skipped", "no implicit retry");
  const retried = await Promise.all([sendOrderStatusOnce(key, { retryFailed: true }), sendOrderStatusOnce(key, { retryFailed: true })]);
  assert.deepEqual(retried.sort(), ["duplicate_skipped", "sent"]);
  assert.deepEqual({ ...(await orderRow(key)) }, { status: "sent", attempts: 2 });
  assert.equal(waplify.accepted.length, 1);
});

test("H. duplicate webhook: two concurrent deliveries of the same subscription event + a later redelivery, first send times out after acceptance → one message, row 'unknown'", { skip: dbSkip }, async () => {
  await ensureDb();
  const key = `subscription:sub_${randomUUID().slice(0, 8)}:paused:whatsapp`;
  waplify.modes = ["timeout_after", "ok"];
  const deliver = (extra = {}) =>
    subNotif
      .sendSubscriptionNotificationOnce({
        notificationKey: key,
        send: () =>
          wa.sendSubscriptionStatusWhatsApp({ customerName: "Asha", mobile: "9876500011", planName: "Daily", status: "paused" }),
        ...extra,
      })
      .then((r) => (r.sent ? "sent" : "duplicate_skipped"))
      .catch((e) => `threw:${e.deliveryOutcome || "failed"}`);

  const results = await Promise.all([deliver(), deliver()]);
  assert.deepEqual(results.sort(), ["duplicate_skipped", "threw:unknown"]);
  await sleep(HANG_MS);
  assert.equal(await deliver({ retryFailed: true }), "duplicate_skipped");
  assert.deepEqual({ ...(await subRow(key)) }, { status: "unknown", attempts: 1 });
  assert.equal(waplify.requests, 1);
  assert.equal(waplify.accepted.length, 1);
});

test("G. duplicate scheduler: two reminder ticks race, the send 5xx's after acceptance → 'unknown'; the next minute's tick does NOT re-send (a 'failed' one still would)", { skip: dbSkip }, async () => {
  await ensureDb();
  const orderId = randomUUID();
  await db.query(
    `INSERT INTO orders (id, order_number, order_status, payment_status, total) VALUES (?, ?, 'delivered', 'paid', 100)`,
    [orderId, `WA-${orderId.slice(0, 8)}`],
  );
  const makeReminder = async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO daily_reminders (id, order_id, product_id, reminder_price_paid, status) VALUES (?, ?, ?, 49, 'active')`,
      [id, orderId, randomUUID()],
    );
    return id;
  };
  const today = "2026-09-28";
  // One scheduler tick for one reminder, exactly as runDailyReminderScheduler does it.
  const tick = async (reminderId) => {
    const { claimed } = await reminderCron.claimReminderSendSlot(reminderId, today);
    if (!claimed) return "duplicate_skipped";
    const { success, error } = await wa.safelySendWhatsApp("daily-reminder", () =>
      wa.sendDailyWellnessReminder({ mobile: "9876500011", customerName: "Asha" }),
    );
    if (success) {
      await reminderCron.resolveReminderSendSuccess(reminderId, today, "wamid");
      return "sent";
    }
    await reminderCron.resolveReminderSendFailure(reminderId, today, error.message, undefined, {
      deliveryOutcome: error.deliveryOutcome,
    });
    return `failed:${error.deliveryOutcome}`;
  };
  const slot = async (reminderId) =>
    (await db.query(`SELECT status FROM daily_reminder_sends WHERE reminder_id = ? AND send_date = ?`, [reminderId, today])).rows[0]
      ?.status;

  const uncertain = await makeReminder();
  waplify.modes = ["500_after", "ok"];
  const first = await Promise.all([tick(uncertain), tick(uncertain)]);
  assert.deepEqual(first.sort(), ["duplicate_skipped", "failed:unknown"]);
  assert.equal(await slot(uncertain), "unknown");
  assert.equal(await tick(uncertain), "duplicate_skipped", "next minute's tick does not re-send");
  assert.equal(waplify.accepted.length, 1);

  const known = await makeReminder();
  waplify.modes = ["400", "ok"];
  assert.equal(await tick(known), "failed:failed");
  assert.equal(await slot(known), "failed");
  assert.equal(await tick(known), "sent", "a known failure is still retried on the next tick (unchanged)");
  assert.equal(await tick(known), "duplicate_skipped");
  assert.equal(waplify.requests, 3, "uncertain ×1, known failure ×1, its safe retry ×1 — nothing else");
  assert.equal(waplify.accepted.length, 2);
});

test("sent-but-not-recorded: provider accepted, then recording 'sent' fails → never turned into a retryable 'failed'", { skip: dbSkip }, async () => {
  await ensureDb();
  const key = `order:${randomUUID()}:status:delivered:channel:whatsapp`;
  let failSentWrite = true;
  const queryExecutor = async (sql, params) => {
    if (failSentWrite && /SET status = 'sent'/.test(sql)) throw new Error("DB connection lost");
    return db.query(sql, params);
  };
  const result = await orderNotif.sendOrderStatusNotificationOnce({
    notificationKey: key,
    queryExecutor,
    send: () => wa.sendOrderStatusUpdateWhatsApp({ customerName: "Asha", mobile: "9876500011", orderNumber: "BREE-1", status: "delivered" }),
  });
  assert.deepEqual(result, { sent: true, duplicate: false, recorded: false });
  assert.equal((await orderRow(key)).status, "sending", "left for the staleness window — not 'failed'");
  failSentWrite = false;
  assert.equal(await sendOrderStatusOnce(key, { retryFailed: true }), "duplicate_skipped");
  assert.equal(waplify.accepted.length, 1);
});
