import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// console.log("STEP 3 - Database file loaded");

import mysql from "mysql2/promise";

// console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);

const cleanEnv = (value) => value?.trim();

const dbHost = cleanEnv(process.env.DB_HOST);
const dbPort = Number(cleanEnv(process.env.DB_PORT) || 3306);
const dbUser = cleanEnv(process.env.DB_USER);
const dbPassword = cleanEnv(process.env.DB_PASSWORD);
const dbName = cleanEnv(process.env.DB_NAME);
const databaseUrlRaw = cleanEnv(process.env.DATABASE_URL);

let poolConfig;

if (databaseUrlRaw) {
  try {
    const databaseUrl = new URL(databaseUrlRaw);

    if (!["mysql:", "mysql2:"].includes(databaseUrl.protocol)) {
      throw new Error("DATABASE_URL must use mysql:// or mysql2:// protocol");
    }

    poolConfig = {
      host: databaseUrl.hostname || "localhost",
      port: Number(databaseUrl.port || 3306),
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      database: databaseUrl.pathname.replace(/^\//, ""),
    };
  } catch (err) {
    console.error("❌ Invalid DATABASE_URL format:", databaseUrlRaw);
    console.error("Falling back to DB_HOST / DB_USER / DB_PASSWORD / DB_NAME");
  }
}

if (!poolConfig) {
  if (!dbHost || !dbUser || !dbName) {
    throw new Error(
      "Database configuration is missing. Provide a valid DATABASE_URL or DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.",
    );
  }

  poolConfig = {
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword || "",
    database: dbName,
  };
}

const pool = mysql.createPool({
  ...poolConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: "utf8mb4_unicode_ci",

  // ⭐ Fix timezone
  timezone: "+05:30",
});

const normalizeResult = (result) => {
  if (Array.isArray(result)) {
    const [rows] = result;

    return {
      rows: Array.isArray(rows) ? rows : [],
      rowCount: Array.isArray(rows) ? rows.length : rows?.affectedRows || 0,
      insertId: rows?.insertId,
    };
  }

  return {
    rows: [],
    rowCount: 0,
  };
};

const convertPlaceholders = (text) => {
  return text
    .replace(/\$\d+/g, "?")
    .replace(/\bILIKE\b/gi, "LIKE")
    .replace(/::(int|float|numeric|text|uuid)\b/gi, "")
    .replace(/\btrue\b/gi, "1")
    .replace(/\bfalse\b/gi, "0");
};

const runQuery = async (connection, text, params = []) => {
  const sql = convertPlaceholders(text);

  try {
    const raw = connection._originalQuery
      ? await connection._originalQuery(sql, params)
      : await connection.query(sql, params);

    return normalizeResult(raw);
  } catch (err) {
    console.error("❌ Database Query Error");
    console.error("SQL:", sql);
    console.error("Params:", params);
    console.error(err);
    throw err;
  }
};

const testConnection = async () => {
  const connection = await pool.getConnection();

  try {
    await connection.ping();
    // console.log("✅ MySQL connected");
    // console.log("DB host:", poolConfig.host);
    // console.log("DB name:", poolConfig.database);
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    throw err;
  } finally {
    connection.release();
  }
};

try {
  // console.log("STEP 5 - Testing database connection");
  await testConnection();
  // console.log("STEP 6 - Database connected successfully");
} catch (err) {
  console.error("❌ Database connection failed");
  console.error(err.stack || err);
  // console.log("⚠️ Continuing startup without DB");
}

// FIX (audit Section 2 / Fix 2): ensure the `stock_deducted` guard column
// exists on `orders`. This column lets verifyPayment() and the
// payment.captured webhook safely race each other without double-deducting
// stock. Uses the same information_schema lookup pattern as
// utils/orderSchema.js, so it's safe to run on every boot regardless of
// which migration tooling (if any) manages the rest of the schema.
const ensureStockDeductedColumn = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders' AND column_name = 'stock_deducted'`,
      [currentDb],
    );

    if (!cols.length) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN stock_deducted TINYINT(1) NOT NULL DEFAULT 0",
      );
      console.log("✅ Added orders.stock_deducted column");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders.stock_deducted column exists:",
      err?.message || err,
    );
  }
};

