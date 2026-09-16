import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { resolveOrderDiscount } from "../src/controllers/paymentController.js";
import app from "../src/app.js";
import { closePool } from "../src/config/database.js";

/**
 * ISSUE-002 — Client-controlled discount.
 *
 * createOrder used to read `discountAmount`/`discount_amount` straight from
 * the request body and feed it directly into the authoritative Razorpay
 * charge, with no validation against any real coupon/promotion record.
 * `POST /api/payment/create-order` is public (optionalAuth — guest checkout
 * is allowed), so anyone could hand-craft `discountAmount: 999999` and drive
 * a real order to near-₹0.
 *
 * The fix: createOrder no longer reads that field at all. The only way to
 * get a non-zero discount is a real promotion CODE, resolved by the new
 * `resolveOrderDiscount` against the same server-side catalog
 * (getPromotionCatalog) Razorpay's Magic Checkout coupon widget already
 * uses via applyPromotions/getPromotions — computed from the
 * server-validated subtotal, never a client-supplied one.
 *
 * These tests drive resolveOrderDiscount directly (the same pure-function
 * testing style already used for classifyPaymentState/calculateOrderTotals
 * in this codebase) since a full createOrder HTTP round trip requires a
 * real product catalog in a database, and this environment has no test
 * database configured (see ISSUE-007) — DATABASE_URL is production and is
 * never touched by the test suite.
 */

test("ISSUE-002: no promotion code means zero discount, regardless of subtotal", () => {
  assert.deepEqual(resolveOrderDiscount({ promotionCode: undefined, subtotal: 5000 }), {
    valid: true,
    discountAmount: 0,
    promotion: null,
  });
  assert.deepEqual(resolveOrderDiscount({ promotionCode: "", subtotal: 5000 }), {
    valid: true,
    discountAmount: 0,
    promotion: null,
  });
});

test("ISSUE-002: an unknown/made-up promotion code is rejected, not silently ignored to zero", () => {
  const result = resolveOrderDiscount({
    promotionCode: "TOTALLY-FAKE-CODE",
    subtotal: 5000,
  });
  assert.equal(result.valid, false);
  assert.equal(result.discountAmount, 0);
});

test("ISSUE-002: a real flat-amount promotion code resolves to the catalog's own amount, in rupees", () => {
  const result = resolveOrderDiscount({ promotionCode: "FLAT10", subtotal: 5000 });
  assert.equal(result.valid, true);
  assert.equal(result.discountAmount, 10); // catalog stores 1000 paise
  assert.equal(result.promotion.code, "FLAT10");
});

test("ISSUE-002: a percentage promotion code is computed from the SERVER subtotal, not a client-supplied one", () => {
  const result = resolveOrderDiscount({ promotionCode: "10PER", subtotal: 1000 });
  assert.equal(result.valid, true);
  assert.equal(result.discountAmount, 100); // 10% of the given (server) subtotal
});

test("ISSUE-002: a minimum-order promotion is rejected below its threshold even if the code is real", () => {
  const belowThreshold = resolveOrderDiscount({ promotionCode: "BREE20", subtotal: 100 });
  assert.equal(belowThreshold.valid, false);

  const aboveThreshold = resolveOrderDiscount({ promotionCode: "BREE20", subtotal: 600 });
  assert.equal(aboveThreshold.valid, true);
  assert.equal(aboveThreshold.discountAmount, 20);
});

test("ISSUE-002: promotion codes are matched case/whitespace-insensitively, same as the Razorpay coupon widget path", () => {
  const result = resolveOrderDiscount({ promotionCode: "  flat10  ", subtotal: 5000 });
  assert.equal(result.valid, true);
  assert.equal(result.discountAmount, 10);
});

test("ISSUE-002: resolveOrderDiscount has no parameter through which a raw client amount can influence the result", () => {
  // Simulates an attacker trying to smuggle a raw amount into the discount
  // resolver by attaching extra properties to the call — proves the
  // function's behavior is governed entirely by `promotionCode` + the
  // trusted `subtotal`, with any other field silently ignored.
  const attempted = resolveOrderDiscount({
    promotionCode: undefined,
    subtotal: 5000,
    discountAmount: 999999,
    discount_amount: 999999,
    amount: 0,
  });
  assert.equal(attempted.discountAmount, 0);
});

// ── HTTP-level regression: the route itself is still mounted ──────────────

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

test("ISSUE-002 regression: POST /api/payment/create-order still rejects an empty cart before any discount logic runs, and a bogus discountAmount changes nothing about that", async () => {
  const response = await fetch(`${baseUrl}/api/payment/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [], discountAmount: 999999, amount: 0 }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.message, /cart is empty/i);
});
