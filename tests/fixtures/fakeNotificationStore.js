/**
 * In-memory model of order_status_notifications (+ the orders rows the
 * notification code reads), interpreting the exact SQL statements issued by
 * services/orderStatusNotificationService.js and
 * services/notificationReconciliation.js. Each statement is applied
 * atomically, like a single MySQL statement, so concurrent callers
 * (Promise.all) interleave only between statements — the same guarantee
 * the real claim relies on. `store.now` is the database clock (NOW()).
 *
 * There is no test MySQL in this repo; this never touches a real database.
 */
import { RECOVERABLE_CUSTOMER_ORDER_EVENTS } from "../../src/services/customerOrderEvents.js";

const norm = (sql) => sql.replace(/\s+/g, " ").trim();
const MINUTE = 60 * 1000;

export const createFakeNotificationStore = ({ orders = [], now = new Date("2026-10-01T10:00:00Z") } = {}) => {
  const store = {
    now: new Date(now),
    orders: new Map(orders.map((o) => [o.id, { ...o }])),
    notifications: new Map(),
    statements: [],
  };

  const row = (key) => store.notifications.get(key);
  const nowMs = () => store.now.getTime();

  store.advance = (ms) => {
    store.now = new Date(nowMs() + ms);
  };

  store.queryFn = async (sql, params = []) => {
    const q = norm(sql);
    store.statements.push(q);
    // Yield, so concurrent callers really interleave between statements.
    await Promise.resolve();

    if (q.startsWith("INSERT IGNORE INTO order_status_notifications")) {
      const [key] = params;
      if (!row(key)) {
        store.notifications.set(key, {
          notification_key: key,
          status: "pending",
          attempts: 0,
          last_attempt_at: null,
          sent_at: null,
          last_error: null,
          next_retry_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (q.startsWith("UPDATE order_status_notifications SET status = 'sending'")) {
      const [key, retryFlag, staleMinutes, reclaimFlag] = params;
      const r = row(key);
      if (!r) return { rows: [], rowCount: 0 };
      const stale =
        r.status === "sending" &&
        reclaimFlag === 1 &&
        r.last_attempt_at &&
        nowMs() - r.last_attempt_at.getTime() > staleMinutes * MINUTE;
      if (!(r.status === "pending" || (r.status === "failed" && retryFlag === 1) || stale)) {
        return { rows: [], rowCount: 0 };
      }
      r.status = "sending";
      r.attempts += 1;
      r.last_attempt_at = new Date(store.now);
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("UPDATE order_status_notifications SET status = 'sent'")) {
      const r = row(params[0]);
      if (!r || r.status !== "sending") return { rows: [], rowCount: 0 };
      r.status = "sent";
      r.sent_at = new Date(store.now);
      r.last_error = null;
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("UPDATE order_status_notifications SET status = ?, last_error = ?")) {
      const [outcome, error, key] = params;
      const r = row(key);
      if (!r || r.status !== "sending") return { rows: [], rowCount: 0 };
      r.status = outcome;
      r.last_error = error;
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("UPDATE order_status_notifications SET next_retry_at = CASE")) {
      const [retryable, maxAttempts, baseSeconds, maxSeconds, key] = params;
      const r = row(key);
      if (!r) return { rows: [], rowCount: 0 };
      if (retryable === 1 && r.status === "failed" && r.attempts < maxAttempts) {
        const seconds = Math.min(baseSeconds * 2 ** Math.max(r.attempts - 1, 0), maxSeconds);
        r.next_retry_at = new Date(nowMs() + seconds * 1000);
      } else {
        r.next_retry_at = null;
      }
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("SELECT notification_key FROM order_status_notifications WHERE status = 'failed' AND next_retry_at IS NOT NULL")) {
      const due = [...store.notifications.values()]
        .filter((r) => r.status === "failed" && r.next_retry_at && r.next_retry_at.getTime() <= nowMs())
        .sort((a, b) => a.next_retry_at - b.next_retry_at)
        .map((r) => ({ notification_key: r.notification_key }));
      return { rows: due, rowCount: due.length };
    }

    if (q.startsWith("UPDATE order_status_notifications SET next_retry_at = NULL, last_error = ?")) {
      const [error, key] = params;
      const r = row(key);
      if (!r || r.status !== "failed") return { rows: [], rowCount: 0 };
      r.next_retry_at = null;
      r.last_error = error;
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("UPDATE order_status_notifications SET status = 'pending', next_retry_at = NULL")) {
      const r = row(params[0]);
      if (!r || r.status !== "failed" || !r.next_retry_at || r.next_retry_at.getTime() > nowMs()) {
        return { rows: [], rowCount: 0 };
      }
      r.status = "pending";
      r.next_retry_at = null;
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("SELECT notification_key, status FROM order_status_notifications WHERE notification_key IN")) {
      const rows = params.filter((k) => row(k)).map((k) => ({ notification_key: k, status: row(k).status }));
      return { rows, rowCount: rows.length };
    }

    if (q.startsWith("SELECT notification_key FROM order_status_notifications WHERE status = 'sending'")) {
      const [minutes] = params;
      const rows = [...store.notifications.values()]
        .filter((r) => r.status === "sending" && nowMs() - r.last_attempt_at.getTime() > minutes * MINUTE)
        .map((r) => ({ notification_key: r.notification_key }));
      return { rows, rowCount: rows.length };
    }

    if (q.startsWith("UPDATE order_status_notifications SET status = 'unknown'")) {
      const [key, minutes] = params;
      const r = row(key);
      if (!r || r.status !== "sending" || nowMs() - r.last_attempt_at.getTime() <= minutes * MINUTE) {
        return { rows: [], rowCount: 0 };
      }
      r.status = "unknown";
      r.next_retry_at = null;
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("SELECT COUNT(*) AS n FROM order_status_notifications WHERE status = 'unknown'")) {
      const n = [...store.notifications.values()].filter((r) => r.status === "unknown").length;
      return { rows: [{ n }], rowCount: 1 };
    }

    if (q === "SELECT * FROM orders WHERE id = ? LIMIT 1") {
      const o = store.orders.get(params[0]);
      return { rows: o ? [{ ...o }] : [], rowCount: o ? 1 : 0 };
    }

    // Reconciler recovery scan: one per recoverable event, identified by
    // its WHERE clause; window = [now - lookback h, now - grace min].
    if (q.startsWith("SELECT * FROM orders WHERE")) {
      const event = RECOVERABLE_CUSTOMER_ORDER_EVENTS.find((e) => q.includes(norm(e.recovery.where)));
      if (!event) throw new Error(`fake store: unrecognised recovery scan: ${q}`);
      const [lookbackHours, graceMinutes] = params;
      const ts = event.recovery.timestampColumn;
      const rows = [...store.orders.values()].filter((o) => {
        if (!event.isCurrent(o) || !o[ts]) return false;
        const t = new Date(o[ts]).getTime();
        return t >= nowMs() - lookbackHours * 60 * MINUTE && t <= nowMs() - graceMinutes * MINUTE;
      });
      return { rows: rows.map((o) => ({ ...o })), rowCount: rows.length };
    }

    throw new Error(`fake store: unhandled SQL: ${q}`);
  };

  store.status = (key) => row(key)?.status;
  return store;
};

export const notificationKey = (orderId, slug, channel) =>
  `order:${orderId}:status:${slug}:channel:${channel}`;
