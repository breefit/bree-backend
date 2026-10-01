/**
 * Audit finding 4 — failed/unknown notifications were terminal.
 *
 * Exercises the REAL claim layer (sendOrderStatusNotificationOnce), the REAL
 * customer delivery path and the REAL reconciler against an in-memory
 * order_status_notifications with a controllable NOW(). Provider responses
 * come from the real senders talking to a fake WAPLIFY / mocked SMTP.
 *
 * Policy under test:
 *   provably not accepted (SMTP 4xx, WAPLIFY 429 / no connection) → retried
 *     with backoff, max NOTIFICATION_MAX_ATTEMPTS, same notification key;
 *   permanent (SMTP 5xx, other 4xx, config)                        → never retried;
 *   unknown (timeout / 5xx after send / stale 'sending')           → never re-sent.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeProviders } from "./fixtures/fakeNotificationProviders.js";
import { createFakeNotificationStore, notificationKey } from "./fixtures/fakeNotificationStore.js";

let providers;
let rc;
let notif;
let recon;
let osn;
let email;
let cronMod;
let closePool;

before(async () => {
  providers = await startFakeProviders();
  rc = await import("../src/controllers/admin/returnController.js");
  notif = await import("../src/services/customerOrderNotifications.js");
  recon = await import("../src/services/notificationReconciliation.js");
  osn = await import("../src/services/orderStatusNotificationService.js");
  email = await import("../src/services/orderEmailService.js");
  cronMod = await import("../cron/notificationReconciliationCron.js");
  ({ closePool } = await import("../src/config/database.js"));
});

after(async () => {
  notif.setCustomerNotificationDepsForTests({});
  await providers.stop();
  await closePool().catch(() => {});
});

beforeEach(() => providers.reset());

const MIN = 60 * 1000;
let seq = 0;
const setup = (overrides = {}) => {
  const order = {
    id: `aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    order_number: `BREE-2000${seq}`,
    order_status: "delivered",
    refund_status: "completed",
    refund_completed_at: new Date("2026-10-01T09:00:00Z"),
    contact_name: "Asha Rao",
    contact_email: "asha@example.com",
    contact_phone: "9876500011",
    ...overrides,
  };
  const store = createFakeNotificationStore({ orders: [order] });
  notif.setCustomerNotificationDepsForTests({ queryExecutor: store.queryFn });
  const key = (slug, channel) => notificationKey(order.id, slug, channel);
  const run = () => recon.reconcileCustomerNotifications({ queryFn: store.queryFn });
  return { order, store, key, run };
};

test("failed (SMTP 4xx — provably not accepted) is retried after backoff under the SAME key, then sent once", async () => {
  const { order, store, key, run } = setup();
  providers.emailModes = ["fail_4xx", "ok"];
  await rc.notifyReturnEvent(order, "Refund Completed");

  const row = store.notifications.get(key("refund_completed", "email"));
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.equal(row.next_retry_at.getTime() - store.now.getTime(), 5 * MIN, "first retry after 5 minutes");

  await run();
  assert.equal(providers.emails.length, 0, "not due yet — no retry storm");

  store.advance(5 * MIN);
  const summary = await run();
  assert.equal(summary.retried, 1);
  assert.equal(providers.emails.length, 1);
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 2);
  assert.equal(row.next_retry_at, null);
  assert.equal(store.notifications.size, 2, "still exactly one logical row per channel");

  store.advance(60 * MIN);
  await run();
  assert.equal(providers.emails.length, 1, "never sent again");
});

test("backoff doubles and stops at the maximum attempt count", async () => {
  const { order, store, key, run } = setup();
  providers.emailModes = ["fail_4xx"];
  await rc.notifyReturnEvent(order, "Refund Completed");
  const row = store.notifications.get(key("refund_completed", "email"));

  const gaps = [];
  while (row.next_retry_at) {
    gaps.push((row.next_retry_at.getTime() - store.now.getTime()) / MIN);
    store.advance(row.next_retry_at.getTime() - store.now.getTime());
    await run();
  }
  assert.deepEqual(gaps, [5, 10, 20, 40]);
  assert.equal(row.attempts, osn.NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(row.status, "failed");

  store.advance(24 * 60 * MIN);
  await run();
  assert.equal(row.attempts, osn.NOTIFICATION_MAX_ATTEMPTS, "no further attempts after the cap");
});

test("permanent failure (SMTP 5xx) is never retried", async () => {
  const { order, store, key, run } = setup();
  providers.emailModes = ["fail_5xx", "ok"];
  await rc.notifyReturnEvent(order, "Refund Completed");
  const row = store.notifications.get(key("refund_completed", "email"));
  assert.equal(row.status, "failed");
  assert.equal(row.next_retry_at, null);
  store.advance(24 * 60 * MIN);
  await run();
  assert.equal(providers.emails.length, 0);
  assert.equal(row.attempts, 1);
});

test("permanent WhatsApp rejection (HTTP 400) is never retried", async () => {
  const { order, store, key, run } = setup();
  providers.whatsappModes = ["400", "ok"];
  await rc.notifyReturnEvent(order, "Refund Completed");
  const row = store.notifications.get(key("refund_completed", "whatsapp"));
  assert.equal(row.status, "failed");
  assert.equal(row.next_retry_at, null);
  store.advance(24 * 60 * MIN);
  await run();
  assert.equal(providers.whatsapp.length, 0);
});

test("unknown outcome (SMTP timeout; WAPLIFY 5xx after acceptance) is never re-sent, and is reported", async () => {
  const { order, store, key, run } = setup();
  providers.emailModes = ["timeout", "ok"];
  providers.whatsappModes = ["500_after", "ok"];
  await rc.notifyReturnEvent(order, "Refund Completed");
  assert.equal(store.status(key("refund_completed", "email")), "unknown");
  assert.equal(store.status(key("refund_completed", "whatsapp")), "unknown");

  store.advance(24 * 60 * MIN);
  const summary = await run();
  assert.equal(summary.unknown, 2);
  assert.equal(providers.emails.length, 0);
  assert.equal(providers.whatsapp.length, 1, "only the copy WAPLIFY may already have delivered");
  assert.equal(providers.whatsappRequests, 1);
});

test("stale 'sending' claim (process died mid-send) is marked unknown and NOT re-sent — not by the reconciler, not by a later live call", async () => {
  const { order, store, key, run } = setup();
  const k = key("refund_completed", "whatsapp");
  store.notifications.set(k, {
    notification_key: k,
    status: "sending",
    attempts: 1,
    last_attempt_at: new Date(store.now),
    next_retry_at: null,
  });

  store.advance(6 * MIN);
  await rc.notifyReturnEvent(order, "Refund Completed"); // live re-trigger after 6 minutes
  assert.equal(providers.whatsapp.length, 0, "customer events never reclaim a stale 'sending' row");

  store.advance(10 * MIN);
  const summary = await run();
  assert.equal(summary.staleMarkedUnknown, 1);
  assert.equal(store.status(k), "unknown");
  assert.equal(providers.whatsapp.length, 0);
});

test("two reconciler workers (two Hostinger processes) racing on the same due retry send it exactly once", async () => {
  const { order, store, key, run } = setup();
  providers.emailModes = ["fail_4xx", "ok"];
  await rc.notifyReturnEvent(order, "Refund Completed");
  store.advance(5 * MIN);

  const [a, b, c] = await Promise.all([run(), run(), run()]);
  assert.equal(a.retried + b.retried + c.retried, 1);
  assert.equal(providers.emails.length, 1);
  assert.equal(store.notifications.get(key("refund_completed", "email")).attempts, 2);
});

test("a retry for an event the order has moved past is dropped, not sent (no stale 'Refund Initiated' after completion)", async () => {
  const { order, store, key, run } = setup({ refund_status: "initiated" });
  providers.emailModes = ["fail_4xx", "ok"];
  await rc.notifyReturnEvent(order, "Refund Initiated");
  store.orders.get(order.id).refund_status = "completed";
  store.advance(5 * MIN);

  const summary = await run();
  assert.equal(summary.superseded, 1);
  const row = store.notifications.get(key("refund_initiated", "email"));
  assert.equal(row.next_retry_at, null);
  assert.match(row.last_error, /superseded/);
  assert.ok(
    !providers.emails.some((m) => /Refund Initiated/.test(m.subject)),
    "the stale 'Refund Initiated' is never sent",
  );
  // (The completed refund's own missing "Refund Completed" is recovered.)
  assert.deepEqual(providers.emails.map((m) => m.subject), [`Order Status Updated — Refund Completed (#${order.order_number})`]);
});

test("admin double-click / duplicate trigger of the same event sends one message per channel", async () => {
  const { order } = setup({ return_status: "approved" });
  await Promise.all([rc.notifyReturnEvent(order, "Return Approved"), rc.notifyReturnEvent(order, "Return Approved")]);
  await rc.notifyReturnEvent(order, "Return Approved");
  assert.equal(providers.emails.length, 1);
  assert.equal(providers.whatsapp.length, 1);
});

test("duplicate cron execution: a tick that cannot take the MySQL lock does nothing", async () => {
  let reconciled = 0;
  const reconcile = async () => {
    reconciled++;
  };
  const locked = await cronMod.runNotificationReconciliationTick({
    runWithLock: async () => ({ ran: false, reason: "lock_held_elsewhere" }),
    reconcile,
  });
  assert.equal(locked.ran, false);
  assert.equal(reconciled, 0);

  // And with the real runWithCronLock against a client whose GET_LOCK says 0.
  const { runWithCronLock } = await import("../src/utils/cronLock.js");
  const result = await runWithCronLock("bree_notification_reconciliation_cron", reconcile, {
    getClientFn: async () => ({
      query: async () => ({ rows: [{ acquired: 0 }] }),
      release() {},
    }),
  });
  assert.equal(result.ran, false);
  assert.equal(reconciled, 0);
});

test("forward-order notifications keep their old semantics: no retry scheduling and stale-claim reclaim unchanged", async () => {
  const store = createFakeNotificationStore();
  const k = "order:fwd-1:status:processing:channel:email";
  await assert.rejects(
    osn.sendOrderStatusNotificationOnce({
      notificationKey: k,
      queryExecutor: store.queryFn,
      send: async () => {
        throw Object.assign(new Error("451"), { deliveryOutcome: "failed", retryable: true });
      },
    }),
  );
  assert.equal(store.notifications.get(k).next_retry_at, null);
  assert.ok(!store.statements.some((s) => s.includes("SET next_retry_at = CASE")));
});

test("classifyEmailError: 4xx / never-connected retryable, 5xx / auth permanent, timeout / reset unknown", () => {
  const c = email.classifyEmailError;
  assert.deepEqual(c({ responseCode: 451 }), { outcome: "failed", retryable: true });
  assert.deepEqual(c({ responseCode: 550 }), { outcome: "failed", retryable: false });
  assert.deepEqual(c({ code: "EAUTH", responseCode: 535 }), { outcome: "failed", retryable: false });
  assert.deepEqual(c({ code: "ESOCKET", message: "connect ECONNREFUSED 1.2.3.4:465" }), { outcome: "failed", retryable: true });
  assert.deepEqual(c({ code: "EDNS" }), { outcome: "failed", retryable: true });
  assert.deepEqual(c({ code: "ETIMEDOUT" }), { outcome: "unknown", retryable: false });
  assert.deepEqual(c({ code: "ECONNRESET" }), { outcome: "unknown", retryable: false });
  assert.deepEqual(c(new Error("template bug")), { outcome: "failed", retryable: false });
});

test("parseNotificationKey only accepts the canonical key shape", () => {
  assert.deepEqual(recon.parseNotificationKey("order:abc-1:status:refund_completed:channel:email"), {
    orderId: "abc-1",
    slug: "refund_completed",
    channel: "email",
  });
  assert.equal(recon.parseNotificationKey("subscription:x:payment.failed"), null);
  assert.equal(recon.parseNotificationKey("order:a:status:b:channel:sms"), null);
});
