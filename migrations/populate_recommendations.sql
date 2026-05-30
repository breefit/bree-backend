-- Populate recommended_product_ids based on product quantities
-- Run this after the migration

-- For 7-Pack products -> recommend 30-Pack
UPDATE products
SET recommended_product_ids = (
  SELECT JSON_ARRAY(id)
  FROM (
    SELECT id FROM products p2
    WHERE p2.quantity = 30
      AND p2.category = products.category
      AND p2.is_active = 1
    LIMIT 1
  ) subq
)
WHERE quantity = 7 AND is_active = 1;

-- For 30-Pack -> recommend 6-Month and 1-Year
UPDATE products
SET recommended_product_ids = (
  SELECT JSON_ARRAYAGG(id)
  FROM (
    SELECT id FROM products p2
    WHERE p2.quantity IN (180, 365)
      AND p2.category = products.category
      AND p2.is_active = 1
    ORDER BY p2.quantity ASC
  ) subq
)
WHERE quantity = 30 AND is_active = 1;

-- For 6-Month -> recommend 1-Year
UPDATE products
SET recommended_product_ids = (
  SELECT JSON_ARRAY(id)
  FROM (
    SELECT id FROM products p2
    WHERE p2.quantity = 365
      AND p2.category = products.category
      AND p2.is_active = 1
    LIMIT 1
  ) subq
)
WHERE quantity = 180 AND is_active = 1;

-- 1-Year (365) products get no recommendations (empty array)
-- This is already the default
