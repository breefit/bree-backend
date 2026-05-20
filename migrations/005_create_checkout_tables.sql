-- =========================================
-- USER ADDRESSES TABLE
-- =========================================

CREATE TABLE IF NOT EXISTS user_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Address Details
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    address_line_1 TEXT NOT NULL,
    address_line_2 TEXT,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    pincode VARCHAR(10) NOT NULL,
    country VARCHAR(100) DEFAULT 'India',

    -- Address Type
    address_type VARCHAR(50) DEFAULT 'home',

    -- Default Address
    is_default BOOLEAN DEFAULT FALSE,

    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- =========================================
-- USER ADDRESS INDEXES
-- =========================================

CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id
ON user_addresses(user_id);

CREATE INDEX IF NOT EXISTS idx_user_addresses_default
ON user_addresses(user_id, is_default);

CREATE INDEX IF NOT EXISTS idx_user_addresses_created
ON user_addresses(created_at DESC);

-- Only one default address per user
CREATE UNIQUE INDEX IF NOT EXISTS unique_default_per_user
ON user_addresses(user_id)
WHERE is_default = TRUE;

-- =========================================
-- ORDERS TABLE
-- =========================================

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    address_id UUID REFERENCES user_addresses(id)
    ON DELETE SET NULL,

    -- Contact Snapshot
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(20) NOT NULL,
    contact_name VARCHAR(255) NOT NULL,

    -- Pricing Snapshot
    subtotal DECIMAL(10,2) NOT NULL,
    shipping DECIMAL(10,2) DEFAULT 0,
    tax DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,

    -- Payment Status
    payment_status VARCHAR(50) DEFAULT 'pending',

    -- Order Status
    order_status VARCHAR(50) DEFAULT 'pending',

    -- Razorpay
    razorpay_order_id VARCHAR(255),
    razorpay_payment_id VARCHAR(255),

    -- Dates
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    paid_at TIMESTAMP
);

-- =========================================
-- ORDER INDEXES
-- =========================================

CREATE INDEX IF NOT EXISTS idx_orders_user_id
ON orders(user_id);

CREATE INDEX IF NOT EXISTS idx_orders_status
ON orders(payment_status, order_status);

CREATE INDEX IF NOT EXISTS idx_orders_created
ON orders(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_razorpay
ON orders(razorpay_order_id, razorpay_payment_id);

-- =========================================
-- ORDER ITEMS TABLE
-- =========================================

CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    order_id UUID NOT NULL REFERENCES orders(id)
    ON DELETE CASCADE,

    product_id UUID NOT NULL,

    -- Product Snapshot
    product_name VARCHAR(255) NOT NULL,
    product_image TEXT,
    product_price DECIMAL(10,2) NOT NULL,
    product_mrp DECIMAL(10,2),
    product_quantity_pack INT,

    -- Quantity
    quantity INT NOT NULL DEFAULT 1,

    -- Subtotal
    subtotal DECIMAL(10,2) NOT NULL,

    -- Timestamp
    created_at TIMESTAMP DEFAULT NOW()
);

-- =========================================
-- ORDER ITEM INDEXES
-- =========================================

CREATE INDEX IF NOT EXISTS idx_order_items_order_id
ON order_items(order_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product_id
ON order_items(product_id);

-- =========================================
-- UPDATE TIMESTAMP FUNCTION
-- =========================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =========================================
-- TRIGGERS
-- =========================================

DROP TRIGGER IF EXISTS update_user_addresses_updated_at
ON user_addresses;

CREATE TRIGGER update_user_addresses_updated_at
BEFORE UPDATE ON user_addresses
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_orders_updated_at
ON orders;

CREATE TRIGGER update_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();