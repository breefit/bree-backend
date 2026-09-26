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

// FIX (ISSUE-007 — test suite could touch the production database): this
// repo has no separate test database — DATABASE_URL is the live production
// connection string (confirmed in docs/audit/BREE_COMPLETE_DEBUG_REPORT.md).
// Under NODE_ENV=test, DATABASE_URL is never read at all — only a distinct
// TEST_DATABASE_URL is trusted for a real connection. If none is configured
// (the default in this repo today), the pool is pointed at an address
// nothing listens on, so any code path that still tries a real query fails
// loudly (ECONNREFUSED) instead of silently reaching production; every
// startup side effect below (the connectivity ping, the schema-migration
// chain) is skipped outright in test mode. Tests that need real query
// behavior use the queryExecutor-injection pattern already established in
// this codebase (see tests/shippingNotifications.test.js) against an
// in-memory fake instead of a live database.
const NODE_ENV = cleanEnv(process.env.NODE_ENV);
export const isTestEnv = NODE_ENV === "test";

const dbHost = cleanEnv(process.env.DB_HOST);
const dbPort = Number(cleanEnv(process.env.DB_PORT) || 3306);
const dbUser = cleanEnv(process.env.DB_USER);
const dbPassword = cleanEnv(process.env.DB_PASSWORD);
const dbName = cleanEnv(process.env.DB_NAME);
const prodDatabaseUrlRaw = cleanEnv(process.env.DATABASE_URL);
const testDatabaseUrlRaw = cleanEnv(process.env.TEST_DATABASE_URL);

if (isTestEnv && testDatabaseUrlRaw && prodDatabaseUrlRaw && testDatabaseUrlRaw === prodDatabaseUrlRaw) {
  // Hard abort, never a warning: TEST_DATABASE_URL must never be allowed to
  // resolve to the same database as production.
  console.error(
    "[FATAL] TEST_DATABASE_URL is identical to the production DATABASE_URL. " +
      "Refusing to run tests against production. Aborting immediately.",
  );
  process.exit(1);
}

let poolConfig;
let databaseUrlRaw = null;

if (isTestEnv) {
  if (testDatabaseUrlRaw) {
    databaseUrlRaw = testDatabaseUrlRaw;
  } else {
    console.warn(
      "[DB] NODE_ENV=test and no TEST_DATABASE_URL is configured — real " +
        "database queries are unavailable in this run. DATABASE_URL " +
        "(production) is never used in test mode. Tests must inject a fake " +
        "queryExecutor; any code path that attempts a real query will fail " +
        "fast instead of reaching production.",
    );
    // Deliberately unreachable: localhost with nothing listening on the
    // MySQL port, so a stray real query fails fast (ECONNREFUSED) rather
    // than silently succeeding against whatever DATABASE_URL happens to be.
    poolConfig = {
      host: "127.0.0.1",
      port: 1,
      user: "test_db_not_configured",
      password: "",
      database: "test_db_not_configured",
    };
  }
} else {
  databaseUrlRaw = prodDatabaseUrlRaw;
}

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

