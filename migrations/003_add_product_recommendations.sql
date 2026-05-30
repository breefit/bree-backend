-- Add recommended_product_ids column to products table
-- This stores product IDs as a JSON array for MySQL compatibility.

ALTER TABLE products
ADD COLUMN IF NOT EXISTS recommended_product_ids JSON NOT NULL DEFAULT '[]';

-- MySQL does not support direct JSON indexing for array containment in the same way as Postgres GIN.
-- If needed, a generated column can be added later for search performance.
