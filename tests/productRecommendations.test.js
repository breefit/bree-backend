import test from "node:test";
import assert from "node:assert/strict";
import { getRecommendations } from "../src/controllers/productController.js";

/**
 * ISSUE-019 — Admin product recommendations had no effect.
 *
 * product_relations is fully CRUD'd through the admin UI
 * (ProductRelationsModal — "Recommend"/"Upsell"/"Alternative", the only UI
 * that looks like it controls this feature) but the customer-facing
 * getRecommendations endpoint never read it at all — it only ever used
 * journey_level. Whatever an admin configured had zero effect on what a
 * customer actually saw.
 *
 * Fix: an explicit product_relations entry for a product now takes
 * priority over the automatic journey_level rule — including its guard
 * clauses (show_recommendations/is_subscription/journey_level) — falling
 * back to the existing journey_level logic only when nothing has been
 * explicitly configured for that product. This drives the REAL
 * getRecommendations handler end-to-end against a fake queryFn fixture.
 */

let productCounter = 0;
// A fresh, never-before-used product id per test avoids collisions in the
// module-level in-memory recommendations cache (utils/cache.js) that
// getRecommendations itself reads/writes.
const nextProductId = () => `11111111-1111-4111-8111-${String(++productCounter).padStart(12, "0")}`;

const makeReqRes = (productId) => {
  const req = { params: { id: productId } };
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

/**
 * `sourceProduct`: the row backing the "SELECT ... FROM products WHERE
 * (id = ? OR slug = ?)" lookup. `relations`: fake product_relations JOIN
 * rows for that product (empty = admin hasn't configured anything).
 * `journeyLevelRows`: what the fallback journey_level query would return.
 */
const createFakeQueryFn = ({ sourceProduct, relations = [], journeyLevelRows = [] }) => async (sql) => {
  if (sql.includes("FROM products") && sql.includes("WHERE (id = ? OR slug = ?)")) {
    return { rows: sourceProduct ? [sourceProduct] : [] };
  }
  if (sql.includes("FROM product_relations")) {
    return { rows: relations };
  }
  if (sql.includes("WHERE journey_level IN")) {
    return { rows: journeyLevelRows };
  }
  throw new Error(`Unhandled fake SQL in productRecommendations test: ${sql}`);
};

const baseSourceProduct = (overrides = {}) => ({
  id: nextProductId(),
  name: "Source Product",
  journey_level: 1,
  show_recommendations: 1,
  is_subscription: 0,
  ...overrides,
});

const relatedProductRow = (overrides = {}) => ({
  id: nextProductId(),
  name: "Admin-Chosen Product",
  slug: "admin-chosen-product",
  image: null,
  price: 499,
  mrp: 599,
  quantity: 1,
  is_subscription: 0,
  journey_level: 2,
  is_free_shipping: 0,
  shipping_charge: 0,
  estimated_delivery: null,
  ...overrides,
});

test("ISSUE-019: an admin-configured relation is returned to the customer — the core confirmed bug", async () => {
  const source = baseSourceProduct();
  const related = relatedProductRow();
  const { req, res } = makeReqRes(source.id);

  await getRecommendations(req, res, {
    queryFn: createFakeQueryFn({ sourceProduct: source, relations: [related] }),
  });

  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, related.id);
  assert.equal(res.body[0].name, "Admin-Chosen Product");
});

test("ISSUE-019: an admin-configured relation overrides show_recommendations=0 — an explicit admin choice is not silently suppressed by the blanket default", async () => {
  const source = baseSourceProduct({ show_recommendations: 0 });
  const related = relatedProductRow();
  const { req, res } = makeReqRes(source.id);

  await getRecommendations(req, res, {
    queryFn: createFakeQueryFn({ sourceProduct: source, relations: [related] }),
  });

  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, related.id);
});

test("ISSUE-019: an admin-configured relation overrides is_subscription=1", async () => {
  const source = baseSourceProduct({ is_subscription: 1 });
  const related = relatedProductRow();
  const { req, res } = makeReqRes(source.id);

  await getRecommendations(req, res, {
    queryFn: createFakeQueryFn({ sourceProduct: source, relations: [related] }),
  });

  assert.equal(res.body.length, 1);
});

test("ISSUE-019: multiple admin relations are returned in admin-assigned weight order (already ORDER BY weight DESC in SQL — this proves the handler passes them through unmodified)", async () => {
  const source = baseSourceProduct();
  const first = relatedProductRow({ name: "Highest Weight" });
  const second = relatedProductRow({ name: "Lower Weight" });
  const { req, res } = makeReqRes(source.id);

  await getRecommendations(req, res, {
    queryFn: createFakeQueryFn({ sourceProduct: source, relations: [first, second] }),
  });

  assert.deepEqual(res.body.map((r) => r.name), ["Highest Weight", "Lower Weight"]);
});

test("ISSUE-019 regression: a product with NO admin-configured relations still falls back to the existing journey_level rule", async () => {
  const source = baseSourceProduct({ journey_level: 1 });
  const journeyLevelMatch = relatedProductRow({ name: "Journey Level 2 Product", journey_level: 2 });
  const { req, res } = makeReqRes(source.id);

  await getRecommendations(req, res, {
    queryFn: createFakeQueryFn({
      sourceProduct: source,
      relations: [], // nothing configured by admin
      journeyLevelRows: [journeyLevelMatch],
    }),
  });

  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, "Journey Level 2 Product");
});

test("ISSUE-019 regression: the journey_level fallback's own guard clauses (show_recommendations=0) still apply when there is no admin override", async () => {
  const source = baseSourceProduct({ show_recommendations: 0 });
  const { req, res } = makeReqRes(source.id);

  await getRecommendations(req, res, {
    queryFn: createFakeQueryFn({ sourceProduct: source, relations: [] }),
  });

  assert.deepEqual(res.body, []);
});

test("ISSUE-019 regression: an unknown product id still returns an empty array, not an error", async () => {
  const { req, res } = makeReqRes(nextProductId());
  await getRecommendations(req, res, {
    queryFn: createFakeQueryFn({ sourceProduct: null }),
  });
  assert.deepEqual(res.body, []);
});
