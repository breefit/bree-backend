/**
 * Return shipping end to end: Delhivery reverse pickup creation, reverse AWB
 * tracking, return_status synchronization, Mark Returned, QC/refund
 * timestamps, the shared timeline fields, and IST-consistent timestamps.
 *
 * Runs the REAL controllers/services against:
 *   - a real MySQL test database (TEST_DATABASE_URL — never production),
 *     with the orders columns created by the app's own ensure*() helpers;
 *   - a fake Delhivery HTTP server on 127.0.0.1 (create / track / pickup
 *     request endpoints) — DELHIVERY_BASE_URL/TOKEN are overridden before
 *     delhiveryService is imported, so real Delhivery is never reached;
 *   - a fake WAPLIFY HTTP server (return notifications go to WhatsApp);
 *     orders carry no email address, so no SMTP send is ever attempted.
 *
 * Skipped (not failed) when TEST_DATABASE_URL is not configured.
 */
import test, { before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL?.trim());
const skip = HAS_TEST_DB
  ? false
  : "TEST_DATABASE_URL not configured — reverse shipment end-to-end tests need a real (non-production) MySQL";

// ── Fake Delhivery ───────────────────────────────────────────────────────────
const delhivery = {
  creates: [],
  trackRequests: [],
  pickupRequests: [],
  otherRequests: [],
  manifestedReferences: new Set(),
  createMode: "ok", // ok | manifest_then_500
  tracking: {}, // awb -> { status, body, latencyMs }
  nextAwb: 58045510900000,
  reset() {
    this.creates = [];
    this.trackRequests = [];
    this.pickupRequests = [];
    this.otherRequests = [];
    this.manifestedReferences = new Set();
    this.createMode = "ok";
    this.tracking = {};
  },
};

const trackingBody = (awb, statusType, status) => ({
  ShipmentData: [
    {
      Shipment: {
        AWB: awb,
        Status: {
          Status: status,
          StatusType: statusType,
          StatusDateTime: "2026-09-27T10:00:00.000",
          StatusLocation: "Test RPC",
          Instructions: "",
        },
        Scans: [],
      },
    },
  ],
});
const setTracking = (awb, statusType, status) => {
  delhivery.tracking[awb] = { status: 200, body: trackingBody(awb, statusType, status) };
};

const waplify = { requests: [] };

let delhiveryServer;
let waplifyServer;
let db;
let returns;
let reverse;
let shippingCron;
let orders;
let adminOrders;
let dailyReminder;

const readBody = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });

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
      const reference = payload.shipments[0].order;
      if (delhivery.manifestedReferences.has(reference)) {
        // Delhivery refuses an order id it already manifested.
        return send(200, {
          success: false,
          rmk: `Duplicate order id ${reference}`,
          packages: [{ status: "Fail", remarks: ["Duplicate order id"] }],
        });
      }
      delhivery.manifestedReferences.add(reference);
      if (delhivery.createMode === "manifest_then_500") {
        return send(500, { message: "gateway error after manifest" });
      }
      const waybill = String(delhivery.nextAwb++);
      return send(200, {
        success: true,
        packages: [{ waybill, status: "Success", refnum: reference }],
      });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/packages/json/") {
      const awb = url.searchParams.get("waybill");
      delhivery.trackRequests.push(awb);
      const entry = delhivery.tracking[awb];
      if (!entry) return send(404, { message: "not found" });
      if (entry.latencyMs) await new Promise((r) => setTimeout(r, entry.latencyMs));
      return send(entry.status, entry.body);
    }

    if (url.pathname.startsWith("/fm/request/new")) {
      delhivery.pickupRequests.push(body);
      return send(200, { pickup_id: 999 });
    }

    delhivery.otherRequests.push(`${req.method} ${req.url}`);
    send(404, { message: "unexpected" });
  });
  await new Promise((r) => delhiveryServer.listen(0, "127.0.0.1", r));

  waplifyServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    waplify.requests.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { message_id: `wamid-${waplify.requests.length}` } }));
  });
  await new Promise((r) => waplifyServer.listen(0, "127.0.0.1", r));

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
  });

  db = await import("../src/config/database.js");
  await db.ensureOrderShippingAddressColumns();
  await db.ensureOrderShipmentColumns();
  // ensureOrderShipmentColumns reads information_schema without an alias
  // and so cannot add a column on MySQL 8+ once any of its columns exist —
  // add the forward-shipment columns the admin order query reads directly.
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
  shippingCron = await import("../cron/shippingTrackingCron.js");
  orders = await import("../src/controllers/orderController.js");
  adminOrders = await import("../src/controllers/admin/orderController.js");
  dailyReminder = await import("../src/services/dailyReminderService.js");

  assert.match(process.env.DELHIVERY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
});

