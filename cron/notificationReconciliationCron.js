import cron from "node-cron";
import { runWithCronLock } from "../src/utils/cronLock.js";
import { reconcileCustomerNotifications } from "../src/services/notificationReconciliation.js";

// Retries / recovers customer return-refund notifications — see
// services/notificationReconciliation.js. Same distributed-lock pattern as
// the other crons: with several Hostinger processes only one runs a tick,
// and every send inside it is still claimed atomically per notification key.
const LOCK_NAME = "bree_notification_reconciliation_cron";

export const runNotificationReconciliationTick = async ({
  runWithLock = runWithCronLock,
  reconcile = reconcileCustomerNotifications,
} = {}) => {
  try {
    const result = await runWithLock(LOCK_NAME, () => reconcile());
    if (!result.ran) {
      console.log("[NOTIFICATION_RECONCILIATION] Another instance holds the lock — skipping this tick");
    }
    return result;
  } catch (error) {
    console.error("[NOTIFICATION_RECONCILIATION] Run failed", error);
    return { ran: false, reason: "error" };
  }
};

export const startNotificationReconciliationCron = () =>
  cron.schedule("*/5 * * * *", () => runNotificationReconciliationTick());

export default startNotificationReconciliationCron;
