/**
 * Daily Reminder Service
 *
 * Handles creation and management of daily reminder purchases
 */

import { query } from "../config/database.js";
import { randomUUID } from "crypto";
import { validateMobile } from "./whatsappNotificationService.js";

/**
 * Creates a daily reminder record after successful payment
 *
 * Reminder does NOT start immediately - it only activates after delivery.
 * reminder_start_date and reminder_end_date are calculated when delivery is confirmed.
 *
 * @param {Object} options
 * @param {string} options.userId - Customer user ID
 * @param {string} options.orderId - Order ID
 * @param {string} options.orderItemId - Order item ID (optional)
 * @param {string} options.productId - Product ID
 * @param {string} options.reminderTime - Selected time (HH:MM, e.g., "05:30")
 * @param {number} options.reminderPricePaid - Actual price paid by customer
 * @param {number} options.reminderOriginalPrice - Original/display price at purchase
 * @param {number} options.packageDurationDays - Duration of package (e.g., 30, 180, 365)
 * @param {string|null} options.reminderWhatsappNumber - Selected WhatsApp number for sending reminders
 * @param {string} options.reminderPhoneSource - Source of the selected number: profile|custom
 * @returns {Promise<{success: boolean, reminderId?: string, error?: string}>}
 */
export const createDailyReminder = async ({
  userId,
  orderId,
  orderItemId = null,
  productId,
  reminderTime,
  reminderPricePaid,
  reminderOriginalPrice,
  packageDurationDays = null,
  reminderWhatsappNumber = null,
  reminderPhoneSource = "profile",
}) => {
  try {
    // Validate reminder time (must be one of: 04:00, 04:30, 05:00, 05:30, 06:00)
    const ALLOWED_TIMES = ["04:00", "04:30", "05:00", "05:30", "06:00"];
    if (!ALLOWED_TIMES.includes(reminderTime)) {
      return {
        success: false,
        error: `Invalid reminder time. Allowed times: ${ALLOWED_TIMES.join(", ")}`,
      };
    }

    const reminderId = randomUUID();
    const normalizedWhatsappNumber =
      reminderWhatsappNumber && String(reminderWhatsappNumber).trim()
        ? validateMobile(reminderWhatsappNumber)
        : null;
    const safePhoneSource =
      reminderPhoneSource === "custom" ? "custom" : "profile";

    await query(
      `
      INSERT INTO daily_reminders
      (id, user_id, order_id, order_item_id, product_id,
       reminder_enabled, reminder_time, reminder_channel,
       reminder_whatsapp_number, reminder_phone_source,
       reminder_price_paid, reminder_original_price,
       package_duration_days, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        reminderId,
        userId,
        orderId,
        orderItemId,
        productId,
        1, // reminder_enabled = true (always enabled on creation)
        reminderTime,
        "whatsapp",
        normalizedWhatsappNumber,
        safePhoneSource,
        reminderPricePaid,
        reminderOriginalPrice,
        packageDurationDays,
        "active",
      ],
    );

    console.log(
      `[Reminder] Created reminder ${reminderId} for order ${orderId} | Time: ${reminderTime} | Phone: ${normalizedWhatsappNumber || "fallback-user-phone"} | Source: ${safePhoneSource}`,
    );

    return { success: true, reminderId };
  } catch (error) {
    console.error("[Reminder] Error creating reminder:", error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Activates a reminder by setting its start and end dates
 * Called when the order/package is confirmed as delivered
 *
 * reminder_start_date = delivery_date + 1 day (first reminder is next calendar day)
 * reminder_end_date = delivery_date + package_duration_days
 *
 * @param {Object} options
 * @param {string} options.reminderId - Reminder ID
 * @param {Date|string} options.deliveryDate - Date the order was delivered (YYYY-MM-DD)
 * @returns {Promise<{success: boolean, startDate?: string, endDate?: string, error?: string}>}
 */
export const activateReminderFromDelivery = async ({
  reminderId,
  deliveryDate,
}) => {
  try {
    // Parse delivery date
    const delivDate = new Date(deliveryDate);
    if (isNaN(delivDate.getTime())) {
      return {
        success: false,
        error: "Invalid delivery date format",
      };
    }

    // Fetch the reminder to get package duration
    const { rows: reminderRows } = await query(
      `SELECT package_duration_days FROM daily_reminders WHERE id = ? LIMIT 1`,
      [reminderId],
    );

    if (!reminderRows.length) {
      return {
        success: false,
        error: "Reminder not found",
      };
    }

    const packageDurationDays = reminderRows[0].package_duration_days || 30;

    // Calculate start date (delivery + 1 day)
    const startDate = new Date(delivDate);
    startDate.setDate(startDate.getDate() + 1);
    const startDateStr = formatDateISO(startDate);

    // Calculate end date (delivery + package duration)
    const endDate = new Date(delivDate);
    endDate.setDate(endDate.getDate() + packageDurationDays);
    const endDateStr = formatDateISO(endDate);

    // Update the reminder with delivery and calculated dates
    await query(
      `
      UPDATE daily_reminders
      SET delivery_date = ?, reminder_start_date = ?, reminder_end_date = ?, updated_at = NOW()
      WHERE id = ?
      `,
      [formatDateISO(delivDate), startDateStr, endDateStr, reminderId],
    );

    console.log(
      `[Reminder] Activated reminder ${reminderId} | Start: ${startDateStr}, End: ${endDateStr}`,
    );

    return {
      success: true,
      deliveryDate: formatDateISO(delivDate),
      startDate: startDateStr,
      endDate: endDateStr,
    };
  } catch (error) {
    console.error("[Reminder] Error activating reminder:", error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Gets all active reminders for a customer
 *
 * @param {string} userId - Customer user ID
 * @returns {Promise<Array>} Array of active reminders
 */
export const getCustomerReminders = async (userId) => {
  try {
    const { rows } = await query(
      `
      SELECT
        id, order_id, product_id, reminder_time, reminder_price_paid,
        reminder_original_price, delivery_date, reminder_start_date,
        reminder_end_date, package_duration_days, status, created_at
      FROM daily_reminders
      WHERE user_id = ? AND status = 'active'
      ORDER BY created_at DESC
      `,
      [userId],
    );
    return rows;
  } catch (error) {
    console.error("[Reminder] Error fetching customer reminders:", error);
    return [];
  }
};

/**
 * Gets reminder details for an order
 *
 * @param {string} orderId - Order ID
 * @returns {Promise<Object|null>} Reminder details or null
 */
export const getOrderReminder = async (orderId) => {
  try {
    const { rows } = await query(
      `
      SELECT
        id, user_id, reminder_enabled, reminder_time, reminder_price_paid,
        reminder_original_price, delivery_date, reminder_start_date,
        reminder_end_date, package_duration_days, status
      FROM daily_reminders
      WHERE order_id = ? LIMIT 1
      `,
      [orderId],
    );
    return rows.length ? rows[0] : null;
  } catch (error) {
    console.error("[Reminder] Error fetching order reminder:", error);
    return null;
  }
};

/**
 * Disables a reminder (but keeps the record for history)
 *
 * @param {string} reminderId - Reminder ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const disableReminder = async (reminderId) => {
  try {
    await query(
      `UPDATE daily_reminders SET status = 'paused', updated_at = NOW() WHERE id = ?`,
      [reminderId],
    );

    console.log(`[Reminder] Disabled reminder ${reminderId}`);
    return { success: true };
  } catch (error) {
    console.error("[Reminder] Error disabling reminder:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Re-enables a reminder
 *
 * @param {string} reminderId - Reminder ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const enableReminder = async (reminderId) => {
  try {
    await query(
      `UPDATE daily_reminders SET status = 'active', updated_at = NOW() WHERE id = ?`,
      [reminderId],
    );

    console.log(`[Reminder] Enabled reminder ${reminderId}`);
    return { success: true };
  } catch (error) {
    console.error("[Reminder] Error enabling reminder:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Marks reminder as ended (past reminder_end_date)
 *
 * @param {string} reminderId - Reminder ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const endReminder = async (reminderId) => {
  try {
    await query(
      `UPDATE daily_reminders SET status = 'ended', updated_at = NOW() WHERE id = ?`,
      [reminderId],
    );

    console.log(`[Reminder] Ended reminder ${reminderId}`);
    return { success: true };
  } catch (error) {
    console.error("[Reminder] Error ending reminder:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Helper: Format date as YYYY-MM-DD
 */
const formatDateISO = (date) => {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

export default {
  createDailyReminder,
  activateReminderFromDelivery,
  getCustomerReminders,
  getOrderReminder,
  disableReminder,
  enableReminder,
  endReminder,
};
