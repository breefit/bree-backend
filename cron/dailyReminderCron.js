/**
 * Daily Wellness Reminder Scheduler
 *
 * Sends WhatsApp reminders to customers who have purchased the reminder add-on.
 * Reminders are sent only if:
 * - The reminder is enabled and active
 * - The order/package has been delivered
 * - Current date is >= reminder_start_date and <= reminder_end_date
 * - Current time matches the selected reminder time (within a tolerance window)
 * - No reminder has been sent for this reminder on today's date (idempotency)
 *
 * Timezone: Asia/Kolkata (IST)
 */

import { query } from "../src/config/database.js";
import {
  sendDailyWellnessReminder,
  safelySendWhatsApp,
} from "../src/services/whatsappNotificationService.js";

const TIMEZONE = "Asia/Kolkata";
const TOLERANCE_MINUTES = 5; // Send within 5 minutes of scheduled time

/**
 * Gets current date in YYYY-MM-DD format (Asia/Kolkata timezone)
 */
const getTodayIST = () => {
  const now = new Date();
  const istTime = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const yyyy = istTime.getFullYear();
  const mm = String(istTime.getMonth() + 1).padStart(2, "0");
  const dd = String(istTime.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * Gets current time in HH:MM format (Asia/Kolkata timezone)
 */
const getCurrentTimeIST = () => {
  const now = new Date();
  const istTime = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const hours = String(istTime.getHours()).padStart(2, "0");
  const minutes = String(istTime.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

/**
 * Checks if current time is within tolerance of the scheduled reminder time
 */
const isWithinReminderTimeWindow = (
  scheduledTime,
  currentTime,
  toleranceMinutes = TOLERANCE_MINUTES,
) => {
  const [scheduledHour, scheduledMinute] = scheduledTime.split(":").map(Number);
  const [currentHour, currentMinute] = currentTime.split(":").map(Number);

  const scheduledTotalMinutes = scheduledHour * 60 + scheduledMinute;
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  const diff = Math.abs(currentTotalMinutes - scheduledTotalMinutes);
  return diff <= toleranceMinutes;
};

/**
 * Fetches all eligible reminders for sending today
 * Eligibility criteria:
 * - reminder_enabled = 1
 * - status = 'active'
 * - reminder_start_date <= TODAY
 * - reminder_end_date >= TODAY
 * - NOT already sent today (checked via daily_reminder_sends table)
 */
const getEligibleReminders = async (today) => {
  const { rows } = await query(
    `
    SELECT
      dr.id,
      dr.user_id,
      dr.order_id,
      dr.product_id,
      dr.reminder_enabled,
      dr.reminder_time,
      dr.reminder_start_date,
      dr.reminder_end_date,
      u.name AS customer_name,
      u.phone AS customer_phone,
      drs.id AS send_record_id
    FROM daily_reminders dr
    INNER JOIN users u ON dr.user_id = u.id
    LEFT JOIN daily_reminder_sends drs ON dr.id = drs.reminder_id AND drs.send_date = ?
    WHERE
      dr.reminder_enabled = 1
      AND dr.status = 'active'
      AND dr.reminder_start_date IS NOT NULL
      AND dr.reminder_end_date IS NOT NULL
      AND dr.reminder_start_date <= ?
      AND dr.reminder_end_date >= ?
      AND drs.id IS NULL
    ORDER BY dr.reminder_time ASC
    `,
    [today, today, today],
  );
  return rows;
};

/**
 * Marks a reminder as successfully sent for a given date
 * Uses UNIQUE constraint on (reminder_id, send_date) to prevent duplicates
 */
const recordReminderSend = async (
  reminderId,
  sendDate,
  waplifyMessageId = null,
  status = "success",
) => {
  const { randomUUID } = await import("crypto");
  const recordId = randomUUID();

  try {
    await query(
      `
      INSERT INTO daily_reminder_sends
      (id, reminder_id, send_date, status, waplify_message_id)
      VALUES (?, ?, ?, ?, ?)
      `,
      [recordId, reminderId, sendDate, status, waplifyMessageId],
    );
    return { success: true, recordId };
  } catch (error) {
    // If UNIQUE constraint violation, another instance already recorded this send
    if (error.code === "ER_DUP_ENTRY" || error.message.includes("UNIQUE")) {
      console.log(
        `[Reminder] Duplicate send prevented for reminder ${reminderId} on ${sendDate}`,
      );
      return { success: false, reason: "duplicate" };
    }
    throw error;
  }
};

/**
 * Records a failed reminder send attempt
 */
const recordReminderFailure = async (reminderId, sendDate, errorMessage) => {
  const { randomUUID } = await import("crypto");
  const recordId = randomUUID();

  try {
    await query(
      `
      INSERT INTO daily_reminder_sends
      (id, reminder_id, send_date, status, error_message)
      VALUES (?, ?, ?, ?, ?)
      `,
      [recordId, reminderId, sendDate, "failed", errorMessage],
    );
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY" || error.message.includes("UNIQUE")) {
      console.log(
        `[Reminder] Duplicate failure record prevented for reminder ${reminderId} on ${sendDate}`,
      );
      return;
    }
    throw error;
  }
};

/**
 * Main scheduler function - runs periodically (e.g., every minute)
 * Checks if current time matches any reminder's scheduled time,
 * and sends reminders if eligible
 */
export const runDailyReminderScheduler = async () => {
  const today = getTodayIST();
  const currentTime = getCurrentTimeIST();

  console.log(`[Reminder Scheduler] Running at ${currentTime} IST (${today})`);

  try {
    const reminders = await getEligibleReminders(today);

    if (!reminders.length) {
      console.log(
        `[Reminder Scheduler] No eligible reminders found for ${today}`,
      );
      return { processed: 0, sent: 0, skipped: 0, failed: 0 };
    }

    console.log(
      `[Reminder Scheduler] Found ${reminders.length} eligible reminders`,
    );

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const reminder of reminders) {
      const {
        id: reminderId,
        customer_name,
        customer_phone,
        reminder_time,
        reminder_start_date,
        reminder_end_date,
      } = reminder;

      // Check if current time is within tolerance of scheduled time
      if (!isWithinReminderTimeWindow(reminder_time, currentTime)) {
        skipped++;
        continue;
      }

      try {
        // Send the WhatsApp reminder
        const { success, result } = await safelySendWhatsApp(
          `daily-reminder-${reminderId}`,
          () =>
            sendDailyWellnessReminder({
              mobile: customer_phone,
              customerName: customer_name,
            }),
        );

        if (success && result?.data?.message_id) {
          // Record successful send
          await recordReminderSend(
            reminderId,
            today,
            result.data.message_id,
            "success",
          );
          sent++;

          console.log(
            `[Reminder] Sent reminder ${reminderId} to ${customer_phone} (${customer_name}) | Message ID: ${result.data.message_id}`,
          );
        } else if (success) {
          // Sent but no message ID in response
          await recordReminderSend(reminderId, today, null, "success");
          sent++;

          console.log(
            `[Reminder] Sent reminder ${reminderId} to ${customer_phone} (${customer_name})`,
          );
        } else {
          // Send failed
          failed++;
          await recordReminderFailure(
            reminderId,
            today,
            result?.error || "Unknown error",
          );

          console.error(
            `[Reminder] Failed to send reminder ${reminderId} to ${customer_phone}: ${result?.error}`,
          );
        }
      } catch (error) {
        failed++;
        await recordReminderFailure(reminderId, today, error.message);

        console.error(
          `[Reminder] Exception while sending reminder ${reminderId}: ${error.message}`,
        );
      }
    }

    console.log(
      `[Reminder Scheduler] Complete | Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}`,
    );

    return {
      processed: reminders.length,
      sent,
      skipped,
      failed,
    };
  } catch (error) {
    console.error("[Reminder Scheduler] Fatal error:", error);
    throw error;
  }
};

export default {
  runDailyReminderScheduler,
};
