import test from "node:test";
import assert from "node:assert/strict";

/**
 * PHASE 3 — Medium Issue #29: several backend files baked
 * `https://www.breefit.in` directly into source instead of deriving it from
 * FRONTEND_URL, so a domain migration required a code change (not just an
 * env update) in multiple files.
 *
 * orderEmailService.js and paymentController.js were fixed to derive from
 * FRONTEND_URL (with the same string as a fallback).
 *
 * bulkNotificationService.js's WEBSITE_URL/buildBulkOrderQuoteReviewUrl/
 * buildHeader logoUrl were deliberately reverted to stay hardcoded — see
 * that file's own comment and tests/bulkNotification.test.js's "canonical
 * and independent of frontend URL lists" test: FRONTEND_URL is a
 * multi-purpose, comma-separated CORS allow-list (can legitimately include
 * localhost/preview origins), not a single canonical customer-facing
 * domain, so a customer-facing WhatsApp/email link must NOT be derived
 * from it.
 */

test("orderEmailService.buildOrderTrackingUrl respects FRONTEND_URL when set", async () => {
  const original = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://staging.bree-fit.example";
  try {
    const { buildOrderTrackingUrl } = await import(
      `../src/services/orderEmailService.js?t=${Date.now()}-a`
    );
    assert.equal(
      buildOrderTrackingUrl("order-1"),
      "https://staging.bree-fit.example/order/order-1/tracking",
    );
  } finally {
    if (original === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = original;
  }
});

test("orderEmailService falls back to breefit.in only when FRONTEND_URL is unset", async () => {
  const original = process.env.FRONTEND_URL;
  delete process.env.FRONTEND_URL;
  try {
    const { buildOrderTrackingUrl } = await import(
      `../src/services/orderEmailService.js?t=${Date.now()}-b`
    );
    assert.equal(
      buildOrderTrackingUrl("order-1"),
      "https://www.breefit.in/order/order-1/tracking",
    );
  } finally {
    if (original === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = original;
  }
});

test("bulkNotificationService.buildBulkOrderQuoteReviewUrl stays canonical even when FRONTEND_URL is set to something else (deliberate, not a bug)", async () => {
  const original = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://staging.bree-fit.example,http://localhost:3000";
  try {
    const { buildBulkOrderQuoteReviewUrl } = await import(
      `../src/services/bulkNotificationService.js?t=${Date.now()}-a`
    );
    assert.equal(
      buildBulkOrderQuoteReviewUrl("bulk-1"),
      "https://www.breefit.in/bulk-order/bulk-1/",
    );
  } finally {
    if (original === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = original;
  }
});

test("no remaining unconditional breefit.in literal (outside comments/fallbacks) in the files fixed for Issue #29 (orderEmailService, paymentController)", async () => {
  const fs = await import("fs");
  const files = [
    "src/services/orderEmailService.js",
    "src/controllers/paymentController.js",
  ];
  for (const file of files) {
    const content = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const bareLiterals = content.match(/`https:\/\/(www\.)?breefit\.in[^`]*`/g) || [];
    const stringLiterals = content.match(/"https:\/\/(www\.)?breefit\.in[^"]*"(?!\s*\)\s*;?\s*$)/gm) || [];
    // Every remaining literal must appear only as a `process.env.FRONTEND_URL || "..."` fallback.
    for (const literal of [...bareLiterals, ...stringLiterals]) {
      const index = content.indexOf(literal);
      const contextBefore = content.slice(Math.max(0, index - 60), index);
      assert.match(
        contextBefore,
        /FRONTEND_URL\s*\|\|\s*$/,
        `${file}: found a breefit.in literal not used as a FRONTEND_URL fallback: ${literal}`,
      );
    }
  }
});
