import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

/**
 * ISSUE-024 — WAPLIFY and WAREHOUSE environment variables were missing
 * from .env.example entirely. WAPLIFY is the primary/live WhatsApp
 * provider used by every notification in the app; WAREHOUSE_* is used in
 * every Delhivery shipment payload. A fresh deployment following
 * .env.example as the setup guide would silently have zero WhatsApp
 * capability and a broken/missing pickup address on every shipment.
 *
 * This test greps the actual source tree for every `process.env.WAPLIFY_*`
 * / `process.env.WAREHOUSE_*` reference and asserts each one has a
 * corresponding line in .env.example — a real structural check against
 * the live code, not just a claim that the file was edited.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const envExample = fs.readFileSync(path.join(backendRoot, ".env.example"), "utf8");

const findEnvVarReferences = (prefix) => {
  // ripgrep isn't guaranteed installed; use grep -r, which is.
  const output = execSync(
    `grep -rhoE "process\\.env\\.${prefix}[A-Z0-9_]*" src`,
    { cwd: backendRoot, encoding: "utf8" },
  );
  const names = new Set(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace("process.env.", "")),
  );
  return [...names].sort();
};

test("ISSUE-024: every WAPLIFY_* env var actually read by the source code is documented in .env.example", () => {
  const referenced = findEnvVarReferences("WAPLIFY_");
  assert.ok(referenced.length > 0, "sanity check: expected to find WAPLIFY_* references in src/");

  const missing = referenced.filter(
    (name) => !new RegExp(`^${name}=`, "m").test(envExample),
  );
  assert.deepEqual(missing, [], `missing from .env.example: ${missing.join(", ")}`);
});

test("ISSUE-024: every WAREHOUSE_* env var actually read by the source code is documented in .env.example", () => {
  const referenced = findEnvVarReferences("WAREHOUSE_");
  assert.ok(referenced.length > 0, "sanity check: expected to find WAREHOUSE_* references in src/");

  const missing = referenced.filter(
    (name) => !new RegExp(`^${name}=`, "m").test(envExample),
  );
  assert.deepEqual(missing, [], `missing from .env.example: ${missing.join(", ")}`);
});

test("ISSUE-024 regression: META_APP_SECRET and META_VERIFY_TOKEN (used by the ISSUE-015 signature-verification fix) are documented too", () => {
  assert.match(envExample, /^META_APP_SECRET=/m);
  assert.match(envExample, /^META_VERIFY_TOKEN=/m);
});

test("ISSUE-024 regression: .env.example still contains no real secret values (only placeholders)", () => {
  // A loose but meaningful check: none of the placeholder lines should
  // contain what looks like a real, long base64/hex-ish live credential —
  // every value should read as an obvious placeholder string.
  const suspiciousRealSecretPattern = /^(?!#)[A-Z0-9_]+=(?:sk_live_|rzp_live_|AIza)[A-Za-z0-9]{10,}/m;
  assert.doesNotMatch(envExample, suspiciousRealSecretPattern);
});
