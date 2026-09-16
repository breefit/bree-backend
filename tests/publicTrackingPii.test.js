import test from "node:test";
import assert from "node:assert/strict";
import { getOrderTracking } from "../src/controllers/orderController.js";

/**
 * ISSUE-009 — Public order tracking over-exposes PII.
 *
 * GET /orders/:id/tracking is intentionally public (the order UUID is the
 * credential — a courier-tracking-style design, documented in the
 * controller itself) but used to return the customer's full phone number
 * (ua.phone, selected but never rendered by the frontend anywhere), the
 * account owner's internal user_id, and the raw structured address/name
 * join columns underlying the one address string the UI actually shows —
 * on top of the resolved address string itself. If an order id ever leaks
 * (logs, a Referer header, a screenshot, pasted into a support chat), a
 * third party got permanent, easily-machine-parsed access to all of that.
 *
 * This drives the REAL getOrderTracking handler (not a regex over the
 * source) with a fake queryFn fixture, and asserts the exact response
 * shape: sensitive/unused fields are gone, while every field the frontend
 * genuinely renders (confirmed by grep against OrderTracking.js/
 * OrderTrackingCard.js) is still present and unchanged.
 */

const fakeOrderRow = {
  id: "00000000-0000-4000-8000-000000000001",
  order_number: "BRE-7001",
  order_status: "shipped",
  payment_status: "paid",
  shipping_address: null, // force the ua_*/la_* fallback path to populate
  subtotal: 900,
  shipping: 50,
  tax: 0,
  total: 950,
  is_free_shipping: 0,
  shipping_charge: 50,
  estimated_delivery: null,
  created_at: new Date(),
  delivered_at: null,
  return_status: null,
  return_requested_at: null,
  return_approved_at: null,
  reverse_awb: null,
  reverse_tracking_url: null,
  reverse_shipment_created_at: null,
  reverse_pickup_request_id: null,
  returned_at: null,
  inspection_status: null,
  refund_status: null,
  refund_amount: null,
  refund_completed_at: null,
  parent_package_id: null,
  fulfillment_cycle: null,
  package_number: null,
  package_total_cycles: null,
  contact_name: "Priya Sharma",
  contact_email: "priya@example.com",
  // The raw join columns a leaked tracking link used to expose directly.
  ua_full_name: "Priya Sharma",
  ua_phone: "9876543210",
  ua_address_line_1: "Flat 4B, Sunrise Apartments",
  ua_address_line_2: "MG Road",
  ua_city: "Pune",
  ua_state: "MH",
  ua_pincode: "411001",
  ua_country: "India",
  la_label: null,
  la_address_line1: null,
  la_address_line2: null,
  la_city: null,
  la_state: null,
  la_pincode: null,
  la_country: null,
};

const createFakeQueryFn = (orderRow) => async (sql) => {
  // getOrderSchemaInfo() — called internally by getOrderTracking to decide
  // new-vs-legacy column names; the fixture below is shaped like the "new"
  // schema (contact_email/subtotal/total), so report exactly that.
  if (sql.includes("SELECT DATABASE()")) {
    return { rows: [{ db: "bree_test" }] };
  }
  if (sql.includes("information_schema.columns")) {
    return {
      rows: [
        { table_name: "orders", column_name: "contact_email" },
        { table_name: "orders", column_name: "subtotal" },
        { table_name: "orders", column_name: "total" },
        { table_name: "orders", column_name: "notes" },
        { table_name: "order_items", column_name: "product_name" },
        { table_name: "order_items", column_name: "product_price" },
      ],
    };
  }
  if (sql.includes("FROM orders o")) {
    return { rows: orderRow ? [orderRow] : [] };
  }
  if (sql.includes("FROM order_items")) {
    return { rows: [{ id: "item-1", product_name: "Bree Fit", product_image: null, product_price: 900, quantity: 1, subtotal: 900 }] };
  }
  if (sql.includes("FROM order_status_history")) {
    return {
      rows: [
        {
          id: "hist-1",
          previous_status: "paid",
          new_status: "shipped",
          notes: null,
          created_at: new Date(),
        },
      ],
    };
  }
  if (sql.includes("FROM daily_reminders")) {
    return { rows: [] };
  }
  throw new Error(`Unhandled fake SQL in publicTrackingPii test: ${sql}`);
};

