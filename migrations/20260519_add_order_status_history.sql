-- Add order_status_history table to track status changes
CREATE TABLE IF NOT EXISTS order_status_history (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id CHAR(36) NOT NULL,
  previous_status VARCHAR(50),
  new_status VARCHAR(50) NOT NULL,
  changed_by CHAR(36), -- admin or system user id
  notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_status_history_order_id FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id);
