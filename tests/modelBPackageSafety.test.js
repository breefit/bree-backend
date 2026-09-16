import test from "node:test";
import assert from "node:assert/strict";
import { createPackagePurchaseFromOrder, fulfillNextCycle } from "../src/services/packageFulfillmentService.js";
import { cancelSubscription, pauseSubscription, resumeSubscription } from "../src/controllers/subscriptionController.js";
import {
  cancelSubscription as adminCancelSubscription,
  pauseSubscription as adminPauseSubscription,
  resumeSubscription as adminResumeSubscription,
} from "../src/controllers/admin/subscriptionAdminController.js";

/**
 * PHASE 3C — Step 2: Model B (pay-once package, BREE-driven monthly
 * fulfillment, NOT recurring Razorpay billing) pause/cancel business
 * decision.
 *
 * docs/DATABASE.md's "Recurring Package Database" section and
 * docs/Subscription_Flow.md:536 already document that pause/cancel for
 * Model B packages is an EXPLICIT, UNRESOLVED business decision — current
 * code deliberately never writes anything but 'active'/'completed' to
 * package_purchases.status. Per the task's instructions, no arbitrary
 * refund/cancellation behavior is invented here. Instead these tests prove
 * the three safety properties the task requires while that decision remains
 * open:
 *
 *   (a) createPackagePurchaseFromOrder can never create two package_purchases
 *       rows for the same origin order, even under real concurrency — so a
 *       retried/duplicated trigger can never double-create fulfillment.
 *   (b) The existing Model A (recurring-subscription) pause/cancel/resume
 *       endpoints — customer-facing and admin — safely reject a Model B
 *       package's origin order rather than mutating it or calling Razorpay,
 *       because Model B orders never have is_subscription = 1 or a
 *       razorpay_subscription_id.
 *   (c) A package_purchases row with status other than 'active' (e.g. a
 *       hypothetical future 'paused') is already correctly excluded by
 *       fulfillNextCycle's own due-check, proving the stopping mechanism is
 *       ready for that status to be introduced later without any further
 *       fulfillment-side code change.
 *
 * All three are driven against the REAL functions (with the queryFn/
 * getClientFn/getRazorpayFn DI added for this purpose) using a fake
 * MySQL-shaped DB with genuine UNIQUE-constraint duplicate-key semantics —
 * not source-regex, not mocked implementations. No production database, no
 * real Razorpay call.
 */

const isDuplicateKeyError = (err) => err?.code === "ER_DUP_ENTRY";

// ── (a) createPackagePurchaseFromOrder concurrency safety ──────────────────

