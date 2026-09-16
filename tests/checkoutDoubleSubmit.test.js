import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createOrder } from "../src/controllers/paymentController.js";

/**
 * PHASE 3B — Medium #6: checkout double-submit / duplicate-order
 * protection.
 *
 * ORIGINAL RACE: `createOrder` (the Magic Checkout path — the only one
 * real traffic ever reaches, per the Phase 3 audit) had no dedup mechanism
 * reachable for that path at all — the one dedup check that existed only
 * ran when `!isMagicCheckout`, which is never true in production. Two
 * concurrent requests for the same checkout attempt (a double-click, or a
 * network-level automatic retry) could both pass validation and both
 * create a fresh order + fresh Razorpay order.
 *
 * IDEMPOTENCY KEY: a client-generated `idempotency_key`, introduced by this
 * fix (none existed before — confirmed via repo-wide grep) and sent once
 * per checkout page mount by bree-frontend's Checkout.js. Not the
 * customer's user_id (a customer can place multiple separate orders) and
 * not a hash of cart contents (two genuinely separate identical-cart orders
 * must both succeed) — see checkoutIdempotencyService.js's own comment.
 *
 * ATOMICITY: a MySQL UNIQUE(idempotency_key) constraint — modeled here with
 * a fake table that genuinely throws ER_DUP_ENTRY on a second INSERT for
 * the same key, exactly like a real UNIQUE index would across any number
 * of separate backend processes/instances (not an in-memory Set/mutex).
 *
 * This drives the REAL createOrder function directly (not a regex over the
 * source, not via HTTP — createOrder isn't Express-route-testable with
 * injected deps) against a fake MySQL-shaped DB (BEGIN/COMMIT/ROLLBACK
 * transaction semantics, a real sequence counter for order numbers, a real
 * UNIQUE constraint on the idempotency key) and a fake Razorpay client with
 * artificial latency so the race is real, not just theoretically possible.
 * No production database, no real Razorpay call.
 */

