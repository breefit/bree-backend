/**
 * H4 (contract-independent part): Delhivery reverse-shipment creation when
 * the outcome is uncertain.
 *
 * Drives the REAL createReverseShipment against:
 *   - a real MySQL test database (TEST_DATABASE_URL — never production);
 *   - a fake Delhivery on 127.0.0.1 that can CREATE a shipment (record the
 *     reference as manifested, like Delhivery does) and THEN lose the
 *     response: timeout, connection reset, 5xx, malformed 200. It refuses a
 *     reused reference with "Duplicate order id", exactly as Delhivery's FAQ
 *     documents. `manifested` = shipments that really exist at "Delhivery".
 *   - a fake WAPLIFY (return notifications); orders carry no email.
 * No ref_ids/ref_nos lookup is used or assumed.
 *
 * The classifier unit tests at the bottom need no DB.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL?.trim());
const skip = HAS_TEST_DB ? false : "TEST_DATABASE_URL not configured — needs a real (non-production) MySQL";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELHIVERY_TIMEOUT_MS = 600;

// mode: ok | slow_ok | timeout_after_create | reset_after_create | 500_after_create
//       | 500_before_create | malformed_200 | reject_400 | reject_200
const delhivery = {
  mode: "ok",
  creates: [], // every create request received
  manifested: new Map(), // reference -> awb (shipments that exist at Delhivery)
  trackRequests: [],
  nextAwb: 58045530000000,
  reset() {
    this.mode = "ok";
    this.creates = [];
    this.manifested = new Map();
    this.trackRequests = [];
  },
};
const waplify = { requests: [] };

let delhiveryServer;
let waplifyServer;
let db;
let returns;
let reverse;

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
    const json = (status, payload) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "POST" && url.pathname === "/api/cmu/create.json") {
      const payload = JSON.parse(new URLSearchParams(body).get("data"));
      const reference = payload.shipments[0].order;
      delhivery.creates.push(reference);
      const mode = delhivery.mode;
      if (mode === "reject_400") return json(400, { rmk: "Invalid pincode" });
      if (mode === "500_before_create") return json(500, { message: "internal" });
      if (mode === "reject_200") {
        return json(200, { success: false, packages: [{ status: "Fail", remarks: ["Non serviceable pincode"] }] });
      }
      if (delhivery.manifested.has(reference)) {
        return json(200, {
          success: false,
          packages: [{ status: "Fail", refnum: reference, remarks: ["Duplicate order id"] }],
        });
      }
      const waybill = String(delhivery.nextAwb++);
      delhivery.manifested.set(reference, waybill); // the shipment now EXISTS
      if (mode === "slow_ok") await sleep(200);
      if (mode === "timeout_after_create") {
        await sleep(DELHIVERY_TIMEOUT_MS * 3);
        return json(200, { success: true, packages: [{ waybill, status: "Success" }] });
      }
      if (mode === "reset_after_create") return req.socket.destroy();
      if (mode === "500_after_create") return json(502, { message: "bad gateway" });
      if (mode === "malformed_200") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(`{"success": true, "packages": [{"waybill": "${waybill}"`); // truncated JSON
      }
      return json(200, { success: true, packages: [{ waybill, status: "Success", refnum: reference }] });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/packages/json/") {
      delhivery.trackRequests.push(url.searchParams.get("waybill"));
      return json(200, {
        ShipmentData: [{ Shipment: { AWB: url.searchParams.get("waybill"), Status: { Status: "Scheduled", StatusType: "PP", StatusDateTime: "2026-09-29T10:00:00" } } }],
      });
    }
    json(404, { message: "unexpected" });
  });
  await new Promise((r) => delhiveryServer.listen(0, "127.0.0.1", r));

  waplifyServer = http.createServer(async (req, res) => {
    waplify.requests.push(JSON.parse((await readBody(req)) || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "success", message_id: `wamid-${waplify.requests.length}` }));
  });
  await new Promise((r) => waplifyServer.listen(0, "127.0.0.1", r));

  Object.assign(process.env, {
    DELHIVERY_BASE_URL: `http://127.0.0.1:${delhiveryServer.address().port}`,
    DELHIVERY_API_TOKEN: "test-fake-delhivery-token",
    DELHIVERY_TIMEOUT: String(DELHIVERY_TIMEOUT_MS),
    DELHIVERY_PICKUP_LOCATION: "BREE-TEST-WAREHOUSE",
    DELHIVERY_BOTTLE_WEIGHT_KG: "0.02",
    WAREHOUSE_NAME: "BREE Test Warehouse",
    WAREHOUSE_ADDRESS: "Plot 7, Test Industrial Area",
    WAREHOUSE_CITY: "Chennai",
    WAREHOUSE_STATE: "Tamil Nadu",
    WAREHOUSE_PINCODE: "600001",
    WAREHOUSE_PHONE: "9000000000",
    WAPLIFY_BASE_URL: `http://127.0.0.1:${waplifyServer.address().port}`,
    WAPLIFY_API_KEY: "wapl_test_only",
    WAPLIFY_TEMPLATE_ORDER_STATUS: "order_status_test",
  });

  db = await import("../src/config/database.js");
  await db.ensureOrderShippingAddressColumns();
  await db.ensureOrderShipmentColumns();
  const { rows } = await db.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'orders'`,
  );
  const have = new Set(rows.map((r) => r.c));
  for (const [column, definition] of [
    ["shipment_id", "VARCHAR(255) NULL"],
    ["tracking_number", "VARCHAR(255) NULL"],
    ["shipment_created_at", "DATETIME NULL"],
    ["pickup_request_id", "VARCHAR(255) NULL"],
    ["tracking_sync_last_failure_at", "DATETIME NULL"],
    ["notes", "TEXT NULL"],
  ]) {
    if (!have.has(column)) await db.query(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
  }
  await db.ensureOrderReturnColumns();
  await db.ensurePackageProductColumns();
  await db.ensureOrderBulkColumns();
  await db.ensurePackageOrderColumns();

  returns = await import("../src/controllers/admin/returnController.js");
  reverse = await import("../src/services/reverseShipmentTracking.js");
  assert.match(process.env.DELHIVERY_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
});

after(async () => {
  if (db) await db.closePool();
  for (const s of [delhiveryServer, waplifyServer]) if (s) await new Promise((r) => s.close(r));
});

beforeEach(async () => {
  if (!HAS_TEST_DB) return;
  delhivery.reset();
  waplify.requests = [];
  for (const t of ["order_status_notifications", "order_status_history", "order_items", "daily_reminders", "orders"]) {
    await db.query(`DELETE FROM ${t}`);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(c) {
    this.statusCode = c;
    return this;
  },
  json(b) {
    this.body = b;
    return this;
  },
});
const create = async (orderId, body = {}, deps) => {
  const res = makeRes();
  await returns.createReverseShipment(
    { params: { orderId }, body, admin: { id: null }, app: { locals: {} } },
    res,
    deps,
  );
  return res;
};
let seq = 0;
const seedApprovedReturn = async () => {
  seq += 1;
  const id = randomUUID();
  const orderNumber = `BREE-H4${String(seq).padStart(4, "0")}`;
  await db.query(
    `INSERT INTO orders (id, order_number, order_status, payment_status, razorpay_payment_id, total,
       contact_name, contact_phone, shipping_address_line1, shipping_city, shipping_state, shipping_pincode,
       shipping_country, awb_number, tracking_status, delivered_at)
     VALUES (?, ?, 'delivered', 'paid', ?, 950, 'Asha Test', '9876500010', '12 MG Road', 'Bengaluru',
       'Karnataka', '560001', 'India', ?, 'Delivered', ?)`,
    [id, orderNumber, `pay_${randomUUID().slice(0, 8)}`, `FWD-H4-${seq}`, new Date(Date.now() - 3600 * 1000)],
  );
  await db.query(
    `INSERT INTO order_items (id, order_id, product_id, product_name, product_price, quantity, subtotal)
     VALUES (?, ?, ?, 'Amla 7 Day', 950, 1, 950)`,
    [randomUUID(), id, randomUUID()],
  );
  const res = makeRes();
  await returns.approveReturn({ params: { orderId: id }, body: { reason: "Quality Issue" }, admin: { id: null }, app: { locals: {} } }, res);
  assert.equal(res.statusCode, 200);
  return { id, orderNumber, reference: `${orderNumber}-RETURN` };
};
const row = async (id) => (await db.query(`SELECT * FROM orders WHERE id = ?`, [id])).rows[0];
const notificationKeys = async (id) =>
  (await db.query(`SELECT notification_key FROM order_status_notifications WHERE notification_key LIKE ?`, [`order:${id}:%`])).rows.map(
    (r) => r.notification_key,
  );

// Asserts the uncertain state is recorded, the return state machine is
// untouched, and a retry is refused WITHOUT calling Delhivery.
const assertUncertainAndBlocked = async (o, res, { expectAwbPreserved = null } = {}) => {
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "REVERSE_SHIPMENT_OUTCOME_UNCERTAIN");
  assert.match(res.body.message, /Unable to confirm/);
  assert.match(res.body.message, /not a confirmed failure/);
  assert.doesNotMatch(res.body.message, /failed|try again/i, "must not read as a definite failure / invite a retry");
  assert.ok(res.body.message.includes(o.reference));

  let r = await row(o.id);
  assert.equal(r.reverse_shipment_create_status, "uncertain");
  assert.equal(r.reverse_shipment_reference, o.reference);
  assert.ok(r.reverse_shipment_create_attempted_at instanceof Date);
  assert.ok(r.reverse_shipment_create_error);
  assert.equal(r.reverse_awb, null);
  assert.equal(r.return_status, "approved", "reverse tracking state machine untouched");
  if (expectAwbPreserved) assert.equal(r.reverse_shipment_unconfirmed_awb, expectAwbPreserved);

  const createsBefore = delhivery.creates.length;
  delhivery.mode = "ok";
  const retry = await create(o.id);
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.body.code, "REVERSE_SHIPMENT_OUTCOME_UNCERTAIN");
  assert.equal(delhivery.creates.length, createsBefore, "a retry never calls Delhivery while the outcome is uncertain");
  assert.equal([...delhivery.manifested.keys()].filter((k) => k === o.reference).length <= 1, true);
  r = await row(o.id);
  assert.equal(r.reverse_awb, null);
  await sleep(100);
  assert.ok(!(await notificationKeys(o.id)).some((k) => k.includes("return_shipment_created")), "no 'shipment created' notification");
};

// ════════════════════════════════════════════════════════════════════════════
test("successful response → AWB saved, diagnostics clear, one Delhivery shipment, one notification", { skip }, async () => {
  const o = await seedApprovedReturn();
  const res = await create(o.id);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const r = await row(o.id);
  assert.equal(r.reverse_awb, res.body.delhivery.awb);
  assert.equal(r.return_status, "reverse_shipment_created");
  assert.equal(r.reverse_shipment_create_status, null);
  assert.equal(r.reverse_shipment_unconfirmed_awb, null);
  assert.equal(delhivery.creates.length, 1);
  assert.equal(delhivery.manifested.size, 1);
  const shipmentKeys = async () => (await notificationKeys(o.id)).filter((k) => k.includes("return_shipment_created"));
  for (let i = 0; i < 100 && (await shipmentKeys()).length < 1; i++) await sleep(20);
  await sleep(100);
  assert.equal((await shipmentKeys()).length, 1, "exactly one 'shipment created' notification (WhatsApp; order has no email)");
});

test("timeout after Delhivery created the shipment → uncertain (not a failure), retry blocked, exactly one shipment", { skip }, async () => {
  const o = await seedApprovedReturn();
  delhivery.mode = "timeout_after_create";
  const res = await create(o.id);
  assert.equal(delhivery.manifested.size, 1, "the shipment exists at Delhivery");
  await assertUncertainAndBlocked(o, res);
  assert.equal(delhivery.creates.length, 1);
});

test("connection reset after creation → uncertain, retry blocked, exactly one shipment", { skip }, async () => {
  const o = await seedApprovedReturn();
  delhivery.mode = "reset_after_create";
  const res = await create(o.id);
  await assertUncertainAndBlocked(o, res);
  assert.equal(delhivery.creates.length, 1);
  assert.equal(delhivery.manifested.size, 1);
});

test("5xx after creation → uncertain, retry blocked, exactly one shipment", { skip }, async () => {
  const o = await seedApprovedReturn();
  delhivery.mode = "500_after_create";
  const res = await create(o.id);
  await assertUncertainAndBlocked(o, res);
  assert.equal(delhivery.creates.length, 1);
  assert.equal(delhivery.manifested.size, 1);
});

test("malformed 200 response (truncated JSON) → uncertain, retry blocked, exactly one shipment", { skip }, async () => {
  const o = await seedApprovedReturn();
  delhivery.mode = "malformed_200";
  const res = await create(o.id);
  await assertUncertainAndBlocked(o, res);
  assert.equal(delhivery.creates.length, 1);
});

test("DB failure after the AWB was received → AWB logged BEFORE the write, preserved on the order, retry blocked, no second shipment", { skip }, async () => {
  const o = await seedApprovedReturn();
  const sequence = [];
  const origLog = console.log;
  console.log = (...args) => {
    if (String(args[0]).includes("return.reverse_shipment_awb_received")) sequence.push(["log", JSON.parse(args[0]).awb]);
    return origLog(...args);
  };
  const failingClient = async () => {
    const real = await db.getClient();
    const wrappedQuery = async (sql, params) => {
      if (/UPDATE orders\s+SET reverse_awb = \?/.test(sql)) {
        sequence.push(["update"]);
        throw Object.assign(new Error("Lost connection to MySQL server during query"), { code: "PROTOCOL_CONNECTION_LOST" });
      }
      return real.query(sql, params);
    };
    return { query: wrappedQuery, release: () => real.release() };
  };
  let res;
  try {
    res = await create(o.id, {}, { getClientFn: failingClient });
  } finally {
    console.log = origLog;
  }
  const awb = delhivery.manifested.get(o.reference);
  assert.ok(awb);
  assert.deepEqual(sequence, [["log", awb], ["update"]], "AWB logged before the DB write that failed");
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "REVERSE_SHIPMENT_AWB_NOT_SAVED");
  assert.ok(res.body.message.includes(awb));
  assert.match(res.body.message, /Do NOT create it again/);

  // Same checks as every other uncertain outcome (retry uses the real client).
  const r = await row(o.id);
  assert.equal(r.reverse_shipment_create_status, "uncertain");
  assert.equal(r.reverse_shipment_unconfirmed_awb, awb);
  const retry = await create(o.id);
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.body.reverseShipment.unconfirmedAwb, awb);
  assert.equal(delhivery.creates.length, 1);
  assert.equal((await row(o.id)).reverse_awb, null);
});

test("concurrent admin clicks (success) → one Delhivery create, both get the same AWB (FOR UPDATE)", { skip }, async () => {
  const o = await seedApprovedReturn();
  delhivery.mode = "slow_ok";
  const [a, b] = await Promise.all([create(o.id), create(o.id)]);
  assert.deepEqual([a.statusCode, b.statusCode], [200, 200]);
  assert.equal(a.body.delhivery.awb, b.body.delhivery.awb);
  assert.equal(delhivery.creates.length, 1);
});

test("concurrent admin clicks (uncertain) → one Delhivery create; the waiting click sees 'uncertain' and never calls Delhivery", { skip }, async () => {
  const o = await seedApprovedReturn();
  delhivery.mode = "timeout_after_create";
  const [a, b] = await Promise.all([create(o.id), create(o.id)]);
  assert.deepEqual([a.statusCode, b.statusCode], [409, 409]);
  assert.equal(delhivery.creates.length, 1);
  assert.equal(delhivery.manifested.size, 1);
});

test("confirmed failures (HTTP 400; 200 with a package-level 'Fail') → recorded 'failed', described as nothing created, and a retry IS allowed", { skip }, async () => {
  for (const mode of ["reject_400", "reject_200"]) {
    const o = await seedApprovedReturn();
    delhivery.reset();
    delhivery.mode = mode;
    const res = await create(o.id);
    assert.equal(res.statusCode, 400, mode);
    assert.equal(res.body.code, "REVERSE_SHIPMENT_REJECTED");
    assert.match(res.body.message, /Nothing was created/);
    const r = await row(o.id);
    assert.equal(r.reverse_shipment_create_status, "failed");
    assert.equal(r.return_status, "approved");

    delhivery.mode = "ok";
    const retry = await create(o.id);
    assert.equal(retry.statusCode, 200, `${mode} retry`);
    assert.equal((await row(o.id)).reverse_shipment_create_status, null);
    assert.equal(delhivery.manifested.size, 1);
  }
});

test("audited unblock: only an explicit confirmation re-enables creation — and even then Delhivery's reference dedupe prevents a duplicate", { skip }, async () => {
  // (a) The first attempt DID create it: confirming wrongly still cannot duplicate.
  const created = await seedApprovedReturn();
  delhivery.mode = "timeout_after_create";
  await create(created.id);
  delhivery.mode = "ok";
  assert.equal((await create(created.id, { confirmedNotCreated: true })).statusCode, 409, "notes are required");
  const wrongConfirm = await create(created.id, { confirmedNotCreated: true, notes: "Checked panel" });
  assert.equal(wrongConfirm.statusCode, 409, "Duplicate order id → uncertain again");
  assert.equal(delhivery.manifested.size, 1, "still exactly one shipment");

  // (b) The first attempt did NOT create it: confirmation lets it proceed.
  const notCreated = await seedApprovedReturn();
  delhivery.mode = "500_before_create";
  assert.equal((await create(notCreated.id)).statusCode, 409);
  delhivery.mode = "ok";
  const ok = await create(notCreated.id, { confirmedNotCreated: true, notes: "Delhivery support confirmed no shipment" });
  assert.equal(ok.statusCode, 200);
  assert.equal((await row(notCreated.id)).reverse_shipment_create_status, null);
  await sleep(100);
  const history = (await db.query(`SELECT notes FROM order_status_history WHERE order_id = ?`, [notCreated.id])).rows.map((r) => r.notes);
  assert.ok(history.some((n) => /Admin confirmed Delhivery has NO shipment/.test(n)));
});

test("reverse tracking is unchanged: an uncertain order (no reverse_awb) is never tracked; a created one is", { skip }, async () => {
  const uncertain = await seedApprovedReturn();
  delhivery.mode = "500_after_create";
  await create(uncertain.id);
  const good = await seedApprovedReturn();
  delhivery.mode = "ok";
  const created = await create(good.id);
  await reverse.syncReverseShipmentTracking({ notify: () => {} });
  assert.deepEqual(delhivery.trackRequests, [created.body.delhivery.awb]);
  assert.equal((await row(uncertain.id)).return_status, "approved");
  assert.equal((await row(good.id)).return_status, "pickup_scheduled");
});

// ── Classifier (no DB) ───────────────────────────────────────────────────────
test("classifier: which outcomes are uncertain vs confirmed failures", async () => {
  const { classifyReverseShipmentCreateOutcome: c } = await import("../src/controllers/admin/returnController.js");
  const U = "uncertain";
  const F = "failed";
  // thrown by delhiveryService.handleError
  assert.equal(c({ error: { success: false, message: "No response received from Delhivery.", code: "ECONNABORTED" } }).outcome, U);
  assert.equal(c({ error: { success: false, message: "No response received from Delhivery.", code: "ECONNRESET" } }).outcome, U);
  assert.equal(c({ error: { success: false, message: "socket hang up" } }).outcome, U);
  for (const status of [500, 502, 503, 504]) assert.equal(c({ error: { status, message: "x" } }).outcome, U, String(status));
  for (const status of [400, 401, 403, 422]) assert.equal(c({ error: { status, message: "x" } }).outcome, F, String(status));
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) assert.equal(c({ error: { code } }).outcome, F, code);
  // resolved responses
  assert.equal(c({ response: '{"success": true, "packages": [' }).outcome, U, "malformed JSON string");
  assert.equal(c({ response: null }).outcome, U);
  assert.equal(c({ response: { success: false, packages: [{ status: "Fail", remarks: ["Duplicate order id"] }] } }).outcome, U);
  assert.equal(c({ response: { success: false, packages: [{ status: "Fail", remarks: ["Non serviceable pincode"] }] } }).outcome, F);
  assert.equal(c({ response: { success: false, error: true, rmk: "An internal Error has occurred", packages: [] } }).outcome, U);
  assert.equal(c({ response: { success: true, packages: [{ waybill: "1", status: "Success" }] } }), null);
});
