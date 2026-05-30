-- Complete recommendations setup in one file
-- MySQL-compatible version for product recommendations.

ALTER TABLE products
ADD COLUMN IF NOT EXISTS recommended_product_ids JSON NOT NULL DEFAULT '[]';

-- Populate recommendations based on product quantities
-- This creates the upgrade paths:
-- 7 → 30 → 180 & 365
-- 180 → 365
-- 365 → (no upgrade)

UPDATE products p1
SET recommended_product_ids = JSON_ARRAY(
  (SELECT p2.id FROM products p2
   WHERE p2.quantity = 30
     AND p2.category = p1.category
     AND p2.is_active = 1
   ORDER BY p2.created_at
   LIMIT 1)
)
WHERE p1.quantity = 7
  AND p1.is_active = 1
  AND (JSON_LENGTH(p1.recommended_product_ids) IS NULL OR JSON_LENGTH(p1.recommended_product_ids) = 0);

UPDATE products p1
SET recommended_product_ids = (
  SELECT COALESCE(JSON_ARRAYAGG(p2.id), JSON_ARRAY()) FROM products p2
  WHERE p2.quantity IN (180, 365)
    AND p2.category = p1.category
    AND p2.is_active = 1
  ORDER BY p2.quantity ASC
)
WHERE p1.quantity = 30
  AND p1.is_active = 1
  AND (JSON_LENGTH(p1.recommended_product_ids) IS NULL OR JSON_LENGTH(p1.recommended_product_ids) = 0);

UPDATE products p1
SET recommended_product_ids = JSON_ARRAY(
  (SELECT p2.id FROM products p2
   WHERE p2.quantity = 365
     AND p2.category = p1.category
     AND p2.is_active = 1
   LIMIT 1)
)
WHERE p1.quantity = 180
  AND p1.is_active = 1
  AND (JSON_LENGTH(p1.recommended_product_ids) IS NULL OR JSON_LENGTH(p1.recommended_product_ids) = 0);

-- Step 3: Verify the setup
SELECT 
    'Setup Status Report' AS report,
    COUNT(*) AS total_products,
    SUM(CASE WHEN recommended_product_ids IS NOT NULL AND JSON_LENGTH(recommended_product_ids) > 0 THEN 1 ELSE 0 END) AS products_with_recommendations,
    SUM(CASE WHEN recommended_product_ids IS NULL OR JSON_LENGTH(recommended_product_ids) = 0 THEN 1 ELSE 0 END) AS products_without_recommendations
FROM products;

SELECT 
    id,
    name,
    quantity,
    category,
    recommended_product_ids,
    JSON_LENGTH(recommended_product_ids) AS num_recommendations
FROM products
WHERE recommended_product_ids IS NOT NULL 
  AND JSON_LENGTH(recommended_product_ids) > 0
ORDER BY quantity;
