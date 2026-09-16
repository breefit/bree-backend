import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import app from "../src/app.js";
import { closePool } from "../src/config/database.js";

/**
 * PHASE 3 — Medium Issue #8: the legacy POST /api/orders/create route used
 * to read `tax` straight from req.body and fold it into the authoritative
 * order total with only numeric coercion — a client could submit any
 * numeric (including negative) tax value. No server-side tax-rate table
 * exists anywhere in this codebase to recompute a "correct" value instead,
 * so the field is no longer read at all; the local safeTax is always 0.
 *
 * `auth` (unlike `optionalAuth`/`verifyAuth`) does a real DB user lookup on
 * every request (middleware/auth.js), not just JWT verification, so a full
 * authenticated HTTP round trip through this route needs a real or fake
 * database this environment doesn't have (see ISSUE-007 — no
 * TEST_DATABASE_URL configured). The unauthenticated-request regression
 * below is a genuine behavioral HTTP test; the source assertion after it
 * directly confirms the actual code no longer reads or forwards `tax` —
 * this dead/unused legacy route (confirmed zero frontend callers) doesn't
 * warrant retrofitting full DI into `auth` just for this one field removal.
 */

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const httpServer = app.listen(0, "127.0.0.1", () => resolve(httpServer));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePool();
});

test("ISSUE-008 (Medium): the createOrder handler no longer destructures/reads `tax` from the request body, and safeTax is hardcoded to 0", () => {
  const source = fs.readFileSync(
    new URL("../src/controllers/orderController.js", import.meta.url),
    "utf8",
  );
  const createOrderSource = source.slice(
    source.indexOf("export const createOrder ="),
    source.indexOf("export const createOrder =") + 4000,
  );

  assert.doesNotMatch(
    createOrderSource,
    /\btax\s*[=,]/,
    "createOrder must not destructure or otherwise read a `tax` field from req.body",
  );
  assert.match(createOrderSource, /const safeTax = 0;/);
});

test("ISSUE-008 (Medium): an unauthenticated request is still rejected before reaching createOrder at all", async () => {
  const response = await fetch(`${baseUrl}/api/orders/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [], tax: -999999 }),
  });

  assert.equal(response.status, 401);
});
