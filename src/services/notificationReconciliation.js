/**
 * Customer notification reconciliation (return / refund / cancel-and-refund
 * events from services/customerOrderEvents.js).
 *
 * FIX (audit findings 3 + 4): a failed notification was terminal, and a
 * process that died after committing a refund/return state change but
 * before claiming its notification lost that notification for good.
 * One pass, run every 5 minutes under a MySQL GET_LOCK
 * (cron/notificationReconciliationCron.js), does four things:
 *
 *   1. RETRY  rows with status 'failed' whose next_retry_at is due. Only
 *      failures the provider provably did not accept ever get a
 *      next_retry_at (orderStatusNotificationService.scheduleNotificationRetry).
 *      The row is re-armed with a conditional UPDATE (failed → pending,
 *      only if still due) — one worker wins — then sent through the normal
 *      claim. Same notification_key, so it is still one logical
 *      notification. A row whose event no longer describes the order
 *      (e.g. "Refund Initiated" after the refund completed) is dropped.
 *   2. RECOVER  events produced by webhooks/crons (Refund Completed, Refund
 *      Failed, Return Received, Return Pickup Scheduled) whose order is in
 *      that state, changed within the lookback window, and has NO
 *      notification row at all (or one stuck at 'pending'). Sent through
 *      the normal claim: INSERT IGNORE + atomic pending → sending, so a
 *      concurrent live send or a second worker can never double-send.
 *   3. STALE 'sending' rows older than 15 minutes (a process died mid-
 *      send) become 'unknown' — the provider may already have accepted
 *      them, and Waplify has no idempotency key, so they are not re-sent.
 *   4. REPORT  'unknown' rows are logged for manual review; never re-sent.
 *
 * Manual resend of an 'unknown' row, after confirming in the WAPLIFY/SMTP
 * logs that it was NOT delivered:
 *   UPDATE order_status_notifications
 *   SET status = 'failed', next_retry_at = NOW()
 *   WHERE notification_key = '<key>' AND status = 'unknown';
 */
import { query } from "../config/database.js";
import {
  getCustomerOrderEventBySlug,
  RECOVERABLE_CUSTOMER_ORDER_EVENTS,
} from "./customerOrderEvents.js";
import {
  deliverCustomerEvent,
  buildCustomerEventPayload,
  CUSTOMER_NOTIFICATION_CHANNELS,
} from "./customerOrderNotifications.js";
import { buildOrderStatusNotificationKey } from "./orderStatusNotificationService.js";

const BATCH_LIMIT = 50;
const RECOVERY_GRACE_MINUTES = 3;
const STALE_SENDING_MINUTES = 15;
const DEFAULT_LOOKBACK_HOURS = 72;

const KEY_PATTERN = /^order:([^:]+):status:([a-z0-9_]+):channel:(email|whatsapp)$/;

export const parseNotificationKey = (key) => {
  const match = KEY_PATTERN.exec(String(key || ""));
  return match ? { orderId: match[1], slug: match[2], channel: match[3] } : null;
};

export const getRecoveryLookbackHours = () => {
  const hours = Number(process.env.NOTIFICATION_RECOVERY_LOOKBACK_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LOOKBACK_HOURS;
};

const log = (level, event, meta = {}) => {
  const line = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...meta });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const recipientFor = (payload, channel) => (channel === "email" ? payload.email : payload.phone);

const loadOrder = async (queryFn, orderId) => {
  const { rows } = await queryFn("SELECT * FROM orders WHERE id = ? LIMIT 1", [orderId]);
  return rows[0] || null;
};

const dropRetry = (queryFn, key, reason) =>
  queryFn(
    `UPDATE order_status_notifications
     SET next_retry_at = NULL, last_error = ?
     WHERE notification_key = ? AND status = 'failed'`,
    [String(reason).slice(0, 1000), key],
  );

const retryDueNotifications = async ({ queryFn, deliver, limit, summary }) => {
  const { rows } = await queryFn(
    `SELECT notification_key FROM order_status_notifications
     WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()
     ORDER BY next_retry_at ASC
     LIMIT ${Number(limit) || BATCH_LIMIT}`,
  );

  for (const { notification_key: key } of rows) {
    try {
      const parsed = parseNotificationKey(key);
      const event = parsed && getCustomerOrderEventBySlug(parsed.slug);
      if (!event) {
        await dropRetry(queryFn, key, "not a reconcilable customer event — not retried");
        continue;
      }
      const order = await loadOrder(queryFn, parsed.orderId);
      if (!order || !event.isCurrent(order)) {
        await dropRetry(queryFn, key, "superseded: order is no longer in this state — not resent");
        summary.superseded++;
        continue;
      }
      if (!recipientFor(buildCustomerEventPayload(order, event), parsed.channel)) {
        await dropRetry(queryFn, key, "no recipient on the order — not resent");
        continue;
      }

      // Re-arm only if this row is still a due retry — exactly one worker
      // (process / overlapping tick) gets rowCount 1 and sends.
      const rearm = await queryFn(
        `UPDATE order_status_notifications
         SET status = 'pending', next_retry_at = NULL
         WHERE notification_key = ? AND status = 'failed'
           AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()`,
        [key],
      );
      if (!Number(rearm?.rowCount || 0)) continue;

      const result = await deliver(order, event, parsed.channel, { queryExecutor: queryFn });
      if (result?.sent) summary.retried++;
    } catch (error) {
      summary.errors++;
      log("error", "notification_reconciliation.retry_failed", { key, error: error?.message });
    }
  }
};

