// import dotenv from "dotenv";
// dotenv.config();

// console.log("STEP 3 - Database file loaded");

// import mysql from "mysql2/promise";

// console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);

// if (!process.env.DATABASE_URL) {
//   throw new Error("DATABASE_URL environment variable is not set");
// }

// const databaseUrl = new URL(process.env.DATABASE_URL);

// if (!["mysql:", "mysql2:"].includes(databaseUrl.protocol)) {
//   throw new Error("DATABASE_URL must use mysql:// or mysql2:// protocol");
// }

// const pool = mysql.createPool({
//   host: databaseUrl.hostname,
//   port: Number(databaseUrl.port || 3306),
//   user: decodeURIComponent(databaseUrl.username),
//   password: decodeURIComponent(databaseUrl.password),
//   database: databaseUrl.pathname.replace(/^\//, ""),
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0,
//   decimalNumbers: true,
//   supportBigNumbers: true,
//   bigNumberStrings: true,
//   charset: "utf8mb4_unicode_ci",
// });

// const normalizeResult = (result) => {
//   if (Array.isArray(result)) {
//     const [rows] = result;

//     return {
//       rows: Array.isArray(rows) ? rows : [],
//       rowCount: Array.isArray(rows) ? rows.length : rows?.affectedRows || 0,
//       insertId: rows?.insertId,
//     };
//   }

//   return {
//     rows: [],
//     rowCount: 0,
//   };
// };

// const convertPlaceholders = (text) => {
//   return text
//     .replace(/\$\d+/g, "?")
//     .replace(/\bILIKE\b/gi, "LIKE")
//     .replace(/::(int|float|numeric|text|uuid)\b/gi, "")
//     .replace(/\btrue\b/gi, "1")
//     .replace(/\bfalse\b/gi, "0");
// };

// const runQuery = async (connection, text, params = []) => {
//   const sql = convertPlaceholders(text);

//   try {
//     const raw = connection._originalQuery
//       ? await connection._originalQuery(sql, params)
//       : await connection.query(sql, params);

//     return normalizeResult(raw);
//   } catch (err) {
//     console.error("❌ Database Query Error");
//     console.error("SQL:", sql);
//     console.error("Params:", params);
//     console.error(err);
//     throw err;
//   }
// };

// const testConnection = async () => {
//   const connection = await pool.getConnection();

//   try {
//     await connection.ping();
//     console.log("✅ MySQL connected");
//   } catch (err) {
//     console.error("❌ Database connection failed:", err.message);
//     throw err;
//   } finally {
//     connection.release();
//   }
// };

// // Startup test
// try {
//   console.log("STEP 5 - Testing database connection");
//   await testConnection();
//   console.log("STEP 6 - Database connected successfully");
// } catch (err) {
//   console.error("❌ Database connection failed");
//   console.error(err.stack || err);

//   // TEMPORARY DEBUGGING
//   console.log("⚠️ Continuing startup without DB");
// }

// export const query = async (text, params = []) => {
//   return runQuery(pool, text, params);
// };

// export const getClient = async () => {
//   const connection = await pool.getConnection();

//   connection._originalQuery = connection.query.bind(connection);

//   connection.query = async (text, params = []) => {
//     return runQuery(connection, text, params);
//   };

//   return connection;
// };

// export default pool;
import dotenv from "dotenv";
dotenv.config();

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

await ensureStockDeductedColumn();

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

await ensureOrderNumberSchema();

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

await ensureRenewalOrderColumns();

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