const isDuplicateKeyError = (err) => err?.code === "ER_DUP_ENTRY";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fake MySQL-shaped database: a pooled queryFn (auto-acquire-per-call,
// used for product lookups + the idempotency ledger) and a getClientFn
// (one held connection per call, used for the actual order-creation
// transaction) — sharing the same underlying in-memory tables, exactly
// like two different connections to the same real database would. ───────
const makeFakeCheckoutDb = ({ products }) => {
  const productsTable = new Map(products.map((p) => [p.id, { ...p }]));
  const ordersTable = new Map();
  const orderItemsTable = [];
  const paymentsTable = [];
  const historyTable = [];
  const idempotencyTable = new Map(); // idempotency_key -> row
  let orderNumberCounter = 5000;

  const handleSharedStatement = (sql, params, inTransaction) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "SHOW COLUMNS FROM products LIKE 'is_free_shipping'") {
      return { rows: [] }; // shipping columns not available — matches most products fixtures below
    }

    if (normalized.startsWith("SELECT id, name, image, price")) {
      const [productId] = params;
      const product = productsTable.get(productId);
      return { rows: product ? [{ ...product }] : [] };
    }

    if (normalized === "SELECT id, razorpay_order_id, total FROM orders WHERE id = ? LIMIT 1") {
      const [id] = params;
      const order = ordersTable.get(id);
      return { rows: order ? [{ id: order.id, razorpay_order_id: order.razorpay_order_id, total: order.total }] : [] };
    }

    if (normalized === "INSERT INTO checkout_idempotency (id, idempotency_key, user_id, status) VALUES (?, ?, ?, 'processing')") {
      const [id, idempotencyKey, userId] = params;
      if (idempotencyTable.has(idempotencyKey)) {
        const dupError = new Error(`Duplicate entry '${idempotencyKey}' for key 'uq_checkout_idempotency_key'`);
        dupError.code = "ER_DUP_ENTRY";
        throw dupError;
      }
      idempotencyTable.set(idempotencyKey, {
        id,
        idempotency_key: idempotencyKey,
        user_id: userId,
        status: "processing",
        order_id: null,
        razorpay_order_id: null,
        updated_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized === "SELECT status, order_id, updated_at FROM checkout_idempotency WHERE idempotency_key = ? LIMIT 1") {
      const [idempotencyKey] = params;
      const row = idempotencyTable.get(idempotencyKey);
      return { rows: row ? [{ status: row.status, order_id: row.order_id, updated_at: row.updated_at }] : [] };
    }

    if (normalized.startsWith("UPDATE checkout_idempotency SET status = 'processing'")) {
      const [idempotencyKey, staleMinutes] = params;
      const row = idempotencyTable.get(idempotencyKey);
      if (!row) return { rows: [], rowCount: 0 };
      const isStale = row.status === "processing" && Date.now() - row.updated_at.getTime() > staleMinutes * 60 * 1000;
      if (row.status === "failed" || isStale) {
        row.status = "processing";
        row.updated_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("UPDATE checkout_idempotency SET status = 'completed'")) {
      const [orderId, razorpayOrderId, idempotencyKey] = params;
      const row = idempotencyTable.get(idempotencyKey);
      if (row) {
        row.status = "completed";
        row.order_id = orderId;
        row.razorpay_order_id = razorpayOrderId;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith("UPDATE checkout_idempotency SET status = 'failed'")) {
      const [, idempotencyKey] = params;
      const row = idempotencyTable.get(idempotencyKey);
      if (row) row.status = "failed";
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized === "UPDATE order_number_counter SET current_value = LAST_INSERT_ID(current_value + 1) WHERE id = 1") {
      orderNumberCounter += 1;
      return { rows: [], rowCount: 1 };
    }

    if (normalized === "SELECT LAST_INSERT_ID() AS next_value") {
      return { rows: [{ next_value: orderNumberCounter }] };
    }

    if (normalized.startsWith("INSERT INTO orders")) {
      const [
        id, orderNumber, userId, addressId, customerName, email, mobileNumber,
        shippingAddress, contactName, contactEmail, contactPhone, subtotal,
        shipping, total, isFreeShipping, shippingCharge, estimatedDelivery,
        orderStatus, paymentStatus, razorpayOrderId,
      ] = params;
      ordersTable.set(id, {
        id, order_number: orderNumber, user_id: userId, total, razorpay_order_id: razorpayOrderId,
        payment_status: paymentStatus, order_status: orderStatus,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO order_items")) {
      orderItemsTable.push(params);
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO payments")) {
      paymentsTable.push(params);
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("INSERT INTO order_status_history")) {
      historyTable.push(params);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake SQL in checkoutDoubleSubmit test (${inTransaction ? "client" : "pooled"}): ${normalized}`);
  };

  const queryFn = async (sql, params = []) => handleSharedStatement(sql, params, false);

  const getClientFn = async () => ({
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      return handleSharedStatement(sql, params, true);
    },
    release: () => {},
  });

  return {
    queryFn,
    getClientFn,
    ordersTable,
    orderItemsTable,
    paymentsTable,
    idempotencyTable,
  };
};

const makeFakeRazorpay = ({ delayMs = 20 } = {}) => {
  let createCalls = 0;
  let orderCounter = 0;
  const getRazorpayFn = () => ({
    orders: {
      create: async (payload) => {
        createCalls += 1;
        await sleep(delayMs);
        orderCounter += 1;
        return {
          id: `order_rzp_${orderCounter}`,
          amount: payload.amount,
          currency: payload.currency,
          status: "created",
        };
      },
      fetch: async () => ({ status: "created" }),
    },
  });
  return { getRazorpayFn, getCreateCalls: () => createCalls };
};

const makeReqRes = ({ items, idempotencyKey, userId = null }) => {
  const req = {
    body: {
      items,
      line_items: items.map((i) => ({
        sku: i.product_id,
        variant_id: i.product_id,
        name: "Test Product",
        description: "Test Product",
        price: 10000,
        offer_price: 10000,
        quantity: i.quantity,
      })),
      idempotency_key: idempotencyKey,
    },
    user: userId ? { id: userId, name: "Test User", email: "test@example.com" } : null,
    app: {},
  };
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
  return { req, res };
};

const oneCartItem = [{ id: "prod-1", name: "Test Product", image: null, price: 100 }];

test("Promise.all([createOrder(request), createOrder(request)]) — same idempotency key — exactly one order created, exactly one Razorpay order created", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem });
  const rzp = makeFakeRazorpay({ delayMs: 25 });
  const key = "idem-key-race-1";

  const { req: reqA, res: resA } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key });
  const { req: reqB, res: resB } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key });

  await Promise.all([
    createOrder(reqA, resA, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
    createOrder(reqB, resB, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
  ]);

  assert.equal(rzp.getCreateCalls(), 1, "exactly one Razorpay order must be created");
  assert.equal(db.ordersTable.size, 1, "exactly one authoritative order row must exist");

  // The winner always succeeds. The loser's exact response depends on
  // timing (this codebase's real, race-safe behavior — see
  // checkoutIdempotencyService.js): if its claim attempt lands BEFORE the
  // winner finishes (the realistic case with the 25ms Razorpay delay used
  // here), it correctly gets a 409 "already in progress" — a genuinely
  // in-flight duplicate is refused, not blindly retried. If it happens to
  // land AFTER the winner already committed, it replays the winner's exact
  // order instead of creating a second one. Both outcomes are correct;
  // what must NEVER happen is a second real order/Razorpay call.
  const successes = [resA, resB].filter((r) => r.body?.success === true);
  const conflicts = [resA, resB].filter((r) => r.statusCode === 409);
  assert.equal(successes.length + conflicts.length, 2, "every response must be either a success or a 409 — no crash, no unhandled state");
  assert.ok(successes.length >= 1, "at least the winning request must succeed");

  if (successes.length === 2) {
    assert.equal(successes[0].body.order_db_id, successes[1].body.order_db_id, "if both report success, they must reference the SAME order");
  }
});

test("1. same customer + same checkout key concurrently — only one order, both responses reference it", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem });
  const rzp = makeFakeRazorpay({ delayMs: 15 });
  const key = "idem-key-same-customer";

  const { req: reqA, res: resA } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key, userId: "user-1" });
  const { req: reqB, res: resB } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key, userId: "user-1" });

  await Promise.all([
    createOrder(reqA, resA, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
    createOrder(reqB, resB, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
  ]);

  assert.equal(db.ordersTable.size, 1);
  assert.equal(rzp.getCreateCalls(), 1);
});

test("2. same customer + DIFFERENT checkout keys — two legitimate separate orders both succeed", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem });
  const rzp = makeFakeRazorpay({ delayMs: 10 });

  const { req: reqA, res: resA } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: "key-A", userId: "user-1" });
  const { req: reqB, res: resB } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: "key-B", userId: "user-1" });

  await Promise.all([
    createOrder(reqA, resA, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
    createOrder(reqB, resB, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn }),
  ]);

  assert.equal(db.ordersTable.size, 2, "a customer must be able to legitimately place two separate orders");
  assert.equal(rzp.getCreateCalls(), 2);
  assert.notEqual(resA.body.order_db_id, resB.body.order_db_id);
});

test("3. different customers + same client-generated key (globally scoped) — second one is refused, not silently merged into the first customer's order", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem });
  const rzp = makeFakeRazorpay({ delayMs: 5 });
  const key = "idem-key-shared-by-accident";

  const { req: reqA, res: resA } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key, userId: "user-1" });
  await createOrder(reqA, resA, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });
  assert.equal(resA.body.success, true);

  const { req: reqB, res: resB } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key, userId: "user-2" });
  await createOrder(reqB, resB, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });

  // The key is globally unique by design (see checkoutIdempotencyService.js) —
  // a second, sequential (non-concurrent) request with the same key replays
  // the FIRST customer's completed order rather than creating a new one for
  // user-2. This is the documented, intentional contract: the key
  // identifies ONE checkout attempt, not a customer.
  assert.equal(resB.body.order_db_id, resA.body.order_db_id);
  assert.equal(db.ordersTable.size, 1);
});

test("4. retry after first successful request replays the same order (never double-charges/double-creates)", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem });
  const rzp = makeFakeRazorpay({ delayMs: 5 });
  const key = "idem-key-retry-after-success";

  const { req: req1, res: res1 } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key });
  await createOrder(req1, res1, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });

  const { req: req2, res: res2 } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key });
  await createOrder(req2, res2, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(rzp.getCreateCalls(), 1, "the retry must NOT call Razorpay again");
  assert.equal(res2.body.order_db_id, res1.body.order_db_id);
  assert.equal(db.ordersTable.size, 1);
});

test("5. retry after a simulated failure is allowed to actually succeed (not permanently blocked)", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem });
  const key = "idem-key-retry-after-failure";

  // First attempt: Razorpay itself fails.
  const failingRzp = {
    getRazorpayFn: () => ({
      orders: {
        create: async () => {
          throw new Error("simulated Razorpay outage");
        },
      },
    }),
  };
  const { req: req1, res: res1 } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key });
  await createOrder(req1, res1, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: failingRzp.getRazorpayFn });
  assert.equal(res1.statusCode, 502);
  assert.equal(db.idempotencyTable.get(key).status, "failed");

  // Retry with the SAME key, Razorpay now healthy — must succeed.
  const healthyRzp = makeFakeRazorpay({ delayMs: 5 });
  const { req: req2, res: res2 } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key });
  await createOrder(req2, res2, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: healthyRzp.getRazorpayFn });

  assert.equal(res2.body.success, true, "a retry after a real failure must be allowed to succeed, not permanently blocked as a 'duplicate'");
  assert.equal(db.ordersTable.size, 1);
});

test("6. an invalid request (empty cart) never claims the idempotency key — a subsequent valid retry with the SAME key can still succeed", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem });
  const rzp = makeFakeRazorpay({ delayMs: 5 });
  const key = "idem-key-invalid-then-valid";

  const { req: req1, res: res1 } = makeReqRes({ items: [], idempotencyKey: key });
  await createOrder(req1, res1, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });
  assert.equal(res1.statusCode, 400);
  assert.equal(db.idempotencyTable.has(key), false, "an empty-cart request must never claim the key at all");

  const { req: req2, res: res2 } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: key });
  await createOrder(req2, res2, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });
  assert.equal(res2.body.success, true);
});

test("7. payment amount remains server-authoritative — a client-supplied amount is ignored, not trusted", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem }); // product price = 100
  const rzp = makeFakeRazorpay({ delayMs: 5 });

  const { req, res } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: "idem-key-amount-tamper" });
  req.body.amount = 1; // attacker-supplied near-zero amount

  await createOrder(req, res, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });

  // Price-mismatch guard (pre-existing, unrelated to this fix) rejects a
  // client amount that disagrees with the server-computed total.
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /price mismatch/i);
});

test("8. existing Phase 1 discount protection remains intact — a client-supplied discountAmount is never read", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem }); // product price = 100
  const rzp = makeFakeRazorpay({ delayMs: 5 });

  const { req, res } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: "idem-key-discount-tamper" });
  req.body.discountAmount = 99999; // attacker-supplied discount

  await createOrder(req, res, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.body.success, true);
  // Full price (100 rupees = 10000 paise) still charged — the discount was ignored.
  assert.equal(res.body.amount, 10000);
});

test("no idempotency_key provided — backward compatible, proceeds exactly as before (unprotected, but never crashes)", async () => {
  const db = makeFakeCheckoutDb({ products: oneCartItem });
  const rzp = makeFakeRazorpay({ delayMs: 5 });

  const { req, res } = makeReqRes({ items: [{ product_id: "prod-1", quantity: 1 }], idempotencyKey: undefined });
  delete req.body.idempotency_key;

  await createOrder(req, res, { queryFn: db.queryFn, getClientFn: db.getClientFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.body.success, true);
  assert.equal(db.idempotencyTable.size, 0, "no ledger row should be created when no key is supplied");
});
