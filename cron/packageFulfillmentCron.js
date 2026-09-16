import cron from "node-cron";
import {
  runDuePackageFulfillments,
  reconcileMissingPackagePurchases,
} from "../src/services/packageFulfillmentService.js";

// Daily, off-peak (3 AM IST). The interval isn't precision-sensitive — a
// package's next_fulfillment_date is a day-level target, not a minute-level
// one — so once a day is enough; runDuePackageFulfillments() is idempotent
// so a missed/late run (e.g. server was down) just catches up on the next
// tick with no duplicate or skipped cycles.
export const startPackageFulfillmentCron = () => {
  const task = cron.schedule(
    "0 3 * * *",
    async () => {
      try {
        const result = await runDuePackageFulfillments();
        if (result.processed > 0) {
          console.log(
            `[PACKAGE_CRON] Processed ${result.processed} due package(s), created ${result.created} fulfillment order(s)`,
          );
        }
      } catch (error) {
        console.error("[PACKAGE_CRON] Cron run failed", error);
      }

      // FIX (Medium #14 — Phase 3): see packageFulfillmentService.js's
      // reconcileMissingPackagePurchases comment — catches the case where
      // BOTH fire-and-forget creation triggers (verify + webhook) failed
      // for the same order, which the due-fulfillment pass above can never
      // discover (it only looks at packages that already have a row).
      try {
        const reconcileResult = await reconcileMissingPackagePurchases();
        if (reconcileResult.created > 0) {
          console.log(
            `[PACKAGE_RECONCILE] Created ${reconcileResult.created} missing package_purchases row(s) out of ${reconcileResult.checked} checked`,
          );
        }
      } catch (error) {
        console.error("[PACKAGE_RECONCILE] Reconciliation run failed", error);
      }
    },
    { timezone: "Asia/Kolkata" },
  );

  return task;
};

export default startPackageFulfillmentCron;
