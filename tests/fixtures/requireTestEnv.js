// Must be the FIRST import of every database-dependent test file and fixture.
// ESM evaluates imports in source order, so this runs before anything that can
// load src/config/database.js. Without NODE_ENV=test, database.js would use the
// production DATABASE_URL (the real .env sets NODE_ENV=development), and these
// tests run unscoped `DELETE FROM users` / `DELETE FROM orders`.
if (process.env.NODE_ENV?.trim() !== "test") {
  console.error(
    '[FATAL] Database-dependent tests require NODE_ENV=test (use "npm test" or ' +
      '"npm run test:db"). Aborting before any database module is loaded.',
  );
  process.exit(1);
}
