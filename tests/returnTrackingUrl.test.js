import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDelhiveryShipmentDetails,
  DEFAULT_DELHIVERY_TRACKING_URL,
} from "../src/controllers/shippingController.js";
import { getOrderTracking } from "../src/controllers/orderController.js";
import {
  normalizeReverseTrackingStatus,
  returnStatusProvenBy,
  syncReverseShipmentTracking,
} from "../src/services/reverseShipmentTracking.js";
import { orderRouter } from "../src/routes/index.js";

/**
 * Return-tracking URL investigation — the admin "Reverse Tracking URL →
 * Track" link for the LEGACY return BREE-100018 / reverse AWB
 * 58045510000044 (created before the reverse-pickup fix, Delhivery status
 * UD/Manifested).
 *
 * The link is a plain <a href={reverse_tracking_url}> to Delhivery. It was
 * stored as `https://tracking.delhivery.com/track/shipment/<awb>` — the old
 * default base, whose host has no DNS record (NXDOMAIN), so the link could
 * never load. These tests pin the fixed default and the reverse/forward
 * separation around it. No database and no real Delhivery call: every
 * query and every Delhivery response is a fixture.
 */

const LEGACY_REVERSE_AWB = "58045510000044";
const FORWARD_AWB = "58045510000011";
const ORDER_ID = "00000000-0000-4000-8000-000000000018";

const withTrackingEnv = async (value, fn) => {
  const previous = process.env.DELHIVERY_TRACKING_URL;
  if (value === undefined) delete process.env.DELHIVERY_TRACKING_URL;
  else process.env.DELHIVERY_TRACKING_URL = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DELHIVERY_TRACKING_URL;
    else process.env.DELHIVERY_TRACKING_URL = previous;
  }
};

// ── Tracking URL generation ─────────────────────────────────────────────────

test("C: reverse AWB 58045510000044 → Delhivery public tracking page for exactly that AWB", async () => {
  await withTrackingEnv(undefined, () => {
    const parsed = extractDelhiveryShipmentDetails({ packages: [{ waybill: LEGACY_REVERSE_AWB }] });
    assert.equal(parsed.success, true);
    assert.equal(parsed.awbNumber, LEGACY_REVERSE_AWB);
    assert.equal(parsed.trackingUrl, `https://www.delhivery.com/track-v2/package/${LEGACY_REVERSE_AWB}`);
  });
});

test("regression: the default tracking base is no longer the unresolvable tracking.delhivery.com host", () => {
  const host = new URL(DEFAULT_DELHIVERY_TRACKING_URL).hostname;
  assert.equal(host, "www.delhivery.com");
  assert.notEqual(host, "tracking.delhivery.com");
});

test("A: forward shipment URL uses the same builder and its own AWB; DELHIVERY_TRACKING_URL still overrides", async () => {
  await withTrackingEnv("https://example.test/t/", () => {
    const parsed = extractDelhiveryShipmentDetails({ packages: [{ waybill: FORWARD_AWB }] });
    assert.equal(parsed.trackingUrl, `https://example.test/t/${FORWARD_AWB}`);
  });
});

test("E: a Delhivery response without an AWB yields no tracking URL (never a URL ending in 'null')", () => {
  const parsed = extractDelhiveryShipmentDetails({ packages: [{ status: "Fail" }] });
  assert.equal(parsed.success, false);
  assert.equal(parsed.trackingUrl, undefined);
});

// ── Public customer tracking API ────────────────────────────────────────────

