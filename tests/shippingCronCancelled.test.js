import test from "node:test";
import assert from "node:assert/strict";

process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";

const { syncShippingTracking, ACTIVE_FORWARD_SHIPMENTS_WHERE } = await import(
  "../cron/shippingTrackingCron.js"
);
const { cancelShipment } = await import("../src/controllers/shippingController.js");

/**
 * PRODUCTION INCIDENT — BREE-100019 / AWB 58045510000055: after a successful
 * Cancel Shipment, SHIPPING_CRON at 19:30 IST still logged "Processing
 * order ...", called Delhivery tracking and wrote back "Not Picked".
 *
 * Drives the REAL syncShippingTracking and cancelShipment against one
 * shared in-memory orders table:
 *  - SELECT: "spec" mode returns what ACTIVE_FORWARD_SHIPMENTS_WHERE
 *    describes; "leaky" mode returns every AWB row (the old
 *    tracking_status-only query / a stale snapshot) so the per-row and
 *    UPDATE guards are proven on their own.
 *  - UPDATE: applies the statement's own WHERE guards (cancellation guard,
 *    `order_status = ?`) against the CURRENT row, like MySQL does.
 * Orders carry no email/phone, so no notification is ever sent.
 */

const norm = (sql) => sql.replace(/\s+/g, " ").trim();
const isCancelledRow = (row) =>
  row.order_status === "cancelled" ||
  String(row.tracking_status || "").trim().toLowerCase() === "cancelled";

