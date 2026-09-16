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

-- FIX (Medium #26 — Phase 3): auth (OTP/phone lookup) and payment code do
-- direct WHERE phone = ? lookups against this table; non-unique since
-- phone isn't guaranteed unique here (unlike email/customer_number above).
-- Also created idempotently at runtime by ensureUsersPhoneIndex in
-- config/database.js for databases that predate this line.
CREATE INDEX idx_users_phone ON users(phone);

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
  image                   TEXT          NOT NULL,
  features                JSON          NOT NULL,
  recommended_product_ids JSON          NOT NULL DEFAULT (JSON_ARRAY()),
  duration                INT           DEFAULT NULL,
  display_order           INT           NOT NULL DEFAULT 0,
  featured                TINYINT(1)    NOT NULL DEFAULT 0,
  popular                 TINYINT(1)    NOT NULL DEFAULT 0,
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
  razorpay_payment_id      VARCHAR(255)  DEFAULT NULL UNIQUE,
  order_confirmation_email_sent_at DATETIME NULL DEFAULT NULL,
  order_confirmation_whatsapp_sent_at DATETIME NULL DEFAULT NULL,

  razorpay_subscription_id VARCHAR(255)  DEFAULT NULL,
  razorpay_plan_id         VARCHAR(255)  DEFAULT NULL,
  subscription_status      VARCHAR(50)   NOT NULL DEFAULT 'pending',
  next_billing_date        DATETIME      NULL,
  is_subscription          TINYINT(1)    NOT NULL DEFAULT 0,

  notes                    TEXT          DEFAULT NULL,
  paid_at                  DATETIME      NULL,
  created_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  order_number             VARCHAR(30)   DEFAULT NULL UNIQUE,
  is_renewal_order         TINYINT(1)    NOT NULL DEFAULT 0,
  parent_order_id          VARCHAR(36)   DEFAULT NULL,
  is_free_shipping         TINYINT(1)    NOT NULL DEFAULT 0,
  shipping_charge          DECIMAL(10,2) NOT NULL DEFAULT 0,
  estimated_delivery       VARCHAR(100)  DEFAULT NULL,

  -- FIX (ISSUE-017 — financial-data safety): was ON DELETE CASCADE, meaning
  -- a deleted user row would silently delete every one of their orders
  -- (and, transitively, order_items/payments/order_status_history via
  -- their own CASCADE FKs to orders) — a real risk for financial/audit
  -- records if a "delete my account"/GDPR-erasure feature is ever added.
  -- user_id is already nullable (guest checkout orders have user_id=NULL),
  -- so SET NULL is schema-compatible — matches fk_orders_address below.
  -- See migrations/009_orders_user_fk_set_null.sql for existing databases.
  CONSTRAINT fk_orders_user    FOREIGN KEY (user_id)    REFERENCES users(id)     ON DELETE SET NULL,
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
-- TABLE: subscription_email_notifications
-- One durable claim per logical subscription email notification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_email_notifications (
  notification_key VARCHAR(255) PRIMARY KEY,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts         INT NOT NULL DEFAULT 0,
  last_attempt_at  DATETIME NULL,
  sent_at          DATETIME NULL,
  last_error       VARCHAR(1000) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- ---------------------------------------------------------------------------
-- TABLE: webhook_events  (Phase 3B — Razorpay webhook idempotency ledger)
-- ---------------------------------------------------------------------------
-- event_id is a SHA-256 hash of the raw webhook body, not a Razorpay-
-- provided field — Razorpay's webhook payloads carry no dedicated event/
-- delivery id (see src/services/webhookIdempotencyService.js). No webhook
-- payload contents or secrets are stored here.
CREATE TABLE IF NOT EXISTS webhook_events (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  provider       VARCHAR(20)   NOT NULL,
  event_id       VARCHAR(64)   NOT NULL,
  event_type     VARCHAR(100)  NOT NULL,
  status         VARCHAR(20)   NOT NULL DEFAULT 'processing',
  error_message  VARCHAR(1000) NULL DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at   DATETIME      NULL DEFAULT NULL,
  UNIQUE KEY uq_webhook_events_provider_event_id (provider, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: checkout_idempotency  (Phase 3B — checkout double-submit protection)
-- ---------------------------------------------------------------------------
-- idempotency_key is client-generated (see
-- src/services/checkoutIdempotencyService.js and bree-frontend's
-- Checkout.js) — one per checkout page mount, not per user, so a customer
-- can still legitimately place multiple separate orders.
CREATE TABLE IF NOT EXISTS checkout_idempotency (
  id                CHAR(36)      NOT NULL PRIMARY KEY,
  idempotency_key   VARCHAR(100)  NOT NULL,
  user_id           CHAR(36)      NULL DEFAULT NULL,
  status            VARCHAR(20)   NOT NULL DEFAULT 'processing',
  order_id          CHAR(36)      NULL DEFAULT NULL,
  razorpay_order_id VARCHAR(255)  NULL DEFAULT NULL,
  error_message     VARCHAR(1000) NULL DEFAULT NULL,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_checkout_idempotency_key (idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: order_status_notifications  (Phase 4 — LOW-20: added to fresh-install
-- schema; was previously created only via a runtime migration)
-- ---------------------------------------------------------------------------
-- Idempotency/claim ledger for order-status-change customer notifications —
-- one row per (order, status, channel), claimed atomically before sending,
-- so no duplicate WhatsApp/email ever goes out no matter how many times the
-- same status transition is observed. See
-- src/services/orderStatusNotificationService.js.
CREATE TABLE IF NOT EXISTS order_status_notifications (
  notification_key  VARCHAR(255)  NOT NULL PRIMARY KEY,
  status             VARCHAR(20)   NOT NULL DEFAULT 'pending',
  attempts           INT           NOT NULL DEFAULT 0,
  last_attempt_at    DATETIME      NULL DEFAULT NULL,
  sent_at            DATETIME      NULL DEFAULT NULL,
  last_error         VARCHAR(1000) NULL DEFAULT NULL,
  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: bulk_booking_number_counter  (Phase 4 — LOW-20: sequence generator
-- for BB-###### bulk booking numbers; was previously runtime-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bulk_booking_number_counter (
  id             TINYINT    NOT NULL PRIMARY KEY,
  current_value  INT        NOT NULL,
  updated_at     TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: bulk_booking_communications  (Phase 4 — LOW-20: was previously
-- runtime-only)
-- ---------------------------------------------------------------------------
-- Communication-history log for Bulk Order quote/confirmation/dispatch
-- events, shown on the admin bulk booking detail screen.
CREATE TABLE IF NOT EXISTS bulk_booking_communications (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  bulk_booking_id  CHAR(36)      NOT NULL,
  type             VARCHAR(40)   NOT NULL,
  label            VARCHAR(100)  NOT NULL,
  sent_by          VARCHAR(36)   NULL DEFAULT NULL,
  sent_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bulk_booking_communications_booking (bulk_booking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: package_purchases  (Phase 4 — LOW-20: Model B pay-once recurring
-- package parent record; was previously runtime-only)
-- ---------------------------------------------------------------------------
-- One row per pay-once, BREE-fulfilled recurring package purchase. See
-- src/services/packageFulfillmentService.js and docs/DATABASE.md's
-- "Recurring Package Database" section. origin_order_id UNIQUE is the
-- idempotency key preventing a duplicate row for the same origin order.
CREATE TABLE IF NOT EXISTS package_purchases (
  id                          CHAR(36)      NOT NULL PRIMARY KEY,
  package_number              VARCHAR(30)   NULL UNIQUE,
  user_id                     CHAR(36)      NULL,
  product_id                  CHAR(36)      NOT NULL,
  origin_order_id             CHAR(36)      NOT NULL UNIQUE,
  total_cycles                INT           NOT NULL,
  fulfillment_interval_days   INT           NOT NULL,
  cycles_created               INT           NOT NULL DEFAULT 1,
  next_fulfillment_date       DATETIME      NULL DEFAULT NULL,
  status                      VARCHAR(20)   NOT NULL DEFAULT 'active',
  created_at                  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_package_purchases_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_package_purchases_product
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_package_purchases_origin_order
    FOREIGN KEY (origin_order_id) REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_package_purchases_status_next (status, next_fulfillment_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: package_number_counter  (Phase 4 — LOW-20: sequence generator for
-- PKG-###### package numbers; was previously runtime-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS package_number_counter (
  id             TINYINT    NOT NULL PRIMARY KEY,
  current_value  INT        NOT NULL,
  updated_at     TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: daily_reminders  (Phase 4 — LOW-20: was previously created only by
-- migrations/008_add_daily_reminder_feature.sql, absent from this
-- fresh-install dump)
-- ---------------------------------------------------------------------------
-- A customer's purchase of the Daily WhatsApp Reminder add-on for one
-- order/product. See src/services/dailyReminderService.js and
-- cron/dailyReminderCron.js.
CREATE TABLE IF NOT EXISTS daily_reminders (
  id                     CHAR(36)      NOT NULL PRIMARY KEY,
  user_id                CHAR(36)      NOT NULL,
  order_id               CHAR(36)      NOT NULL,
  product_id             CHAR(36)      NOT NULL,
  reminder_enabled       TINYINT(1)    NOT NULL DEFAULT 1,
  reminder_time          TIME          NULL DEFAULT NULL,
  reminder_channel       VARCHAR(20)   NOT NULL DEFAULT 'whatsapp',
  reminder_whatsapp_number VARCHAR(20) NULL DEFAULT NULL,
  delivery_date          DATE          NULL DEFAULT NULL,
  reminder_start_date    DATE          NULL DEFAULT NULL,
  reminder_end_date      DATE          NULL DEFAULT NULL,
  package_duration_days  INT           NULL DEFAULT NULL,
  -- Free-text (not a DB enum) so a new value can be added without a
  -- migration. Only 'active'/'paused'/'ended' are currently written by
  -- application code — 'cancelled' is reserved, not yet used.
  status                 VARCHAR(50)   NOT NULL DEFAULT 'active',
  created_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_daily_reminders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_daily_reminders_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_daily_reminders_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_daily_reminders_user (user_id),
  INDEX idx_daily_reminders_order (order_id),
  INDEX idx_daily_reminders_product (product_id),
  INDEX idx_daily_reminders_status (status),
  INDEX idx_daily_reminders_active (reminder_enabled, status, reminder_start_date, reminder_end_date),
  INDEX idx_daily_reminders_delivery (delivery_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- TABLE: daily_reminder_sends  (Phase 4 — LOW-20: was previously created
-- only by migrations/008_add_daily_reminder_feature.sql)
-- ---------------------------------------------------------------------------
-- Idempotency ledger: one row per (reminder, send_date), claimed atomically
-- before sending — guarantees a single WhatsApp reminder per day even under
-- concurrent cron ticks. See cron/dailyReminderCron.js's
-- claimReminderSendSlot.
CREATE TABLE IF NOT EXISTS daily_reminder_sends (
  id                 CHAR(36)      NOT NULL PRIMARY KEY,
  reminder_id        CHAR(36)      NOT NULL,
  send_date          DATE          NOT NULL,
  -- Free-text (not a DB enum). Only 'success'/'failed' are currently
  -- written by cron/dailyReminderCron.js — 'skipped' is reserved, not yet
  -- used.
  status             VARCHAR(50)   NOT NULL DEFAULT 'success',
  waplify_message_id VARCHAR(255)  NULL DEFAULT NULL,
  error_message      TEXT          NULL DEFAULT NULL,
  sent_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_daily_reminder_sends_reminder FOREIGN KEY (reminder_id) REFERENCES daily_reminders(id) ON DELETE CASCADE,
  UNIQUE KEY unique_reminder_send (reminder_id, send_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- END OF SCHEMA
-- =============================================================================