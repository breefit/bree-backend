import dotenv from "dotenv";
dotenv.config();

import fs from "fs/promises";
import mysql from "mysql2/promise";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const databaseUrl = new URL(process.env.DATABASE_URL);
if (!["mysql:", "mysql2:"].includes(databaseUrl.protocol)) {
  throw new Error(
    "DATABASE_URL must use mysql:// or mysql2:// protocol for MySQL migration",
  );
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
  multipleStatements: true,
  decimalNumbers: true,
  charset: "utf8mb4_unicode_ci",
});

const schemaPath = resolve(__dirname, "../mysql-schema.sql");
const sql = await fs.readFile(schemaPath, "utf8");

const connection = await pool.getConnection();
try {
  console.log(`Executing MySQL schema from ${schemaPath}`);
  await connection.query(sql);
  console.log("✅ MySQL schema created successfully");
} catch (err) {
  console.error("❌ MySQL schema creation failed:", err.message);
  throw err;
} finally {
  connection.release();
  await pool.end();
}
