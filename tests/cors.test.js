import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app.js";

const otpPaths = [
  "/api/auth/send-otp",
  "/api/auth/verify-otp",
  "/api/auth/resend-otp",
];

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
});

const preflight = (path, origin, method = "POST") =>
  fetch(`${baseUrl}${path}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "content-type",
    },
  });

const assertCorsHeaders = (response, origin) => {
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(
    response.headers.get("access-control-allow-credentials"),
    "true",
  );
};

test("canonical production origin is allowed for every OTP preflight", async () => {
  for (const path of otpPaths) {
    const response = await preflight(path, "https://www.breefit.in");
    assert.equal(response.status, 204);
    assertCorsHeaders(response, "https://www.breefit.in");
  }
});

test("null origin is allowed for every OTP preflight", async () => {
  for (const path of otpPaths) {
    const response = await preflight(path, "null");
    assert.equal(response.status, 204);
    assertCorsHeaders(response, "null");
  }
});

test("null-origin OTP POSTs pass CORS and reach route validation", async () => {
  for (const path of otpPaths) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Origin: "null",
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    assert.equal(response.status, 400);
    assertCorsHeaders(response, "null");
    assert.match(await response.text(), /Mobile number is required/);
  }
});

test("null origin remains blocked for authenticated endpoints", async () => {
  const response = await preflight("/api/auth/verify", "null", "GET");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("unsupported origins remain blocked for every OTP endpoint", async () => {
  for (const path of otpPaths) {
    const response = await preflight(path, "https://example.com");
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});
