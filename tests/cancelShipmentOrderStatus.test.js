import test from "node:test";
import assert from "node:assert/strict";
import { cancelShipment } from "../src/controllers/shippingController.js";

/**
 * PHASE 3 — Medium Issue #19: cancelShipment used to update only
 * tracking_status = 'Cancelled', leaving order_status wherever it was
 * before (e.g. still 'shipped') — a cancelled shipment could coexist
 * indefinitely with an order_status the rest of the app still treats as
 * actively shipping. Fixed to also set order_status = 'cancelled' in the
 * same UPDATE, and to record that as the real transition in
 * order_status_history (previously logged previousStatus === newStatus,
 * i.e. no actual transition at all).
 *
 * Drives the REAL cancelShipment function (not a regex over the source)
 * against a fake single-connection transactional client and a fake
 * Delhivery client. No production database, no real Delhivery call.
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
          "SELECT id, order_number, order_status, tracking_status, awb_number, contact_name, contact_email FROM orders WHERE id = ? LIMIT 1",
        )
      ) {
        const [id] = params;
        const row = orders.get(id);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      if (
        normalized.startsWith(
          "UPDATE orders SET tracking_status = ?, order_status = ?, delhivery_response = ?, updated_at = NOW() WHERE id = ?",
        )
      ) {
        const [trackingStatus, orderStatus, delhiveryResponse, id] = params;
        const row = orders.get(id);
        if (row) {
          row.tracking_status = trackingStatus;
          row.order_status = orderStatus;
          row.delhivery_response = delhiveryResponse;
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      if (normalized.startsWith("INSERT INTO order_status_history")) {
        const [orderId, previousStatus, newStatus, changedBy, notes] = params;
        history.push({ orderId, previousStatus, newStatus, changedBy, notes });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled fake SQL in cancelShipmentOrderStatus test: ${normalized}`);
    },
    release: () => {},
  });

  return { getClientFn: async () => makeClient(), orders, history };
};

const makeReqRes = (orderId) => {
  const req = { params: { orderId }, app: {} };
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
  id: "order-cancel-1",
  order_number: "BRE-7001",
  order_status: "shipped",
  tracking_status: "In Transit",
  awb_number: "AWB999888777",
  contact_name: "Test Customer",
  // Deliberately no contact_email — sendShipmentCancelledEmail then no-ops
  // instead of attempting a real SMTP send (see orderEmailService.js's
  // sendEmail: `if (!to) return;`).
  ...overrides,
});

const fakeDelhiveryService = (response = { success: true }) => ({
  cancelShipment: async () => response,
});

test("ISSUE-019: cancelling a shipment also transitions order_status to 'cancelled', not just tracking_status", async () => {
  const db = createFakeOrdersDb(baseOrder());
  const { req, res } = makeReqRes("order-cancel-1");

  await cancelShipment(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: fakeDelhiveryService(),
  });

  assert.equal(res.body.success, true);
  const finalOrder = db.orders.get("order-cancel-1");
  assert.equal(finalOrder.tracking_status, "Cancelled");
  assert.equal(
    finalOrder.order_status,
    "cancelled",
    "order_status must transition to 'cancelled' too — it must never be left as 'shipped' while tracking_status is 'Cancelled'",
  );
});

test("ISSUE-019: the recorded status-history entry reflects the REAL transition (shipped -> cancelled), not previousStatus === newStatus", async () => {
  const db = createFakeOrdersDb(baseOrder({ order_status: "shipped" }));
  const { req, res } = makeReqRes("order-cancel-1");

  await cancelShipment(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: fakeDelhiveryService(),
  });

  assert.equal(db.history.length, 1);
  assert.equal(db.history[0].previousStatus, "shipped");
  assert.equal(db.history[0].newStatus, "cancelled");
});

test("ISSUE-019 regression: a shipment already delivered is still refused (unaffected by this fix)", async () => {
  const db = createFakeOrdersDb(baseOrder({ tracking_status: "Delivered", order_status: "delivered" }));
  const { req, res } = makeReqRes("order-cancel-1");

  await cancelShipment(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: fakeDelhiveryService(),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(db.orders.get("order-cancel-1").order_status, "delivered");
});

test("ISSUE-019 regression: a Delhivery API failure rolls back and leaves order_status untouched", async () => {
  const db = createFakeOrdersDb(baseOrder({ order_status: "shipped" }));
  const { req, res } = makeReqRes("order-cancel-1");

  await cancelShipment(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: { cancelShipment: async () => { throw new Error("Delhivery outage"); } },
  });

  assert.equal(res.statusCode, 500);
  assert.equal(db.orders.get("order-cancel-1").order_status, "shipped");
  assert.equal(db.history.length, 0);
});
