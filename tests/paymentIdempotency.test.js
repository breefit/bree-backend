import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPaymentState,
  formatRazorpayShippingAddress,
} from "../src/controllers/paymentController.js";

test("processes an unpaid order", () => {
  assert.equal(
    classifyPaymentState({
      paymentStatus: "pending",
      storedPaymentId: null,
      incomingPaymentId: "pay_A",
    }),
    "process",
  );
});

test("reconciles a paid order whose order payment ID is missing", () => {
  assert.equal(
    classifyPaymentState({
      paymentStatus: "paid",
      storedPaymentId: null,
      incomingPaymentId: "pay_A",
    }),
    "reconcile",
  );
});

test("accepts duplicate verification or webhook for the same payment", () => {
  assert.equal(
    classifyPaymentState({
      paymentStatus: "paid",
      storedPaymentId: "pay_A",
      incomingPaymentId: "pay_A",
    }),
    "already_paid",
  );
});

test("preserves conflict protection for a different payment", () => {
  assert.equal(
    classifyPaymentState({
      paymentStatus: "paid",
      storedPaymentId: "pay_A",
      incomingPaymentId: "pay_B",
    }),
    "conflict",
  );
});

test("formats the authoritative Magic Checkout shipping address", () => {
  assert.equal(
    formatRazorpayShippingAddress({
      name: "Customer",
      line1: "1 Main Street",
      line2: "Apt 2",
      city: "Pune",
      state: "MH",
      zipcode: "411001",
      country: "India",
    }),
    "Customer, 1 Main Street, Apt 2, Pune, MH, 411001, India",
  );
});