const makeFakePackageDb = ({ orderItemsByOrder = {} } = {}) => {
  const packagePurchasesTable = new Map(); // id -> row
  const ordersTable = new Map(); // id -> { parent_package_id, fulfillment_cycle }
  let packageCounter = 100;

  const handleStatement = (sql, params, inTransaction) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT id, package_number, total_cycles FROM package_purchases")) {
      const [originOrderId] = params;
      const existing = [...packagePurchasesTable.values()].find(
        (row) => row.origin_order_id === originOrderId,
      );
      return { rows: existing ? [{ id: existing.id, package_number: existing.package_number, total_cycles: existing.total_cycles }] : [] };
    }

    if (normalized.startsWith("SELECT oi.product_id, oi.quantity")) {
      const [orderId] = params;
      const item = orderItemsByOrder[orderId];
      return { rows: item ? [item] : [] };
    }

    if (normalized === "UPDATE package_number_counter SET current_value = LAST_INSERT_ID(current_value + 1) WHERE id = 1") {
      packageCounter += 1;
      return { rows: [], rowCount: 1 };
    }

    if (normalized === "SELECT LAST_INSERT_ID() AS next_value") {
      return { rows: [{ next_value: packageCounter }] };
    }

    if (normalized.startsWith("INSERT INTO package_purchases")) {
      const id = params[0];
      const packageNumber = params[1];
      const productId = params[3];
      const originOrderId = params[4];
      const totalCycles = params[5];
      const status = params[params.length - 1];

      const alreadyExists = [...packagePurchasesTable.values()].some(
        (row) => row.origin_order_id === originOrderId,
      );
      if (alreadyExists) {
        const dupError = new Error(
          `Duplicate entry '${originOrderId}' for key 'uq_package_purchases_origin_order_id'`,
        );
        dupError.code = "ER_DUP_ENTRY";
        throw dupError;
      }

      packagePurchasesTable.set(id, {
        id,
        package_number: packageNumber,
        product_id: productId,
        origin_order_id: originOrderId,
        total_cycles: totalCycles,
        status,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith("UPDATE orders SET parent_package_id")) {
      const [packageId, orderId] = params;
      ordersTable.set(orderId, { parent_package_id: packageId, fulfillment_cycle: 1 });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled fake SQL in modelBPackageSafety test (${inTransaction ? "client" : "pooled"}): ${normalized}`);
  };

  const queryFn = async (sql, params = []) => handleStatement(sql, params, false);

  const getClientFn = async () => ({
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      return handleStatement(sql, params, true);
    },
    release: () => {},
  });

  return { queryFn, getClientFn, packagePurchasesTable, ordersTable };
};

const recurringItem = {
  product_id: "prod-package-1",
  quantity: 1,
  package_duration_months: 6,
  package_fulfillment_interval_days: 30,
};

test("Promise.all() — two concurrent createPackagePurchaseFromOrder() calls for the SAME order — exactly one package_purchases row is ever created", async () => {
  const db = makeFakePackageDb({ orderItemsByOrder: { "order-race-1": recurringItem } });

  const [resultA, resultB] = await Promise.all([
    createPackagePurchaseFromOrder("order-race-1", { queryFn: db.queryFn, getClientFn: db.getClientFn }),
    createPackagePurchaseFromOrder("order-race-1", { queryFn: db.queryFn, getClientFn: db.getClientFn }),
  ]);

  assert.equal(db.packagePurchasesTable.size, 1, "exactly one package_purchases row must exist despite the concurrent race");
  assert.ok(resultA, "the first caller must get a result, not null");
  assert.ok(resultB, "the second (racing) caller must get a result too, not null or a thrown error");
  assert.equal(resultA.packageId, resultB.packageId, "both concurrent callers must resolve to the SAME package — the loser must re-select the winner's row, never fail or duplicate");
});

test("Promise.all() — two concurrent calls for DIFFERENT orders — two independent packages are created (the constraint does not over-serialize unrelated orders)", async () => {
  const db = makeFakePackageDb({
    orderItemsByOrder: { "order-x": recurringItem, "order-y": recurringItem },
  });

  const [resultX, resultY] = await Promise.all([
    createPackagePurchaseFromOrder("order-x", { queryFn: db.queryFn, getClientFn: db.getClientFn }),
    createPackagePurchaseFromOrder("order-y", { queryFn: db.queryFn, getClientFn: db.getClientFn }),
  ]);

  assert.equal(db.packagePurchasesTable.size, 2);
  assert.notEqual(resultX.packageId, resultY.packageId);
});

test("a sequential retry for an order that already has a package returns the existing package without creating a second row", async () => {
  const db = makeFakePackageDb({ orderItemsByOrder: { "order-retry": recurringItem } });

  const first = await createPackagePurchaseFromOrder("order-retry", { queryFn: db.queryFn, getClientFn: db.getClientFn });
  const second = await createPackagePurchaseFromOrder("order-retry", { queryFn: db.queryFn, getClientFn: db.getClientFn });

  assert.equal(db.packagePurchasesTable.size, 1);
  assert.equal(first.packageId, second.packageId);
});

// ── (b) Model A pause/cancel/resume endpoints safely reject Model B orders ─

const makeReqRes = ({ params, userId = "user-1" } = {}) => {
  const req = { params, user: { id: userId }, admin: { id: "admin-1", email: "admin@bree.test" }, body: {} };
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

// Models the real WHERE clauses: customer-facing endpoints filter on
// razorpay_subscription_id + user_id + is_subscription = 1; admin endpoints
// filter on the order's own id + is_subscription = 1. A Model B origin
// order has is_subscription = 0/NULL and no razorpay_subscription_id, so
// every one of these queries must return zero rows for it — modeled here by
// simply never having a matching row in the fake table, exactly like the
// real orders table would for such a row.
const makeFakeSubscriptionLookupDb = () => ({
  queryFn: async () => ({ rows: [] }),
});

const makeFakeRazorpayNeverCalled = () => {
  let calls = 0;
  return {
    getRazorpayFn: () => ({
      subscriptions: {
        cancel: async () => {
          calls += 1;
          throw new Error("must not be called");
        },
        pause: async () => {
          calls += 1;
          throw new Error("must not be called");
        },
        resume: async () => {
          calls += 1;
          throw new Error("must not be called");
        },
      },
    }),
    getCalls: () => calls,
  };
};

test("customer-facing cancelSubscription safely 404s for a Model B package's origin order (no razorpay_subscription_id match) — Razorpay is never called", async () => {
  const db = makeFakeSubscriptionLookupDb();
  const rzp = makeFakeRazorpayNeverCalled();
  const { req, res } = makeReqRes({ params: { id: "pkg-origin-order-1" } });

  await cancelSubscription(req, res, { queryFn: db.queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.statusCode, 404);
  assert.equal(rzp.getCalls(), 0);
});

test("customer-facing pauseSubscription safely 404s for a Model B package's origin order — Razorpay is never called", async () => {
  const db = makeFakeSubscriptionLookupDb();
  const rzp = makeFakeRazorpayNeverCalled();
  const { req, res } = makeReqRes({ params: { id: "pkg-origin-order-1" } });

  await pauseSubscription(req, res, { queryFn: db.queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.statusCode, 404);
  assert.equal(rzp.getCalls(), 0);
});

test("customer-facing resumeSubscription safely 404s for a Model B package's origin order — Razorpay is never called", async () => {
  const db = makeFakeSubscriptionLookupDb();
  const rzp = makeFakeRazorpayNeverCalled();
  const { req, res } = makeReqRes({ params: { id: "pkg-origin-order-1" } });

  await resumeSubscription(req, res, { queryFn: db.queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.statusCode, 404);
  assert.equal(rzp.getCalls(), 0);
});

test("admin cancelSubscription safely 404s for a Model B package's origin order id — Razorpay is never called", async () => {
  const db = makeFakeSubscriptionLookupDb();
  const rzp = makeFakeRazorpayNeverCalled();
  const { req, res } = makeReqRes({ params: { id: "pkg-origin-order-1" } });

  await adminCancelSubscription(req, res, { queryFn: db.queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.statusCode, 404);
  assert.equal(rzp.getCalls(), 0);
});

test("admin pauseSubscription safely 404s for a Model B package's origin order id — Razorpay is never called", async () => {
  const db = makeFakeSubscriptionLookupDb();
  const rzp = makeFakeRazorpayNeverCalled();
  const { req, res } = makeReqRes({ params: { id: "pkg-origin-order-1" } });

  await adminPauseSubscription(req, res, { queryFn: db.queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.statusCode, 404);
  assert.equal(rzp.getCalls(), 0);
});

test("admin resumeSubscription safely 404s for a Model B package's origin order id — Razorpay is never called", async () => {
  const db = makeFakeSubscriptionLookupDb();
  const rzp = makeFakeRazorpayNeverCalled();
  const { req, res } = makeReqRes({ params: { id: "pkg-origin-order-1" } });

  await adminResumeSubscription(req, res, { queryFn: db.queryFn, getRazorpayFn: rzp.getRazorpayFn });

  assert.equal(res.statusCode, 404);
  assert.equal(rzp.getCalls(), 0);
});

// ── (c) fulfillNextCycle already excludes a non-'active' package status ────

test("fulfillNextCycle skips a package whose status is not 'active' (e.g. a hypothetical future 'paused') — no order is created, no crash", async () => {
  const packageRow = {
    id: "pkg-paused-1",
    status: "paused", // never written by current code — proves the check is ready for it
    next_fulfillment_date: new Date(Date.now() - 24 * 60 * 60 * 1000), // due, if status were active
    cycles_created: 1,
    total_cycles: 6,
    origin_order_id: "order-paused-origin",
  };

  const getClientFn = async () => ({
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT * FROM package_purchases WHERE id = ?")) {
        const [id] = params;
        return { rows: id === packageRow.id ? [packageRow] : [] };
      }
      throw new Error(`Unhandled fake SQL — fulfillNextCycle should never reach past the status check for a non-active package: ${normalized}`);
    },
    release: () => {},
  });

  const result = await fulfillNextCycle("pkg-paused-1", { getClientFn });

  assert.equal(result.created, false);
  assert.equal(result.reason, "not_due_or_already_handled");
});

test("fulfillNextCycle DOES create the cycle for an 'active' package with the same due date (control — proves the paused test above is a real behavioral difference, not a fake-DB artifact)", async () => {
  const packageRow = {
    id: "pkg-active-1",
    status: "active",
    next_fulfillment_date: new Date(Date.now() - 24 * 60 * 60 * 1000),
    cycles_created: 1,
    total_cycles: 6,
    fulfillment_interval_days: 30,
    origin_order_id: "order-active-origin",
  };
  const originOrder = { id: "order-active-origin", user_id: "user-1", is_free_shipping: 0, shipping_charge: 0 };
  const originItem = { product_id: "prod-1", product_name: "Box", product_image: null, product_price: 500, quantity: 1, subtotal: 500 };
  let orderNumberCounter = 9000;

  const getClientFn = async () => ({
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT * FROM package_purchases WHERE id = ?")) {
        return { rows: [packageRow] };
      }
      if (normalized === "SELECT * FROM orders WHERE id = ?") {
        return { rows: [originOrder] };
      }
      if (normalized.startsWith("SELECT product_id, product_name, product_image, product_price, quantity, subtotal")) {
        return { rows: [originItem] };
      }
      if (normalized === "UPDATE order_number_counter SET current_value = LAST_INSERT_ID(current_value + 1) WHERE id = 1") {
        orderNumberCounter += 1;
        return { rows: [], rowCount: 1 };
      }
      if (normalized === "SELECT LAST_INSERT_ID() AS next_value") {
        return { rows: [{ next_value: orderNumberCounter }] };
      }
      if (normalized.startsWith("INSERT INTO orders")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO order_items")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO order_status_history")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE package_purchases SET cycles_created")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unhandled fake SQL: ${normalized}`);
    },
    release: () => {},
  });

  const result = await fulfillNextCycle("pkg-active-1", { getClientFn });

  assert.equal(result.created, true);
  assert.equal(result.cycle, 2);
});
