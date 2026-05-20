-- Add recommended_product_ids column to products table
-- This stores UUIDs of products that should be recommended as upgrades

ALTER TABLE products
ADD COLUMN recommended_product_ids UUID[] DEFAULT ARRAY[]::UUID[];

-- Add index for better query performance
CREATE INDEX idx_products_recommended_ids ON products USING GIN (recommended_product_ids);

-- Optional: Add a comment for documentation
COMMENT ON COLUMN products.recommended_product_ids IS 'Array of product UUIDs to recommend as upgrades for this product';
