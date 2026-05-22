import dotenv from "dotenv";
dotenv.config();

import pg from "pg";
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: { rejectUnauthorized: false },

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err.message);
});

// Test DB connection
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
    return;
  }

  release();

  console.log("✅ PostgreSQL connected");
});

export const query = (text, params) => pool.query(text, params);

export const getClient = () => pool.connect();

export default pool;
