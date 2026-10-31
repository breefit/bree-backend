import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildTestEnv } from "../scripts/run-tests.js";

// Synthetic values only — "production" here is the never-resolvable .invalid TLD.
const SAFE_TEST_ENV = {
  NODE_ENV: "test",
  TEST_DATABASE_URL: "mysql://t:t@127.0.0.1:3307/bree_migration_test",
  DATABASE_URL: "mysql://blocked:blocked@127.0.0.1:1/blocked_not_a_database",
  DB_HOST: "127.0.0.1",
  SMTP_HOST: "127.0.0.1",
  SMTP_PASSWORD: "fake",
  WAPLIFY_BASE_URL: "http://127.0.0.1:1",
  DELHIVERY_BASE_URL: "http://127.0.0.1:1",
  DELHIVERY_TRACKING_URL: "http://127.0.0.1:1",
  EMAIL_LOGO_URL: "http://127.0.0.1:1/logo.png",
};
const HOSTILE_SHELL = {
  PATH: "/usr/bin",
  NODE_ENV: "production",
  DATABASE_URL: "mysql://prod_user:prod_secret_pw@db.prod.invalid:3306/u999_bree_prod",
  SMTP_HOST: "smtp.prod.invalid",
  SMTP_PASSWORD: "prod_smtp_secret",
};

test("test env overrides values already exported in the shell and forces NODE_ENV=test", () => {
  const env = buildTestEnv({ baseEnv: HOSTILE_SHELL, testEnv: SAFE_TEST_ENV, mode: "unit" });
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.DATABASE_URL, SAFE_TEST_ENV.DATABASE_URL);
  assert.equal(env.SMTP_HOST, "127.0.0.1");
  assert.equal(env.SMTP_PASSWORD, "fake");
  assert.equal(env.PATH, "/usr/bin", "unrelated shell variables are kept");
  assert.equal(buildTestEnv({ baseEnv: {}, testEnv: { ...SAFE_TEST_ENV, NODE_ENV: "development" }, mode: "unit" }).NODE_ENV, "test");
});

test("unit runs blank TEST_DATABASE_URL; database runs keep it", () => {
  assert.equal(buildTestEnv({ baseEnv: {}, testEnv: SAFE_TEST_ENV, mode: "unit" }).TEST_DATABASE_URL, "");
  assert.equal(buildTestEnv({ baseEnv: {}, testEnv: SAFE_TEST_ENV, mode: "db" }).TEST_DATABASE_URL, SAFE_TEST_ENV.TEST_DATABASE_URL);
});

test("refuses when .env defines a key the test env file does not (its production value would load)", () => {
  assert.throws(
    () => buildTestEnv({ baseEnv: {}, testEnv: SAFE_TEST_ENV, productionEnvKeys: ["DATABASE_URL", "RAZORPAY_KEY_SECRET", "NEW_PROVIDER_TOKEN"], mode: "unit" }),
    /RAZORPAY_KEY_SECRET, NEW_PROVIDER_TOKEN/,
  );
});

test("refuses any external endpoint in the test env file, naming the key but never the value", () => {
  for (const [key, value] of [
    ["DATABASE_URL", HOSTILE_SHELL.DATABASE_URL],
    ["WAPLIFY_BASE_URL", "https://api.prod.invalid"],
    ["DELHIVERY_BASE_URL", "https://track.prod.invalid"],
    ["SMTP_HOST", "smtp.prod.invalid"],
    ["DB_HOST", "db.prod.invalid"],
  ]) {
    assert.throws(
      () => buildTestEnv({ baseEnv: {}, testEnv: { ...SAFE_TEST_ENV, [key]: value }, mode: "unit" }),
      (error) => error.message.includes(key) && !error.message.includes(value) && !/prod\.invalid|prod_secret/.test(error.message),
    );
  }
  const { DELHIVERY_TRACKING_URL, ...missing } = SAFE_TEST_ENV;
  assert.throws(() => buildTestEnv({ baseEnv: {}, testEnv: missing, mode: "unit" }), /DELHIVERY_TRACKING_URL/);
});

test("the runner fails immediately when .env.migration-test is missing", () => {
  const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/run-tests.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bree-runner-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.copyFileSync(runner, path.join(root, "scripts", "run-tests.js"));
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "run-tests.js")], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.migration-test not found/);
    assert.doesNotMatch(result.stdout, /tests \d+/, "no tests may start");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
