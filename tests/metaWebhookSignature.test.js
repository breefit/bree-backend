import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { verifyMetaWebhookSignature } from "../src/controllers/webhookController.js";
import app from "../src/app.js";
import { closePool } from "../src/config/database.js";

/**
 * ISSUE-015 — Meta WhatsApp webhook had no signature verification.
 *
 * POST /api/webhooks/meta used to accept and process any JSON body with no
 * check at all — a public, unauthenticated ingestion endpoint. It
 * currently only logs (no order/notification state is touched), but per
 * the fix's own rationale: it's one careless future edit away from being a
 * real spoofing vector, and Meta signs every delivery with
 * X-Hub-Signature-256 regardless of whether the receiver checks it — so
 * the route is made safe unconditionally rather than only if a static
 * analysis of "is Meta still configured" could be confirmed (an external,
 * account-level fact this repo can't verify).
 *
 * Covers both layers: the pure verifyMetaWebhookSignature function
 * (real HMAC-SHA256 computed exactly as Meta does), and the real HTTP
 * route end-to-end (same app.listen()+fetch pattern as
 * paymentStatusBypass.test.js), proving the wiring is correct, not just
 * the primitive.
 */

const APP_SECRET = "test_meta_app_secret_dont_use_in_prod";

const sign = (bodyString, secret = APP_SECRET) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(bodyString).digest("hex");

// Set once for the whole file rather than per-test set/delete — a
// top-level `before()`/`after()` in a node:test file (no enclosing
// describe) brackets EVERY test in the file, not just the ones below it,
// so per-test cleanup that deletes this can race against that file-wide
// hook and leave it unset for a later test (exactly what broke the HTTP
// section below during development of this fix). The one test that needs
// the "unconfigured" state saves and restores narrowly around itself.
process.env.META_APP_SECRET = APP_SECRET;

test("ISSUE-015: a validly signed payload verifies", () => {
  const body = Buffer.from(JSON.stringify({ entry: [] }));
  const signature = sign(body.toString());
  assert.equal(verifyMetaWebhookSignature(body, signature), true);
});

test("ISSUE-015: an invalid signature (wrong secret) is rejected", () => {
  const body = Buffer.from(JSON.stringify({ entry: [] }));
  const wrongSignature = sign(body.toString(), "a-completely-different-secret");
  assert.equal(verifyMetaWebhookSignature(body, wrongSignature), false);
});

test("ISSUE-015: a signature for a DIFFERENT body than the one actually sent is rejected (proves it checks the real bytes, not just presence)", () => {
  const actualBody = Buffer.from(JSON.stringify({ entry: [{ tampered: true }] }));
  const signatureForDifferentBody = sign(JSON.stringify({ entry: [] }));
  assert.equal(verifyMetaWebhookSignature(actualBody, signatureForDifferentBody), false);
});

test("ISSUE-015: a missing signature header is rejected", () => {
  const body = Buffer.from(JSON.stringify({ entry: [] }));
  assert.equal(verifyMetaWebhookSignature(body, undefined), false);
  assert.equal(verifyMetaWebhookSignature(body, ""), false);
});

test("ISSUE-015: a malformed signature header (no 'sha256=' prefix, or non-hex garbage) is rejected without throwing", () => {
  const body = Buffer.from(JSON.stringify({ entry: [] }));
  assert.doesNotThrow(() => {
    assert.equal(verifyMetaWebhookSignature(body, "not-even-the-right-format"), false);
    assert.equal(verifyMetaWebhookSignature(body, "sha256=not-hex-at-all-!!"), false);
    assert.equal(verifyMetaWebhookSignature(body, "sha256="), false);
  });
});

test("ISSUE-015: when META_APP_SECRET is not configured, every request is rejected (fail closed, never fail open)", () => {
  delete process.env.META_APP_SECRET;
  try {
    const body = Buffer.from(JSON.stringify({ entry: [] }));
    const signature = sign(body.toString());
    assert.equal(verifyMetaWebhookSignature(body, signature), false);
  } finally {
    process.env.META_APP_SECRET = APP_SECRET;
  }
});

// ── Real HTTP route, end-to-end ────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const httpServer = app.listen(0, "127.0.0.1", () => resolve(httpServer));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  delete process.env.META_APP_SECRET;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePool();
});

test("ISSUE-015 HTTP: POST /api/webhooks/meta with a valid signature is accepted (200)", async () => {
  const bodyString = JSON.stringify({ entry: [] });
  const response = await fetch(`${baseUrl}/api/webhooks/meta`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sign(bodyString),
    },
    body: bodyString,
  });
  assert.equal(response.status, 200);
});

test("ISSUE-015 HTTP: POST /api/webhooks/meta with an invalid signature is rejected (403), not silently processed", async () => {
  const bodyString = JSON.stringify({ entry: [{ malicious: true }] });
  const response = await fetch(`${baseUrl}/api/webhooks/meta`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": "sha256=" + "0".repeat(64),
    },
    body: bodyString,
  });
  assert.equal(response.status, 403);
});

test("ISSUE-015 HTTP: POST /api/webhooks/meta with NO signature header at all is rejected (403)", async () => {
  const bodyString = JSON.stringify({ entry: [] });
  const response = await fetch(`${baseUrl}/api/webhooks/meta`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyString,
  });
  assert.equal(response.status, 403);
});

test("ISSUE-015 HTTP: POST /api/webhooks/meta with a malformed body and a valid signature for that exact (malformed) body does not crash — 200, ignored", async () => {
  const bodyString = "not valid json{{{";
  const response = await fetch(`${baseUrl}/api/webhooks/meta`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sign(bodyString),
    },
    body: bodyString,
  });
  assert.equal(response.status, 200);
});

test("ISSUE-015 HTTP regression: GET /api/webhooks/meta (the verification handshake) is unaffected by the signature check", async () => {
  process.env.META_VERIFY_TOKEN = "test-verify-token";
  const response = await fetch(
    `${baseUrl}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=echo123`,
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text, "echo123");
  delete process.env.META_VERIFY_TOKEN;
});
