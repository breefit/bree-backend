import cron from "node-cron";
import { query } from "../src/config/database.js";
import delhiveryService from "../src/services/delhiveryService.js";
import {
  extractDelhiveryTrackingDetails,
  normalizeTrackingStatus,
  mapTrackingStatusToOrderStatus,
} from "../src/controllers/shippingController.js";
import { appendStatusHistory } from "../src/models/Order.js";
import {
  sendOutForDeliveryEmail,
  sendShipmentDeliveredEmail,
} from "../src/services/orderEmailService.js";

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
            contact_name, contact_email, tracking_url, courier_name
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

      if (orderStatusChanged) {
        const mappedOrderStatus =
          mapTrackingStatusToOrderStatus(trackingStatus);
        if (mappedOrderStatus) {
          updateFields.push("order_status = ?");
          updateParams.push(mappedOrderStatus);
        }
      }

      updateParams.push(order.id);

      await query(
        `UPDATE orders SET ${updateFields.join(", ")} WHERE id = ?`,
        updateParams,
      );

      if (orderStatusChanged) {
        const mappedOrderStatus =
          mapTrackingStatusToOrderStatus(trackingStatus);
        if (mappedOrderStatus) {
          await appendStatusHistory({
            orderId: order.id,
            previousStatus: order.order_status,
            newStatus: mappedOrderStatus,
            changedBy: null,
            notes: `Order status auto-synced from Delhivery tracking status "${trackingStatus}" for AWB ${awb}`,
          });
        }
      }

      if (orderStatusChanged) {
        if (normalizedTrackingStatus === "out for delivery") {
          try {
            await sendOutForDeliveryEmail({
              to: order.contact_email,
              name: order.contact_name,
              orderId: order.id,
              awbNumber: order.awb_number,
              trackingUrl: order.tracking_url,
              currentLocation: parsedTracking.currentLocation,
              expectedDeliveryDate: parsedTracking.expectedDelivery,
            });
          } catch (emailError) {
            console.error(
              `[SHIPPING_CRON] Failed to send out-for-delivery email for order ${order.id}`,
              emailError,
            );
          }
        } else if (normalizedTrackingStatus === "delivered") {
          try {
            await sendShipmentDeliveredEmail({
              to: order.contact_email,
              name: order.contact_name,
              orderId: order.id,
            });
          } catch (emailError) {
            console.error(
              `[SHIPPING_CRON] Failed to send delivered email for order ${order.id}`,
              emailError,
            );
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