after(async () => {
  if (db) await db.closePool();
  if (delhiveryServer) await new Promise((r) => delhiveryServer.close(r));
  if (waplifyServer) await new Promise((r) => waplifyServer.close(r));
});

beforeEach(async () => {
  if (!HAS_TEST_DB) return;
  delhivery.reset();
  waplify.requests = [];
  for (const table of ["order_status_notifications", "order_status_history", "order_items", "daily_reminders", "orders"]) {
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
const call = async (handler, orderId, body = {}) => {
  const res = makeRes();
  await handler({ params: { orderId, id: orderId }, body, admin: { id: null }, app: { locals: {} } }, res);
  return res;
};

let seq = 0;
const seedDeliveredOrder = async () => {
  const id = randomUUID();
  seq += 1;
  const orderNumber = `BREE-T${String(seq).padStart(5, "0")}`;
  await db.query(
    `INSERT INTO orders (id, order_number, order_status, payment_status, razorpay_payment_id, total,
       contact_name, contact_phone, shipping_address_line1, shipping_address_line2, shipping_city,
       shipping_state, shipping_pincode, shipping_country, awb_number, tracking_status, delivered_at)
     VALUES (?, ?, 'delivered', 'paid', ?, 950, 'Asha Test', '9876500010',
       '12 MG Road', 'Flat 3', 'Bengaluru', 'Karnataka', '560001', 'India', ?, 'Delivered', ?)`,
    [id, orderNumber, `pay_test_${randomUUID()}`, `FWD${seq}`, new Date(Date.now() - 60 * 60 * 1000)],
  );
  await db.query(
    `INSERT INTO order_items (id, order_id, product_id, product_name, product_price, quantity, subtotal)
     VALUES (?, ?, ?, 'Amla Shots 7 Day Pack', 950, 1, 950)`,
    [randomUUID(), id, randomUUID()],
  );
  return { id, orderNumber };
};

const approveAndCreate = async () => {
  const order = await seedDeliveredOrder();
  assert.equal((await call(returns.approveReturn, order.id, { reason: "Quality Issue" })).statusCode, 200);
  const created = await call(returns.createReverseShipment, order.id);
  assert.equal(created.statusCode, 200, JSON.stringify(created.body));
  return { ...order, awb: created.body.delhivery.awb };
};

const row = async (id) => (await db.query(`SELECT * FROM orders WHERE id = ?`, [id])).rows[0];
const history = async (id) =>
  (await db.query(`SELECT notes FROM order_status_history WHERE order_id = ? ORDER BY created_at, id`, [id])).rows.map(
    (r) => r.notes,
  );
const trackingHistory = async (id) =>
  (await history(id)).filter((n) => /Delhivery (reverse status|— reverse status)|Return (pickup scheduled|delivered to BREE)/.test(n));

const syncWithSpy = async () => {
  const notified = [];
  const summary = await reverse.syncReverseShipmentTracking({
    notify: (order, label) => notified.push([order.id, label]),
  });
  return { summary, notified };
};

const FORWARD_COLUMNS = ["awb_number", "tracking_status", "order_status", "delhivery_response", "delivered_at"];
const forwardSnapshot = (r) => JSON.stringify(FORWARD_COLUMNS.map((c) => r[c]));

// ── A–D: reverse shipment creation ───────────────────────────────────────────
test("A–D: approval → reverse shipment is a Delhivery reverse pickup: customer = pickup point, BREE warehouse = destination, payment_mode Pickup, reverse reference; AWB stored", { skip }, async () => {
  const order = await seedDeliveredOrder();
  const before = await row(order.id);
  await call(returns.approveReturn, order.id, { reason: "Quality Issue" });
  const res = await call(returns.createReverseShipment, order.id);

  assert.equal(res.statusCode, 200);
  assert.equal(delhivery.creates.length, 1);
  const [payload] = delhivery.creates;
  const [shipment] = payload.shipments;
  // C — pickup point is the customer.
  assert.equal(shipment.name, "Asha Test");
  assert.equal(shipment.add, "12 MG Road");
  assert.equal(shipment.city, "Bengaluru");
  assert.equal(shipment.pin, "560001");
  assert.equal(shipment.phone, "9876500010");
  // D — destination is BREE's warehouse.
  assert.deepEqual(payload.pickup_location, { name: "BREE-TEST-WAREHOUSE" });
  assert.equal(shipment.return_add, "Plot 7, Test Industrial Area");
  assert.equal(shipment.return_pin, "600001");
  assert.equal(shipment.payment_mode, "Pickup");
  assert.equal(shipment.cod_amount, "0");
  assert.equal(shipment.order, `${order.orderNumber}-RETURN`);

  // B — stored on the reverse columns only.
  const after = await row(order.id);
  assert.equal(after.return_status, "reverse_shipment_created");
  assert.equal(after.reverse_awb, res.body.delhivery.awb);
  assert.equal(after.reverse_shipment_type, "rvp");
  assert.equal(after.reverse_shipment_reference, `${order.orderNumber}-RETURN`);
  assert.ok(after.reverse_shipment_created_at instanceof Date);
  assert.equal(forwardSnapshot(after), forwardSnapshot(before), "forward shipment columns untouched");
  assert.equal(delhivery.pickupRequests.length, 0, "no warehouse pickup request is ever sent for a return");
});

test("Y: repeat click / retry never creates a second Delhivery reverse shipment", { skip }, async () => {
  const created = await approveAndCreate();
  const again = await call(returns.createReverseShipment, created.id);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.delhivery.awb, created.awb);
  assert.equal(delhivery.creates.length, 1, "second click returns the existing shipment without calling Delhivery");

  // Lost response: Delhivery manifested it but BREE saw a 500.
  const lost = await seedDeliveredOrder();
  await call(returns.approveReturn, lost.id, { reason: "Quality Issue" });
  delhivery.createMode = "manifest_then_500";
  const first = await call(returns.createReverseShipment, lost.id);
  assert.equal(first.statusCode, 500);
  assert.equal((await row(lost.id)).return_status, "approved");
  assert.equal((await row(lost.id)).reverse_awb, null);

  delhivery.createMode = "ok";
  const retry = await call(returns.createReverseShipment, lost.id);
  assert.equal(retry.statusCode, 400, "the same reverse reference is refused by Delhivery instead of manifesting a duplicate");
  const references = delhivery.creates.map((p) => p.shipments[0].order).filter((r) => r.startsWith(lost.orderNumber));
  assert.deepEqual(references, [`${lost.orderNumber}-RETURN`, `${lost.orderNumber}-RETURN`]);
  assert.equal([...delhivery.manifestedReferences].filter((r) => r.startsWith(lost.orderNumber)).length, 1);
});

// ── E: pickup request ───────────────────────────────────────────────────────
test("E: 'schedule pickup' sends NO Delhivery pickup request (reverse pickups are auto-scheduled) and changes nothing", { skip }, async () => {
  const created = await approveAndCreate();
  const res = await call(returns.scheduleReversePickup, created.id);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "REVERSE_PICKUP_AUTO_SCHEDULED");
  assert.equal(delhivery.pickupRequests.length, 0);
  assert.equal((await row(created.id)).return_status, "reverse_shipment_created");
  assert.equal((await row(created.id)).reverse_pickup_request_id, null);
});

// ── F, H, I, J, M: tracking lifecycle ────────────────────────────────────────
test("F/H/I/J/M: reverse AWB tracked through PP/Open → PP/Scheduled → PU/In Transit → PU/Pending → DL/DTO; exactly two transitions, two history rows, two notifications", { skip }, async () => {
  const created = await approveAndCreate();
  const forwardBefore = forwardSnapshot(await row(created.id));
  const allNotified = [];
  const tick = async (statusType, status) => {
    setTracking(created.awb, statusType, status);
    const { notified } = await syncWithSpy();
    allNotified.push(...notified);
    return row(created.id);
  };

  let r = await tick("PP", "Open");
  assert.equal(r.reverse_tracking_status, "pickup_requested");
  assert.equal(r.return_status, "reverse_shipment_created", "PP/Open is not a scheduled pickup");
  assert.equal(r.reverse_pickup_scheduled_at, null);

  r = await tick("PP", "Scheduled"); // H
  assert.equal(r.return_status, "pickup_scheduled");
  assert.equal(r.reverse_tracking_raw_status, "PP/Scheduled");
  assert.ok(r.reverse_pickup_scheduled_at instanceof Date);
  assert.equal(r.reverse_picked_up_at, null, "scheduled is not picked up");

  r = await tick("PP", "Dispatched");
  assert.equal(r.reverse_tracking_status, "out_for_pickup");
  assert.equal(r.reverse_picked_up_at, null, "out for pickup is not picked up");

  r = await tick("PU", "In Transit"); // I
  assert.equal(r.reverse_tracking_status, "in_transit");
  assert.ok(r.reverse_picked_up_at instanceof Date);
  assert.equal(r.return_status, "pickup_scheduled", "picked up / in transit is NOT returned");
  const pickedUpAt = r.reverse_picked_up_at.getTime();

  r = await tick("PU", "Pending");
  assert.equal(r.return_status, "pickup_scheduled");
  assert.equal(r.reverse_picked_up_at.getTime(), pickedUpAt, "milestone timestamps are never overwritten");

  r = await tick("DL", "DTO"); // J
  assert.equal(r.return_status, "returned");
  assert.equal(r.returned_source, "delhivery");
  assert.equal(r.inspection_status, "pending");
  assert.ok(r.reverse_delivered_at instanceof Date);
  assert.ok(r.returned_at instanceof Date);

  // M — the same DL/DTO again changes nothing and is no longer even polled.
  await tick("DL", "DTO");
  await tick("DL", "DTO");

  assert.deepEqual(allNotified.map(([, label]) => label), ["Return Pickup Scheduled", "Return Received"]);
  const notes = await history(created.id);
  assert.equal(notes.filter((n) => n.startsWith("Return pickup scheduled by Delhivery")).length, 1);
  assert.equal(notes.filter((n) => n.startsWith("Return delivered to BREE")).length, 1);
  assert.ok(delhivery.trackRequests.every((awb) => awb === created.awb), "only the reverse AWB is tracked");
  assert.equal(forwardSnapshot(await row(created.id)), forwardBefore, "reverse tracking never touches forward columns");
});

// ── G: forward tracking unchanged, the two flows never cross ────────────────
test("G: forward cron tracks only forward AWBs; reverse pass tracks only reverse AWBs; neither writes the other's columns", { skip }, async () => {
  const created = await approveAndCreate();
  const inTransit = await seedDeliveredOrder();
  await db.query(
    `UPDATE orders SET order_status = 'shipped', tracking_status = 'In Transit', delivered_at = NULL, return_status = NULL WHERE id = ?`,
    [inTransit.id],
  );
  const forwardAwb = (await row(inTransit.id)).awb_number;
  delhivery.tracking[forwardAwb] = { status: 200, body: trackingBody(forwardAwb, "DL", "Delivered") };
  setTracking(created.awb, "PP", "Scheduled");
  const returnBefore = await row(created.id);

  await shippingCron.syncShippingTracking();
  assert.deepEqual(delhivery.trackRequests, [forwardAwb], "the forward cron never sees the reverse AWB (or the delivered order)");
  const fwd = await row(inTransit.id);
  assert.equal(fwd.order_status, "delivered");
  assert.equal(fwd.return_status, null);
  assert.equal(fwd.reverse_tracking_status, null);

  delhivery.trackRequests = [];
  await syncWithSpy();
  assert.deepEqual(delhivery.trackRequests, [created.awb]);
  const ret = await row(created.id);
  assert.equal(ret.return_status, "pickup_scheduled");
  assert.equal(forwardSnapshot(ret), forwardSnapshot(returnBefore));
  assert.equal(ret.delhivery_response, returnBefore.delhivery_response, "forward raw response untouched");
  assert.ok(ret.reverse_delhivery_response.includes("Scheduled"));
});

// ── K: unknown / unsafe statuses ─────────────────────────────────────────────
test("K: unknown or forward-style statuses (DL/Delivered, RT/RTO, UD/In Transit, garbage) are stored and logged, never transition", { skip }, async () => {
  const created = await approveAndCreate();
  for (const [type, status] of [["DL", "Delivered"], ["RT", "RTO"], ["UD", "In Transit"], ["PP", "Totally New Status"], [null, "Delivered"]]) {
    delhivery.tracking[created.awb] = {
      status: 200,
      body: trackingBody(created.awb, type, status),
    };
    const { summary, notified } = await syncWithSpy();
    const r = await row(created.id);
    assert.equal(r.reverse_tracking_status, "unknown", `${type}/${status}`);
    assert.equal(r.return_status, "reverse_shipment_created", `${type}/${status}`);
    assert.equal(summary.unknown, 1);
    assert.deepEqual(notified, []);
  }
  assert.deepEqual(await trackingHistory(created.id), []);
});

test("K: a LEGACY return shipment (forward Prepaid, reverse_shipment_type NULL — the BREE-100018 shape) is tracked but can never drive return_status", { skip }, async () => {
  const order = await seedDeliveredOrder();
  await db.query(
    `UPDATE orders SET return_status = 'pickup_scheduled', return_approved_at = NOW(), reverse_awb = '58045510000044',
       reverse_pickup_request_id = '323693428', reverse_shipment_created_at = NOW(), reverse_shipment_type = NULL WHERE id = ?`,
    [order.id],
  );
  for (const [type, status] of [["PU", "In Transit"], ["DL", "Delivered"], ["DL", "DTO"]]) {
    setTracking("58045510000044", type, status);
    const { notified } = await syncWithSpy();
    assert.deepEqual(notified, []);
  }
  const r = await row(order.id);
  assert.equal(r.return_status, "pickup_scheduled");
  assert.equal(r.reverse_picked_up_at, null);
  assert.equal(r.reverse_delivered_at, null);
  assert.equal(r.reverse_tracking_raw_status, "DL/DTO", "observation recorded");
  assert.deepEqual(await trackingHistory(order.id), []);
});

// ── L: failures retry later ──────────────────────────────────────────────────
test("L: Delhivery 500 / 4xx / malformed body / timeout → no state change, failure count increments; next successful run applies and resets", { skip }, async () => {
  const created = await approveAndCreate();
  const failures = [
    { status: 500, body: { message: "internal" } },
    { status: 401, body: { message: "unauthorized" } },
    { status: 200, body: { unexpected: true } },
    { status: 200, body: trackingBody(created.awb, "PP", "Scheduled"), latencyMs: 2500 }, // > DELHIVERY_TIMEOUT
  ];
  for (let i = 0; i < failures.length; i++) {
    delhivery.tracking[created.awb] = failures[i];
    const { summary, notified } = await syncWithSpy();
    assert.equal(summary.failed, 1, `failure case ${i}`);
    assert.deepEqual(notified, []);
    const r = await row(created.id);
    assert.equal(r.return_status, "reverse_shipment_created");
    assert.equal(Number(r.reverse_tracking_failure_count), i + 1);
  }

  setTracking(created.awb, "PP", "Scheduled");
  await syncWithSpy();
  const r = await row(created.id);
  assert.equal(r.return_status, "pickup_scheduled");
  assert.equal(Number(r.reverse_tracking_failure_count), 0);
});

// ── N: two processes ─────────────────────────────────────────────────────────
test("N: two concurrent reverse-tracking runs (and two cron ticks under the real GET_LOCK) → one transition, one history row, one notification", { skip }, async () => {
  const created = await approveAndCreate();
  setTracking(created.awb, "DL", "DTO");
  delhivery.tracking[created.awb].latencyMs = 150;
  await db.query(`UPDATE orders SET return_status = 'pickup_scheduled' WHERE id = ?`, [created.id]);

  const [a, b] = await Promise.all([syncWithSpy(), syncWithSpy()]);
  assert.equal(a.notified.length + b.notified.length, 1);
  assert.equal((await trackingHistory(created.id)).length, 1);
  assert.equal((await row(created.id)).return_status, "returned");

  // Real cron path: separate lock name from the forward cron, real notify.
  const second = await approveAndCreate();
  await db.query(`UPDATE orders SET return_status = 'pickup_scheduled' WHERE id = ?`, [second.id]);
  setTracking(second.awb, "DL", "DTO");
  delhivery.tracking[second.awb].latencyMs = 150;
  waplify.requests = [];
  const ticks = await Promise.all([shippingCron.runReverseTrackingTick(), shippingCron.runReverseTrackingTick()]);
  assert.equal(ticks.filter((t) => t.ran).length >= 1, true);
  await new Promise((r) => setTimeout(r, 300)); // fire-and-forget notification
  assert.equal((await trackingHistory(second.id)).length, 1);
  const received = waplify.requests.filter((body) => JSON.stringify(body).includes("Return Received"));
  assert.equal(received.length, 1, "Return Received WhatsApp sent exactly once");
});

// ── O: Mark Returned ─────────────────────────────────────────────────────────
test("O: Mark Returned is refused until Delhivery reports DL/DTO; an explicit override needs reason + notes and is recorded as such", { skip }, async () => {
  const created = await approveAndCreate();
  setTracking(created.awb, "PU", "In Transit");
  await syncWithSpy();

  const plain = await call(returns.markReturned, created.id, { notes: "looks fine" });
  assert.equal(plain.statusCode, 409);
  assert.equal(plain.body.code, "DELHIVERY_RECEIPT_NOT_CONFIRMED");
  assert.match(plain.body.message, /PU\/In Transit/);

  const noReason = await call(returns.markReturned, created.id, { override: true, notes: "x" });
  assert.equal(noReason.statusCode, 409);
  assert.equal((await row(created.id)).return_status, "pickup_scheduled");

  const override = await call(returns.markReturned, created.id, {
    override: true,
    reason: "Parcel physically received at BREE warehouse",
    notes: "Received at dock 2, courier did not scan",
  });
  assert.equal(override.statusCode, 200);
  let r = await row(created.id);
  assert.equal(r.return_status, "returned");
  assert.equal(r.returned_source, "manual_override");
  assert.equal(r.reverse_tracking_raw_status, "PU/In Transit", "Delhivery status preserved");
  const overrideNote = (await history(created.id)).find((n) => n.startsWith("MANUAL OVERRIDE"));
  assert.match(overrideNote, /Reason: Parcel physically received/);
  assert.match(overrideNote, /Delhivery reverse status at override: PU\/In Transit/);

  // Tracking continues after an override and records Delhivery's DL/DTO — no second transition.
  setTracking(created.awb, "DL", "DTO");
  const { notified } = await syncWithSpy();
  r = await row(created.id);
  assert.deepEqual(notified, []);
  assert.equal(r.return_status, "returned");
  assert.equal(r.returned_source, "manual_override");
  assert.ok(r.reverse_delivered_at instanceof Date);

  // Once Delhivery confirmed, a plain Mark Returned is accepted as 'delhivery'.
  const confirmed = await approveAndCreate();
  await db.query(
    `UPDATE orders SET return_status = 'pickup_scheduled', reverse_tracking_status = 'delivered_to_bree', reverse_tracking_raw_status = 'DL/DTO' WHERE id = ?`,
    [confirmed.id],
  );
  const ok = await call(returns.markReturned, confirmed.id, {});
  assert.equal(ok.statusCode, 200);
  assert.equal((await row(confirmed.id)).returned_source, "delhivery");
});

// ── P / Q: QC and refund approval still work, now timestamped ──────────────
test("P/Q: Quality Check approval and Refund approval still work and now record inspection_completed_at / refund_approved_at", { skip }, async () => {
  const created = await approveAndCreate();
  setTracking(created.awb, "DL", "DTO");
  await syncWithSpy();

  const qc = await call(returns.approveInspection, created.id, { notes: "sealed, unused" });
  assert.equal(qc.statusCode, 200, JSON.stringify(qc.body));
  const refund = await call(returns.approveRefund, created.id, {});
  assert.equal(refund.statusCode, 200, JSON.stringify(refund.body));

  const r = await row(created.id);
  assert.equal(r.inspection_status, "approved");
  assert.ok(r.inspection_completed_at instanceof Date);
  assert.equal(r.refund_status, "approved");
  assert.ok(r.refund_approved_at instanceof Date);
  assert.equal(Number(r.refund_amount), 950);
});

// ── T / U / V: one authoritative state for both timelines ──────────────────
const TIMELINE_FIELDS = [
  "return_status", "return_requested_at", "return_approved_at", "reverse_awb", "reverse_tracking_url",
  "reverse_shipment_created_at", "reverse_shipment_type", "reverse_pickup_request_id", "reverse_tracking_status",
  "reverse_tracking_raw_status", "reverse_tracking_updated_at", "reverse_pickup_scheduled_at", "reverse_picked_up_at",
  "reverse_delivered_at", "returned_at", "returned_source", "inspection_status", "inspection_completed_at",
  "refund_status", "refund_amount", "refund_approved_at", "refund_completed_at",
];

test("T/U/V: admin order API and customer tracking API return identical timeline fields, identical on every refresh; raw Delhivery payload never exposed", { skip }, async () => {
  const created = await approveAndCreate();
  setTracking(created.awb, "PU", "In Transit");
  await syncWithSpy();

  const fetchBoth = async () => {
    const adminRes = makeRes();
    await adminOrders.getOrder({ params: { id: created.id } }, adminRes);
    const customerRes = makeRes();
    await orders.getOrderTracking({ params: { id: created.id }, user: null }, customerRes);
    return { admin: adminRes.body, customer: customerRes.body.order };
  };

  const first = await fetchBoth();
  const pick = (o) => JSON.parse(JSON.stringify(Object.fromEntries(TIMELINE_FIELDS.map((f) => [f, o[f] ?? null]))));
  assert.deepEqual(pick(first.customer), pick(first.admin));
  assert.equal(pick(first.admin).reverse_tracking_status, "in_transit");

  const second = await fetchBoth(); // refresh / new session — nothing is session- or client-derived
  assert.deepEqual(pick(second.admin), pick(first.admin));
  assert.deepEqual(pick(second.customer), pick(first.customer));

  for (const body of [first.admin, first.customer]) {
    assert.equal(body.reverse_delhivery_response, undefined);
  }
  assert.equal(first.customer.reverse_shipment_reference, undefined);
  assert.equal(first.customer.reverse_tracking_failure_count, undefined);
});

// ── W / X: IST-consistent timestamps on a UTC MySQL server ────────────────
test("W/X: pooled NOW() and transaction NOW() are both IST wall-clock (even on a UTC MySQL server); delivered_at round-trips; 48h return deadline is exact", { skip }, async () => {
  const { rows: [pooled] } = await db.query(`SELECT NOW() AS now_wall, @@session.time_zone AS tz`);
  const client = await db.getClient();
  let txNow;
  try {
    ({ rows: [txNow] } = await client.query(`SELECT NOW() AS now_wall, @@session.time_zone AS tz`));
  } finally {
    client.release();
  }
  assert.equal(pooled.tz, "+05:30");
  assert.equal(txNow.tz, "+05:30");
  // mysql2 reads DATETIME as +05:30, so an IST wall-clock NOW() is the real instant.
  assert.ok(Math.abs(pooled.now_wall.getTime() - Date.now()) < 60_000, `pooled NOW() off by ${pooled.now_wall.getTime() - Date.now()}ms`);
  assert.ok(Math.abs(txNow.now_wall.getTime() - pooled.now_wall.getTime()) < 60_000);

  // A cron-style write (pooled query, server-side NOW()) of delivered_at.
  const order = await seedDeliveredOrder();
  await db.query(`UPDATE orders SET delivered_at = NOW() WHERE id = ?`, [order.id]);
  const deliveredAt = (await row(order.id)).delivered_at;
  assert.ok(Math.abs(deliveredAt.getTime() - Date.now()) < 60_000, "delivered_at is the real instant, not 5h30 off");

  const eligibility = returns.isReturnWindowOpen({ order_status: "delivered", delivered_at: deliveredAt, return_status: null });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.deadline.getTime() - deliveredAt.getTime(), 48 * 60 * 60 * 1000);

  // Midnight IST and 05:00 IST boundaries: DATE() of a stored instant is its IST calendar date.
  for (const [iso, istDate] of [
    ["2026-09-25T18:29:59Z", "2026-09-25"], // 23:59:59 IST
    ["2026-09-25T18:30:00Z", "2026-09-26"], // 00:00 IST
    ["2026-09-25T23:30:00Z", "2026-09-26"], // 05:00 IST (still Sep 25 in UTC)
  ]) {
    await db.query(`UPDATE orders SET delivered_at = ? WHERE id = ?`, [new Date(iso), order.id]);
    const { rows: [d] } = await db.query(
      `SELECT CAST(DATE(delivered_at) AS CHAR) AS ist_date, delivered_at FROM orders WHERE id = ?`,
      [order.id],
    );
    assert.equal(d.ist_date, istDate, iso);
    assert.equal(d.delivered_at.toISOString(), new Date(iso).toISOString());
  }
});

