-- =========================================
-- USER ADDRESSES TABLE
-- =========================================

CREATE TABLE IF NOT EXISTS user_addresses (
    id CHAR(36) PRIMARY KEY NOT NULL DEFAULT (UUID()),
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

-- =========================================
-- USER ADDRESS INDEXES
-- =========================================

CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id
ON user_addresses(user_id);

CREATE INDEX IF NOT EXISTS idx_user_addresses_default
ON user_addresses(user_id, is_default);

CREATE INDEX IF NOT EXISTS idx_user_addresses_created
ON user_addresses(created_at);

-- =========================================
-- ORDERS TABLE
-- =========================================

CREATE TABLE IF NOT EXISTS orders (
    id CHAR(36) PRIMARY KEY NOT NULL DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    address_id CHAR(36) NULL,
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(20) NOT NULL,
    contact_name VARCHAR(255) NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    shipping DECIMAL(10,2) NOT NULL DEFAULT 0,
    tax DECIMAL(10,2) NOT NULL DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    payment_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    order_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    razorpay_order_id VARCHAR(255),
    razorpay_payment_id VARCHAR(255),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    paid_at DATETIME,
    CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_orders_address FOREIGN KEY (address_id) REFERENCES user_addresses(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================
-- ORDER INDEXES
-- =========================================

CREATE INDEX IF NOT EXISTS idx_orders_user_id
ON orders(user_id);

CREATE INDEX IF NOT EXISTS idx_orders_status
ON orders(payment_status, order_status);

CREATE INDEX IF NOT EXISTS idx_orders_created
ON orders(created_at);

CREATE INDEX IF NOT EXISTS idx_orders_razorpay
ON orders(razorpay_order_id, razorpay_payment_id);

-- =========================================
-- ORDER ITEMS TABLE
-- =========================================

CREATE TABLE IF NOT EXISTS order_items (
    id CHAR(36) PRIMARY KEY NOT NULL DEFAULT (UUID()),
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

-- =========================================
-- ORDER ITEM INDEXES
-- =========================================

CREATE INDEX IF NOT EXISTS idx_order_items_order_id
ON order_items(order_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product_id
ON order_items(product_id);
