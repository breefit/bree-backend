import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import app from "../src/app.js";
import { closePool } from "../src/config/database.js";
import cache from "../src/utils/cache.js";
import {
  getProducts,
  getProduct,
  getHomeProducts,
  getCategories,
  getHomeData,
  getRecommendations,
} from "../src/controllers/productController.js";
import {
  getProducts as adminGetProducts,
  setProductVisibility,
} from "../src/controllers/admin/productController.js";
import { validateCart } from "../src/controllers/cartController.js";
import { createOrder } from "../src/controllers/paymentController.js";
import { customerVisibleWhere } from "../src/constants/productVisibility.js";

/**
 * Product visibility ("Show in User UI").
 *
 * products.is_visible (NOT NULL DEFAULT 1) is the admin toggle; is_active
 * stays the soft-delete flag. Every customer-facing product query must use
 * customerVisibleWhere() — "is_active = 1 AND is_visible = 1".
 *
 * The handlers are driven for real against a fake MySQL-shaped table that
 * only applies a filter if the SQL actually contains it: if a customer query
 * forgets `is_visible = 1`, hidden rows come back and these tests fail. No
 * real database, Razorpay or socket is touched.
 */

// ── Fake products/product_relations tables ───────────────────────────────────
const product = (overrides) => ({
  name: overrides.id,
  slug: overrides.id,
  category: "Wellness Shot",
  description: "",
  price: 100,
  mrp: 120,
  quantity: 7,
  image: "img.png",
  features: "[]",
  popular: 0,
  display_order: 0,
  is_active: 1,
  is_visible: 1, // mirrors the column DEFAULT 1
  is_subscription: 0,
  journey_level: 0,
  show_recommendations: 1,
  is_free_shipping: 1,
  shipping_charge: 0,
  estimated_delivery: null,
  created_at: new Date(),
  ...overrides,
});

