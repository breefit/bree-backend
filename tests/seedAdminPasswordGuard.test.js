import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PHASE 4 — LOW-09: migrations/seed.js used to silently fall back to a
 * predictable, publicly-documented default admin password
 * ("Change_Me_Strong_Password_123!") whenever ADMIN_PASSWORD was unset.
 * This script is never run automatically by the server (confirmed: no
 * reference to it in src/server.js or anywhere else — it's a standalone,
 * manually-invoked one-time setup step, `npm run seed`), so failing loudly
 * here can never surprise a running server.
 *
 * Fixed: seed.js now throws before creating any DB connection pool if
 * ADMIN_PASSWORD is unset — matching the exact same style as the
 * pre-existing DATABASE_URL guard directly above it.
 *
 * This test drives the REAL script as a subprocess (the only way to
 * exercise a top-level-await script with no exported functions) with
 * ADMIN_PASSWORD deliberately unset. The guard throws before
 * `mysql.createPool(...)` is ever called, so this test makes NO database
 * connection attempt whatsoever — production-safe by construction, not
 * just by mocking.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedScriptPath = path.join(__dirname, "..", "migrations", "seed.js");

test("LOW-09: seed.js exits non-zero and never reaches the DB when ADMIN_PASSWORD is unset", () => {
  const result = spawnSync("node", [seedScriptPath], {
    env: {
      ...process.env,
      DATABASE_URL: "mysql://user:pass@127.0.0.1:1/does_not_matter",
      ADMIN_PASSWORD: "",
      ADMIN_EMAIL: "",
    },
    encoding: "utf8",
    timeout: 10000,
  });

  assert.notEqual(result.status, 0, "the script must exit with a non-zero status");
  assert.match(result.stderr, /ADMIN_PASSWORD/);
  assert.match(result.stderr, /Refusing to seed a predictable default/i);
  // If the guard had NOT fired before pool creation, a real (refused)
  // connection attempt would appear as an ECONNREFUSED/getaddrinfo error
  // instead of our thrown configuration error — absence of that confirms
  // no connection was ever attempted.
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|ETIMEDOUT|getaddrinfo/);
});

test("LOW-09: seed.js's DATABASE_URL guard (pre-existing, unmodified) still fires first when DATABASE_URL is also unset", () => {
  const result = spawnSync("node", [seedScriptPath], {
    env: {
      ...process.env,
      DATABASE_URL: "",
      ADMIN_PASSWORD: "",
    },
    encoding: "utf8",
    timeout: 10000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL environment variable is not set/);
});