if (!poolConfig && isTestEnv) {
  // Never fall back to the DB_HOST/DB_USER/DB_NAME production vars in test
  // mode either — same unreachable placeholder as the no-TEST_DATABASE_URL
  // case above.
  poolConfig = {
    host: "127.0.0.1",
    port: 1,
    user: "test_db_not_configured",
    password: "",
    database: "test_db_not_configured",
  };
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

// FIX (return timeline dates 5h30 off — mixed-timezone DATETIME writes):
// `timezone: "+05:30"` above only tells mysql2 how to convert JS Date
// values to/from DATETIME strings; it never set the MySQL SESSION
// time_zone. So NOW()/CURRENT_TIMESTAMP in a pooled query() ran in the
// MySQL server's own zone (UTC on the production host), while getClient()
// transaction connections below already ran `SET time_zone = '+05:30'` —
// e.g. delivered_at (written by the tracking cron via query()) held UTC
// wall-clock time while return_approved_at (written in a getClient()
// transaction) held IST, and mysql2 then read BOTH back as +05:30. Every
// new pooled connection now gets the same session zone as getClient(), so
// every server-side NOW() is IST wall-clock, matching how mysql2 already
// reads and writes JS Dates. Per-session only — the MySQL server's global
// time zone is not touched. DATE values written as 'YYYY-MM-DD' strings
// (e.g. daily_reminder_sends.send_date) are unaffected.
pool.on("connection", (connection) => {
  connection.query("SET time_zone = '+05:30'", (error) => {
    if (error) {
      console.error("[DB] Failed to set session time_zone on pooled connection", {
        message: error?.message || String(error),
      });
    }
  });
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

// FIX (live verification — webhook idempotency logging): every query error
// used to be logged at the same "❌ Database Query Error" level, including
// ER_DUP_ENTRY hits that are the EXPECTED, correct outcome of an
// atomic idempotency claim (e.g. webhookIdempotencyService.claimWebhookEvent
// racing UNIQUE(provider, event_id) on purpose — see that file's own
// comment). That made a working idempotency guard look identical in logs to
// a genuine, unhandled database failure.
//
// `isExpectedError` is an opt-in predicate a caller can pass per-query (via
// the 4th arg on query()/connection.query()) to say "this specific error
// shape is a known, handled outcome here, not a bug" — it changes ONLY the
// log level/verbosity for that one call, never the thrown error or any
// retry/rollback/transaction behavior. Every existing call site that
// doesn't pass it keeps today's exact behavior (full "❌ Database Query
// Error" + SQL + params + stack for every failure), so this cannot mask a
// real bug anywhere else in the app — only a call site that explicitly
// opts in for a specific, named error shape gets quieter logging, and only
// when the thrown error actually matches that shape (anything else still
// logs loudly, e.g. a genuine outage hitting that same query).
export const runQuery = async (connection, text, params = [], { isExpectedError } = {}) => {
  const sql = convertPlaceholders(text);

  if (connection._released) {
    const error = new Error("Database connection has already been released");
    error.code = "DB_CONNECTION_RELEASED";
    throw error;
  }

  try {
    const raw = connection._originalQuery
      ? await connection._originalQuery(sql, params)
      : await connection.query(sql, params);

    return normalizeResult(raw);
  } catch (err) {
    if (typeof isExpectedError === "function" && isExpectedError(err)) {
      console.info("[DB] Expected constraint rejection (handled by caller)", {
        sql,
        code: err?.code,
        message: err?.message,
      });
    } else {
      console.error("❌ Database Query Error");
      console.error("SQL:", sql);
      console.error("Params:", params);
      console.error(err);
    }
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

// FIX (ISSUE-007): never probe a real connection at import time in test
// mode — importing this module (transitively, via almost any controller)
// used to ping whatever DATABASE_URL pointed at, which the test suite's own
// in-code comment confirms is production, on every single test run.
if (!isTestEnv) {
  try {
    // console.log("STEP 5 - Testing database connection");
    await testConnection();
    // console.log("STEP 6 - Database connected successfully");
  } catch (err) {
    console.error("❌ Database connection failed");
    console.error(err.stack || err);
    // console.log("⚠️ Continuing startup without DB");
  }
}

// FIX (Order Number feature): ensure orders.order_number + the
// order_number_counter table exist. Uses an idempotent information_schema
// pattern and is safe to run on every boot.
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
      // console.log("✅ Added orders.order_number column");
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
      // console.log("✅ Created order_number_counter table");
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
      // console.log("✅ Added orders.is_renewal_order column");
    }

    if (!existing.has("parent_order_id")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN parent_order_id VARCHAR(36) NULL DEFAULT NULL",
      );
      // console.log("✅ Added orders.parent_order_id column");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure renewal order columns exist:",
      err?.message || err,
    );
  }
};

const ensureSubscriptionEmailNotificationSchema = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_email_notifications (
        notification_key VARCHAR(255) PRIMARY KEY,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_attempt_at DATETIME NULL,
        sent_at DATETIME NULL,
        last_error VARCHAR(1000) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) {
      throw new Error(
        "Cannot verify the orders database for payment uniqueness",
      );
    }

    const [duplicatePayments] = await pool.query(
      `SELECT razorpay_payment_id
       FROM orders
       WHERE razorpay_payment_id IS NOT NULL
       GROUP BY razorpay_payment_id
       HAVING COUNT(*) > 1
       LIMIT 1`,
    );

    if (duplicatePayments.length) {
      throw new Error(
        "Duplicate non-null orders.razorpay_payment_id values exist; resolve legacy duplicates before starting with renewal idempotency enabled",
      );
    }

    const [uniqueIndexes] = await pool.query(
      `SELECT DISTINCT index_name
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND table_name = 'orders'
         AND column_name = 'razorpay_payment_id'
         AND non_unique = 0`,
      [currentDb],
    );

    if (!uniqueIndexes.length) {
      await pool.query(
        `ALTER TABLE orders
         ADD UNIQUE INDEX uq_orders_razorpay_payment_id (razorpay_payment_id)`,
      );
    }
  } catch (err) {
    console.error(
      "CRITICAL: Could not ensure subscription email notification schema:",
      err?.message || String(err),
    );
    throw err;
  }
};