const makeDb = ({ products = [], relations = [] } = {}) => {
  const table = new Map(products.map((p) => [p.id, { ...p }]));
  const calls = [];

  // Applies ONLY the filters the SQL text actually contains.
  const applyFilters = (sql, rows) =>
    rows.filter(
      (r) =>
        (!/is_active = 1/.test(sql) || Number(r.is_active) === 1) &&
        (!/is_visible = 1/.test(sql) || Number(r.is_visible) === 1),
    );

  const queryFn = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    calls.push(q);
    const all = [...table.values()];

    if (q.startsWith("SHOW COLUMNS FROM products")) {
      return { rows: [{ Field: "is_free_shipping" }] };
    }
    if (q.startsWith("UPDATE products SET is_visible = ?")) {
      const [value, id] = params;
      const row = table.get(id);
      if (row) row.is_visible = value;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (q.startsWith("SELECT id, name, is_visible FROM products WHERE id = ?")) {
      const row = table.get(params[0]);
      return { rows: row ? [{ id: row.id, name: row.name, is_visible: row.is_visible }] : [] };
    }
    if (q.startsWith("SELECT * FROM products WHERE id = ?")) {
      const row = table.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    // Admin list (no customer filter by design)
    if (q.includes("FROM products") && q.includes("LIMIT ? OFFSET ?")) {
      return { rows: applyFilters(q, all) };
    }
    if (q.startsWith("SELECT COUNT(*) AS total FROM products")) {
      return { rows: [{ total: applyFilters(q, all).length }] };
    }
    if (q.startsWith("SELECT DISTINCT category FROM products")) {
      const cats = [...new Set(applyFilters(q, all).map((r) => r.category))];
      return { rows: cats.map((category) => ({ category })) };
    }
    if (q.startsWith("SELECT 1 AS configured FROM product_relations")) {
      return { rows: relations.some((r) => r.product_id === params[0]) ? [{ configured: 1 }] : [] };
    }
    if (q.includes("FROM product_relations pr JOIN products p")) {
      // INNER JOIN: a relation to a row that doesn't exist yields nothing.
      const joined = relations
        .filter((r) => r.product_id === params[0])
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .map((r) => table.get(r.related_product_id))
        .filter(Boolean);
      return { rows: applyFilters(q, joined) };
    }
    // Source product of getRecommendations
    if (q.includes("FROM products WHERE (id = ? OR slug = ?)")) {
      const rows = all.filter((r) => r.id === params[0] || r.slug === params[1]);
      return { rows: applyFilters(q, rows) };
    }
    if (q.includes("WHERE journey_level IN")) {
      const rows = all.filter((r) => params.includes(r.journey_level) && Number(r.is_subscription) === 0);
      return { rows: applyFilters(q, rows) };
    }
    // Public product detail
    if (q.includes("FROM products p") && q.includes("(p.id = ? OR p.slug = ?)")) {
      const rows = all.filter((r) => r.id === params[0] || r.slug === params[1]);
      return { rows: applyFilters(q, rows).slice(0, 1) };
    }
    // Public home: trial/popular
    if (q.includes("FROM products p") && q.includes("p.journey_level = 1")) {
      return { rows: applyFilters(q, all.filter((r) => r.journey_level === 1)).slice(0, 1) };
    }
    if (q.includes("FROM products p") && q.includes("p.popular = 1")) {
      return { rows: applyFilters(q, all.filter((r) => r.popular === 1)).slice(0, 4) };
    }
    // Public home: fill-up query
    if (q.includes("FROM products p") && q.includes("LIMIT ?")) {
      const limit = params[params.length - 1];
      const excluded = params.slice(0, -1);
      return { rows: applyFilters(q, all.filter((r) => !excluded.includes(r.id))).slice(0, limit) };
    }
    // Public listing (optionally by category)
    if (q.includes("FROM products p") && q.includes("ORDER BY p.display_order")) {
      const rows = q.includes("p.category = ?") ? all.filter((r) => r.category === params[0]) : all;
      return { rows: applyFilters(q, rows) };
    }
    // validate-cart / checkout product lookup
    if (q.startsWith("SELECT id, name, image, price") && q.includes("WHERE id = ?")) {
      const row = table.get(params[0]);
      return { rows: applyFilters(q, row ? [{ ...row }] : []) };
    }
    if (q.includes("FROM testimonials")) return { rows: [] };

    throw new Error(`Unhandled fake SQL in productVisibility test: ${q}`);
  };

  return { queryFn, table, calls };
};

const makeRes = () => ({
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
});

const call = async (handler, req, db) => {
  const res = makeRes();
  await handler({ params: {}, query: {}, body: {}, app: { locals: {} }, ...req }, res, { queryFn: db.queryFn });
  return res;
};

const ids = (rows) => rows.map((r) => r.id).sort();

// Every public handler caches; start each test cold.
beforeEach(() => cache.flush());

// ── A. Default ───────────────────────────────────────────────────────────────
test("A. new products default to visible (column DEFAULT 1 in schema + migration + boot helper)", async () => {
  const fs = await import("node:fs/promises");
  const schema = await fs.readFile(new URL("../mysql-schema.sql", import.meta.url), "utf8");
  const migration = await fs.readFile(new URL("../migrations/010_add_product_visibility.sql", import.meta.url), "utf8");
  const database = await fs.readFile(new URL("../src/config/database.js", import.meta.url), "utf8");
  const def = /is_visible\s+TINYINT\(1\)\s+NOT NULL DEFAULT 1/;
  assert.match(schema, def);
  assert.match(migration, def);
  assert.match(database, def);
  // The shared predicate is what every customer query uses.
  assert.equal(customerVisibleWhere("p"), "p.is_active = 1 AND p.is_visible = 1");
});

// ── B/C. Admin list ──────────────────────────────────────────────────────────
test("B+C. admin product list returns BOTH visible and hidden products, with is_visible exposed", async () => {
  const db = makeDb({ products: [product({ id: "vis" }), product({ id: "hid", is_visible: 0 })] });
  const res = await call(adminGetProducts, { query: { limit: 100 } }, db);
  assert.deepEqual(ids(res.body.products), ["hid", "vis"]);
  assert.equal(res.body.total, 2);
  assert.ok(db.calls.some((q) => q.includes("is_visible") && q.includes("LIMIT ? OFFSET ?")));
});

// ── D/E. Admin toggle ────────────────────────────────────────────────────────
test("D. admin can hide a product; response is the updated product; only is_visible changes", async () => {
  const db = makeDb({ products: [product({ id: "p1", price: 499, name: "30-Pack" })] });
  const res = await call(setProductVisibility, { params: { id: "p1" }, body: { is_visible: false }, admin: { id: "a1" } }, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, "p1");
  assert.equal(res.body.is_visible, 0);
  assert.equal(res.body.price, 499);
  assert.equal(res.body.name, "30-Pack");
  const updates = db.calls.filter((q) => q.startsWith("UPDATE products"));
  assert.deepEqual(updates, ["UPDATE products SET is_visible = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"]);
});

test("E. admin can make a hidden product visible again", async () => {
  const db = makeDb({ products: [product({ id: "p1", is_visible: 0 })] });
  const res = await call(setProductVisibility, { params: { id: "p1" }, body: { is_visible: true } }, db);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.is_visible, 1);
});

