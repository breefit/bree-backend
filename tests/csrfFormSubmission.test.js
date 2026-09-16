import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app.js";
import { closePool } from "../src/config/database.js";

/**
 * PHASE 3 — Medium Issue #2: this API's only CSRF mitigation is "CORS +
 * JSON-only bodies," but express.urlencoded() was registered globally, so a
 * classic cross-site <form method="POST" enctype="application/
 * x-www-form-urlencoded"> — which browsers send with NO CORS preflight and
 * WITH cookies attached — was actually parsed into req.body just like a
 * real JSON request, defeating that mitigation. Removed the urlencoded
 * parser; this proves a form-encoded POST now arrives with an empty body
 * that existing required-field validation rejects, exactly as a real
 * cross-site form submission would look to this server.
 *
 * Real HTTP requests against the actual Express app. No production DB or
 * external API — validation fails before any of that is reached.
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

test("a form-urlencoded POST body (what a plain cross-site <form> submit sends) is NOT parsed — required fields read as missing", async () => {
  // No Origin header at all (exactly how a real <form> navigation looks —
  // forms don't set a custom Origin the way fetch/XHR would either) plus a
  // form-encoded body carrying what would otherwise be valid OTP-send data.
  const response = await fetch(`${baseUrl}/api/auth/send-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "mobile=9876543210",
  });

  // If the body HAD been parsed, this would reach sendOtp with a valid
  // mobile number. Instead it must fail the same "Mobile number is
  // required" validation as an empty JSON body would.
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.message, /Mobile number is required/);
});

test("a form-urlencoded POST to an authenticated mutating endpoint also arrives with an empty body, not the attacker-supplied fields", async () => {
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "name=attacker&email=a@b.com&message=csrf-test",
  });

  // Whatever contact's own validation/error shape is, the one thing that
  // must be impossible is a 2xx success — that would mean the
  // attacker-supplied form fields were actually parsed and saved as a real
  // contact submission. (This route has no express-validator guard, so an
  // empty/undefined body surfaces as a downstream error rather than a
  // clean 400 — either way, "not silently accepted" is what matters here.)
  assert.ok(response.status >= 400, `expected a non-2xx rejection, got ${response.status}`);
});

test("real JSON requests (what the actual frontend sends) are completely unaffected", async () => {
  const response = await fetch(`${baseUrl}/api/auth/send-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile: "9876543211" }),
  });

  // Passes validation and reaches the controller (which will fail later for
  // an unrelated reason — no real WAPLIFY/DB in test env — but critically
  // NOT with the "Mobile number is required" validation error, proving JSON
  // parsing itself is untouched by removing the urlencoded parser).
  const body = await response.json().catch(() => ({}));
  assert.notEqual(response.status, 400);
  assert.ok(!body?.message || !/Mobile number is required/.test(body.message));
});