// FIX (Order Number feature): ensure orders.order_number + the
// order_number_counter table exist. Same idempotent information_schema
// pattern as ensureStockDeductedColumn above — safe to run on every boot.
// Does NOT touch orders.id (UUID), any Razorpay columns, or any FKs.
const ensureOrderNumberSchema = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders' AND column_name = 'order_number'`,
      [currentDb],
    );

    if (!cols.length) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN order_number VARCHAR(30) NULL UNIQUE",
      );
      console.log("✅ Added orders.order_number column");
    }

    const [tables] = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = ? AND table_name = 'order_number_counter'`,
      [currentDb],
    );

    if (!tables.length) {
      await pool.query(`
        CREATE TABLE order_number_counter (
          id            TINYINT      NOT NULL PRIMARY KEY,
          current_value INT          NOT NULL,
          updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                      ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      console.log("✅ Created order_number_counter table");
    }

    await pool.query(
      "INSERT IGNORE INTO order_number_counter (id, current_value) VALUES (1, 100000)",
    );
  } catch (err) {
    console.error(
      "❌ Could not ensure order_number schema exists:",
      err?.message || err,
    );
  }
};

// ── Phase 2: renewal order columns ────────────────────────────────────────────
// is_renewal_order — TINYINT flag that distinguishes renewal fulfillment orders
//   (created by the subscription.charged webhook) from the original first-cycle
//   subscription order.
//
// parent_order_id  — UUID FK pointing to the original (is_renewal_order = 0)
//   subscription order. Used by admin queries to list all renewals belonging to
//   a subscription without relying solely on razorpay_subscription_id.
//
// Both are idempotent: the ALTER is wrapped in an existence check and is safe to
// run on every application boot.
const ensureRenewalOrderColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'
         AND column_name IN ('is_renewal_order', 'parent_order_id')`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));

    if (!existing.has("is_renewal_order")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN is_renewal_order TINYINT(1) NOT NULL DEFAULT 0",
      );
      console.log("✅ Added orders.is_renewal_order column");
    }

    if (!existing.has("parent_order_id")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN parent_order_id VARCHAR(36) NULL DEFAULT NULL",
      );
      console.log("✅ Added orders.parent_order_id column");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure renewal order columns exist:",
      err?.message || err,
    );
  }
};

// FIX: ensure the orders table has the shipping / totals columns expected by
// the checkout and order APIs. This keeps older databases functional without
// requiring a manual SQL migration for each local environment.
const ensureOrderShippingColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));
    const additions = [];

    if (!existing.has("subtotal")) {
      additions.push("ADD COLUMN subtotal DECIMAL(10,2) NULL DEFAULT NULL");
    }
    if (!existing.has("shipping")) {
      additions.push("ADD COLUMN shipping DECIMAL(10,2) NOT NULL DEFAULT 0");
    }
    if (!existing.has("tax")) {
      additions.push("ADD COLUMN tax DECIMAL(10,2) NOT NULL DEFAULT 0");
    }
    if (!existing.has("total")) {
      additions.push("ADD COLUMN total DECIMAL(10,2) NULL DEFAULT NULL");
    }
    if (!existing.has("is_free_shipping")) {
      additions.push(
        "ADD COLUMN is_free_shipping TINYINT(1) NOT NULL DEFAULT 0",
      );
    }
    if (!existing.has("shipping_charge")) {
      additions.push(
        "ADD COLUMN shipping_charge DECIMAL(10,2) NOT NULL DEFAULT 0",
      );
    }
    if (!existing.has("estimated_delivery")) {
      additions.push(
        "ADD COLUMN estimated_delivery VARCHAR(100) NULL DEFAULT NULL",
      );
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE orders ${additions.join(", ")}`);
      console.log("✅ Added missing orders shipping/totals columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders shipping/totals columns exist:",
      err?.message || err,
    );
  }
};

