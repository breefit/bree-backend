/**
 * Audit finding 8 — reverse-pickup notifications must reflect the Delhivery
 * state actually observed.
 *
 * Drives the REAL syncReverseShipmentTracking against a stateful in-memory
 * order row (the conditional `UPDATE … WHERE return_status = ?` is modelled,
 * so duplicate polls are real no-ops) and a mocked Delhivery tracking API.
 * The return_status state machine itself is unchanged; only which customer
 * event (if any) a transition produces is under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  syncReverseShipmentTracking,
  customerEventForReverseTransition,
} from "../src/services/reverseShipmentTracking.js";

const ORDER_ID = "rev-order-1";
const AWB = "RVP-AWB-1";

const tracking = (statusType, status) => ({
  ShipmentData: [
    {
      Shipment: {
        AWB,
        Status: { Status: status, StatusType: statusType, StatusDateTime: "2026-10-01T09:30:00" },
        Scans: [],
      },
    },
  ],
});

const makeHarness = () => {
  const order = {
    id: ORDER_ID,
    order_number: "BREE-100030",
    order_status: "delivered",
    return_status: "reverse_shipment_created",
    reverse_awb: AWB,
    reverse_shipment_type: "rvp",
    reverse_tracking_status: null,
    reverse_delivered_at: null,
    reverse_tracking_failure_count: 0,
  };
  const notified = [];
  const history = [];
  let current = null;

  const queryFn = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.includes("FROM orders") && q.includes("reverse_awb IS NOT NULL")) {
      const done = ["delivered_to_bree", "cancelled"].includes(order.reverse_tracking_status);
      return { rows: done ? [] : [{ ...order }] };
    }
    if (q.startsWith("UPDATE orders SET reverse_tracking_status = ?")) {
      const [normalized, raw, , scheduled, pickedUp, delivered] = params;
      order.reverse_tracking_status = normalized;
      order.reverse_tracking_raw_status = raw;
      if (scheduled) order.reverse_pickup_scheduled_at ??= new Date();
      if (pickedUp) order.reverse_picked_up_at ??= new Date();
      if (delivered) order.reverse_delivered_at ??= new Date();
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE orders SET return_status = ?")) {
      const [target, , expected] = params;
      if (order.return_status !== expected) return { rows: [], rowCount: 0 };
      order.return_status = target;
      if (target === "returned") order.inspection_status ??= "pending";
      return { rows: [], rowCount: 1 };
    }
    if (q === "SELECT * FROM orders WHERE id = ? LIMIT 1") return { rows: [{ ...order }] };
    if (q.startsWith("UPDATE orders SET reverse_tracking_failure_count")) return { rows: [], rowCount: 1 };
    throw new Error(`unhandled SQL ${q}`);
  };

  const poll = async (statusType, status) => {
    current = tracking(statusType, status);
    return syncReverseShipmentTracking({
      queryFn,
      trackShipment: async () => current,
      notify: (row, event, ...rest) => notified.push({ event, extraArgs: rest.length }),
      historyFn: async (entry) => history.push(entry.notes),
    });
  };
  return { order, notified, history, poll };
};

const events = (h) => h.notified.map((n) => n.event);

test("first status PP/Open (pickup only requested) → no transition, no customer message", async () => {
  const h = makeHarness();
  await h.poll("PP", "Open");
  assert.equal(h.order.return_status, "reverse_shipment_created");
  assert.deepEqual(events(h), []);
});

test("first status PP/Scheduled → 'Return Pickup Scheduled' once", async () => {
  const h = makeHarness();
  await h.poll("PP", "Scheduled");
  assert.equal(h.order.return_status, "pickup_scheduled");
  assert.deepEqual(events(h), ["Return Pickup Scheduled"]);
  assert.equal(h.notified[0].extraArgs, 0, "no free-text notes argument");
  assert.match(h.history[0], /^Return pickup scheduled by Delhivery/);
});

test("first status PP/Dispatched (courier out for pickup) → 'Return Pickup Scheduled' (still true: pickup is scheduled, not yet done)", async () => {
  const h = makeHarness();
  await h.poll("PP", "Dispatched");
  assert.deepEqual(events(h), ["Return Pickup Scheduled"]);
});

for (const status of ["In Transit", "Pending", "Dispatched"]) {
  test(`first status PU/${status} (already picked up) → state advances as before, but NO false 'Pickup Scheduled' message`, async () => {
    const h = makeHarness();
    await h.poll("PU", status);
    assert.equal(h.order.return_status, "pickup_scheduled", "state machine unchanged");
    assert.ok(h.order.reverse_picked_up_at instanceof Date);
    assert.deepEqual(events(h), [], "no pickup-scheduled (and no unapproved 'picked up') message");
    assert.match(h.history[0], /already picked up when first observed/);
  });
}

test("first status DL/DTO → only 'Return Received'; the missed pickup message is not invented afterwards", async () => {
  const h = makeHarness();
  await h.poll("DL", "DTO");
  assert.equal(h.order.return_status, "returned");
  assert.deepEqual(events(h), ["Return Received"]);
});

test("DL/Delivered (a FORWARD delivery status) is never treated as received", async () => {
  const h = makeHarness();
  await h.poll("DL", "Delivered");
  assert.equal(h.order.return_status, "reverse_shipment_created");
  assert.deepEqual(events(h), []);
});

test("duplicate polling of the same status sends nothing extra", async () => {
  const h = makeHarness();
  await h.poll("PP", "Scheduled");
  await h.poll("PP", "Scheduled");
  await h.poll("PP", "Scheduled");
  assert.deepEqual(events(h), ["Return Pickup Scheduled"]);
  await h.poll("DL", "DTO");
  await h.poll("DL", "DTO");
  assert.deepEqual(events(h), ["Return Pickup Scheduled", "Return Received"]);
});

test("full progression PP/Open → PP/Scheduled → PP/Dispatched → PU/In Transit → PU/Pending → DL/DTO → exactly two customer messages", async () => {
  const h = makeHarness();
  for (const [type, status] of [
    ["PP", "Open"],
    ["PP", "Scheduled"],
    ["PP", "Dispatched"],
    ["PU", "In Transit"],
    ["PU", "Pending"],
    ["DL", "DTO"],
  ]) {
    await h.poll(type, status);
  }
  assert.equal(h.order.return_status, "returned");
  assert.deepEqual(events(h), ["Return Pickup Scheduled", "Return Received"]);
});

test("PU first, then DL/DTO → only 'Return Received' over the whole return", async () => {
  const h = makeHarness();
  await h.poll("PU", "In Transit");
  await h.poll("DL", "DTO");
  assert.deepEqual(events(h), ["Return Received"]);
});

test("customerEventForReverseTransition mapping", () => {
  assert.equal(customerEventForReverseTransition("pickup_scheduled", "pickup_scheduled"), "Return Pickup Scheduled");
  assert.equal(customerEventForReverseTransition("pickup_scheduled", "out_for_pickup"), "Return Pickup Scheduled");
  assert.equal(customerEventForReverseTransition("pickup_scheduled", "in_transit"), null);
  assert.equal(customerEventForReverseTransition("returned", "delivered_to_bree"), "Return Received");
});
