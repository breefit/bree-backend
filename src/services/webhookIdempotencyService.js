import { randomUUID } from "crypto";
import { query } from "../config/database.js";

// FIX (Phase 3B — Medium #5): Razorpay webhook idempotency ledger.
//
// EVENT ID SOURCE: Razorpay's webhook payload does NOT include a dedicated
// unique event/delivery identifier — confirmed by reading the current
// payload-parsing code (handleWebhook only ever destructures `event` and
// `payload` from the body) and by Razorpay's own webhook payload
// documentation, which shows `{ entity: "event", account_id, event,
// contains, payload: { <resource>: { entity: {...} } }, created_at }` with
// no top-level `id` field (unlike, e.g., Stripe's `id: "evt_..."`). No
// event ID field is invented here.
//
// Instead, the idempotency key is a SHA-256 hash of the exact raw webhook
// body (computed by the caller and passed in as `eventId`). This is safe
// because:
//   - A genuine REDELIVERY (retry) of the same event carries byte-identical
//     JSON — including the payload's own `created_at` — and hashes to the
//     same key, so it is correctly recognized as a duplicate.
//   - A genuinely NEW event, even one sharing the same event TYPE and the
//     same entity id as a past event (e.g. a subscription that is paused,
//     resumed, and paused again — the same subscription_id, the same
//     "subscription.paused" event type, but a real, distinct occurrence
//     each time), has at least a different `created_at` in the payload,
//     producing a different hash — so it is correctly NOT deduped. A naive
//     key of just `event + entity_id` would incorrectly treat the second
//     "paused" event as a duplicate of the first and silently drop it.
//
// SCHEMA: see ensureWebhookEventsTable in config/database.js.

const isDuplicateKeyError = (err) =>
  err?.code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(err?.message || "");

/**
 * Atomically claims an event id for processing.
 *
 * - First delivery: INSERTs a new 'processing' row — claim succeeds.
 * - Concurrent/duplicate delivery while the first is still in flight: the
 *   INSERT hits the UNIQUE(provider, event_id) constraint; the existing
 *   row is still 'processing' — claim fails, NOT completed (caller must
 *   not re-run business logic, but also must not report success as if the
 *   work is done — it's the FIRST request's job to do that).
 * - Delivery after a previous attempt already succeeded: existing row is
 *   'completed' — claim fails, alreadyCompleted: true (safe to
 *   acknowledge without reprocessing).
 * - Delivery after a previous attempt FAILED (a real error, not just a
 *   duplicate): existing row is 'failed' — this is a legitimate retry
 *   opportunity. Atomically re-claims by flipping 'failed' -> 'processing'
 *   (guarded by a WHERE status = 'failed', so only one of several
 *   concurrent retries wins).
 *
 * @returns {{ claimed: boolean, alreadyCompleted: boolean }}
 */
export const claimWebhookEvent = async ({
  eventId,
  eventType,
  provider = "razorpay",
  queryFn = query,
}) => {
  try {
    // FIX (live verification — webhook duplicate logging): ER_DUP_ENTRY on
    // this exact INSERT is the expected, correct result of the atomic
    // idempotency claim (see this function's own doc comment) — not a
    // database problem. `isExpectedError` tells the shared query logger
    // (config/database.js) to log this specific, already-classified case
    // quietly instead of as an unhandled-looking "❌ Database Query Error".
    // Any OTHER error from this same INSERT (bad connection, unknown
    // column, etc.) still isn't a duplicate-key error, so it still logs at
    // full severity and still propagates below exactly as before.
    await queryFn(
      `INSERT INTO webhook_events (id, provider, event_id, event_type, status)
       VALUES (?, ?, ?, ?, 'processing')`,
      [randomUUID(), provider, eventId, eventType],
      { isExpectedError: isDuplicateKeyError },
    );
    return { claimed: true, alreadyCompleted: false };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;

    const { rows } = await queryFn(
      `SELECT status FROM webhook_events WHERE provider = ? AND event_id = ? LIMIT 1`,
      [provider, eventId],
    );
    const existing = rows[0];

    if (!existing) {
      // Extremely unlikely (row removed between the failed INSERT and this
      // SELECT) — fail safe by not claiming rather than risking a double
      // process.
      return { claimed: false, alreadyCompleted: false };
    }

    if (existing.status === "completed") {
      return { claimed: false, alreadyCompleted: true };
    }

    if (existing.status === "failed") {
      const retryClaim = await queryFn(
        `UPDATE webhook_events
         SET status = 'processing', error_message = NULL
         WHERE provider = ? AND event_id = ? AND status = 'failed'`,
        [provider, eventId],
      );
      return { claimed: Boolean(retryClaim.rowCount), alreadyCompleted: false };
    }

    // status === 'processing': another request (or another instance) is
    // handling this exact event right now.
    return { claimed: false, alreadyCompleted: false };
  }
};

export const markWebhookEventCompleted = async ({
  eventId,
  provider = "razorpay",
  queryFn = query,
}) => {
  await queryFn(
    `UPDATE webhook_events SET status = 'completed', processed_at = NOW() WHERE provider = ? AND event_id = ?`,
    [provider, eventId],
  );
};

export const markWebhookEventFailed = async ({
  eventId,
  provider = "razorpay",
  queryFn = query,
  errorMessage,
}) => {
  await queryFn(
    `UPDATE webhook_events SET status = 'failed', error_message = ? WHERE provider = ? AND event_id = ?`,
    [errorMessage ? String(errorMessage).slice(0, 1000) : null, provider, eventId],
  );
};
