import test from "node:test";
import assert from "node:assert/strict";
import { getPackagePurchases } from "../src/controllers/admin/subscriptionAdminController.js";

/**
 * ISSUE-012 — Two incompatible subscription models; admin analytics blind
 * to Model B.
 *
 * Model A (`orders.is_subscription = 1`, real Razorpay recurring billing)
 * and Model B (`package_purchases` — pay-once, ship-monthly packages) are
 * both live, independent, intentional business models. AdminSubscriptions
 * .js/getSubscriptions queried only Model A — a pay-once package customer
 * was completely invisible to store staff using the Subscriptions
 * dashboard, with zero data shown for them anywhere.
 *
 * This adds read-only admin visibility for Model B as its own endpoint —
 * a deliberate choice not to merge two genuinely different data shapes
 * (fulfillment cycles vs. billing cycles) into one query, and NOT to
 * convert Model B into recurring Razorpay billing (a real, distinct
 * business model in its own right). Model A's existing endpoint/query is
 * completely untouched by this fix.
 */

const makeReqRes = (query) => {
  const req = { query };
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

const makePackage = (i, overrides = {}) => ({
  id: `package-${i}`,
  package_number: `PKG-${1000 + i}`,
  status: "active",
  total_cycles: 6,
  cycles_created: 2,
  fulfillment_interval_days: 30,
  next_fulfillment_date: new Date(Date.UTC(2026, 1, 1 + i)),
  created_at: new Date(Date.UTC(2026, 0, 1 + i)),
  product_name: "Bree 6-Month Pack",
  customer_name: `Customer ${i}`,
  email: `customer${i}@example.com`,
  phone: "9876543210",
  origin_order_number: `BRE-${2000 + i}`,
  ...overrides,
});

const createFakePackagesQueryFn = (allPackages) => async (sql, params = []) => {
  const normalized = sql.replace(/\s+/g, " ").trim();
  const hasSearch = normalized.includes("pp.package_number LIKE ?");
  const hasStatus = normalized.includes("pp.status = ?");

  let cursor = 0;
  let searchTerm = null;
  if (hasSearch) {
    searchTerm = params[cursor].replace(/%/g, "").toLowerCase();
    cursor += 5;
  }
  let statusValue = null;
  if (hasStatus) {
    statusValue = params[cursor];
    cursor += 1;
  }

  let filtered = allPackages.filter((p) => {
    if (statusValue && p.status !== statusValue) return false;
    if (searchTerm) {
      const haystack = [p.package_number, p.id, p.customer_name, p.email, p.product_name]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });

  filtered = [...filtered].sort((a, b) => b.created_at - a.created_at);

  if (normalized.startsWith("SELECT COUNT(*)")) {
    return { rows: [{ total: filtered.length }] };
  }

  const limitValue = params[params.length - 2];
  const offsetValue = params[params.length - 1];
  return { rows: filtered.slice(offsetValue, offsetValue + limitValue) };
};

test("ISSUE-012: Model B package purchases are now visible via a dedicated admin endpoint (previously invisible everywhere)", async () => {
  const packages = [makePackage(1), makePackage(2)];
  const { req, res } = makeReqRes({ page: 1, limit: 20 });
  await getPackagePurchases(req, res, { queryFn: createFakePackagesQueryFn(packages) });

  assert.equal(res.body.packages.length, 2);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.packages[0].product, "Bree 6-Month Pack");
  assert.equal(res.body.packages[0].totalCycles, 6);
  assert.equal(res.body.packages[0].cyclesCreated, 2);
});

test("ISSUE-012: search narrows by package number, customer name/email, and product name", async () => {
  const packages = [
    makePackage(1, { customer_name: "Priya Sharma" }),
    makePackage(2, { customer_name: "Rahul Verma" }),
  ];
  const { req, res } = makeReqRes({ search: "Priya", page: 1, limit: 20 });
  await getPackagePurchases(req, res, { queryFn: createFakePackagesQueryFn(packages) });

  assert.equal(res.body.total, 1);
  assert.equal(res.body.packages[0].customerName, "Priya Sharma");
});

test("ISSUE-012: status filter narrows results", async () => {
  const packages = [
    makePackage(1, { status: "active" }),
    makePackage(2, { status: "completed" }),
  ];
  const { req, res } = makeReqRes({ status: "completed", page: 1, limit: 20 });
  await getPackagePurchases(req, res, { queryFn: createFakePackagesQueryFn(packages) });

  assert.equal(res.body.total, 1);
  assert.equal(res.body.packages[0].status, "completed");
});

test("ISSUE-012: pagination totals reflect the full filtered count, not just the current page", async () => {
  const packages = Array.from({ length: 25 }, (_, i) => makePackage(i));
  const { req, res } = makeReqRes({ page: 1, limit: 20 });
  await getPackagePurchases(req, res, { queryFn: createFakePackagesQueryFn(packages) });

  assert.equal(res.body.packages.length, 20);
  assert.equal(res.body.total, 25);
});
