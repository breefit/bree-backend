/**
 * Audit findings 6 + 7 — customer order history leaked internal notes and
 * matched guest orders (`user_id IS NULL`) for any logged-in user.
 *
 * Drives the REAL getOrderHistory / getOrderTracking with fake query
 * functions. The fake order_status_history rows carry internal notes on
 * purpose: they must never come back out of a customer API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getOrderHistory,
  getOrderTracking,
  buildCustomerSafeOrderHistory,
} from "../src/controllers/orderController.js";

const OWN_ORDER = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORDER = "00000000-0000-4000-8000-0000000000b2";
const GUEST_ORDER = "00000000-0000-4000-8000-0000000000c3";

const SECRETS = [
  "ADMIN-VERIFY-NOTE-3301",
  "rfnd_SECRET3302",
  "MANUAL OVERRIDE — OVERRIDE-REASON-3303",
  "QC-INTERNAL-3304",
  "pay_SECRET3305",
  "RRN-3306",
  "admin-uuid-3307",
];

const ORDERS = {
  [OWN_ORDER]: {
    id: OWN_ORDER,
    user_id: "user-1",
    order_status: "delivered",
    return_status: "returned",
    return_approved_at: new Date("2026-09-20T10:00:00Z"),
    reverse_shipment_created_at: new Date("2026-09-20T11:00:00Z"),
    reverse_pickup_scheduled_at: new Date("2026-09-21T09:00:00Z"),
    reverse_picked_up_at: new Date("2026-09-21T15:00:00Z"),
    returned_at: new Date("2026-09-23T10:00:00Z"),
    inspection_status: "approved",
    inspection_completed_at: new Date("2026-09-23T12:00:00Z"),
    refund_status: "completed",
    refund_approved_at: new Date("2026-09-23T12:05:00Z"),
    refund_completed_at: new Date("2026-09-25T08:00:00Z"),
    // Never selected by the customer API — present to prove it.
    refund_reference: "rfnd_SECRET3302",
    razorpay_payment_id: "pay_SECRET3305",
    refund_rrn: "RRN-3306",
  },
  [OTHER_ORDER]: { id: OTHER_ORDER, user_id: "user-2", order_status: "delivered" },
  [GUEST_ORDER]: { id: GUEST_ORDER, user_id: null, order_status: "delivered" },
};

const HISTORY = [
  { previous_status: null, new_status: "paid", changed_by: null, notes: null, created_at: new Date("2026-09-10T10:00:00Z") },
  { previous_status: "paid", new_status: "processing", changed_by: "admin-uuid-3307", notes: "ADMIN-VERIFY-NOTE-3301", created_at: new Date("2026-09-11T10:00:00Z") },
  { previous_status: "ready_to_ship", new_status: "ready_to_ship", changed_by: "admin-uuid-3307", notes: "Shipment created. AWB X", created_at: new Date("2026-09-12T10:00:00Z") },
  { previous_status: "processing", new_status: "delivered", changed_by: null, notes: null, created_at: new Date("2026-09-15T10:00:00Z") },
  { previous_status: "delivered", new_status: "delivered", changed_by: "admin-uuid-3307", notes: "MANUAL OVERRIDE — OVERRIDE-REASON-3303", created_at: new Date("2026-09-23T10:00:00Z") },
  { previous_status: "delivered", new_status: "delivered", changed_by: "admin-uuid-3307", notes: "QC-INTERNAL-3304", created_at: new Date("2026-09-23T12:00:00Z") },
  { previous_status: "delivered", new_status: "delivered", changed_by: null, notes: "Refund rfnd_SECRET3302 confirmed completed via webhook", created_at: new Date("2026-09-25T08:00:00Z") },
  { previous_status: "delivered", new_status: "past_due", changed_by: null, notes: "internal", created_at: new Date("2026-09-26T08:00:00Z") },
];

const makeHistoryQueryFn = () => {
  const calls = [];
  const queryFn = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    calls.push({ q, params });
    if (q.includes("FROM orders WHERE id = ?")) {
      const [id, userId] = params;
      const order = ORDERS[id];
      // Faithful to the SQL: `user_id = ?` — NULL never equals anything.
      const match = order && order.user_id !== null && order.user_id === userId;
      return { rows: match ? [{ ...order }] : [] };
    }
    if (q.includes("FROM order_status_history")) return { rows: HISTORY.map((h) => ({ ...h })) };
    throw new Error(`unhandled SQL ${q}`);
  };
  return { queryFn, calls };
};

const run = async (orderId, user) => {
  const { queryFn, calls } = makeHistoryQueryFn();
  const res = {
    statusCode: 200,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  await getOrderHistory({ params: { id: orderId }, user }, res, { queryFn });
  return { res, calls };
};

test("1. a customer can read their own order history — sanitized to {status, label, timestamp}", async () => {
  const { res, calls } = await run(OWN_ORDER, { id: "user-1" });
  assert.equal(res.statusCode, 200);
  for (const entry of res.body.history) {
    assert.deepEqual(Object.keys(entry).sort(), ["label", "status", "timestamp"]);
  }
  const statuses = res.body.history.map((e) => e.status);
  assert.deepEqual(statuses, [
    "paid",
    "processing",
    "ready_to_ship",
    "delivered",
    "return_approved",
    "return_shipment_created",
    "return_pickup_scheduled",
    "return_picked_up",
    "return_received",
    "quality_check_passed",
    "refund_approved",
    "refund_completed",
  ]);
  assert.equal(res.body.history.at(-1).label, "Refund Completed");
  const body = JSON.stringify(res.body);
  for (const secret of SECRETS) assert.ok(!body.includes(secret), `leaked ${secret}`);
  // The history query no longer even selects notes / changed_by.
  const historySql = calls.find((c) => c.q.includes("FROM order_status_history")).q;
  assert.doesNotMatch(historySql, /\bnotes\b|changed_by/);
});

test("2/3. another customer's order — even with its exact UUID — is a 404, not a leak", async () => {
  const { res, calls } = await run(OTHER_ORDER, { id: "user-1" });
  assert.equal(res.statusCode, 404);
  assert.ok(!calls.some((c) => c.q.includes("order_status_history")), "history never queried");
});

test("4. a guest order's history is not exposed through the authenticated customer endpoint", async () => {
  const { res, calls } = await run(GUEST_ORDER, { id: "user-1" });
  assert.equal(res.statusCode, 404);
  const orderSql = calls[0].q;
  assert.match(orderSql, /WHERE id = \? AND user_id = \?/);
  assert.doesNotMatch(orderSql, /IS NULL/);
});

test("no authenticated user → 404 without touching the database", async () => {
  const { res, calls } = await run(OWN_ORDER, undefined);
  assert.equal(res.statusCode, 404);
  assert.equal(calls.length, 0);
});

test("refund failed / rejected appear as safe labels with no detail", () => {
  const history = buildCustomerSafeOrderHistory(
    { return_status: "returned", returned_at: new Date(), refund_status: "failed" },
    [],
  );
  assert.deepEqual(history.at(-1), { status: "refund_failed", label: "Refund Failed", timestamp: null });
});

// ── Public tracking (UUID link, no login) ────────────────────────────────────

const makeTrackingQueryFn = () => {
  const calls = [];
  const queryFn = async (sql) => {
    calls.push(sql.replace(/\s+/g, " ").trim());
    if (sql.includes("SELECT DATABASE()")) return { rows: [{ db: "bree_test" }] };
    if (sql.includes("information_schema.columns")) {
      return {
        rows: [
          { table_name: "orders", column_name: "contact_email" },
          { table_name: "orders", column_name: "subtotal" },
          { table_name: "orders", column_name: "total" },
          { table_name: "order_items", column_name: "product_name" },
          { table_name: "order_items", column_name: "product_price" },
        ],
      };
    }
    if (sql.includes("FROM orders o")) {
      return {
        rows: [
          {
            id: GUEST_ORDER,
            order_number: "BREE-100044",
            order_status: "delivered",
            payment_status: "paid",
            shipping_address: "Somewhere, Pune",
            total: 950,
            created_at: new Date(),
            return_status: "returned",
            refund_status: "failed",
            refund_amount: 950,
          },
        ],
      };
    }
    if (sql.includes("FROM order_items")) return { rows: [] };
    if (sql.includes("FROM order_status_history")) {
      return { rows: HISTORY.map(({ notes, changed_by, ...safe }) => safe) };
    }
    if (sql.includes("FROM daily_reminders")) return { rows: [] };
    throw new Error(`unhandled tracking SQL ${sql}`);
  };
  return { queryFn, calls };
};

test("5/6/7. public UUID tracking still works logged-out (guest order), and never selects notes, refund id, RRN, payment id or QC/override data", async () => {
  const { queryFn, calls } = makeTrackingQueryFn();
  const res = {
    statusCode: 200,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  await getOrderTracking({ params: { id: GUEST_ORDER } }, res, { queryFn });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.order.refund_status, "failed");

  const orderSql = calls.find((c) => c.includes("FROM orders o"));
  for (const column of [
    "refund_reference",
    "refund_rrn",
    "razorpay_payment_id",
    "refund_gateway_status",
    "return_notes",
    "return_reason",
    "reverse_delhivery_response",
    "reverse_shipment_create_error",
  ]) {
    assert.ok(!new RegExp(`\\b${column}\\b`).test(orderSql), `public tracking selects ${column}`);
  }
  const historySql = calls.find((c) => c.includes("FROM order_status_history"));
  assert.doesNotMatch(historySql, /\bnotes\b|changed_by/);
  const body = JSON.stringify(res.body);
  for (const secret of SECRETS) assert.ok(!body.includes(secret), `leaked ${secret}`);
});

test("8. admin order detail (admin-authenticated route) still returns internal history notes", () => {
  const adminSource = fs.readFileSync(new URL("../src/controllers/admin/orderController.js", import.meta.url), "utf8");
  assert.match(adminSource, /SELECT previous_status, new_status, notes, created_at\s+FROM order_status_history/);
  const routes = fs.readFileSync(new URL("../src/routes/admin/index.js", import.meta.url), "utf8");
  assert.ok(routes.indexOf("router.use(adminAuth)") < routes.indexOf('router.get("/orders/:id", getOrder)'));
});
