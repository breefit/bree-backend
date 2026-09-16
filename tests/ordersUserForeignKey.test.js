import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * ISSUE-017 — orders.user_id was ON DELETE CASCADE, a financial-data
 * safety risk: deleting a user row would silently cascade-delete every one
 * of their orders. No code path currently deletes users, so this was
 * latent — fixed pre-emptively to SET NULL (matching the existing
 * fk_orders_address pattern on the same table) before any future
 * "delete my account"/GDPR-erasure feature could ever exercise it.
 *
 * This environment has no real MySQL server available to run the
 * migration against (no dedicated test database — see ISSUE-007's own
 * safety guard, which deliberately keeps DATABASE_URL/production
 * unreachable in test mode) and this repo's local machine's MySQL install
 * is unrelated to BREE production and not accessible to this session
 * either. These are therefore structural/static checks on the actual SQL
 * files — NOT a substitute for actually running the migration against a
 * real (non-production) MySQL instance before it's applied to production;
 * see the Phase 2 report's "Manual verification required" note for this
 * issue.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");

const schemaSql = read("../mysql-schema.sql");
const migrationSql = read("../migrations/009_orders_user_fk_set_null.sql");
const migrateScript = read("../migrations/mysql-migrate.js");

test("ISSUE-017: mysql-schema.sql's orders table now declares fk_orders_user as ON DELETE SET NULL, not CASCADE", () => {
  const ordersTableStart = schemaSql.indexOf("CREATE TABLE IF NOT EXISTS orders");
  const ordersTableEnd = schemaSql.indexOf(
    "ENGINE=InnoDB",
    ordersTableStart,
  );
  const ordersTableSql = schemaSql.slice(ordersTableStart, ordersTableEnd);

  assert.match(
    ordersTableSql,
    /fk_orders_user\s+FOREIGN KEY \(user_id\)\s+REFERENCES users\(id\)\s+ON DELETE SET NULL/,
  );
  assert.doesNotMatch(
    ordersTableSql,
    /fk_orders_user\s+FOREIGN KEY \(user_id\)\s+REFERENCES users\(id\)\s+ON DELETE CASCADE/,
  );
  // The sibling FK on the same table this change is modeled on must still
  // be exactly what it was.
  assert.match(
    ordersTableSql,
    /fk_orders_address\s+FOREIGN KEY \(address_id\)\s+REFERENCES addresses\(id\)\s+ON DELETE SET NULL/,
  );
});

test("ISSUE-017: the migration for an already-provisioned database conditionally drops the old FK and re-adds it as SET NULL", () => {
  // Uses dynamic SQL (PREPARE/EXECUTE) to make dropping the old constraint
  // conditional — MySQL has no `DROP FOREIGN KEY IF EXISTS` — guarded by
  // an information_schema lookup so the migration is safe to run more
  // than once (idempotent) against a database that has already been
  // migrated.
  assert.match(migrationSql, /information_schema\.TABLE_CONSTRAINTS/i);
  assert.match(migrationSql, /CONSTRAINT_NAME = 'fk_orders_user'/);
  assert.match(migrationSql, /PREPARE stmt FROM @drop_old_fk/);
  assert.match(migrationSql, /EXECUTE stmt/);
  assert.match(migrationSql, /DEALLOCATE PREPARE stmt/);
  assert.match(
    migrationSql,
    /ADD CONSTRAINT fk_orders_user FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE SET NULL/,
  );
});

test("ISSUE-017: the migration is wired into the existing manual migration runner (npm run migrate), not the automatic runtime ensure*Schema() chain", () => {
  assert.match(migrateScript, /009_orders_user_fk_set_null\.sql/);
  assert.match(migrateScript, /ordersUserFkMigration/);

  // Must NOT have been added to the automatic-on-every-boot chain in
  // config/database.js — a FK constraint rewrite deserves a deliberate,
  // explicit `npm run migrate` step, unlike the purely additive
  // (ADD COLUMN/CREATE TABLE IF NOT EXISTS) functions that chain runs
  // unattended on every server start.
  const databaseConfigSource = read("../src/config/database.js");
  assert.doesNotMatch(databaseConfigSource, /009_orders_user_fk_set_null/);
  assert.doesNotMatch(databaseConfigSource, /ensureOrdersUserForeignKey/);
});