// ── Bulk Order workflow columns ─────────────────────────────────────────────
// bulk_bookings gains payment tracking (Razorpay), quote-approval tracking,
// and an order-creation guard (order_created / created_order_id) so the
// Bulk → Order handoff can be made idempotent and the booking can become
// read-only once an order exists. Same idempotent information_schema
// pattern as the other ensure* helpers above — safe to run on every boot.
const ensureBulkBookingWorkflowColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'bulk_bookings'`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));
    const additions = [];

    if (!existing.has("payment_status")) {
      additions.push(
        "ADD COLUMN payment_status VARCHAR(20) NOT NULL DEFAULT 'pending'",
      );
    }
    if (!existing.has("razorpay_order_id")) {
      additions.push(
        "ADD COLUMN razorpay_order_id VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("razorpay_payment_id")) {
      additions.push(
        "ADD COLUMN razorpay_payment_id VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("razorpay_signature")) {
      additions.push(
        "ADD COLUMN razorpay_signature VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("quote_shared_at")) {
      additions.push("ADD COLUMN quote_shared_at DATETIME NULL DEFAULT NULL");
    }
    if (!existing.has("quote_approved")) {
      additions.push("ADD COLUMN quote_approved TINYINT(1) NOT NULL DEFAULT 0");
    }
    if (!existing.has("quote_approved_at")) {
      additions.push("ADD COLUMN quote_approved_at DATETIME NULL DEFAULT NULL");
    }
    if (!existing.has("payment_link_shared_at")) {
      additions.push(
        "ADD COLUMN payment_link_shared_at DATETIME NULL DEFAULT NULL",
      );
    }
    if (!existing.has("paid_at")) {
      additions.push("ADD COLUMN paid_at DATETIME NULL DEFAULT NULL");
    }
    if (!existing.has("order_created")) {
      additions.push("ADD COLUMN order_created TINYINT(1) NOT NULL DEFAULT 0");
    }
    if (!existing.has("created_order_id")) {
      additions.push("ADD COLUMN created_order_id CHAR(36) NULL DEFAULT NULL");
    }
    // FIX (audit): human-friendly booking reference (e.g. "BB-100001"),
    // referenced by bulkOrderService.getBookingReference() and the payment
    // details response, but never actually added to the schema — every read
    // silently fell back to the raw UUID. Backed by bulk_booking_number_counter
    // below, generated once at booking-creation time (see createBulkBooking).
    if (!existing.has("bulk_booking_number")) {
      additions.push(
        "ADD COLUMN bulk_booking_number VARCHAR(30) NULL DEFAULT NULL UNIQUE",
      );
    }

    // FIX (Magic Checkout for Bulk Orders): structured delivery address,
    // collected at booking-submission time. This is the "default/reference"
    // address per the business flow — it seeds the Razorpay Magic Checkout
    // popup, and is the fallback if the customer never changes the address
    // there. The pre-existing `location` column is untouched and kept for
    // backward compatibility (nothing here removes or repurposes it).
    if (!existing.has("address_line1")) {
      additions.push("ADD COLUMN address_line1 VARCHAR(255) NULL DEFAULT NULL");
    }
    if (!existing.has("address_line2")) {
      additions.push("ADD COLUMN address_line2 VARCHAR(255) NULL DEFAULT NULL");
    }
    if (!existing.has("city")) {
      additions.push("ADD COLUMN city VARCHAR(100) NULL DEFAULT NULL");
    }
    if (!existing.has("state")) {
      additions.push("ADD COLUMN state VARCHAR(100) NULL DEFAULT NULL");
    }
    if (!existing.has("pincode")) {
      additions.push("ADD COLUMN pincode VARCHAR(10) NULL DEFAULT NULL");
    }
    if (!existing.has("country")) {
      additions.push(
        "ADD COLUMN country VARCHAR(56) NOT NULL DEFAULT 'India'",
      );
    }

    // Magic Checkout migration: the Bulk Request form now collects a single
    // free-text "Enquiry Address" field instead of the structured
    // address_line1/city/state/pincode/country fields above (those stay in
    // the schema untouched, purely for existing bookings created before this
    // migration to keep displaying correctly). The FINAL delivery address is
    // now collected by Razorpay Magic Checkout at payment time and written
    // straight onto the created Order's shipping_address_* columns — never
    // onto this row.
    if (!existing.has("enquiry_address")) {
      additions.push("ADD COLUMN enquiry_address TEXT NULL DEFAULT NULL");
    }

    // FIX (Profile "Bulk Orders" tab): bulk_bookings was never linked to the
    // authenticated user who submitted it — only email/mobile/company were
    // stored. Creating a bulk booking already requires login (bulkRoutes.js:
    // `router.post("/", auth, createBulkBooking)`), so req.user.id is always
    // available at creation time; this column is where it gets persisted,
    // letting the Profile page query "my bulk bookings" by user_id instead
    // of trusting a frontend-supplied email/phone.
    if (!existing.has("user_id")) {
      additions.push("ADD COLUMN user_id CHAR(36) NULL DEFAULT NULL");
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE bulk_bookings ${additions.join(", ")}`);
      console.log("✅ Added missing bulk_bookings workflow columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure bulk_bookings workflow columns exist:",
      err?.message || err,
    );
  }
};

