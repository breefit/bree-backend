-- Migration: add product_relations table and soft-delete existing products

CREATE TABLE IF NOT EXISTS product_relations (
  id INT PRIMARY KEY AUTO_INCREMENT,
  product_id CHAR(36) NOT NULL,
  related_product_id CHAR(36) NOT NULL,
  relation_type VARCHAR(50) NOT NULL DEFAULT 'recommend', -- recommend|upsell|related
  weight INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_product FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_related_product FOREIGN KEY(related_product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_product_relations_product ON product_relations(product_id);
CREATE INDEX IF NOT EXISTS idx_product_relations_related ON product_relations(related_product_id);

-- Soft-delete (deactivate) all existing product rows so admin can re-create
-- or manually activate only desired products. This preserves historical order items.
UPDATE products SET is_active = 0 WHERE is_active = 1;