test("toggle validation: non-boolean is_visible → 400, nothing written", async () => {
  for (const bad of [undefined, "false", 0, 1, null, "yes"]) {
    const db = makeDb({ products: [product({ id: "p1" })] });
    const res = await call(setProductVisibility, { params: { id: "p1" }, body: { is_visible: bad } }, db);
    assert.equal(res.statusCode, 400, `value ${JSON.stringify(bad)}`);
    assert.equal(db.table.get("p1").is_visible, 1);
    assert.ok(!db.calls.some((q) => q.startsWith("UPDATE")));
  }
});

test("toggle on a nonexistent product → 404", async () => {
  const db = makeDb();
  const res = await call(setProductVisibility, { params: { id: "nope" }, body: { is_visible: false } }, db);
  assert.equal(res.statusCode, 404);
});

test("hiding a product broadcasts only its id on the public product:updated socket event", async () => {
  const db = makeDb({ products: [product({ id: "p1", name: "Secret" })] });
  const emitted = [];
  const io = { emit: (event, payload) => emitted.push({ event, payload }) };
  await call(setProductVisibility, { params: { id: "p1" }, body: { is_visible: false }, app: { locals: { io } } }, db);
  assert.deepEqual(emitted, [{ event: "product:updated", payload: { id: "p1" } }]);
});

test("toggle invalidates the public product caches so customers see the change immediately", async () => {
  const db = makeDb({ products: [product({ id: "p1" }), product({ id: "p2" })] });
  const first = await call(getProducts, {}, db);
  assert.deepEqual(ids(first.body), ["p1", "p2"]);
  await call(setProductVisibility, { params: { id: "p2" }, body: { is_visible: false } }, db);
  const second = await call(getProducts, {}, db);
  assert.deepEqual(ids(second.body), ["p1"]);
});

// ── F. Public listing surfaces ───────────────────────────────────────────────
const catalog = () =>
  makeDb({
    products: [
      product({ id: "vis-trial", journey_level: 1, category: "Shots" }),
      product({ id: "vis-pop", popular: 1, category: "Shots" }),
      product({ id: "hid-trial", journey_level: 1, is_visible: 0, category: "HiddenOnly" }),
      product({ id: "hid-pop", popular: 1, is_visible: 0, category: "HiddenOnly" }),
      product({ id: "deleted", is_active: 0, category: "DeletedOnly" }),
    ],
  });

test("F. GET /api/products excludes hidden (and deleted) products", async () => {
  const res = await call(getProducts, {}, catalog());
  assert.deepEqual(ids(res.body), ["vis-pop", "vis-trial"]);
});

test("F. category filter excludes hidden products; a category with only hidden products is empty", async () => {
  const shots = await call(getProducts, { query: { category: "Shots" } }, catalog());
  assert.deepEqual(ids(shots.body), ["vis-pop", "vis-trial"]);
  cache.flush();
  const hiddenOnly = await call(getProducts, { query: { category: "HiddenOnly" } }, catalog());
  assert.deepEqual(hiddenOnly.body, []);
});

test("F. GET /api/products/home excludes hidden products from trial, popular and fill-up slots", async () => {
  const res = await call(getHomeProducts, {}, catalog());
  assert.deepEqual(ids(res.body), ["vis-pop", "vis-trial"]);
});