// FIX (Shipped/Out-for-Delivery/Delivered notifications): shipment status
// sync has two entry points that can observe the same transition — the
// 30-min cron (cron/shippingTrackingCron.js) and the admin-triggered manual
// refresh (GET /api/shipping/track/:awb, shippingController.trackShipment)
// — plus webhook-style retries from either. Same idempotency shape as
// ensureSubscriptionEmailNotificationSchema() above: one row per
// (order, status, channel), claimed atomically before sending, so no
// duplicate WhatsApp/email ever goes out no matter how many times the same
// status is observed. See services/orderStatusNotificationService.js.
const ensureOrderStatusNotificationSchema = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_status_notifications (
        notification_key VARCHAR(255) PRIMARY KEY,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_attempt_at DATETIME NULL,
        sent_at DATETIME NULL,
        last_error VARCHAR(1000) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (err) {
    console.error(
      "Could not ensure order_status_notifications schema:",
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
      // console.log("✅ Added missing orders shipping/totals columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders shipping/totals columns exist:",
      err?.message || err,
    );
  }
};

const ensureDailyReminderPhoneColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'daily_reminders'`,
      [currentDb],
    );

    const existing = new Set(cols.map((c) => c.column_name));
    const additions = [];

    if (!existing.has("reminder_whatsapp_number")) {
      additions.push(
        "ADD COLUMN reminder_whatsapp_number VARCHAR(20) NULL DEFAULT NULL",
      );
    }
    if (!existing.has("reminder_phone_source")) {
      additions.push(
        "ADD COLUMN reminder_phone_source VARCHAR(20) NOT NULL DEFAULT 'profile'",
      );
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE daily_reminders ${additions.join(", ")}`);
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure daily reminder phone columns exist:",
      err?.message || err,
    );
  }
};

