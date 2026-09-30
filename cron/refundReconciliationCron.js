import cron from "node-cron";
import { query, getClient } from "../src/config/database.js";
import { getRazorpay } from "../src/config/razorpay.js";
import { completeRefund } from "../src/controllers/admin/returnController.js";
import { runWithCronLock } from "../src/utils/cronLock.js";

// ==========================================================================
// Refund reconciliation
// ==========================================================================
// Safety net for a missed/late refund.processed or refund.failed webhook:
// asks Razorpay for the current status of each refund still 'initiated'
// (or a stale 'processing' claim) and applies it through the existing
// refund state machine — completeRefund with allowCreate: false, which:
//   - NEVER creates a Razorpay refund and never claims 'processing';
//   - initiated + refund id → refunds.fetch():
//       processed → completed (payments refunded, history, notification)
//       failed    → failed (history; admin Retry Refund workflow)
//       pending / created / anything else → stays initiated
//   - stale processing with no refund id → adopts a refund of ours that
//     Razorpay already holds (fetchMultipleRefund), else leaves it alone;
//   - Razorpay error → state unchanged, logged.
// Every transition is guarded on the exact state it read, so it is
// idempotent and never overrides a webhook or an admin action.
// ==========================================================================

const LOCK_NAME = "bree_refund_reconciliation_cron";
const BATCH_LIMIT = 25;

const log = (level, event, meta = {}) => {
  const line = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...meta });
  if (level === "error") console.error(line);
  else console.log(line);
};

const captureResponse = () => ({
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
});

/** Reconciles one order's refund. Returns { statusCode, body } from completeRefund. */
export const reconcileOrderRefund = async (
  orderId,
  { getClientFn = getClient, queryFn = query, getRazorpayFn = getRazorpay } = {},
) => {
  const res = captureResponse();
  await completeRefund({ params: { orderId }, body: {}, app: { locals: {} } }, res, {
    getClientFn,
    queryFn,
    getRazorpayFn,
    allowCreate: false,
  });
  return { statusCode: res.statusCode, body: res.body };
};

export const reconcilePendingRefunds = async ({
  getClientFn = getClient,
  queryFn = query,
  getRazorpayFn = getRazorpay,
  limit = BATCH_LIMIT,
} = {}) => {
  const { rows } = await queryFn(
    `SELECT id, refund_status FROM orders
     WHERE refund_status IN ('initiated', 'processing')
     ORDER BY updated_at ASC
     LIMIT ${Number(limit) || BATCH_LIMIT}`,
  );

  const results = [];
  for (const row of rows) {
    try {
      const result = await reconcileOrderRefund(row.id, {
        getClientFn,
        queryFn,
        getRazorpayFn,
      });
      results.push({ orderId: row.id, ...result });
      log("info", "refund_reconciliation.checked", {
        orderId: row.id,
        before: row.refund_status,
        statusCode: result.statusCode,
        after: result.body?.order?.refund_status ?? null,
      });
    } catch (error) {
      results.push({ orderId: row.id, statusCode: 500, error: error?.message });
      log("error", "refund_reconciliation.failed", { orderId: row.id, error: error?.message });
    }
  }
  return results;
};

export const startRefundReconciliationCron = () =>
  cron.schedule("15,45 * * * *", async () => {
    try {
      const result = await runWithCronLock(LOCK_NAME, () => reconcilePendingRefunds());
      if (!result.ran) {
        console.log("[REFUND_RECONCILIATION] Another instance holds the lock — skipping this tick");
      }
    } catch (error) {
      console.error("[REFUND_RECONCILIATION] Run failed", error);
    }
  });

export default startRefundReconciliationCron;
