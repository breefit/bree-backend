import test from "node:test";
import assert from "node:assert/strict";

// Production runs in UTC — pin it so the regression below reproduces the
// incident regardless of the developer machine's timezone. The fix must not
// depend on the process timezone at all.
process.env.TZ = "UTC";
process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";
process.env.DELHIVERY_PICKUP_LOCATION ||= "BREE FIT";

const { schedulePickup, buildPickupRequestPayload } = await import(
  "../src/controllers/shippingController.js"
);
const { default: delhiveryService } = await import(
  "../src/services/delhiveryService.js"
);
const {
  getDefaultPickupDate,
  getIstNowParts,
  isPickupTimeInPastError,
  validatePickupSchedule,
  PICKUP_TIME_IN_PAST,
} = await import("../src/utils/pickupSchedule.js");

/**
 * PRODUCTION INCIDENT — BREE-100019 (order 0efc2f64-ab4f-4462-8cc2-
 * 202a9c80012d, AWB 58045510000055). At ~18:58 IST the backend sent
 * POST /fm/request/new/ with pickup_date 2026-09-30 / pickup_time 14:00:00
 * and Delhivery answered 400 { pickup_time: "Pickup time cannot be in past" }.
 *
 * All clocks here are fixed via schedulePickup's `nowFn` / explicit `now`
 * arguments, so every test is deterministic.
 */

// 2026-09-30 18:59:00 IST
const NOW = new Date("2026-09-30T13:29:00.000Z");
const nowFn = () => new Date(NOW);

