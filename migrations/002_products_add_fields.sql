-- Migration: add product metadata fields
-- Run: node migrations/migrate.js (or run SQL against your Postgres DB)

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS duration INT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;

-- Optional: backfill `featured` from `popular`
UPDATE products SET featured = popular WHERE featured IS FALSE;

-- Optional: compute discount percentage column if you want a persisted value
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS discount NUMERIC(6,2) DEFAULT NULL;

UPDATE products
SET discount = ROUND((mrp - price) * 100.0 / NULLIF(mrp,0), 2)
WHERE mrp IS NOT NULL AND mrp > 0;

-- Indexes for quick lookup
CREATE INDEX IF NOT EXISTS idx_products_featured ON products(featured);
CREATE INDEX IF NOT EXISTS idx_products_display_order ON products(display_order);
