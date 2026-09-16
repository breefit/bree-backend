import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { fulfillNextCycle } from "../src/services/packageFulfillmentService.js";

/**
 * PHASE 3 — Medium Issue #15: fulfillNextCycle re-anchored a package's
 * next_fulfillment_date off DATE_ADD(NOW(), INTERVAL ...) — the ACTUAL
 * processing time — instead of the package's own original cadence. A cron
 * tick that ran even a few hours late (any downtime, or the daily tick
 * simply landing later than the "ideal" instant) permanently shifted every
 * subsequent cycle's date later by that same drift, compounding on every
 * late run. Fixed to anchor off the row's own pre-update
 * next_fulfillment_date instead of NOW().
 *
 * Drives the REAL fulfillNextCycle function (not a regex over the source)
 * against a fake single-connection transactional client modeling the exact
 * SQL statement shapes it issues, with fake timers pinning "now" far away
 * from the package's actual due date to prove the new date is computed
 * from the due date, not the (late) processing instant. No production
 * database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const makeFakeFulfillmentDb = ({ pkg, originOrder, originItems }) => {
  const packages = new Map([[pkg.id, { ...pkg }]]);
  const insertedOrders = [];
  const insertedItems = [];
  let orderCounter = 1000;

  const client = {
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      if (normalized === "SELECT * FROM package_purchases WHERE id = ? FOR UPDATE") {
        const [id] = params;
        const row = packages.get(id);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      if (normalized === "SELECT * FROM orders WHERE id = ?") {
        const [id] = params;
        return { rows: id === originOrder.id ? [{ ...originOrder }] : [], rowCount: id === originOrder.id ? 1 : 0 };
      }

      if (normalized.startsWith("SELECT product_id, product_name, product_image, product_price, quantity, subtotal")) {
        return { rows: originItems.map((i) => ({ ...i })), rowCount: originItems.length };
      }

      if (normalized === "UPDATE order_number_counter SET current_value = LAST_INSERT_ID(current_value + 1) WHERE id = 1") {
        return { rows: [], rowCount: 1 };
      }

      if (normalized === "SELECT LAST_INSERT_ID() AS next_value") {
        orderCounter += 1;
        return { rows: [{ next_value: orderCounter }] };
      }

      if (normalized.startsWith("INSERT INTO orders")) {
        insertedOrders.push(params);
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("INSERT INTO order_items")) {
        insertedItems.push(params);
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("INSERT INTO order_status_history")) {
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE package_purchases")) {
        const [cyclesCreated, status, id] = params;
        const row = packages.get(id);
        if (row) {
          row.cycles_created = cyclesCreated;
          row.status = status;
          // Model the SQL fragment's two branches exactly: NULL when
          // completed, else DATE_ADD(next_fulfillment_date, INTERVAL
          // fulfillment_interval_days DAY) computed off the PRE-UPDATE
          // row value (`row.next_fulfillment_date` here is still the old
          // value at this point, matching real MySQL SET-clause semantics
          // when the column isn't reassigned earlier in the same SET).
          if (normalized.includes("next_fulfillment_date = NULL")) {
            row.next_fulfillment_date = null;
          } else {
            row.next_fulfillment_date = new Date(
              new Date(row.next_fulfillment_date).getTime() +
                row.fulfillment_interval_days * DAY_MS,
            );
          }
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      throw new Error(`Unhandled fake SQL in packageFulfillmentScheduleDrift test: ${normalized}`);
    },
    release: () => {},
  };

  return { getClientFn: async () => client, packages, insertedOrders, insertedItems };
};

const basePackage = (overrides = {}) => ({
  id: "pkg-1",
  origin_order_id: "order-origin-1",
  status: "active",
  cycles_created: 1,
  total_cycles: 6,
  fulfillment_interval_days: 30,
  next_fulfillment_date: null,
  ...overrides,
});

const baseOriginOrder = {
  id: "order-origin-1",
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
};

const baseOriginItems = [
  { product_id: "prod-1", product_name: "30-Day Pack", product_image: null, product_price: 999, quantity: 1, subtotal: 999 },
];

test("ISSUE-015: a cron tick running LATE (well after the due date) still anchors the next cycle off the ORIGINAL due date, not the late processing time", async () => {
  const dueDate = new Date("2025-01-01T00:00:00Z");
  const db = makeFakeFulfillmentDb({
    pkg: basePackage({ next_fulfillment_date: dueDate }),
    originOrder: baseOriginOrder,
    originItems: baseOriginItems,
  });

  mock.timers.enable({ apis: ["Date"] });
  // The cron actually runs 10 days LATE — well past the due date.
  mock.timers.setTime(dueDate.getTime() + 10 * DAY_MS);

  try {
    const result = await fulfillNextCycle("pkg-1", { getClientFn: db.getClientFn });

    assert.equal(result.created, true);
    const updated = db.packages.get("pkg-1");
    const expectedNextDate = dueDate.getTime() + 30 * DAY_MS; // anchored to the ORIGINAL due date + interval
    assert.equal(
      new Date(updated.next_fulfillment_date).getTime(),
      expectedNextDate,
      "next_fulfillment_date must be anchored to the original due date, not to the (10-days-late) actual processing time",
    );
  } finally {
    mock.timers.reset();
  }
});

test("ISSUE-015 regression: a cron tick running exactly on time computes the same anchored date (no behavior change for the common case)", async () => {
  const dueDate = new Date("2025-01-01T00:00:00Z");
  const db = makeFakeFulfillmentDb({
    pkg: basePackage({ next_fulfillment_date: dueDate }),
    originOrder: baseOriginOrder,
    originItems: baseOriginItems,
  });

  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(dueDate.getTime());

  try {
    await fulfillNextCycle("pkg-1", { getClientFn: db.getClientFn });
    const updated = db.packages.get("pkg-1");
    assert.equal(new Date(updated.next_fulfillment_date).getTime(), dueDate.getTime() + 30 * DAY_MS);
  } finally {
    mock.timers.reset();
  }
});

test("ISSUE-015 regression: the final cycle sets next_fulfillment_date to NULL and status 'completed', unaffected by the anchoring fix", async () => {
  const dueDate = new Date("2025-01-01T00:00:00Z");
  const db = makeFakeFulfillmentDb({
    pkg: basePackage({ next_fulfillment_date: dueDate, cycles_created: 5, total_cycles: 6 }),
    originOrder: baseOriginOrder,
    originItems: baseOriginItems,
  });

  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(dueDate.getTime());

  try {
    const result = await fulfillNextCycle("pkg-1", { getClientFn: db.getClientFn });
    assert.equal(result.cycle, 6);
    const updated = db.packages.get("pkg-1");
    assert.equal(updated.status, "completed");
    assert.equal(updated.next_fulfillment_date, null);
  } finally {
    mock.timers.reset();
  }
});

test("ISSUE-015 regression: not yet due is still correctly skipped (unaffected by the anchoring fix)", async () => {
  const futureDate = new Date(Date.now() + 5 * DAY_MS);
  const db = makeFakeFulfillmentDb({
    pkg: basePackage({ next_fulfillment_date: futureDate }),
    originOrder: baseOriginOrder,
    originItems: baseOriginItems,
  });

  const result = await fulfillNextCycle("pkg-1", { getClientFn: db.getClientFn });
  assert.equal(result.created, false);
  assert.equal(result.reason, "not_due_or_already_handled");
});
