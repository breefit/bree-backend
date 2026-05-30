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

console.log("STEP 3 - Database file loaded");

import mysql from "mysql2/promise";

console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);

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
      "Database configuration is missing. Provide a valid DATABASE_URL or DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME."
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
    console.log("✅ MySQL connected");
    console.log("DB host:", poolConfig.host);
    console.log("DB name:", poolConfig.database);
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    throw err;
  } finally {
    connection.release();
  }
};

try {
  console.log("STEP 5 - Testing database connection");
  await testConnection();
  console.log("STEP 6 - Database connected successfully");
} catch (err) {
  console.error("❌ Database connection failed");
  console.error(err.stack || err);
  console.log("⚠️ Continuing startup without DB");
}

export const query = async (text, params = []) => {
  return runQuery(pool, text, params);
};

export const getClient = async () => {
  const connection = await pool.getConnection();

  connection._originalQuery = connection.query.bind(connection);

  connection.query = async (text, params = []) => {
    return runQuery(connection, text, params);
  };

  return connection;
};

export default pool;
