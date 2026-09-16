import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureOrderShipmentTrackingIndex,
  ensureUsersPhoneIndex,
} from "../src/config/database.js";

/**
 * PHASE 3 — Medium Issues #25/#26: cron/shippingTrackingCron.js's 30-minute
 * tick and the manual track endpoint filter directly on orders.awb_number/
 * tracking_status; auth/payment code does direct WHERE phone = ? lookups
 * against users — neither column had a covering index, so every one of
 * those was a full table scan. Added two idempotent, information_schema
 * -gated startup migrations (matching the exact pattern
 * ensureBulkBookingUserIdIndexAndBackfill already uses in this file).
 *
 * Drives the REAL functions against a fake information_schema-aware query
 * function (no production database — these never run against a real DB in
 * this test).
 */

const makeFakeSchemaDb = ({ existingIndexes = [] } = {}) => {
  const createdIndexes = [];
  const indexes = new Set(existingIndexes);

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "SELECT DATABASE() AS db") {
      return [[{ db: "bree_test" }]];
    }

    if (normalized.startsWith("SELECT 1 FROM information_schema.statistics")) {
      const indexNameMatch = sql.match(/index_name = 'idx_[a-z_]+'/);
      const indexName = indexNameMatch[0].split("'")[1];
      return [indexes.has(indexName) ? [{ 1: 1 }] : []];
    }

    if (normalized.startsWith("CREATE INDEX")) {
      const indexName = normalized.split(" ")[2];
      createdIndexes.push(normalized);
      indexes.add(indexName);
      return [{}];
    }

    throw new Error(`Unhandled fake SQL in missingIndexesMigration test: ${normalized}`);
  };

  return { queryFn, createdIndexes, indexes };
};

test("ISSUE-025: creates idx_orders_awb_tracking_status when it doesn't exist yet", async () => {
  const db = makeFakeSchemaDb();

  await ensureOrderShipmentTrackingIndex({ queryFn: db.queryFn });

  assert.equal(db.createdIndexes.length, 1);
  assert.match(db.createdIndexes[0], /idx_orders_awb_tracking_status ON orders\(awb_number, tracking_status\)/);
});

test("ISSUE-025 regression: is a no-op (idempotent) when the index already exists", async () => {
  const db = makeFakeSchemaDb({ existingIndexes: ["idx_orders_awb_tracking_status"] });

  await ensureOrderShipmentTrackingIndex({ queryFn: db.queryFn });

  assert.equal(db.createdIndexes.length, 0, "must not attempt to re-create an existing index");
});

test("ISSUE-026: creates idx_users_phone when it doesn't exist yet", async () => {
  const db = makeFakeSchemaDb();

  await ensureUsersPhoneIndex({ queryFn: db.queryFn });

  assert.equal(db.createdIndexes.length, 1);
  assert.match(db.createdIndexes[0], /idx_users_phone ON users\(phone\)/);
});

test("ISSUE-026 regression: is a no-op (idempotent) when the index already exists", async () => {
  const db = makeFakeSchemaDb({ existingIndexes: ["idx_users_phone"] });

  await ensureUsersPhoneIndex({ queryFn: db.queryFn });

  assert.equal(db.createdIndexes.length, 0);
});

test("ISSUE-025/026: a failure (e.g. missing privileges) is caught and logged, never thrown — startup must not crash on this", async () => {
  const throwingQueryFn = async () => {
    throw new Error("simulated ALTER privilege denied");
  };

  await assert.doesNotReject(() => ensureOrderShipmentTrackingIndex({ queryFn: throwingQueryFn }));
  await assert.doesNotReject(() => ensureUsersPhoneIndex({ queryFn: throwingQueryFn }));
});