const createFakeOrdersDb = (initialOrder) => {
  const orders = new Map([[initialOrder.id, { ...initialOrder }]]);
  const history = [];

  const makeClient = () => ({
    query: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [], rowCount: 0 };
      }

      if (
        normalized.startsWith(
          "SELECT id, order_number, order_status, tracking_status, awb_number, shipment_id, pickup_request_id, shipment_created_at FROM orders WHERE id = ?",
        )
      ) {
        const row = orders.get(params[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      if (
        normalized.startsWith(
          "SELECT COALESCE(SUM(quantity), 1) AS total_quantity FROM order_items WHERE order_id = ?",
        )
      ) {
        return { rows: [{ total_quantity: 1 }], rowCount: 1 };
      }

      if (normalized.startsWith("UPDATE orders SET pickup_request_id = ?")) {
        const [pickupRequestId, trackingStatus, , id] = params;
        const row = orders.get(id);
        if (row) {
          row.pickup_request_id = pickupRequestId;
          row.tracking_status = trackingStatus;
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      if (normalized.startsWith("INSERT INTO order_status_history")) {
        history.push(params);
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled fake SQL in pickup time test: ${normalized}`);
    },
    release: () => {},
  });

  return { getClientFn: async () => makeClient(), orders, history };
};

const makeReqRes = (orderId, body = {}) => {
  const req = { params: { orderId }, body, app: {} };
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

const ORDER_ID = "0efc2f64-ab4f-4462-8cc2-202a9c80012d";
const baseOrder = () => ({
  id: ORDER_ID,
  order_number: "BREE-100019",
  order_status: "shipped",
  tracking_status: "Manifested",
  awb_number: "58045510000055",
  shipment_id: null,
  pickup_request_id: null,
  shipment_created_at: "2026-09-30T08:00:00.000Z",
});

// Records every requestPickup call; each call consumes the next scripted
// outcome ({ ok } resolves, { fail } rejects).
const scriptedDelhivery = (...outcomes) => {
  const calls = [];
  return {
    calls,
    requestPickup: async (payload) => {
      calls.push(payload);
      const outcome = outcomes[Math.min(calls.length, outcomes.length) - 1] || {
        ok: { success: true, request_id: "PICKUP-1" },
      };
      if (outcome.fail) throw outcome.fail;
      return outcome.ok;
    },
  };
};

const runSchedulePickup = async (body, delhivery, now = nowFn) => {
  const db = createFakeOrdersDb(baseOrder());
  const { req, res } = makeReqRes(ORDER_ID, body);
  await schedulePickup(req, res, {
    getClientFn: db.getClientFn,
    delhiveryServiceFn: delhivery,
    nowFn: now,
  });
  return { res, db };
};

// Exactly what delhiveryService.handleError() produces for the production
// response: HTTP 400 { "pickup_time": "Pickup time cannot be in past" }.
const delhiveryPastTimeError = {
  success: false,
  status: 400,
  message: "Bad Request",
  data: { pickup_time: "Pickup time cannot be in past" },
};

// ── Server-side validation before the Delhivery call ───────────────────────

test("today + past time (production payload) -> 400 PICKUP_TIME_IN_PAST, Delhivery never called", async () => {
  const delhivery = scriptedDelhivery();
  const { res, db } = await runSchedulePickup(
    { pickup_date: "2026-09-30", pickup_time: "14:00:00" },
    delhivery,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, PICKUP_TIME_IN_PAST);
  assert.equal(res.body.retryable, false);
  assert.equal(res.body.timezone, "Asia/Kolkata");
  assert.match(res.body.message, /cannot be in the past/i);
  assert.equal(delhivery.calls.length, 0);
  assert.equal(db.orders.get(ORDER_ID).pickup_request_id, null);
});

test("today + future time -> Delhivery called once with that slot", async () => {
  const delhivery = scriptedDelhivery({
    ok: { success: true, request_id: "PICKUP-TODAY" },
  });
  const { res, db } = await runSchedulePickup(
    { pickup_date: "2026-09-30", pickup_time: "20:00:00" },
    delhivery,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(delhivery.calls.length, 1);
  assert.equal(delhivery.calls[0].pickup_date, "2026-09-30");
  assert.equal(delhivery.calls[0].pickup_time, "20:00:00");
  assert.equal(db.orders.get(ORDER_ID).pickup_request_id, "PICKUP-TODAY");
});

test("tomorrow + valid time (even earlier than now's clock time) -> Delhivery called", async () => {
  const delhivery = scriptedDelhivery({
    ok: { success: true, request_id: "PICKUP-TOMORROW" },
  });
  const { res } = await runSchedulePickup(
    { pickup_date: "2026-10-01", pickup_time: "10:00:00" },
    delhivery,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(delhivery.calls.length, 1);
  assert.equal(delhivery.calls[0].pickup_date, "2026-10-01");
});

test("yesterday -> rejected even with a later clock time, Delhivery never called", async () => {
  const delhivery = scriptedDelhivery();
  const { res } = await runSchedulePickup(
    { pickup_date: "2026-09-29", pickup_time: "23:00:00" },
    delhivery,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, PICKUP_TIME_IN_PAST);
  assert.equal(delhivery.calls.length, 0);
});

test("exact boundary: pickup == now (IST) is rejected, now + 1s is accepted", async () => {
  const exact = scriptedDelhivery();
  const { res: exactRes } = await runSchedulePickup(
    { pickup_date: "2026-09-30", pickup_time: "18:59:00" },
    exact,
  );
  assert.equal(exactRes.statusCode, 400);
  assert.equal(exactRes.body.code, PICKUP_TIME_IN_PAST);
  assert.equal(exact.calls.length, 0);

  const hhmm = scriptedDelhivery();
  const { res: hhmmRes } = await runSchedulePickup(
    { pickup_date: "2026-09-30", pickup_time: "18:59" },
    hhmm,
  );
  assert.equal(hhmmRes.statusCode, 400, "HH:mm form must hit the same boundary");
  assert.equal(hhmm.calls.length, 0);

  const oneSecondBefore = scriptedDelhivery();
  const { res: beforeRes } = await runSchedulePickup(
    { pickup_date: "2026-09-30", pickup_time: "18:58:59" },
    oneSecondBefore,
  );
  assert.equal(beforeRes.statusCode, 400);
  assert.equal(oneSecondBefore.calls.length, 0);

  const later = scriptedDelhivery();
  const { res: laterRes } = await runSchedulePickup(
    { pickup_date: "2026-09-30", pickup_time: "18:59:01" },
    later,
  );
  assert.equal(laterRes.statusCode, 200);
  assert.equal(later.calls.length, 1);
});

test("impossible calendar date -> 400 INVALID_PICKUP_DATE_TIME, Delhivery never called", async () => {
  const delhivery = scriptedDelhivery();
  const { res } = await runSchedulePickup(
    { pickup_date: "2026-02-30", pickup_time: "10:00:00" },
    delhivery,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "INVALID_PICKUP_DATE_TIME");
  assert.equal(delhivery.calls.length, 0);
});

// ── Root cause: default pickup date on a UTC server ────────────────────────

test("REGRESSION: default slot at 18:59 IST on a UTC server rolls to tomorrow 14:00 IST", async () => {
  const previous = process.env.DELHIVERY_PICKUP_TIME;
  process.env.DELHIVERY_PICKUP_TIME = "14:00:00";
  try {
    const delhivery = scriptedDelhivery({
      ok: { success: true, request_id: "PICKUP-DEFAULT" },
    });
    // Frontend sends {} — backend picks the slot.
    const { res } = await runSchedulePickup({}, delhivery);

    assert.equal(res.statusCode, 200);
    assert.equal(delhivery.calls.length, 1);
    assert.equal(delhivery.calls[0].pickup_date, "2026-10-01");
    assert.equal(delhivery.calls[0].pickup_time, "14:00:00");
  } finally {
    if (previous === undefined) delete process.env.DELHIVERY_PICKUP_TIME;
    else process.env.DELHIVERY_PICKUP_TIME = previous;
  }
});

test("default pickup date is resolved in Asia/Kolkata, independent of process TZ", () => {
  // 10:00 IST -> 14:00 still ahead today
  assert.equal(
    getDefaultPickupDate("14:00:00", new Date("2026-09-30T04:30:00Z")),
    "2026-09-30",
  );
  // 18:58 IST (13:28 UTC — before 14:00 UTC) -> tomorrow
  assert.equal(
    getDefaultPickupDate("14:00:00", new Date("2026-09-30T13:28:00Z")),
    "2026-10-01",
  );
  // exactly 14:00:00 IST -> not in the future -> tomorrow
  assert.equal(
    getDefaultPickupDate("14:00:00", new Date("2026-09-30T08:30:00Z")),
    "2026-10-01",
  );
  // 00:30 IST on Oct 1 (still Sep 30 in UTC) -> Oct 1 14:00
  assert.equal(
    getDefaultPickupDate("14:00:00", new Date("2026-09-30T19:00:00Z")),
    "2026-10-01",
  );
  // year rollover: 31 Dec 20:00 IST -> 1 Jan
  assert.equal(
    getDefaultPickupDate("14:00:00", new Date("2026-12-31T14:30:00Z")),
    "2027-01-01",
  );
  assert.deepEqual(getIstNowParts(new Date("2026-09-30T13:29:00Z")), {
    date: "2026-09-30",
    time: "18:59:00",
  });
});

test("buildPickupRequestPayload default never produces a past slot", () => {
  const payload = buildPickupRequestPayload(
    { pickupLocation: "BREE FIT" },
    { pickup_time: "14:00:00" },
    1,
    NOW,
  );
  assert.equal(validatePickupSchedule(payload, NOW), null);
  assert.equal(payload.pickup_date, "2026-10-01");
});

// ── Delhivery's own "in past" rejection is permanent ───────────────────────

test("Delhivery 400 pickup_time-in-past -> PICKUP_TIME_IN_PAST, requestPickup called exactly once (no retry)", async () => {
  // Local validation passes (slot is ahead of our clock) but Delhivery still
  // rejects it, e.g. clock skew — must be surfaced as permanent, not retried.
  const delhivery = scriptedDelhivery(
    { fail: delhiveryPastTimeError },
    { ok: { success: true, request_id: "SHOULD-NOT-BE-USED" } },
  );
  const { res, db } = await runSchedulePickup(
    { pickup_date: "2026-09-30", pickup_time: "19:00:00" },
    delhivery,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, PICKUP_TIME_IN_PAST);
  assert.equal(res.body.retryable, false);
  assert.equal(res.body.errorCategory, "invalid_or_expired_pickup_time");
  assert.deepEqual(res.body.delhiveryError, {
    pickup_time: "Pickup time cannot be in past",
  });
  assert.equal(delhivery.calls.length, 1, "permanent error must not be retried");
  assert.equal(db.orders.get(ORDER_ID).pickup_request_id, null);
  assert.equal(db.history.length, 0);
});

test("Delhivery non-throwing response with pickup_time-in-past -> PICKUP_TIME_IN_PAST", async () => {
  const delhivery = scriptedDelhivery({
    ok: { success: false, pickup_time: "Pickup time cannot be in past" },
  });
  const { res } = await runSchedulePickup(
    { pickup_date: "2026-09-30", pickup_time: "19:00:00" },
    delhivery,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, PICKUP_TIME_IN_PAST);
  assert.equal(delhivery.calls.length, 1);
});

// ── Transient failures keep existing behavior ──────────────────────────────

test("transient Delhivery failure (timeout / 503) -> existing error response, not PICKUP_TIME_IN_PAST, and a later attempt still succeeds", async () => {
  const timeout = scriptedDelhivery({
    fail: {
      success: false,
      message: "No response received from Delhivery.",
      code: "ECONNABORTED",
    },
  });
  const { res: timeoutRes, db } = await runSchedulePickup(
    { pickup_date: "2026-10-01", pickup_time: "14:00:00" },
    timeout,
  );
  // Existing behavior: formatDelhiveryPickupError defaults to 502, one call,
  // no automatic retry anywhere in the stack, order left schedulable.
  assert.equal(timeoutRes.statusCode, 502);
  assert.notEqual(timeoutRes.body.code, PICKUP_TIME_IN_PAST);
  assert.match(timeoutRes.body.message, /Delhivery rejected the pickup request/);
  assert.equal(timeout.calls.length, 1);
  assert.equal(db.orders.get(ORDER_ID).pickup_request_id, null);

  const unavailable = scriptedDelhivery({
    fail: {
      success: false,
      status: 503,
      message: "Service Unavailable",
      data: "upstream unavailable",
    },
  });
  const { res: unavailableRes } = await runSchedulePickup(
    { pickup_date: "2026-10-01", pickup_time: "14:00:00" },
    unavailable,
  );
  assert.equal(unavailableRes.statusCode, 503);
  assert.notEqual(unavailableRes.body.code, PICKUP_TIME_IN_PAST);
  assert.equal(unavailable.calls.length, 1);

  // Manual re-attempt after a transient failure keeps working.
  const recovered = scriptedDelhivery({
    ok: { success: true, request_id: "PICKUP-RECOVERED" },
  });
  const { res: recoveredRes } = await runSchedulePickup(
    { pickup_date: "2026-10-01", pickup_time: "14:00:00" },
    recovered,
  );
  assert.equal(recoveredRes.statusCode, 200);
  assert.equal(recoveredRes.body.order.pickupRequestId, "PICKUP-RECOVERED");
});

test("existing duplicate-pickup recovery is unaffected", async () => {
  const delhivery = scriptedDelhivery({
    fail: {
      success: false,
      status: 400,
      data: { pr_exist: true, pickup_id: 319322489 },
    },
  });
  const { res } = await runSchedulePickup(
    { pickup_date: "2026-10-01", pickup_time: "14:00:00" },
    delhivery,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.pickupRequestId, 319322489);
});

// ── Detection + service-level backstop ─────────────────────────────────────

test("isPickupTimeInPastError only matches the permanent past-time rejection", () => {
  assert.equal(isPickupTimeInPastError(delhiveryPastTimeError), true);
  assert.equal(
    isPickupTimeInPastError({ data: { pickup_time: ["Pickup time cannot be in past"] } }),
    true,
  );
  assert.equal(isPickupTimeInPastError({ code: PICKUP_TIME_IN_PAST }), true);
  assert.equal(
    isPickupTimeInPastError({ message: "No response received from Delhivery.", code: "ECONNABORTED" }),
    false,
  );
  assert.equal(isPickupTimeInPastError({ status: 503, data: "upstream unavailable" }), false);
  assert.equal(isPickupTimeInPastError({ data: { message: "Insufficient wallet balance" } }), false);
  assert.equal(isPickupTimeInPastError(null), false);
});

test("delhiveryService backstop: a past slot is rejected before any HTTP call", async () => {
  const payload = {
    pickup_location: "BREE FIT",
    expected_package_count: 1,
    pickup_date: "2026-09-30",
    pickup_time: "14:00:00",
  };
  const validation = delhiveryService.validatePickupPayload(payload, NOW);
  assert.equal(validation.code, PICKUP_TIME_IN_PAST);
  assert.equal(validation.status, 400);

  assert.equal(
    delhiveryService.validatePickupPayload(
      { ...payload, pickup_date: "2026-10-01" },
      NOW,
    ),
    null,
  );

  // requestPickup() uses the real clock; a 2020 slot is past on any clock,
  // and validation throws before client.post() is reached.
  await assert.rejects(
    delhiveryService.requestPickup({ ...payload, pickup_date: "2020-01-01" }),
    (error) => error.code === PICKUP_TIME_IN_PAST && error.status === 400,
  );
});
