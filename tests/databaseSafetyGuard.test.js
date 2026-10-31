import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSafeDatabaseMode, isTestRunnerProcess } from "../src/config/testDatabaseGuard.js";

/**
 * Regression tests for every way a test could reach the production database
 * (see src/config/testDatabaseGuard.js). Each scenario runs in a child process
 * with a clean environment: DATABASE_URL / DB_* are synthetic "production"
 * values on the never-resolvable .invalid TLD, and every integration points at
 * 127.0.0.1:1. dotenv never overrides a variable that is already set, so the
 * real .env cannot supply a database or provider. If a guard ever regressed,
 * the worst case is a failed DNS lookup — never a real connection.
 */

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(backendRoot, "tests");
const databaseModuleUrl = pathToFileURL(path.join(backendRoot, "src/config/database.js")).href;

const FAKE_PROD = {
  DATABASE_URL: "mysql://prod_user:prod_secret_pw@db.prod.invalid:3306/u999_bree_prod",
  DB_HOST: "db.prod.invalid",
  DB_PORT: "3306",
  DB_USER: "prod_user",
  DB_PASSWORD: "prod_secret_pw",
  DB_NAME: "u999_bree_prod",
};
const SECRETS = ["prod_user", "prod_secret_pw", "db.prod.invalid", "u999_bree_prod"];
const SAFE_TEST_URL = "mysql://t:t@127.0.0.1:3307/bree_guard_test";

const childEnv = (overrides = {}) => {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TZ: "Asia/Kolkata",
    ...FAKE_PROD,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1",
    SMTP_USER: "test@example.test",
    SMTP_PASSWORD: "fake",
    WAPLIFY_BASE_URL: "http://127.0.0.1:1",
    WAPLIFY_API_KEY: "fake",
    DELHIVERY_BASE_URL: "http://127.0.0.1:1",
    DELHIVERY_API_TOKEN: "fake",
    RAZORPAY_KEY_ID: "rzp_test_fake",
    RAZORPAY_KEY_SECRET: "fake",
    TEST_DATABASE_URL: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
};

const run = (args, env) => {
  const result = spawnSync(process.execPath, args, { cwd: backendRoot, env, encoding: "utf8", timeout: 30000 });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
};

const importDatabase = (env) =>
  run(["--input-type=module", "-e", `await import(${JSON.stringify(databaseModuleUrl)}); console.log("IMPORTED"); process.exit(0);`], env);

const assertRefused = ({ status, output }, pattern) => {
  assert.equal(status, 1, `expected exit 1, got ${status}. Output:\n${output.slice(-800)}`);
  assert.match(output, pattern);
  assert.doesNotMatch(output, /IMPORTED/);
  assert.doesNotMatch(output, /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/, "no connection may be attempted");
  for (const secret of SECRETS) assert.ok(!output.includes(secret), `output leaked ${secret}`);
};

// ── Pure detection / mode rules ────────────────────────────────────────────
test("isTestRunnerProcess detects node --test children, --test-isolation=none and directly-run test files", () => {
  const base = { env: {}, execArgv: [], entryScript: undefined, testsDir };
  assert.equal(isTestRunnerProcess({ ...base, env: { NODE_TEST_CONTEXT: "child-v8" } }), true);
  assert.equal(isTestRunnerProcess({ ...base, execArgv: ["--test", "--test-isolation=none"] }), true);
  assert.equal(isTestRunnerProcess({ ...base, entryScript: path.join(testsDir, "dailyReminderEndToEnd.test.js") }), true);
  assert.equal(isTestRunnerProcess({ ...base, entryScript: path.join(testsDir, "fixtures", "runReminderTickProcess.mjs") }), true);
  // The production server is none of these.
  assert.equal(isTestRunnerProcess({ ...base, entryScript: path.join(backendRoot, "src", "server.js") }), false);
  assert.equal(isTestRunnerProcess({ ...base, execArgv: ["--test-concurrency=0"] }), false);
});

test("assertSafeDatabaseMode refuses TEST_DATABASE_URL or a test runner outside NODE_ENV=test", () => {
  assert.throws(() => assertSafeDatabaseMode({ isTestEnv: false, testDatabaseUrl: SAFE_TEST_URL, underTestRunner: false }), /NODE_ENV is not "test"/);
  assert.throws(() => assertSafeDatabaseMode({ isTestEnv: false, testDatabaseUrl: "", underTestRunner: true }), /without NODE_ENV=test/);
  assert.doesNotThrow(() => assertSafeDatabaseMode({ isTestEnv: true, testDatabaseUrl: SAFE_TEST_URL, underTestRunner: true }));
  assert.doesNotThrow(() => assertSafeDatabaseMode({ isTestEnv: false, testDatabaseUrl: "", underTestRunner: false }));
});

