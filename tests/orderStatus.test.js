import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOrderStatus,
  getOrderStatusLabel,
  getOrderStatusFlow,
} from "../src/constants/orderStatus.js";
import {
  calculateOrderTotals,
  calculateRazorpayShippingFeePaise,
} from "../src/utils/orderTotals.js";

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

test("resolves Razorpay shipping from the product delivery configuration", () => {
  assert.equal(calculateRazorpayShippingFeePaise({ isFreeShipping: true }), 0);
  assert.equal(
    calculateRazorpayShippingFeePaise({
      isFreeShipping: false,
      shippingCharge: 49,
    }),
    4900,
  );
  assert.equal(
    calculateRazorpayShippingFeePaise({
      isFreeShipping: false,
      shippingCharge: 69,
    }),
    6900,
  );
  assert.equal(
    calculateRazorpayShippingFeePaise({
      isFreeShipping: false,
      shippingCharge: 99,
    }),
    9900,
  );
  assert.equal(
    calculateRazorpayShippingFeePaise({
      isFreeShipping: false,
      shippingFee: 49.5,
    }),
    4950,
  );
});

test("keeps reminder pricing separate from delivery pricing", () => {
  const totals = calculateOrderTotals({
    productSubtotal: 499,
    deliveryCharge: 49,
    dailyReminderPrice: 49,
  });

  assert.equal(totals.productSubtotal, 499);
  assert.equal(totals.deliveryCharge, 49);
  assert.equal(totals.dailyReminderPrice, 49);
  assert.equal(totals.finalTotal, 597);
  assert.equal(
    calculateRazorpayShippingFeePaise({
      isFreeShipping: false,
      shippingCharge: 49,
    }),
    4900,
  );
});
