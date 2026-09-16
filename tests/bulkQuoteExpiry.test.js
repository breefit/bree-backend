import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { ensureBulkRazorpayOrder } from "../src/controllers/bulkController.js";

/**
 * PHASE 3 — Medium Issue #9: a months-old approved bulk-order quote
 * remained payable at its frozen quote_price indefinitely — no column or
 * check ever bounded a quote's validity window. Added quote_expires_at
 * (set to quote_shared_at + 15 days whenever updateBulkBooking shares a
 * quote — see that file's isSharingQuote block) and enforced in
 * ensureBulkRazorpayOrder, the function that gates creating/reusing the
 * Razorpay order a customer actually pays through.
 *
 * Drives the REAL ensureBulkRazorpayOrder function (not a regex over the
 * source) against a fake single-connection transactional client, with fake
 * timers to prove the exact expiry boundary. No production database, no
 * real Razorpay call (the function returns before ever reaching Razorpay
 * for every case tested here).
 */

const makeFakeBulkBookingsDb = (initialBooking) => {
  const bookings = new Map([[initialBooking.id, { ...initialBooking }]]);

  const client = {
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      if (normalized === "SELECT * FROM bulk_bookings WHERE id = ? FOR UPDATE") {
        const [id] = params;
        const row = bookings.get(id);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      throw new Error(`Unhandled fake SQL in bulkQuoteExpiry test: ${normalized}`);
    },
    release: () => {},
  };

  return { getClientFn: async () => client, bookings };
};

const baseBooking = (overrides = {}) => ({
  id: "booking-1",
  order_created: 0,
  quote_price: 50000,
  quote_approved: 1,
  quote_expires_at: null,
  payment_status: "pending",
  razorpay_order_id: null,
  bulk_booking_number: "BB-100001",
  ...overrides,
});

test("ISSUE-009: an approved quote past its expiry is rejected with QUOTE_EXPIRED, before ever reaching Razorpay", async () => {
  const db = makeFakeBulkBookingsDb(
    baseBooking({ quote_expires_at: new Date("2025-01-01T00:00:00Z") }),
  );

  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(new Date("2025-01-20T00:00:00Z").getTime()); // 19 days later

  try {
    const result = await ensureBulkRazorpayOrder("booking-1", { getClientFn: db.getClientFn });
    assert.equal(result.ok, false);
    assert.equal(result.code, "QUOTE_EXPIRED");
  } finally {
    mock.timers.reset();
  }
});

test("ISSUE-009: a quote 1 second before its expiry is still accepted (reaches the payment_status check, not rejected as expired)", async () => {
  const expiresAt = new Date("2025-01-16T00:00:00Z");
  const db = makeFakeBulkBookingsDb(
    baseBooking({ quote_expires_at: expiresAt, payment_status: "paid" }),
  );

  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(expiresAt.getTime() - 1000);

  try {
    const result = await ensureBulkRazorpayOrder("booking-1", { getClientFn: db.getClientFn });
    // payment_status: 'paid' is checked right after the expiry check — this
    // proves execution passed the expiry gate (a different rejection code),
    // not that the whole flow succeeds end-to-end.
    assert.equal(result.code, "ALREADY_PAID");
  } finally {
    mock.timers.reset();
  }
});

test("ISSUE-009 regression: a quote with NO expiry set (pre-migration row) is never treated as expired", async () => {
  const db = makeFakeBulkBookingsDb(baseBooking({ quote_expires_at: null, payment_status: "paid" }));

  const result = await ensureBulkRazorpayOrder("booking-1", { getClientFn: db.getClientFn });

  assert.notEqual(result.code, "QUOTE_EXPIRED");
});

test("ISSUE-009 regression: an unapproved quote is still rejected with NOT_APPROVED, not masked by the new expiry check", async () => {
  const db = makeFakeBulkBookingsDb(
    baseBooking({ quote_approved: 0, quote_expires_at: new Date("2020-01-01") }),
  );

  const result = await ensureBulkRazorpayOrder("booking-1", { getClientFn: db.getClientFn });

  assert.equal(result.code, "NOT_APPROVED");
});
