import test from "node:test";
import assert from "node:assert/strict";

process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";
process.env.DELHIVERY_PICKUP_LOCATION ||= "BREE FIT";
process.env.WAREHOUSE_CITY ||= "Hyderabad";
process.env.WAREHOUSE_STATE ||= "Telangana";
process.env.WAREHOUSE_PINCODE ||= "500001";
process.env.WAREHOUSE_ADDRESS ||= "Warehouse Road";

const {
  createShipment,
  trackShipment,
  schedulePickup,
  cancelShipment,
  mapTrackingStatusToOrderStatus,
  isForwardOrderStatusTransition,
  isCancelledShipment,
} = await import("../src/controllers/shippingController.js");
const { ACTIVE_FORWARD_SHIPMENTS_WHERE } = await import(
  "../cron/shippingTrackingCron.js"
);

/**
 * PRODUCTION INCIDENT — BREE-100019 (order 0efc2f64-ab4f-4462-8cc2-
 * 202a9c80012d, AWB 58045510000055). Verified read-only against the live
 * order + Delhivery tracking:
 *   18:57:09  createShipment → order_status "shipped" while Delhivery only
 *             had "Manifested" (X-UCI, manifest uploaded) — nothing picked up.
 *   19:18:06  Cancel Shipment → order_status "cancelled", tracking
 *             "Cancelled"; Delhivery now reports the AWB as "Not Picked"
 *             (X-PNP) — never "Cancelled".
 *   ≤19:30    a tracking sync wrote "Not Picked" over "Cancelled", which
 *             put the cancelled order back into the 30-minute tracking cron.
 * Drives the real controllers against fake DB clients / Delhivery.
 */

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

const norm = (sql) => sql.replace(/\s+/g, " ").trim();

