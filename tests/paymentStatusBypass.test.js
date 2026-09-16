import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app.js";
import { closePool } from "../src/config/database.js";

/**
 * ISSUE-001 — Payment status bypass.
 *
 * PUT /api/orders/:id/payment-status used to let ANY authenticated customer
 * write payment_status/order_status directly onto their own order — with no
 * Razorpay verification, no admin check, no sequential-transition guard.
 * A customer could mark their own unpaid order "paid"/"delivered" with a
 * single request. No legitimate frontend caller of this route ever existed
 * (confirmed by a repo-wide search), so the fix removes the route and its
 * controller entirely rather than re-gating it.
 *
 * This drives the real Express app end-to-end (same app.listen()+fetch
 * pattern already used in cors.test.js/authRateLimit.test.js) to prove the
 * route surface itself is gone — not just that the old handler was edited.
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
  // FIX (ISSUE-007): without this, importing app.js opens a MySQL pool that
  // is never closed, and the test process hangs instead of exiting.
  await closePool();
});

const FAKE_ORDER_ID = "00000000-0000-4000-8000-000000000000";

test("ISSUE-001: PUT /api/orders/:id/payment-status no longer exists for an unauthenticated caller (404, not a payment-status write)", async () => {
  const response = await fetch(
    `${baseUrl}/api/orders/${FAKE_ORDER_ID}/payment-status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment_status: "paid", order_status: "delivered" }),
    },
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.message, /not found/i);
});

test("ISSUE-001: PUT /api/orders/:id/payment-status no longer exists even with a forged/garbage bearer token (route is gone before auth would even run)", async () => {
  const response = await fetch(
    `${baseUrl}/api/orders/${FAKE_ORDER_ID}/payment-status`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ payment_status: "paid", order_status: "paid" }),
    },
  );
  assert.equal(response.status, 404);
});

test("ISSUE-001 regression: sibling order routes are still mounted and unaffected by removing payment-status", async () => {
  // GET /api/orders/:id still exists (optionalAuth) — proves the route
  // removal didn't accidentally take the whole orderRouter down with it.
  // This environment has no real test database configured (ISSUE-007 fix
  // deliberately keeps DATABASE_URL/production unreachable in test mode),
  // so the controller's own DB call may itself fail — the only thing this
  // asserts is that the request reached orderController's getOrder handler
  // rather than the app-level "route not found" 404.
  const response = await fetch(`${baseUrl}/api/orders/${FAKE_ORDER_ID}`);
  const body = await response.json().catch(() => ({}));
  assert.doesNotMatch(
    body.message || "",
    /^Route /,
    "GET /api/orders/:id must still be routed to its controller, not the app-level 404 handler",
  );
});

test("ISSUE-006 regression: GET /api/shipping/label/:awb (the route the removed customer button used to call directly) still requires a real admin token — a plain/unauthenticated request is 401, not a payment/order-status-style bypass", async () => {
  const response = await fetch(`${baseUrl}/api/shipping/label/AWB123456789`);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.match(body.message, /admin token/i);
});

test("ISSUE-001 regression: POST /api/payment/create-order (the real, verified checkout entry point) is still mounted", async () => {
  // Deliberately minimal/invalid body — only proving the route exists and
  // is handled by paymentController, not that it succeeds (no real test
  // database is configured in this environment — see ISSUE-007).
  const response = await fetch(`${baseUrl}/api/payment/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await response.json().catch(() => ({}));
  assert.doesNotMatch(
    body.message || "",
    /^Route /,
    "POST /api/payment/create-order must still be routed to paymentController, not the app-level 404 handler",
  );
});
