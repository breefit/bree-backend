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

const connection = await pool.getConnection();
try {
  // Check if migration 008 has already been applied
  console.log("Checking if migration 008 is already applied...");

  const [existingTableCheck] = await connection.query(
    `SHOW TABLES LIKE 'daily_reminders'`,
  );

  if (existingTableCheck.length > 0) {
    console.log(
      "✅ Migration 008 already applied - daily_reminders table exists",
    );

    // Verify the schema
    console.log("\nVerifying daily_reminders table structure:");
    const [columns] = await connection.query(`DESCRIBE daily_reminders`);
    console.log(`  - Table has ${columns.length} columns`);
    columns.forEach((col) => {
      console.log(`    • ${col.Field} (${col.Type})`);
    });

    // Check products columns
    console.log("\nVerifying products table additions:");
    const [productsCheck] = await connection.query(
      `SHOW COLUMNS FROM products WHERE Field IN ('daily_reminder_enabled', 'daily_reminder_price', 'daily_reminder_original_price')`,
    );

    if (productsCheck.length === 3) {
      console.log("  ✅ All 3 reminder columns exist on products table");
    } else {
      console.log(
        `  ⚠️  Only ${productsCheck.length}/3 reminder columns found on products`,
      );
    }

    console.log("\n✅ Migration 008 verification complete");
    process.exit(0);
  }

  console.log("Migration 008 not yet applied. Applying now...\n");

  const reminderMigrationPath = resolve(
    __dirname,
    "008_add_daily_reminder_feature.sql",
  );
  const reminderMigration = await fs.readFile(reminderMigrationPath, "utf8");

  console.log(`Executing migration from ${reminderMigrationPath}`);
  await connection.query(reminderMigration);

  console.log("✅ Migration 008 applied successfully");

  // Verify
  console.log("\nVerifying migration results:");
  const [dailyRemindersCheck] = await connection.query(
    `SHOW TABLES LIKE 'daily_reminders'`,
  );

  if (dailyRemindersCheck.length > 0) {
    console.log("  ✅ daily_reminders table created");

    const [reminderColumns] = await connection.query(
      `DESCRIBE daily_reminders`,
    );
    console.log(`  ✅ Table has ${reminderColumns.length} columns`);
  }

  const [productsColumnsCheck] = await connection.query(
    `SHOW COLUMNS FROM products WHERE Field IN ('daily_reminder_enabled', 'daily_reminder_price', 'daily_reminder_original_price')`,
  );

  if (productsColumnsCheck.length === 3) {
    console.log("  ✅ 3 reminder columns added to products table");
  }

  const [reminderSendsCheck] = await connection.query(
    `SHOW TABLES LIKE 'daily_reminder_sends'`,
  );

  if (reminderSendsCheck.length > 0) {
    console.log("  ✅ daily_reminder_sends table created");
  }

  console.log("\n✅ Migration 008 complete and verified");
} catch (err) {
  console.error("❌ Migration failed:", err.message);
  console.error("\nFull error details:");
  console.error(err);
  process.exit(1);
} finally {
  connection.release();
  await pool.end();
}
