import test from "node:test";
import assert from "node:assert/strict";
import { reconcileMissingPackagePurchases } from "../src/services/packageFulfillmentService.js";

/**
 * PHASE 3 — Medium Issue #14: createPackagePurchaseFromOrder is called
 * fire-and-forget from both trigger paths (verify + webhook) — if both
 * failed for the same order, no package_purchases row was ever created,
 * and nothing ever re-scanned for that. Added reconcileMissingPackagePurchases,
 * wired into cron/packageFulfillmentCron.js's existing daily tick.
 *
 * Drives the REAL function (not a regex over the source) against a fake
 * queryFn (modeling the paid-order/missing-row SELECT) and a fake createFn
 * (standing in for createPackagePurchaseFromOrder, which is already
 * separately idempotent and doesn't need re-testing here). No production
 * database.
 */

const makeFakeDb = (orderIds) => {
  const queryFn = async (sql) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT DISTINCT o.id")) {
      return { rows: orderIds.map((id) => ({ id })) };
    }
    throw new Error(`Unhandled fake SQL in packageFulfillmentReconciliation test: ${normalized}`);
  };
  return { queryFn };
};

test("ISSUE-014: creates a package_purchases row for every paid order missing one", async () => {
  const db = makeFakeDb(["order-missing-1", "order-missing-2"]);
  const created = [];
  const createFn = async (orderId) => {
    created.push(orderId);
    return { packageId: `pkg-${orderId}`, packageNumber: "PKG-1", totalCycles: 6 };
  };

  const result = await reconcileMissingPackagePurchases({ queryFn: db.queryFn, createFn });

  assert.equal(result.checked, 2);
  assert.equal(result.created, 2);
  assert.deepEqual(created.sort(), ["order-missing-1", "order-missing-2"]);
});

test("ISSUE-014: no missing orders is a clean no-op (createFn never called)", async () => {
  const db = makeFakeDb([]);
  let callCount = 0;
  const createFn = async () => {
    callCount += 1;
  };

  const result = await reconcileMissingPackagePurchases({ queryFn: db.queryFn, createFn });

  assert.equal(result.checked, 0);
  assert.equal(result.created, 0);
  assert.equal(callCount, 0);
});

test("ISSUE-014: createPackagePurchaseFromOrder returning null (e.g. no matching package item after all) is NOT counted as created", async () => {
  const db = makeFakeDb(["order-1"]);
  const createFn = async () => null;

  const result = await reconcileMissingPackagePurchases({ queryFn: db.queryFn, createFn });

  assert.equal(result.checked, 1);
  assert.equal(result.created, 0);
});

test("ISSUE-014: one order's creation failure never blocks reconciling the others in the same pass", async () => {
  const db = makeFakeDb(["order-fails", "order-succeeds"]);
  const createFn = async (orderId) => {
    if (orderId === "order-fails") throw new Error("simulated transient DB error");
    return { packageId: "pkg-order-succeeds" };
  };

  const result = await reconcileMissingPackagePurchases({ queryFn: db.queryFn, createFn });

  assert.equal(result.checked, 2);
  assert.equal(result.created, 1, "the failing order must not prevent the succeeding one from being reconciled");
});
