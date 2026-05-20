-- Populate recommended_product_ids based on product quantities
-- Run this after the migration

-- For 7-Pack products: recommend 30-Pack products
UPDATE products p1
SET recommended_product_ids = ARRAY(
  SELECT id FROM products p2 
  WHERE p2.quantity = 30 
  AND p2.category = p1.category 
  AND p2.is_active = true
  LIMIT 1
)
WHERE p1.quantity = 7 AND p1.is_active = true;

-- For 30-Pack products: recommend 6-Month (180) and 1-Year (365) products
UPDATE products p1
SET recommended_product_ids = ARRAY(
  SELECT id FROM products p2 
  WHERE p2.quantity IN (180, 365)
  AND p2.category = p1.category 
  AND p2.is_active = true
  ORDER BY p2.quantity ASC
)
WHERE p1.quantity = 30 AND p1.is_active = true;

-- For 6-Month (180) products: recommend 1-Year (365) products
UPDATE products p1
SET recommended_product_ids = ARRAY(
  SELECT id FROM products p2 
  WHERE p2.quantity = 365
  AND p2.category = p1.category 
  AND p2.is_active = true
  LIMIT 1
)
WHERE p1.quantity = 180 AND p1.is_active = true;

-- 1-Year (365) products get no recommendations (empty array)
-- This is already the default