// Index + backfill for bulk_bookings.user_id, split out from the column
// addition above since both need the column to already exist and the index
// needs its own idempotency check (information_schema.statistics, not
// .columns). Backfill matches existing NULL rows to a user by email (unique
// on users.email) so bookings made before this column existed still show up
// under "My Bulk Orders" for the account that was logged in when they were
// submitted.
const ensureBulkBookingUserIdIndexAndBackfill = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [idxRows] = await pool.query(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'bulk_bookings'
         AND index_name = 'idx_bulk_bookings_user_id'
       LIMIT 1`,
      [currentDb],
    );

    if (!idxRows.length) {
      await pool.query(
        "CREATE INDEX idx_bulk_bookings_user_id ON bulk_bookings(user_id)",
      );
      console.log("✅ Created idx_bulk_bookings_user_id index");
    }

    const [result] = await pool.query(`
      UPDATE bulk_bookings b
      INNER JOIN users u ON u.email = b.email
      SET b.user_id = u.id
      WHERE b.user_id IS NULL
    `);

    const affected = result?.affectedRows || 0;
    if (affected > 0) {
      console.log(
        `✅ Backfilled user_id for ${affected} legacy bulk booking(s) by email match`,
      );
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure bulk_bookings.user_id index/backfill:",
      err?.message || err,
    );
  }
};

// FIX (audit): counter table for bulk_booking_number, same atomic-counter
// idiom as order_number_counter in ensureOrderNumberSchema above.
const ensureBulkBookingNumberSchema = async () => {
  try {
    const [tables] = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'bulk_booking_number_counter'`,
    );

    if (!tables.length) {
      await pool.query(`
        CREATE TABLE bulk_booking_number_counter (
          id            TINYINT      NOT NULL PRIMARY KEY,
          current_value INT          NOT NULL,
          updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                      ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      console.log("✅ Created bulk_booking_number_counter table");
    }

    await pool.query(
      "INSERT IGNORE INTO bulk_booking_number_counter (id, current_value) VALUES (1, 100000)",
    );
  } catch (err) {
    console.error(
      "❌ Could not ensure bulk_booking_number schema exists:",
      err?.message || err,
    );
  }
};

// Backfills bulk_booking_number for any bulk_bookings rows created before
// that column existed (it's nullable, so legacy rows have NULL). Assigns
// each one a number via the same atomic counter new bookings use, oldest
// first, so admin/customer surfaces never show "no reference" for an old
// booking. Idempotent — only touches rows still NULL, safe on every restart;
// uses a single dedicated connection (like getNextBulkBookingNumber) so
// LAST_INSERT_ID() reads back the value this same session just wrote.
const ensureBulkBookingNumberBackfill = async () => {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query(
      "SELECT id FROM bulk_bookings WHERE bulk_booking_number IS NULL ORDER BY created_at ASC",
    );

    if (!rows.length) return;

    for (const row of rows) {
      await connection.query(
        `UPDATE bulk_booking_number_counter
         SET current_value = LAST_INSERT_ID(current_value + 1)
         WHERE id = 1`,
      );
      const [[{ next_value }]] = await connection.query(
        "SELECT LAST_INSERT_ID() AS next_value",
      );
      await connection.query(
        "UPDATE bulk_bookings SET bulk_booking_number = ? WHERE id = ?",
        [`BB-${next_value}`, row.id],
      );
    }

    console.log(
      `✅ Backfilled bulk_booking_number for ${rows.length} legacy bulk booking(s)`,
    );
  } catch (err) {
    console.error(
      "❌ Could not backfill bulk_bookings.bulk_booking_number:",
      err?.message || err,
    );
  } finally {
    connection.release();
  }
};

// FIX (audit): communication_history was read by the admin UI
// (selectedBooking.communication_history) but no table ever backed it, so
// every notification sent (quote, payment link, confirmation, dispatch) went
// unlogged. This table gives it a real, queryable home.
const ensureBulkBookingCommunicationsTable = async () => {
  try {
    const [tables] = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'bulk_booking_communications'`,
    );

    if (!tables.length) {
      await pool.query(`
        CREATE TABLE bulk_booking_communications (
          id              CHAR(36)     NOT NULL PRIMARY KEY,
          bulk_booking_id CHAR(36)     NOT NULL,
          type            VARCHAR(40)  NOT NULL,
          label           VARCHAR(100) NOT NULL,
          sent_by         VARCHAR(36)  NULL DEFAULT NULL,
          sent_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_bulk_booking_communications_booking (bulk_booking_id)
        )
      `);
      console.log("✅ Created bulk_booking_communications table");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure bulk_booking_communications table exists:",
      err?.message || err,
    );
  }
};

