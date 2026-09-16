import test from "node:test";
import assert from "node:assert/strict";
import { fulfillNextCycle } from "../src/services/packageFulfillmentService.js";

/**
 * PHASE 3C — Step 5: cron/background-job concurrency audit.
 *
 * Full audit covered all 4 scheduled jobs:
 *   1. shippingTrackingCron.js (every 30 min) — already wrapped in
 *      runWithCronLock (MySQL GET_LOCK/RELEASE_LOCK), added in Phase 3.
 *      Confirmed unchanged.
 *   2. packageFulfillmentCron.js (daily 3 AM) — runDuePackageFulfillments's
 *      per-package work (fulfillNextCycle) takes `SELECT ... FOR UPDATE` on
 *      the package_purchases row AND relies on a UNIQUE index
 *      uq_orders_package_cycle(parent_package_id, fulfillment_cycle) as a
 *      DB-level backstop. createPackagePurchaseFromOrder relies on
 *      package_purchases.origin_order_id UNIQUE (already proven under real
 *      Promise.all() concurrency in tests/modelBPackageSafety.test.js).
 *      THIS FILE adds the missing proof for fulfillNextCycle's own row-lock
 *      protection — no test previously drove two concurrent calls against
 *      the SAME package.
 *   3. dailyReminderCron.js (every minute) — claimReminderSendSlot's atomic
 *      INSERT IGNORE + conditional UPDATE, backed by
 *      UNIQUE KEY unique_reminder_send(reminder_id, send_date). Already
 *      proven under real Promise.all() concurrency in
 *      tests/dailyReminder.test.js ("scheduler: concurrent claims for the
 *      same reminder+day — only one caller ever wins").
 *   4. otpCleanupJob.js (hourly) — a single bounded, side-effect-free
 *      `DELETE FROM otp_verifications WHERE expires_at < NOW()`. Two
 *      concurrent runs simply each delete whatever still matches; InnoDB
 *      row-locks serialize the two DELETEs and neither errors nor produces
 *      any duplicate side effect (there is no side effect beyond the row
 *      count). Trivially safe by construction — no meaningful race to
 *      prove with a test (nothing there behaves differently under
 *      concurrency than sequentially).
 *
 * Classification (per the task's A/B/C/D scale — A: must have distributed
 * lock, B: safe without one, C: has protection but check-then-act, D:
 * unknown/needs production verification): all 4 jobs classify B. No new
 * locking was added — runWithCronLock is not needed for jobs 2-4, each
 * already has a genuine DB-level protection (row lock + unique constraint,
 * or atomic claim + unique constraint, or a naturally idempotent bounded
 * DELETE).
 *
 * This test drives the REAL fulfillNextCycle function under genuine
 * Promise.all() concurrency against a fake MySQL-shaped DB with real
 * FOR UPDATE row-lock semantics (a per-row mutex — the same established
 * pattern as tests/bulkQuotePaymentRace.test.js) and a real UNIQUE-
 * constraint-shaped duplicate-cycle check on the orders table. Not a
 * source regex, not a fully mocked implementation.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

const isDuplicateKeyError = (err) => err?.code === "ER_DUP_ENTRY";

// Models: package_purchases (row-locked via FOR UPDATE), the origin order +
// its items (read-only fixtures), and orders (where the new cycle order is
// inserted — enforcing the real uq_orders_package_cycle(parent_package_id,
// fulfillment_cycle) UNIQUE index as the DB-level backstop).
const makeFakeFulfillmentDb = ({ packages, originOrders, originItemsByOrder }) => {
  const packagesTable = new Map(packages.map((p) => [p.id, { ...p }]));
  const ordersTable = new Map(); // id -> { parent_package_id, fulfillment_cycle }
  const rowLocks = new Map();
  const getLock = (id) => {
    if (!rowLocks.has(id)) rowLocks.set(id, createMutex());
    return rowLocks.get(id);
  };
  let orderCounter = 5000;

  const makeClient = () => {
    let heldPackageId = null;
    return {
      query: async (sql, params = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();

        if (normalized === "BEGIN") return { rows: [], rowCount: 0 };
        if (normalized === "COMMIT" || normalized === "ROLLBACK") {
          if (heldPackageId) {
            getLock(heldPackageId).release();
            heldPackageId = null;
          }
          return { rows: [], rowCount: 0 };
        }

        if (normalized === "SELECT * FROM package_purchases WHERE id = ? FOR UPDATE") {
          const [id] = params;
          await getLock(id).acquire();
          heldPackageId = id;
          const row = packagesTable.get(id);
          return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (normalized === "SELECT * FROM orders WHERE id = ?") {
          const [id] = params;
          const order = originOrders.find((o) => o.id === id);
          return { rows: order ? [{ ...order }] : [], rowCount: order ? 1 : 0 };
        }

        if (normalized.startsWith("SELECT product_id, product_name, product_image, product_price, quantity, subtotal")) {
          const [orderId] = params;
          const items = originItemsByOrder[orderId] || [];
          return { rows: items.map((i) => ({ ...i })), rowCount: items.length };
        }

        if (normalized === "UPDATE order_number_counter SET current_value = LAST_INSERT_ID(current_value + 1) WHERE id = 1") {
          orderCounter += 1;
          return { rows: [], rowCount: 1 };
        }

        if (normalized === "SELECT LAST_INSERT_ID() AS next_value") {
          return { rows: [{ next_value: orderCounter }] };
        }

        if (normalized.startsWith("INSERT INTO orders")) {
          const id = params[0];
          const parentPackageId = params[13];
          const fulfillmentCycle = params[14];
          const duplicateCycle = [...ordersTable.values()].some(
            (row) =>
              row.parent_package_id === parentPackageId &&
              row.fulfillment_cycle === fulfillmentCycle,
          );
          if (duplicateCycle) {
            const dupError = new Error(
              `Duplicate entry '${parentPackageId}-${fulfillmentCycle}' for key 'uq_orders_package_cycle'`,
            );
            dupError.code = "ER_DUP_ENTRY";
            throw dupError;
          }
          ordersTable.set(id, { parent_package_id: parentPackageId, fulfillment_cycle: fulfillmentCycle });
          return { rows: [], rowCount: 1 };
        }

        if (normalized.startsWith("INSERT INTO order_items")) {
          return { rows: [], rowCount: 1 };
        }

        if (normalized.startsWith("INSERT INTO order_status_history")) {
          return { rows: [], rowCount: 1 };
        }

        if (normalized.startsWith("UPDATE package_purchases")) {
          const [cyclesCreated, status, id] = params;
          const row = packagesTable.get(id);
          if (row) {
            row.cycles_created = cyclesCreated;
            row.status = status;
            row.next_fulfillment_date =
              status === "completed"
                ? null
                : new Date(new Date(row.next_fulfillment_date).getTime() + row.fulfillment_interval_days * DAY_MS);
          }
          return { rows: [], rowCount: row ? 1 : 0 };
        }

        throw new Error(`Unhandled fake SQL in cronConcurrencyAudit test: ${normalized}`);
      },
      release: () => {},
    };
  };

  return { getClientFn: async () => makeClient(), packagesTable, ordersTable };
};

const baseOriginOrder = (id) => ({
  id,
  user_id: "user-1",
  address_id: null,
  customer_name: "Test Customer",
  email: "customer@example.com",
  mobile_number: "9876543210",
  shipping_address: "1 Test Street",
  contact_name: "Test Customer",
  contact_email: "customer@example.com",
  contact_phone: "9876543210",
  is_free_shipping: 0,
  shipping_charge: 0,
  estimated_delivery: null,
});

const baseItems = [
  { product_id: "prod-1", product_name: "30-Day Pack", product_image: null, product_price: 999, quantity: 1, subtotal: 999 },
];

test("job 2 (packageFulfillmentCron): Promise.all() — two concurrent fulfillNextCycle() calls for the SAME package — exactly ONE new cycle order is ever created", async () => {
  const dueDate = new Date(Date.now() - DAY_MS);
  const db = makeFakeFulfillmentDb({
    packages: [
      {
        id: "pkg-race-1",
        origin_order_id: "order-origin-race-1",
        status: "active",
        cycles_created: 1,
        total_cycles: 6,
        fulfillment_interval_days: 30,
        next_fulfillment_date: dueDate,
      },
    ],
    originOrders: [baseOriginOrder("order-origin-race-1")],
    originItemsByOrder: { "order-origin-race-1": baseItems },
  });

  const [resultA, resultB] = await Promise.all([
    fulfillNextCycle("pkg-race-1", { getClientFn: db.getClientFn }),
    fulfillNextCycle("pkg-race-1", { getClientFn: db.getClientFn }),
  ]);

  assert.equal(db.ordersTable.size, 1, "exactly one fulfillment-cycle order must exist despite the concurrent race");

  const outcomes = [resultA, resultB];
  const created = outcomes.filter((r) => r.created === true);
  const rejected = outcomes.filter((r) => r.created === false);
  assert.equal(created.length, 1, "exactly one caller must report having created the cycle");
  assert.equal(rejected.length, 1);
  // The loser is rejected either by the FOR UPDATE lock making the row no
  // longer due by the time it acquires the lock (not_due_or_already_handled)
  // or, if it somehow raced past that, by the UNIQUE constraint backstop
  // (duplicate_concurrent) — both are correct, safe outcomes; a crash or a
  // second order is not.
  assert.ok(
    ["not_due_or_already_handled", "duplicate_concurrent"].includes(rejected[0].reason),
    `unexpected rejection reason: ${rejected[0].reason}`,
  );

  const updatedPkg = db.packagesTable.get("pkg-race-1");
  assert.equal(updatedPkg.cycles_created, 2, "cycles_created must be incremented exactly once, not twice");
});

test("job 2: Promise.all() — two concurrent fulfillNextCycle() calls for DIFFERENT packages — both succeed independently (the row lock does not over-serialize unrelated packages)", async () => {
  const dueDate = new Date(Date.now() - DAY_MS);
  const db = makeFakeFulfillmentDb({
    packages: [
      {
        id: "pkg-x",
        origin_order_id: "order-origin-x",
        status: "active",
        cycles_created: 1,
        total_cycles: 6,
        fulfillment_interval_days: 30,
        next_fulfillment_date: dueDate,
      },
      {
        id: "pkg-y",
        origin_order_id: "order-origin-y",
        status: "active",
        cycles_created: 1,
        total_cycles: 6,
        fulfillment_interval_days: 30,
        next_fulfillment_date: dueDate,
      },
    ],
    originOrders: [baseOriginOrder("order-origin-x"), baseOriginOrder("order-origin-y")],
    originItemsByOrder: { "order-origin-x": baseItems, "order-origin-y": baseItems },
  });

  const [resultX, resultY] = await Promise.all([
    fulfillNextCycle("pkg-x", { getClientFn: db.getClientFn }),
    fulfillNextCycle("pkg-y", { getClientFn: db.getClientFn }),
  ]);

  assert.equal(resultX.created, true);
  assert.equal(resultY.created, true);
  assert.equal(db.ordersTable.size, 2);
});
