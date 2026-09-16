import test from "node:test";
import assert from "node:assert/strict";
import { resumeSubscription } from "../src/controllers/subscriptionController.js";
import { resumeSubscription as adminResumeSubscription } from "../src/controllers/admin/subscriptionAdminController.js";

/**
 * PHASE 4 — LOW-08: both the customer-facing and admin resumeSubscription
 * endpoints used to have no local pre-check on the subscription's current
 * status before calling Razorpay — an already-active, never-paused, or
 * cancelled subscription would still trigger a live gateway call. The
 * database write afterward (updateSubscriptionOrder's
 * expectedSubscriptionStatuses guard) was always the final authority, but
 * an invalid-state request reached Razorpay first, unlike admin
 * pauseSubscription which already had an equivalent local check for
 * "cancelled".
 *
 * Fixed: both resumeSubscription functions now reject with 400 locally
 * when the order's subscription_status isn't "paused", before ever calling
 * Razorpay. The database remains authoritative — this is only a fast,
 * local rejection of the common invalid-state case.
 *
 * These tests drive the REAL functions with a fake queryFn/getRazorpayFn,
 * proving: (1) a non-paused status is rejected with 400 and Razorpay is
 * never called, (2) a paused status proceeds to call Razorpay.
 */

const makeReqRes = ({ params, userId = "user-1" } = {}) => {
  const req = { params, user: { id: userId }, admin: { id: "admin-1" }, body: {} };
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

const makeFakeRazorpay = () => {
  let calls = 0;
  return {
    getRazorpayFn: () => ({
      subscriptions: {
        resume: async () => {
          calls += 1;
          return { status: "active" };
        },
      },
    }),
    getCalls: () => calls,
  };
};

for (const invalidStatus of ["active", "cancelled", "authenticated", null]) {
  test(`customer resumeSubscription: subscription_status="${invalidStatus}" is rejected with 400, Razorpay never called`, async () => {
    const queryFn = async () => ({
      rows: [
        {
          id: "order-1",
          razorpay_subscription_id: "sub_1",
          subscription_status: invalidStatus,
          contact_email: "a@b.com",
          contact_name: "A",
          contact_phone: "9999999999",
          product_name: "Plan",
        },
      ],
    });
    const rzp = makeFakeRazorpay();
    const { req, res } = makeReqRes({ params: { id: "sub_1" } });

    await resumeSubscription(req, res, { queryFn, getRazorpayFn: rzp.getRazorpayFn });

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /cannot be resumed/i);
    assert.equal(rzp.getCalls(), 0);
  });

  test(`admin resumeSubscription: subscription_status="${invalidStatus}" is rejected with 400, Razorpay never called`, async () => {
    const queryFn = async () => ({
      rows: [
        {
          id: "order-1",
          razorpay_subscription_id: "sub_1",
          subscription_status: invalidStatus,
          contact_email: "a@b.com",
          contact_name: "A",
          contact_phone: "9999999999",
          product_name: "Plan",
        },
      ],
    });
    const rzp = makeFakeRazorpay();
    const { req, res } = makeReqRes({ params: { id: "order-1" } });

    await adminResumeSubscription(req, res, { queryFn, getRazorpayFn: rzp.getRazorpayFn });

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /cannot be resumed/i);
    assert.equal(rzp.getCalls(), 0);
  });
}

test("customer resumeSubscription: subscription_status='paused' proceeds to call Razorpay", async () => {
  const queryFn = async () => ({
    rows: [
      {
        id: "order-1",
        razorpay_subscription_id: "sub_1",
        subscription_status: "paused",
        contact_email: "a@b.com",
        contact_name: "A",
        contact_phone: "9999999999",
        product_name: "Plan",
      },
    ],
  });
  const rzp = makeFakeRazorpay();
  const { req, res } = makeReqRes({ params: { id: "sub_1" } });

  await resumeSubscription(req, res, { queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(rzp.getCalls(), 1);
  assert.notEqual(res.statusCode, 400);
});

test("admin resumeSubscription: subscription_status='paused' proceeds to call Razorpay", async () => {
  const queryFn = async () => ({
    rows: [
      {
        id: "order-1",
        razorpay_subscription_id: "sub_1",
        subscription_status: "paused",
        contact_email: "a@b.com",
        contact_name: "A",
        contact_phone: "9999999999",
        product_name: "Plan",
      },
    ],
  });
  const rzp = makeFakeRazorpay();
  const { req, res } = makeReqRes({ params: { id: "order-1" } });

  await adminResumeSubscription(req, res, { queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(rzp.getCalls(), 1);
  assert.notEqual(res.statusCode, 400);
});
