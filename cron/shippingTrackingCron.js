import cron from "node-cron";
import { query } from "../src/config/database.js";
import delhiveryService from "../src/services/delhiveryService.js";
import {
  extractDelhiveryTrackingDetails,
  normalizeTrackingStatus,
  mapTrackingStatusToOrderStatus,
  isForwardOrderStatusTransition,
} from "../src/controllers/shippingController.js";
import { appendStatusHistory } from "../src/models/Order.js";
import {
  sendOutForDeliveryEmail,
  sendShipmentDeliveredEmail,
  sendOrderStatusUpdateEmail,
} from "../src/services/orderEmailService.js";
import { sendOrderStatusUpdateWhatsApp } from "../src/services/whatsappNotificationService.js";
import { activateReminderFromDelivery } from "../src/services/dailyReminderService.js";

const TERMINAL_STATUSES = ["delivered", "cancelled", "returned"];

const getAvailableOrderColumns = async () => {
  const { rows } = await query("SHOW COLUMNS FROM orders");
  const fields = new Set((rows || []).map((row) => row.Field));

  return {
    hasCurrentLocation: fields.has("current_location"),
    hasExpectedDelivery:
      fields.has("expected_delivery") || fields.has("expected_delivery_date"),
    hasLastTrackingUpdate: fields.has("last_tracking_update"),
  };
};

export const syncShippingTracking = async () => {
  console.log("[SHIPPING_CRON] Cron start");

  const { rows: orders } = await query(
    `SELECT id, order_number, order_status, awb_number, tracking_status,
            contact_name, customer_name, email, contact_email,
            mobile_number, contact_phone, tracking_url, courier_name
     FROM orders
     WHERE awb_number IS NOT NULL
       AND awb_number != ''
       AND LOWER(TRIM(COALESCE(tracking_status, ''))) NOT IN ('delivered', 'cancelled', 'returned')`,
  );

  const availableColumns = await getAvailableOrderColumns();
  console.log(`[SHIPPING_CRON] Processing ${orders.length} orders`);

  for (const order of orders) {
    const awb = order.awb_number;
    if (!awb) continue;

    console.log(`[SHIPPING_CRON] Processing order ${order.id} AWB ${awb}`);

    try {
      const trackingResponse = await delhiveryService.trackShipment(awb);
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

      updateParams.push(order.id);
      const updateWhere = shouldTransitionOrderStatus
        ? "WHERE id = ? AND order_status = ?"
        : "WHERE id = ?";
      if (shouldTransitionOrderStatus) {
        updateParams.push(order.order_status);
      }

      const updateResult = await query(
        `UPDATE orders SET ${updateFields.join(", ")} ${updateWhere}`,
        updateParams,
      );

      if (
        shouldTransitionOrderStatus &&
        !Number(updateResult.affectedRows ?? updateResult.rowCount)
      ) {
        console.warn(
          `[SHIPPING_CRON] Skipping stale status transition for order ${order.id}; another update won the race`,
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

        if (recipientEmail) {
          try {
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
          } catch (emailError) {
            console.error(
              `[SHIPPING_CRON] Failed to send ${mappedOrderStatus} email for order ${order.id}`,
              emailError,
            );
          }
        } else {
          console.error(
            `[SHIPPING_CRON] Cannot send ${mappedOrderStatus} email for order ${order.id}: no customer email in contact_email or email`,
          );
        }

        if (recipientPhone) {
          try {
            await sendOrderStatusUpdateWhatsApp({
              customerName: recipientName,
              mobile: recipientPhone,
              orderNumber: order.order_number,
              orderUuid: order.id,
              status: mappedOrderStatus,
            });
          } catch (whatsappError) {
            console.error(
              `[SHIPPING_CRON] Failed to send ${mappedOrderStatus} WhatsApp for order ${order.id}`,
              whatsappError,
            );
          }
        } else {
          console.error(
            `[SHIPPING_CRON] Cannot send ${mappedOrderStatus} WhatsApp for order ${order.id}: no customer phone in contact_phone or mobile_number`,
          );
        }

        if (normalizedTrackingStatus === "delivered") {
          // Activate daily reminders when order is delivered
          try {
            const { rows: reminders } = await query(
              `SELECT id FROM daily_reminders
               WHERE order_id = ? AND reminder_enabled = 1`,
              [order.id],
            );

            for (const reminder of reminders) {
              await activateReminderFromDelivery({
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
    } catch (error) {
      console.error(
        `[SHIPPING_CRON] API failure for order ${order.id} AWB ${awb}`,
        error.message || error,
      );
    }
  }

  console.log("[SHIPPING_CRON] Cron completion");
};

export const startShippingTrackingCron = () => {
  const task = cron.schedule("*/30 * * * *", async () => {
    try {
      await syncShippingTracking();
    } catch (error) {
      console.error("[SHIPPING_CRON] Cron run failed", error);
    }
  });

  return task;
};

export default startShippingTrackingCron;
