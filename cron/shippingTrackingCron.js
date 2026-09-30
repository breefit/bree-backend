import cron from "node-cron";
import { query } from "../src/config/database.js";
import delhiveryService from "../src/services/delhiveryService.js";
import {
  extractDelhiveryTrackingDetails,
  normalizeTrackingStatus,
  mapTrackingStatusToOrderStatus,
  isForwardOrderStatusTransition,
  shouldSendBreeStatusWhatsApp,
  isCancelledShipment,
} from "../src/controllers/shippingController.js";
import { appendStatusHistory } from "../src/models/Order.js";
import {
  sendOutForDeliveryEmail,
  sendShipmentDeliveredEmail,
  sendOrderStatusUpdateEmail,
} from "../src/services/orderEmailService.js";
import { sendOrderStatusUpdateWhatsApp } from "../src/services/whatsappNotificationService.js";
import { activateReminderFromDelivery } from "../src/services/dailyReminderService.js";
import {
  sendOrderStatusNotificationOnce,
  buildOrderStatusNotificationKey,
  logNotification,
} from "../src/services/orderStatusNotificationService.js";
import { runWithCronLock } from "../src/utils/cronLock.js";
import { syncReverseShipmentTracking } from "../src/services/reverseShipmentTracking.js";

const TERMINAL_STATUSES = ["delivered", "cancelled", "returned"];

// FIX (BREE-100019 / AWB 58045510000055): the active set used to be decided
// by tracking_status text alone. After a cancellation Delhivery reports the
// AWB as "Not Picked" (never "Cancelled"), and once that text replaced
// "Cancelled" the cancelled order was polled and rewritten every 30 minutes
// indefinitely. order_status = 'cancelled' (set by cancelShipment) now
// excludes it as well.
//
// Why order_status is a safe signal here (audited, not assumed): for an
// order WITH an AWB, order_status can only become 'cancelled' through
// cancelShipment (Delhivery accepted the cancel) or Delhivery's own tracking
// reporting Cancelled/Lost. Manual admin/bulk status changes cannot set it
// (DELHIVERY_LOCKED_STATUSES in admin/orderController.js), and Cancel Order &
// Refund refuses a live shipment. 'cancelled' is also already terminal for
// isForwardOrderStatusTransition(), so polling it could never move the order
// — it only overwrote tracking_status and delhivery_response.
export const NOT_CANCELLED_SHIPMENT_GUARD = `AND COALESCE(order_status, '') <> 'cancelled'
       AND LOWER(TRIM(COALESCE(tracking_status, ''))) <> 'cancelled'`;

export const ACTIVE_FORWARD_SHIPMENTS_WHERE = `WHERE awb_number IS NOT NULL
       AND awb_number != ''
       AND LOWER(TRIM(COALESCE(tracking_status, ''))) NOT IN ('delivered', 'cancelled', 'returned')
       ${NOT_CANCELLED_SHIPMENT_GUARD}`;

// FIX (Medium #17 — Phase 3): a persistently-failing Delhivery tracking API
// call for a given order used to be only console.error'd and silently
// retried on the next 30-minute tick, indefinitely, with no counter and no
// escalation. Extracted as small, independently testable functions (rather
// than adding broad dependency injection to the large, non-DI
// syncShippingTracking loop) — called from the per-order try/catch below.
const TRACKING_FAILURE_ALERT_THRESHOLD = 5; // ~2.5 hours of consecutive failures at the 30-minute cron interval

export const recordTrackingSyncFailure = async (
  order,
  { queryFn = query, alertThreshold = TRACKING_FAILURE_ALERT_THRESHOLD } = {},
) => {
  await queryFn(
    `UPDATE orders
     SET tracking_sync_failure_count = tracking_sync_failure_count + 1,
         tracking_sync_last_failure_at = NOW()
     WHERE id = ?`,
    [order.id],
  );

  const { rows } = await queryFn(
    "SELECT tracking_sync_failure_count FROM orders WHERE id = ?",
    [order.id],
  );
  const failureCount = Number(rows?.[0]?.tracking_sync_failure_count || 0);

  if (failureCount >= alertThreshold) {
    console.error(
      `[SHIPPING_CRON] ALERT: order ${order.id} (AWB ${order.awb_number}) has failed tracking sync ${failureCount} consecutive times — needs manual investigation`,
    );
  }

  return failureCount;
};

export const resetTrackingSyncFailure = async (order, { queryFn = query } = {}) => {
  if (!order.tracking_sync_failure_count) return;
  await queryFn(
    "UPDATE orders SET tracking_sync_failure_count = 0 WHERE id = ?",
    [order.id],
  );
};

