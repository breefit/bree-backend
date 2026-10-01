/**
 * Order-status shipment notification idempotency.
 *
 * Shipped / Out for Delivery / Delivered are detected from two places —
 * the 30-min Delhivery tracking cron and the admin-triggered manual
 * refresh (GET /api/shipping/track/:awb) — and either can observe the same
 * status more than once (re-poll, webhook-style retry, race between the
 * two). This wraps a single WhatsApp/email send so it fires at most once
 * per (order, status, channel), using the same claim-then-send shape as
 * services/subscriptionEmailNotificationService.js.
 */
import { query } from "../config/database.js";

/**
 * Builds the stable dedupe key for one order-status notification.
 * Same (orderId, status, channel) always produces the same key, so every
 * call site that might observe the same transition shares one claim.
 */
export const buildOrderStatusNotificationKey = ({ orderId, status, channel }) =>
  `order:${orderId}:status:${status}:channel:${channel}`;

export const maskNotificationEmail = (email) => {
  if (!email) return null;
  const [local, domain] = String(email).split("@");
  if (!domain) return "[invalid-email]";
  return `${local?.slice(0, 2) || "*"}***@${domain}`;
};

export const maskNotificationPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits ? `***${digits.slice(-4)}` : null;
};

// FIX (stuck-claim bug — idempotency table must never eat a real send):
// the claim UPDATE below only moved 'pending' (or, with retryFailed,
// 'failed') rows to 'sending'. If the process ever died between claiming
// (status='sending') and resolving to 'sent'/'failed' — a PM2 restart
// during deploy, an uncaught exception, a killed worker — that row was
// stuck at 'sending' forever. Every later attempt then found rowCount = 0
// and reported "duplicate_skipped", even though no notification had ever
// actually been sent: the exact "idempotency table incorrectly marking the
// notification as already sent" failure mode. A 'sending' row older than
// this is treated as abandoned and reclaimable, same as a 'failed' one.
const STALE_CLAIM_MINUTES = 5;

// FIX (notification reconciliation — audit finding 4): a 'failed' row used
// to be terminal. For reconcilable (customer return/refund) notifications,
// a failure the provider PROVABLY did not accept (error.retryable — see
// classifyWaplifyError / classifyEmailError) is now scheduled for a retry
// with exponential backoff: 5 min, 10, 20, 40 … capped at 6 h, at most
// NOTIFICATION_MAX_ATTEMPTS sends in total. Permanent failures (other 4xx,
// SMTP 5xx/auth, missing config) and 'unknown' outcomes get no
// next_retry_at, so they are never retried automatically.
export const NOTIFICATION_MAX_ATTEMPTS = 5;
const RETRY_BASE_SECONDS = 300;
const RETRY_MAX_SECONDS = 6 * 60 * 60;

export const scheduleNotificationRetry = ({
  notificationKey,
  retryable,
  queryExecutor = query,
}) =>
  queryExecutor(
    `UPDATE order_status_notifications
     SET next_retry_at = CASE
       WHEN ? = 1 AND status = 'failed' AND attempts < ?
         THEN DATE_ADD(NOW(), INTERVAL LEAST(? * POW(2, GREATEST(attempts - 1, 0)), ?) SECOND)
       ELSE NULL
     END
     WHERE notification_key = ?`,
    [
      retryable ? 1 : 0,
      NOTIFICATION_MAX_ATTEMPTS,
      RETRY_BASE_SECONDS,
      RETRY_MAX_SECONDS,
      notificationKey,
    ],
  );

// Best-effort extraction of a provider message/request id from whatever
// send() resolved with, for the success log line only — never the whole
// provider payload (which could carry more than an id). WhatsApp sends
// (sendTemplateMessage) resolve with the raw Waplify response body, which
// uses one of these field names (same convention as extractRequestId()
// in whatsappNotificationService.js and dailyReminderCron.js's
// result.data.message_id). Email sends resolve with nothing — omitted
// from the log in that case, which is expected, not an error.
const extractProviderMessageId = (sendResult) =>
  sendResult?.message_id ||
  sendResult?.data?.message_id ||
  sendResult?.request_id ||
  sendResult?.data?.request_id ||
  sendResult?.id ||
  sendResult?.data?.id ||
  null;

export const logNotification = ({
  orderId,
  status,
  channel,
  action,
  result,
  error,
  providerMessageId,
}) => {
  const line = {
    orderId: orderId || null,
    status: status || null,
    channel: channel || null,
    action,
    result: result || null,
  };
  if (providerMessageId) line.providerMessageId = providerMessageId;
  if (error) line.error = String(error).slice(0, 500);
  const logFn = action === "failed" ? console.error : console.info;
  logFn("[ORDER_STATUS_NOTIFICATION]", line);
};