// FIX (Daily Reminder purchase → persistence gap): daily_reminders is
// designed as one row per (order, product) — createOrder and
// createSubscription both create it at most once per (order_id,
// product_id), and verifyPayment's fallback only creates one when that
// exact pair doesn't already exist. This adds a DB-level guarantee of that
// invariant (defense-in-depth against a future code path accidentally
// double-inserting), the same idempotent information_schema pattern as
// every other ensure*() helper in this file. Best-effort / non-fatal: if
// historical duplicate rows already exist, this logs and skips rather than
// crashing startup — cleaning those up, if ever needed, is a separate,
// deliberate action, not something this should do automatically.
export const ensureDailyReminderOrderProductUnique = async ({
  queryFn = pool.query.bind(pool),
} = {}) => {
  try {
    const [dbRows] = await queryFn("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [uniqueIndexes] = await queryFn(
      `SELECT DISTINCT index_name
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND table_name = 'daily_reminders'
         AND index_name = 'uq_daily_reminders_order_product'`,
      [currentDb],
    );
    if (uniqueIndexes.length) return;

    const [duplicates] = await queryFn(
      `SELECT order_id, product_id, COUNT(*) AS occurrences
       FROM daily_reminders
       GROUP BY order_id, product_id
       HAVING COUNT(*) > 1`,
    );
    if (duplicates.length) {
      // FIX (Medium #24 — Phase 3): this used to be a one-line
      // console.warn with no further detail, repeated identically on every
      // restart forever with no escalation — easy to lose in normal log
      // volume, and gave an operator nothing to act on beyond "some
      // duplicate exists somewhere." Escalated to console.error (more
      // likely to be surfaced by log-level-based alerting) and now reports
      // exactly how many duplicate groups exist and their ids, so the
      // (still deliberately non-destructive — no automatic cleanup) skip
      // is at least immediately actionable.
      console.error(
        `❌ daily_reminders has ${duplicates.length} duplicate (order_id, product_id) group(s) — skipping the uq_daily_reminders_order_product unique index. Investigate and clean up before adding it manually.`,
        { duplicateGroups: duplicates.slice(0, 20) },
      );
      return;
    }

    await queryFn(
      `ALTER TABLE daily_reminders
       ADD UNIQUE INDEX uq_daily_reminders_order_product (order_id, product_id)`,
    );
  } catch (err) {
    console.error(
      "❌ Could not ensure daily_reminders (order_id, product_id) unique index:",
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
    // FIX (Medium #9 — Phase 3): nothing ever bounded how long an approved
    // quote stays payable at its frozen quote_price — a months-old quote
    // was payable indefinitely at a stale price. Set alongside
    // quote_shared_at whenever a quote is (re-)shared (see bulkController.js
    // updateBulkBooking's isSharingQuote block) and enforced in
    // ensureBulkRazorpayOrder before a new Razorpay order can be created.
    if (!existing.has("quote_expires_at")) {
      additions.push("ADD COLUMN quote_expires_at DATETIME NULL DEFAULT NULL");
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
      additions.push("ADD COLUMN country VARCHAR(56) NOT NULL DEFAULT 'India'");
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
      // console.log("✅ Added missing bulk_bookings workflow columns");
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
      // console.log("✅ Created idx_bulk_bookings_user_id index");
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
      // console.log("✅ Created bulk_booking_number_counter table");
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
      // console.log("✅ Created bulk_booking_communications table");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure bulk_booking_communications table exists:",
      err?.message || err,
    );
  }
};

// FIX (Phase 3B — Medium #5): Razorpay webhook event-id idempotency
// ledger. See services/webhookIdempotencyService.js for the full claim/
// complete/fail state machine and the reasoning behind deriving the
// idempotency key from a hash of the raw webhook body (Razorpay does not
// provide a dedicated event/delivery id). UNIQUE(provider, event_id) is
// the atomic-claim backstop — safe across multiple backend
// instances/processes, since it's enforced by MySQL itself, not by any
// in-process state. No webhook payload contents or secrets are stored
// here — only the event type, a derived id, and a short (truncated) error
// message on failure.
const ensureWebhookEventsTable = async () => {
  try {
    const [tables] = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'webhook_events'`,
    );

    if (!tables.length) {
      await pool.query(`
        CREATE TABLE webhook_events (
          id             CHAR(36)     NOT NULL PRIMARY KEY,
          provider       VARCHAR(20)  NOT NULL,
          event_id       VARCHAR(64)  NOT NULL,
          event_type     VARCHAR(100) NOT NULL,
          status         VARCHAR(20)  NOT NULL DEFAULT 'processing',
          error_message  VARCHAR(1000) NULL DEFAULT NULL,
          created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          processed_at   DATETIME     NULL DEFAULT NULL,
          UNIQUE KEY uq_webhook_events_provider_event_id (provider, event_id)
        )
      `);
      // console.log("✅ Created webhook_events table");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure webhook_events table exists:",
      err?.message || err,
    );
  }
};

// FIX (Phase 3B — Medium #6): checkout double-submit / duplicate-order
// protection. See services/checkoutIdempotencyService.js for the full
// claim/complete/fail state machine and the reasoning behind the
// idempotency key. UNIQUE(idempotency_key) is the atomic-claim backstop —
// safe across multiple backend instances/processes/PM2 workers, enforced
// by MySQL itself.
const ensureCheckoutIdempotencyTable = async () => {
  try {
    const [tables] = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'checkout_idempotency'`,
    );

    if (!tables.length) {
      await pool.query(`
        CREATE TABLE checkout_idempotency (
          id               CHAR(36)      NOT NULL PRIMARY KEY,
          idempotency_key  VARCHAR(100)  NOT NULL,
          user_id          CHAR(36)      NULL DEFAULT NULL,
          status           VARCHAR(20)   NOT NULL DEFAULT 'processing',
          order_id         CHAR(36)      NULL DEFAULT NULL,
          razorpay_order_id VARCHAR(255) NULL DEFAULT NULL,
          error_message    VARCHAR(1000) NULL DEFAULT NULL,
          created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_checkout_idempotency_key (idempotency_key)
        )
      `);
      // console.log("✅ Created checkout_idempotency table");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure checkout_idempotency table exists:",
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
export const ensureOrderBulkColumns = async () => {
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
      // console.log("✅ Added orders.is_bulk_order column");
    }

    if (!existing.has("bulk_booking_id")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN bulk_booking_id CHAR(36) NULL DEFAULT NULL",
      );
      // console.log("✅ Added orders.bulk_booking_id column");
    }

    if (!existing.has("bulk_booking_number")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN bulk_booking_number VARCHAR(30) NULL DEFAULT NULL",
      );
      // console.log("✅ Added orders.bulk_booking_number column");
    }

    if (!existing.has("company_name")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN company_name VARCHAR(255) NULL DEFAULT NULL",
      );
      // console.log("✅ Added orders.company_name column");
    }

    if (!existing.has("contact_person")) {
      await pool.query(
        "ALTER TABLE orders ADD COLUMN contact_person VARCHAR(255) NULL DEFAULT NULL",
      );
      // console.log("✅ Added orders.contact_person column");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders bulk-order columns exist:",
      err?.message || err,
    );
  }
};