test("X: the return deadline shown/enforced is delivered_at + 48h in IST terms — 26 Sep 13:30 IST delivery closes 28 Sep 13:30 IST", { skip }, async () => {
  const delivered = new Date("2026-09-26T08:00:00Z"); // 13:30 IST
  const order = await seedDeliveredOrder();
  await db.query(`UPDATE orders SET delivered_at = ? WHERE id = ?`, [delivered, order.id]);
  const stored = (await row(order.id)).delivered_at;
  const { rows: [wall] } = await db.query(`SELECT CAST(delivered_at AS CHAR) AS wall FROM orders WHERE id = ?`, [order.id]);
  assert.equal(wall.wall, "2026-09-26 13:30:00", "stored as IST wall-clock");

  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T07:59:59Z") }); // 13:29:59 IST
  try {
    assert.equal(returns.isReturnWindowOpen({ order_status: "delivered", delivered_at: stored }).eligible, true);
    mock.timers.setTime(Date.parse("2026-09-28T08:00:01Z")); // 13:30:01 IST
    assert.equal(returns.isReturnWindowOpen({ order_status: "delivered", delivered_at: stored }).eligible, false);
  } finally {
    mock.timers.reset();
  }
});

// ── Return approval still stops the daily reminder (previous fix intact) ──
test("regression: approving a return still stops the order's daily reminder", { skip }, async () => {
  const order = await seedDeliveredOrder();
  await db.query(
    `INSERT INTO daily_reminders (id, user_id, order_id, product_id, reminder_enabled, reminder_time, reminder_price_paid, status)
     VALUES (?, NULL, ?, ?, 1, '05:00', 9, 'active')`,
    [randomUUID(), order.id, randomUUID()],
  );
  await call(returns.approveReturn, order.id, { reason: "Quality Issue" });
  const { rows } = await db.query(`SELECT reminder_enabled, status FROM daily_reminders WHERE order_id = ?`, [order.id]);
  assert.deepEqual(rows.map((r) => [Number(r.reminder_enabled), r.status]), [[0, "ended"]]);
  assert.equal(dailyReminder.isReminderBlockedByReturnStatus("pickup_scheduled"), true);
});
