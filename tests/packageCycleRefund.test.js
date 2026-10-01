/**
 * Audit finding 9 — package-cycle 2+ orders have no Razorpay payment of their
 * own. Which payment their refund should come from is a pending BUSINESS
 * decision, so the refund flow refuses them explicitly (no payment is
 * guessed, mapped or invented). Normal orders are unaffected.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/config/database.js";
import {
  approveRefund,
  completeRefund,
  PACKAGE_CYCLE_REFUND_UNSUPPORTED_MESSAGE,
} from "../src/controllers/admin/returnController.js";

after(() => closePool().catch(() => {}));

const res = () => ({
  statusCode: 200,
  status(c) {
    this.statusCode = c;
    return this;
  },
  json(b) {
    this.body = b;
    return this;
  },
});

const clientFor = (order, writes) => () => ({
  release() {},
  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [] };
    if (q.startsWith("SELECT * FROM orders WHERE id = ?")) return { rows: [{ ...order }] };
    writes.push(q);
    if (q.startsWith("UPDATE orders SET refund_status = 'approved'")) {
      Object.assign(order, { refund_status: "approved", refund_amount: params[0] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  },
});

const packageCycleOrder = () => ({
  id: "pkg-cycle-2",
  order_status: "delivered",
  return_status: "returned",
  inspection_status: "approved",
  refund_status: null,
  payment_status: "paid",
  parent_package_id: "pkg-1",
  fulfillment_cycle: 2,
  razorpay_payment_id: null,
  total: 999,
});

test("Approve Refund on a package-cycle order without its own payment → explicit 400, nothing written", async () => {
  const writes = [];
  const r = res();
  await approveRefund({ params: { orderId: "pkg-cycle-2" }, body: {} }, r, {
    getClientFn: clientFor(packageCycleOrder(), writes),
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, "PACKAGE_CYCLE_REFUND_UNSUPPORTED");
  assert.equal(
    r.body.message,
    "Refund processing for package-cycle orders requires the original package payment mapping and is not currently supported.",
  );
  assert.equal(r.body.message, PACKAGE_CYCLE_REFUND_UNSUPPORTED_MESSAGE);
  assert.deepEqual(writes, []);
});

test("Initiate Refund on such an order → same explicit refusal; Razorpay is never contacted", async () => {
  const writes = [];
  const r = res();
  await completeRefund({ params: { orderId: "pkg-cycle-2" }, body: {} }, r, {
    getClientFn: clientFor({ ...packageCycleOrder(), refund_status: "approved", refund_amount: 999 }, writes),
    getRazorpayFn: () => {
      throw new Error("Razorpay must not be called");
    },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.code, "PACKAGE_CYCLE_REFUND_UNSUPPORTED");
  assert.deepEqual(writes, [], "no 'processing' claim is taken");
});

test("a normal order (and a package order that has its own payment) is unaffected", async () => {
  for (const order of [
    { ...packageCycleOrder(), id: "normal-1", parent_package_id: null, razorpay_payment_id: "pay_1" },
    { ...packageCycleOrder(), id: "pkg-cycle-1", fulfillment_cycle: 1, razorpay_payment_id: "pay_2" },
  ]) {
    const writes = [];
    const r = res();
    await approveRefund({ params: { orderId: order.id }, body: {}, admin: { id: "a" } }, r, {
      getClientFn: clientFor(order, writes),
    });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(order.refund_status, "approved");
    assert.equal(Number(order.refund_amount), 999);
  }
});
