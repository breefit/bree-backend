-- =============================================================================
-- BREE MySQL Schema  — Consolidated Source of Truth (LOCAL, matched to PRODUCTION)
-- Version : 2026-07-07
-- Engine  : MySQL 8.0+ / MariaDB 10.6+
-- Encoding: utf8mb4 / utf8mb4_unicode_ci
--
-- This file reflects the production (Hostinger u431546627_breefit_db) structure
-- exactly, verified column-by-column, index-by-index, FK-by-FK on 2026-07-07.
--
-- Usage   : mysql -u<user> -p <database> < mysql-schema-final.sql
--           OR: node migrations/mysql-migrate.js
-- =============================================================================

SET SESSION sql_mode = 'STRICT_ALL_TABLES';

-- ---------------------------------------------------------------------------
-- TABLE: users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id               CHAR(36)     PRIMARY KEY NOT NULL,
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(255) NOT NULL UNIQUE,
  password         TEXT,
  phone            VARCHAR(50),
  picture          TEXT,
  provider         VARCHAR(50)  NOT NULL DEFAULT 'email',
  role             VARCHAR(50)  NOT NULL DEFAULT 'user',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  customer_number  VARCHAR(20)  DEFAULT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: admins
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id          CHAR(36)     PRIMARY KEY NOT NULL,
  email       VARCHAR(255) NOT NULL UNIQUE,
  password    TEXT         NOT NULL,
  name        VARCHAR(255) NOT NULL DEFAULT 'Admin',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: addresses  (legacy simple address store — this IS what orders.address_id
-- points to in production; do not assume orders points to user_addresses)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS addresses (
  id            CHAR(36)     PRIMARY KEY NOT NULL,
  user_id       CHAR(36)     NOT NULL,
  label         VARCHAR(255) NOT NULL DEFAULT 'Home',
  address_line1 VARCHAR(255) NOT NULL,
  address_line2 VARCHAR(255) DEFAULT NULL,
  city          VARCHAR(255) NOT NULL,
  state         VARCHAR(255) NOT NULL,
  pincode       VARCHAR(50)  NOT NULL,
  country       VARCHAR(255) NOT NULL DEFAULT 'India',
  is_default    TINYINT(1)   NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_addresses_user ON addresses(user_id);

-- ---------------------------------------------------------------------------
-- TABLE: user_addresses  (full checkout address book — separate from `addresses`)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_addresses (
  id              CHAR(36)     PRIMARY KEY NOT NULL,
  user_id         CHAR(36)     NOT NULL,
  full_name       VARCHAR(255) NOT NULL,
  phone           VARCHAR(20)  NOT NULL,
  address_line_1  TEXT         NOT NULL,
  address_line_2  TEXT,
  city            VARCHAR(100) NOT NULL,
  state           VARCHAR(100) NOT NULL,
  pincode         VARCHAR(10)  NOT NULL,
  country         VARCHAR(100) NOT NULL DEFAULT 'India',
  address_type    VARCHAR(50)  NOT NULL DEFAULT 'home',
  is_default      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_user_addresses_user_id ON user_addresses(user_id);
CREATE INDEX idx_user_addresses_default  ON user_addresses(user_id, is_default);
CREATE INDEX idx_user_addresses_created  ON user_addresses(created_at);

-- ---------------------------------------------------------------------------
-- TABLE: products
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id                      CHAR(36)      PRIMARY KEY NOT NULL,
  name                    VARCHAR(255)  NOT NULL,
  slug                    VARCHAR(255)  NOT NULL UNIQUE,
  category                VARCHAR(255)  NOT NULL DEFAULT 'Wellness Shot',
  description             TEXT          NOT NULL,
  price                   DECIMAL(10,2) NOT NULL,
  mrp                     DECIMAL(10,2) NOT NULL,
  quantity                INT           NOT NULL DEFAULT 1,
  stock_qty               INT           NOT NULL DEFAULT 0,
  image                   TEXT          NOT NULL,
  features                JSON          NOT NULL,
  recommended_product_ids JSON          NOT NULL DEFAULT (JSON_ARRAY()),
  duration                INT           DEFAULT NULL,
  display_order           INT           NOT NULL DEFAULT 0,
  featured                TINYINT(1)    NOT NULL DEFAULT 0,
  popular                 TINYINT(1)    NOT NULL DEFAULT 0,
  status                  VARCHAR(100)  NOT NULL DEFAULT 'In Stock',
  is_active               TINYINT(1)    NOT NULL DEFAULT 1,
  discount                DECIMAL(6,2)  DEFAULT NULL,
  created_at              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  razorpay_plan_id        VARCHAR(255)  DEFAULT NULL,
  is_subscription         TINYINT(1)    NOT NULL DEFAULT 0,
  journey_level           INT           NOT NULL DEFAULT 0,
  show_recommendations    TINYINT(1)    NOT NULL DEFAULT 1,
  is_free_shipping        TINYINT(1)    NOT NULL DEFAULT 1,
  shipping_charge         DECIMAL(10,2) NOT NULL DEFAULT 0,
  estimated_delivery      VARCHAR(100)  DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_products_active        ON products(is_active);
CREATE INDEX idx_products_featured      ON products(featured);
CREATE INDEX idx_products_display_order ON products(display_order);

-- ---------------------------------------------------------------------------
-- TABLE: product_relations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_relations (
  id                 INT          PRIMARY KEY AUTO_INCREMENT,
  product_id         CHAR(36)     NOT NULL,
  related_product_id CHAR(36)     NOT NULL,
  relation_type      VARCHAR(50)  NOT NULL DEFAULT 'recommend',
  weight             INT          NOT NULL DEFAULT 0,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_prod_rel_product FOREIGN KEY (product_id)         REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_prod_rel_related FOREIGN KEY (related_product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_product_relations_product ON product_relations(product_id);
CREATE INDEX idx_product_relations_related ON product_relations(related_product_id);

-- ---------------------------------------------------------------------------
-- TABLE: orders
-- NOTE: fk_orders_address references `addresses`, NOT `user_addresses`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                       CHAR(36)      PRIMARY KEY NOT NULL,
  user_id                  CHAR(36)      NULL,
  address_id               CHAR(36)      NULL,

  customer_name            VARCHAR(255)  DEFAULT NULL,
  email                    VARCHAR(255)  DEFAULT NULL,
  mobile_number            VARCHAR(20)   DEFAULT NULL,
  shipping_address         TEXT          DEFAULT NULL,
  transaction_id           VARCHAR(255)  DEFAULT NULL,
  amount                   DECIMAL(10,2) DEFAULT NULL,
  cancel_reason            TEXT          DEFAULT NULL,
  cancelled_by             VARCHAR(255)  DEFAULT NULL,
  cancelled_at             DATETIME      NULL,

  contact_email            VARCHAR(255)  DEFAULT NULL,
  contact_phone            VARCHAR(20)   DEFAULT NULL,
  contact_name             VARCHAR(255)  DEFAULT NULL,

  subtotal                 DECIMAL(10,2) DEFAULT NULL,
  shipping                 DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax                      DECIMAL(10,2) NOT NULL DEFAULT 0,
  total                    DECIMAL(10,2) DEFAULT NULL,

  order_status             VARCHAR(50)   NOT NULL DEFAULT 'pending_payment',
  payment_status           VARCHAR(50)   NOT NULL DEFAULT 'pending',

  razorpay_order_id        VARCHAR(255)  DEFAULT NULL,
  razorpay_payment_id      VARCHAR(255)  DEFAULT NULL,

  razorpay_subscription_id VARCHAR(255)  DEFAULT NULL,
  razorpay_plan_id         VARCHAR(255)  DEFAULT NULL,
  subscription_status      VARCHAR(50)   NOT NULL DEFAULT 'pending',
  next_billing_date        DATETIME      NULL,
  is_subscription          TINYINT(1)    NOT NULL DEFAULT 0,

  notes                    TEXT          DEFAULT NULL,
  paid_at                  DATETIME      NULL,
  created_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  stock_deducted           TINYINT(1)    NOT NULL DEFAULT 0,
  order_number             VARCHAR(30)   DEFAULT NULL UNIQUE,
  is_renewal_order         TINYINT(1)    NOT NULL DEFAULT 0,
  parent_order_id          VARCHAR(36)   DEFAULT NULL,
  is_free_shipping         TINYINT(1)    NOT NULL DEFAULT 0,
  shipping_charge          DECIMAL(10,2) NOT NULL DEFAULT 0,
  estimated_delivery       VARCHAR(100)  DEFAULT NULL,

  CONSTRAINT fk_orders_user    FOREIGN KEY (user_id)    REFERENCES users(id)     ON DELETE CASCADE,
  CONSTRAINT fk_orders_address FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_orders_user_id             ON orders(user_id);
CREATE INDEX idx_orders_status              ON orders(order_status);
CREATE INDEX idx_orders_payment             ON orders(payment_status);
CREATE INDEX idx_orders_created             ON orders(created_at);
CREATE INDEX idx_orders_razorpay            ON orders(razorpay_order_id);
CREATE INDEX idx_orders_subscription        ON orders(razorpay_subscription_id);
CREATE INDEX idx_orders_subscription_status ON orders(subscription_status);
CREATE INDEX idx_orders_parent_order_id     ON orders(parent_order_id);
CREATE INDEX idx_orders_is_renewal_order    ON orders(is_renewal_order);

-- ---------------------------------------------------------------------------
-- TABLE: order_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id                    CHAR(36)      PRIMARY KEY NOT NULL,
  order_id              CHAR(36)      NOT NULL,
  product_id            CHAR(36)      NOT NULL,
  product_name          VARCHAR(255)  NOT NULL,
  product_image         TEXT          DEFAULT NULL,
  product_price         DECIMAL(10,2) NOT NULL,
  product_mrp           DECIMAL(10,2) DEFAULT NULL,
  product_quantity_pack INT           DEFAULT NULL,
  quantity              INT           NOT NULL DEFAULT 1,
  subtotal              DECIMAL(10,2) NOT NULL,
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_order_items_order_id   ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);

-- ---------------------------------------------------------------------------
-- TABLE: order_status_history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_status_history (
  id              INT          PRIMARY KEY AUTO_INCREMENT,
  order_id        CHAR(36)     NOT NULL,
  previous_status VARCHAR(50)  DEFAULT NULL,
  new_status      VARCHAR(50)  NOT NULL,
  changed_by      CHAR(36)     DEFAULT NULL,
  notes           TEXT         DEFAULT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_status_history_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_order_status_history_order_id ON order_status_history(order_id);

-- ---------------------------------------------------------------------------
-- TABLE: payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                       CHAR(36)      PRIMARY KEY NOT NULL,
  order_id                 CHAR(36)      NOT NULL UNIQUE,
  razorpay_order_id        VARCHAR(255)  UNIQUE DEFAULT NULL,
  razorpay_subscription_id VARCHAR(255)  DEFAULT NULL,
  razorpay_payment_id      VARCHAR(255)  UNIQUE DEFAULT NULL,
  razorpay_signature       TEXT          DEFAULT NULL,
  amount                   DECIMAL(10,2) NOT NULL,
  currency                 VARCHAR(20)   NOT NULL DEFAULT 'INR',
  status                   VARCHAR(50)   NOT NULL DEFAULT 'created',
  refund_id                VARCHAR(255)  DEFAULT NULL,
  refund_amount            DECIMAL(10,2) DEFAULT NULL,
  created_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_payments_rzp_order        ON payments(razorpay_order_id);
CREATE INDEX idx_payments_rzp_subscription ON payments(razorpay_subscription_id);

-- ---------------------------------------------------------------------------
-- TABLE: bulk_bookings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bulk_bookings (
  id             CHAR(36)      PRIMARY KEY NOT NULL,
  company_name   VARCHAR(255)  NOT NULL,
  contact_person VARCHAR(255)  NOT NULL,
  email          VARCHAR(255)  NOT NULL,
  mobile_number  VARCHAR(20)   NOT NULL,
  location       VARCHAR(255)  DEFAULT NULL,
  quantity       INT           DEFAULT NULL,
  requirements   TEXT          DEFAULT NULL,
  status         VARCHAR(30)   NOT NULL DEFAULT 'new',
  quote_price    DECIMAL(10,2) DEFAULT NULL,
  delivery_date  DATE          DEFAULT NULL,
  admin_notes    TEXT          DEFAULT NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_bulk_bookings_status     ON bulk_bookings(status);
CREATE INDEX idx_bulk_bookings_created_at ON bulk_bookings(created_at);

-- ---------------------------------------------------------------------------
-- TABLE: contact_inquiries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_inquiries (
  id         CHAR(36)     PRIMARY KEY NOT NULL,
  name       VARCHAR(255) NOT NULL,
  email      VARCHAR(255) NOT NULL,
  phone      VARCHAR(50)  DEFAULT NULL,
  message    TEXT         NOT NULL,
  contacted  TINYINT(1)   NOT NULL DEFAULT 0,
  notes      TEXT         DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_inquiries_contacted ON contact_inquiries(contacted);

-- ---------------------------------------------------------------------------
-- TABLE: testimonials
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS testimonials (
  id         CHAR(36)     PRIMARY KEY NOT NULL,
  user_id    CHAR(36)     NULL,
  name       VARCHAR(255) NOT NULL,
  role       VARCHAR(255) DEFAULT NULL,
  avatar     TEXT         DEFAULT NULL,
  text       TEXT         NOT NULL,
  rating     INT          NOT NULL DEFAULT 5,
  approved   TINYINT(1)   NOT NULL DEFAULT 0,
  status     VARCHAR(50)  NOT NULL DEFAULT 'pending',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_testimonials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_testimonials_approved ON testimonials(approved);
CREATE INDEX idx_testimonials_status   ON testimonials(status);
CREATE INDEX idx_testimonials_updated  ON testimonials(updated_at);

-- ---------------------------------------------------------------------------
-- TABLE: refresh_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          CHAR(36)     PRIMARY KEY NOT NULL,
  user_id     CHAR(36)     NOT NULL,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  user_agent  TEXT         DEFAULT NULL,
  ip_address  VARCHAR(100) DEFAULT NULL,
  revoked     TINYINT(1)   NOT NULL DEFAULT 0,
  expires_at  DATETIME     NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_refresh_tokens_user_id    ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- TABLE: razorpay_plans  (cache: reuse an existing plan for a given price, else create one)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS razorpay_plans (
  id               CHAR(36)     NOT NULL,
  razorpay_plan_id VARCHAR(255) NOT NULL,
  amount_paise     INT          NOT NULL,
  period           VARCHAR(20)  NOT NULL DEFAULT 'month',
  interval_val     INT          NOT NULL DEFAULT 1,
  plan_name        VARCHAR(255) NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_rzp_plan_id (razorpay_plan_id),
  INDEX idx_plan_lookup (amount_paise, period, interval_val)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: customer_number_counter  (sequence generator for BREE-C###### numbers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_number_counter (
  id             TINYINT(4)   NOT NULL,
  current_value  INT(11)      NOT NULL,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: order_number_counter  (sequence generator for BREE-###### order numbers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_number_counter (
  id             TINYINT(4)   NOT NULL,
  current_value  INT(11)      NOT NULL,
  updated_at     TIMESTAMP    NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- END OF SCHEMA
-- =============================================================================