const createFakeDb = (initialOrder) => {
  const order = { ...initialOrder };
  const history = [];
  const updates = [];

  const client = {
    query: async (sql, params = []) => {
      const q = norm(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [], rowCount: 0 };

      if (q.startsWith("SELECT") && q.includes("FROM orders") && !q.includes("order_items")) {
        return { rows: [{ ...order }], rowCount: 1 };
      }
      if (q.includes("FROM order_items")) {
        return q.startsWith("SELECT COALESCE(SUM(quantity)")
          ? { rows: [{ total_quantity: 1 }], rowCount: 1 }
          : {
              rows: [
                {
                  id: "item-1",
                  product_id: "prod-1",
                  product_name: "Wellness Shot",
                  product_price: 500,
                  quantity: 1,
                  pack_bottle_count: 1,
                  is_recurring_package: 0,
                },
              ],
              rowCount: 1,
            };
      }
      if (q.startsWith("UPDATE orders SET")) {
        updates.push({ sql: q, params });
        const setClause = q.slice("UPDATE orders SET ".length, q.lastIndexOf(" WHERE "));
        const columns = setClause
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.endsWith("= ?"))
          .map((part) => part.replace(/\s*=\s*\?$/, ""));
        columns.forEach((column, index) => {
          order[column] = params[index];
        });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("INSERT INTO order_status_history")) {
        history.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unhandled fake SQL in forwardShipmentStatus test: ${q}`);
    },
    release: () => {},
  };

  return { getClientFn: async () => client, order, history, updates };
};

const BREE_100019 = {
  id: "0efc2f64-ab4f-4462-8cc2-202a9c80012d",
  order_number: "BREE-100019",
  user_id: "user-1",
  address_id: null,
  payment_status: "paid",
  // No contact_email/phone → notification senders only log, never send.
  contact_name: "Test Customer",
  contact_email: "",
  contact_phone: "9000000000",
  shipping_address_line1: "1 Test Street",
  shipping_address_line2: "",
  shipping_city: "Hyderabad",
  shipping_state: "Telangana",
  shipping_pincode: "500081",
  shipping_country: "India",
  subtotal: 500,
  total: 500,
  is_bulk_order: 0,
  parent_package_id: null,
  fulfillment_cycle: null,
  awb_number: null,
  shipment_id: null,
  tracking_number: null,
  tracking_url: null,
  tracking_status: null,
  pickup_request_id: null,
  shipment_created_at: null,
  delhivery_response: null,
  order_status: "ready_to_ship",
};

const trackingResponse = (status, statusCode) => ({
  ShipmentData: [
    {
      Shipment: {
        AWB: "58045510000055",
        Status: {
          Status: status,
          StatusCode: statusCode,
          StatusType: "UD",
          StatusDateTime: "2026-09-30T19:18:06.381",
          StatusLocation: "Hyderabad_Bownplly1_C (Telangana)",
          Instructions: "Shipment not received from client",
        },
        Scans: [],
      },
    },
  ],
});

// ── 3. Forward status mapping ───────────────────────────────────────────

test("createShipment (AWB generated / Manifested) keeps the order ready_to_ship — never 'shipped'", async () => {
  const db = createFakeDb(BREE_100019);
  let delhiveryCalls = 0;
  const res = makeRes();

  await createShipment({ params: { orderId: BREE_100019.id }, body: {}, app: {} }, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: {
      createShipment: async () => {
        delhiveryCalls += 1;
        return {
          success: true,
          upload_wbn: "UPL123",
          packages: [{ waybill: "58045510000055", status: "Success", remarks: [] }],
        };
      },
    },
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(delhiveryCalls, 1);
  assert.equal(db.order.order_status, "ready_to_ship");
  assert.equal(db.order.tracking_status, "Manifested");
  assert.equal(db.order.awb_number, "58045510000055");
  assert.equal(res.body.order.status, "ready_to_ship");
  assert.ok(
    db.updates.every((u) => !/order_status/.test(u.sql)),
    "shipment creation must not write order_status",
  );
  assert.equal(db.history.length, 1);
  assert.ok(db.history[0].includes("ready_to_ship"));
  assert.ok(!db.history[0].includes("shipped"));
});

test("pre-pickup Delhivery statuses (Manifested, Not Picked, Pickup Scheduled) never map to BREE 'shipped'", () => {
  for (const status of ["Manifested", "Not Picked", "Pickup Scheduled", "Pickup Pending", " MANIFESTED "]) {
    assert.equal(mapTrackingStatusToOrderStatus(status), null, status);
  }
});

test("only picked-up / in-transit statuses map to 'shipped'; later statuses unchanged", () => {
  for (const status of ["Picked Up", "In Transit", "Pending", "Dispatched"]) {
    assert.equal(mapTrackingStatusToOrderStatus(status), "shipped", status);
  }
  assert.equal(mapTrackingStatusToOrderStatus("Out for delivery"), "out_for_delivery");
  assert.equal(mapTrackingStatusToOrderStatus("Delivered"), "delivered");
  assert.equal(isForwardOrderStatusTransition("ready_to_ship", "shipped"), true);
});

test("automatic sync: ready_to_ship + 'Not Picked' (failed pickup) → no change; + 'In Transit' → shipped", async () => {
  const notPicked = createFakeDb({
    ...BREE_100019,
    awb_number: "58045510000055",
    tracking_status: "Manifested",
  });
  const res1 = makeRes();
  await trackShipment({ params: { awb: "58045510000055" }, app: {} }, res1, {
    getClientFn: notPicked.getClientFn,
    delhiveryServiceFn: { trackShipment: async () => trackingResponse("Not Picked", "X-PNP") },
  });
  assert.equal(res1.statusCode, 200);
  assert.equal(notPicked.order.order_status, "ready_to_ship");
  assert.equal(notPicked.order.tracking_status, "Not Picked", "tracking text still synced");
  assert.equal(notPicked.history.length, 0);

  const inTransit = createFakeDb({
    ...BREE_100019,
    awb_number: "58045510000055",
    tracking_status: "Manifested",
  });
  const res2 = makeRes();
  await trackShipment({ params: { awb: "58045510000055" }, app: {} }, res2, {
    getClientFn: inTransit.getClientFn,
    delhiveryServiceFn: { trackShipment: async () => trackingResponse("In Transit", "X-PPOM") },
  });
  // (trackShipment's history row goes through the module's real DB helper,
  // outside the injected client — unchanged behavior — so only the status
  // transition itself is asserted here.)
  assert.equal(inTransit.order.order_status, "shipped");
  assert.equal(inTransit.order.tracking_status, "In Transit");
});

// ── 4. Cancelled shipments are not active shipments ─────────────────────

const CANCELLED_BREE_100019 = {
  ...BREE_100019,
  order_status: "cancelled",
  awb_number: "58045510000055",
  // Production state after the sync overwrote "Cancelled".
  tracking_status: "Not Picked",
};

test("BREE-100019 as stored in production (cancelled + 'Not Picked') is a cancelled shipment, excluded from the cron", () => {
  assert.equal(isCancelledShipment(CANCELLED_BREE_100019), true);
  assert.equal(isCancelledShipment({ order_status: "shipped", tracking_status: "Cancelled" }), true);
  assert.equal(isCancelledShipment({ order_status: "ready_to_ship", tracking_status: "Manifested" }), false);
  assert.match(ACTIVE_FORWARD_SHIPMENTS_WHERE, /order_status, ''\) <> 'cancelled'/);
  assert.match(ACTIVE_FORWARD_SHIPMENTS_WHERE, /NOT IN \('delivered', 'cancelled', 'returned'\)/);
});

test("manual Track Shipment on a cancelled shipment returns live data but never overwrites the DB", async () => {
  const db = createFakeDb({ ...CANCELLED_BREE_100019, tracking_status: "Cancelled" });
  const res = makeRes();
  await trackShipment({ params: { awb: "58045510000055" }, app: {} }, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: { trackShipment: async () => trackingResponse("Not Picked", "X-PNP") },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.shipmentCancelled, true);
  assert.equal(res.body.tracking.trackingStatus, "Not Picked");
  assert.equal(db.updates.length, 0, "cancelled shipment must not be written back");
  assert.equal(db.order.tracking_status, "Cancelled");
  assert.equal(db.order.order_status, "cancelled");
});

test("Cancel Shipment on an order already cancelled (tracking text overwritten) does not call Delhivery again", async () => {
  const db = createFakeDb(CANCELLED_BREE_100019);
  let calls = 0;
  const res = makeRes();
  await cancelShipment({ params: { orderId: BREE_100019.id }, body: {}, app: {} }, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: { cancelShipment: async () => { calls += 1; return {}; } },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /already been cancelled/);
  assert.equal(calls, 0);
});

// ── Pickup still schedulable from the new post-AWB state ────────────────

test("Schedule Pickup works from ready_to_ship + AWB, and is refused for a cancelled order", async () => {
  const ready = createFakeDb({ ...BREE_100019, awb_number: "58045510000055", tracking_status: "Manifested" });
  let calls = 0;
  const delhivery = {
    requestPickup: async () => {
      calls += 1;
      return { success: true, pickup_id: 12345 };
    },
  };
  const res = makeRes();
  await schedulePickup({ params: { orderId: BREE_100019.id }, body: {}, app: {} }, res, {
    getClientFn: ready.getClientFn,
    delhiveryServiceFn: delhivery,
    nowFn: () => new Date("2026-09-30T13:31:00Z"), // 19:01 IST
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls, 1);
  assert.equal(ready.order.pickup_request_id, 12345);
  assert.equal(ready.order.order_status, "ready_to_ship", "pickup scheduled is still not shipped");

  const cancelled = createFakeDb(CANCELLED_BREE_100019);
  const res2 = makeRes();
  await schedulePickup({ params: { orderId: BREE_100019.id }, body: {}, app: {} }, res2, {
    getClientFn: cancelled.getClientFn,
    delhiveryServiceFn: delhivery,
    nowFn: () => new Date("2026-09-30T13:31:00Z"),
  });
  assert.equal(res2.statusCode, 400);
  assert.equal(calls, 1);
});
