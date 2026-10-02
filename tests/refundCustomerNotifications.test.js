/**
 * Audit findings 2 + 3 — refund.failed must tell the customer (safely, once),
 * and refund.processed's "Refund Processed" must survive a failure or crash
 * after the refund state commit.
 *
 * Drives the REAL handleWebhook (signed with a test-only secret) and the REAL
 * notification path (customerOrderNotifications → claim layer → real
 * senders → fake WAPLIFY / mocked SMTP). Orders, payments, webhook_events and
 * order_status_notifications are in memory. No real DB, provider or Razorpay.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startFakeProviders } from "./fixtures/fakeNotificationProviders.js";
import { createFakeNotificationStore, notificationKey } from "./fixtures/fakeNotificationStore.js";

process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test_only_refund_notifications";

let providers;
let handleWebhook;
let notif;
let reconcile;
let closePool;

before(async () => {
  providers = await startFakeProviders();
  ({ handleWebhook } = await import("../src/controllers/paymentController.js"));
  notif = await import("../src/services/customerOrderNotifications.js");
  ({ reconcileCustomerNotifications: reconcile } = await import("../src/services/notificationReconciliation.js"));
  ({ closePool } = await import("../src/config/database.js"));
  assert.match(process.env.WAPLIFY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
});

after(async () => {
  notif.setCustomerNotificationDepsForTests({});
  await providers.stop();
  await closePool().catch(() => {});
});

beforeEach(() => providers.reset());

const ORDER_ID = "11111111-2222-4333-8444-555555555555";
const GATEWAY_ERROR = "BAD_REQUEST_ERROR: The beneficiary bank is offline (GATEWAY-INTERNAL-7731)";

const setup = ({ refundStatus = "initiated", failPaymentsUpdate = false } = {}) => {
  const store = createFakeNotificationStore({
    now: new Date(),
    orders: [
      {
        id: ORDER_ID,
        order_number: "BREE-100020",
        order_status: "delivered",
        payment_status: "paid",
        razorpay_payment_id: "pay_abc123",
        refund_status: refundStatus,
        refund_reference: "rfnd_test1",
        refund_amount: 499,
        contact_name: "Asha Rao",
        contact_email: "asha@example.com",
        contact_phone: "9876500011",
        user_id: "user-1",
      },
    ],
  });
  notif.setCustomerNotificationDepsForTests({ queryExecutor: store.queryFn });
  const ledger = new Map();
  const history = [];

  const queryFn = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("INSERT INTO webhook_events")) {
      const [, provider, eventId] = params;
      const key = `${provider}:${eventId}`;
      if (ledger.has(key)) throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
      ledger.set(key, "processing");
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("SELECT status FROM webhook_events")) {
      const status = ledger.get(`${params[0]}:${params[1]}`);
      return { rows: status ? [{ status }] : [] };
    }
    if (q.startsWith("UPDATE webhook_events SET status = 'processing'")) {
      const key = `${params[0]}:${params[1]}`;
      if (ledger.get(key) !== "failed") return { rows: [], rowCount: 0 };
      ledger.set(key, "processing");
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE webhook_events SET status = 'completed'")) {
      ledger.set(`${params[0]}:${params[1]}`, "completed");
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE webhook_events SET status = 'failed'")) {
      ledger.set(`${params[1]}:${params[2]}`, "failed");
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("SELECT * FROM orders WHERE refund_reference = ?")) {
      const rows = [...store.orders.values()].filter((o) => o.refund_reference === params[0]);
      return { rows: rows.map((o) => ({ ...o })) };
    }
    if (q.startsWith("UPDATE orders SET refund_status = 'completed'")) {
      const o = store.orders.get(params[1]);
      if (!["initiated", "processing"].includes(o.refund_status)) return { rows: [], rowCount: 0 };
      Object.assign(o, { refund_status: "completed", payment_status: "refunded", refund_completed_at: new Date(store.now) });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE orders SET refund_status = 'failed'")) {
      const o = store.orders.get(params[1]);
      if (!["initiated", "processing"].includes(o.refund_status)) return { rows: [], rowCount: 0 };
      Object.assign(o, { refund_status: "failed", updated_at: new Date(store.now) });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE payments")) {
      if (failPaymentsUpdate) throw new Error("Lock wait timeout exceeded (simulated)");
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE orders SET refund_gateway_status")) return { rows: [], rowCount: 1 };
    if (q.startsWith("INSERT INTO order_status_history")) {
      history.push(params[3]);
      return { rows: [], rowCount: 1 };
    }
    return store.queryFn(sql, params);
  };

  return { store, queryFn, history, ledger, order: () => store.orders.get(ORDER_ID) };
};

const signed = (event, entity) => {
  const payload = { event, payload: { refund: { entity } }, created_at: entity.created_at || 1 };
  const rawBody = JSON.stringify(payload);
  return {
    headers: {
      "x-razorpay-signature": crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex"),
    },
    rawBody,
    body: payload,
    app: {},
  };
};
const res = () => ({
  statusCode: 200,
  status(c) {
    this.statusCode = c;
    return this;
  },
  json(b) {
    this.body = b;
    return this;
  },
});
const refundFailed = (extra = {}) =>
  signed("refund.failed", {
    id: "rfnd_test1",
    payment_id: "pay_abc123",
    status: "failed",
    error_description: GATEWAY_ERROR,
    acquirer_data: { rrn: "RRN-INTERNAL-5521" },
    notes: { order_id: ORDER_ID },
    ...extra,
  });
const refundProcessed = (extra = {}) =>
  signed("refund.processed", {
    id: "rfnd_test1",
    payment_id: "pay_abc123",
    status: "processed",
    acquirer_data: { rrn: "RRN-INTERNAL-5521" },
    notes: { order_id: ORDER_ID },
    ...extra,
  });

const settle = () => new Promise((r) => setTimeout(r, 150));
const internalValues = ["rfnd_test1", "RRN-INTERNAL-5521", "pay_abc123", "GATEWAY-INTERNAL-7731", "beneficiary bank"];
const assertSafe = () => {
  const content = providers.allCustomerContent();
  for (const value of internalValues) assert.ok(!content.includes(value), `leaked ${value}`);
};

// ── J. Refund Failed ─────────────────────────────────────────────────────────

test("J. refund.failed → exactly one WhatsApp and one email, with safe generic copy only", async () => {
  const db = setup();
  const r = res();
  await handleWebhook(refundFailed(), r, { queryFn: db.queryFn });
  await settle();

  assert.equal(r.statusCode, 200);
  assert.equal(db.order().refund_status, "failed");
  assert.equal(providers.whatsapp.length, 1);
  assert.equal(providers.emails.length, 1);
  assert.deepEqual(providers.whatsapp[0].body_data, {
    1: "Asha Rao",
    2: "BREE-100020",
    3: "Refund Update",
    4: "Your refund could not be completed at this time. Please contact BREE Support for assistance.",
  });
  assert.equal(providers.emails[0].subject, "Refund Update — #BREE-100020");
  assert.match(
    providers.emails[0].html,
    /Your refund could not be completed at this time\. Please contact BREE Support for assistance\./,
  );
  assertSafe();
  // Detailed failure stays in admin history.
  assert.ok(db.history.some((h) => /rfnd_test1 FAILED/.test(h)));
  assert.equal(db.store.status(notificationKey(ORDER_ID, "refund_failed", "whatsapp")), "sent");
  assert.equal(db.store.status(notificationKey(ORDER_ID, "refund_failed", "email")), "sent");
});

test("J. duplicate refund.failed (same delivery, and a distinct re-send) → no duplicate customer message", async () => {
  const db = setup();
  await handleWebhook(refundFailed(), res(), { queryFn: db.queryFn });
  await settle();
  await handleWebhook(refundFailed(), res(), { queryFn: db.queryFn }); // ledger duplicate
  await handleWebhook(refundFailed({ created_at: 99 }), res(), { queryFn: db.queryFn }); // new payload, guarded UPDATE
  await settle();
  assert.equal(providers.whatsapp.length, 1);
  assert.equal(providers.emails.length, 1);
});

test("J. a failing Refund Failed notification never alters the refund state", async () => {
  const db = setup();
  providers.whatsappModes = ["400"];
  providers.emailModes = ["fail_5xx"];
  const r = res();
  await handleWebhook(refundFailed(), r, { queryFn: db.queryFn });
  await settle();
  assert.equal(r.statusCode, 200);
  assert.equal(db.order().refund_status, "failed");
  assert.equal(db.order().payment_status, "paid");
  assert.equal(db.store.status(notificationKey(ORDER_ID, "refund_failed", "whatsapp")), "failed");
});

// ── I. Refund Processed ──────────────────────────────────────────────────────

test("I. refund.processed → exactly one 'Refund Processed' WhatsApp and email; no refund id / RRN shown", async () => {
  const db = setup();
  await handleWebhook(refundProcessed(), res(), { queryFn: db.queryFn });
  await settle();
  assert.equal(db.order().refund_status, "completed");
  assert.equal(providers.whatsapp.length, 1);
  assert.equal(providers.emails.length, 1);
  assert.equal(providers.whatsapp[0].body_data[3], "Refund Processed");
  assert.equal(providers.whatsapp[0].body_data[4], "Your refund has been processed. It may take a few business days to reflect in your account, depending on your bank.");
  assertSafe();
});

test("I. duplicate refund.processed → no duplicate notification", async () => {
  const db = setup();
  await handleWebhook(refundProcessed(), res(), { queryFn: db.queryFn });
  await handleWebhook(refundProcessed(), res(), { queryFn: db.queryFn });
  await handleWebhook(refundProcessed({ created_at: 42 }), res(), { queryFn: db.queryFn });
  await settle();
  assert.equal(providers.whatsapp.length, 1);
  assert.equal(providers.emails.length, 1);
});

test("I. a WhatsApp send whose outcome is unknown (5xx after acceptance) leaves the refund completed and is never re-sent", async () => {
  const db = setup();
  providers.whatsappModes = ["500_after", "ok"];
  await handleWebhook(refundProcessed(), res(), { queryFn: db.queryFn });
  await settle();
  assert.equal(db.order().refund_status, "completed");
  assert.equal(db.store.status(notificationKey(ORDER_ID, "refund_completed", "whatsapp")), "unknown");

  db.store.advance(60 * 60 * 1000);
  await reconcile({ queryFn: db.store.queryFn });
  await settle();
  assert.equal(providers.whatsapp.length, 1, "the one possibly-delivered message only — no duplicate");
});

test("I. bookkeeping failing AFTER the refund state commit no longer loses 'Refund Processed'; Razorpay's redelivery does not duplicate it", async () => {
  const db = setup({ failPaymentsUpdate: true });
  await assert.rejects(handleWebhook(refundProcessed(), res(), { queryFn: db.queryFn }), /Lock wait timeout/);
  await settle();
  assert.equal(db.order().refund_status, "completed", "the refund state commit is never rolled back by notification handling");
  assert.equal(providers.whatsapp.length, 1);
  assert.equal(providers.emails.length, 1);
  assert.equal(db.ledger.get(`razorpay:${crypto.createHash("sha256").update(refundProcessed().rawBody).digest("hex")}`), "failed");

  // Razorpay redelivers the failed event: the refund is already completed,
  // so the guarded UPDATE matches nothing and nothing is re-sent.
  await handleWebhook(refundProcessed(), res(), { queryFn: db.queryFn }).catch(() => {});
  await settle();
  assert.equal(providers.whatsapp.length, 1);
  assert.equal(providers.emails.length, 1);
});

test("I. process dies after the refund commit (notification never claimed) → the reconciler recovers it exactly once, even with two workers", async () => {
  const db = setup();
  // Simulates the crash: state committed, notification call never happened.
  await handleWebhook(refundProcessed(), res(), { queryFn: db.queryFn, notifyRefundEvent: () => {} });
  assert.equal(db.order().refund_status, "completed");
  assert.equal(db.store.notifications.size, 0, "no notification row exists after the crash");

  // Within the grace period the reconciler leaves it to the live path.
  await reconcile({ queryFn: db.store.queryFn });
  assert.equal(providers.whatsapp.length, 0);

  db.store.advance(5 * 60 * 1000);
  const [a, b] = await Promise.all([
    reconcile({ queryFn: db.store.queryFn }),
    reconcile({ queryFn: db.store.queryFn }),
  ]);
  assert.equal(a.recovered + b.recovered, 2, "one email + one WhatsApp, recovered by exactly one worker each");
  assert.equal(providers.whatsapp.length, 1);
  assert.equal(providers.emails.length, 1);
  assert.equal(providers.whatsapp[0].body_data[3], "Refund Processed");

  // Later runs never send it again.
  db.store.advance(30 * 60 * 1000);
  await reconcile({ queryFn: db.store.queryFn });
  assert.equal(providers.whatsapp.length, 1);
  assert.equal(providers.emails.length, 1);
});

test("I. a completed refund older than the recovery lookback is never notified retroactively", async () => {
  const db = setup();
  await handleWebhook(refundProcessed(), res(), { queryFn: db.queryFn, notifyRefundEvent: () => {} });
  db.store.advance(73 * 60 * 60 * 1000);
  await reconcile({ queryFn: db.store.queryFn, lookbackHours: 72 });
  assert.equal(providers.whatsappRequests, 0);
  assert.equal(providers.emails.length, 0);
});
