import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeTestDatabase } from "../src/config/testDatabaseGuard.js";

// Synthetic stand-ins for production — never real hosts or credentials.
const PRODUCTION = {
  databaseUrl: "mysql://prod_user:prod_pw@db.prod.example:3306/u123_bree",
  dbHost: "db.prod.example",
  dbPort: "3306",
  dbName: "u123_bree",
};
const SAFE_URL = "mysql://bree_test:pw@127.0.0.1:3307/bree_migration_test";

test("accepts a loopback database whose name contains 'test'", () => {
  assert.deepEqual(
    assertSafeTestDatabase({ testDatabaseUrl: SAFE_URL, productionConfigs: [PRODUCTION] }),
    { host: "127.0.0.1", port: 3307, database: "bree_migration_test" },
  );
});

test("refuses a TEST_DATABASE_URL identical to production", () => {
  assert.throws(
    () => assertSafeTestDatabase({ testDatabaseUrl: PRODUCTION.databaseUrl, productionConfigs: [PRODUCTION] }),
    /loopback/,
  );
});

test("refuses the production host reached with different credentials", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        testDatabaseUrl: "mysql://other:other@db.prod.example:3306/bree_test",
        productionConfigs: [PRODUCTION],
      }),
    /loopback/,
  );
});

test("refuses production reached through a localhost tunnel (same database name)", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        testDatabaseUrl: "mysql://prod_user:prod_pw@127.0.0.1:3306/u123_bree",
        productionConfigs: [{ ...PRODUCTION, dbName: "u123_bree_test_shadow" }],
      }),
    /must contain "test"|same database name/,
  );
  assert.throws(
    () =>
      assertSafeTestDatabase({
        testDatabaseUrl: "mysql://u:p@localhost:3306/prod_test",
        productionConfigs: [{ databaseUrl: "mysql://u:p@localhost:3306/prod_test" }],
      }),
    /identical/,
  );
});

test("refuses a loopback database matching production host and port", () => {
  assert.throws(
    () =>
      assertSafeTestDatabase({
        testDatabaseUrl: "mysql://u:p@127.0.0.1:3306/bree_test",
        productionConfigs: [{ dbHost: "127.0.0.1", dbPort: "3306", dbName: "bree" }],
      }),
    /same host and port/,
  );
});

test("refuses a database name without 'test' and malformed URLs", () => {
  assert.throws(
    () => assertSafeTestDatabase({ testDatabaseUrl: "mysql://u:p@127.0.0.1:3307/bree", productionConfigs: [] }),
    /must contain "test"/,
  );
  assert.throws(
    () => assertSafeTestDatabase({ testDatabaseUrl: "postgres://u:p@127.0.0.1/bree_test", productionConfigs: [] }),
    /valid mysql/,
  );
});

test("refusal messages never include hosts, users, passwords or database names", () => {
  for (const testDatabaseUrl of [
    PRODUCTION.databaseUrl,
    "mysql://prod_user:prod_pw@127.0.0.1:3306/u123_bree",
    "mysql://u:p@127.0.0.1:3306/bree_test",
  ]) {
    try {
      assertSafeTestDatabase({ testDatabaseUrl, productionConfigs: [{ ...PRODUCTION, dbHost: "127.0.0.1" }] });
      assert.fail("expected a refusal");
    } catch (error) {
      // 127.0.0.1 is not checked: it appears in the fixed loopback hint text.
      for (const secret of ["prod_user", "prod_pw", "db.prod.example", "u123_bree", "bree_test"]) {
        assert.ok(!error.message.includes(secret), `message leaked ${secret}: ${error.message}`);
      }
    }
  }
});
