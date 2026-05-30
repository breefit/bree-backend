-- BREE MySQL Schema
-- This schema is the MySQL equivalent of the previous PostgreSQL schema.
-- Use `node migrations/mysql-migrate.js` to create it against a MySQL database.

SET SESSION sql_mode = 'STRICT_ALL_TABLES';

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password TEXT,
  phone VARCHAR(50),
  picture TEXT,
  provider VARCHAR(50) NOT NULL DEFAULT 'email',
  role VARCHAR(50) NOT NULL DEFAULT 'user',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS addresses (
  id CHAR(36) PRIMARY KEY NOT NULL,
  user_id CHAR(36) NOT NULL,
  label VARCHAR(255) NOT NULL DEFAULT 'Home',
  line1 TEXT NOT NULL,
  line2 TEXT,
  city VARCHAR(255) NOT NULL,
  state VARCHAR(255) NOT NULL,
  pincode VARCHAR(50) NOT NULL,
  country VARCHAR(255) NOT NULL DEFAULT 'India',
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_addresses_user ON addresses(user_id);

CREATE TABLE IF NOT EXISTS user_addresses (
  id CHAR(36) PRIMARY KEY NOT NULL,
  user_id CHAR(36) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  address_line_1 TEXT NOT NULL,
  address_line_2 TEXT,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  pincode VARCHAR(10) NOT NULL,
  country VARCHAR(100) NOT NULL DEFAULT 'India',
  address_type VARCHAR(50) NOT NULL DEFAULT 'home',
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_user_addresses_user_id ON user_addresses(user_id);
CREATE INDEX idx_user_addresses_default ON user_addresses(user_id, is_default);
CREATE INDEX idx_user_addresses_created ON user_addresses(created_at);

CREATE TABLE IF NOT EXISTS products (
  id CHAR(36) PRIMARY KEY NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  category VARCHAR(255) NOT NULL DEFAULT 'Wellness Shot',
  description TEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  mrp DECIMAL(10,2) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  stock_qty INT NOT NULL DEFAULT 0,
  image TEXT NOT NULL,
  features JSON NOT NULL,
  recommended_product_ids JSON NOT NULL,
  duration INT DEFAULT NULL,
  display_order INT NOT NULL DEFAULT 0,
  featured TINYINT(1) NOT NULL DEFAULT 0,
  popular TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(100) NOT NULL DEFAULT 'In Stock',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  discount DECIMAL(6,2) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_products_active ON products(is_active);
CREATE INDEX idx_products_featured ON products(featured);
CREATE INDEX idx_products_display_order ON products(display_order);

CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY NOT NULL,
  user_id CHAR(36) NULL,
  address_id CHAR(36) NULL,
  customer_name VARCHAR(255),
  email VARCHAR(255),
  mobile_number VARCHAR(20),
  shipping_address TEXT,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(20),
  contact_name VARCHAR(255),
  subtotal DECIMAL(10,2) DEFAULT NULL,
  shipping DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax DECIMAL(10,2) NOT NULL DEFAULT 0,
  total DECIMAL(10,2) DEFAULT NULL,
  amount DECIMAL(10,2) DEFAULT NULL,
  order_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  payment_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  transaction_id VARCHAR(255),
  razorpay_order_id VARCHAR(255),
  razorpay_payment_id VARCHAR(255),
  notes TEXT,
  paid_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_address FOREIGN KEY (address_id) REFERENCES user_addresses(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(order_status);
CREATE INDEX idx_orders_payment ON orders(payment_status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_razorpay ON orders(razorpay_order_id);

CREATE TABLE IF NOT EXISTS order_items (
  id CHAR(36) PRIMARY KEY NOT NULL,
  order_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  product_image TEXT,
  product_price DECIMAL(10,2) NOT NULL,
  product_mrp DECIMAL(10,2) DEFAULT NULL,
  product_quantity_pack INT DEFAULT NULL,
  quantity INT NOT NULL DEFAULT 1,
  subtotal DECIMAL(10,2) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);

CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) PRIMARY KEY NOT NULL,
  order_id CHAR(36) NOT NULL UNIQUE,
  razorpay_order_id VARCHAR(255) NOT NULL UNIQUE,
  razorpay_payment_id VARCHAR(255) UNIQUE,
  razorpay_signature TEXT,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(20) NOT NULL DEFAULT 'INR',
  status VARCHAR(50) NOT NULL DEFAULT 'created',
  refund_id VARCHAR(255),
  refund_amount DECIMAL(10,2) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_payments_rzp_order ON payments(razorpay_order_id);

CREATE TABLE IF NOT EXISTS contact_inquiries (
  id CHAR(36) PRIMARY KEY NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  message TEXT NOT NULL,
  contacted TINYINT(1) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_inquiries_contacted ON contact_inquiries(contacted);

CREATE TABLE IF NOT EXISTS testimonials (
  id CHAR(36) PRIMARY KEY NOT NULL,
  user_id CHAR(36) NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(255),
  avatar TEXT,
  text TEXT NOT NULL,
  rating INT NOT NULL DEFAULT 5,
  approved TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_testimonials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_testimonials_approved ON testimonials(approved);
CREATE INDEX idx_testimonials_status ON testimonials(status);
CREATE INDEX idx_testimonials_updated ON testimonials(updated_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id CHAR(36) PRIMARY KEY NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  user_agent TEXT,
  ip_address VARCHAR(100),
  revoked TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS admins (
  id CHAR(36) PRIMARY KEY NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password TEXT NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT 'Admin',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_relations (
  id INT PRIMARY KEY AUTO_INCREMENT,
  product_id CHAR(36) NOT NULL,
  related_product_id CHAR(36) NOT NULL,
  relation_type VARCHAR(50) NOT NULL DEFAULT 'recommend',
  weight INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_prod_rel_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_prod_rel_related FOREIGN KEY (related_product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_product_relations_product ON product_relations(product_id);
CREATE INDEX idx_product_relations_related ON product_relations(related_product_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id CHAR(36) NOT NULL,
  previous_status VARCHAR(50),
  new_status VARCHAR(50) NOT NULL,
  changed_by CHAR(36),
  notes TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_status_history_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_order_status_history_order_id ON order_status_history(order_id);