const legacyReturnRow = {
  id: ORDER_ID,
  order_number: "BREE-100018",
  order_status: "delivered",
  payment_status: "paid",
  shipping_address: "Flat 1, Test Street, Pune 411001",
  subtotal: 900,
  shipping: 0,
  tax: 0,
  total: 900,
  is_free_shipping: 1,
  shipping_charge: 0,
  estimated_delivery: null,
  created_at: new Date("2026-09-20T10:00:00+05:30"),
  delivered_at: new Date("2026-09-24T10:00:00+05:30"),
  return_status: "reverse_shipment_created",
  return_requested_at: new Date("2026-09-25T10:00:00+05:30"),
  return_approved_at: new Date("2026-09-25T10:05:00+05:30"),
  reverse_awb: LEGACY_REVERSE_AWB,
  reverse_tracking_url: `https://tracking.delhivery.com/track/shipment/${LEGACY_REVERSE_AWB}`,
  reverse_shipment_created_at: new Date("2026-09-25T10:10:00+05:30"),
  reverse_pickup_request_id: null,
  returned_at: null,
  reverse_shipment_type: null, // legacy: created before the RVP fix
  reverse_tracking_status: "unknown",
  reverse_tracking_raw_status: "UD/Manifested",
  reverse_tracking_updated_at: new Date("2026-09-28T09:30:00+05:30"),
  reverse_pickup_scheduled_at: null,
  reverse_picked_up_at: null,
  reverse_delivered_at: null,
  returned_source: null,
  inspection_completed_at: null,
  refund_approved_at: null,
  inspection_status: null,
  refund_status: null,
  refund_amount: null,
  refund_completed_at: null,
  parent_package_id: null,
  fulfillment_cycle: null,
  package_number: null,
  package_total_cycles: null,
  contact_name: "Test Customer",
  contact_email: "customer@example.test",
  ua_full_name: "Test Customer",
  ua_phone: "9000000000",
  ua_address_line_1: "Flat 1",
  ua_address_line_2: "Test Street",
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

const fakeTrackingQuery = (row) => async (sql) => {
  if (sql.includes("SELECT DATABASE()")) return { rows: [{ db: "bree_test" }] };
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
  if (sql.includes("FROM orders o")) return { rows: row ? [row] : [] };
  if (sql.includes("FROM order_items")) return { rows: [] };
  if (sql.includes("FROM order_status_history")) return { rows: [] };
  if (sql.includes("FROM daily_reminders")) return { rows: [] };
  throw new Error(`Unhandled fake SQL: ${sql}`);
};

const callTracking = async (id, row, user) => {
  const req = { params: { id }, ...(user ? { user } : {}) };
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
  await getOrderTracking(req, res, { queryFn: fakeTrackingQuery(row) });
  return res;
};

test("B/F/G: logged-out request for the legacy return resolves reverse_awb 58045510000044, not the forward AWB", async () => {
  const res = await callTracking(ORDER_ID, { ...legacyReturnRow, awb_number: FORWARD_AWB });
  assert.equal(res.statusCode, 200);
  const { order } = res.body;
  assert.equal(order.reverse_awb, LEGACY_REVERSE_AWB);
  assert.notEqual(order.reverse_awb, FORWARD_AWB);
  assert.equal(order.reverse_shipment_type, null, "legacy shipment stays identifiable as legacy");
  assert.equal(order.reverse_tracking_raw_status, "UD/Manifested");
  assert.equal(order.return_status, "reverse_shipment_created", "UD/Manifested never reads as returned");
  assert.equal(order.returned_at, null);
});

test("6: the public tracking response carries no raw Delhivery payload, phone, internal ids or payment references", async () => {
  const res = await callTracking(ORDER_ID, {
    ...legacyReturnRow,
    user_id: "internal-user",
  });
  const json = JSON.stringify(res.body);
  for (const forbidden of [
    "reverse_delhivery_response",
    "delhivery_response",
    "user_id",
    "ua_phone",
    "9000000000",
    "refund_reference",
    "razorpay",
    "return_approved_by",
    "return_notes",
  ]) {
    assert.ok(!json.includes(forbidden), `response must not contain ${forbidden}`);
  }
  for (const key of Object.keys(res.body.order)) {
    assert.ok(!/^(ua|la)_/.test(key), `structured address column ${key} leaked`);
  }
});

test("D: invalid tracking id → 400; unknown well-formed id → 404", async () => {
  assert.equal((await callTracking("not-a-uuid", legacyReturnRow)).statusCode, 400);
  assert.equal((await callTracking(ORDER_ID, null)).statusCode, 404);
});

test("E: an approved return without a reverse shipment exposes no reverse AWB or tracking URL", async () => {
  const res = await callTracking(ORDER_ID, {
    ...legacyReturnRow,
    return_status: "approved",
    reverse_awb: null,
    reverse_tracking_url: null,
    reverse_tracking_status: null,
    reverse_tracking_raw_status: null,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.reverse_awb, null);
  assert.equal(res.body.order.reverse_tracking_url, null);
});

test("F/N/O: GET /api/orders/:id/tracking is mounted with optionalAuth only — no auth/adminAuth wall", () => {
  const layer = orderRouter.stack.find(
    (l) => l.route?.path === "/:id/tracking" && l.route.methods.get,
  );
  assert.ok(layer, "tracking route exists");
  const names = layer.route.stack.map((s) => s.handle.name);
  assert.deepEqual(names, ["optionalAuth", "getOrderTracking"]);
});

// ── UD/Manifested classification ───────────────────────────────────────────

test("H/7: UD/Manifested (and other unmapped statuses) normalize to unknown and prove no return_status", () => {
  for (const [type, status] of [
    ["UD", "Manifested"],
    ["UD", "In Transit"],
    ["DL", "Delivered"],
    ["RT", "RTO"],
    [null, "Manifested"],
    ["ZZ", "Brand New Status"],
  ]) {
    const normalized = normalizeReverseTrackingStatus(type, status);
    assert.equal(normalized, "unknown", `${type}/${status}`);
    assert.equal(returnStatusProvenBy(normalized), null, `${type}/${status}`);
  }
});

// ── Reverse tracking cron against mocked Delhivery ──────────────────────────

const legacyTrackableRow = {
  id: ORDER_ID,
  order_number: "BREE-100018",
  order_status: "delivered",
  return_status: "reverse_shipment_created",
  reverse_awb: LEGACY_REVERSE_AWB,
  reverse_shipment_type: null,
  reverse_tracking_status: null,
  reverse_delivered_at: null,
  reverse_tracking_failure_count: 0,
};

const delhiveryTracking = (statusType, status) => ({
  ShipmentData: [
    {
      Shipment: {
        AWB: LEGACY_REVERSE_AWB,
        Status: { Status: status, StatusType: statusType, StatusDateTime: "2026-09-28T09:30:00" },
        Scans: [],
      },
    },
  ],
});

const runSync = async (row, trackShipment) => {
  const sqls = [];
  const trackedAwbs = [];
  const notifications = [];
  const history = [];
  const queryFn = async (sql, params = []) => {
    sqls.push({ sql, params });
    if (sql.includes("FROM orders") && sql.includes("reverse_awb IS NOT NULL")) return { rows: [row] };
    if (sql.startsWith("SELECT * FROM orders")) return { rows: [row] };
    return { rows: [], rowCount: 1 };
  };
  const summary = await syncReverseShipmentTracking({
    queryFn,
    trackShipment: async (awb) => {
      trackedAwbs.push(awb);
      return trackShipment(awb);
    },
    notify: (...args) => notifications.push(args),
    historyFn: async (entry) => history.push(entry),
  });
  const updates = sqls.filter(({ sql }) => /^\s*UPDATE/i.test(sql));
  return { summary, trackedAwbs, notifications, history, updates };
};

// Forward-shipment columns the reverse pass must never assign.
const FORWARD_ASSIGNMENT =
  /(?<![a-z_])(awb_number|tracking_status|tracking_url|tracking_number|delhivery_response|order_status|delivered_at|current_location)\s*=/i;

test("G/8/11/L: legacy reverse AWB with UD/Manifested is tracked by reverse_awb, recorded as unknown, and never changes return_status or forward fields", async () => {
  const { summary, trackedAwbs, notifications, history, updates } = await runSync(
    legacyTrackableRow,
    async () => delhiveryTracking("UD", "Manifested"),
  );
  assert.deepEqual(trackedAwbs, [LEGACY_REVERSE_AWB]);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.transitioned, 0);
  assert.equal(notifications.length, 0, "no 'Return Received' / pickup notification");
  assert.equal(history.length, 0);
  assert.equal(updates.length, 1, "exactly one observation write");
  const [{ sql, params }] = updates;
  assert.ok(!/return_status\s*=/.test(sql), "return_status untouched");
  assert.ok(!/returned_at\s*=/.test(sql), "returned_at untouched");
  assert.ok(!FORWARD_ASSIGNMENT.test(sql), "no forward column written");
  assert.equal(params[0], "unknown");
  assert.equal(params[1], "UD/Manifested");
  assert.deepEqual(params.slice(3, 6), [0, 0, 0], "no pickup/picked-up/delivered milestone recorded");
});

test("8: even DL/DTO on a LEGACY shipment cannot mark the return received", async () => {
  const { summary, notifications, updates } = await runSync(legacyTrackableRow, async () =>
    delhiveryTracking("DL", "DTO"),
  );
  assert.equal(summary.transitioned, 0);
  assert.equal(notifications.length, 0);
  assert.ok(updates.every(({ sql }) => !/return_status\s*=/.test(sql)));
});

for (const [label, failure] of [
  ["I: timeout", () => Promise.reject(Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" }))],
  ["J: 4xx", () => Promise.reject(Object.assign(new Error("Unauthorized"), { status: 401 }))],
  ["K: 5xx", () => Promise.reject(Object.assign(new Error("Internal Server Error"), { status: 503 }))],
  ["K: success:false body", () => Promise.resolve({ success: false, status: 500, message: "upstream" })],
]) {
  test(`${label} from Delhivery → only reverse_tracking_failure_count increments`, async () => {
    const { summary, notifications, updates } = await runSync(legacyTrackableRow, failure);
    assert.equal(summary.failed, 1);
    assert.equal(summary.transitioned, 0);
    assert.equal(notifications.length, 0);
    assert.equal(updates.length, 1);
    assert.match(updates[0].sql, /SET reverse_tracking_failure_count = reverse_tracking_failure_count \+ 1/);
  });
}
