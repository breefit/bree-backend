import dotenv from "dotenv";
dotenv.config();

import mysql from "mysql2/promise";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const databaseUrl = new URL(process.env.DATABASE_URL);

if (!["mysql:", "mysql2:"].includes(databaseUrl.protocol)) {
  throw new Error("DATABASE_URL must use mysql:// or mysql2:// protocol");
}

const pool = mysql.createPool({
  host: databaseUrl.hostname,
  port: Number(databaseUrl.port || 3306),
  user: decodeURIComponent(databaseUrl.username),
  password: decodeURIComponent(databaseUrl.password),
  database: databaseUrl.pathname.replace(/^\//, ""),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true,
  namedPlaceholders: false,
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
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    throw err;
  } finally {
    connection.release();
  }
};

await testConnection();

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
