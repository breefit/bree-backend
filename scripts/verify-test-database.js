// Preflight for database-dependent tests (npm run test:db).
//
// Connects through src/config/database.js, so testDatabaseGuard.js runs first
// and aborts on anything that could be production. Then asks the server which
// database it actually connected to and refuses unless it matches
// TEST_DATABASE_URL. Prints only the local test database's own host, port and
// name, never production values.

if (process.env.NODE_ENV?.trim() !== "test" || !process.env.TEST_DATABASE_URL?.trim()) {
  console.error("[test-db] Refusing: run with NODE_ENV=test and TEST_DATABASE_URL set (node --env-file=.env.migration-test).");
  process.exit(1);
}

const expected = new URL(process.env.TEST_DATABASE_URL.trim());
const expectedDatabase = expected.pathname.replace(/^\//, "");
const { query, closePool } = await import("../src/config/database.js");

try {
  const { rows } = await query("SELECT DATABASE() AS db, @@port AS port, @@version AS version");
  const [{ db, port, version }] = rows;
  if (db !== expectedDatabase || Number(port) !== Number(expected.port || 3306)) {
    console.error("[test-db] Refusing: connected database does not match TEST_DATABASE_URL.");
    process.exitCode = 1;
  } else {
    const { rows: tables } = await query(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()",
    );
    console.log(
      `[test-db] OK: ${expected.hostname}:${port}/${db} (MySQL ${version}, ${tables[0].count} tables)`,
    );
  }
} catch (error) {
  console.error("[test-db] Could not reach the test database:", error.code || error.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
