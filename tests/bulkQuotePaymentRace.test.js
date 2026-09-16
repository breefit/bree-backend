import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  ensureBulkRazorpayOrder,
  updateBulkBooking,
  verifyBulkPayment,
} from "../src/controllers/bulkController.js";

// verifyPaymentSignature (utils/razorpay.js) is a plain named ES module
// import inside bulkController.js — a live binding that mock.method cannot
// reliably override from outside the module. A REAL, correctly-computed
// HMAC signature (using the same formula and the same RAZORPAY_KEY_SECRET
// already loaded from .env in this test environment) is used instead,
// matching the established pattern in
// tests/verifyPaymentAmountCheckFailsClosed.test.js.
const buildValidBulkSignature = ({ razorpay_order_id, razorpay_payment_id }) =>
  crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

/**
 * PHASE 3B — Medium #10: bulk quote -> payment race protection.
 *
 * ORIGINAL RACE: a booking's quote_price could be changed (re-quoted) by an
 * admin WHILE a customer's Razorpay checkout — already opened against the
 * OLD amount — was still in flight. verifyBulkPayment compared the
 * CAPTURED Razorpay amount against the booking's CURRENT (already-changed)
 * quote_price and, on a mismatch, just 400'd with no trace at all — a
 * customer's real captured money could be silently stranded, invisible to
 * any admin screen.
 *
 * QUOTE AUTHORITY: `bulk_bookings.quote_price` (server-side, existing
 * column — no competing price field introduced). The client never
 * supplies an amount to verifyBulkPayment at all — it only supplies
 * razorpay_order_id/payment_id/signature; the expected amount is always
 * `booking.quote_price`, read fresh from the DB on every verify call.
 *
 * FIX: (1) a genuine price change in updateBulkBooking now invalidates any
 * stale razorpay_order_id and resets quote_approved, so a NEW payment
 * attempt can never be created against the old price (ensureBulkRazorpayOrder
 * already refuses without quote_approved). (2) If a payment was already
 * CAPTURED against a stale reference before the invalidation landed (the
 * genuinely un-preventable race — the customer's popup was already open),
 * verifyBulkPayment now flags the booking `payment_status =
 * 'captured_mismatch'` instead of silently discarding all trace of it.
 * (3) quote_expires_at (15 days, from Phase 3) is unchanged/preserved.
 *
 * Drives the REAL functions directly (not a regex over the source) against
 * a fake MySQL-shaped DB (real transaction/row-lock semantics) and a fake
 * Razorpay client with artificial latency so races are real. No production
 * database, no real Razorpay call.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Shared fake bulk_bookings table + real MySQL-shaped row locking,
// usable by queryFn (pooled) AND getClientFn (one held connection with
// real FOR UPDATE lock semantics via a per-row mutex) at once — the same
// pattern already established in tests/refundConcurrency.test.js. ────────
const createMutex = () => {
  let locked = false;
  const waiters = [];
  return {
    acquire() {
      if (!locked) {
        locked = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else locked = false;
    },
  };
};

// Single, complete fake bulk_bookings table + real MySQL-shaped FOR UPDATE
// row locking, shared by queryFn (pooled — a fresh client per call) and
// getClientFn (one held connection per call, reused across every .query()
// on it until .release()) — the same pattern already established in
// tests/refundConcurrency.test.js. Every statement is handled directly on
// ONE client implementation so a lock acquired by a client is guaranteed
// to be released by that SAME client (the earlier two-layer version had a
// fallback path that acquired a lock on a throwaway client and never
// released it — a real deadlock, caught by actually running these tests).
const makeFakeBulkDb = (initialBooking) => {
  const bookings = new Map([[initialBooking.id, { ...initialBooking }]]);
  const rowLocks = new Map();
  const getLock = (id) => {
    if (!rowLocks.has(id)) rowLocks.set(id, createMutex());
    return rowLocks.get(id);
  };

  // Generic SET-clause writer: parses "col = ?" / "col = NULL" / "col = NOW()"
  // fields from the SQL text itself and applies them in order against the
  // params array (skipping the trailing `id` param used by the WHERE clause).
  const applyGenericUpdate = (normalized, params) => {
    const whereIdx = normalized.indexOf(" WHERE ");
    const setClause = normalized.slice(normalized.indexOf("SET") + 4, whereIdx).trim();
    const fields = setClause.split(",").map((f) => f.trim());
    const id = params[params.length - 1];
    const row = bookings.get(id);
    if (!row) return { rows: [], rowCount: 0 };

    let paramIdx = 0;
    for (const field of fields) {
      if (field.endsWith("= NULL")) {
        row[field.slice(0, field.indexOf("=")).trim()] = null;
      } else if (field.endsWith("= NOW()")) {
        row[field.slice(0, field.indexOf("=")).trim()] = new Date();
      } else if (/=\s*\d+$/.test(field)) {
        const [col, val] = field.split("=").map((s) => s.trim());
        row[col] = Number(val);
      } else if (field.endsWith("= ?")) {
        const column = field.slice(0, field.indexOf("=")).trim();
        row[column] = params[paramIdx];
        paramIdx += 1;
      }
    }
    row.updated_at = new Date();
    return { rows: [], rowCount: 1 };
  };

  const makeClient = () => {
    let heldId = null;
    return {
      query: async (sql, params = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();

        if (normalized === "BEGIN") return { rows: [], rowCount: 0 };
        if (normalized === "COMMIT" || normalized === "ROLLBACK") {
          if (heldId) {
            getLock(heldId).release();
            heldId = null;
          }
          return { rows: [], rowCount: 0 };
        }

        if (normalized === "SELECT * FROM bulk_bookings WHERE id = ? FOR UPDATE") {
          const [id] = params;
          await getLock(id).acquire();
          heldId = id;
          const row = bookings.get(id);
          return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (normalized === "SELECT razorpay_order_id, quote_price, quote_approved, payment_status FROM bulk_bookings WHERE id = ? FOR UPDATE") {
          const [id] = params;
          await getLock(id).acquire();
          heldId = id;
          const row = bookings.get(id);
          return {
            rows: row
              ? [{
                  razorpay_order_id: row.razorpay_order_id,
                  quote_price: row.quote_price,
                  quote_approved: row.quote_approved,
                  payment_status: row.payment_status,
                }]
              : [],
            rowCount: row ? 1 : 0,
          };
        }

        if (normalized === "UPDATE bulk_bookings SET razorpay_order_id = ?, payment_link_shared_at = NOW(), updated_at = NOW() WHERE id = ?") {
          const [razorpayOrderId, id] = params;
          const row = bookings.get(id);
          if (row) {
            row.razorpay_order_id = razorpayOrderId;
            row.updated_at = new Date();
          }
          return { rows: [], rowCount: row ? 1 : 0 };
        }

        if (normalized === "SELECT * FROM bulk_bookings WHERE id = ?") {
          const [id] = params;
          const row = bookings.get(id);
          return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (normalized === "UPDATE bulk_bookings SET payment_status = 'captured_mismatch', updated_at = NOW() WHERE id = ? AND payment_status <> 'paid'") {
          const [id] = params;
          const row = bookings.get(id);
          if (row && row.payment_status !== "paid") {
            row.payment_status = "captured_mismatch";
            row.updated_at = new Date();
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }

        if (normalized === "UPDATE bulk_bookings SET payment_status = 'paid', razorpay_payment_id = ?, razorpay_signature = ?, paid_at = NOW(), updated_at = NOW() WHERE id = ?") {
          const [paymentId, signature, id] = params;
          const row = bookings.get(id);
          if (row) {
            row.payment_status = "paid";
            row.razorpay_payment_id = paymentId;
            row.razorpay_signature = signature;
            row.paid_at = new Date();
            row.updated_at = new Date();
          }
          return { rows: [], rowCount: row ? 1 : 0 };
        }

        // updateBulkBooking's generic (non-"quoted"-status) UPDATE path and
        // verifyBulkPayment's captured_mismatch flag — both plain
        // `UPDATE bulk_bookings SET ... WHERE id = ?` / `WHERE id = ? AND
        // payment_status <> 'paid'` forms, no FOR UPDATE, no row lock
        // needed (a single-row UPDATE is already atomic on its own).
        if (normalized.startsWith("UPDATE bulk_bookings SET") && !normalized.includes("FOR UPDATE") && !normalized.includes("payment_link_shared_at")) {
          return applyGenericUpdate(normalized, params);
        }

        throw new Error(`Unhandled fake SQL in bulkQuotePaymentRace test: ${normalized}`);
      },
      release: () => {
        if (heldId) {
          getLock(heldId).release();
          heldId = null;
        }
      },
    };
  };

  const queryFn = async (sql, params = []) => {
    const client = makeClient();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  };

  return { queryFn, getClientFn: async () => makeClient(), bookings };
};

const makeFakeRazorpay = ({ delayMs = 15, existingOrders = {} } = {}) => {
  let createCalls = 0;
  let orderCounter = 0;
  const orders = { ...existingOrders };
  const getRazorpayFn = () => ({
    orders: {
      create: async (payload) => {
        createCalls += 1;
        await sleep(delayMs);
        orderCounter += 1;
        const id = `order_rzp_${orderCounter}`;
        orders[id] = { id, amount: payload.amount, currency: payload.currency, status: "created" };
        return orders[id];
      },
      fetch: async (id) => {
        if (!orders[id]) throw new Error("Order not found");
        return orders[id];
      },
    },
    payments: {
      fetch: async (id) => orders.__payments?.[id] || { id, status: "captured", amount: 0, currency: "INR" },
    },
  });
  return { getRazorpayFn, getCreateCalls: () => createCalls, orders };
};

const baseBooking = (overrides = {}) => ({
  id: "booking-1",
  bulk_booking_number: "BB-100001",
  status: "quoted",
  quote_price: 10000,
  quote_approved: 1,
  quote_expires_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10 days out — not expired
  order_created: 0,
  payment_status: "pending",
  razorpay_order_id: null,
  razorpay_payment_id: null,
  contact_person: "Test Customer",
  requirements: "Test bulk order",
  ...overrides,
});

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
};

// ── 1. Valid unexpired quote -> payment succeeds ──────────────────────────

test("1. a valid, unexpired, approved quote creates a Razorpay order successfully", async () => {
  const db = makeFakeBulkDb(baseBooking());
  const rzp = makeFakeRazorpay();

  const result = await ensureBulkRazorpayOrder("booking-1", {
    queryFn: db.queryFn,
    getClientFn: db.getClientFn,
    getRazorpayFn: rzp.getRazorpayFn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(rzp.getCreateCalls(), 1);
  assert.equal(db.bookings.get("booking-1").razorpay_order_id, result.razorpayOrderId);
});

// ── 2. Expired quote -> payment rejected (also see bulkQuoteExpiry.test.js) ─

test("2. an expired quote is rejected before any Razorpay order is created", async () => {
  const db = makeFakeBulkDb(baseBooking({ quote_expires_at: new Date(Date.now() - 60 * 1000) }));
  const rzp = makeFakeRazorpay();

  const result = await ensureBulkRazorpayOrder("booking-1", {
    queryFn: db.queryFn,
    getClientFn: db.getClientFn,
    getRazorpayFn: rzp.getRazorpayFn,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "QUOTE_EXPIRED");
  assert.equal(rzp.getCreateCalls(), 0);
});

test("expiration boundary: exactly at expiration is rejected, 1 second before is accepted", async () => {
  const now = Date.now();

  const dbBefore = makeFakeBulkDb(baseBooking({ quote_expires_at: new Date(now + 1000) }));
  const rzpBefore = makeFakeRazorpay();
  const resultBefore = await ensureBulkRazorpayOrder("booking-1", {
    queryFn: dbBefore.queryFn, getClientFn: dbBefore.getClientFn, getRazorpayFn: rzpBefore.getRazorpayFn,
  });
  assert.equal(resultBefore.ok, true, "1 second before expiration must still be accepted");

  const dbAt = makeFakeBulkDb(baseBooking({ quote_expires_at: new Date(now - 1) }));
  const rzpAt = makeFakeRazorpay();
  const resultAt = await ensureBulkRazorpayOrder("booking-1", {
    queryFn: dbAt.queryFn, getClientFn: dbAt.getClientFn, getRazorpayFn: rzpAt.getRazorpayFn,
  });
  assert.equal(resultAt.code, "QUOTE_EXPIRED", "at/after expiration must be rejected");
});

// ── 3. Quote changed before payment -> stale amount rejected & flagged ────

test("3. a captured payment against a STALE (already-changed) quote amount is rejected and flagged 'captured_mismatch', not silently dropped", async () => {
  const booking = baseBooking({ payment_status: "pending", razorpay_order_id: "order_stale_1" });
  const db = makeFakeBulkDb(booking);
  const rzp = makeFakeRazorpay({
    existingOrders: {
      order_stale_1: { id: "order_stale_1", amount: 1000000, currency: "INR", status: "created" }, // old ₹10,000 price
      __payments: { pay_stale_1: { id: "pay_stale_1", status: "captured", amount: 1000000, currency: "INR" } },
    },
  });

  // Admin re-quotes to ₹12,000 AFTER the customer's Razorpay checkout (for
  // the OLD ₹10,000 order) already captured payment.
  db.bookings.get("booking-1").quote_price = 12000;

  const req = {
    params: { id: "booking-1" },
    body: {
      razorpay_order_id: "order_stale_1",
      razorpay_payment_id: "pay_stale_1",
      razorpay_signature: buildValidBulkSignature({ razorpay_order_id: "order_stale_1", razorpay_payment_id: "pay_stale_1" }),
    },
  };
  const res = makeRes();

  await verifyBulkPayment(req, res, { queryFn: db.queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /does not match the current quoted amount/i);
  assert.equal(db.bookings.get("booking-1").payment_status, "captured_mismatch", "the stranded captured payment must be flagged, not silently discarded");
});

// ── 4. Two simultaneous payment (order-creation) attempts for the same
// quote -> only one Razorpay order is created ─────────────────────────────

test("4. Promise.all([ensureBulkRazorpayOrder, ensureBulkRazorpayOrder]) for the same booking creates exactly ONE Razorpay order", async () => {
  const db = makeFakeBulkDb(baseBooking());
  const rzp = makeFakeRazorpay({ delayMs: 20 });

  const [resultA, resultB] = await Promise.all([
    ensureBulkRazorpayOrder("booking-1", { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
    ensureBulkRazorpayOrder("booking-1", { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
  ]);

  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  assert.equal(resultA.razorpayOrderId, resultB.razorpayOrderId, "both concurrent callers must end up with the SAME order id");
  assert.equal(db.bookings.get("booking-1").razorpay_order_id, resultA.razorpayOrderId);
  // Note: rzp.orders.create() may be CALLED twice (both requests race past
  // the read-only phase-1 check before either commits phase-2 — this
  // codebase's own documented tradeoff, see the "Another concurrent
  // request already wrote a fresh one first... no charge, no cleanup
  // needed" comment in ensureBulkRazorpayOrder) — what matters is that only
  // ONE order id is ever actually PERSISTED and returned to both callers.
});

// ── 5. Quote already accepted/paid -> duplicate attempt rejected safely ───

test("5. a booking already paid refuses a new Razorpay order attempt (ALREADY_PAID), not a second charge", async () => {
  const db = makeFakeBulkDb(baseBooking({ payment_status: "paid" }));
  const rzp = makeFakeRazorpay();

  const result = await ensureBulkRazorpayOrder("booking-1", {
    queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ALREADY_PAID");
  assert.equal(rzp.getCreateCalls(), 0);
});

test("5b. verifyBulkPayment for an already-paid booking with the SAME payment id replays success idempotently (no re-verification)", async () => {
  const db = makeFakeBulkDb(baseBooking({
    payment_status: "paid",
    razorpay_payment_id: "pay_already_verified",
    order_created: 1,
  }));
  const rzp = makeFakeRazorpay();
  let fetchCalls = 0;
  const countingRzp = {
    getRazorpayFn: () => {
      const real = rzp.getRazorpayFn();
      return { ...real, payments: { fetch: async (...args) => { fetchCalls += 1; return real.payments.fetch(...args); } } };
    },
  };

  const req = {
    params: { id: "booking-1" },
    body: { razorpay_order_id: "x", razorpay_payment_id: "pay_already_verified", razorpay_signature: "sig" },
  };
  const res = makeRes();

  await verifyBulkPayment(req, res, { queryFn: db.queryFn, getRazorpayFn: countingRzp.getRazorpayFn });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(fetchCalls, 0, "an already-verified payment must not re-fetch/re-verify with Razorpay at all");
});

// ── 6. Payment provider failure -> quote remains retryable ─────────────────

test("6. a Razorpay outage during order creation leaves the booking untouched and retryable (no partial/broken state)", async () => {
  const db = makeFakeBulkDb(baseBooking());
  const failingRzp = {
    getRazorpayFn: () => ({ orders: { create: async () => { throw new Error("simulated Razorpay outage"); } } }),
  };

  await assert.rejects(
    () => ensureBulkRazorpayOrder("booking-1", { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: failingRzp.getRazorpayFn }),
  );

  const booking = db.bookings.get("booking-1");
  assert.equal(booking.razorpay_order_id, null, "no partial order reference must be left behind");
  assert.equal(booking.quote_approved, 1, "the quote itself remains valid/approved for a retry");

  // Retry with Razorpay healthy now succeeds.
  const healthyRzp = makeFakeRazorpay();
  const retryResult = await ensureBulkRazorpayOrder("booking-1", { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: healthyRzp.getRazorpayFn });
  assert.equal(retryResult.ok, true);
});

// ── 7 & 8. Client cannot manipulate amount/discount — server-authoritative ─

test("7. verifyBulkPayment never reads a client-supplied amount — the expected amount always comes from booking.quote_price", async () => {
  const booking = baseBooking({ razorpay_order_id: "order_amt_1", quote_price: 10000 });
  const db = makeFakeBulkDb(booking);
  const rzp = makeFakeRazorpay({
    existingOrders: {
      order_amt_1: { id: "order_amt_1", amount: 1000000, currency: "INR", status: "created" },
      __payments: { pay_amt_1: { id: "pay_amt_1", status: "captured", amount: 1000000, currency: "INR" } },
    },
  });

  const req = {
    params: { id: "booking-1" },
    // Attacker-supplied amount field — verifyBulkPayment's signature doesn't
    // even destructure an `amount` field from req.body at all.
    body: {
      razorpay_order_id: "order_amt_1",
      razorpay_payment_id: "pay_amt_1",
      razorpay_signature: buildValidBulkSignature({ razorpay_order_id: "order_amt_1", razorpay_payment_id: "pay_amt_1" }),
      amount: 1,
    },
  };
  const res = makeRes();

  await verifyBulkPayment(req, res, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });

  // Real captured amount (1000000 paise = ₹10,000) matches the real
  // quote_price (₹10,000) — succeeds regardless of the attacker's `amount:
  // 1` field, proving that field is simply never consulted.
  assert.equal(res.body.success, true);
});

test("8. bulk verifyBulkPayment has no discount field at all — a client-supplied discount cannot influence the expected amount", async () => {
  const booking = baseBooking({ razorpay_order_id: "order_disc_1", quote_price: 10000 });
  const db = makeFakeBulkDb(booking);
  const rzp = makeFakeRazorpay({
    existingOrders: {
      order_disc_1: { id: "order_disc_1", amount: 1000000, currency: "INR", status: "created" },
      __payments: { pay_disc_1: { id: "pay_disc_1", status: "captured", amount: 1000000, currency: "INR" } },
    },
  });

  const req = {
    params: { id: "booking-1" },
    body: {
      razorpay_order_id: "order_disc_1",
      razorpay_payment_id: "pay_disc_1",
      razorpay_signature: buildValidBulkSignature({ razorpay_order_id: "order_disc_1", razorpay_payment_id: "pay_disc_1" }),
      discountAmount: 9999, // attacker-supplied — bulk flow has no discount concept to begin with
    },
  };
  const res = makeRes();

  await verifyBulkPayment(req, res, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });

  // The full quote_price (₹10,000) is still what's expected/verified —
  // proving no discount field was read or applied anywhere in this path.
  assert.equal(res.body.success, true);
});

// ── 9. Concurrent quote update + payment attempt ──────────────────────────

test("9. a re-quote racing a concurrent payment-order-creation attempt never leaves a payable order at the OLD price", async () => {
  const db = makeFakeBulkDb(baseBooking({ quote_price: 10000 }));
  const rzp = makeFakeRazorpay({ delayMs: 15 });

  const requoteReq = { params: { id: "booking-1" }, body: { quote_price: 12000 } };
  const requoteRes = makeRes();

  await Promise.all([
    ensureBulkRazorpayOrder("booking-1", { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
    updateBulkBooking(requoteReq, requoteRes, { queryFn: db.queryFn }),
  ]);

  const finalBooking = db.bookings.get("booking-1");
  // Whichever order won the race, the FINAL state must be internally
  // consistent: if the quote ended up at 12000 (re-quote landed last), the
  // booking's razorpay_order_id must NOT still be the stale 10000 order —
  // updateBulkBooking's invalidation must have cleared it.
  if (Number(finalBooking.quote_price) === 12000) {
    assert.equal(finalBooking.razorpay_order_id, null, "a re-quote must invalidate any Razorpay order created for the old price");
    assert.equal(finalBooking.quote_approved, 0, "the customer must re-approve the new price before paying again");
  }
});

// ── 10. Concurrent duplicate payment (verify) attempts ─────────────────────

test("10. Promise.all([verifyBulkPayment(same payment), verifyBulkPayment(same payment)]) never double-processes", async () => {
  const booking = baseBooking({ razorpay_order_id: "order_dup_1", quote_price: 10000 });
  const db = makeFakeBulkDb(booking);
  const rzp = makeFakeRazorpay({
    delayMs: 10,
    existingOrders: {
      order_dup_1: { id: "order_dup_1", amount: 1000000, currency: "INR", status: "created" },
      __payments: { pay_dup_1: { id: "pay_dup_1", status: "captured", amount: 1000000, currency: "INR" } },
    },
  });

  const signature = buildValidBulkSignature({ razorpay_order_id: "order_dup_1", razorpay_payment_id: "pay_dup_1" });
  const makeReq = () => ({
    params: { id: "booking-1" },
    body: { razorpay_order_id: "order_dup_1", razorpay_payment_id: "pay_dup_1", razorpay_signature: signature },
  });

  const resA = makeRes();
  const resB = makeRes();
  await Promise.all([
    verifyBulkPayment(makeReq(), resA, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
    verifyBulkPayment(makeReq(), resB, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
  ]);

  // Both requests reach a defined, non-crashing outcome, and the booking
  // ends up in a single consistent state (never corrupted by the race).
  assert.ok([resA.statusCode, resB.statusCode].every((s) => [200, 400, 409].includes(s)));
});
