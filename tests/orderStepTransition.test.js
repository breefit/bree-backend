import test from "node:test";
import assert from "node:assert/strict";
import { isValidOrderStepTransition } from "../src/constants/orderStatus.js";

/**
 * PHASE 4 — LOW-02: order-status transition validation used to be
 * duplicated across three blocks in admin/orderController.js (a 7-step
 * ORDER_STEPS array + index-adjacency comparison, with special-cased
 * "cancelled"/"returned" branches) — one of the three copies was already
 * fully dead diagnostic code. Extracted into a single shared
 * isValidOrderStepTransition(prev, next) in constants/orderStatus.js, now
 * used by both updateOrderStatus (single) and bulkUpdateStatus (bulk).
 *
 * These tests drive the REAL shared function and cover every branch that
 * existed in the original duplicated logic, proving the extraction is
 * behavior-preserving: valid transitions remain valid, invalid transitions
 * remain rejected, and the special-cased cancel/return rules are intact.
 */

const pipeline = [
  "pending_payment",
  "paid",
  "processing",
  "ready_to_ship",
  "shipped",
  "out_for_delivery",
  "delivered",
];

test("LOW-02: every adjacent forward step in the pipeline is a valid transition", () => {
  for (let i = 0; i < pipeline.length - 1; i++) {
    const result = isValidOrderStepTransition(pipeline[i], pipeline[i + 1]);
    assert.equal(result.ok, true, `${pipeline[i]} -> ${pipeline[i + 1]} should be valid`);
  }
});

test("LOW-02: setting the SAME status again (no-op transition) is valid", () => {
  for (const status of pipeline) {
    const result = isValidOrderStepTransition(status, status);
    assert.equal(result.ok, true, `${status} -> ${status} (no-op) should be valid`);
  }
});

test("LOW-02: skipping a step forward is rejected", () => {
  const result = isValidOrderStepTransition("pending_payment", "processing");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_step");
});

test("LOW-02: moving backward in the pipeline is rejected", () => {
  const result = isValidOrderStepTransition("shipped", "paid");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_step");
});

test("LOW-02: cancelling is allowed from any non-delivered status", () => {
  for (const status of pipeline.filter((s) => s !== "delivered")) {
    const result = isValidOrderStepTransition(status, "cancelled");
    assert.equal(result.ok, true, `${status} -> cancelled should be valid`);
  }
});

test("LOW-02: cancelling a DELIVERED order is rejected with reason 'cancel_after_delivered'", () => {
  const result = isValidOrderStepTransition("delivered", "cancelled");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancel_after_delivered");
});

test("LOW-02: marking 'returned' is only valid from delivered or out_for_delivery", () => {
  assert.equal(isValidOrderStepTransition("delivered", "returned").ok, true);
  assert.equal(isValidOrderStepTransition("out_for_delivery", "returned").ok, true);
});

test("LOW-02: marking 'returned' from any other status is rejected with reason 'invalid_return_source'", () => {
  for (const status of ["pending_payment", "paid", "processing", "ready_to_ship", "shipped"]) {
    const result = isValidOrderStepTransition(status, "returned");
    assert.equal(result.ok, false, `${status} -> returned should be rejected`);
    assert.equal(result.reason, "invalid_return_source");
  }
});

test("LOW-02: prev/next in the result are the normalized status values, usable for message formatting", () => {
  const result = isValidOrderStepTransition("PENDING_PAYMENT", "delivered");
  assert.equal(result.prev, "pending_payment");
  assert.equal(result.next, "delivered");
});