const recoverMissingNotifications = async ({ queryFn, deliver, limit, lookbackHours, summary }) => {
  for (const event of RECOVERABLE_CUSTOMER_ORDER_EVENTS) {
    const { where, timestampColumn: ts } = event.recovery;
    try {
      const { rows: orders } = await queryFn(
        `SELECT * FROM orders
         WHERE ${where}
           AND ${ts} IS NOT NULL
           AND ${ts} >= NOW() - INTERVAL ? HOUR
           AND ${ts} <= NOW() - INTERVAL ? MINUTE
         ORDER BY ${ts} ASC
         LIMIT ${Number(limit) || BATCH_LIMIT}`,
        [lookbackHours, RECOVERY_GRACE_MINUTES],
      );

      const wanted = [];
      for (const order of orders) {
        if (!event.isCurrent(order)) continue;
        const payload = buildCustomerEventPayload(order, event);
        for (const channel of CUSTOMER_NOTIFICATION_CHANNELS) {
          if (!recipientFor(payload, channel)) continue;
          wanted.push({
            order,
            channel,
            key: buildOrderStatusNotificationKey({ orderId: order.id, status: event.slug, channel }),
          });
        }
      }
      if (!wanted.length) continue;

      const { rows: existing } = await queryFn(
        `SELECT notification_key, status FROM order_status_notifications
         WHERE notification_key IN (${wanted.map(() => "?").join(", ")})`,
        wanted.map((w) => w.key),
      );
      const statusByKey = new Map(existing.map((r) => [r.notification_key, r.status]));

      for (const w of wanted) {
        const status = statusByKey.get(w.key);
        // A row in any state other than 'pending' is owned by the retry /
        // unknown policy above — never recovered here.
        if (status !== undefined && status !== "pending") continue;
        const result = await deliver(w.order, event, w.channel, { queryExecutor: queryFn });
        if (result?.sent) {
          summary.recovered++;
          log("warn", "notification_reconciliation.recovered_missing", {
            orderId: w.order.id,
            event: event.slug,
            channel: w.channel,
          });
        }
      }
    } catch (error) {
      summary.errors++;
      log("error", "notification_reconciliation.recover_failed", {
        event: event.slug,
        error: error?.message,
      });
    }
  }
};

const markStaleSendingUnknown = async ({ queryFn, limit, summary }) => {
  const { rows } = await queryFn(
    `SELECT notification_key FROM order_status_notifications
     WHERE status = 'sending' AND last_attempt_at < NOW() - INTERVAL ? MINUTE
     LIMIT ${Number(limit) || BATCH_LIMIT}`,
    [STALE_SENDING_MINUTES],
  );
  for (const { notification_key: key } of rows) {
    const parsed = parseNotificationKey(key);
    if (!parsed || !getCustomerOrderEventBySlug(parsed.slug)) continue;
    const result = await queryFn(
      `UPDATE order_status_notifications
       SET status = 'unknown', next_retry_at = NULL,
           last_error = 'send interrupted (stale sending claim) — outcome unknown, not resent'
       WHERE notification_key = ? AND status = 'sending'
         AND last_attempt_at < NOW() - INTERVAL ? MINUTE`,
      [key, STALE_SENDING_MINUTES],
    );
    if (Number(result?.rowCount || 0)) summary.staleMarkedUnknown++;
  }
};

/** One reconciliation pass. Never throws. */
export const reconcileCustomerNotifications = async ({
  queryFn = query,
  deliver = deliverCustomerEvent,
  limit = BATCH_LIMIT,
  lookbackHours = getRecoveryLookbackHours(),
} = {}) => {
  const summary = { retried: 0, superseded: 0, recovered: 0, staleMarkedUnknown: 0, unknown: 0, errors: 0 };
  const ctx = { queryFn, deliver, limit, lookbackHours, summary };

  for (const step of [retryDueNotifications, recoverMissingNotifications, markStaleSendingUnknown]) {
    try {
      await step(ctx);
    } catch (error) {
      summary.errors++;
      log("error", "notification_reconciliation.step_failed", { step: step.name, error: error?.message });
    }
  }

  try {
    const { rows } = await queryFn(
      "SELECT COUNT(*) AS n FROM order_status_notifications WHERE status = 'unknown'",
    );
    summary.unknown = Number(rows?.[0]?.n || 0);
    if (summary.unknown > 0) {
      log("warn", "notification_reconciliation.unknown_outcomes_need_review", {
        count: summary.unknown,
      });
    }
  } catch (error) {
    summary.errors++;
  }

  log("info", "notification_reconciliation.run_complete", summary);
  return summary;
};

export default reconcileCustomerNotifications;
