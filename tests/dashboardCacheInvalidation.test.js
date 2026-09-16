import test from "node:test";
import assert from "node:assert/strict";
import cache from "../src/utils/cache.js";
import { invalidateDashboardCache } from "../src/controllers/admin/dashboardController.js";

/**
 * PHASE 3 — Medium Issue #20: the admin dashboard stats cache (previously
 * a 120s TTL) was never invalidated on any order mutation — an admin could
 * make a change (update an order's status) and still see stale totals/
 * pending-orders/revenue on the dashboard for up to the full TTL. Added
 * invalidateDashboardCache(), called from admin/orderController.js's
 * updateOrderStatus (after COMMIT, src/controllers/admin/orderController.js
 * around the "FIX (Medium #20" comment) and bulkUpdateStatus (same
 * comment, right before its success response) — both call sites verified
 * directly in the source since those two functions are large,
 * non-dependency-injected transactions where retrofitting full HTTP-level
 * test injection would be a much bigger change than this fix warrants.
 * Also shortened the TTL itself from 120s to 20s as a smaller blast radius
 * for any mutation path this doesn't (yet) explicitly invalidate.
 *
 * This test drives the REAL cache module and the REAL
 * invalidateDashboardCache export directly — proving the actual
 * invalidation mechanism works, not a regex over the source.
 */

test("ISSUE-020: invalidateDashboardCache clears a previously cached admin:dashboard entry", () => {
  cache.set("admin:dashboard", { total_orders: 42 }, 120);
  assert.deepEqual(cache.get("admin:dashboard"), { total_orders: 42 });

  invalidateDashboardCache();

  assert.equal(cache.get("admin:dashboard"), null, "the cached dashboard payload must be gone after invalidation");
});

test("ISSUE-020 regression: invalidating a not-yet-cached dashboard entry is a safe no-op", () => {
  cache.del("admin:dashboard"); // ensure clean slate
  assert.doesNotThrow(() => invalidateDashboardCache());
  assert.equal(cache.get("admin:dashboard"), null);
});

test("ISSUE-020 regression: invalidating the dashboard cache never touches an unrelated cache key", () => {
  cache.set("admin:dashboard", { total_orders: 1 }, 120);
  cache.set("products:featured", { items: ["a", "b"] }, 120);

  invalidateDashboardCache();

  assert.equal(cache.get("admin:dashboard"), null);
  assert.deepEqual(cache.get("products:featured"), { items: ["a", "b"] }, "an unrelated cache key must be untouched");
});
