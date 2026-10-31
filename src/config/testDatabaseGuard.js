// Strict test-database guard (Node 26 migration — local DB isolation).
//
// The DB-backed tests run unscoped deletes (e.g. `DELETE FROM users`,
// `DELETE FROM orders`), so a TEST_DATABASE_URL that resolves to production
// in any way would wipe live data. The previous check only refused a
// TEST_DATABASE_URL byte-identical to DATABASE_URL; the same production
// database reached with a different user, password, port or through an SSH
// tunnel on localhost slipped through. This guard refuses unless the test
// database is on a loopback host, has "test" in its name, and does not share
// a database name or host/port/database with any production configuration.
//
// Error messages name the rule that failed, never a host, user, password or
// database name, so a refusal can be logged without exposing credentials.

import path from "path";

/**
 * True when this process is running a test: a `node --test` child
 * (NODE_TEST_CONTEXT), `node --test --test-isolation=none` (--test in
 * execArgv), or a test file run directly with `node tests/x.test.js`
 * (entry script inside tests/).
 */
export const isTestRunnerProcess = ({ env, execArgv, entryScript, testsDir }) =>
  Boolean(env.NODE_TEST_CONTEXT) ||
  execArgv.includes("--test") ||
  (Boolean(entryScript) && path.resolve(entryScript).startsWith(testsDir + path.sep));

/**
 * Outside NODE_ENV=test, database.js uses the production DATABASE_URL and runs
 * the startup schema chain (ALTER/CREATE TABLE) on import. The real .env sets
 * NODE_ENV=development, so a test file run without NODE_ENV=test — or a
 * TEST_DATABASE_URL meant for a test database — would otherwise reach
 * production, where the DB tests run unscoped `DELETE FROM users`.
 */
export const assertSafeDatabaseMode = ({ isTestEnv, testDatabaseUrl, underTestRunner }) => {
  if (isTestEnv) return;
  if (testDatabaseUrl?.trim()) {
    throw new Error('TEST_DATABASE_URL is set but NODE_ENV is not "test".');
  }
  if (underTestRunner) {
    throw new Error('A test is running without NODE_ENV=test (use "npm test" or "npm run test:db").');
  }
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const parseMysqlUrl = (raw) => {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["mysql:", "mysql2:"].includes(url.protocol)) return null;
    return {
      host: url.hostname.toLowerCase(),
      port: Number(url.port || 3306),
      database: url.pathname.replace(/^\//, "").toLowerCase(),
    };
  } catch {
    return null;
  }
};

/**
 * @param {object} options
 * @param {string} options.testDatabaseUrl  TEST_DATABASE_URL
 * @param {Array<{ databaseUrl?: string, dbHost?: string, dbPort?: string|number, dbName?: string }>} options.productionConfigs
 *   Every known production configuration (process env and the on-disk .env).
 * @returns {{ host: string, port: number, database: string }}
 */
export const assertSafeTestDatabase = ({ testDatabaseUrl, productionConfigs = [] }) => {
  const test = parseMysqlUrl(testDatabaseUrl);
  if (!test || !test.database) {
    throw new Error("TEST_DATABASE_URL is not a valid mysql:// URL with a database name.");
  }
  if (!LOOPBACK_HOSTS.has(test.host)) {
    throw new Error("TEST_DATABASE_URL must point at a loopback host (127.0.0.1, localhost or ::1).");
  }
  if (!test.database.includes("test")) {
    throw new Error('TEST_DATABASE_URL database name must contain "test".');
  }

  for (const config of productionConfigs) {
    if (config.databaseUrl?.trim() && config.databaseUrl.trim() === testDatabaseUrl.trim()) {
      throw new Error("TEST_DATABASE_URL is identical to a production DATABASE_URL.");
    }

    const production = parseMysqlUrl(config.databaseUrl);
    const productionNames = [production?.database, config.dbName?.trim().toLowerCase()].filter(Boolean);
    if (productionNames.includes(test.database)) {
      throw new Error("TEST_DATABASE_URL uses the same database name as production.");
    }

    const productionHosts = [
      production && { host: production.host, port: production.port },
      config.dbHost?.trim() && { host: config.dbHost.trim().toLowerCase(), port: Number(config.dbPort || 3306) },
    ].filter(Boolean);
    if (productionHosts.some(({ host, port }) => host === test.host && port === test.port)) {
      throw new Error("TEST_DATABASE_URL uses the same host and port as production.");
    }
  }

  return test;
};