test("F. home data (featured, popular/recommendations, categories) excludes hidden products", async () => {
  const res = await call(getHomeData, {}, catalog());
  assert.deepEqual(ids(res.body.featured_products), ["vis-trial"]);
  assert.deepEqual(ids(res.body.recommendations), ["vis-pop"]);
  assert.deepEqual(res.body.categories, ["Shots"]);
});

// ── G. Search / categories ───────────────────────────────────────────────────
test("G. categories list never surfaces a category that only hidden products belong to", async () => {
  const res = await call(getCategories, {}, catalog());
  assert.deepEqual(res.body, ["Shots"]);
});

// ── H. Detail ────────────────────────────────────────────────────────────────
test("H. hidden product detail → 404 'Product not found' (same as nonexistent), by id and by slug", async () => {
  const db = catalog();
  const byId = await call(getProduct, { params: { id: "hid-trial" } }, db);
  assert.equal(byId.statusCode, 404);
  assert.deepEqual(byId.body, { message: "Product not found" });
  const missing = await call(getProduct, { params: { id: "does-not-exist" } }, db);
  assert.deepEqual(missing.body, byId.body, "hidden must be indistinguishable from missing");
  const visible = await call(getProduct, { params: { id: "vis-pop" } }, db);
  assert.equal(visible.statusCode, 200);
  assert.equal(visible.body.id, "vis-pop");
  // The public SELECT list never includes the admin-only flag.
  const detailSql = db.calls.find((q) => q.includes("(p.id = ? OR p.slug = ?)"));
  assert.ok(!detailSql.split(" FROM ")[0].includes("is_visible"));
});

test("H. a product cached while visible is not served from cache after it is hidden", async () => {
  const db = catalog();
  const before = await call(getProduct, { params: { id: "vis-pop" } }, db);
  assert.equal(before.statusCode, 200);
  await call(setProductVisibility, { params: { id: "vis-pop" }, body: { is_visible: false } }, db);
  const afterHide = await call(getProduct, { params: { id: "vis-pop" } }, db);
  assert.equal(afterHide.statusCode, 404);
});

// ── I/J. Cart + checkout ─────────────────────────────────────────────────────
test("I. validate-cart reports a hidden product as unavailable (no hidden-vs-deleted distinction)", async () => {
  const db = catalog();
  const res = await call(validateCart, { body: { items: [{ id: "hid-pop", price: 100, quantity: 1 }] } }, db);
  assert.equal(res.body.items[0].available, false);
  assert.equal(res.body.items[0].reason, undefined);
});

test("J. validate-cart reports a visible product as available", async () => {
  const res = await call(validateCart, { body: { items: [{ id: "vis-pop", price: 100, quantity: 1 }] } }, catalog());
  assert.equal(res.body.items[0].available, true);
});

test("I. checkout create-order rejects a hidden product id sent directly (bypassing the UI) with 400", async () => {
  const db = catalog();
  const res = makeRes();
  await createOrder(
    { body: { items: [{ product_id: "hid-pop", quantity: 1 }] }, user: null, app: {} },
    res,
    { queryFn: db.queryFn },
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /not found or unavailable/);
  const lookup = db.calls.find((q) => q.startsWith("SELECT id, name, image, price"));
  assert.match(lookup, /is_active = 1 AND is_visible = 1/);
});

test("J. checkout create-order accepts a visible product past product validation", async () => {
  const db = catalog();
  const res = makeRes();
  try {
    await createOrder(
      { body: { items: [{ product_id: "vis-pop", quantity: 1 }] }, user: null, app: {} },
      res,
      { queryFn: db.queryFn, getClientFn: async () => { throw new Error("stop-after-validation"); } },
    );
  } catch {
    // Anything past product validation (order transaction, Razorpay) is out
    // of scope here and intentionally stubbed to fail.
  }
  assert.notEqual(res.body?.message?.includes?.("not found or unavailable"), true);
});

