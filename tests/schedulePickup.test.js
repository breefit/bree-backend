import test from "node:test";
import assert from "node:assert/strict";

process.env.DELHIVERY_PICKUP_LOCATION ||= "BREE FIT";

const { schedulePickup } = await import("../src/controllers/shippingController.js");

/**
 * LIVE PRODUCTION VERIFICATION — Issue 1 (Schedule Pickup false negative).
 *
 * Root cause: hasPickupShipmentReference() used to require BOTH awb_number
 * AND shipment_id before allowing a pickup request. Delhivery's real
 * /api/cmu/create.json success response never returns a shipment_id/id
 * field on the package object (only `waybill`) — confirmed against the
 * live incident: order 24bbb460-d437-4ab2-bb4e-449dddc776c1 got AWB
 * 58045510000033 persisted (createShipment succeeded, packing-slip
 * download by AWB succeeded), yet shipment_id was never populated, so
 * schedulePickup incorrectly rejected it with "No AWB/shipment found".
 *
 * Fixed to require only awb_number — the same identifier every other
 * Delhivery-facing check in this file (downloadShippingLabel,
 * cancelShipment, trackShipment) already keys off.
 *
 * Drives the REAL schedulePickup function (not a regex over the source)
 * against a fake single-connection transactional client and a fake
 * Delhivery client, following the same pattern as
 * tests/cancelShipmentOrderStatus.test.js. No production database, no
 * real Delhivery call.
 */

const createFakeOrdersDb = (initialOrder) => {
  const orders = new Map([[initialOrder.id, { ...initialOrder }]]);
  const history = [];

  const makeClient = () => ({
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      if (
        normalized.startsWith(
          "SELECT id, order_number, order_status, tracking_status, awb_number, shipment_id, pickup_request_id, shipment_created_at FROM orders WHERE id = ?",
        )
      ) {
        const [id] = params;
        const row = orders.get(id);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      if (
        normalized.startsWith(
          "SELECT COALESCE(SUM(quantity), 1) AS total_quantity FROM order_items WHERE order_id = ?",
        )
      ) {
        return { rows: [{ total_quantity: 1 }], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE orders SET pickup_request_id = ?")) {
        const [pickupRequestId, trackingStatus, delhiveryResponse, id] = params;
        const row = orders.get(id);
        if (row) {
          row.pickup_request_id = pickupRequestId;
          row.tracking_status = trackingStatus;
          row.delhivery_response = delhiveryResponse;
          if (normalized.includes("shipment_created_at = NOW()")) {
            row.shipment_created_at = "2026-09-21T00:00:00.000Z";
          }
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      if (normalized.startsWith("INSERT INTO order_status_history")) {
        const [orderId, previousStatus, newStatus, changedBy, notes] = params;
        history.push({ orderId, previousStatus, newStatus, changedBy, notes });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled fake SQL in schedulePickup test: ${normalized}`);
    },
    release: () => {},
  });

  return { getClientFn: async () => makeClient(), orders, history };
};

const makeReqRes = (orderId, body = {}) => {
  const req = { params: { orderId }, body, app: {} };
  const res = {
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
  };
  return { req, res };
};

const baseOrder = (overrides = {}) => ({
  id: "order-pickup-1",
  order_number: "BRE-8001",
  order_status: "shipped",
  tracking_status: "Manifested",
  awb_number: "58045510000033",
  shipment_id: null, // Delhivery's real response never populates this — see root-cause comment above.
  pickup_request_id: null,
  shipment_created_at: "2026-09-21T00:00:00.000Z",
  ...overrides,
});

const fakeDelhiveryService = (
  response = { success: true, request_id: "PICKUP-999" },
) => {
  let calls = 0;
  return {
    requestPickup: async () => {
      calls += 1;
      return response;
    },
    getCallCount: () => calls,
  };
};

test("1. shipment exists + AWB exists (no shipment_id) -> schedule pickup succeeds", async () => {
  const db = createFakeOrdersDb(baseOrder());
  const { req, res } = makeReqRes("order-pickup-1");
  const delhivery = fakeDelhiveryService();

  await schedulePickup(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: delhivery,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.order.pickupRequestId, "PICKUP-999");
  assert.equal(res.body.delhivery.pickupRequestId, "PICKUP-999");
  assert.equal(delhivery.getCallCount(), 1);
  assert.equal(db.orders.get("order-pickup-1").pickup_request_id, "PICKUP-999");
  assert.equal(db.history.length, 1);
});

test("2. shipment does not exist (no AWB) -> clear error, Delhivery never called, no second shipment/AWB attempted", async () => {
  const db = createFakeOrdersDb(baseOrder({ awb_number: null, shipment_id: null }));
  const { req, res } = makeReqRes("order-pickup-1");
  const delhivery = fakeDelhiveryService();

  await schedulePickup(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: delhivery,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Shipment has not been created/i);
  assert.equal(delhivery.getCallCount(), 0, "must never call Delhivery when no shipment exists");
  assert.equal(db.orders.get("order-pickup-1").pickup_request_id, null);
});

test("3. duplicate pickup request -> returns existing pickup, does not create a duplicate pickup or call Delhivery again", async () => {
  const db = createFakeOrdersDb(baseOrder({ pickup_request_id: "PICKUP-EXISTING" }));
  const { req, res } = makeReqRes("order-pickup-1");
  const delhivery = fakeDelhiveryService();

  await schedulePickup(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: delhivery,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.alreadyScheduled, true);
  assert.equal(res.body.pickupRequestId, "PICKUP-EXISTING");
  assert.equal(delhivery.getCallCount(), 0, "must not re-request pickup once pickup_request_id is already stored");
  assert.equal(db.orders.get("order-pickup-1").pickup_request_id, "PICKUP-EXISTING");
});

test("4. existing AWB remains unchanged by a successful pickup scheduling", async () => {
  const db = createFakeOrdersDb(baseOrder());
  const { req, res } = makeReqRes("order-pickup-1");
  const delhivery = fakeDelhiveryService();

  await schedulePickup(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: delhivery,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(
    db.orders.get("order-pickup-1").awb_number,
    "58045510000033",
    "schedulePickup must never modify the existing AWB",
  );
});
