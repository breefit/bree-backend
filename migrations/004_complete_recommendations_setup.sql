-- Complete recommendations setup in one file
-- Run this file to set up the product recommendations feature

-- Step 1: Add recommended_product_ids column if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'products' AND column_name = 'recommended_product_ids'
    ) THEN
        ALTER TABLE products
        ADD COLUMN recommended_product_ids UUID[] DEFAULT ARRAY[]::UUID[];
        
        CREATE INDEX idx_products_recommended_ids ON products USING GIN (recommended_product_ids);
        
        COMMENT ON COLUMN products.recommended_product_ids IS 'Array of product UUIDs to recommend as upgrades for this product';
        
        RAISE NOTICE 'Column recommended_product_ids added successfully';
    ELSE
        RAISE NOTICE 'Column recommended_product_ids already exists';
    END IF;
END $$;

-- Step 2: Populate recommendations based on product quantities
-- This creates the upgrade paths:
-- 7 → 30 → 180 & 365
-- 180 → 365
-- 365 → (no upgrade)

UPDATE products p1
SET recommended_product_ids = ARRAY(
  SELECT id FROM products p2 
  WHERE p2.quantity = 30 
  AND p2.category = p1.category 
  AND p2.is_active = true
  ORDER BY p2.created_at
  LIMIT 1
)
WHERE p1.quantity = 7 AND p1.is_active = true AND (
    p1.recommended_product_ids IS NULL OR 
    array_length(p1.recommended_product_ids, 1) = 0
);

UPDATE products p1
SET recommended_product_ids = ARRAY(
  SELECT id FROM products p2 
  WHERE p2.quantity IN (180, 365)
  AND p2.category = p1.category 
  AND p2.is_active = true
  ORDER BY p2.quantity ASC
)
WHERE p1.quantity = 30 AND p1.is_active = true AND (
    p1.recommended_product_ids IS NULL OR 
    array_length(p1.recommended_product_ids, 1) = 0
);

UPDATE products p1
SET recommended_product_ids = ARRAY(
  SELECT id FROM products p2 
  WHERE p2.quantity = 365
  AND p2.category = p1.category 
  AND p2.is_active = true
  LIMIT 1
)
WHERE p1.quantity = 180 AND p1.is_active = true AND (
    p1.recommended_product_ids IS NULL OR 
    array_length(p1.recommended_product_ids, 1) = 0
);

-- Step 3: Verify the setup
SELECT 
    'Setup Status Report' as report,
    COUNT(*) as total_products,
    SUM(CASE WHEN recommended_product_ids IS NOT NULL AND array_length(recommended_product_ids, 1) > 0 THEN 1 ELSE 0 END) as products_with_recommendations,
    SUM(CASE WHEN recommended_product_ids IS NULL OR array_length(recommended_product_ids, 1) = 0 THEN 1 ELSE 0 END) as products_without_recommendations
FROM products;

-- Show detailed recommendations
SELECT 
    id,
    name,
    quantity,
    category,
    recommended_product_ids,
    array_length(recommended_product_ids, 1) as num_recommendations
FROM products
WHERE recommended_product_ids IS NOT NULL 
AND array_length(recommended_product_ids, 1) > 0
ORDER BY quantity;
