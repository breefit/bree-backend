import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { verifyPayment } from "../src/controllers/paymentController.js";

/**
 * PHASE 3 — Medium Issue #7: verifyPayment's live Razorpay amount
 * cross-check used to silently fall through to "verified" (on HMAC
 * signature trust alone) whenever the rzp.payments.fetch() call itself
 * failed (Razorpay API outage/timeout) — the exact scenario most likely to
 * accompany real trouble made the one check that exists to catch a real
 * amount mismatch unreachable. Fixed to fail closed: a fetch failure now
 * refuses the request (502) instead of completing the order.
 *
 * Drives the REAL verifyPayment function directly (not a regex over the
 * source, not via HTTP — verifyPayment isn't Express-route-testable with
 * injected deps since Express itself calls it with just (req,res)), with a
 * genuinely valid HMAC signature (computed the same way
 * utils/razorpay.js's verifyPaymentSignature does, using the real
 * RAZORPAY_KEY_SECRET already loaded from .env in this test environment)
 * so the failure under test is specifically the amount cross-check, not
 * signature rejection. No production database, no real Razorpay call.
 */

const buildValidSignature = ({ razorpay_order_id, razorpay_payment_id }) =>
  crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

const makeReqRes = (body) => {
  const req = { body, user: null };
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

const fakeOrder = {
  id: "order-verify-1",
  razorpay_order_id: "order_test123",
  razorpay_payment_id: null,
  payment_status: "pending",
  is_subscription: 0,
  total: 500,
  amount: 500,
};

const makeFakeQueryFn = (order) => async (sql, params = []) => {
  const normalized = sql.replace(/\s+/g, " ").trim();

  if (normalized === "SELECT id FROM orders WHERE razorpay_payment_id = ?") {
    // No prior order already recorded against this payment id.
    return { rows: [], rowCount: 0 };
  }

  if (normalized.startsWith("SELECT * FROM orders WHERE")) {
    return { rows: order ? [{ ...order }] : [], rowCount: order ? 1 : 0 };
  }

  throw new Error(`Unhandled fake SQL in verifyPaymentAmountCheckFailsClosed test: ${normalized}`);
};

test("ISSUE-007 (Medium #7): a Razorpay outage during the amount cross-check fails CLOSED (502), never falls through to verified on HMAC trust alone", async () => {
  const payment_id = "pay_test123";
  const order_id = "order_test123";
  const signature = buildValidSignature({ razorpay_order_id: order_id, razorpay_payment_id: payment_id });

  const { req, res } = makeReqRes({
    razorpay_order_id: order_id,
    razorpay_payment_id: payment_id,
    razorpay_signature: signature,
  });

  const getRazorpayFn = () => ({
    payments: {
      fetch: async () => {
        throw new Error("ETIMEDOUT: Razorpay API unreachable");
      },
    },
  });

  await verifyPayment(req, res, {
    queryFn: makeFakeQueryFn(fakeOrder),
    getRazorpayFn,
  });

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.success, false);
  assert.doesNotMatch(res.body.message, /verified|success/i);
});

test("ISSUE-007 (Medium #7) regression: a genuine amount MISMATCH (Razorpay reachable, wrong amount) is still rejected with 400, not 502", async () => {
  const payment_id = "pay_test456";
  const order_id = "order_test123";
  const signature = buildValidSignature({ razorpay_order_id: order_id, razorpay_payment_id: payment_id });

  const { req, res } = makeReqRes({
    razorpay_order_id: order_id,
    razorpay_payment_id: payment_id,
    razorpay_signature: signature,
  });

  const getRazorpayFn = () => ({
    payments: {
      // Order total is 500 rupees = 50000 paise; Razorpay reports a
      // DIFFERENT amount — a real, confirmed mismatch, not a fetch failure.
      fetch: async () => ({ amount: 12345, status: "captured" }),
    },
  });

  await verifyPayment(req, res, {
    queryFn: makeFakeQueryFn(fakeOrder),
    getRazorpayFn,
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /amount mismatch/i);
});

test("ISSUE-007 (Medium #7) regression: an invalid signature is still rejected before the amount cross-check ever runs", async () => {
  const { req, res } = makeReqRes({
    razorpay_order_id: "order_test123",
    razorpay_payment_id: "pay_test789",
    razorpay_signature: "not-a-real-signature",
  });

  let fetchCalled = false;
  const getRazorpayFn = () => ({
    payments: { fetch: async () => { fetchCalled = true; return {}; } },
  });

  await verifyPayment(req, res, {
    queryFn: makeFakeQueryFn(fakeOrder),
    getRazorpayFn,
  });

  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalled, false, "the amount cross-check must never run for an invalid signature");
});