// ── K–P. Recommendations / cart suggestions ─────────────────────────────────
const recsDb = ({ relations = [], extra = [] } = {}) =>
  makeDb({
    products: [
      product({ id: "A", journey_level: 1 }),
      product({ id: "B-hidden", journey_level: 2, is_visible: 0 }),
      product({ id: "C-visible", journey_level: 2 }),
      product({ id: "D-deleted", journey_level: 2, is_active: 0 }),
      product({ id: "S-hidden-source", journey_level: 1, is_visible: 0 }),
      ...extra,
    ],
    relations,
  });

const recs = (id, db) => call(getRecommendations, { params: { id } }, db);

test("K. cart suggestions (journey fallback) exclude hidden products", async () => {
  const res = await recs("A", recsDb());
  assert.deepEqual(ids(res.body), ["C-visible"]);
});

test("L. cart suggestions (journey fallback) exclude deleted products", async () => {
  const res = await recs("A", recsDb());
  assert.ok(!ids(res.body).includes("D-deleted"));
});

test("L. a relation to a nonexistent product is ignored (INNER JOIN)", async () => {
  const db = recsDb({ relations: [{ product_id: "A", related_product_id: "ghost" }, { product_id: "A", related_product_id: "C-visible" }] });
  const res = await recs("A", db);
  assert.deepEqual(ids(res.body), ["C-visible"]);
});

test("M. an admin relation to a hidden product is skipped; other valid relations still returned", async () => {
  const db = recsDb({
    relations: [
      { product_id: "A", related_product_id: "B-hidden", weight: 10 },
      { product_id: "A", related_product_id: "C-visible", weight: 5 },
    ],
  });
  const res = await recs("A", db);
  assert.deepEqual(ids(res.body), ["C-visible"]);
  const relSql = db.calls.find((q) => q.includes("FROM product_relations pr"));
  assert.match(relSql, /p\.is_active = 1 AND p\.is_visible = 1/);
});

test("N. an admin relation to a deleted product is skipped", async () => {
  const db = recsDb({ relations: [{ product_id: "A", related_product_id: "D-deleted" }, { product_id: "A", related_product_id: "C-visible" }] });
  const res = await recs("A", db);
  assert.deepEqual(ids(res.body), ["C-visible"]);
});

test("O. multiple visible recommendations are all returned, in admin weight order", async () => {
  const db = recsDb({
    extra: [product({ id: "E-visible", journey_level: 3 })],
    relations: [
      { product_id: "A", related_product_id: "E-visible", weight: 1 },
      { product_id: "A", related_product_id: "B-hidden", weight: 50 },
      { product_id: "A", related_product_id: "C-visible", weight: 9 },
    ],
  });
  const res = await recs("A", db);
  assert.deepEqual(res.body.map((r) => r.id), ["C-visible", "E-visible"]);
});

test("P. when every configured relation is hidden/deleted → [] (not null, not broken cards, no substitution)", async () => {
  const db = recsDb({
    relations: [
      { product_id: "A", related_product_id: "B-hidden" },
      { product_id: "A", related_product_id: "D-deleted" },
    ],
  });
  const res = await recs("A", db);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});

test("P. every returned recommendation is a complete card (id, name, price) — no null entries", async () => {
  const db = recsDb({ relations: [{ product_id: "A", related_product_id: "C-visible" }, { product_id: "A", related_product_id: "B-hidden" }] });
  const res = await recs("A", db);
  for (const r of res.body) {
    assert.ok(r && r.id && r.name && Number.isFinite(r.price));
  }
});

test("hidden SOURCE product does not participate in recommendations at all", async () => {
  const db = recsDb({ relations: [{ product_id: "S-hidden-source", related_product_id: "C-visible" }] });
  const res = await recs("S-hidden-source", db);
  assert.deepEqual(res.body, []);
});

test("a recommendation cached while visible disappears after the target is hidden", async () => {
  const db = recsDb();
  assert.deepEqual(ids((await recs("A", db)).body), ["C-visible"]);
  await call(setProductVisibility, { params: { id: "C-visible" }, body: { is_visible: false } }, db);
  assert.deepEqual((await recs("A", db)).body, []);
});

