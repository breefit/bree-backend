-- =============================================================================
-- Migration: Product visibility ("Show in User UI")
-- Version: 010
-- Created: 2026-09-28
-- Description:
--   Adds products.is_visible — the admin toggle that hides a product from
--   every customer-facing listing, detail page, recommendation and new
--   purchase while keeping it fully manageable in Admin.
--
--   Deliberately NOT reusing products.is_active: that column is the
--   soft-delete flag (DELETE /api/admin/products/:id sets it to 0).
--
--   NOT NULL DEFAULT 1 → every existing product stays visible after deploy.
--
--   The same column is also added on boot by ensureProductVisibilityColumn()
--   in src/config/database.js (additive, same pattern as
--   ensurePackageProductColumns). This file is for `npm run migrate`.
--
--   Safe to run more than once: both steps check information_schema first.
-- =============================================================================

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'products'
    AND COLUMN_NAME = 'is_visible'
);

SET @add_col := IF(
  @col_exists = 0,
  'ALTER TABLE products ADD COLUMN is_visible TINYINT(1) NOT NULL DEFAULT 1',
  'SELECT 1'
);

PREPARE stmt FROM @add_col;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'products'
    AND INDEX_NAME = 'idx_products_visible'
);

SET @add_idx := IF(
  @idx_exists = 0,
  'CREATE INDEX idx_products_visible ON products(is_visible)',
  'SELECT 1'
);

PREPARE stmt FROM @add_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
