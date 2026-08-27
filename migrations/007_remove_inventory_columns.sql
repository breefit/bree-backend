-- Remove legacy inventory fields after application stock logic is removed.
-- The conditional statements keep this migration safe on databases where a
-- column was already removed manually or was never created.

SET @drop_products_stock_qty = IF(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'products'
      AND column_name = 'stock_qty'
  ),
  'ALTER TABLE products DROP COLUMN stock_qty',
  'SELECT 1'
);
PREPARE drop_products_stock_qty_stmt FROM @drop_products_stock_qty;
EXECUTE drop_products_stock_qty_stmt;
DEALLOCATE PREPARE drop_products_stock_qty_stmt;

SET @drop_products_status = IF(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'products'
      AND column_name = 'status'
  ),
  'ALTER TABLE products DROP COLUMN status',
  'SELECT 1'
);
PREPARE drop_products_status_stmt FROM @drop_products_status;
EXECUTE drop_products_status_stmt;
DEALLOCATE PREPARE drop_products_status_stmt;

SET @drop_orders_stock_deducted = IF(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'orders'
      AND column_name = 'stock_deducted'
  ),
  'ALTER TABLE orders DROP COLUMN stock_deducted',
  'SELECT 1'
);
PREPARE drop_orders_stock_deducted_stmt FROM @drop_orders_stock_deducted;
EXECUTE drop_orders_stock_deducted_stmt;
DEALLOCATE PREPARE drop_orders_stock_deducted_stmt;