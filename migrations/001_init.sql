-- BREE Database Schema
-- Run via: node migrations/migrate.js
-- Compatible with Neon PostgreSQL

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL UNIQUE,
  password    TEXT,                       -- NULL for OAuth users
  phone       TEXT,
  picture     TEXT,
  provider    TEXT        NOT NULL DEFAULT 'email',
  role        TEXT        NOT NULL DEFAULT 'user',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

ALTER TABLE users
  ALTER COLUMN role SET DEFAULT 'user';

UPDATE users
  SET role = 'user'
  WHERE role IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── Addresses ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS addresses (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT        NOT NULL DEFAULT 'Home',
  line1       TEXT        NOT NULL,
  line2       TEXT,
  city        TEXT        NOT NULL,
  state       TEXT        NOT NULL,
  pincode     TEXT        NOT NULL,
  country     TEXT        NOT NULL DEFAULT 'India',
  is_default  BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

-- ── Products ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id          TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT          NOT NULL,
  slug        TEXT          NOT NULL UNIQUE,
  category    TEXT          NOT NULL DEFAULT 'Wellness Shot',
  description TEXT          NOT NULL DEFAULT '',
  price       NUMERIC(10,2) NOT NULL,
  mrp         NUMERIC(10,2) NOT NULL,
  quantity    INT           NOT NULL DEFAULT 1,   -- bottles per pack
  stock_qty   INT           NOT NULL DEFAULT 0,
  image       TEXT          NOT NULL DEFAULT '',
  features    TEXT[]        NOT NULL DEFAULT '{}',
  popular     BOOLEAN       NOT NULL DEFAULT false,
  status      TEXT          NOT NULL DEFAULT 'In Stock',
  is_active   BOOLEAN       NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);

-- ── Orders ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT          REFERENCES users(id),
  customer_name     TEXT          NOT NULL,
  email             TEXT          NOT NULL,
  mobile_number     TEXT          NOT NULL DEFAULT '',
  shipping_address  TEXT          NOT NULL DEFAULT '',
  amount            NUMERIC(10,2) NOT NULL,
  order_status      TEXT          NOT NULL DEFAULT 'pending',
  payment_status    TEXT          NOT NULL DEFAULT 'pending',
  transaction_id    TEXT,
  razorpay_order_id TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user        ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_payment     ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created     ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_rzp_id      ON orders(razorpay_order_id);

-- ── Order Items ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id          TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id    TEXT          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT          NOT NULL REFERENCES products(id),
  name        TEXT          NOT NULL,
  quantity    INT           NOT NULL,
  price       NUMERIC(10,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ── Payments ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                    TEXT          PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id              TEXT          NOT NULL UNIQUE REFERENCES orders(id),
  razorpay_order_id     TEXT          NOT NULL UNIQUE,
  razorpay_payment_id   TEXT          UNIQUE,
  razorpay_signature    TEXT,
  amount                NUMERIC(10,2) NOT NULL,
  currency              TEXT          NOT NULL DEFAULT 'INR',
  status                TEXT          NOT NULL DEFAULT 'created',
  refund_id             TEXT,
  refund_amount         NUMERIC(10,2),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_rzp_order ON payments(razorpay_order_id);

-- ── Contact Inquiries ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_inquiries (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  phone       TEXT,
  message     TEXT        NOT NULL,
  contacted   BOOLEAN     NOT NULL DEFAULT false,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inquiries_contacted ON contact_inquiries(contacted);

-- ── Testimonials ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS testimonials (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT        REFERENCES users(id),
  name        TEXT        NOT NULL,
  role        TEXT,
  avatar      TEXT,
  text        TEXT        NOT NULL,
  rating      INT         NOT NULL DEFAULT 5,
  approved    BOOLEAN     NOT NULL DEFAULT false,
  status      TEXT        NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE testimonials
  ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_testimonials_approved ON testimonials(approved);
CREATE INDEX IF NOT EXISTS idx_testimonials_status ON testimonials(status);
CREATE INDEX IF NOT EXISTS idx_testimonials_updated ON testimonials(updated_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  user_agent  TEXT,
  ip_address  TEXT,
  revoked     BOOLEAN     NOT NULL DEFAULT false,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- ── Admins ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email       TEXT        NOT NULL UNIQUE,
  password    TEXT        NOT NULL,
  name        TEXT        NOT NULL DEFAULT 'Admin',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
