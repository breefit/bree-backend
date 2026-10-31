// Test entry point for `npm test` (unit) and `npm run test:db` (database).
//
// The real .env holds production credentials, and dotenv fills in any
// variable that is not already set — so a bare `node --test` loads them.
// This runner builds the test environment from .env.migration-test instead,
// overriding anything already exported in the shell, forces NODE_ENV=test,
// and passes that environment to `node --test` (whose test processes and
// their own child processes inherit it). It never prints variable values.
//
//   npm test                       -> every test file, TEST_DATABASE_URL blanked
//   npm test -- tests/x.test.js    -> just those files
//   npm run test:db                -> preflight, then the database test files

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ENV_FILE = ".env.migration-test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Every variable that points the app at an external service. Each must be
// defined in the test env file and point at a loopback address.
const URL_KEYS = ["DATABASE_URL", "WAPLIFY_BASE_URL", "DELHIVERY_BASE_URL", "DELHIVERY_TRACKING_URL", "EMAIL_LOGO_URL"];
const HOST_KEYS = ["DB_HOST", "SMTP_HOST"];

const isLoopbackUrl = (value) => {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

/**
 * Builds the environment for a test run. Throws (naming keys, never values)
 * when the test env file would let a production value or endpoint through.
 */
export const buildTestEnv = ({ baseEnv, testEnv, productionEnvKeys = [], mode }) => {
  const uncovered = productionEnvKeys.filter((key) => !Object.hasOwn(testEnv, key));
  if (uncovered.length) {
    throw new Error(
      `${TEST_ENV_FILE} does not define these keys from .env, so their production values would load: ${uncovered.join(", ")}`,
    );
  }
  for (const key of URL_KEYS) {
    if (!Object.hasOwn(testEnv, key) || !isLoopbackUrl(testEnv[key])) {
      throw new Error(`${TEST_ENV_FILE} must set ${key} to a loopback URL.`);
    }
  }
  for (const key of HOST_KEYS) {
    if (!LOOPBACK_HOSTS.has(testEnv[key]?.trim())) {
      throw new Error(`${TEST_ENV_FILE} must set ${key} to a loopback host.`);
    }
  }

  const env = { ...baseEnv, ...testEnv, NODE_ENV: "test" };
  // Unit tests run against the unreachable placeholder pool; only the
  // database run gets the (guarded) test database.
  if (mode !== "db") env.TEST_DATABASE_URL = "";
  return env;
};

const fail = (message) => {
  console.error(`[test-env] ${message}`);
  process.exit(1);
};

const main = () => {
  const [first, ...rest] = process.argv.slice(2);
  const mode = first === "--db" ? "db" : "unit";
  const extraArgs = mode === "db" ? rest : process.argv.slice(2);

  const testEnvPath = path.join(backendRoot, TEST_ENV_FILE);
  if (!fs.existsSync(testEnvPath)) {
    fail(`${TEST_ENV_FILE} not found in ${backendRoot}. Refusing to run tests without the isolated test environment.`);
  }
  const testEnv = parseEnv(fs.readFileSync(testEnvPath, "utf8"));
  const productionEnvPath = path.join(backendRoot, ".env");
  const productionEnvKeys = fs.existsSync(productionEnvPath)
    ? Object.keys(parseEnv(fs.readFileSync(productionEnvPath, "utf8")))
    : [];

  let env;
  try {
    env = buildTestEnv({ baseEnv: process.env, testEnv, productionEnvKeys, mode });
  } catch (error) {
    fail(error.message);
  }

  const credentials = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentials || !fs.existsSync(path.resolve(backendRoot, credentials))) {
    fail(`GOOGLE_APPLICATION_CREDENTIALS in ${TEST_ENV_FILE} must point at an existing fake service-account file.`);
  }

  console.log(
    `[test-env] ${Object.keys(testEnv).length} variables from ${TEST_ENV_FILE} (NODE_ENV=test, ${mode === "db" ? "database tests" : "unit tests, TEST_DATABASE_URL blanked"})`,
  );

  const run = (args) =>
    spawnSync(process.execPath, args, { cwd: backendRoot, env, stdio: "inherit" }).status ?? 1;

  if (mode === "db") {
    const preflight = run(["scripts/verify-test-database.js"]);
    if (preflight !== 0) process.exit(preflight);
    const dbFiles = extraArgs.length
      ? extraArgs
      : fs
          .readdirSync(path.join(backendRoot, "tests"))
          .filter((name) => name.endsWith(".test.js"))
          .sort()
          .map((name) => `tests/${name}`)
          .filter((file) => fs.readFileSync(path.join(backendRoot, file), "utf8").includes("TEST_DATABASE_URL"));
    process.exit(run(["--test", "--test-concurrency=1", "--test-force-exit", ...dbFiles]));
  }

  process.exit(run(["--test", ...extraArgs]));
};

// Real paths on both sides: import.meta.url is symlink-resolved, so comparing
// against an unresolved argv[1] would silently skip main() and exit 0.
if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  main();
}
