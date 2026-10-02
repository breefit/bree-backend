/**
 * Order-milestone WhatsApp notifications (BREE-100020 follow-up).
 *
 * A normal successfully delivered order sends exactly 4 standard progress
 * WhatsApps: Confirmed (dedicated order_confirmed template), Processing,
 * Ready To Ship, Delivered (order_status_update template). Paid, Shipped
 * and Out For Delivery send none. Each milestone sends at most once per
 * order no matter how many times it is observed.
 *
 * Everything here drives the REAL senders (sendOrderConfirmationWhatsApp,
 * sendOrderStatusUpdateWhatsApp → sendTemplateMessage → HTTP) against a fake
 * Waplify server on 127.0.0.1, and the REAL claim layer
 * (sendOrderStatusNotificationOnce) against an in-memory
 * order_status_notifications table. No real customer, provider or
 * database is ever contacted.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");

// ── Fake Waplify: records every message the customer would receive ──────────
const waplify = { accepted: [] };
let server;
let wa;
let payment;
let shipping;
let notif;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      waplify.accepted.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ status: "success", message_id: `wamid.${waplify.accepted.length}` }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // Set before the dynamic imports below so the services bind to the fake
  // server (dotenv never overrides variables that are already set).
  Object.assign(process.env, {
    WAPLIFY_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    WAPLIFY_API_KEY: "wapl_test_only_key",
    WAPLIFY_TEMPLATE_ORDER_CONFIRMED: "order_confirmed_test",
    WAPLIFY_TEMPLATE_ORDER_STATUS: "order_status_test",
  });
  wa = await import("../src/services/whatsappNotificationService.js");
  payment = await import("../src/controllers/paymentController.js");
  shipping = await import("../src/controllers/shippingController.js");
  notif = await import("../src/services/orderStatusNotificationService.js");
  assert.match(process.env.WAPLIFY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
});

after(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  waplify.accepted = [];
});

// ── In-memory orders + order_status_notifications ───────────────────────────
const createFakeDb = (order) => {
  const notifRows = new Map();
  const queryExecutor = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM orders WHERE id = ?")) {
      return { rows: [order], rowCount: 1 };
    }
    if (normalized.includes("FROM order_items WHERE order_id = ?")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("INSERT IGNORE INTO order_status_notifications")) {
      if (!notifRows.has(params[0])) {
        notifRows.set(params[0], { status: "pending", last_attempt_at: null });
      }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("SET status = 'sending'")) {
      const [key, retryFlag] = params;
      const row = notifRows.get(key);
      const claimable =
        row && (row.status === "pending" || (row.status === "failed" && retryFlag === 1));
      if (!claimable) return { rows: [], rowCount: 0 };
      row.status = "sending";
      row.last_attempt_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes("SET status = 'sent'")) {
      const row = notifRows.get(params[0]);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = "sent";
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes("SET status = ?, last_error = ?")) {
      const row = notifRows.get(params[2]);
      if (!row || row.status !== "sending") return { rows: [], rowCount: 0 };
      row.status = params[0];
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unhandled fake query: ${normalized}`);
  };
  return { queryExecutor, notifRows };
};

const baseOrder = () => ({
  id: "6f0c1a52-0000-4000-8000-000000100020",
  order_number: "BREE-100020",
  customer_name: "Pavan Veguru",
  contact_name: "Pavan Veguru",
  email: "test@example.invalid",
  contact_email: "test@example.invalid",
  mobile_number: "9000000020",
  contact_phone: "9000000020",
  total: 1,
  amount: 1,
  shipping_address: "test",
  paid_at: new Date("2026-09-30T10:00:00+05:30"),
  payment_status: "paid",
  order_status: "paid",
});

// Order-created / payment-success: exactly what verifyPayment and the
// payment.captured webhook run (notifyInitialOrderConfirmation, then
// notifyPaidStatusUpdate on a paid transition). Emails are counted, not sent.
const runOrderCreated = async (db, counters = {}) => {
  await payment.notifyInitialOrderConfirmation(baseOrder().id, {
    queryExecutor: db.queryExecutor,
    sendConfirmationEmail: async () => {
      counters.confirmEmail = (counters.confirmEmail || 0) + 1;
    },
  });
  await payment.notifyPaidStatusUpdate(baseOrder().id, {
    queryExecutor: db.queryExecutor,
    sendPaidEmail: async () => {
      counters.paidEmail = (counters.paidEmail || 0) + 1;
    },
  });
};

// The WhatsApp half of every order_status trigger path — admin single
// update, admin bulk update, cron/shippingTrackingCron.js and
// shippingController.trackShipment() all do exactly this (shape pinned by
// the source-audit test at the bottom of this file).
// `statusChanged: true` lets a test bypass the caller-level prev !== next
// check, proving the claim layer alone still blocks a repeat.
const runStatusTrigger = async (db, order, prevStatus, nextStatus, { statusChanged } = {}) => {
  const changed = statusChanged ?? prevStatus !== nextStatus;
  if (!changed) return "unchanged";
  if (!shipping.shouldSendBreeStatusWhatsApp(nextStatus)) {
    return shipping.getSkippedBreeStatusWhatsAppAction(nextStatus);
  }
  const result = await notif.sendOrderStatusNotificationOnce({
    notificationKey: notif.buildOrderStatusNotificationKey({
      orderId: order.id,
      status: nextStatus,
      channel: "whatsapp",
    }),
    orderId: order.id,
    status: nextStatus,
    channel: "whatsapp",
    queryExecutor: db.queryExecutor,
    send: () =>
      wa.sendOrderStatusUpdateWhatsApp({
        customerName: order.contact_name,
        mobile: order.contact_phone,
        orderNumber: order.order_number,
        orderUuid: order.id,
        status: nextStatus,
      }),
  });
  return result.sent ? "sent" : "duplicate_skipped";
};

const sentStatuses = () =>
  waplify.accepted.map((m) =>
    m.template_name === "order_confirmed_test" ? "Confirmed" : m.body_data?.["3"],
  );

// ── 1, 2, 3, 13: Confirmed / Paid ───────────────────────────────────────────

test("1 + 13: a new order sends exactly ONE confirmation WhatsApp (dedicated template) and NOT the generic 'Current Status: Confirmed' message", async () => {
  const db = createFakeDb(baseOrder());
  const counters = {};
  await runOrderCreated(db, counters);

  assert.equal(waplify.accepted.length, 1);
  const [msg] = waplify.accepted;
  assert.equal(msg.template_name, "order_confirmed_test");
  assert.deepEqual(msg.body_data, {
    1: "Pavan Veguru",
    2: "BREE-100020",
    3: "₹1",
    4: new Date(baseOrder().paid_at).toLocaleDateString("en-IN"),
  });
  assert.equal(
    waplify.accepted.some((m) => m.template_name === "order_status_test"),
    false,
    "the generic order_status_update 'Confirmed' message must not be sent",
  );
  // Email side untouched: confirmation email + paid email still sent once.
  assert.deepEqual(counters, { confirmEmail: 1, paidEmail: 1 });
});

test("2: order-created processed twice (verifyPayment + redelivered webhook, sequential and concurrent) still sends exactly 1 confirmation", async () => {
  const db = createFakeDb(baseOrder());
  await runOrderCreated(db);
  await runOrderCreated(db);
  await Promise.all([runOrderCreated(db), runOrderCreated(db)]);
  assert.deepEqual(sentStatuses(), ["Confirmed"]);
});

test("3: Paid sends no additional standard status WhatsApp on any path", async () => {
  const order = baseOrder();
  const db = createFakeDb(order);
  await payment.notifyPaidStatusUpdate(order.id, {
    queryExecutor: db.queryExecutor,
    sendPaidEmail: async () => {},
  });
  // Admin manually moving pending_payment -> paid.
  assert.equal(
    await runStatusTrigger(db, order, "pending_payment", "paid"),
    "skipped_not_customer_milestone",
  );
  assert.equal(waplify.accepted.length, 0);
  assert.equal(shipping.shouldSendBreeStatusWhatsApp("paid"), false);
  assert.equal(shipping.shouldSendBreeStatusWhatsApp("pending_payment"), false);
});

// ── 4–11: Processing / Ready To Ship / Shipped / Out For Delivery / Delivered

test("4 + 5: Processing sends exactly 1 message with the spec copy; written twice (and claim re-hit directly) still 1", async () => {
  const order = baseOrder();
  const db = createFakeDb(order);
  assert.equal(await runStatusTrigger(db, order, "paid", "processing"), "sent");
  assert.equal(await runStatusTrigger(db, order, "processing", "processing"), "unchanged");
  assert.equal(
    await runStatusTrigger(db, order, "paid", "processing", { statusChanged: true }),
    "duplicate_skipped",
  );

  assert.equal(waplify.accepted.length, 1);
  assert.equal(waplify.accepted[0].template_name, "order_status_test");
  assert.deepEqual(waplify.accepted[0].body_data, {
    1: "Pavan Veguru",
    2: "BREE-100020",
    3: "Processing",
    4: "Your order is now being processed.",
  });
});

test("6 + 7: Ready To Ship sends exactly 1 message with the spec copy; written twice still 1", async () => {
  const order = baseOrder();
  const db = createFakeDb(order);
  assert.equal(await runStatusTrigger(db, order, "processing", "ready_to_ship"), "sent");
  assert.equal(await runStatusTrigger(db, order, "ready_to_ship", "ready_to_ship"), "unchanged");
  await Promise.all([
    runStatusTrigger(db, order, "processing", "ready_to_ship", { statusChanged: true }),
    runStatusTrigger(db, order, "processing", "ready_to_ship", { statusChanged: true }),
  ]);

  assert.equal(waplify.accepted.length, 1);
  assert.deepEqual(waplify.accepted[0].body_data, {
    1: "Pavan Veguru",
    2: "BREE-100020",
    3: "Ready To Ship",
    4: "Your order is ready to be shipped. We'll notify you when it is on its way.",
  });
});

test("8 + 9: Shipped and Out For Delivery send no standard WhatsApp and claim no notification row", async () => {
  const order = baseOrder();
  const db = createFakeDb(order);
  assert.equal(
    await runStatusTrigger(db, order, "ready_to_ship", "shipped"),
    "skipped_delhivery_duplicate",
  );
  assert.equal(
    await runStatusTrigger(db, order, "shipped", "out_for_delivery"),
    "skipped_delhivery_duplicate",
  );
  assert.equal(waplify.accepted.length, 0);
  assert.equal(db.notifRows.size, 0);
});

test("10 + 11: Delivered sends exactly 1 message with the spec copy; cron + manual refresh + admin retries still 1", async () => {
  const order = baseOrder();
  const db = createFakeDb(order);
  await Promise.all([
    runStatusTrigger(db, order, "out_for_delivery", "delivered"), // cron
    runStatusTrigger(db, order, "out_for_delivery", "delivered"), // trackShipment
  ]);
  assert.equal(await runStatusTrigger(db, order, "delivered", "delivered"), "unchanged");
  assert.equal(
    await runStatusTrigger(db, order, "out_for_delivery", "delivered", { statusChanged: true }),
    "duplicate_skipped",
  );

  assert.equal(waplify.accepted.length, 1);
  assert.deepEqual(waplify.accepted[0].body_data, {
    1: "Pavan Veguru",
    2: "BREE-100020",
    3: "Delivered",
    4: "Your order has been delivered successfully. 🎉 We hope you enjoy your purchase.",
  });
});

// ── 12: full flow ────────────────────────────────────────────────────────────

test("12: full normal order flow sends exactly 4 standard WhatsApps — Confirmed, Processing, Ready To Ship, Delivered — even with every step observed twice", async () => {
  const order = baseOrder();
  const db = createFakeDb(order);

  await runOrderCreated(db);
  await runOrderCreated(db);
  const flow = ["paid", "processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered"];
  for (let i = 1; i < flow.length; i += 1) {
    await runStatusTrigger(db, order, flow[i - 1], flow[i]);
    // Every step re-observed: a cron re-poll / admin retry / webhook
    // redelivery that still believes it is the transition.
    await runStatusTrigger(db, order, flow[i - 1], flow[i], { statusChanged: true });
    await runStatusTrigger(db, order, flow[i], flow[i]);
  }

  assert.deepEqual(sentStatuses(), ["Confirmed", "Processing", "Ready To Ship", "Delivered"]);
  assert.equal(
    waplify.accepted.filter((m) => m.body_data?.["3"] === "Confirmed").length,
    0,
    "the old generic Confirmed status message must never be sent",
  );
});

// ── 14: cancellation / refund / return unaffected ───────────────────────────

test("14: cancellation, return and refund WhatsApps are unaffected — still sent once each with their own copy", async () => {
  const order = baseOrder();
  const db = createFakeDb(order);

  assert.equal(shipping.shouldSendBreeStatusWhatsApp("cancelled"), true);
  assert.equal(shipping.shouldSendBreeStatusWhatsApp("returned"), true);
  assert.equal(await runStatusTrigger(db, order, "processing", "cancelled"), "sent");
  assert.equal(
    await runStatusTrigger(db, order, "processing", "cancelled", { statusChanged: true }),
    "duplicate_skipped",
  );

  // notifyReturnEvent (returnController.js) — same sender, same claim
  // keyspace, return/refund labels as the status. It never consults the
  // milestone guard, so none of these can be suppressed by it.
  for (const label of ["Return Approved", "Refund Initiated", "Refund Processed"]) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    await notif.sendOrderStatusNotificationOnce({
      notificationKey: notif.buildOrderStatusNotificationKey({
        orderId: order.id,
        status: slug,
        channel: "whatsapp",
      }),
      queryExecutor: db.queryExecutor,
      send: () =>
        wa.sendOrderStatusUpdateWhatsApp({
          customerName: order.contact_name,
          mobile: order.contact_phone,
          orderNumber: order.order_number,
          orderUuid: order.id,
          status: label,
        }),
    });
  }

  assert.deepEqual(sentStatuses(), [
    "Cancelled",
    "Return Approved",
    "Refund Initiated",
    "Refund Processed",
  ]);
  assert.equal(waplify.accepted[0].body_data["4"], "Your order has been cancelled.");
  assert.equal(
    waplify.accepted[3].body_data["4"],
    "Your refund has been processed. It may take a few business days to reflect in your account, depending on your bank.",
  );

  const returnControllerSource = read("../src/controllers/admin/returnController.js");
  assert.doesNotMatch(returnControllerSource, /shouldSendBreeStatusWhatsApp/);
});

// ── 15: idempotency mechanism intact + every trigger path uses it ───────────

test("15: every order_status trigger path still gates the generic WhatsApp through the shared guard and the per-(order,status,whatsapp) claim", () => {
  const adminSource = read("../src/controllers/admin/orderController.js");
  const shippingSource = read("../src/controllers/shippingController.js");
  const cronSource = read("../cron/shippingTrackingCron.js");
  const paymentSource = read("../src/controllers/paymentController.js");

  // admin single + admin bulk
  assert.equal((adminSource.match(/if \(!shouldSendBreeStatusWhatsApp\(status\)\)/g) || []).length, 2);
  assert.equal((adminSource.match(/sendOrderStatusUpdateWhatsApp\(\{/g) || []).length, 2);
  // trackShipment + cron
  for (const source of [shippingSource, cronSource]) {
    assert.match(source, /if \(!shouldSendBreeStatusWhatsApp\(mappedOrderStatus\)\)/);
  }
  for (const source of [adminSource, shippingSource, cronSource]) {
    assert.match(
      source,
      /sendOrderStatusNotificationOnce\(\{\s*notificationKey: buildOrderStatusNotificationKey\(\{[\s\S]*?channel: "whatsapp",[\s\S]*?sendOrderStatusUpdateWhatsApp\(\{/,
    );
  }
  // Payment paths: the only WhatsApp is the dedicated confirmation, claimed
  // under status "confirmed".
  assert.doesNotMatch(paymentSource, /sendOrderStatusUpdateWhatsApp/);
  assert.match(
    paymentSource,
    /status: "confirmed",\s*channel: "whatsapp",[\s\S]*?sendConfirmationWhatsApp\(\{/,
  );
});

test("15: claim layer — a failed send stays retryable, an uncertain (unknown) one is never re-sent", async () => {
  const db = createFakeDb(baseOrder());
  const key = notif.buildOrderStatusNotificationKey({
    orderId: "o-1",
    status: "processing",
    channel: "whatsapp",
  });
  let calls = 0;
  const failKnown = async () => {
    calls += 1;
    throw Object.assign(new Error("400"), { deliveryOutcome: "failed" });
  };
  await assert.rejects(
    notif.sendOrderStatusNotificationOnce({ notificationKey: key, send: failKnown, queryExecutor: db.queryExecutor }),
  );
  const retried = await notif.sendOrderStatusNotificationOnce({
    notificationKey: key,
    send: async () => {
      calls += 1;
    },
    retryFailed: true,
    queryExecutor: db.queryExecutor,
  });
  assert.equal(retried.sent, true);
  assert.equal(calls, 2);

  const unknownKey = key.replace("processing", "delivered");
  await assert.rejects(
    notif.sendOrderStatusNotificationOnce({
      notificationKey: unknownKey,
      send: async () => {
        throw Object.assign(new Error("timeout"), { deliveryOutcome: "unknown" });
      },
      queryExecutor: db.queryExecutor,
    }),
  );
  const again = await notif.sendOrderStatusNotificationOnce({
    notificationKey: unknownKey,
    send: async () => {
      calls += 1;
    },
    retryFailed: true,
    queryExecutor: db.queryExecutor,
  });
  assert.equal(again.duplicate, true);
  assert.equal(calls, 2);
});
