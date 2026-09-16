import { getClient } from "../config/database.js";

// FIX (Medium #16 — Phase 3): cron/shippingTrackingCron.js's 30-minute tick
// had no cross-instance coordination — fine for a single-instance
// deployment (the existing optimistic-concurrency order-status UPDATE and
// the notification claim table already prevent duplicate side effects even
// if two ticks somehow raced), but a real gap if this app is ever scaled
// horizontally: every instance would independently poll every due order.
//
// Uses MySQL's GET_LOCK()/RELEASE_LOCK() — a server-side advisory lock
// visible across every connection to the same database, not just this
// process — with a 0-second (non-blocking) wait: a tick that can't acquire
// the lock immediately skips this run entirely rather than queuing up
// behind another instance's in-flight run, which is the right behavior for
// a fixed-interval cron (the next tick will simply try again).
//
// GET_LOCK/RELEASE_LOCK are connection-scoped, so both calls (and the work
// in between) MUST happen on the exact same connection — this is why
// getClient() (a single held connection) is used here rather than the
// pooled query() wrapper, which hands out a different connection per call.
export const runWithCronLock = async (
  lockName,
  fn,
  { getClientFn = getClient } = {},
) => {
  const client = await getClientFn();
  let lockAcquired = false;
  try {
    const { rows } = await client.query("SELECT GET_LOCK(?, 0) AS acquired", [
      lockName,
    ]);
    lockAcquired = Number(rows?.[0]?.acquired) === 1;

    if (!lockAcquired) {
      return { ran: false, reason: "lock_held_elsewhere" };
    }

    await fn();
    return { ran: true };
  } finally {
    if (lockAcquired) {
      await client
        .query("SELECT RELEASE_LOCK(?)", [lockName])
        .catch((err) =>
          console.error(`[CRON_LOCK] Failed to release lock "${lockName}"`, {
            message: err?.message || String(err),
          }),
        );
    }
    client.release();
  }
};
