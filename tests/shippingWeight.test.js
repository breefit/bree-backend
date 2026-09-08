import test from "node:test";
import assert from "node:assert/strict";
import {
  BOTTLE_VOLUME_ML,
  getConfiguredBottleWeightKg,
  resolveShipmentWeight,
} from "../src/utils/shippingWeight.js";

const resolve = (productName, quantity, extra = {}) =>
  resolveShipmentWeight({
    order: extra.order || {},
    items: [{ product_name: productName, quantity, ...extra.item }],
    bottleWeightKg: 0.02,
  });

test("keeps bottle volume fixed and resolves a 7-Day Pack", () => {
  const result = resolve("7-Pack Trial", 1, { item: { pack_bottle_count: 7 } });

  assert.equal(BOTTLE_VOLUME_ML, 50);
  assert.equal(result.bottleCount, 7);
  assert.equal(result.totalWeightKg, 0.14);
  assert.equal(result.totalWeightGrams, 140);
});

test("resolves a 30-Day Pack", () => {
  const result = resolve("30-Pack Monthly Box", 1, {
    item: { pack_bottle_count: 30 },
  });

  assert.equal(result.bottleCount, 30);
  assert.equal(result.totalWeightKg, 0.6);
  assert.equal(result.totalWeightGrams, 600);
});

test("resolves a recurring monthly 30-Day Pack", () => {
  const result = resolve("30-Pack Monthly Box", 1, {
    order: { parent_package_id: "package-1", fulfillment_cycle: 2 },
    item: { pack_bottle_count: 30 },
  });

  assert.equal(result.bottleCount, 30);
  assert.equal(result.packageType, "30-day");
});

test("uses the requested quantity for 100-bottle bulk orders", () => {
  const result = resolve("Bulk Order - BB-100001", 100, {
    order: { is_bulk_order: 1 },
  });

  assert.equal(result.bottleCount, 100);
  assert.equal(result.totalWeightGrams, 2000);
});

test("uses the requested quantity for 150-bottle bulk orders", () => {
  const result = resolve("Bulk Order - BB-100002", 150, {
    order: { is_bulk_order: 1 },
  });

  assert.equal(result.bottleCount, 150);
  assert.equal(result.totalWeightGrams, 3000);
});

test("rejects missing or non-positive physical bottle weight", () => {
  assert.throws(
    () => getConfiguredBottleWeightKg({ DELHIVERY_BOTTLE_WEIGHT_KG: "0" }),
    /DELHIVERY_BOTTLE_WEIGHT_KG/,
  );
  assert.throws(
    () =>
      resolveShipmentWeight({
        order: {},
        items: [
          { product_name: "7-Pack Trial", quantity: 1, pack_bottle_count: 7 },
        ],
        bottleWeightKg: 0,
      }),
    /bottleWeightKg must be a positive number/,
  );
});

test("rejects invalid bottle counts", () => {
  assert.throws(
    () => resolve("Bulk Order - invalid", 0, { order: { is_bulk_order: 1 } }),
    /quantity must be a positive number/,
  );
});
