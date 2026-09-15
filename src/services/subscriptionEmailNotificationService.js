import { query } from "../config/database.js";

// FIX (stuck-claim bug — idempotency table must never eat a real send):
// the claim UPDATE below used to only move 'pending' (or, with
// retryFailed, 'failed') rows to 'sending'. If the process ever died
// between claiming (status='sending') and resolving to 'sent'/'failed' —
// a PM2 restart during deploy, an uncaught exception, a killed worker —
// that row stayed stuck at 'sending' forever, and no subscription email
// for that key (activation/pause/resume/cancel/renewal/halted/payment-
// failed) could ever be sent again: every later attempt found
// rowCount = 0 and looked like a harmless duplicate_skipped, even though
// no notification had ever actually gone out. Same reclaim rule already
// proven for order-status notifications (see
// services/orderStatusNotificationService.js) — a 'sending' row older
// than this is treated as abandoned and reclaimable, same as a 'failed'
// one.
const STALE_CLAIM_MINUTES = 5;

// FIX (subscription WhatsApp sends had ZERO idempotency): every
// sendSubscriptionStatusWhatsApp call site (customer create/pause/resume/
// cancel, the mirrored admin actions, and every webhook event) fired
// straight through sendWhatsAppSafe with no claim/dedupe of any kind —
// unlike email, which has always gone through this table. A retried
// admin API call, a webhook redelivery, or the same lifecycle event
// reaching BREE through two independent triggers (e.g. verifyPayment AND
// the subscription.activated webhook, both racing to confirm the same
// first payment) could each independently call the WhatsApp provider and
// send the customer the same message twice.
//
// Rather than build a parallel table+service for WhatsApp, this claim/
// send/resolve mechanism is channel-agnostic already — nothing about it
// is email-specific — so it's reused as-is for WhatsApp, distinguished
// purely by the notificationKey string (WhatsApp keys carry an explicit
// `:whatsapp` suffix; see whatsappNotificationService call sites). Same
// shared table (subscription_email_notifications) as before; the name
// predates this reuse but renaming the table/file for a naming nicety
// isn't worth the migration risk.
export const sendSubscriptionNotificationOnce = async ({
  notificationKey,
  send,
  retryFailed = false,
  // Same injection pattern as dailyReminderService.createDailyReminder and
  // orderStatusNotificationService.sendOrderStatusNotificationOnce —
  // defaults to the real pool, overridable so this claim/send/resolve
  // state machine can be unit-tested against an in-memory fake without
  // touching the production subscription_email_notifications table (this
  // repo has no separate test database).
  queryExecutor = query,
}) => {
  if (!notificationKey || typeof send !== "function") {
    throw new Error("notificationKey and send are required");
  }

  await queryExecutor(
    `INSERT IGNORE INTO subscription_email_notifications
       (notification_key, status)
     VALUES (?, 'pending')`,
    [notificationKey],
  );

  const claimResult = await queryExecutor(
    `UPDATE subscription_email_notifications
     SET status = 'sending', attempts = attempts + 1, last_attempt_at = NOW()
     WHERE notification_key = ?
       AND (
         status = 'pending'
         OR (status = 'failed' AND ? = 1)
         OR (status = 'sending' AND last_attempt_at < NOW() - INTERVAL ? MINUTE)
       )`,
    [notificationKey, retryFailed ? 1 : 0, STALE_CLAIM_MINUTES],
  );

  if (!claimResult.rowCount) {
    return { sent: false, duplicate: true };
  }

  try {
    await send();
    await queryExecutor(
      `UPDATE subscription_email_notifications
       SET status = 'sent', sent_at = NOW(), last_error = NULL
       WHERE notification_key = ? AND status = 'sending'`,
      [notificationKey],
    );
    return { sent: true, duplicate: false };
  } catch (error) {
    await queryExecutor(
      `UPDATE subscription_email_notifications
       SET status = 'failed', last_error = ?
       WHERE notification_key = ? AND status = 'sending'`,
      [String(error?.message || error).slice(0, 1000), notificationKey],
    );
    throw error;
  }
};

// Backward-compatible name — every existing email call site imports this;
// it is the exact same function as sendSubscriptionNotificationOnce.
export const sendSubscriptionEmailOnce = sendSubscriptionNotificationOnce;

export default sendSubscriptionEmailOnce;
