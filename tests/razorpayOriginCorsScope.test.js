import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app.js";
import { closePool } from "../src/config/database.js";

/**
 * PHASE 3 — Medium Issue #3: the CORS Razorpay-subdomain exception used to
 * be checked for EVERY route, credentialed — any *.razorpay.com/*.razorpay.in
 * origin got cookie-bearing CORS access to /api/auth, /api/admin,
 * /api/orders, everything, not just the one endpoint that legitimately
 * needs it (Magic Checkout's Shipping Info widget calling
 * POST /api/payment/shipping-info directly from a Razorpay-hosted iframe
 * origin). The fix scopes the exception to that one path only.
 *
 * Real HTTP requests against the actual Express app — no production DB or
 * external API involved (CORS is enforced before any route handler runs).
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

const preflight = (path, origin, method = "POST") =>
  fetch(`${baseUrl}${path}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "content-type",
    },
  });

const RAZORPAY_ORIGIN = "https://api.razorpay.com";

test("a Razorpay-hosted origin IS allowed for the one endpoint that legitimately needs it (Magic Checkout Shipping Info)", async () => {
  const response = await preflight("/api/payment/shipping-info", RAZORPAY_ORIGIN);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), RAZORPAY_ORIGIN);
});

test("a Razorpay-hosted origin is REJECTED for every other route — auth, admin, orders — not credentialed globally anymore", async () => {
  const otherRoutes = [
    "/api/auth/verify",
    "/api/admin/login",
    "/api/orders",
    "/api/payment/create-order",
    "/api/payment/verify",
  ];

  for (const path of otherRoutes) {
    // eslint-disable-next-line no-await-in-loop
    const response = await preflight(path, RAZORPAY_ORIGIN, path === "/api/auth/verify" ? "GET" : "POST");
    assert.equal(response.status, 403, `${path} must reject a Razorpay-hosted origin`);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});

test("an arbitrary non-Razorpay, non-allow-listed origin is still rejected for shipping-info too (not opened up to everyone)", async () => {
  const response = await preflight("/api/payment/shipping-info", "https://evil.example.com");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("the real frontend origin still works normally on shipping-info (the scoping didn't accidentally break the legitimate frontend flow)", async () => {
  const response = await preflight("/api/payment/shipping-info", "https://www.breefit.in");
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://www.breefit.in");
});
