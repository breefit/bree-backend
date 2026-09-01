-- =============================================================================
-- Migration: Add Daily WhatsApp Reminder Feature
-- Version: 008
-- Created: 2026-08-31
-- Description:
--   Adds support for optional paid "Daily WhatsApp Reminder" add-ons.
--   - Product-level configuration (enable/disable, pricing)
--   - Customer purchase tracking
--   - Reminder send log with duplicate prevention
-- =============================================================================

-- Add reminder configuration columns to products table
ALTER TABLE products ADD COLUMN daily_reminder_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN daily_reminder_price DECIMAL(10,2) DEFAULT NULL;
ALTER TABLE products ADD COLUMN daily_reminder_original_price DECIMAL(10,2) DEFAULT NULL;

-- Create index on daily_reminder_enabled for faster queries
CREATE INDEX idx_products_reminder_enabled ON products(daily_reminder_enabled);

-- =============================================================================
-- TABLE: daily_reminders
-- Tracks customer purchases of daily reminder add-ons
-- =============================================================================
CREATE TABLE IF NOT EXISTS daily_reminders (
  id CHAR(36) PRIMARY KEY NOT NULL,
  
  -- Customer and order reference
  user_id CHAR(36) NULL,
  order_id CHAR(36) NOT NULL,
  order_item_id CHAR(36) NULL,
  product_id CHAR(36) NOT NULL,
  
  -- Reminder configuration (purchased values)
  reminder_enabled TINYINT(1) NOT NULL DEFAULT 1,
  reminder_time VARCHAR(5) NOT NULL DEFAULT '05:30',  -- HH:MM format (04:00, 04:30, 05:00, 05:30, 06:00)
  reminder_channel VARCHAR(50) NOT NULL DEFAULT 'whatsapp',
  
  -- Pricing (immutable — locked in at purchase time)
  reminder_price_paid DECIMAL(10,2) NOT NULL,
  reminder_original_price DECIMAL(10,2) DEFAULT NULL,
  
  -- Delivery-based activation (essential — reminders ONLY after delivery)
  -- The reminder does NOT start on order creation or payment date
  delivery_date DATE NULL,  -- When the order/package was delivered
  reminder_start_date DATE NULL,  -- delivery_date + 1 day
  reminder_end_date DATE NULL,  -- delivery_date + package duration
  
  -- Package/product duration info (for calculating end date)
  package_duration_days INT DEFAULT NULL,
  
  -- Status tracking
  status VARCHAR(50) NOT NULL DEFAULT 'active',  -- active, paused, ended, cancelled
  
  -- Metadata
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- Foreign key constraints
  CONSTRAINT fk_daily_reminders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_daily_reminders_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_daily_reminders_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Indexes for efficient querying
CREATE INDEX idx_daily_reminders_user ON daily_reminders(user_id);
CREATE INDEX idx_daily_reminders_order ON daily_reminders(order_id);
CREATE INDEX idx_daily_reminders_product ON daily_reminders(product_id);
CREATE INDEX idx_daily_reminders_status ON daily_reminders(status);
CREATE INDEX idx_daily_reminders_active ON daily_reminders(reminder_enabled, status, reminder_start_date, reminder_end_date);
CREATE INDEX idx_daily_reminders_delivery ON daily_reminders(delivery_date);

-- =============================================================================
-- TABLE: daily_reminder_sends
-- Tracks successful reminder sends for idempotency (prevent duplicates)
-- One record per reminder per day = guaranteed single WhatsApp per day
-- =============================================================================
CREATE TABLE IF NOT EXISTS daily_reminder_sends (
  id CHAR(36) PRIMARY KEY NOT NULL,
  
  -- Reference to the reminder and the day it was sent
  reminder_id CHAR(36) NOT NULL,
  send_date DATE NOT NULL,  -- The date the reminder was supposed to be sent (YYYY-MM-DD)
  
  -- Send result
  status VARCHAR(50) NOT NULL DEFAULT 'success',  -- success, failed, skipped
  waplify_message_id VARCHAR(255) DEFAULT NULL,  -- Waplify API response message ID
  error_message TEXT DEFAULT NULL,  -- Error details if failed
  
  -- Timestamp
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Foreign key
  CONSTRAINT fk_daily_reminder_sends_reminder FOREIGN KEY (reminder_id) REFERENCES daily_reminders(id) ON DELETE CASCADE,
  
  -- UNIQUE constraint: only ONE send record per reminder per date
  UNIQUE KEY unique_reminder_send (reminder_id, send_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Indexes
CREATE INDEX idx_daily_reminder_sends_reminder ON daily_reminder_sends(reminder_id);
CREATE INDEX idx_daily_reminder_sends_date ON daily_reminder_sends(send_date);
CREATE INDEX idx_daily_reminder_sends_status ON daily_reminder_sends(status);

-- =============================================================================
-- End of Migration
-- =============================================================================