const makeReqRes = (orderId) => {
  const req = { params: { id: orderId } };
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

test("ISSUE-009: the public tracking response never includes the customer's phone number, in any field", async () => {
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000001");
  await getOrderTracking(req, res, { queryFn: createFakeQueryFn(fakeOrderRow) });

  assert.equal(res.statusCode, 200);
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(
    serialized,
    /9876543210/,
    "the raw phone number must not appear anywhere in the public tracking response",
  );
  assert.equal(res.body.order.ua_phone, undefined);
});

test("ISSUE-009: the public tracking response never includes the account owner's internal user_id", async () => {
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000001");
  await getOrderTracking(req, res, {
    queryFn: createFakeQueryFn({ ...fakeOrderRow, user_id: "user-internal-999" }),
  });

  assert.equal(res.body.order.user_id, undefined);
});

test("ISSUE-009: the raw structured address/name join columns are stripped — only the single resolved shipping_address string is exposed", async () => {
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000001");
  await getOrderTracking(req, res, { queryFn: createFakeQueryFn(fakeOrderRow) });

  const order = res.body.order;
  for (const field of [
    "ua_full_name",
    "ua_phone",
    "ua_address_line_1",
    "ua_address_line_2",
    "ua_city",
    "ua_state",
    "ua_pincode",
    "ua_country",
    "la_label",
    "la_address_line1",
    "la_address_line2",
    "la_city",
    "la_state",
    "la_pincode",
    "la_country",
  ]) {
    assert.equal(order[field], undefined, `${field} must not be present in the public response`);
  }
});

test("ISSUE-009: order_status_history rows never include changed_by (an internal admin/user id)", async () => {
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000001");
  await getOrderTracking(req, res, { queryFn: createFakeQueryFn(fakeOrderRow) });

  for (const row of res.body.history) {
    assert.equal(row.changed_by, undefined);
  }
});

// ── Regression: everything the frontend actually renders must survive. ────

test("ISSUE-009 regression: the resolved shipping_address string is still present and correctly built from the address join columns", async () => {
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000001");
  await getOrderTracking(req, res, { queryFn: createFakeQueryFn(fakeOrderRow) });

  const address = res.body.order.shipping_address;
  assert.ok(address, "shipping_address must still be populated");
  assert.match(address, /Sunrise Apartments/);
  assert.match(address, /Pune/);
});

test("ISSUE-009 regression: contact_name, contact_email, payment_status, order_status, and financial totals the UI renders are all still present", async () => {
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000001");
  await getOrderTracking(req, res, { queryFn: createFakeQueryFn(fakeOrderRow) });

  const order = res.body.order;
  assert.equal(order.contact_name, "Priya Sharma");
  assert.equal(order.contact_email, "priya@example.com");
  assert.equal(order.payment_status, "paid");
  assert.equal(order.order_status, "shipped");
  assert.equal(order.total, 950);
});

test("ISSUE-009 regression: return/refund timeline fields the customer's own tracking page needs are still present", async () => {
  const refundingOrder = {
    ...fakeOrderRow,
    return_status: "returned",
    inspection_status: "approved",
    refund_status: "approved",
    refund_amount: 950,
  };
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000001");
  await getOrderTracking(req, res, { queryFn: createFakeQueryFn(refundingOrder) });

  const order = res.body.order;
  assert.equal(order.return_status, "returned");
  assert.equal(order.inspection_status, "approved");
  assert.equal(order.refund_status, "approved");
  assert.equal(order.refund_amount, 950);
  // refund_reference (the Razorpay refund id) was already excluded before
  // this fix and must remain excluded.
  assert.equal(order.refund_reference, undefined);
});

test("ISSUE-009 regression: order items and status history are still returned in full", async () => {
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000001");
  await getOrderTracking(req, res, { queryFn: createFakeQueryFn(fakeOrderRow) });

  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].product_name, "Bree Fit");
  assert.equal(res.body.history.length, 1);
  assert.equal(res.body.history[0].new_status, "shipped");
});

test("ISSUE-009 regression: an unknown order id still 404s the same way as before", async () => {
  const { req, res } = makeReqRes("00000000-0000-4000-8000-000000000099");
  await getOrderTracking(req, res, { queryFn: createFakeQueryFn(null) });
  assert.equal(res.statusCode, 404);
});