/**
 * Sends one notification at most once per notificationKey. Returns
 * `{ sent: false, duplicate: true }` without calling `send` if this key was
 * already claimed (sent, currently being sent by a concurrent caller, or
 * "sending" too recently to be considered abandoned).
 * Failures are recorded (so the row stays retryable) and rethrown — callers
 * must catch this the same way they already catch a bare send() call, so a
 * notification failure never blocks the order/shipment status update.
 *
 * `orderId`/`status`/`channel` are optional and used only for the
 * structured [ORDER_STATUS_NOTIFICATION] log lines — never for the dedupe
 * decision itself, which is entirely keyed off `notificationKey`.
 */
export const sendOrderStatusNotificationOnce = async ({
  notificationKey,
  send,
  retryFailed = false,
  orderId,
  status,
  channel,
  // Customer return/refund events (services/customerOrderNotifications.js)
  // pass true: a provably-unaccepted failure is then scheduled for the
  // notification reconciler instead of being terminal.
  reconcilable = false,
  // false = a 'sending' row left behind by a dead process is NOT re-sent:
  // the provider may already have accepted it (Waplify has no idempotency
  // key). Customer return/refund events pass false; the reconciler marks
  // such rows 'unknown' for manual review instead.
  reclaimStaleSending = true,
  // Same injection pattern as dailyReminderService.createDailyReminder's
  // queryExecutor — defaults to the real pool, overridable so this claim/
  // send/resolve state machine can be exercised against an in-memory fake
  // in tests without touching the production order_status_notifications
  // table (this repo has no separate test database).
  queryExecutor = query,
}) => {
  if (!notificationKey || typeof send !== "function") {
    throw new Error("notificationKey and send are required");
  }

  const logCtx = { orderId, status, channel };
  logNotification({ ...logCtx, action: "attempted" });

  await queryExecutor(
    `INSERT IGNORE INTO order_status_notifications
       (notification_key, status)
     VALUES (?, 'pending')`,
    [notificationKey],
  );

  const claimResult = await queryExecutor(
    `UPDATE order_status_notifications
     SET status = 'sending', attempts = attempts + 1, last_attempt_at = NOW()
     WHERE notification_key = ?
       AND (
         status = 'pending'
         OR (status = 'failed' AND ? = 1)
         OR (status = 'sending' AND last_attempt_at < NOW() - INTERVAL ? MINUTE AND ? = 1)
       )`,
    [notificationKey, retryFailed ? 1 : 0, STALE_CLAIM_MINUTES, reclaimStaleSending ? 1 : 0],
  );

  if (!claimResult.rowCount) {
    logNotification({ ...logCtx, action: "duplicate_skipped", result: "success" });
    return { sent: false, duplicate: true };
  }

  let sendResult;
  try {
    sendResult = await send();
  } catch (error) {
    // FIX (WhatsApp retry idempotency audit): a send whose outcome is
    // unknown (Waplify 5xx / timeout / reset — see classifyWaplifyError)
    // may already have reached the customer. It is recorded as 'unknown',
    // which neither retryFailed nor any other path reclaims — re-sending
    // it could duplicate the message. Only a known failure is 'failed'.
    const outcome = error?.deliveryOutcome === "unknown" ? "unknown" : "failed";
    await queryExecutor(
      `UPDATE order_status_notifications
       SET status = ?, last_error = ?
       WHERE notification_key = ? AND status = 'sending'`,
      [outcome, String(error?.message || error).slice(0, 1000), notificationKey],
    );
    if (reconcilable) {
      await scheduleNotificationRetry({
        notificationKey,
        retryable: outcome === "failed" && error?.retryable === true,
        queryExecutor,
      }).catch((scheduleError) =>
        logNotification({
          ...logCtx,
          action: "retry_schedule_failed",
          result: "failure",
          error: scheduleError?.message || scheduleError,
        }),
      );
    }
    logNotification({
      ...logCtx,
      action: outcome === "unknown" ? "unknown_outcome" : "failed",
      result: "failure",
      error: error?.message || error,
    });
    throw error;
  }

  // FIX (WhatsApp retry idempotency audit): the provider has accepted the
  // message. A DB error recording that used to fall into the catch above
  // and mark the row 'failed' — i.e. retryable — for a message the
  // customer already received. It is logged instead and never re-marked.
  try {
    await queryExecutor(
      `UPDATE order_status_notifications
       SET status = 'sent', sent_at = NOW(), last_error = NULL
       WHERE notification_key = ? AND status = 'sending'`,
      [notificationKey],
    );
  } catch (recordError) {
    logNotification({
      ...logCtx,
      action: "sent_not_recorded",
      result: "success",
      error: recordError?.message || recordError,
    });
    return { sent: true, duplicate: false, recorded: false };
  }
  logNotification({
    ...logCtx,
    action: "sent",
    result: "success",
    providerMessageId: extractProviderMessageId(sendResult),
  });
  return { sent: true, duplicate: false };
};

export default sendOrderStatusNotificationOnce;
