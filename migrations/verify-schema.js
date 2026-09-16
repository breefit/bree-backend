#!/usr/bin/env node
/**
 * ISSUE-016 — schema fragmentation verification tool.
 *
 * mysql-schema.sql + migrations/*.sql do not fully describe the schema
 * this app actually runs against — 23 `ensure*()` functions in
 * src/config/database.js add columns/tables/indexes on every server boot
 * (see docs/SCHEMA_MIGRATIONS.md for the full inventory). This script
 * compares two REAL databases' actual information_schema (tables,
 * columns, indexes) and prints a diff, so drift between "what
 * mysql-schema.sql says" and "what's actually running" can be measured
 * instead of assumed.
 *
 * This does NOT run automatically and is not run by any fix against
 * anything — it is a tool for the team to run deliberately, against a
 * fresh database and a staging/production schema SNAPSHOT (never the live
 * database itself).
 *
 * Usage:
 *   node migrations/verify-schema.js \
 *     --baseline "mysql://user:pass@host:3306/bree_fresh" \
 *     --target   "mysql://user:pass@host:3306/bree_staging_snapshot"
 *
 * Exit code 0 if no differences found, 1 if differences were printed, 2 on
 * a connection/usage error.
 */

import mysql from "mysql2/promise";

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--baseline") args.baseline = argv[++i];
    else if (argv[i] === "--target") args.target = argv[++i];
  }
  return args;
};

const connect = async (databaseUrlRaw, label) => {
  if (!databaseUrlRaw) {
    throw new Error(`Missing --${label} <mysql connection url>`);
  }
  const url = new URL(databaseUrlRaw);
  if (!["mysql:", "mysql2:"].includes(url.protocol)) {
    throw new Error(`--${label} must be a mysql:// URL`);
  }
  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  });
  return { connection, databaseName: url.pathname.replace(/^\//, "") };
};

const fetchColumns = async (connection, databaseName) => {
  const [rows] = await connection.query(
    `SELECT table_name, column_name, column_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = ?
     ORDER BY table_name, column_name`,
    [databaseName],
  );
  const map = new Map();
  for (const row of rows) {
    const key = `${row.table_name}.${row.column_name}`;
    map.set(key, {
      type: row.column_type,
      nullable: row.is_nullable,
      default: row.column_default,
    });
  }
  return map;
};

const fetchIndexes = async (connection, databaseName) => {
  const [rows] = await connection.query(
    `SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
     FROM information_schema.statistics
     WHERE table_schema = ?
     GROUP BY table_name, index_name
     ORDER BY table_name, index_name`,
    [databaseName],
  );
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.table_name}.${row.index_name}`, row.columns);
  }
  return map;
};

const diffMaps = (baselineMap, targetMap, describe) => {
  const differences = [];
  for (const [key, baselineValue] of baselineMap) {
    if (!targetMap.has(key)) {
      differences.push(`MISSING in target: ${describe(key, baselineValue)}`);
    }
  }
  for (const [key, targetValue] of targetMap) {
    if (!baselineMap.has(key)) {
      differences.push(`EXTRA in target (not in a fresh baseline): ${describe(key, targetValue)}`);
    }
  }
  return differences;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  let baselineConn;
  let targetConn;
  try {
    const baseline = await connect(args.baseline, "baseline");
    const target = await connect(args.target, "target");
    baselineConn = baseline.connection;
    targetConn = target.connection;

    const [baselineColumns, targetColumns, baselineIndexes, targetIndexes] =
      await Promise.all([
        fetchColumns(baselineConn, baseline.databaseName),
        fetchColumns(targetConn, target.databaseName),
        fetchIndexes(baselineConn, baseline.databaseName),
        fetchIndexes(targetConn, target.databaseName),
      ]);

    const columnDiffs = diffMaps(
      baselineColumns,
      targetColumns,
      (key, value) => `${key} (${value.type}, nullable=${value.nullable}, default=${value.default})`,
    );
    const indexDiffs = diffMaps(
      baselineIndexes,
      targetIndexes,
      (key, value) => `${key} (${value})`,
    );

    const allDiffs = [...columnDiffs, ...indexDiffs];

    if (allDiffs.length === 0) {
      console.log("✅ No schema differences found between baseline and target.");
      process.exitCode = 0;
      return;
    }

    console.log(`⚠️  ${allDiffs.length} schema difference(s) found:\n`);
    for (const line of allDiffs) {
      console.log(`  - ${line}`);
    }
    process.exitCode = 1;
  } catch (err) {
    console.error("❌ verify-schema failed:", err.message);
    process.exitCode = 2;
  } finally {
    await baselineConn?.end();
    await targetConn?.end();
  }
};

main();
