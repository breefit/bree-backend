import test from "node:test";
import assert from "node:assert/strict";
import { runWithCronLock } from "../src/utils/cronLock.js";

/**
 * PHASE 3 — Medium Issue #16: cron/shippingTrackingCron.js's 30-minute
 * tick had no cross-instance coordination. Added runWithCronLock, using
 * MySQL's GET_LOCK()/RELEASE_LOCK() (a server-side advisory lock visible
 * across connections/instances, not just this process) with a 0-second
 * non-blocking wait — a tick that can't acquire the lock immediately skips
 * this run instead of queueing up.
 *
 * Drives the REAL runWithCronLock function against a fake single-connection
 * client modeling MySQL's actual GET_LOCK/RELEASE_LOCK semantics (a lock
 * held by "another instance" is modeled as a separate fake connection that
 * already holds the named lock). No production database.
 */

const makeFakeLockServer = () => {
  const heldLocks = new Set();
  const releaseCalls = [];

  // Models a single MySQL server-side lock namespace shared across every
  // "connection" this factory produces — exactly like GET_LOCK/
  // RELEASE_LOCK are visible server-wide, not per-connection.
  const makeClient = () => ({
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized === "SELECT GET_LOCK(?, 0) AS acquired") {
        const [lockName] = params;
        if (heldLocks.has(lockName)) {
          return { rows: [{ acquired: 0 }] };
        }
        heldLocks.add(lockName);
        return { rows: [{ acquired: 1 }] };
      }

      if (normalized === "SELECT RELEASE_LOCK(?)") {
        const [lockName] = params;
        heldLocks.delete(lockName);
        releaseCalls.push(lockName);
        return { rows: [{ "RELEASE_LOCK(?)": 1 }] };
      }

      throw new Error(`Unhandled fake SQL in cronLock test: ${normalized}`);
    },
    release: () => {},
  });

  return {
    getClientFn: async () => makeClient(),
    heldLocks,
    releaseCalls,
    // Simulates ANOTHER instance already holding the lock when this test
    // needs that starting state.
    preHoldLock: (name) => heldLocks.add(name),
  };
};

test("ISSUE-016: acquires the lock, runs the work, and releases the lock afterward", async () => {
  const server = makeFakeLockServer();
  let ran = false;

  const result = await runWithCronLock(
    "test_lock",
    async () => {
      ran = true;
    },
    { getClientFn: server.getClientFn },
  );

  assert.equal(result.ran, true);
  assert.equal(ran, true);
  assert.equal(server.heldLocks.has("test_lock"), false, "the lock must be released after the work completes");
  assert.deepEqual(server.releaseCalls, ["test_lock"]);
});

test("ISSUE-016: skips the run entirely (never calls the work function) when another instance already holds the lock", async () => {
  const server = makeFakeLockServer();
  server.preHoldLock("test_lock");
  let ran = false;

  const result = await runWithCronLock(
    "test_lock",
    async () => {
      ran = true;
    },
    { getClientFn: server.getClientFn },
  );

  assert.equal(result.ran, false);
  assert.equal(result.reason, "lock_held_elsewhere");
  assert.equal(ran, false, "the work function must never run when the lock could not be acquired");
});

test("ISSUE-016: the lock is still released even if the work function throws", async () => {
  const server = makeFakeLockServer();

  await assert.rejects(
    () =>
      runWithCronLock(
        "test_lock",
        async () => {
          throw new Error("simulated failure mid-run");
        },
        { getClientFn: server.getClientFn },
      ),
    /simulated failure mid-run/,
  );

  assert.equal(server.heldLocks.has("test_lock"), false, "a crashed run must not leave the lock held forever");
});

test("ISSUE-016 regression: a released lock CAN be immediately re-acquired by the next tick", async () => {
  const server = makeFakeLockServer();

  const first = await runWithCronLock("test_lock", async () => {}, { getClientFn: server.getClientFn });
  const second = await runWithCronLock("test_lock", async () => {}, { getClientFn: server.getClientFn });

  assert.equal(first.ran, true);
  assert.equal(second.ran, true, "the next tick must be able to acquire the lock once the previous one released it");
});

test("ISSUE-016 regression: different lock names are independent (one instance's shipping-cron lock never blocks an unrelated lock)", async () => {
  const server = makeFakeLockServer();
  server.preHoldLock("other_cron_lock");

  const result = await runWithCronLock("shipping_cron_lock", async () => {}, { getClientFn: server.getClientFn });

  assert.equal(result.ran, true);
});
