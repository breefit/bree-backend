/**
 * Audit finding 1 — admin/internal notes must never reach customers.
 *
 * Drives the REAL return controllers (approveReturn, rejectReturn,
 * rejectInspection, markReturned) and the REAL senders
 * (sendCustomerEventWhatsApp → sendTemplateMessage over HTTP to a fake
 * WAPLIFY on 127.0.0.1; sendCustomerEventEmail → mocked nodemailer). The
 * notification claim runs against an in-memory order_status_notifications.
 * Every internal value (admin notes, reasons, override text, Razorpay ids,
 * RRN, Delhivery diagnostics) is a unique marker that must appear in NO
 * customer message.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeProviders } from "./fixtures/fakeNotificationProviders.js";
import { createFakeNotificationStore } from "./fixtures/fakeNotificationStore.js";

let providers;
let rc; // returnController
let notif; // customerOrderNotifications
let events; // customerOrderEvents
let closePool;
let store;

before(async () => {
  providers = await startFakeProviders();
  rc = await import("../src/controllers/admin/returnController.js");
  notif = await import("../src/services/customerOrderNotifications.js");
  events = await import("../src/services/customerOrderEvents.js");
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
  store = createFakeNotificationStore();
  notif.setCustomerNotificationDepsForTests({ queryExecutor: store.queryFn });
});

const INTERNAL = {
  return_notes: "INTERNAL-RETURN-NOTES-1101",
  return_reason: "INTERNAL-RETURN-REASON-1102",
  refund_reference: "rfnd_INTERNAL1103",
  refund_rrn: "RRN-INTERNAL-1104",
  razorpay_payment_id: "pay_INTERNAL1105",
  refund_gateway_status: "INTERNAL-GATEWAY-1106",
  reverse_awb: "AWB-INTERNAL-1107",
  reverse_shipment_reference: "REVREF-INTERNAL-1108",
  reverse_shipment_create_error: "INTERNAL-SHIPMENT-ERROR-1109",
  reverse_delhivery_response: '{"diag":"INTERNAL-DELHIVERY-1110"}',
  reverse_tracking_raw_status: "PU/INTERNAL-RAW-1111",
};
const ADMIN_NOTE = "ADMIN-VERIFICATION-NOTE-2201";
const ADMIN_REASON = "ADMIN-REASON-2202";
const OVERRIDE_REASON = "OVERRIDE-REASON-2203";
const OVERRIDE_NOTES = "OVERRIDE-NOTES-2204";
const QC_NOTE = "QC-INTERNAL-NOTE-2205";

let seq = 0;
const makeOrder = (overrides = {}) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  order_number: `BREE-1009${String(seq).padStart(2, "0")}`,
  order_status: "delivered",
  delivered_at: new Date(Date.now() - 60 * 60 * 1000),
  payment_status: "paid",
  contact_name: "Asha Rao",
  contact_email: "asha@example.com",
  contact_phone: "9876500011",
  refund_amount: 499,
  ...INTERNAL,
  ...overrides,
});

const assertNoInternalContent = (extra = []) => {
  const content = providers.allCustomerContent();
  for (const value of [...Object.values(INTERNAL), ...extra]) {
    assert.ok(!content.includes(value), `customer content leaked internal value ${value}`);
  }
};

const waitFor = async (predicate, ms = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for notifications");
    await new Promise((r) => setTimeout(r, 10));
  }
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

// Minimal transactional orders client for the four controllers under test.
const makeClientFn = (orders) => () => ({
  release() {},
  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [], rowCount: 0 };
    if (q === "SELECT * FROM orders WHERE id = ? FOR UPDATE" || q === "SELECT * FROM orders WHERE id = ? LIMIT 1") {
      const o = orders.get(params[0]);
      return { rows: o ? [{ ...o }] : [], rowCount: o ? 1 : 0 };
    }
    if (q.startsWith("UPDATE daily_reminders")) return { rows: [], rowCount: 0 };
    if (q.startsWith("UPDATE orders SET return_status = 'approved'") || q.startsWith("UPDATE orders SET return_status = 'rejected'")) {
      const [reason, notes, , id] = params;
      Object.assign(orders.get(id), {
        return_status: q.includes("'approved'") ? "approved" : "rejected",
        return_reason: reason,
        return_notes: notes,
        return_approved_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE orders SET return_status = 'returned'")) {
      const [source, id] = params;
      Object.assign(orders.get(id), { return_status: "returned", returned_source: source, inspection_status: "pending" });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE orders SET inspection_status = 'rejected'")) {
      Object.assign(orders.get(params[0]), { inspection_status: "rejected", inspection_completed_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`fake client: unhandled SQL ${q}`);
  },
});

const runController = async (fn, order, body) => {
  const orders = new Map([[order.id, { ...order }]]);
  const res = makeRes();
  await fn({ params: { orderId: order.id }, body, admin: { id: "admin-1" } }, res, {
    getClientFn: makeClientFn(orders),
  });
  return res;
};

test("A. Return Approved: customer gets the approved copy by email and WhatsApp; the admin's verification notes and reason are in neither", async () => {
  const order = makeOrder({ return_status: null, return_notes: null, return_reason: null });
  const res = await runController(rc.approveReturn, order, { reason: ADMIN_REASON, notes: ADMIN_NOTE });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await waitFor(() => providers.emails.length === 1 && providers.whatsapp.length === 1);

  const [wa] = providers.whatsapp;
  assert.deepEqual(wa.body_data, {
    1: "Asha Rao",
    2: order.order_number,
    3: "Return Approved",
    4: "Your return request has been approved. We will arrange the pickup shortly.",
  });
  assert.deepEqual(wa.url_button_data, { 0: order.id });
  assert.deepEqual(Object.keys(wa).sort(), ["body_data", "contact_name", "contact_phone", "template_name", "url_button_data"]);

  const [email] = providers.emails;
  assert.equal(email.subject, `Order Status Updated — Return Approved (#${order.order_number})`);
  assert.match(email.html, /We will arrange the pickup shortly\./);
  assertNoInternalContent([ADMIN_NOTE, ADMIN_REASON]);
});

test("B. Return Rejected: customer-safe copy only; internal rejection reason/notes are not emailed or sent on WhatsApp", async () => {
  const order = makeOrder({ return_status: null, return_notes: null, return_reason: null });
  const res = await runController(rc.rejectReturn, order, { reason: ADMIN_REASON, notes: ADMIN_NOTE });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await waitFor(() => providers.emails.length === 1 && providers.whatsapp.length === 1);

  assert.equal(providers.whatsapp[0].body_data[3], "Return Rejected");
  assert.match(providers.whatsapp[0].body_data[4], /could not be approved\. Please contact BREE Support/);
  assertNoInternalContent([ADMIN_NOTE, ADMIN_REASON]);
});

test("G. QC failure: customer gets 'Return Quality Check Failed' copy; QC reason/notes stay internal", async () => {
  const order = makeOrder({ return_status: "returned", inspection_status: "pending", refund_status: null });
  const res = await runController(rc.rejectInspection, order, { reason: ADMIN_REASON, notes: QC_NOTE });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await waitFor(() => providers.emails.length === 1 && providers.whatsapp.length === 1);

  assert.equal(providers.whatsapp[0].body_data[3], "Return Quality Check Failed");
  assert.match(providers.emails[0].html, /did not pass our quality check/);
  assertNoInternalContent([QC_NOTE, ADMIN_REASON]);
});

test("manual override reason and notes are never sent to the customer (Return Received)", async () => {
  const order = makeOrder({
    return_status: "pickup_scheduled",
    reverse_shipment_type: "rvp",
    reverse_tracking_status: "in_transit",
  });
  const res = await runController(rc.markReturned, order, {
    override: true,
    reason: OVERRIDE_REASON,
    notes: OVERRIDE_NOTES,
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await waitFor(() => providers.emails.length === 1 && providers.whatsapp.length === 1);

  assert.equal(providers.whatsapp[0].body_data[3], "Return Received");
  assertNoInternalContent([OVERRIDE_REASON, OVERRIDE_NOTES]);
});

test("no customer event — return, refund or cancellation — ever carries a refund id, RRN, payment id, AWB or Delhivery diagnostic", async () => {
  for (const name of Object.keys(events.CUSTOMER_ORDER_EVENTS)) {
    const order = makeOrder();
    await rc.notifyReturnEvent(order, name);
  }
  const count = Object.keys(events.CUSTOMER_ORDER_EVENTS).length;
  assert.equal(providers.whatsapp.length, count);
  assert.equal(providers.emails.length, count);
  assertNoInternalContent();
});

test("a legacy free-text third argument is ignored — it can no longer smuggle notes into a customer message", async () => {
  const order = makeOrder();
  await rc.notifyReturnEvent(order, "Return Approved", ADMIN_NOTE);
  assert.equal(providers.emails.length, 1);
  assert.equal(providers.whatsapp.length, 1);
  assertNoInternalContent([ADMIN_NOTE]);
});

test("an unknown event name sends nothing (no generic fallback text)", async () => {
  const order = makeOrder();
  const results = await rc.notifyReturnEvent(order, "Admin said: refund the customer manually");
  assert.deepEqual(results, []);
  assert.equal(providers.whatsappRequests, 0);
  assert.equal(providers.emails.length, 0);
});

test("buildCustomerEventPayload exposes only whitelisted customer fields", () => {
  const order = makeOrder();
  const payload = notif.buildCustomerEventPayload(order, events.CUSTOMER_ORDER_EVENTS["Refund Processed"]);
  assert.deepEqual(Object.keys(payload).sort(), [
    "email",
    "emailMessage",
    "emailSubject",
    "label",
    "name",
    "orderId",
    "orderNumber",
    "phone",
    "whatsappMessage",
  ]);
  const serialized = JSON.stringify(payload);
  for (const value of Object.values(INTERNAL)) assert.ok(!serialized.includes(value));
  assert.deepEqual(
    [...notif.CUSTOMER_PAYLOAD_FIELDS].sort(),
    ["contact_email", "contact_name", "contact_phone", "customer_name", "email", "id", "mobile_number", "order_number", "refund_amount"],
  );
});

test("controllers pass only an event name to notifyReturnEvent — never notes/reason variables", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/controllers/admin/returnController.js", import.meta.url), "utf8");
  const calls = source.match(/notifyReturnEvent\([^;]*?\);/gs) || [];
  assert.ok(calls.length >= 9, `expected the return/refund call sites, found ${calls.length}`);
  for (const call of calls) {
    assert.doesNotMatch(call, /\bnotes\b|\breason\b|overrideReason|overrideNotes/, call);
  }
});

test("the cancel-and-refund notification shows the refund amount (customer-owned) and nothing internal", async () => {
  const order = makeOrder({ order_status: "cancelled", refund_amount: 1299 });
  await rc.notifyReturnEvent(order, "cancelled");
  assert.equal(providers.whatsapp[0].body_data[4], "Your order has been cancelled.");
  assert.match(providers.emails[0].html, /a refund of ₹1,299 is being processed to your original payment method/);
  assertNoInternalContent();
});