const createDb = (rows, { selectMode = "spec" } = {}) => {
  const orders = new Map(rows.map((row) => [row.id, { ...row }]));
  const history = [];
  const reminders = new Map(); // orderId -> [reminderId]

  const run = async (sql, params = []) => {
    const q = norm(sql);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [], rowCount: 0 };

    if (q === "SHOW COLUMNS FROM orders") return { rows: [], rowCount: 0 };

    if (q.startsWith("SELECT id, order_number, order_status, awb_number, tracking_status")) {
      assert.ok(q.includes(norm(ACTIVE_FORWARD_SHIPMENTS_WHERE)), "cron must select with ACTIVE_FORWARD_SHIPMENTS_WHERE");
      const selected = [...orders.values()].filter((row) => {
        if (!row.awb_number) return false;
        if (selectMode === "leaky") return true;
        const tracking = String(row.tracking_status || "").trim().toLowerCase();
        return !["delivered", "cancelled", "returned"].includes(tracking) && row.order_status !== "cancelled";
      });
      return { rows: selected.map((row) => ({ ...row })), rowCount: selected.length };
    }

    // cancelShipment's own read
    if (q.startsWith("SELECT id, order_number, order_status, tracking_status, awb_number")) {
      const row = orders.get(params[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    if (q.startsWith("UPDATE orders SET")) {
      const setClause = q.slice("UPDATE orders SET ".length, q.indexOf(" WHERE "));
      const whereClause = q.slice(q.indexOf(" WHERE "));
      const setColumns = setClause
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.endsWith("= ?"))
        .map((part) => part.replace(/\s*=\s*\?$/, ""));
      const whereParams = params.slice(setColumns.length);
      const row = orders.get(whereParams[0]);
      if (!row) return { rows: [], rowCount: 0 };
      if (whereClause.includes("<> 'cancelled'") && isCancelledRow(row)) {
        return { rows: [], rowCount: 0 };
      }
      if (whereClause.includes("AND order_status = ?") && row.order_status !== whereParams[1]) {
        return { rows: [], rowCount: 0 };
      }
      setColumns.forEach((column, index) => {
        row[column] = params[index];
      });
      if (setClause.includes("delivered_at = NOW()")) row.delivered_at = "NOW";
      if (setClause.includes("tracking_sync_failure_count = 0")) row.tracking_sync_failure_count = 0;
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("INSERT INTO order_status_history")) {
      history.push(params);
      return { rows: [], rowCount: 1 };
    }

    if (q.startsWith("SELECT id FROM daily_reminders")) {
      const ids = reminders.get(params[0]) || [];
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    }

    // Cancel Shipment's row lock + reminder stop.
    if (q === "SELECT id FROM orders WHERE id = ? FOR UPDATE") {
      return { rows: orders.has(params[0]) ? [{ id: params[0] }] : [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE daily_reminders SET reminder_enabled = 0, status = 'ended'")) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unhandled fake SQL in shippingCronCancelled test: ${q}`);
  };

  return {
    queryFn: run,
    getClientFn: async () => ({ query: run, release: () => {} }),
    orders,
    history,
    reminders,
  };
};

const tracking = (status) => ({
  ShipmentData: [
    {
      Shipment: {
        AWB: "any",
        Status: { Status: status, StatusType: "UD", StatusDateTime: "2026-09-30T19:18:06.381" },
        Scans: [],
      },
    },
  ],
});

const fakeDelhivery = (statusByAwb, { onTrack } = {}) => {
  const calls = [];
  return {
    calls,
    trackShipment: async (awb) => {
      calls.push(awb);
      if (onTrack) await onTrack(awb);
      return tracking(statusByAwb[awb]);
    },
    cancelShipment: async () => ({ status: true, remark: "Shipment has been cancelled" }),
  };
};

const order = (overrides) => ({
  order_number: "BREE-TEST",
  contact_name: null,
  customer_name: null,
  email: null,
  contact_email: null,
  mobile_number: null,
  contact_phone: null,
  tracking_url: null,
  courier_name: "Delhivery",
  tracking_sync_failure_count: 0,
  delivered_at: null,
  ...overrides,
});

const BREE_100019 = order({
  id: "0efc2f64-ab4f-4462-8cc2-202a9c80012d",
  order_number: "BREE-100019",
  awb_number: "58045510000055",
  order_status: "cancelled",
  tracking_status: "Not Picked", // production state after the overwrite
});

const runCron = (db, delhivery, activations = []) =>
  syncShippingTracking({
    queryFn: db.queryFn,
    delhiveryServiceFn: delhivery,
    activateReminderFn: async (args) => {
      activations.push(args);
      return { success: true };
    },
  });

// ── cancelled order with AWB is excluded ────────────────────────────────

test("cancelled order with AWB (BREE-100019 production state) is not selected, tracked, updated or activated", async () => {
  const db = createDb([BREE_100019]);
  db.reminders.set(BREE_100019.id, ["reminder-1"]);
  const delhivery = fakeDelhivery({ "58045510000055": "Not Picked" });
  const activations = [];

  await runCron(db, delhivery, activations);

  assert.deepEqual(delhivery.calls, [], "Delhivery tracking must not be called");
  const row = db.orders.get(BREE_100019.id);
  assert.equal(row.order_status, "cancelled");
  assert.equal(row.tracking_status, "Not Picked", "row left exactly as it was");
  assert.equal(db.history.length, 0);
  assert.equal(activations.length, 0);
});

test("even if a cancelled row is handed to the loop (old query / stale snapshot), it is skipped before any Delhivery call", async () => {
  const db = createDb(
    [BREE_100019, order({ id: "c2", awb_number: "AWB-C2", order_status: "cancelled", tracking_status: "Cancelled" })],
    { selectMode: "leaky" },
  );
  const delhivery = fakeDelhivery({ "58045510000055": "Delivered", "AWB-C2": "Delivered" });
  const activations = [];

  await runCron(db, delhivery, activations);

  assert.deepEqual(delhivery.calls, []);
  assert.equal(db.orders.get(BREE_100019.id).order_status, "cancelled");
  assert.equal(db.orders.get("c2").tracking_status, "Cancelled");
  assert.equal(activations.length, 0);
});

// ── active shipments keep working ───────────────────────────────────────

test("active manifested order (ready_to_ship, AWB, not picked up) is tracked and stays ready_to_ship", async () => {
  const db = createDb([order({ id: "m1", awb_number: "AWB-M1", order_status: "ready_to_ship", tracking_status: "Manifested" })]);
  const delhivery = fakeDelhivery({ "AWB-M1": "Not Picked" });

  await runCron(db, delhivery);

  assert.deepEqual(delhivery.calls, ["AWB-M1"]);
  const row = db.orders.get("m1");
  assert.equal(row.tracking_status, "Not Picked");
  assert.equal(row.order_status, "ready_to_ship", "failed pickup is not shipped");
  assert.equal(db.history.length, 0);
});

test("active manifested order advances to shipped once Delhivery reports it in transit", async () => {
  const db = createDb([order({ id: "m2", awb_number: "AWB-M2", order_status: "ready_to_ship", tracking_status: "Manifested" })]);
  const delhivery = fakeDelhivery({ "AWB-M2": "In Transit" });

  await runCron(db, delhivery);

  assert.equal(db.orders.get("m2").order_status, "shipped");
  assert.equal(db.history.length, 1);
});

test("active in-transit order is tracked; delivery advances status, stamps delivered_at and activates reminders", async () => {
  const db = createDb([order({ id: "t1", awb_number: "AWB-T1", order_status: "shipped", tracking_status: "In Transit" })]);
  db.reminders.set("t1", ["reminder-t1"]);
  const delhivery = fakeDelhivery({ "AWB-T1": "Delivered" });
  const activations = [];

  await runCron(db, delhivery, activations);

  assert.deepEqual(delhivery.calls, ["AWB-T1"]);
  const row = db.orders.get("t1");
  assert.equal(row.order_status, "delivered");
  assert.equal(row.tracking_status, "Delivered");
  assert.equal(row.delivered_at, "NOW");
  assert.equal(activations.length, 1);
  assert.equal(activations[0].reminderId, "reminder-t1");
});

// ── cancellation after AWB creation stops future tracking ───────────────

test("cancellation after AWB creation stops all future tracking, even though Delhivery then reports 'Not Picked'", async () => {
  const db = createDb([order({ id: "x1", order_number: "BREE-X1", awb_number: "AWB-X1", order_status: "ready_to_ship", tracking_status: "Manifested" })]);
  const delhivery = fakeDelhivery({ "AWB-X1": "Manifested" });

  await runCron(db, delhivery);
  assert.deepEqual(delhivery.calls, ["AWB-X1"], "tracked while active");

  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await cancelShipment({ params: { orderId: "x1" }, body: {}, app: {} }, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: delhivery,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(db.orders.get("x1").order_status, "cancelled");

  // Delhivery's post-cancel status for an unpicked AWB.
  delhivery.calls.length = 0;
  const activations = [];
  const statusByAwb = { "AWB-X1": "Not Picked" };
  await runCron(db, fakeDelhivery(statusByAwb), activations);
  await runCron(db, { ...fakeDelhivery(statusByAwb), trackShipment: async () => assert.fail("must not track a cancelled shipment") });

  const row = db.orders.get("x1");
  assert.equal(row.tracking_status, "Cancelled");
  assert.equal(row.order_status, "cancelled");
  assert.equal(activations.length, 0);
});

test("cancellation committed WHILE the cron is mid-run: Delhivery's 'Not Picked' is not written over 'Cancelled' (the BREE-100019 overwrite)", async () => {
  const db = createDb([order({ id: "r0", order_number: "BREE-R0", awb_number: "AWB-R0", order_status: "ready_to_ship", tracking_status: "Manifested" })]);
  const delhivery = fakeDelhivery(
    { "AWB-R0": "Not Picked" },
    {
      onTrack: async () => {
        const row = db.orders.get("r0");
        row.order_status = "cancelled";
        row.tracking_status = "Cancelled";
      },
    },
  );

  await runCron(db, delhivery);

  const row = db.orders.get("r0");
  assert.equal(row.tracking_status, "Cancelled");
  assert.equal(row.order_status, "cancelled");

  // …so the next tick does not select it either.
  await runCron(db, { trackShipment: async () => assert.fail("must not track a cancelled shipment") });
});

test("cancellation committed WHILE the cron is mid-run is not overwritten, advanced or activated", async () => {
  const db = createDb([order({ id: "r1", order_number: "BREE-R1", awb_number: "AWB-R1", order_status: "shipped", tracking_status: "In Transit" })]);
  db.reminders.set("r1", ["reminder-r1"]);
  const activations = [];
  // The cron already holds its (now stale) snapshot; the admin cancels
  // between the SELECT and the cron's UPDATE. Worst case: Delhivery says
  // "Delivered".
  const delhivery = fakeDelhivery(
    { "AWB-R1": "Delivered" },
    {
      onTrack: async () => {
        const row = db.orders.get("r1");
        row.order_status = "cancelled";
        row.tracking_status = "Cancelled";
      },
    },
  );

  await runCron(db, delhivery, activations);

  assert.deepEqual(delhivery.calls, ["AWB-R1"]);
  const row = db.orders.get("r1");
  assert.equal(row.tracking_status, "Cancelled", "tracking must not overwrite the cancellation");
  assert.equal(row.order_status, "cancelled", "status must not advance");
  assert.equal(row.delivered_at, null);
  assert.equal(db.history.length, 0);
  assert.equal(activations.length, 0, "delivery activation must not run");
});
