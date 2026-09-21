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
  maskMobile,
} from "../src/services/whatsappNotificationService.js";
import { activateReminderFromDelivery } from "../src/services/dailyReminderService.js";
import os from "os";

const TIMEZONE = "Asia/Kolkata";
const TOLERANCE_MINUTES = 5; // Send within 5 minutes of scheduled time

// FIX (live verification — Issue 2, triple scheduler executions): this cron
// has no distributed lock (unlike shippingTrackingCron.js's
// runWithCronLock) — a deliberate, already-audited decision (see
// tests/cronConcurrencyAudit.test.js job 3): every actual SEND is protected
// at the database level by claimReminderSendSlot's atomic INSERT IGNORE +
// conditional UPDATE, backed by UNIQUE KEY unique_reminder_send(reminder_id,
// send_date) — proven safe under real concurrent callers in
// tests/dailyReminder.test.js. Logging host+PID on every tick is purely
// diagnostic: it lets a live log grep instantly tell "one process ticking
// 3x" (a code bug) apart from "3 separate OS processes each ticking once"
// (an orphaned/duplicate PM2 process from a redeploy) — it does not gate,
// delay, or skip any run, so it changes no business/timing behavior.
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

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
export const isWithinReminderTimeWindow = (
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

// FIX (concurrent cron/worker duplicate-send race): the previous design
// called the WhatsApp API FIRST and only tried to record a
// daily_reminder_sends row afterwards, using `INSERT ... ON DUPLICATE KEY
// UPDATE` — which never throws, so the ER_DUP_ENTRY handling below it could
// never actually run. Two ticks racing (a second PM2/cluster instance
// running the same cron, or a manual retry overlapping a scheduled run)
// could both pass eligibility, both call the WhatsApp provider for the
// same reminder+day, and both then silently overwrite the same row — two
// real messages sent, one row, no error anywhere.
//
// Same claim-before-send shape as services/orderStatusNotificationService.js
// (already proven for order-status notifications this session): INSERT
// IGNORE creates a 'pending' row, then an atomic UPDATE ... WHERE
// status='pending' is the actual claim — only the caller whose UPDATE
// affects a row may call the provider. A 'sending' row older than the
// staleness window is reclaimable (crashed process), same rationale as the
// order-status service. A same-day 'failed' row is always reclaimable, so
// the very next minute's tick naturally retries within today's tolerance
// window — no separate retry job needed.
const STALE_CLAIM_MINUTES = 5;

// queryExecutor defaults to the real pool — same injection pattern as
// dailyReminderService.createDailyReminder and
// orderStatusNotificationService.sendOrderStatusNotificationOnce, so this
// claim/send/resolve state machine can be exercised against an in-memory
// fake in tests without touching the production database.
export const claimReminderSendSlot = async (
  reminderId,
  sendDate,
  queryExecutor = query,
) => {
  const { randomUUID } = await import("crypto");
  const recordId = randomUUID();

  await queryExecutor(
    `INSERT IGNORE INTO daily_reminder_sends (id, reminder_id, send_date, status)
     VALUES (?, ?, ?, 'pending')`,
    [recordId, reminderId, sendDate],
  );

  const claimResult = await queryExecutor(
    `UPDATE daily_reminder_sends
     SET status = 'sending', sent_at = CURRENT_TIMESTAMP
     WHERE reminder_id = ? AND send_date = ?
       AND (
         status = 'pending'
         OR status = 'failed'
         OR (status = 'sending' AND sent_at < NOW() - INTERVAL ? MINUTE)
       )`,
    [reminderId, sendDate, STALE_CLAIM_MINUTES],
  );

  return { claimed: Boolean(claimResult.rowCount) };
};

/** Resolves a claimed send slot as successfully sent. */
export const resolveReminderSendSuccess = async (
  reminderId,
  sendDate,
  waplifyMessageId,
  queryExecutor = query,
) => {
  await queryExecutor(
    `UPDATE daily_reminder_sends
     SET status = 'success', waplify_message_id = ?, error_message = NULL,
         sent_at = CURRENT_TIMESTAMP
     WHERE reminder_id = ? AND send_date = ? AND status = 'sending'`,
    [waplifyMessageId, reminderId, sendDate],
  );
};

/** Resolves a claimed send slot as failed — reclaimable by the next tick. */
export const resolveReminderSendFailure = async (
  reminderId,
  sendDate,
  errorMessage,
  queryExecutor = query,
) => {
  await queryExecutor(
    `UPDATE daily_reminder_sends
     SET status = 'failed', error_message = ?
     WHERE reminder_id = ? AND send_date = ? AND status = 'sending'`,
    [String(errorMessage || "Unknown error").slice(0, 1000), reminderId, sendDate],
  );
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

  console.log(
    `[Reminder Scheduler] Running at ${currentTime} IST (${today}) | instance=${INSTANCE_ID}`,
  );

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
        // Claim the send slot BEFORE calling the provider — this is what
        // actually prevents a concurrent tick/worker from double-sending
        // (see claimReminderSendSlot's comment above). Nothing calls the
        // WhatsApp API unless this succeeds.
        const { claimed } = await claimReminderSendSlot(reminderId, today);
        if (!claimed) {
          skipped++;
          console.info(
            `[DAILY_REMINDER] DUPLICATE_SKIPPED | reminderId=${reminderId} | orderId=${reminder.order_id} | channel=whatsapp | instance=${INSTANCE_ID}`,
          );
          continue;
        }

        console.info(
          `[DAILY_REMINDER] CLAIMED | reminderId=${reminderId} | orderId=${reminder.order_id} | instance=${INSTANCE_ID}`,
        );

        // NOTE: safelySendWhatsApp resolves { success: true, result } on
        // success but { success: false, error } (not `result`) on failure —
        // destructure both so a real provider error isn't lost as
        // "Unknown error" below.
        console.info(
          `[DAILY_REMINDER] ATTEMPT | reminderId=${reminderId} | orderId=${reminder.order_id} | channel=whatsapp | phone=${maskMobile(sendMobile)}`,
        );
        const { success, result, error: sendError } = await safelySendWhatsApp(
          `daily-reminder-${reminderId}`,
          () =>
            sendDailyWellnessReminder({
              mobile: sendMobile,
              customerName: customer_name,
            }),
        );

        if (success) {
          const messageId = result?.data?.message_id || null;
          await resolveReminderSendSuccess(reminderId, today, messageId);
          sent++;

          console.log(
            `[DAILY_REMINDER] SUCCESS | reminderId=${reminderId} | orderId=${reminder.order_id} | phone=${maskMobile(sendMobile)} | providerMessageId=${messageId || "none"}`,
          );
        } else {
          failed++;
          const errorMessage = sendError?.message || String(sendError || "Unknown error");
          await resolveReminderSendFailure(reminderId, today, errorMessage);

          console.error(
            `[DAILY_REMINDER] FAILED | reminderId=${reminderId} | orderId=${reminder.order_id} | phone=${maskMobile(sendMobile)} | error=${errorMessage}`,
          );
        }
      } catch (error) {
        failed++;
        await resolveReminderSendFailure(reminderId, today, error.message);

        console.error(
          `[DAILY_REMINDER] FAILED | reminderId=${reminderId} | orderId=${reminder.order_id} | error=${error.message}`,
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
