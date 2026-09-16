-- ISSUE-017 — orders.user_id was ON DELETE CASCADE, a financial-data
-- safety risk: deleting a user row would silently cascade-delete every one
-- of their orders (and, transitively, order_items/payments/
-- order_status_history via their own CASCADE FKs to orders). No current
-- code path deletes users (confirmed by a repo-wide search for
-- "DELETE FROM users"), so this has never fired in production — but a
-- future "delete my account"/GDPR-erasure feature must not be able to
-- erase financial/audit history as a side effect of removing an account.
--
-- orders.user_id is already nullable (guest-checkout orders are created
-- with user_id = NULL), so SET NULL is schema-compatible — this exactly
-- matches the existing fk_orders_address (-> addresses) FK on the same
-- table, which already uses ON DELETE SET NULL.
--
-- This is a manual, opt-in migration (run via `npm run migrate`, same as
-- 007/008) — NOT part of the runtime ensure*Schema() auto-migration chain
-- in src/config/database.js, deliberately: those are additive
-- (ADD COLUMN/CREATE TABLE IF NOT EXISTS) and safe to run unattended on
-- every server boot; dropping and re-adding a FOREIGN KEY constraint on an
-- existing production table is a structural change that deserves a
-- deliberate, explicit migration step instead.
--
-- Safe to run more than once: DROP FOREIGN KEY is only attempted if the
-- old constraint still exists.

SET @constraint_exists := (
  SELECT COUNT(*)
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND CONSTRAINT_NAME = 'fk_orders_user'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);

SET @drop_old_fk := IF(
  @constraint_exists > 0,
  'ALTER TABLE orders DROP FOREIGN KEY fk_orders_user',
  'SELECT 1'
);

PREPARE stmt FROM @drop_old_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
