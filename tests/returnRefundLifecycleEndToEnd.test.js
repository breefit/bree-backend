/**
 * Return → refund lifecycle, end to end (return/refund E2E audit).
 *
 * One throwaway order (ORDER-RETURN-E2E-001) is driven through every step —
 * payment captured, delivered, return approved (reminder stopped), reverse
 * pickup created, Delhivery PP/Scheduled → PU/In Transit → DL/DTO, QC,
 * refund approved, Razorpay refund initiated, refund.processed webhook —
 * asserting the database, history, notifications and external calls after
 * each step. Followed by the concurrency and failure cases the audit
 * defines (two approvals, tracking vs. manual override, two refund
 * approvals, refund vs. webhook, duplicate webhook, notification failure
 * and retry).
 *
 * Runs the REAL controllers/services against:
 *   - a real MySQL test database (TEST_DATABASE_URL — never production);
 *   - a fake Delhivery HTTP server on 127.0.0.1 (create + track);
 *   - a fake WAPLIFY (WhatsApp) HTTP server on 127.0.0.1;
 *   - a fake SMTP server on 127.0.0.1 (every email is captured, none sent);
 *   - an in-memory fake Razorpay client injected into completeRefund, and
 *     webhook requests signed with a test-only RAZORPAY_WEBHOOK_SECRET.
 * No real shipment, refund, WhatsApp message or email is ever created.
 *
 * Skipped (not failed) when TEST_DATABASE_URL is not configured.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto, { randomUUID } from "node:crypto";

const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL?.trim());
const skip = HAS_TEST_DB
  ? false
  : "TEST_DATABASE_URL not configured — return/refund lifecycle end-to-end tests need a real (non-production) MySQL";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });

// ── Fake Delhivery ───────────────────────────────────────────────────────────
const delhivery = {
  creates: [],
  tracking: {},
  nextAwb: 58045520000000,
  reset() {
    this.creates = [];
    this.tracking = {};
  },
};
const setTracking = (awb, statusType, status, latencyMs = 0) => {
  delhivery.tracking[awb] = {
    latencyMs,
    body: {
      ShipmentData: [
        {
          Shipment: {
            AWB: awb,
            Status: {
              Status: status,
              StatusType: statusType,
              StatusDateTime: "2026-09-28T10:00:00.000",
              StatusLocation: "Test RPC",
              Instructions: "",
            },
            Scans: [],
          },
        },
      ],
    },
  };
};

// ── Fake WAPLIFY (WhatsApp) ──────────────────────────────────────────────────
const waplify = { requests: [], fail: false };

// ── Fake SMTP ────────────────────────────────────────────────────────────────
const smtp = { messages: [], fail: false };
const decodeMime = (text) =>
  text
    .replace(/=\r?\n/g, "")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b) => Buffer.from(b, "base64").toString("utf8"))
    .replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_, q) =>
      q.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))),
    );
const startFakeSmtp = () =>
  net.createServer((socket) => {
    socket.write("220 fake-smtp ESMTP\r\n");
    let buf = "";
    let inData = false;
    let current = { data: "" };
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            if (smtp.fail) {
              socket.write("554 5.0.0 rejected by test\r\n");
            } else {
              smtp.messages.push({ ...current, decoded: decodeMime(current.data) });
              socket.write("250 2.0.0 queued\r\n");
            }
            current = { data: "" };
          } else {
            current.data += `${line}\n`;
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") socket.write("250-fake-smtp\r\n250-AUTH PLAIN\r\n250 OK\r\n");
        else if (cmd === "AUTH") socket.write("235 2.7.0 ok\r\n");
        else if (cmd === "MAIL") socket.write("250 OK\r\n");
        else if (cmd === "RCPT") {
          current.to = line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "");
          socket.write("250 OK\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (cmd === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => {});
  });

// ── Fake Razorpay (injected) ─────────────────────────────────────────────────
const razorpay = {
  refundCalls: [],
  ledger: [],
  refundStatus: "pending",
  refundLatencyMs: 0,
  onRefundCall: null,
  reset() {
    this.refundCalls = [];
    this.ledger = [];
    this.refundStatus = "pending";
    this.refundLatencyMs = 0;
    this.onRefundCall = null;
  },
  client() {
    return {
      payments: {
        refund: async (paymentId, params) => {
          razorpay.refundCalls.push({ paymentId, params });
          const refund = {
            id: `rfnd_e2e_${razorpay.refundCalls.length}`,
            entity: "refund",
            payment_id: paymentId,
            amount: params.amount,
            status: razorpay.refundStatus,
            notes: params.notes,
          };
          razorpay.ledger.push(refund);
          if (razorpay.onRefundCall) await razorpay.onRefundCall(refund);
          if (razorpay.refundLatencyMs) await sleep(razorpay.refundLatencyMs);
          return { ...refund };
        },
        fetchMultipleRefund: async (paymentId) => ({
          items: razorpay.ledger.filter((r) => r.payment_id === paymentId).map((r) => ({ ...r })),
        }),
      },
      refunds: {
        fetch: async (id) => ({ ...razorpay.ledger.find((r) => r.id === id) }),
      },
    };
  },
};
const WEBHOOK_SECRET = "test-only-webhook-secret-return-e2e";

let delhiveryServer;
let waplifyServer;
let smtpServer;
let db;
let returns;
let reverse;
let payments;
let orders;
let notificationsSvc;

before(async () => {
  if (!HAS_TEST_DB) return;

  delhiveryServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, "http://x");
    const send = (status, json) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.method === "POST" && url.pathname === "/api/cmu/create.json") {
      const payload = JSON.parse(new URLSearchParams(body).get("data"));
      delhivery.creates.push(payload);
      const waybill = String(delhivery.nextAwb++);
      return send(200, {
        success: true,
        packages: [{ waybill, status: "Success", refnum: payload.shipments[0].order }],
      });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/packages/json/") {
      const entry = delhivery.tracking[url.searchParams.get("waybill")];
      if (!entry) return send(404, { message: "not found" });
      if (entry.latencyMs) await sleep(entry.latencyMs);
      return send(200, entry.body);
    }
    send(404, { message: "unexpected" });
  });
  await new Promise((r) => delhiveryServer.listen(0, "127.0.0.1", r));

  waplifyServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (waplify.fail) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, message: "test failure" }));
    }
    waplify.requests.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { message_id: `wamid-${waplify.requests.length}` } }));
  });
  await new Promise((r) => waplifyServer.listen(0, "127.0.0.1", r));

  smtpServer = startFakeSmtp();
  await new Promise((r) => smtpServer.listen(0, "127.0.0.1", r));

  Object.assign(process.env, {
    DELHIVERY_BASE_URL: `http://127.0.0.1:${delhiveryServer.address().port}`,
    DELHIVERY_API_TOKEN: "test-fake-delhivery-token",
    DELHIVERY_TIMEOUT: "1500",
    DELHIVERY_PICKUP_LOCATION: "BREE-TEST-WAREHOUSE",
    DELHIVERY_BOTTLE_WEIGHT_KG: "0.02",
    WAREHOUSE_NAME: "BREE Test Warehouse",
    WAREHOUSE_ADDRESS: "Plot 7, Test Industrial Area",
    WAREHOUSE_CITY: "Chennai",
    WAREHOUSE_STATE: "Tamil Nadu",
    WAREHOUSE_PINCODE: "600001",
    WAREHOUSE_PHONE: "9000000000",
    WAPLIFY_BASE_URL: `http://127.0.0.1:${waplifyServer.address().port}`,
    WAPLIFY_API_KEY: "test-fake-waplify-key",
    WAPLIFY_TEMPLATE_ORDER_STATUS: "order_status_test",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpServer.address().port),
    SMTP_USER: "test-user",
    SMTP_PASS: "test-pass",
    SMTP_FROM: "BREE Test <no-reply@bree.test>",
    FRONTEND_URL: "https://bree.test",
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });

  db = await import("../src/config/database.js");
  await db.ensureOrderShippingAddressColumns();
  await db.ensureOrderShipmentColumns();
  const { rows: orderColumns } = await db.query(
    `SELECT COLUMN_NAME AS column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'orders'`,
  );
  const haveColumns = new Set(orderColumns.map((c) => c.column_name));
  for (const [column, definition] of [
    ["shipment_id", "VARCHAR(255) NULL"],
    ["tracking_number", "VARCHAR(255) NULL"],
    ["shipment_created_at", "DATETIME NULL"],
    ["pickup_request_id", "VARCHAR(255) NULL"],
    ["tracking_sync_last_failure_at", "DATETIME NULL"],
    ["notes", "TEXT NULL"],
  ]) {
    if (!haveColumns.has(column)) await db.query(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
  }
  await db.ensureOrderReturnColumns();
  await db.ensurePackageProductColumns();
  await db.ensureOrderBulkColumns();
  await db.ensurePackageOrderColumns();

  returns = await import("../src/controllers/admin/returnController.js");
  reverse = await import("../src/services/reverseShipmentTracking.js");
  payments = await import("../src/controllers/paymentController.js");
  orders = await import("../src/controllers/orderController.js");
  notificationsSvc = await import("../src/services/orderStatusNotificationService.js");

  // Guard rails: every external endpoint in this file is local.
  assert.match(process.env.DELHIVERY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
  assert.match(process.env.WAPLIFY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(process.env.SMTP_HOST, "127.0.0.1");
});

after(async () => {
  if (db) await db.closePool();
  for (const server of [delhiveryServer, waplifyServer, smtpServer]) {
    if (server) await new Promise((r) => server.close(r));
  }
});

beforeEach(async () => {
  if (!HAS_TEST_DB) return;
  delhivery.reset();
  razorpay.reset();
  waplify.requests = [];
  waplify.fail = false;
  smtp.messages = [];
  smtp.fail = false;
  for (const table of [
    "order_status_notifications",
    "order_status_history",
    "webhook_events",
    "daily_reminder_sends",
    "daily_reminders",
    "payments",
    "order_items",
    "orders",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
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
const socketEvents = [];
const adminReq = (orderId, body = {}) => ({
  params: { orderId, id: orderId },
  body,
  admin: { id: null },
  app: {
    locals: {
      io: {
        emit: (event, payload) => socketEvents.push([event, payload, "*broadcast*"]),
        to: (room) => ({ emit: (event, payload) => socketEvents.push([event, payload, room]) }),
      },
    },
  },
});
const call = async (handler, orderId, body = {}, deps) => {
  const res = makeRes();
  await handler(adminReq(orderId, body), res, deps);
  return res;
};
const completeRefund = (orderId) =>
  call(returns.completeRefund, orderId, {}, { getRazorpayFn: () => razorpay.client() });

const sendWebhook = async (payload) => {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  const res = makeRes();
  await payments.handleWebhook(
    { headers: { "x-razorpay-signature": signature }, rawBody, body: payload, app: { locals: {} } },
    res,
  );
  return res;
};
const refundWebhook = (event, refund) =>
  sendWebhook({
    entity: "event",
    event,
    payload: { refund: { entity: { ...refund, status: event === "refund.failed" ? "failed" : "processed" } } },
    created_at: Math.floor(Date.now() / 1000),
  });

const TEST_PHONE = "9876500077";
const TEST_EMAIL = "asha.e2e@example.test";

let seq = 0;
const seedPaidDeliveredOrder = async ({ orderNumber, deliveredHoursAgo = 1, withReminder = false } = {}) => {
  seq += 1;
  const id = randomUUID();
  const number = orderNumber || `ORDER-RETURN-E2E-${String(100 + seq).padStart(3, "0")}`;
  const paymentId = `pay_e2e_${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO orders (id, order_number, order_status, payment_status, razorpay_order_id, razorpay_payment_id,
       subtotal, total, contact_name, contact_phone, contact_email, shipping_address_line1, shipping_address_line2,
       shipping_city, shipping_state, shipping_pincode, shipping_country, awb_number, tracking_status, delivered_at)
     VALUES (?, ?, 'delivered', 'paid', ?, ?, 950, 950, 'Asha Test', ?, ?, '12 MG Road', 'Flat 3',
       'Bengaluru', 'Karnataka', '560001', 'India', ?, 'Delivered', ?)`,
    [
      id,
      number,
      `order_e2e_${seq}`,
      paymentId,
      TEST_PHONE,
      TEST_EMAIL,
      `FWD-E2E-${seq}`,
      new Date(Date.now() - deliveredHoursAgo * 60 * 60 * 1000),
    ],
  );
  await db.query(
    `INSERT INTO order_items (id, order_id, product_id, product_name, product_price, quantity, subtotal)
     VALUES (?, ?, ?, 'Amla Shots 7 Day Pack', 950, 1, 950)`,
    [randomUUID(), id, randomUUID()],
  );
  await db.query(
    `INSERT INTO payments (id, order_id, razorpay_order_id, razorpay_payment_id, amount, currency, status)
     VALUES (?, ?, ?, ?, 950, 'INR', 'captured')`,
    [randomUUID(), id, `order_e2e_${seq}`, paymentId],
  );
  let reminderId = null;
  if (withReminder) {
    reminderId = randomUUID();
    await db.query(
      `INSERT INTO daily_reminders (id, user_id, order_id, product_id, reminder_enabled, reminder_time,
         reminder_whatsapp_number, reminder_price_paid, delivery_date, reminder_start_date, reminder_end_date, status)
       VALUES (?, NULL, ?, ?, 1, '05:00', ?, 49, CURDATE(), CURDATE(), CURDATE() + INTERVAL 6 DAY, 'active')`,
      [reminderId, id, randomUUID(), `91${TEST_PHONE}`],
    );
  }
  return { id, orderNumber: number, paymentId, reminderId };
};

const row = async (id) => (await db.query(`SELECT * FROM orders WHERE id = ?`, [id])).rows[0];
const paymentRow = async (id) => (await db.query(`SELECT * FROM payments WHERE order_id = ?`, [id])).rows[0];
const historyNotes = async (id) =>
  (await db.query(`SELECT notes FROM order_status_history WHERE order_id = ? ORDER BY created_at, id`, [id])).rows.map(
    (r) => r.notes,
  );
const notificationRows = async (id) =>
  (
    await db.query(
      `SELECT notification_key, status, attempts FROM order_status_notifications WHERE notification_key LIKE ? ORDER BY notification_key`,
      [`order:${id}:%`],
    )
  ).rows;

// Notifications and history are written after COMMIT, fire-and-forget —
// wait until the expected rows exist and nothing is still in flight.
const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${label}`);
    await sleep(25);
  }
};
const settleNotifications = async (id, expectedKeys) =>
  waitFor(async () => {
    const rows = await notificationRows(id);
    const keys = new Set(rows.map((r) => r.notification_key));
    return (
      expectedKeys.every((k) => keys.has(`order:${id}:status:${k}`)) &&
      rows.every((r) => r.status === "sent" || r.status === "failed")
    );
  }, `notifications ${expectedKeys.join(", ")}`);
const settleHistory = async (id, count) =>
  waitFor(async () => (await historyNotes(id)).length >= count, `${count} history rows`);

const whatsappFor = (orderNumber) => waplify.requests.filter((r) => JSON.stringify(r).includes(orderNumber));
const emailsTo = (to) => smtp.messages.filter((m) => m.to === to);
const withinAMinuteOfNow = (value, label) => {
  assert.ok(value instanceof Date, `${label} is a Date`);
  const drift = Math.abs(value.getTime() - Date.now());
  assert.ok(drift < 60 * 1000, `${label} is IST-consistent with the Node clock (drift ${drift}ms — a 5h30 offset would be 19,800,000ms)`);
};

// ════════════════════════════════════════════════════════════════════════════
// PART 29 — the complete lifecycle of ONE order
// ════════════════════════════════════════════════════════════════════════════
test("ORDER-RETURN-E2E-001: payment captured → delivered → return approved → reverse pickup → PP/PU/DL-DTO → QC → refund approved → Razorpay refund → refund.processed webhook → refund completed", { skip }, async () => {
  socketEvents.length = 0;
  const o = await seedPaidDeliveredOrder({ orderNumber: "ORDER-RETURN-E2E-001", withReminder: true });

  // Steps 1–3: paid, delivered, eligible.
  let r = await row(o.id);
  assert.equal(r.payment_status, "paid");
  assert.equal((await paymentRow(o.id)).status, "captured");
  assert.equal(returns.isReturnWindowOpen(r).eligible, true);

  // Steps 4–6: return requested + approved (admin-driven), reminder stopped.
  const approved = await call(returns.approveReturn, o.id, { reason: "Quality Issue", notes: "Customer reports sediment" });
  assert.equal(approved.statusCode, 200);
  r = await row(o.id);
  assert.equal(r.return_status, "approved");
  assert.equal(r.order_status, "delivered", "a return never mutates order_status");
  withinAMinuteOfNow(r.return_requested_at, "return_requested_at");
  withinAMinuteOfNow(r.return_approved_at, "return_approved_at");
  const reminder = (await db.query(`SELECT reminder_enabled, status FROM daily_reminders WHERE id = ?`, [o.reminderId])).rows[0];
  assert.deepEqual({ ...reminder }, { reminder_enabled: 0, status: "ended" });
  await settleHistory(o.id, 1);
  await settleNotifications(o.id, ["return_approved:channel:email", "return_approved:channel:whatsapp"]);

  // Repeated approval: one transition, one history row, one notification.
  const again = await call(returns.approveReturn, o.id, { reason: "Quality Issue", notes: "dup" });
  assert.equal(again.statusCode, 400);
  await sleep(100);
  assert.equal((await historyNotes(o.id)).length, 1);

  // Steps 7–8: reverse shipment + AWB.
  const created = await call(returns.createReverseShipment, o.id);
  assert.equal(created.statusCode, 200);
  assert.equal(delhivery.creates.length, 1);
  const shipment = delhivery.creates[0].shipments[0];
  assert.equal(shipment.payment_mode, "Pickup");
  assert.equal(shipment.order, "ORDER-RETURN-E2E-001-RETURN");
  assert.equal(shipment.pin, "560001", "pickup point is the customer");
  assert.equal(shipment.return_pin, "600001", "destination is the BREE warehouse");
  const awb = created.body.delhivery.awb;
  r = await row(o.id);
  assert.equal(r.reverse_awb, awb);
  assert.equal(r.reverse_shipment_type, "rvp");
  assert.equal(r.reverse_shipment_reference, "ORDER-RETURN-E2E-001-RETURN");
  assert.equal(r.awb_number, `FWD-E2E-${seq}`, "forward AWB untouched");
  assert.equal(r.reverse_pickup_scheduled_at, null, "shipment created ≠ pickup scheduled");
  // Second click: same AWB, no second Delhivery shipment.
  const createdAgain = await call(returns.createReverseShipment, o.id);
  assert.equal(createdAgain.body.delhivery.awb, awb);
  assert.equal(delhivery.creates.length, 1);

  // Step 9: Delhivery PP/Scheduled.
  setTracking(awb, "PP", "Scheduled");
  await reverse.syncReverseShipmentTracking();
  r = await row(o.id);
  assert.equal(r.return_status, "pickup_scheduled");
  assert.equal(r.reverse_tracking_status, "pickup_scheduled");
  withinAMinuteOfNow(r.reverse_pickup_scheduled_at, "reverse_pickup_scheduled_at");
  assert.equal(r.reverse_picked_up_at, null, "scheduled ≠ picked up");

  // Step 10: PU/In Transit.
  setTracking(awb, "PU", "In Transit");
  await reverse.syncReverseShipmentTracking();
  r = await row(o.id);
  assert.equal(r.return_status, "pickup_scheduled", "picked up ≠ received");
  assert.equal(r.reverse_tracking_status, "in_transit");
  withinAMinuteOfNow(r.reverse_picked_up_at, "reverse_picked_up_at");
  assert.equal(r.returned_at, null);

  // Steps 11–12: DL/DTO → Return Received (automatic, Delhivery-sourced).
  setTracking(awb, "DL", "DTO");
  await reverse.syncReverseShipmentTracking();
  r = await row(o.id);
  assert.equal(r.return_status, "returned");
  assert.equal(r.returned_source, "delhivery");
  assert.equal(r.inspection_status, "pending");
  withinAMinuteOfNow(r.returned_at, "returned_at");
  withinAMinuteOfNow(r.reverse_delivered_at, "reverse_delivered_at");
  await settleNotifications(o.id, [
    "return_pickup_scheduled:channel:whatsapp",
    "return_received:channel:whatsapp",
    "return_received:channel:email",
  ]);

  // Step 13: QC passed.
  assert.equal((await call(returns.approveInspection, o.id, {})).statusCode, 200);
  r = await row(o.id);
  assert.equal(r.inspection_status, "approved");
  withinAMinuteOfNow(r.inspection_completed_at, "inspection_completed_at");

  // Step 14: refund approved — server computes the amount (full refund).
  const refundApproved = await call(returns.approveRefund, o.id, {});
  assert.equal(refundApproved.statusCode, 200);
  r = await row(o.id);
  assert.equal(r.refund_status, "approved");
  assert.equal(Number(r.refund_amount), 950);
  withinAMinuteOfNow(r.refund_approved_at, "refund_approved_at");
  assert.equal(r.refund_completed_at, null, "refund approved ≠ refund completed");
  assert.equal(razorpay.refundCalls.length, 0, "approval alone never calls Razorpay");

  // Step 15: Razorpay refund initiated (Razorpay answers "pending").
  const initiated = await completeRefund(o.id);
  assert.equal(initiated.statusCode, 200, JSON.stringify(initiated.body));
  assert.equal(razorpay.refundCalls.length, 1);
  assert.equal(razorpay.refundCalls[0].params.amount, 95000, "paise, from the server-side refund_amount");
  assert.equal(razorpay.refundCalls[0].params.notes.order_id, o.id);
  r = await row(o.id);
  assert.equal(r.refund_status, "initiated");
  assert.equal(r.refund_reference, "rfnd_e2e_1");
  assert.equal(r.payment_status, "paid", "not refunded until Razorpay says processed");
  assert.equal(r.refund_completed_at, null);
  let pay = await paymentRow(o.id);
  assert.equal(pay.refund_id, "rfnd_e2e_1");
  assert.equal(pay.status, "captured");

  // Steps 16–17: refund.processed webhook → Refund Processed.
  razorpay.ledger[0].status = "processed";
  const hook = await refundWebhook("refund.processed", razorpay.ledger[0]);
  assert.equal(hook.statusCode, 200);
  r = await row(o.id);
  assert.equal(r.refund_status, "completed");
  assert.equal(r.payment_status, "refunded");
  withinAMinuteOfNow(r.refund_completed_at, "refund_completed_at");
  pay = await paymentRow(o.id);
  assert.equal(pay.status, "refunded");
  assert.equal(Number(pay.refund_amount), 950);
  // Duplicate webhook delivery: acknowledged, no second anything.
  const dupHook = await refundWebhook("refund.processed", razorpay.ledger[0]);
  assert.equal(dupHook.body.duplicate, true);

  // Steps 18–19: every notification exactly once, per channel.
  const expected = [
    "return_approved",
    "return_shipment_created",
    "return_pickup_scheduled",
    "return_received",
    "return_inspection_approved",
    "refund_initiated",
    "refund_completed",
  ];
  await settleNotifications(
    o.id,
    expected.flatMap((k) => [`${k}:channel:email`, `${k}:channel:whatsapp`]),
  );
  const notes = await notificationRows(o.id);
  assert.equal(notes.length, expected.length * 2, notes.map((n) => n.notification_key).join("\n"));
  assert.ok(notes.every((n) => n.status === "sent" && n.attempts === 1));
  assert.equal(whatsappFor("ORDER-RETURN-E2E-001").length, expected.length, "one WhatsApp per event");
  const mails = emailsTo(TEST_EMAIL);
  assert.equal(mails.length, expected.length, "one email per event");
  assert.ok(
    mails.every((m) => m.decoded.includes("ORDER-RETURN-E2E-001")),
    "every email names the order number (not a UUID fragment)",
  );
  assert.ok(mails.every((m) => !m.decoded.includes("Customer reports sediment") || /Return Approved/.test(m.decoded)));
  assert.equal(Number((await db.query(`SELECT COUNT(*) AS n FROM daily_reminder_sends`)).rows[0].n), 0, "no reminder ever sent");

  // Step 20: admin history — one row per transition, in order.
  await settleHistory(o.id, 8);
  const history = await historyNotes(o.id);
  const expectedHistory = [
    /^Return approved/,
    /^Reverse pickup \(customer → BREE\) created/,
    /^Return pickup scheduled by Delhivery/,
    /^Return delivered to BREE/,
    /^Quality check passed/,
    /^Refund approved — ₹950/,
    /^Refund initiated with Razorpay — ₹950\. Refund ID: rfnd_e2e_1/,
    /^Refund rfnd_e2e_1 confirmed completed via webhook/,
  ];
  assert.equal(history.length, expectedHistory.length, history.join("\n"));
  expectedHistory.forEach((re, i) => assert.match(history[i], re));

  // Step 21: customer tracking API — every timeline field present, nothing internal.
  const trackRes = makeRes();
  await orders.getOrderTracking({ params: { id: o.id }, user: null }, trackRes);
  const body = JSON.parse(JSON.stringify(trackRes.body ?? trackRes._json ?? {}));
  const pub = body.order || {};
  for (const field of [
    "return_requested_at",
    "return_approved_at",
    "reverse_shipment_created_at",
    "reverse_pickup_scheduled_at",
    "reverse_picked_up_at",
    "reverse_delivered_at",
    "returned_at",
    "inspection_completed_at",
    "refund_approved_at",
    "refund_completed_at",
  ]) {
    assert.ok(pub[field], `customer tracking exposes ${field}`);
  }
  assert.equal(pub.refund_status, "completed");
  for (const hidden of ["return_reason", "return_notes", "return_approved_by", "refund_reference", "reverse_delhivery_response", "razorpay_payment_id", "contact_phone"]) {
    assert.equal(pub[hidden], undefined, `customer tracking never exposes ${hidden}`);
  }
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("rfnd_e2e_1"), "Razorpay refund id not exposed");
  assert.ok(!serialized.includes("Customer reports sediment"), "admin notes not exposed");
  assert.ok((body.history || []).every((h) => h.notes === undefined), "history rows carry no notes");

  // Socket broadcasts carry no PII / payment identifiers.
  assert.equal(socketEvents.filter(([, , room]) => room === "*broadcast*").length, 0, "no order event is broadcast to every socket");
  assert.ok(socketEvents.some(([e, , room]) => e === "order:updated" && room === "admins"), "admins receive order updates");
  const broadcast = JSON.stringify(socketEvents.filter(([e]) => e === "order:updated").map(([, p]) => p));
  for (const secret of [TEST_PHONE, TEST_EMAIL, o.paymentId, "rfnd_e2e_1", "Customer reports sediment"]) {
    assert.ok(!broadcast.includes(secret), `socket payload must not include ${secret}`);
  }

  // PART 30 — expected end state.
  r = await row(o.id);
  assert.deepEqual(
    {
      order_status: r.order_status,
      payment_status: r.payment_status,
      return_status: r.return_status,
      returned_source: r.returned_source,
      inspection_status: r.inspection_status,
      refund_status: r.refund_status,
      refund_reference: r.refund_reference,
      refund_amount: Number(r.refund_amount),
    },
    {
      order_status: "delivered",
      payment_status: "refunded",
      return_status: "returned",
      returned_source: "delhivery",
      inspection_status: "approved",
      refund_status: "completed",
      refund_reference: "rfnd_e2e_1",
      refund_amount: 950,
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// PART 26 — concurrency
// ════════════════════════════════════════════════════════════════════════════
const driveToReturned = async (o) => {
  await call(returns.approveReturn, o.id, { reason: "Quality Issue" });
  const created = await call(returns.createReverseShipment, o.id);
  return created.body.delhivery.awb;
};
const driveToQcPassed = async (o) => {
  const awb = await driveToReturned(o);
  setTracking(awb, "DL", "DTO");
  await reverse.syncReverseShipmentTracking();
  await call(returns.approveInspection, o.id, {});
  return awb;
};

test("26-A: two concurrent approveReturn → one approval, one history row, one notification per channel", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  const results = await Promise.all([
    call(returns.approveReturn, o.id, { reason: "Quality Issue" }),
    call(returns.approveReturn, o.id, { reason: "Quality Issue" }),
  ]);
  assert.deepEqual(results.map((x) => x.statusCode).sort(), [200, 400]);
  await settleNotifications(o.id, ["return_approved:channel:email", "return_approved:channel:whatsapp"]);
  await sleep(100);
  assert.equal((await historyNotes(o.id)).length, 1);
  assert.equal((await notificationRows(o.id)).length, 2);
  assert.equal(whatsappFor(o.orderNumber).length, 1);
});

test("26-C: two concurrent reverse-tracking passes observing DL/DTO → one transition, one history row, one notification per channel", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  const awb = await driveToReturned(o);
  setTracking(awb, "DL", "DTO", 150);
  await settleHistory(o.id, 2);
  await Promise.all([reverse.syncReverseShipmentTracking(), reverse.syncReverseShipmentTracking()]);
  await settleNotifications(o.id, ["return_received:channel:email", "return_received:channel:whatsapp"]);
  const history = (await historyNotes(o.id)).filter((n) => /Return delivered to BREE/.test(n));
  assert.equal(history.length, 1);
  assert.equal((await notificationRows(o.id)).filter((n) => n.notification_key.includes("return_received")).length, 2);
  assert.equal((await row(o.id)).returned_source, "delhivery");
});

test("26-D: reverse tracking DL/DTO racing an admin manual override → returned once, one 'returned' history row, one notification; tracking data still recorded", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  const awb = await driveToReturned(o);
  await settleHistory(o.id, 2);
  setTracking(awb, "DL", "DTO", 200);
  const [, override] = await Promise.all([
    reverse.syncReverseShipmentTracking(),
    (async () => {
      await sleep(50);
      return call(returns.markReturned, o.id, { override: true, reason: "Parcel at warehouse", notes: "Received at dock" });
    })(),
  ]);
  assert.equal(override.statusCode, 200);
  const r = await row(o.id);
  assert.equal(r.return_status, "returned");
  assert.equal(r.returned_source, "manual_override", "the override committed first");
  assert.ok(r.reverse_delivered_at, "Delhivery's DL/DTO is still recorded after the override");
  assert.equal(r.reverse_tracking_status, "delivered_to_bree");
  await settleNotifications(o.id, ["return_received:channel:email", "return_received:channel:whatsapp"]);
  const returnedHistory = (await historyNotes(o.id)).filter((n) => /MANUAL OVERRIDE|Return delivered to BREE/.test(n));
  assert.equal(returnedHistory.length, 1, returnedHistory.join("\n"));
  const overrideMail = emailsTo(TEST_EMAIL).find((m) => /Return Received/.test(m.decoded));
  assert.ok(overrideMail && !overrideMail.decoded.includes("Received at dock"), "internal override notes are not emailed to the customer");
});

test("26-E: two concurrent approveRefund → one approval, one history row, amount computed server-side; bad amounts refused", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  await driveToQcPassed(o);
  const before = (await historyNotes(o.id)).length;
  for (const bad of [0, -5, 951, "abc"]) {
    const res = await call(returns.approveRefund, o.id, { refund_amount: bad });
    assert.equal(res.statusCode, 400, `refund_amount ${bad} refused`);
  }
  const results = await Promise.all([call(returns.approveRefund, o.id, {}), call(returns.approveRefund, o.id, {})]);
  assert.deepEqual(results.map((x) => x.statusCode), [200, 200]);
  assert.equal(results.filter((x) => /already been approved/.test(x.body.message)).length, 1);
  assert.equal(Number((await row(o.id)).refund_amount), 950);
  await settleHistory(o.id, before + 1);
  await sleep(100);
  assert.equal((await historyNotes(o.id)).filter((n) => /^Refund approved/.test(n)).length, 1);
});

test("26-F: completeRefund racing the refund.processed webhook (webhook lands while the Razorpay call is in flight) → one Razorpay refund, completed once, one 'Refund Processed' per channel, no 'Refund Initiated'", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  await driveToQcPassed(o);
  await call(returns.approveRefund, o.id, {});
  razorpay.refundLatencyMs = 300;
  let webhookRes;
  razorpay.onRefundCall = async (refund) => {
    // Razorpay processed it instantly and its webhook beat our response.
    webhookRes = await refundWebhook("refund.processed", { ...refund, status: "processed" });
  };
  const [first, second] = await Promise.all([completeRefund(o.id), (async () => { await sleep(20); return completeRefund(o.id); })()]);
  assert.equal(razorpay.refundCalls.length, 1, "exactly one Razorpay refund");
  assert.equal(webhookRes.statusCode, 200);
  assert.equal(first.statusCode, 200);
  // Refused while 'processing' (409), or — if the webhook already completed
  // it — told it is already done. Never a second Razorpay call either way.
  assert.ok(
    second.statusCode === 409 || (second.statusCode === 200 && /already/.test(second.body.message)),
    JSON.stringify(second.body),
  );
  const r = await row(o.id);
  assert.equal(r.refund_status, "completed");
  assert.equal(r.refund_reference, "rfnd_e2e_1");
  assert.equal(r.payment_status, "refunded");
  await settleNotifications(o.id, ["refund_completed:channel:email", "refund_completed:channel:whatsapp"]);
  const keys = (await notificationRows(o.id)).map((n) => n.notification_key);
  assert.equal(keys.filter((k) => k.includes("refund_completed")).length, 2);
  assert.equal(keys.filter((k) => k.includes("refund_initiated")).length, 0);
  await sleep(100);
  const refundHistory = (await historyNotes(o.id)).filter((n) => /Refund (initiated|completed)|confirmed completed/.test(n));
  assert.equal(refundHistory.length, 1, refundHistory.join("\n"));
});

test("26-G: the same refund.processed webhook delivered twice (and concurrently) → one completion, one history row, one notification per channel", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  await driveToQcPassed(o);
  await call(returns.approveRefund, o.id, {});
  await completeRefund(o.id);
  const refund = { ...razorpay.ledger[0], status: "processed" };
  const [a, b] = await Promise.all([refundWebhook("refund.processed", refund), refundWebhook("refund.processed", refund)]);
  const c = await refundWebhook("refund.processed", refund);
  assert.equal([a, b, c].filter((x) => x.body?.duplicate).length, 2);
  await settleNotifications(o.id, ["refund_completed:channel:email", "refund_completed:channel:whatsapp"]);
  await sleep(100);
  assert.equal((await historyNotes(o.id)).filter((n) => /confirmed completed via webhook/.test(n)).length, 1);
  assert.equal(whatsappFor(o.orderNumber).filter((w) => JSON.stringify(w).includes("Refund Processed")).length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// PART 27 — failure / recovery
// ════════════════════════════════════════════════════════════════════════════
test("26-H / 27: WhatsApp AND email fail when the refund completes → refund stays completed; failures recorded; a retry sends exactly once", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  await driveToQcPassed(o);
  await call(returns.approveRefund, o.id, {});
  razorpay.refundStatus = "processed";
  waplify.fail = true;
  smtp.fail = true;
  const res = await completeRefund(o.id);
  assert.equal(res.statusCode, 200);
  await settleNotifications(o.id, ["refund_completed:channel:email", "refund_completed:channel:whatsapp"]);
  let r = await row(o.id);
  assert.equal(r.refund_status, "completed", "notification failure never rolls back the refund");
  assert.equal(r.payment_status, "refunded");
  const failed = (await notificationRows(o.id)).filter((n) => n.notification_key.includes("refund_completed"));
  assert.deepEqual(failed.map((n) => n.status), ["failed", "failed"]);

  // Retry (there is no automatic retry job — this is the retry mechanism
  // an operator/job would use): exactly one send, then nothing.
  waplify.fail = false;
  const key = notificationsSvc.buildOrderStatusNotificationKey({ orderId: o.id, status: "refund_completed", channel: "whatsapp" });
  let sends = 0;
  const retry = () =>
    notificationsSvc.sendOrderStatusNotificationOnce({ notificationKey: key, retryFailed: true, send: async () => { sends += 1; } });
  await Promise.all([retry(), retry()]);
  await retry();
  assert.equal(sends, 1);
  r = await row(o.id);
  assert.equal(r.refund_status, "completed");
});

test("27: Razorpay call fails outright → refund stays approved (retryable), nothing created; the retry creates exactly one refund", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  await driveToQcPassed(o);
  await call(returns.approveRefund, o.id, {});
  const failing = {
    payments: {
      refund: async () => {
        throw Object.assign(new Error("Razorpay 500"), { statusCode: 500 });
      },
      fetchMultipleRefund: async () => ({ items: [] }),
    },
  };
  const res = await call(returns.completeRefund, o.id, {}, { getRazorpayFn: () => failing });
  assert.equal(res.statusCode, 502);
  assert.equal((await row(o.id)).refund_status, "approved");
  razorpay.refundStatus = "processed";
  assert.equal((await completeRefund(o.id)).statusCode, 200);
  assert.equal(razorpay.refundCalls.length, 1);
  assert.equal((await row(o.id)).refund_status, "completed");
});

test("27: Razorpay accepted the refund but the DB write failed (claim stranded in 'processing') → the stale-claim re-check adopts Razorpay's refund; no second refund", { skip }, async () => {
  const o = await seedPaidDeliveredOrder();
  await driveToQcPassed(o);
  await call(returns.approveRefund, o.id, {});
  // What a crash between Razorpay's success and Phase 3 leaves behind.
  razorpay.refundStatus = "processed";
  await razorpay.client().payments.refund(o.paymentId, { amount: 95000, notes: { order_id: o.id, order_number: o.orderNumber } });
  await db.query(`UPDATE orders SET refund_status = 'processing', updated_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?`, [o.id]);

  const res = await completeRefund(o.id);
  assert.equal(res.statusCode, 200);
  assert.equal(razorpay.refundCalls.length, 1, "only the original refund exists");
  const r = await row(o.id);
  assert.equal(r.refund_status, "completed");
  assert.equal(r.refund_reference, "rfnd_e2e_1");
  assert.match((await historyNotes(o.id)).at(-1) || "", /Existing Razorpay refund reconciled/);
});

test("25: timezone — return deadline boundary at deadline-1s / deadline / deadline+1s, and IST day boundaries 00:00, 05:00, 23:59", { skip }, async () => {
  const at = (iso) => new Date(iso);
  for (const deliveredIst of ["2026-09-26T00:00:00+05:30", "2026-09-26T05:00:00+05:30", "2026-09-26T23:59:00+05:30"]) {
    const o = await seedPaidDeliveredOrder();
    await db.query(`UPDATE orders SET delivered_at = ? WHERE id = ?`, [at(deliveredIst), o.id]);
    const r = await row(o.id);
    assert.equal(r.delivered_at.getTime(), at(deliveredIst).getTime(), `delivered_at round-trips exactly (${deliveredIst})`);
    const deadline = r.delivered_at.getTime() + 48 * 3600 * 1000;
    const realNow = Date.now;
    try {
      Date.now = () => deadline - 1000;
      assert.equal(returns.isReturnWindowOpen(r).eligible, true);
      Date.now = () => deadline;
      assert.equal(returns.isReturnWindowOpen(r).eligible, true, "exactly at the deadline is still eligible");
      Date.now = () => deadline + 1000;
      assert.equal(returns.isReturnWindowOpen(r).eligible, false);
    } finally {
      Date.now = realNow;
    }
  }
  const { rows } = await db.query(`SELECT NOW() AS now_ist, @@session.time_zone AS tz`);
  assert.equal(rows[0].tz, "+05:30");
  withinAMinuteOfNow(rows[0].now_ist, "pooled NOW()");
});

test("2: eligibility — after deadline, not delivered, cancelled, already returned/rejected, already requested are all refused by approveReturn", { skip }, async () => {
  const expired = await seedPaidDeliveredOrder({ deliveredHoursAgo: 49 });
  assert.match((await call(returns.approveReturn, expired.id, {})).body.message, /48-hour return window has expired/);

  const shipped = await seedPaidDeliveredOrder();
  await db.query(`UPDATE orders SET order_status = 'shipped' WHERE id = ?`, [shipped.id]);
  assert.equal((await call(returns.approveReturn, shipped.id, {})).statusCode, 400);

  const cancelled = await seedPaidDeliveredOrder();
  await db.query(`UPDATE orders SET order_status = 'cancelled' WHERE id = ?`, [cancelled.id]);
  assert.equal((await call(returns.approveReturn, cancelled.id, {})).statusCode, 400);

  for (const status of ["approved", "returned", "rejected"]) {
    const o = await seedPaidDeliveredOrder();
    await db.query(`UPDATE orders SET return_status = ? WHERE id = ?`, [status, o.id]);
    assert.equal((await call(returns.approveReturn, o.id, {})).statusCode, 400, `return_status ${status}`);
  }
  assert.equal((await call(returns.approveReturn, randomUUID(), {})).statusCode, 404);
});
