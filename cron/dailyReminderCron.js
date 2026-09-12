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
import { activateReminderFromDelivery } from "../src/services/dailyReminderService.js";

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
      dr.reminder_whatsapp_number,
      COALESCE(u.name, o.contact_name, o.customer_name, 'BREE Customer') AS customer_name,
      COALESCE(u.phone, o.contact_phone, o.mobile_number) AS customer_phone,
      drs.id AS send_record_id
    FROM daily_reminders dr
    LEFT JOIN users u ON dr.user_id = u.id
    INNER JOIN orders o ON dr.order_id = o.id
    LEFT JOIN daily_reminder_sends drs
      ON dr.id = drs.reminder_id
      AND drs.send_date = ?
      AND drs.status = 'success'
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
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        waplify_message_id = VALUES(waplify_message_id),
        error_message = NULL,
        sent_at = CURRENT_TIMESTAMP
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
 * Self-heals reminders stuck without an activation window.
 *
 * activateReminderFromDelivery() is normally called the moment an order's
 * delivery is detected (shippingTrackingCron.js for Delhivery-tracked
 * shipments, or the admin manual-delivery path). If that call was ever
 * missed — e.g. an order was marked "delivered" before the activation
 * hook existed, or a one-off failure — the reminder's start/end dates stay
 * NULL forever and getEligibleReminders() can never select it, even though
 * the order genuinely is delivered. Catch that here using the order's own
 * delivered_at as the source of truth, so a previously-stuck reminder
 * starts on the next scheduler tick instead of needing a manual DB fix.
 */
const activateStuckReminders = async () => {
  try {
    const { rows } = await query(
      `
      SELECT dr.id, dr.order_id, o.delivered_at
      FROM daily_reminders dr
      INNER JOIN orders o ON dr.order_id = o.id
      WHERE dr.reminder_enabled = 1
        AND dr.status = 'active'
        AND dr.reminder_start_date IS NULL
        AND o.order_status = 'delivered'
        AND o.delivered_at IS NOT NULL
      `,
    );

    for (const row of rows) {
      const deliveryDate = new Date(row.delivered_at)
        .toISOString()
        .split("T")[0];

      const result = await activateReminderFromDelivery({
        reminderId: row.id,
        deliveryDate,
      });

      if (result.success) {
        console.info(
          `[Reminder Scheduler] Self-healed reminder ${row.id} for order ${row.order_id} | delivered=${deliveryDate} | start=${result.startDate} end=${result.endDate}`,
        );
      } else {
        console.error(
          `[Reminder Scheduler] Failed to self-heal reminder ${row.id} for order ${row.order_id}: ${result.error}`,
        );
      }
    }
  } catch (error) {
    console.error(
      "[Reminder Scheduler] Self-heal query failed:",
      error.message,
    );
  }
};

/**
 * Logs why enabled+active reminders were excluded from today's eligible
 * batch (no PII beyond order id — no phone numbers, no names). This exists
 * so "[Reminder Scheduler] No eligible reminders found" can be diagnosed
 * from logs alone instead of guessing — e.g. a reminder purchased on an
 * order that was manually marked delivered without the activation step
 * running shows up here as "not yet activated" (start/end date NULL).
 */
const logSkippedReminders = async (today) => {
  try {
    const { rows } = await query(
      `
      SELECT
        dr.id,
        dr.order_id,
        dr.reminder_enabled,
        dr.status,
        dr.reminder_start_date,
        dr.reminder_end_date,
        drs.id AS send_record_id
      FROM daily_reminders dr
      LEFT JOIN daily_reminder_sends drs
        ON dr.id = drs.reminder_id
        AND drs.send_date = ?
        AND drs.status = 'success'
      WHERE dr.reminder_enabled = 1 AND dr.status = 'active'
      `,
      [today],
    );

    for (const r of rows) {
      let reason = null;
      if (!r.reminder_start_date || !r.reminder_end_date) {
        reason = "not_yet_activated (delivery activation never ran)";
      } else if (today < r.reminder_start_date) {
        reason = `before_start_date (starts ${r.reminder_start_date})`;
      } else if (today > r.reminder_end_date) {
        reason = `after_end_date (ended ${r.reminder_end_date})`;
      } else if (r.send_record_id) {
        reason = "already_sent_today";
      }

      if (reason) {
        console.info(
          `[Reminder Scheduler] Order ${r.order_id} reminder ${r.id} skipped | enabled=true | reason=${reason}`,
        );
      }
    }
  } catch (error) {
    console.error("[Reminder Scheduler] Diagnostic logging failed:", error.message);
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
    // Heal any reminder stuck on a delivered order before evaluating
    // eligibility, so a reminder that just got healed can be picked up in
    // this same run if it's already within its window.
    await activateStuckReminders();

    const reminders = await getEligibleReminders(today);

    // Runs regardless of whether any reminders were found eligible — an
    // active reminder stuck at "not_yet_activated" is invisible to
    // getEligibleReminders() itself, so it needs its own diagnostic pass.
    await logSkippedReminders(today);

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
        reminder_whatsapp_number,
        reminder_time,
        reminder_start_date,
        reminder_end_date,
      } = reminder;

      const sendMobile = reminder_whatsapp_number || customer_phone;

      if (!sendMobile) {
        skipped++;
        console.warn(
          `[Reminder Scheduler] Skipping reminder ${reminderId} for order ${reminder.order_id}: no WhatsApp number`,
        );
        continue;
      }

      console.info(
        `[Reminder Scheduler] Eligible reminder ${reminderId} for order ${reminder.order_id} | enabled=${Boolean(reminder.reminder_enabled)} | window=${reminder_start_date}..${reminder_end_date} | scheduled=${reminder_time} | current=${currentTime}`,
      );

      // Check if current time is within tolerance of scheduled time
      if (!isWithinReminderTimeWindow(reminder_time, currentTime)) {
        skipped++;
        console.info(
          `[Reminder Scheduler] Skipping reminder ${reminderId} for order ${reminder.order_id}: outside time window`,
        );
        continue;
      }

      try {
        // Send the WhatsApp reminder
        // NOTE: safelySendWhatsApp resolves { success: true, result } on
        // success but { success: false, error } (not `result`) on failure —
        // destructure both so a real provider error isn't lost as
        // "Unknown error" below.
        const { success, result, error: sendError } = await safelySendWhatsApp(
          `daily-reminder-${reminderId}`,
          () =>
            sendDailyWellnessReminder({
              mobile: sendMobile,
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
            `[Reminder] Sent reminder ${reminderId} to ${sendMobile} (${customer_name}) | Message ID: ${result.data.message_id}`,
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
          const errorMessage = sendError?.message || String(sendError || "Unknown error");
          await recordReminderFailure(reminderId, today, errorMessage);

          console.error(
            `[Reminder] Failed to send reminder ${reminderId} to ${sendMobile}: ${errorMessage}`,
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