const getAvailableOrderColumns = async (queryFn = query) => {
  const { rows } = await queryFn("SHOW COLUMNS FROM orders");
  const fields = new Set((rows || []).map((row) => row.Field));

  return {
    hasCurrentLocation: fields.has("current_location"),
    hasExpectedDelivery:
      fields.has("expected_delivery") || fields.has("expected_delivery_date"),
    hasLastTrackingUpdate: fields.has("last_tracking_update"),
  };
};

// Dependencies are injectable only for tests; the cron lock calls this with
// no arguments, so production always uses the real defaults.
export const syncShippingTracking = async ({
  queryFn = query,
  delhiveryServiceFn = delhiveryService,
  activateReminderFn = activateReminderFromDelivery,
} = {}) => {
  console.log("[SHIPPING_CRON] Cron start");

  const { rows: orders } = await queryFn(
    `SELECT id, order_number, order_status, awb_number, tracking_status,
            contact_name, customer_name, email, contact_email,
            mobile_number, contact_phone, tracking_url, courier_name,
            tracking_sync_failure_count
     FROM orders
     ${ACTIVE_FORWARD_SHIPMENTS_WHERE}`,
  );

  const availableColumns = await getAvailableOrderColumns(queryFn);
  console.log(`[SHIPPING_CRON] Processing ${orders.length} orders`);

  for (const order of orders) {
    const awb = order.awb_number;
    if (!awb) continue;
    // Same rule as ACTIVE_FORWARD_SHIPMENTS_WHERE, re-checked per row.
    if (isCancelledShipment(order)) {
      console.log(`[SHIPPING_CRON] Skipping cancelled shipment ${order.id} AWB ${awb}`);
      continue;
    }

    console.log(`[SHIPPING_CRON] Processing order ${order.id} AWB ${awb}`);

    try {
      const trackingResponse = await delhiveryServiceFn.trackShipment(awb);
      const parsedTracking = extractDelhiveryTrackingDetails(trackingResponse);

      if (!parsedTracking.success) {
        console.warn(
          `[SHIPPING_CRON] AWB ${awb} parse failed: ${parsedTracking.message}`,
        );
        continue;
      }

      const trackingStatus =
        parsedTracking.trackingStatus || order.tracking_status;
      const normalizedTrackingStatus = normalizeTrackingStatus(trackingStatus);
      const orderStatusChanged =
        normalizeTrackingStatus(order.tracking_status) !==
        normalizedTrackingStatus;

      // FIX (Delhivery shipment audit — backward-transition bug + missing
      // delivered_at): computed once, reused for both the UPDATE and the
      // history entry below (previously each recomputed mappedOrderStatus
      // independently and neither applied a forward-only guard, so a stale/
      // out-of-order Delhivery status could regress order_status backwards).
      // isForwardOrderStatusTransition() also blocks any further automatic
      // transition once the order is already delivered/cancelled/returned.
      const mappedOrderStatus = orderStatusChanged
        ? mapTrackingStatusToOrderStatus(trackingStatus)
        : null;
      const shouldTransitionOrderStatus =
        Boolean(mappedOrderStatus) &&
        mappedOrderStatus !== order.order_status &&
        isForwardOrderStatusTransition(order.order_status, mappedOrderStatus);

      const updateFields = [
        "tracking_status = ?",
        "delhivery_response = ?",
        "updated_at = NOW()",
      ];
      const updateParams = [trackingStatus, JSON.stringify(trackingResponse)];

      if (availableColumns.hasCurrentLocation) {
        updateFields.push("current_location = ?");
        updateParams.push(parsedTracking.currentLocation || null);
      }

      if (availableColumns.hasExpectedDelivery) {
        updateFields.push("expected_delivery = ?");
        updateParams.push(parsedTracking.expectedDelivery || null);
      }

      if (availableColumns.hasLastTrackingUpdate) {
        updateFields.push("last_tracking_update = ?");
        updateParams.push(parsedTracking.lastUpdate || null);
      }

      if (shouldTransitionOrderStatus) {
        updateFields.push("order_status = ?");
        updateParams.push(mappedOrderStatus);

        // FIX (Return/Refund audit — 48-hour window): the cron is the
        // primary automatic path an order becomes "delivered" through, but
        // it never stamped delivered_at (only the manual /track/:awb
        // controller endpoint did) — silently breaking the 48-hour return
        // window for every cron-driven delivery. Mirrors the same guarded
        // stamp trackShipment() uses.
        if (mappedOrderStatus === "delivered") {
          updateFields.push("delivered_at = NOW()");
        }
      }

      // FIX (BREE-100019): the row snapshot above can be stale — a Cancel
      // Shipment committed after the SELECT would otherwise be overwritten
      // here with Delhivery's "Not Picked" (exactly how a cancelled order
      // re-entered the active set). The cancellation check is repeated
      // against the CURRENT row, atomically with the write.
      updateParams.push(order.id);
      let updateWhere = `WHERE id = ? ${NOT_CANCELLED_SHIPMENT_GUARD}`;
      if (shouldTransitionOrderStatus) {
        updateWhere += " AND order_status = ?";
        updateParams.push(order.order_status);
      }

      const updateResult = await queryFn(
        `UPDATE orders SET ${updateFields.join(", ")} ${updateWhere}`,
        updateParams,
      );

      if (!Number(updateResult.affectedRows ?? updateResult.rowCount)) {
        console.warn(
          shouldTransitionOrderStatus
            ? `[SHIPPING_CRON] Skipping stale status transition for order ${order.id}; another update won the race`
            : `[SHIPPING_CRON] Order ${order.id} AWB ${awb} was cancelled during this run — tracking not written`,
        );
        continue;
      }

      if (shouldTransitionOrderStatus) {
        await appendStatusHistory({
          orderId: order.id,
          previousStatus: order.order_status,
          newStatus: mappedOrderStatus,
          changedBy: null,
          notes: `Order status auto-synced from Delhivery tracking status "${trackingStatus}" for AWB ${awb}`,
          queryExecutor: queryFn,
        });
      }

      // FIX (Delhivery shipment audit — backward-transition bug): gated on
      // shouldTransitionOrderStatus (not the raw orderStatusChanged text
      // comparison) so a stale/regressive Delhivery status that the guard
      // above just refused to apply can never trigger a misleading
      // "out for delivery"/"delivered" email for a transition that didn't
      // actually happen.
      if (shouldTransitionOrderStatus) {
        const recipientEmail = order.contact_email || order.email;
        const recipientName =
          order.contact_name || order.customer_name || "Customer";
        const recipientPhone = order.contact_phone || order.mobile_number;

        // One notification_key per (order, mappedOrderStatus, channel) —
        // shared with trackShipment()'s manual refresh below, so whichever
        // path observes a given transition first "wins" the send and the
        // other becomes a no-op duplicate, not a second message.
        // sendOrderStatusNotificationOnce() logs every attempt/sent/
        // duplicate_skipped/failed outcome itself — no separate logging
        // needed here beyond the "no contact info at all" case.
        if (recipientEmail) {
          try {
            await sendOrderStatusNotificationOnce({
              notificationKey: buildOrderStatusNotificationKey({
                orderId: order.id,
                status: mappedOrderStatus,
                channel: "email",
              }),
              orderId: order.id,
              status: mappedOrderStatus,
              channel: "email",
              send: async () => {
                if (normalizedTrackingStatus === "out for delivery") {
                  await sendOutForDeliveryEmail({
                    to: recipientEmail,
                    name: recipientName,
                    orderId: order.id,
                    orderNumber: order.order_number,
                    awbNumber: order.awb_number,
                    trackingUrl: order.tracking_url,
                    currentLocation: parsedTracking.currentLocation,
                    expectedDeliveryDate: parsedTracking.expectedDelivery,
                  });
                } else if (normalizedTrackingStatus === "delivered") {
                  await sendShipmentDeliveredEmail({
                    to: recipientEmail,
                    name: recipientName,
                    orderId: order.id,
                    orderNumber: order.order_number,
                  });
                } else if (mappedOrderStatus === "shipped") {
                  await sendOrderStatusUpdateEmail({
                    to: recipientEmail,
                    name: recipientName,
                    orderId: order.id,
                    orderNumber: order.order_number,
                    status: mappedOrderStatus,
                  });
                }
              },
            });
          } catch {
            // Already logged (as action:"failed") and recorded in
            // order_status_notifications by sendOrderStatusNotificationOnce.
          }
        } else {
          logNotification({
            orderId: order.id,
            status: mappedOrderStatus,
            channel: "email",
            action: "failed",
            result: "failure",
            error: "no customer email (contact_email/email both empty)",
          });
        }

        // FIX (duplicate shipping notifications): Delhivery already
        // sends its own WhatsApp for "shipped"/"out for delivery" — see
        // shouldSendBreeStatusWhatsApp() in shippingController.js.
        // Deliberately no order_status_notifications claim for those two.
        // Same guard as trackShipment()'s manual refresh, sharing this
        // status's notification_key namespace.
        if (!shouldSendBreeStatusWhatsApp(mappedOrderStatus)) {
          logNotification({
            orderId: order.id,
            status: mappedOrderStatus,
            channel: "whatsapp",
            action: "skipped_delhivery_duplicate",
            result: "success",
          });
        } else if (recipientPhone) {
          try {
            await sendOrderStatusNotificationOnce({
              notificationKey: buildOrderStatusNotificationKey({
                orderId: order.id,
                status: mappedOrderStatus,
                channel: "whatsapp",
              }),
              orderId: order.id,
              status: mappedOrderStatus,
              channel: "whatsapp",
              send: () =>
                sendOrderStatusUpdateWhatsApp({
                  customerName: recipientName,
                  mobile: recipientPhone,
                  orderNumber: order.order_number,
                  orderUuid: order.id,
                  status: mappedOrderStatus,
                }),
            });
          } catch {
            // Already logged and recorded — see comment above.
          }
        } else {
          logNotification({
            orderId: order.id,
            status: mappedOrderStatus,
            channel: "whatsapp",
            action: "failed",
            result: "failure",
            error: "no customer phone (contact_phone/mobile_number both empty)",
          });
        }

        if (normalizedTrackingStatus === "delivered") {
          // Activate daily reminders when order is delivered
          try {
            const { rows: reminders } = await queryFn(
              `SELECT id FROM daily_reminders
               WHERE order_id = ? AND reminder_enabled = 1`,
              [order.id],
            );

            for (const reminder of reminders) {
              await activateReminderFn({
                reminderId: reminder.id,
                deliveryDate: new Date().toISOString().split("T")[0], // Today's date in YYYY-MM-DD
              });

              console.info(
                `[SHIPPING_CRON] Reminder activated for order ${order.id} reminder ${reminder.id}`,
              );
            }
          } catch (reminderError) {
            console.error(
              `[SHIPPING_CRON] Failed to activate reminders for order ${order.id}`,
              reminderError.message || reminderError,
            );
            // Don't throw — order delivery email sent successfully
          }
        }
      }

      console.log(
        `[SHIPPING_CRON] DB updated for order ${order.id} AWB ${awb} status: ${trackingStatus}`,
      );

      const isTerminal = TERMINAL_STATUSES.includes(normalizedTrackingStatus);
      if (isTerminal) {
        console.log(
          `[SHIPPING_CRON] Order ${order.id} AWB ${awb} reached terminal status ${trackingStatus}`,
        );
      }

      console.log(
        `[SHIPPING_CRON] API success for order ${order.id} AWB ${awb}`,
      );

      await resetTrackingSyncFailure(order, { queryFn }).catch((err) =>
        console.error(
          `[SHIPPING_CRON] Failed to reset tracking_sync_failure_count for order ${order.id}`,
          err,
        ),
      );
    } catch (error) {
      console.error(
        `[SHIPPING_CRON] API failure for order ${order.id} AWB ${awb}`,
        error.message || error,
      );

      await recordTrackingSyncFailure(order, { queryFn }).catch((err) =>
        console.error(
          `[SHIPPING_CRON] Failed to record tracking_sync_failure_count for order ${order.id}`,
          err,
        ),
      );
    }
  }

  console.log("[SHIPPING_CRON] Cron completion");
};

