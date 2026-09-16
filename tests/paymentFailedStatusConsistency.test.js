import test from "node:test";
import assert from "node:assert/strict";
import { markPaymentRowFailed } from "../src/controllers/paymentController.js";

/**
 * PHASE 3 — Medium Issue #22: payments.status never reached a 'failed'
 * terminal state — every write to that column was 'created' or 'captured',
 * so a failed payment attempt left its payments row stuck at 'created'
 * forever while orders.payment_status correctly showed 'failed'. Extracted
 * as markPaymentRowFailed (called from handleWebhook's payment.failed
 * branches, both the subscription and one-time-payment cases) so it can be
 * driven directly here with a fake queryFn — handleWebhook itself is a
 * large, non-DI function and retrofitting broad injection into it would be
 * a much bigger change than this fix warrants.
 */

const makeFakePaymentsDb = (initialRows) => {
  const rows = new Map(initialRows.map((r) => [r.id, { ...r }]));

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "UPDATE payments SET status = 'failed', updated_at = NOW() WHERE razorpay_order_id = ?") {
      const [razorpayOrderId] = params;
      let count = 0;
      for (const row of rows.values()) {
        if (row.razorpay_order_id === razorpayOrderId) {
          row.status = "failed";
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (normalized === "UPDATE payments SET status = 'failed', updated_at = NOW() WHERE razorpay_subscription_id = ?") {
      const [razorpaySubscriptionId] = params;
      let count = 0;
      for (const row of rows.values()) {
        if (row.razorpay_subscription_id === razorpaySubscriptionId) {
          row.status = "failed";
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    throw new Error(`Unhandled fake SQL in paymentFailedStatusConsistency test: ${normalized}`);
  };

  return { queryFn, rows };
};

test("ISSUE-022: a one-time-payment failure marks the payments row 'failed' by razorpay_order_id", async () => {
  const db = makeFakePaymentsDb([
    { id: "pay-row-1", razorpay_order_id: "order_abc", razorpay_subscription_id: null, status: "created" },
  ]);

  await markPaymentRowFailed({ razorpayOrderId: "order_abc", queryFn: db.queryFn });

  assert.equal(db.rows.get("pay-row-1").status, "failed");
});

test("ISSUE-022: a subscription-charge failure marks the payments row 'failed' by razorpay_subscription_id", async () => {
  const db = makeFakePaymentsDb([
    { id: "pay-row-2", razorpay_order_id: null, razorpay_subscription_id: "sub_xyz", status: "created" },
  ]);

  await markPaymentRowFailed({ razorpaySubscriptionId: "sub_xyz", queryFn: db.queryFn });

  assert.equal(db.rows.get("pay-row-2").status, "failed");
});

test("ISSUE-022: subscription id takes precedence when both are somehow provided (matches the exclusive if/else-if webhook branches)", async () => {
  const db = makeFakePaymentsDb([
    { id: "pay-row-3", razorpay_order_id: "order_abc", razorpay_subscription_id: "sub_xyz", status: "created" },
  ]);

  await markPaymentRowFailed({
    razorpayOrderId: "order_abc",
    razorpaySubscriptionId: "sub_xyz",
    queryFn: db.queryFn,
  });

  assert.equal(db.rows.get("pay-row-3").status, "failed");
});

test("ISSUE-022 regression: an unrelated payments row (different order) is never touched", async () => {
  const db = makeFakePaymentsDb([
    { id: "pay-row-1", razorpay_order_id: "order_abc", razorpay_subscription_id: null, status: "created" },
    { id: "pay-row-2", razorpay_order_id: "order_other", razorpay_subscription_id: null, status: "captured" },
  ]);

  await markPaymentRowFailed({ razorpayOrderId: "order_abc", queryFn: db.queryFn });

  assert.equal(db.rows.get("pay-row-1").status, "failed");
  assert.equal(db.rows.get("pay-row-2").status, "captured", "an unrelated order's payment row must be untouched");
});

test("ISSUE-022 regression: no id at all is a safe no-op (never touches every row)", async () => {
  const db = makeFakePaymentsDb([
    { id: "pay-row-1", razorpay_order_id: "order_abc", razorpay_subscription_id: null, status: "created" },
  ]);

  const result = await markPaymentRowFailed({ queryFn: db.queryFn });

  assert.equal(result.rowCount, 0);
  assert.equal(db.rows.get("pay-row-1").status, "created");
});