// ── Q/R. Existing orders + subscriptions ─────────────────────────────────────
// Order history, tracking, renewals and package fulfillment read order_items
// snapshots (or join products without any visibility filter). Hiding a
// product must not add a visibility filter to any of those paths.
test("Q+R. post-purchase paths are NOT gated by product visibility", async () => {
  const fs = await import("node:fs/promises");
  const read = (p) => fs.readFile(new URL(`../src/${p}`, import.meta.url), "utf8");
  const postPurchase = [
    "services/packageFulfillmentService.js",
    "services/renewalService.js",
    "controllers/shippingController.js",
    "controllers/admin/orderController.js",
    "controllers/admin/subscriptionAdminController.js",
    "controllers/admin/returnController.js",
  ];
  for (const file of postPurchase) {
    const src = await read(file);
    assert.ok(!/is_visible|customerVisibleWhere/.test(src), `${file} must not filter on visibility`);
  }
  // Customer order views (getMyOrders/getOrder/tracking) are in orderController
  // and must not filter order items by visibility either — only the
  // new-purchase product lock and legacy validate-cart may.
  const orderController = await read("controllers/orderController.js");
  const uses = orderController.match(/customerVisibleWhere\(|is_visible/g) || [];
  assert.equal(uses.length, 3, "orderController: lockProductsForOrder + legacy validateCart (2 refs) only");
  // Paid-reminder creation inside verifyPayment runs AFTER money is captured
  // and must keep honoring the purchase even if the product was hidden
  // mid-payment.
  const payment = await read("controllers/paymentController.js");
  const verifyBody = payment.slice(payment.indexOf("export const verifyPayment"), payment.indexOf("export const getShippingInfo"));
  assert.ok(!/customerVisibleWhere|is_visible/.test(verifyBody), "verifyPayment must not gate on visibility");
  // Subscription management (cancel/pause/resume) stays available.
  const sub = await read("controllers/subscriptionController.js");
  const manage = sub.slice(sub.indexOf("export const getMySubscriptions"));
  assert.ok(!/customerVisibleWhere|is_visible/.test(manage));
});

// ── S. Rapid toggles ─────────────────────────────────────────────────────────
test("S. rapid toggle requests: each persists exactly the requested boolean; last write wins", async () => {
  const db = makeDb({ products: [product({ id: "p1" })] });
  const sequence = [false, true, false, true, false];
  const results = await Promise.all(
    sequence.map((v) => call(setProductVisibility, { params: { id: "p1" }, body: { is_visible: v } }, db)),
  );
  for (const r of results) assert.equal(r.statusCode, 200);
  assert.equal(db.table.get("p1").is_visible, 0);
  // Idempotent: repeating the same value is a no-op in effect.
  await call(setProductVisibility, { params: { id: "p1" }, body: { is_visible: false } }, db);
  assert.equal(db.table.get("p1").is_visible, 0);
});

// ── T. Authorization (real Express app, real middleware) ─────────────────────
let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await closePool();
});

const patchVisibility = (headers = {}) =>
  fetch(`${baseUrl}/api/admin/products/00000000-0000-4000-8000-000000000000/visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ is_visible: false }),
  });

test("T. unauthenticated PATCH visibility → 401", async () => {
  const res = await patchVisibility();
  assert.equal(res.status, 401);
});

test("T. customer JWT on PATCH visibility → rejected by the admin realm (401)", async (t) => {
  const customerSecret = process.env.JWT_SECRET || "customer-test-secret";
  if (process.env.ADMIN_JWT_SECRET && process.env.ADMIN_JWT_SECRET === customerSecret) {
    t.skip("JWT_SECRET === ADMIN_JWT_SECRET in this environment; realms not separable");
    return;
  }
  const customerToken = jwt.sign({ userId: "cust-1" }, customerSecret, { expiresIn: "5m" });
  const viaHeader = await patchVisibility({ Authorization: `Bearer ${customerToken}` });
  assert.equal(viaHeader.status, 401);
  const viaCookie = await patchVisibility({ Cookie: `auth_token=${customerToken}` });
  assert.equal(viaCookie.status, 401);
});

test("T. public product routes expose no visibility mutation", async () => {
  const res = await fetch(`${baseUrl}/api/products/some-id/visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_visible: true }),
  });
  assert.equal(res.status, 404);
});
