-- =============================================================================
-- Migration: Customer notification retry schedule
-- Version: 011
-- Created: 2026-10-01
-- Description:
--   Adds order_status_notifications.next_retry_at and an index on
--   (status, next_retry_at), used by services/notificationReconciliation.js
--   to retry customer return/refund notifications that the provider
--   provably did NOT accept (Waplify 429 / connection never made, SMTP 4xx).
--
--   Additive only. Every existing row gets NULL, which means "never retried
--   automatically" — no historical notification is re-sent by this change,
--   and no existing notification key or status is modified.
--
--   The same column and index are also added on boot by
--   ensureOrderStatusNotificationRetryColumn() in src/config/database.js.
--   This file is for `npm run migrate`.
--
--   Safe to run more than once: both steps check information_schema first.
-- =============================================================================

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_status_notifications'
    AND COLUMN_NAME = 'next_retry_at'
);

SET @add_col := IF(
  @col_exists = 0,
  'ALTER TABLE order_status_notifications ADD COLUMN next_retry_at DATETIME NULL DEFAULT NULL',
  'SELECT 1'
);

PREPARE stmt FROM @add_col;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'order_status_notifications'
    AND INDEX_NAME = 'idx_osn_status_next_retry'
);

SET @add_idx := IF(
  @idx_exists = 0,
  'CREATE INDEX idx_osn_status_next_retry ON order_status_notifications(status, next_retry_at)',
  'SELECT 1'
);

PREPARE stmt FROM @add_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