// ── Attack scenarios, end to end through database.js ───────────────────────
test("scenario: production DATABASE_URL used as TEST_DATABASE_URL is refused", () => {
  assertRefused(importDatabase(childEnv({ NODE_ENV: "test", TEST_DATABASE_URL: FAKE_PROD.DATABASE_URL })), /loopback host/);
});

test("scenario: production database through a localhost tunnel is refused", () => {
  assertRefused(
    importDatabase(childEnv({ NODE_ENV: "test", TEST_DATABASE_URL: "mysql://prod_user:prod_secret_pw@127.0.0.1:3306/u999_bree_prod" })),
    /must contain "test"|same database name|same host and port/,
  );
});

test("scenario: production host with a test-looking database name is refused", () => {
  assertRefused(
    importDatabase(childEnv({ NODE_ENV: "test", TEST_DATABASE_URL: "mysql://prod_user:prod_secret_pw@db.prod.invalid:3306/bree_test" })),
    /loopback host/,
  );
});

test("scenario: TEST_DATABASE_URL without NODE_ENV=test is refused (NODE_ENV=development, as in the real .env)", () => {
  assertRefused(importDatabase(childEnv({ NODE_ENV: "development", TEST_DATABASE_URL: SAFE_TEST_URL })), /TEST_DATABASE_URL is set but NODE_ENV is not "test"/);
});

test("scenario: TEST_DATABASE_URL with NODE_ENV=production is refused", () => {
  assertRefused(importDatabase(childEnv({ NODE_ENV: "production", TEST_DATABASE_URL: SAFE_TEST_URL })), /NODE_ENV is not "test"/);
});

test("scenario: accidental database.js import inside a test runner without NODE_ENV=test is refused before any schema change", () => {
  assertRefused(importDatabase(childEnv({ NODE_ENV: "development", NODE_TEST_CONTEXT: "child-v8" })), /A test is running without NODE_ENV=test/);
});

test("scenario: direct execution of an individual DB test file without NODE_ENV=test is refused", () => {
  for (const file of ["tests/dailyReminderEndToEnd.test.js", "tests/returnRefundLifecycleEndToEnd.test.js"]) {
    // `node <file>` with the .env-style NODE_ENV=development, and with NODE_ENV unset.
    assertRefused(run([file], childEnv({ NODE_ENV: "development", TEST_DATABASE_URL: SAFE_TEST_URL })), /require NODE_ENV=test/);
    assertRefused(run([file], childEnv({ NODE_ENV: undefined, TEST_DATABASE_URL: SAFE_TEST_URL })), /require NODE_ENV=test/);
    // `node --test <file>`: the runner reports the child's abort as a failure.
    const viaRunner = run(["--test", file], childEnv({ NODE_ENV: "development", TEST_DATABASE_URL: SAFE_TEST_URL }));
    assert.notEqual(viaRunner.status, 0);
    assert.match(viaRunner.output, /require NODE_ENV=test/);
    assert.doesNotMatch(viaRunner.output, /ENOTFOUND|ECONNREFUSED|getaddrinfo/);
  }
});

// ── Controls: the guard must not block legitimate use ──────────────────────
test("control: NODE_ENV=test inside a test runner without TEST_DATABASE_URL still imports (unreachable placeholder pool)", () => {
  const { status, output } = importDatabase(childEnv({ NODE_ENV: "test", NODE_TEST_CONTEXT: "child-v8" }));
  assert.equal(status, 0, output.slice(-800));
  assert.match(output, /IMPORTED/);
});

test("control: the production server path (NODE_ENV=production, no test runner, no TEST_DATABASE_URL) is not blocked by the guard", () => {
  const { output } = importDatabase(
    childEnv({ NODE_ENV: "production", DATABASE_URL: "mysql://u:p@127.0.0.1:1/blocked_db", DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "blocked_db" }),
  );
  assert.doesNotMatch(output, /\[FATAL\]/);
  // The guard let it through to the configured (unreachable) database. The
  // import itself then fails because database.js awaits one startup schema
  // step without a catch — existing behavior when the database is down.
  assert.match(output, /ECONNREFUSED 127\.0\.0\.1:1/);
});
