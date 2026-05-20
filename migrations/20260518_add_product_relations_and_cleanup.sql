-- Migration: add product_relations table and soft-delete existing products
BEGIN;

-- Create a table to store product relationships (upsell, recommend, related)
CREATE TABLE IF NOT EXISTS product_relations (
  id SERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  related_product_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'recommend', -- recommend|upsell|related
  weight INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT fk_product FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_related_product FOREIGN KEY(related_product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_relations_product ON product_relations(product_id);
CREATE INDEX IF NOT EXISTS idx_product_relations_related ON product_relations(related_product_id);

-- Soft-delete (deactivate) all existing product rows so admin can re-create
-- or manually activate only desired products. This preserves historical order items.
UPDATE products SET is_active = false WHERE is_active = true;

COMMIT;