// FIX (Profile → Orders visibility bug): backfills orders.user_id for any
// historical bulk or subscription-renewal orders that ended up with it NULL
// — bulk orders because bulkOrderService.js's INSERT hardcoded user_id to
// NULL until this fix (bulk_bookings.user_id itself was only added once
// booking creation required login), and, defensively, any renewal order
// whose origin order was somehow missing user_id too. Both backfills use an
// existing, proper foreign key — bulk_booking_id -> bulk_bookings.user_id,
// and parent_order_id -> the origin order's own user_id — never an email
// match, since a real FK relationship already exists in both cases. Only
// touches rows still NULL; idempotent and safe to run on every restart.
const ensureOrderUserIdBackfill = async () => {
  try {
    const [bulkResult] = await pool.query(`
      UPDATE orders o
      INNER JOIN bulk_bookings b ON b.id = o.bulk_booking_id
      SET o.user_id = b.user_id
      WHERE o.is_bulk_order = 1
        AND o.user_id IS NULL
        AND b.user_id IS NOT NULL
    `);
    const bulkAffected = bulkResult?.affectedRows || 0;
    if (bulkAffected > 0) {
      console.log(
        `✅ Backfilled user_id for ${bulkAffected} bulk order(s) via bulk_booking_id`,
      );
    }

    const [renewalResult] = await pool.query(`
      UPDATE orders o
      INNER JOIN orders origin ON origin.id = o.parent_order_id
      SET o.user_id = origin.user_id
      WHERE o.is_renewal_order = 1
        AND o.user_id IS NULL
        AND origin.user_id IS NOT NULL
    `);
    const renewalAffected = renewalResult?.affectedRows || 0;
    if (renewalAffected > 0) {
      console.log(
        `✅ Backfilled user_id for ${renewalAffected} subscription renewal order(s) via parent_order_id`,
      );
    }

    // Any orders still NULL after both backfills have no resolvable FK
    // (bulk_booking_id/parent_order_id itself missing, or pointing at a row
    // that also has no user_id) — logged for visibility, not auto-fixed.
    // Guessing a customer via email here would risk attaching an order to
    // the wrong account, so these are left for manual admin review.
    const [[{ remaining }]] = await pool.query(`
      SELECT COUNT(*) AS remaining
      FROM orders
      WHERE user_id IS NULL AND (is_bulk_order = 1 OR is_renewal_order = 1)
    `);
    if (remaining > 0) {
      console.warn(
        `⚠️ ${remaining} bulk/renewal order(s) still have no resolvable user_id — no proper FK to backfill from; needs manual review, not auto-migrated`,
      );
    }
  } catch (err) {
    console.error(
      "❌ Could not backfill orders.user_id for bulk/renewal orders:",
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
export const ensureOrderShippingAddressColumns = async () => {
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
      // console.log("✅ Added missing orders shipping-address columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders shipping-address columns exist:",
      err?.message || err,
    );
  }
};

// Normal paid orders use these timestamps to claim each customer confirmation
// channel exactly once across frontend verification and Razorpay webhook races.
const ensureOrderConfirmationNotificationColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'
         AND column_name IN (
           'order_confirmation_email_sent_at',
           'order_confirmation_whatsapp_sent_at'
         )`,
      [currentDb],
    );

    const existing = new Set(cols.map((column) => column.column_name));
    const additions = [];
    if (!existing.has("order_confirmation_email_sent_at")) {
      additions.push(
        "ADD COLUMN order_confirmation_email_sent_at DATETIME NULL DEFAULT NULL",
      );
    }
    if (!existing.has("order_confirmation_whatsapp_sent_at")) {
      additions.push(
        "ADD COLUMN order_confirmation_whatsapp_sent_at DATETIME NULL DEFAULT NULL",
      );
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE orders ${additions.join(", ")}`);
    }
  } catch (err) {
    console.error(
      "Could not ensure order confirmation notification columns exist:",
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
export const ensureOrderReturnColumns = async () => {
  try {
    const [dbRows] = await pool.query("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'orders'`,
      [currentDb],
    );

    // MySQL 8+ returns an unaliased information_schema column as
    // COLUMN_NAME; without the alias above, `existing` came back empty there,
    // every column was re-added, and the whole ALTER failed with "Duplicate
    // column" — so no new column could ever be added on MySQL 8+.
    const existing = new Set(cols.map((c) => c.column_name ?? c.COLUMN_NAME));
    const additions = [];

    // The actual delivered timestamp — see ensureDeliveredAtBackfill() below
    // for how existing rows get this populated from order_status_history.
    if (!existing.has("delivered_at")) {
      additions.push("ADD COLUMN delivered_at DATETIME NULL DEFAULT NULL");
      // console.log("Will add missing orders.delivered_at column");
    }

    // Return side: return_status values are approved / rejected /
    // reverse_shipment_created / pickup_scheduled / returned. inspection_*
    // is the QC step gating refund eligibility (added new, per requirement
    // 10 — the frontend already expected inspection_status; it just never
    // existed on the backend).
    if (!existing.has("return_status")) {
      additions.push("ADD COLUMN return_status VARCHAR(30) NULL DEFAULT NULL");
      // console.log("Will add missing orders.return_status column");
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
      // console.log("Will add missing orders.inspection_status column");
    }

    // Refund side: refund_status values are approved / initiated /
    // completed / rejected. refund_reference doubles as the Razorpay
    // refund id once a real refund is created (see completeRefund).
    if (!existing.has("refund_status")) {
      additions.push("ADD COLUMN refund_status VARCHAR(30) NULL DEFAULT NULL");
      // console.log("Will add missing orders.refund_status column");
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

    // FIX (return timeline not synchronized with Delhivery): reverse
    // shipment tracking state, kept entirely separate from the forward
    // shipment's tracking_status / delhivery_response / order_status — see
    // services/reverseShipmentTracking.js. reverse_shipment_type is 'rvp'
    // only for shipments created with Delhivery's documented reverse-pickup
    // contract (payment_mode "Pickup"); NULL = legacy return shipment
    // created before that fix (a forward Prepaid shipment), whose tracking
    // is recorded but never allowed to drive return_status.
    const reverseTrackingColumns = [
      ["reverse_shipment_type", "VARCHAR(20) NULL DEFAULT NULL"],
      ["reverse_shipment_reference", "VARCHAR(100) NULL DEFAULT NULL"],
      ["reverse_tracking_status", "VARCHAR(40) NULL DEFAULT NULL"],
      ["reverse_tracking_raw_status", "VARCHAR(120) NULL DEFAULT NULL"],
      ["reverse_tracking_updated_at", "DATETIME NULL DEFAULT NULL"],
      ["reverse_pickup_scheduled_at", "DATETIME NULL DEFAULT NULL"],
      ["reverse_picked_up_at", "DATETIME NULL DEFAULT NULL"],
      ["reverse_delivered_at", "DATETIME NULL DEFAULT NULL"],
      ["reverse_delhivery_response", "LONGTEXT NULL DEFAULT NULL"],
      ["reverse_tracking_failure_count", "INT NOT NULL DEFAULT 0"],
      // 'delhivery' (DL/DTO reported) | 'manual_override' (admin, with reason)
      ["returned_source", "VARCHAR(30) NULL DEFAULT NULL"],
      ["inspection_completed_at", "DATETIME NULL DEFAULT NULL"],
      ["refund_approved_at", "DATETIME NULL DEFAULT NULL"],
    ];
    for (const [column, definition] of reverseTrackingColumns) {
      if (!existing.has(column)) {
        additions.push(`ADD COLUMN ${column} ${definition}`);
      }
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE orders ${additions.join(", ")}`);
      // console.log("✅ Added missing orders return/refund columns");
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
export const ensureOrderShipmentColumns = async () => {
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
      // console.log("Will add missing orders.awb_number column");
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
      additions.push(
        "ADD COLUMN delhivery_response LONGTEXT NULL DEFAULT NULL",
      );
    }
    if (!existing.has("pickup_request_id")) {
      additions.push(
        "ADD COLUMN pickup_request_id VARCHAR(255) NULL DEFAULT NULL",
      );
    }
    // FIX (Medium #17 — Phase 3): a persistently-failing Delhivery tracking
    // API call for a given order was only ever console.error'd, retried
    // silently on the next 30-minute tick, indefinitely — no counter, no
    // escalation. cron/shippingTrackingCron.js increments
    // tracking_sync_failure_count on each failure, resets it to 0 on the
    // next success, and logs a distinct high-visibility alert once an
    // order crosses a consecutive-failure threshold.
    if (!existing.has("tracking_sync_failure_count")) {
      additions.push(
        "ADD COLUMN tracking_sync_failure_count INT NOT NULL DEFAULT 0",
      );
    }
    if (!existing.has("tracking_sync_last_failure_at")) {
      additions.push(
        "ADD COLUMN tracking_sync_last_failure_at DATETIME NULL DEFAULT NULL",
      );
    }

    if (additions.length) {
      await pool.query(`ALTER TABLE orders ${additions.join(", ")}`);
      // console.log("✅ Added missing orders Delhivery shipment columns");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure orders Delhivery shipment columns exist:",
      err?.message || err,
    );
  }
};

// FIX (Medium #25 — Phase 3): cron/shippingTrackingCron.js's 30-minute tick
// and the manual GET /api/shipping/track/:awb endpoint both filter directly
// on awb_number/tracking_status, but no index ever covered either column —
// both columns were added by ensureOrderShipmentColumns above via a plain
// ALTER TABLE with no accompanying index, so every one of those lookups was
// a full table scan. Same idempotent information_schema.statistics pattern
// as ensureBulkBookingUserIdIndexAndBackfill above. queryFn defaults to the
// real pool so production behavior is unchanged; tests inject a fake.
export const ensureOrderShipmentTrackingIndex = async ({
  queryFn = pool.query.bind(pool),
} = {}) => {
  try {
    const [dbRows] = await queryFn("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [idxRows] = await queryFn(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'orders'
         AND index_name = 'idx_orders_awb_tracking_status'
       LIMIT 1`,
      [currentDb],
    );

    if (!idxRows.length) {
      await queryFn(
        "CREATE INDEX idx_orders_awb_tracking_status ON orders(awb_number, tracking_status)",
      );
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure idx_orders_awb_tracking_status index exists:",
      err?.message || err,
    );
  }
};

// FIX (Medium #26 — Phase 3): auth (OTP/phone lookup) and payment code both
// do direct WHERE phone = ? lookups against users, with no index covering
// that column — every one of those was a full table scan. Same pattern as
// above.
export const ensureUsersPhoneIndex = async ({
  queryFn = pool.query.bind(pool),
} = {}) => {
  try {
    const [dbRows] = await queryFn("SELECT DATABASE() AS db");
    const currentDb = dbRows?.[0]?.db;
    if (!currentDb) return;

    const [idxRows] = await queryFn(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'users'
         AND index_name = 'idx_users_phone'
       LIMIT 1`,
      [currentDb],
    );

    if (!idxRows.length) {
      // Non-unique: phone is not guaranteed unique on this table (unlike
      // email/customer_number, which already have their own unique
      // indexes) — this is purely a lookup-speed index.
      await queryFn("CREATE INDEX idx_users_phone ON users(phone)");
    }
  } catch (err) {
    console.error(
      "❌ Could not ensure idx_users_phone index exists:",
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
export const ensurePackageProductColumns = async () => {
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
      // console.log("✅ Added missing products recurring-package columns");
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
export const ensurePackageOrderColumns = async () => {
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
      // console.log("✅ Added missing orders package-fulfillment columns");
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
      // console.log("✅ Added orders.uq_orders_package_cycle unique index");
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
      // console.log("✅ Created package_purchases table");
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
      // console.log("✅ Created package_number_counter table");
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

// FIX (ISSUE-007): the entire startup-migration chain used to run
// unconditionally on import — every test file that transitively imports
// this module (nearly all of them, via any controller) ran ~20 real
// ALTER TABLE/CREATE TABLE IF NOT EXISTS statements against DATABASE_URL,
// which is production. Skipped outright in test mode; a dedicated
// TEST_DATABASE_URL (see above) is expected to already have the schema it
// needs, or to be migrated deliberately/out-of-band, never as a side effect
// of `npm test`.
if (!isTestEnv) {
  // Run startup migrations in a fault-tolerant way: if one fails
  // unexpectedly, the remaining migrations still execute instead of the
  // whole chain aborting.
  await ensureOrderNumberSchema().catch(console.error);
  await ensureRenewalOrderColumns().catch(console.error);
  await ensureSubscriptionEmailNotificationSchema();
  await ensureOrderStatusNotificationSchema();
  await ensureOrderShippingColumns().catch(console.error);
  await ensureDailyReminderPhoneColumns().catch(console.error);
  await ensureDailyReminderOrderProductUnique().catch(console.error);
  await ensureBulkBookingWorkflowColumns().catch(console.error);
  await ensureBulkBookingUserIdIndexAndBackfill().catch(console.error);
  await ensureBulkBookingNumberSchema().catch(console.error);
  await ensureBulkBookingNumberBackfill().catch(console.error);
  await ensureBulkBookingCommunicationsTable().catch(console.error);
  await ensureOrderBulkColumns().catch(console.error);
  await ensureOrderUserIdBackfill().catch(console.error);
  await ensureOrderShippingAddressColumns().catch(console.error);
  await ensureOrderConfirmationNotificationColumns().catch(console.error);
  await ensureOrderShipmentColumns().catch(console.error);
  await ensureOrderShipmentTrackingIndex().catch(console.error);
  await ensureUsersPhoneIndex().catch(console.error);
  await ensureOrderReturnColumns().catch(console.error);
  await ensureDeliveredAtBackfill().catch(console.error);
  await ensurePackageProductColumns().catch(console.error);
  await ensurePackageOrderColumns().catch(console.error);
  await ensurePackagePurchasesTable().catch(console.error);
  await ensurePackageNumberSchema().catch(console.error);
  await ensureWebhookEventsTable().catch(console.error);
  await ensureCheckoutIdempotencyTable().catch(console.error);
}

export const query = async (text, params = [], options = {}) => {
  return runQuery(pool, text, params, options);
};

// FIX (ISSUE-007 — process hangs instead of exiting): pool.end() was never
// called anywhere in the repo, so any process that created this pool kept
// its idle MySQL sockets open forever, consistent with the audit's
// observation that `npm test` never exited on its own. Test files that
// actually open the pool (i.e. import app.js) call this in an `after()`
// hook so the test process can exit cleanly.
export const closePool = () => pool.end();

export const getClient = async () => {
  const connection = await pool.getConnection();
  console.info("[DB] transaction connection acquired");

  try {
    await connection.ping();
    await connection.query("SET time_zone = '+05:30'");
  } catch (error) {
    connection.destroy();
    console.error("[DB] transaction connection health check failed", {
      message: error?.message || String(error),
    });
    throw error;
  }

  connection._originalQuery = connection.query.bind(connection);
  connection._released = false;
  const originalRelease = connection.release.bind(connection);
  connection.release = () => {
    if (connection._released) return;
    connection._released = true;
    originalRelease();
  };

  connection.query = async (text, params = [], options = {}) => {
    return runQuery(connection, text, params, options);
  };

  return connection;
};

export default pool;
