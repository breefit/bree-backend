import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPaymentState,
  getMissingContactUpdates,
  formatRazorpayShippingAddress,
  shouldRecordPaymentHistory,
  shouldClaimOrderConfirmation,
  getOrderConfirmationClaimDecision,
  getOrderConfirmationRecipients,
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

test("fills a missing phone from verified Razorpay contact data", () => {
  assert.deepEqual(
    getMissingContactUpdates({
      currentEmail: "user@example.com",
      currentPhone: "",
      verifiedEmail: "user@example.com",
      verifiedPhone: "+919876543210",
    }),
    { email: null, phone: "+919876543210" },
  );
});

test("fills a missing email from verified Razorpay customer data", () => {
  assert.deepEqual(
    getMissingContactUpdates({
      currentEmail: "",
      currentPhone: "9876543210",
      verifiedEmail: "USER@EXAMPLE.COM",
      verifiedPhone: "+919876543210",
    }),
    { email: "user@example.com", phone: null },
  );
});

test("does not overwrite existing contact fields or invent an email", () => {
  assert.deepEqual(
    getMissingContactUpdates({
      currentEmail: "existing@example.com",
      currentPhone: "9876543210",
      verifiedEmail: "",
      verifiedPhone: "+919999999999",
    }),
    { email: null, phone: null },
  );
});

test("does not add payment history for a duplicate webhook", () => {
  assert.equal(shouldRecordPaymentHistory("paid"), false);
  assert.equal(shouldRecordPaymentHistory("pending"), true);
});

test("claims confirmation only for paid orders without a sent timestamp", () => {
  assert.equal(
    shouldClaimOrderConfirmation({ paymentStatus: "paid", sentAt: null }),
    true,
  );
  assert.equal(
    shouldClaimOrderConfirmation({ paymentStatus: "pending", sentAt: null }),
    false,
  );
  assert.equal(
    shouldClaimOrderConfirmation({
      paymentStatus: "paid",
      sentAt: "2026-09-07T07:23:33.000Z",
    }),
    false,
  );
  assert.equal(
    shouldClaimOrderConfirmation({ paymentStatus: " PAID ", sentAt: null }),
    true,
  );
});

test("first channel owner is eligible before provider in-flight state is set", () => {
  assert.deepEqual(
    getOrderConfirmationClaimDecision({
      paymentStatus: "paid",
      sentAt: null,
      inFlight: false,
    }),
    { alreadySent: false, inFlight: false, eligible: true },
  );
});

test("a competing in-flight channel attempt is not eligible", () => {
  assert.deepEqual(
    getOrderConfirmationClaimDecision({
      paymentStatus: "paid",
      sentAt: null,
      inFlight: true,
      isOwner: false,
    }),
    { alreadySent: false, inFlight: true, eligible: false },
  );
});

test("a successful timestamp blocks duplicate channel delivery", () => {
  assert.deepEqual(
    getOrderConfirmationClaimDecision({
      paymentStatus: "paid",
      sentAt: "2026-09-07T07:23:33.000Z",
      inFlight: false,
      isOwner: true,
    }),
    { alreadySent: true, inFlight: false, eligible: false },
  );
});

test("resolves guest checkout contacts from the order record", () => {
  assert.deepEqual(
    getOrderConfirmationRecipients({
      email: "guest@example.com",
      mobile_number: "+919876543210",
    }),
    { email: "guest@example.com", phone: "+919876543210" },
  );
});

test("resolves logged-in contact fields without inventing missing email", () => {
  assert.deepEqual(
    getOrderConfirmationRecipients({
      contact_email: null,
      contact_phone: "9876543210",
      email: null,
      mobile_number: "9876543210",
    }),
    { email: null, phone: "9876543210" },
  );
});
