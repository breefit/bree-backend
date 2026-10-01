import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isValidOrderStepTransition, ORDER_STATUSES } from "../src/constants/orderStatus.js";

/**
 * Backend protection for the admin cancelled-order UI: even if the frontend
 * controls are bypassed (direct PATCH /api/admin/orders/:id/status or the
 * bulk endpoint, both of which run isValidOrderStepTransition under a row
 * lock), a cancelled order can never be moved back into any other status.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("a cancelled order cannot be moved back into ANY other status (explicit terminal rule)", () => {
  for (const next of ORDER_STATUSES.filter((s) => s !== "cancelled")) {
    const result = isValidOrderStepTransition("cancelled", next);
    assert.equal(result.ok, false, `cancelled -> ${next} must be refused`);
    assert.equal(result.reason, "cancelled_is_terminal", next);
  }
});

test("re-confirming cancelled is still allowed (idempotent), and valid forward transitions are unchanged", () => {
  assert.equal(isValidOrderStepTransition("cancelled", "cancelled").ok, true);
  assert.equal(isValidOrderStepTransition("paid", "processing").ok, true);
  assert.equal(isValidOrderStepTransition("processing", "ready_to_ship").ok, true);
  assert.equal(isValidOrderStepTransition("ready_to_ship", "cancelled").ok, true);
  assert.equal(isValidOrderStepTransition("delivered", "cancelled").ok, false);
  assert.equal(isValidOrderStepTransition("delivered", "returned").ok, true);
  assert.equal(isValidOrderStepTransition("processing", "shipped").ok, false);
});

test("both admin status endpoints enforce the rule and answer with a clear message", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "controllers", "admin", "orderController.js"),
    "utf8",
  );
  assert.equal((source.match(/isValidOrderStepTransition\(/g) || []).length >= 2, true);
  assert.equal((source.match(/transition\.reason === "cancelled_is_terminal"/g) || []).length, 2);
});