// orders gains is_bulk_order / bulk_booking_id so an order created from the
// Bulk Order workflow is flagged and traceable back to its source booking,
// mirroring the is_renewal_order / parent_order_id pattern above.
//
// FIX (audit): bulk_booking_number / company_name / contact_person were
// already being written by bulkOrderService's INSERT and read by
// admin/orderController's getOrders/getOrder SELECTs, but were never added
// here — every admin Orders list/detail request (bulk AND non-bulk orders
// alike) failed with "Unknown column" until this ran, and Bulk → Order
// creation itself failed the same way. Added alongside the pre-existing two
// so the columns those two statements already depend on actually exist.
const ensureOrderBulkColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'
         AND column_name IN (
           'is_bulk_order', 'bulk_booking_id',
           'bulk_booking_number', 'company_name', 'contact_person'
         )`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));

    if (!existing.has("is_bulk_order")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN is_bulk_order TINYINT(1) NOT NULL DEFAULT 0",
      );
      console.log("✅ Added orders.is_bulk_order column");
    }

    if (!existing.has("bulk_booking_id")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN bulk_booking_id CHAR(36) NULL DEFAULT NULL",
      );
      console.log("✅ Added orders.bulk_booking_id column");
    }

    if (!existing.has("bulk_booking_number")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN bulk_booking_number VARCHAR(30) NULL DEFAULT NULL",
      );
      console.log("✅ Added orders.bulk_booking_number column");
    }

    if (!existing.has("company_name")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN company_name VARCHAR(255) NULL DEFAULT NULL",
      );
      console.log("✅ Added orders.company_name column");
    }

    if (!existing.has("contact_person")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN contact_person VARCHAR(255) NULL DEFAULT NULL",
      );
      console.log("✅ Added orders.contact_person column");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders bulk-order columns exist:",
      err?.message || err,
    );
  }
};

// FIX (Magic Checkout for Bulk Orders): a structured delivery address for
// orders that have no `address_id` and never will — bulk_bookings has no
// user_id, and addresses.user_id is NOT NULL, so a Bulk Order can never get
// a row in the addresses table the way a logged-in customer's order can
// (see upsertStructuredAddressForOrder in paymentController.js, which hits
// the identical NOT NULL wall for guest normal-checkout orders and simply
// skips persisting a structured address for them).
//
// This is the smallest additive change compatible with the existing
// address architecture: six columns holding the FINAL confirmed address
// (Magic Checkout's customer_details.shipping_address when the customer
// changes it during checkout, else the bulk booking's own default address).
// shippingController.createShipment() reads these only as a fallback when
// address_id resolves to nothing — every existing address_id-driven order
// is completely unaffected.
const ensureOrderShippingAddressColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'
         AND column_name IN (
           'shipping_address_line1', 'shipping_address_line2',
           'shipping_city', 'shipping_state', 'shipping_pincode',
           'shipping_country'
         )`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));
    const additions = [];

    if (!existing.has("shipping_address_line1")) {
      additions.push(
        "ADD COLUMN shipping_address_line1 VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("shipping_address_line2")) {
      additions.push(
        "ADD COLUMN shipping_address_line2 VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("shipping_city")) {
      additions.push("ADD COLUMN shipping_city VARCHAR(100) NULL DEFAULT NULL");
    }
    if (!existing.has("shipping_state")) {
      additions.push(
        "ADD COLUMN shipping_state VARCHAR(100) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("shipping_pincode")) {
      additions.push(
        "ADD COLUMN shipping_pincode VARCHAR(10) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("shipping_country")) {
      additions.push(
        "ADD COLUMN shipping_country VARCHAR(56) NULL DEFAULT NULL",
      );
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE orders ${additions.join(", ")}`);
      console.log("✅ Added missing orders shipping-address columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders shipping-address columns exist:",
      err?.message || err,
    );
  }
};

// FIX (Return/Refund audit): controllers/admin/returnController.js has
// always read and written return_status, refund_status, delivered_at, and
// friends — its own header comment claims they're "already present on
// orders". They never were; no migration anywhere ever created them, which
// is why every return/refund endpoint threw "Unknown column" on first use.
// Same idempotent information_schema pattern as every other ensure*()
// helper in this file — safe to run on every boot, no manual migration
// step, nothing existing touched or removed.
const ensureOrderReturnColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));
    const additions = [];

    // The actual delivered timestamp — see ensureDeliveredAtBackfill() below
    // for how existing rows get this populated from order_status_history.
    if (!existing.has("delivered_at")) {
      additions.push("ADD COLUMN delivered_at DATETIME NULL DEFAULT NULL");
      console.log("Will add missing orders.delivered_at column");
    }

    // Return side: return_status values are approved / rejected /
    // reverse_shipment_created / pickup_scheduled / returned. inspection_*
    // is the QC step gating refund eligibility (added new, per requirement
    // 10 — the frontend already expected inspection_status; it just never
    // existed on the backend).
    if (!existing.has("return_status")) {
      additions.push("ADD COLUMN return_status VARCHAR(30) NULL DEFAULT NULL");
      console.log("Will add missing orders.return_status column");
    }
    if (!existing.has("return_reason")) {
      additions.push("ADD COLUMN return_reason TEXT NULL DEFAULT NULL");
    }
    if (!existing.has("return_notes")) {
      additions.push("ADD COLUMN return_notes TEXT NULL DEFAULT NULL");
    }
    if (!existing.has("return_requested_at")) {
      additions.push(
        "ADD COLUMN return_requested_at DATETIME NULL DEFAULT NULL",
      );
    }
    if (!existing.has("return_approved_at")) {
      additions.push(
        "ADD COLUMN return_approved_at DATETIME NULL DEFAULT NULL",
      );
    }
    if (!existing.has("return_approved_by")) {
      additions.push(
        "ADD COLUMN return_approved_by CHAR(36) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("reverse_awb")) {
      additions.push("ADD COLUMN reverse_awb VARCHAR(255) NULL DEFAULT NULL");
    }
    if (!existing.has("reverse_tracking_url")) {
      additions.push("ADD COLUMN reverse_tracking_url TEXT NULL DEFAULT NULL");
    }
    if (!existing.has("reverse_shipment_created_at")) {
      additions.push(
        "ADD COLUMN reverse_shipment_created_at DATETIME NULL DEFAULT NULL",
      );
    }
    if (!existing.has("reverse_pickup_request_id")) {
      additions.push(
        "ADD COLUMN reverse_pickup_request_id VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("returned_at")) {
      additions.push("ADD COLUMN returned_at DATETIME NULL DEFAULT NULL");
    }

    // QC — new. Values: pending / approved / rejected.
    if (!existing.has("inspection_status")) {
      additions.push(
        "ADD COLUMN inspection_status VARCHAR(30) NULL DEFAULT NULL",
      );
      console.log("Will add missing orders.inspection_status column");
    }

    // Refund side: refund_status values are approved / initiated /
    // completed / rejected. refund_reference doubles as the Razorpay
    // refund id once a real refund is created (see completeRefund).
    if (!existing.has("refund_status")) {
      additions.push("ADD COLUMN refund_status VARCHAR(30) NULL DEFAULT NULL");
      console.log("Will add missing orders.refund_status column");
    }
    if (!existing.has("refund_amount")) {
      additions.push(
        "ADD COLUMN refund_amount DECIMAL(10,2) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("refund_reference")) {
      additions.push(
        "ADD COLUMN refund_reference VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("refund_completed_at")) {
      additions.push(
        "ADD COLUMN refund_completed_at DATETIME NULL DEFAULT NULL",
      );
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE orders ${additions.join(", ")}`);
      console.log("✅ Added missing orders return/refund columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders return/refund columns exist:",
      err?.message || err,
    );
  }
};

// FIX (Delhivery shipment audit): the outbound/forward shipment columns
// read and written throughout shippingController.js (createShipment,
// schedulePickup, trackShipment, cancelShipment) and
// cron/shippingTrackingCron.js were never actually added to the `orders`
// table by any migration — only the *reverse* shipment columns (returns,
// see ensureOrderReturnColumns above) exist. Every forward-shipment query
// referencing these columns would fail with "Unknown column" against a
// database built from mysql-schema.sql + the ensure* chain alone. Same
// idempotent information_schema pattern as every other ensure* helper.
const ensureOrderShipmentColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));
    const additions = [];

    if (!existing.has("awb_number")) {
      additions.push("ADD COLUMN awb_number VARCHAR(255) NULL DEFAULT NULL");
      console.log("Will add missing orders.awb_number column");
    }
    if (!existing.has("shipment_id")) {
      additions.push("ADD COLUMN shipment_id VARCHAR(255) NULL DEFAULT NULL");
    }
    if (!existing.has("tracking_number")) {
      additions.push(
        "ADD COLUMN tracking_number VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("tracking_url")) {
      additions.push("ADD COLUMN tracking_url TEXT NULL DEFAULT NULL");
    }
    if (!existing.has("tracking_status")) {
      additions.push(
        "ADD COLUMN tracking_status VARCHAR(100) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("courier_name")) {
      additions.push("ADD COLUMN courier_name VARCHAR(100) NULL DEFAULT NULL");
    }
    if (!existing.has("shipment_created_at")) {
      additions.push(
        "ADD COLUMN shipment_created_at DATETIME NULL DEFAULT NULL",
      );
    }
    if (!existing.has("delhivery_response")) {
      additions.push("ADD COLUMN delhivery_response LONGTEXT NULL DEFAULT NULL");
    }
    if (!existing.has("pickup_request_id")) {
      additions.push(
        "ADD COLUMN pickup_request_id VARCHAR(255) NULL DEFAULT NULL",
      );
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE orders ${additions.join(", ")}`);
      console.log("✅ Added missing orders Delhivery shipment columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders Delhivery shipment columns exist:",
      err?.message || err,
    );
  }
};

// FIX (Return/Refund audit — 48-hour window): backfills delivered_at for
// existing delivered orders that don't have it yet, from the one reliable
// source available: order_status_history.created_at where new_status =
// 'delivered'. Deliberately does NOT touch orders that already have a
// delivered_at (never overwrites a valid value) and deliberately leaves
// delivered_at NULL for delivered orders with no matching history row
// (no order_created_at / shipped_at / NOW() fallback — an order with no
// reliable delivery timestamp must not be treated as automatically
// eligible for return). Runs after ensureOrderReturnColumns so the column
// is guaranteed to exist; idempotent (WHERE delivered_at IS NULL means a
// second run is a no-op).
const ensureDeliveredAtBackfill = async () => {
  try {
    const [result] = await pool.query(`
      UPDATE orders o
      INNER JOIN (
        SELECT h.order_id, MIN(h.created_at) AS first_delivered_at
        FROM order_status_history h
        WHERE h.new_status = 'delivered'
        GROUP BY h.order_id
      ) earliest ON earliest.order_id = o.id
      SET o.delivered_at = earliest.first_delivered_at
      WHERE o.order_status = 'delivered'
        AND o.delivered_at IS NULL
    `);

    const affected = result?.affectedRows || 0;
    if (affected > 0) {
      console.log(
        `✅ Backfilled delivered_at for ${affected} delivered order(s) from order_status_history`,
      );
    }
  } catch (err) {
    console.error(
      "❌ Could not backfill orders.delivered_at:",
      err?.message || err,
    );
  }
};

// FIX (Recurring package fulfillment): products gains an opt-in "recurring
// package" mode, deliberately NOT reusing is_subscription/razorpay_plan_id —
// those trigger Razorpay Plan creation in admin/productController.js and
// mean "bill the customer repeatedly." A package is the opposite: pay once,
// ship N times. package_duration_months is the number of fulfillment cycles
// (kept generically named/typed as an integer count of cycles — not
// hardcoded to 3/6/12). package_fulfillment_interval_days is the gap between
// cycles (default 30, not hardcoded either). Both are NULL/inert for every
// normal product. Idempotent information_schema pattern, safe on every boot.
const ensurePackageProductColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'products'`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));
    const additions = [];

    if (!existing.has("is_recurring_package")) {
      additions.push(
        "ADD COLUMN is_recurring_package TINYINT(1) NOT NULL DEFAULT 0",
      );
    }
    if (!existing.has("package_duration_months")) {
      additions.push(
        "ADD COLUMN package_duration_months INT NULL DEFAULT NULL",
      );
    }
    if (!existing.has("package_fulfillment_interval_days")) {
      additions.push(
        "ADD COLUMN package_fulfillment_interval_days INT NOT NULL DEFAULT 30",
      );
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE products ${additions.join(", ")}`);
      console.log("✅ Added missing products recurring-package columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure products recurring-package columns exist:",
      err?.message || err,
    );
  }
};

// orders gains parent_package_id / fulfillment_cycle so a fulfillment order
// (cycle 2+) is a completely normal `orders` row — same order_number,
// status machine, Delhivery flow, tracking, notifications, admin/customer
// Orders UI, and Task C's 48-hour return window (computed from THIS order's
// own delivered_at) — just tagged with which package it belongs to and
// which cycle it represents. Both are NULL for every non-package order.
// The composite unique index is the hard DB-level idempotency backstop for
// the fulfillment cron (belt-and-suspenders alongside its row lock): InnoDB
// permits unlimited rows with NULL in a unique index, so ordinary orders
// (parent_package_id IS NULL) never collide with each other or with this
// constraint.
const ensurePackageOrderColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));
    const additions = [];

    if (!existing.has("parent_package_id")) {
      additions.push("ADD COLUMN parent_package_id CHAR(36) NULL DEFAULT NULL");
    }
    if (!existing.has("fulfillment_cycle")) {
      additions.push("ADD COLUMN fulfillment_cycle INT NULL DEFAULT NULL");
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE orders ${additions.join(", ")}`);
      console.log("✅ Added missing orders package-fulfillment columns");
    }

    const [idx] = await pool.query(
      `SELECT DISTINCT index_name FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'orders'
         AND index_name = 'uq_orders_package_cycle'`,
      [currentDb],
    );

    if (!idx.length) {
      await pool.query(
        `ALTER TABLE orders
         ADD UNIQUE INDEX uq_orders_package_cycle (parent_package_id, fulfillment_cycle)`,
      );
      console.log("✅ Added orders.uq_orders_package_cycle unique index");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders package-fulfillment columns exist:",
      err?.message || err,
    );
  }
};

