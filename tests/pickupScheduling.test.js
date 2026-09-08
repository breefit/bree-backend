import test from "node:test";
import assert from "node:assert/strict";

process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";

const {
  buildPickupRequestPayload,
  extractPickupRequestId,
  formatDelhiveryPickupError,
  hasPickupShipmentReference,
  isValidPickupRequestId,
} = await import("../src/controllers/shippingController.js");

const warehouse = { pickupLocation: "BREE FIT" };

test("builds the Delhivery pickup request with the registered location", () => {
  assert.deepEqual(
    buildPickupRequestPayload(
      warehouse,
      {
        expected_package_count: 2,
        pickup_date: "2026-09-09",
        pickup_time: "10:00:00",
      },
      1,
    ),
    {
      pickup_location: "BREE FIT",
      expected_package_count: 2,
      pickup_date: "2026-09-09",
      pickup_time: "10:00:00",
    },
  );
});

test("defaults a past pickup time to the next day", () => {
  const payload = buildPickupRequestPayload(warehouse, {
    pickup_time: "00:00:00",
  });

  assert.match(payload.pickup_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(payload.pickup_time, "00:00:00");
});

test("extracts a successful pickup request ID", () => {
  assert.equal(
    extractPickupRequestId({ data: { request_id: "PICKUP-123" } }),
    "PICKUP-123",
  );
});

test("rejects a Delhivery success response without a pickup request ID", () => {
  assert.equal(
    extractPickupRequestId({ success: true, message: "Accepted" }),
    null,
  );
});

test("detects duplicate and missing pickup scheduling state", () => {
  assert.equal(isValidPickupRequestId("PICKUP-123"), true);
  assert.equal(isValidPickupRequestId("  "), false);
  assert.equal(isValidPickupRequestId(null), false);
});

test("requires both the existing AWB and shipment reference", () => {
  assert.equal(
    hasPickupShipmentReference({
      awb_number: "58045510000022",
      shipment_id: "UPL123",
    }),
    true,
  );
  assert.equal(
    hasPickupShipmentReference({
      awb_number: "58045510000022",
      shipment_id: null,
    }),
    false,
  );
});

test("preserves the Delhivery 400 status and response body", () => {
  const formatted = formatDelhiveryPickupError({
    status: 400,
    message: "Bad Request",
    data: { rmk: "Pickup time has already passed" },
  });

  assert.equal(formatted.status, 400);
  assert.equal(formatted.message, "Pickup time has already passed");
  assert.deepEqual(formatted.delhiveryError, {
    rmk: "Pickup time has already passed",
  });
});
