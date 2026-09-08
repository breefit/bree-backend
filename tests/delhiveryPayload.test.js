import test from "node:test";
import assert from "node:assert/strict";
import { buildDelhiveryShipmentPayload } from "../src/utils/delhiveryPayload.js";
import {
  getDuplicateDelhiveryOrderDetails,
  hasExistingShipmentState,
  shouldRollbackTransaction,
} from "../src/controllers/shippingController.js";

test("uses the registered Delhivery pickup location for shipment creation", () => {
  const payload = buildDelhiveryShipmentPayload({
    order: {
      order_number: "BREE-TEST-1",
      total_amount: 1048,
      created_at: "2026-09-07T00:00:00.000Z",
    },
    customer: { name: "Customer" },
    shippingAddress: {
      full_name: "Customer",
      mobile: "9876543210",
      address_line_1: "1 Main Street",
      address_line_2: "",
      city: "Hyderabad",
      state: "Telangana",
      pincode: "500100",
      country: "India",
    },
    items: [
      {
        product_name: "Amla Shots",
        quantity: 1,
        pack_bottle_count: 7,
        product_price: 1048,
      },
    ],
    bottleWeightKg: 0.02,
    warehouse: {
      name: "Legacy Warehouse Label",
      pickupLocation: "BREE FIT",
      address: "PLOT NO 14P",
      city: "Hyderabad",
      state: "Telangana",
      pincode: "500100",
      country: "India",
      phone: "8885315072",
    },
  });

  assert.equal(payload.pickup_location.name, "BREE FIT");
  assert.equal(payload.shipments[0].seller_name, "Legacy Warehouse Label");
  assert.equal(payload.shipments[0].quantity, "7");
  assert.equal(payload.shipments[0].weight, 140);
});

test("fails clearly when the registered Delhivery pickup location is missing", () => {
  assert.throws(
    () =>
      buildDelhiveryShipmentPayload({
        order: { order_number: "BREE-TEST-2", total_amount: 1048 },
        shippingAddress: {
          full_name: "Customer",
          mobile: "9876543210",
          address_line_1: "1 Main Street",
          city: "Hyderabad",
          state: "Telangana",
          pincode: "500100",
          country: "India",
        },
        items: [{ product_name: "Amla Shots", quantity: 1 }],
        warehouse: {
          name: "MOMSFOODWORKS",
          address: "PLOT NO 14P",
          city: "Hyderabad",
          state: "Telangana",
          pincode: "500100",
        },
      }),
    /DELHIVERY_PICKUP_LOCATION is missing/,
  );
});

test("only rolls back an active unfinished transaction", () => {
  assert.equal(
    shouldRollbackTransaction({
      transactionStarted: true,
      transactionFinished: false,
    }),
    true,
  );
  assert.equal(
    shouldRollbackTransaction({
      transactionStarted: true,
      transactionFinished: true,
    }),
    false,
  );
  assert.equal(
    shouldRollbackTransaction({
      transactionStarted: false,
      transactionFinished: false,
    }),
    false,
  );
});

test("detects Delhivery duplicate order responses and returned waybills", () => {
  const duplicate = getDuplicateDelhiveryOrderDetails({
    upload_wbn: "UPL123",
    packages: [
      {
        waybill: "58045510000022",
        remarks: ["Duplicate order id"],
      },
    ],
  });

  assert.deepEqual(duplicate, {
    waybill: "58045510000022",
    shipmentId: "UPL123",
    remarks: ["Duplicate order id"],
  });
  assert.equal(
    hasExistingShipmentState({
      delhivery_response: JSON.stringify({
        upload_wbn: "UPL123",
        packages: [
          {
            waybill: "58045510000022",
            remarks: ["Duplicate order id"],
          },
        ],
      }),
    }),
    true,
  );
});

test("does not classify a clean ready-to-ship order as already shipped", () => {
  assert.equal(
    hasExistingShipmentState({
      order_status: "ready_to_ship",
      awb_number: null,
      shipment_id: null,
      shipment_created_at: null,
      delhivery_response: null,
    }),
    false,
  );
});
