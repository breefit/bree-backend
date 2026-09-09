import test from "node:test";
import assert from "node:assert/strict";

process.env.DELHIVERY_BASE_URL ||= "https://delhivery.test";
process.env.DELHIVERY_API_TOKEN ||= "test-token";

const {
  buildPickupRequestPayload,
  classifyDelhiveryPickupError,
  extractPickupRequestId,
  formatExistingPickupMessage,
  formatDelhiveryPickupError,
  formatStoredPickupMessage,
  hasPickupShipmentReference,
  isExistingPickupResponse,
  shouldRequestPickup,
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

const existingPickupResponse = {
  success: false,
  message: "Delhivery API returned an error",
  delhiveryError: {
    data: {
      message:
        "A Pickup Request 319322489 for this Pickup Location Already Exist for 09 Sep in slot 14:00 - 18:00",
    },
    pr_exist: true,
    pickup_id: 319322489,
    error: {
      code: 669,
      message:
        "A Pickup Request 319322489 for this Pickup Location Already Exist for 09 Sep in slot 14:00 - 18:00",
    },
    success: false,
    status: true,
  },
};

test("recognizes a provider-reported existing pickup and persists its ID", () => {
  assert.equal(isExistingPickupResponse(existingPickupResponse), true);
  assert.equal(extractPickupRequestId(existingPickupResponse), 319322489);
  assert.equal(
    formatExistingPickupMessage(existingPickupResponse, 319322489),
    "Pickup is already scheduled for this location on 09 Sep, 14:00 - 18:00. Pickup Request ID: 319322489.",
  );
});

test("recognizes Delhivery pickup error code 669 without pr_exist", () => {
  assert.equal(
    isExistingPickupResponse({
      success: false,
      data: { error: { code: 669, message: "Pickup already exists" } },
    }),
    true,
  );
});

test("keeps wallet and expired-time errors as real failures", () => {
  assert.equal(
    classifyDelhiveryPickupError({
      success: false,
      data: { message: "Insufficient wallet balance" },
    }).category,
    "insufficient_wallet_balance",
  );
  assert.equal(
    classifyDelhiveryPickupError({
      success: false,
      data: { message: "Pickup time has already passed" },
    }).category,
    "invalid_or_expired_pickup_time",
  );
  assert.equal(
    isExistingPickupResponse({
      success: false,
      data: { message: "Insufficient wallet balance" },
    }),
    false,
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

test("returns a stable idempotent message for a database-stored pickup", () => {
  assert.equal(
    formatStoredPickupMessage("319322489"),
    "Pickup is already scheduled. Pickup Request ID: 319322489.",
  );
});

test("does not call the pickup provider when the order is already scheduled", () => {
  assert.equal(shouldRequestPickup({ pickup_request_id: "319322489" }), false);
  assert.equal(shouldRequestPickup({ pickup_request_id: null }), true);
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
