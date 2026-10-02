/**
 * Every BREE Razorpay refund source tells the customer the same thing:
 *   Refund Initiated  →  Refund Processed
 * and never "Refund Completed" — Razorpay's refund.processed means Razorpay
 * processed the refund; the bank credit can take longer.
 *
 * Both sources share one Razorpay call (returnController.completeRefund) and
 * one webhook handler (paymentController.handleWebhook). This drives each
 * flow end to end through the REAL controllers, webhook and customer
 * notification path, with:
 *   - orders/payments/webhook ledger: tests/fixtures/fakeRefundBackend.js
 *   - Razorpay: fake (no network)
 *   - order_status_notifications: in-memory claim table
 *   - WhatsApp: real sender → fake WAPLIFY on 127.0.0.1; email: mocked SMTP
 *
 *   A. Cancel Order & Refund            → Cancelled, Refund Initiated, Refund Processed
 *   B. Return → QC approved → refund    → Refund Initiated, Refund Processed
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startFakeProviders } from "./fixtures/fakeNotificationProviders.js";
import { createFakeNotificationStore } from "./fixtures/fakeNotificationStore.js";
import { createFakeDb, createFakeRazorpay } from "./fixtures/fakeRefundBackend.js";

process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test_only_both_flows";
process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";

let providers;
let cancelOrderAndRefund;
let approveRefund;
let completeRefund;
let handleWebhook;
let reconcileOrderRefund;
let notif;
let closePool;

before(async () => {
  providers = await startFakeProviders();
  ({ cancelOrderAndRefund } = await import("../src/controllers/admin/orderCancellationController.js"));
  ({ approveRefund, completeRefund } = await import("../src/controllers/admin/returnController.js"));
  ({ handleWebhook } = await import("../src/controllers/paymentController.js"));
  ({ reconcileOrderRefund } = await import("../cron/refundReconciliationCron.js"));
  notif = await import("../src/services/customerOrderNotifications.js");
  ({ closePool } = await import("../src/config/database.js"));
  assert.match(process.env.WAPLIFY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
});

after(async () => {
  notif.setCustomerNotificationDepsForTests({});
  await providers.stop();
  await closePool().catch(() => {});
});

beforeEach(() => {
  providers.reset();
  notif.setCustomerNotificationDepsForTests({ queryExecutor: createFakeNotificationStore().queryFn });
});

const PROCESSED_MESSAGE =
  "Your refund has been processed. It may take a few business days to reflect in your account, depending on your bank.";

const CUSTOMER = {
  contact_name: "Asha Rao",
  contact_email: "asha@example.com",
  contact_phone: "9876500011",
};

const baseOrder = (id, overrides) => ({
  id,
  order_number: `BREE-${id.slice(-6)}`,
  payment_status: "paid",
  razorpay_payment_id: "pay_1",
  razorpay_order_id: "order_rzp_1",
  is_subscription: 0,
  razorpay_subscription_id: null,
  total: 500,
  amount: 500,
  awb_number: null,
  tracking_status: null,
  return_status: null,
  refund_status: null,
  refund_amount: null,
  refund_reference: null,
  updated_at: new Date(),
  ...CUSTOMER,
  ...overrides,
});

const basePayment = (orderId) => ({
  id: `payment-${orderId}`,
  order_id: orderId,
  razorpay_order_id: "order_rzp_1",
  razorpay_payment_id: "pay_1",
  amount: 500,
  status: "captured",
  refund_id: null,
  refund_amount: null,
});

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

const processedWebhook = (orderId, refundId, extra = {}) => {
  const payload = {
    event: "refund.processed",
    payload: {
      refund: {
        entity: {
          id: refundId,
          payment_id: "pay_1",
          status: "processed",
          notes: { order_id: orderId },
          acquirer_data: { rrn: "627320498946" },
          ...extra,
        },
      },
    },
  };
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

const waitFor = async (predicate, label) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 150));

const whatsappLabels = () => providers.whatsapp.map((m) => m.body_data[3]);
const emailSubjects = () => providers.emails.map((m) => m.subject);
const assertNeverRefundCompleted = () => {
  const content = providers.allCustomerContent();
  assert.doesNotMatch(content, /Refund Completed/i);
  assert.doesNotMatch(content, /completed successfully/i);
  // Internal identifiers stay internal.
  assert.doesNotMatch(content, /rfnd_|627320498946|pay_1/);
};

// ── A. Cancel Order & Refund ────────────────────────────────────────────────

const setupCancel = () => {
  const id = "order-cancel-flow-000001";
  const db = createFakeDb({ order: baseOrder(id, { order_status: "processing" }), payment: basePayment(id) });
  const razorpay = createFakeRazorpay();
  const deps = { getClientFn: db.getClientFn, queryFn: db.queryFn, getRazorpayFn: razorpay.getRazorpayFn };
  const cancel = async () => {
    const res = makeRes();
    await cancelOrderAndRefund({ params: { orderId: id }, body: {}, app: {} }, res, deps);
    return res;
  };
  return { id, db, razorpay, deps, cancel };
};

test("A. Cancel Order & Refund → customer gets Cancelled, Refund Initiated, then Refund Processed (never 'Refund Completed')", async () => {
  const { id, db, cancel } = setupCancel();
  const res = await cancel();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(db.orders.get(id).refund_status, "initiated");
  await waitFor(() => providers.whatsapp.length === 2 && providers.emails.length === 2, "cancel + initiated");
  assert.deepEqual(whatsappLabels(), ["Cancelled", "Refund Initiated"]);

  await handleWebhook(processedWebhook(id, "rfnd_1"), makeRes(), { queryFn: db.queryFn });
  await waitFor(() => providers.whatsapp.length === 3 && providers.emails.length === 3, "processed");

  assert.equal(db.orders.get(id).refund_status, "completed", "internal state machine unchanged");
  assert.deepEqual(whatsappLabels(), ["Cancelled", "Refund Initiated", "Refund Processed"]);
  assert.equal(providers.whatsapp[2].body_data[4], PROCESSED_MESSAGE);
  assert.equal(emailSubjects()[2], `Order Status Updated — Refund Processed (#${db.orders.get(id).order_number})`);
  assert.match(providers.emails[2].html, /Your refund has been processed\./);
  assertNeverRefundCompleted();
});

test("A. Cancel Order & Refund: duplicate refund.processed (same delivery and a distinct re-delivery) → still one Refund Processed per channel", async () => {
  const { id, db, cancel } = setupCancel();
  await cancel();
  await handleWebhook(processedWebhook(id, "rfnd_1"), makeRes(), { queryFn: db.queryFn });
  const dup = makeRes();
  await handleWebhook(processedWebhook(id, "rfnd_1"), dup, { queryFn: db.queryFn });
  await handleWebhook(processedWebhook(id, "rfnd_1", { created_at: 2 }), makeRes(), { queryFn: db.queryFn });
  await settle();

  assert.equal(dup.body.duplicate, true);
  assert.equal(whatsappLabels().filter((l) => l === "Refund Processed").length, 1);
  assert.equal(emailSubjects().filter((s) => /Refund Processed/.test(s)).length, 1);
  assert.equal(providers.whatsapp.length, 3);
  assert.equal(providers.emails.length, 3);
  assertNeverRefundCompleted();
});

// ── B. Return → QC → refund ─────────────────────────────────────────────────

const setupReturn = () => {
  const id = "order-return-flow-000002";
  const db = createFakeDb({
    order: baseOrder(id, {
      order_status: "delivered",
      return_status: "returned",
      inspection_status: "approved",
    }),
    payment: basePayment(id),
  });
  const razorpay = createFakeRazorpay();
  const deps = { getClientFn: db.getClientFn, queryFn: db.queryFn, getRazorpayFn: razorpay.getRazorpayFn };
  const approveAndInitiate = async () => {
    const approved = makeRes();
    await approveRefund({ params: { orderId: id }, body: {}, app: {} }, approved, { getClientFn: db.getClientFn });
    assert.equal(approved.statusCode, 200, JSON.stringify(approved.body));
    const initiated = makeRes();
    await completeRefund({ params: { orderId: id }, body: {}, app: {} }, initiated, deps);
    assert.equal(initiated.statusCode, 200, JSON.stringify(initiated.body));
  };
  return { id, db, razorpay, deps, approveAndInitiate };
};

test("B. Return/QC refund → customer gets Refund Initiated, then Refund Processed (same copy as the cancellation flow)", async () => {
  const { id, db, approveAndInitiate } = setupReturn();
  await approveAndInitiate();
  await waitFor(() => providers.whatsapp.length === 1 && providers.emails.length === 1, "initiated");
  assert.deepEqual(whatsappLabels(), ["Refund Initiated"], "Refund Approved itself sends nothing");

  await handleWebhook(processedWebhook(id, "rfnd_1"), makeRes(), { queryFn: db.queryFn });
  await waitFor(() => providers.whatsapp.length === 2 && providers.emails.length === 2, "processed");

  assert.equal(db.orders.get(id).refund_status, "completed", "internal state machine unchanged");
  assert.deepEqual(whatsappLabels(), ["Refund Initiated", "Refund Processed"]);
  assert.equal(providers.whatsapp[1].body_data[4], PROCESSED_MESSAGE);
  assert.equal(emailSubjects()[1], `Order Status Updated — Refund Processed (#${db.orders.get(id).order_number})`);
  assertNeverRefundCompleted();
});

test("B. Return/QC refund: duplicate refund.processed → still one Refund Processed per channel", async () => {
  const { id, db, approveAndInitiate } = setupReturn();
  await approveAndInitiate();
  await handleWebhook(processedWebhook(id, "rfnd_1"), makeRes(), { queryFn: db.queryFn });
  const dup = makeRes();
  await handleWebhook(processedWebhook(id, "rfnd_1"), dup, { queryFn: db.queryFn });
  await handleWebhook(processedWebhook(id, "rfnd_1", { created_at: 2 }), makeRes(), { queryFn: db.queryFn });
  await settle();

  assert.equal(dup.body.duplicate, true);
  assert.deepEqual(whatsappLabels(), ["Refund Initiated", "Refund Processed"]);
  assert.equal(providers.emails.length, 2);
  assertNeverRefundCompleted();
});

test("B. Return/QC refund confirmed by the status check (admin 'Check Status' / reconciliation cron) instead of the webhook → also 'Refund Processed'; a late webhook adds nothing", async () => {
  const { id, db, razorpay, deps, approveAndInitiate } = setupReturn();
  await approveAndInitiate();
  razorpay.ledger[0].status = "processed";

  const result = await reconcileOrderRefund(id, deps);
  assert.equal(result.statusCode, 200);
  assert.equal(db.orders.get(id).refund_status, "completed");
  await waitFor(() => providers.whatsapp.length === 2 && providers.emails.length === 2, "processed via recheck");

  await handleWebhook(processedWebhook(id, "rfnd_1"), makeRes(), { queryFn: db.queryFn });
  await settle();
  assert.deepEqual(whatsappLabels(), ["Refund Initiated", "Refund Processed"]);
  assert.equal(providers.emails.length, 2);
  assertNeverRefundCompleted();
});

test("both flows send byte-identical Refund Processed copy", async () => {
  const a = setupCancel();
  await a.cancel();
  await handleWebhook(processedWebhook(a.id, "rfnd_1"), makeRes(), { queryFn: a.db.queryFn });
  await waitFor(() => providers.whatsapp.length === 3, "A processed");
  const fromCancel = providers.whatsapp.find((m) => m.body_data[3] === "Refund Processed").body_data;

  providers.reset();
  notif.setCustomerNotificationDepsForTests({ queryExecutor: createFakeNotificationStore().queryFn });
  const b = setupReturn();
  await b.approveAndInitiate();
  await handleWebhook(processedWebhook(b.id, "rfnd_1"), makeRes(), { queryFn: b.db.queryFn });
  await waitFor(() => providers.whatsapp.length === 2, "B processed");
  const fromReturn = providers.whatsapp.find((m) => m.body_data[3] === "Refund Processed").body_data;

  assert.equal(fromCancel[3], fromReturn[3]);
  assert.equal(fromCancel[4], fromReturn[4]);
});
