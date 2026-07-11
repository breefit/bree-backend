import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOrderStatus,
  getOrderStatusLabel,
  getOrderStatusFlow,
} from "../src/constants/orderStatus.js";

test("normalizes legacy statuses to the new fulfillment lifecycle", () => {
  assert.equal(normalizeOrderStatus("pending"), "pending_payment");
  assert.equal(normalizeOrderStatus("confirmed"), "paid");
  assert.equal(normalizeOrderStatus("dispatched"), "shipped");
  assert.equal(normalizeOrderStatus("out_for_delivery"), "out_for_delivery");
  assert.equal(normalizeOrderStatus("cancelled"), "cancelled");
});

test("returns readable labels for the new statuses", () => {
  assert.equal(getOrderStatusLabel("pending_payment"), "Pending Payment");
  assert.equal(getOrderStatusLabel("ready_to_ship"), "Ready To Ship");
  assert.equal(getOrderStatusLabel("out_for_delivery"), "Out For Delivery");
});

test("exposes the full fulfillment flow for admin transitions", () => {
  assert.deepEqual(getOrderStatusFlow("paid"), [
    "paid",
    "processing",
    "ready_to_ship",
    "shipped",
    "out_for_delivery",
    "delivered",
  ]);
});
