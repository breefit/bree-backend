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
import { buildRazorpayLineItems } from "../src/controllers/paymentController.js";

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
  assert.equal(totals.actualDiscount, 0);
  assert.equal(totals.finalTotal, 597);
  assert.equal(
    calculateRazorpayShippingFeePaise({
      isFreeShipping: false,
      shippingFee: 49,
    }),
    4900,
  );
});

test("30-Pack without reminder stays at product price", () => {
  const totals = calculateOrderTotals({
    productSubtotal: 999,
    deliveryCharge: 0,
    dailyReminderPrice: 0,
    actualDiscount: 0,
  });

  assert.equal(totals.productSubtotal, 999);
  assert.equal(totals.deliveryCharge, 0);
  assert.equal(totals.dailyReminderPrice, 0);
  assert.equal(totals.actualDiscount, 0);
  assert.equal(totals.finalTotal, 999);

  const lineItems = buildRazorpayLineItems([
    { product_id: 42, name: "30-Pack Monthly Box", price: 999, quantity: 1 },
  ]);

  assert.deepEqual(lineItems, [
    {
      sku: "42",
      variant_id: "42",
      name: "30-Pack Monthly Box",
      description: "30-Pack Monthly Box",
      image_url: "",
      price: 99900,
      offer_price: 99900,
      quantity: 1,
    },
  ]);
});

test("30-Pack with reminder and free delivery stays at 1048 and never discounts the reminder", () => {
  const totals = calculateOrderTotals({
    productSubtotal: 999,
    deliveryCharge: 0,
    dailyReminderPrice: 49,
    actualDiscount: 0,
  });

  assert.equal(totals.productSubtotal, 999);
  assert.equal(totals.deliveryCharge, 0);
  assert.equal(totals.dailyReminderPrice, 49);
  assert.equal(totals.actualDiscount, 0);
  assert.equal(totals.finalTotal, 1048);
  assert.equal(
    calculateRazorpayShippingFeePaise({
      isFreeShipping: true,
      shippingFee: 0,
    }),
    0,
  );

  const lineItems = buildRazorpayLineItems(
    [{ product_id: 42, name: "30-Pack Monthly Box", price: 999, quantity: 1 }],
    [{ product_id: 42, price: 49 }],
  );

  assert.deepEqual(lineItems, [
    {
      sku: "42",
      variant_id: "42",
      name: "30-Pack Monthly Box",
      description: "30-Pack Monthly Box",
      image_url: "",
      price: 99900,
      offer_price: 99900,
      quantity: 1,
    },
    {
      sku: "reminder-42",
      variant_id: "reminder-42",
      name: "Daily WhatsApp Reminder",
      description: "Daily WhatsApp Reminder",
      image_url: "https://breefit.in/images/daily-whatsapp-reminder.png",
      price: 4900,
      offer_price: 4900,
      quantity: 1,
    },
  ]);
});

test("7-Pack with reminder and paid delivery stays at 597", () => {
  const totals = calculateOrderTotals({
    productSubtotal: 499,
    deliveryCharge: 49,
    dailyReminderPrice: 49,
    actualDiscount: 0,
  });

  assert.equal(totals.productSubtotal, 499);
  assert.equal(totals.deliveryCharge, 49);
  assert.equal(totals.dailyReminderPrice, 49);
  assert.equal(totals.actualDiscount, 0);
  assert.equal(totals.finalTotal, 597);
  assert.equal(
    calculateRazorpayShippingFeePaise({
      isFreeShipping: false,
      shippingFee: 49,
    }),
    4900,
  );
});

test("genuine coupon or actual discount still reduces the final total correctly", () => {
  const totals = calculateOrderTotals({
    productSubtotal: 999,
    deliveryCharge: 0,
    dailyReminderPrice: 49,
    actualDiscount: 100,
  });

  assert.equal(totals.productSubtotal, 999);
  assert.equal(totals.dailyReminderPrice, 49);
  assert.equal(totals.actualDiscount, 100);
  assert.equal(totals.finalTotal, 948);
});