// FIX (Medium #16 — Phase 3): see utils/cronLock.js — prevents two app
// instances from both polling every due order every 30 minutes if this app
// is ever scaled horizontally.
const SHIPPING_CRON_LOCK_NAME = "bree_shipping_tracking_cron";

// FIX (return timeline not synchronized with Delhivery): reverse (return)
// shipments are tracked by a separate pass with its own logic and its own
// columns (services/reverseShipmentTracking.js) — the forward pass above
// only ever selects awb_number and never sees a reverse AWB. Same
// distributed-lock architecture, separate lock name, so either pass
// failing or being held elsewhere never blocks the other.
const REVERSE_TRACKING_CRON_LOCK_NAME = "bree_reverse_tracking_cron";

export const runReverseTrackingTick = async ({ runWithLock = runWithCronLock } = {}) => {
  try {
    const result = await runWithLock(REVERSE_TRACKING_CRON_LOCK_NAME, () =>
      syncReverseShipmentTracking(),
    );
    if (!result.ran) {
      console.log(
        "[REVERSE_TRACKING] Another instance already holds the lock — skipping this tick",
      );
    }
    return result;
  } catch (error) {
    console.error("[REVERSE_TRACKING] Cron run failed", error);
    return { ran: false, reason: "error" };
  }
};

export const startShippingTrackingCron = () => {
  const task = cron.schedule("*/30 * * * *", async () => {
    try {
      const result = await runWithCronLock(SHIPPING_CRON_LOCK_NAME, syncShippingTracking);
      if (!result.ran) {
        console.log(
          "[SHIPPING_CRON] Another instance already holds the lock — skipping this tick",
        );
      }
    } catch (error) {
      console.error("[SHIPPING_CRON] Cron run failed", error);
    }

    await runReverseTrackingTick();
  });

  return task;
};

export default startShippingTrackingCron;