// New parent record for a multi-cycle package purchase. Deliberately a new
// table rather than reuse of orders.is_subscription/razorpay_subscription_id
// — those model recurring BILLING (repeated Razorpay charges via
// renewalService.js); a package is paid once and only ever ships repeatedly.
// origin_order_id is the checkout order itself, which doubles as cycle 1 —
// no separate "cycle 1" order is ever created (that would ship box #1
// twice). total_cycles / fulfillment_interval_days are snapshotted from the
// product at purchase time so a later admin edit to the product never
// changes an already-sold package's terms. status is 'active' | 'completed'
// only for now — the column is a free-text VARCHAR specifically so a future
// 'paused' / 'cancelled' state can be added later without a migration
// (cancellation/pausing is explicitly out of scope for this implementation).
const ensurePackagePurchasesTable = async () => {
  try {
    const [tables] = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'package_purchases'`,
    );

    if (!tables.length) {
      await pool.query(`
        CREATE TABLE package_purchases (
          id                          CHAR(36)      NOT NULL PRIMARY KEY,
          package_number              VARCHAR(30)   NULL UNIQUE,
          user_id                     CHAR(36)      NULL,
          product_id                  CHAR(36)      NOT NULL,
          origin_order_id             CHAR(36)      NOT NULL UNIQUE,
          total_cycles                INT           NOT NULL,
          fulfillment_interval_days   INT           NOT NULL,
          cycles_created              INT           NOT NULL DEFAULT 1,
          next_fulfillment_date       DATETIME      NULL DEFAULT NULL,
          status                      VARCHAR(20)   NOT NULL DEFAULT 'active',
          created_at                  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at                  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                     ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_package_purchases_user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT fk_package_purchases_product
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
          CONSTRAINT fk_package_purchases_origin_order
            FOREIGN KEY (origin_order_id) REFERENCES orders(id) ON DELETE CASCADE,
          INDEX idx_package_purchases_status_next (status, next_fulfillment_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log("✅ Created package_purchases table");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure package_purchases table exists:",
      err?.message || err,
    );
  }
};

// Same atomic-counter idiom as order_number_counter / bulk_booking_number_counter.
const ensurePackageNumberSchema = async () => {
  try {
    const [tables] = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'package_number_counter'`,
    );

    if (!tables.length) {
      await pool.query(`
        CREATE TABLE package_number_counter (
          id            TINYINT      NOT NULL PRIMARY KEY,
          current_value INT          NOT NULL,
          updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                      ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      console.log("✅ Created package_number_counter table");
    }

    await pool.query(
      "INSERT IGNORE INTO package_number_counter (id, current_value) VALUES (1, 100000)",
    );
  } catch (err) {
    console.error(
      "❌ Could not ensure package_number schema exists:",
      err?.message || err,
    );
  }
};

// Run startup migrations in a fault-tolerant way: if one fails unexpectedly,
// the remaining migrations still execute instead of the whole chain aborting.
await ensureStockDeductedColumn().catch(console.error);
await ensureOrderNumberSchema().catch(console.error);
await ensureRenewalOrderColumns().catch(console.error);
await ensureOrderShippingColumns().catch(console.error);
await ensureBulkBookingWorkflowColumns().catch(console.error);
await ensureBulkBookingUserIdIndexAndBackfill().catch(console.error);
await ensureBulkBookingNumberSchema().catch(console.error);
await ensureBulkBookingNumberBackfill().catch(console.error);
await ensureBulkBookingCommunicationsTable().catch(console.error);
await ensureOrderBulkColumns().catch(console.error);
await ensureOrderShippingAddressColumns().catch(console.error);
await ensureOrderShipmentColumns().catch(console.error);
await ensureOrderReturnColumns().catch(console.error);
await ensureDeliveredAtBackfill().catch(console.error);
await ensurePackageProductColumns().catch(console.error);
await ensurePackageOrderColumns().catch(console.error);
await ensurePackagePurchasesTable().catch(console.error);
await ensurePackageNumberSchema().catch(console.error);

export const query = async (text, params = []) => {
  return runQuery(pool, text, params);
};

export const getClient = async () => {
  const connection = await pool.getConnection();

  await connection.query("SET time_zone = '+05:30'");

  connection._originalQuery = connection.query.bind(connection);

  connection.query = async (text, params = []) => {
    return runQuery(connection, text, params);
  };

  return connection;
};

export default pool;
