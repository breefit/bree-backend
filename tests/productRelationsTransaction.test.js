import test from "node:test";
import assert from "node:assert/strict";
import { setProductRelations } from "../src/controllers/admin/productController.js";

/**
 * PHASE 3 — Medium Issue #27: setProductRelations (admin) previously ran a
 * DELETE followed by a Promise.all() batch of INSERTs as separate pooled
 * query() calls, with no transaction. A failure partway through the INSERT
 * batch left the DELETE already committed but the new relations only
 * partially written — the product could end up with zero relations even
 * though the request "failed."
 *
 * This drives the REAL setProductRelations function (not a regex over the
 * source) against a fake single-connection client that models a real
 * transaction: DELETE and every INSERT land in an uncommitted staging area
 * until COMMIT, and are discarded entirely on ROLLBACK. No production
 * database anywhere in this file.
 */

const makeFakeTransactionalDb = (initialRelations = [], { productExists = true } = {}) => {
  // Committed state, visible to any query that isn't inside our own
  // in-flight transaction.
  let committed = [...initialRelations];

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized === "SELECT id FROM products WHERE id = ? LIMIT 1") {
      const [productId] = params;
      return { rows: productExists ? [{ id: productId }] : [], rowCount: productExists ? 1 : 0 };
    }
    throw new Error(`Unhandled fake SQL (non-transactional queryFn) in productRelationsTransaction test: ${normalized}`);
  };

  const getClientFn = async () => {
    let inTransaction = false;
    let staged = null; // working copy while inside a transaction

    return {
      query: async (sql, params = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();

        if (normalized === "START TRANSACTION") {
          inTransaction = true;
          staged = [...committed];
          return { rows: [], rowCount: 0 };
        }

        if (normalized === "COMMIT") {
          committed = staged;
          inTransaction = false;
          staged = null;
          return { rows: [], rowCount: 0 };
        }

        if (normalized === "ROLLBACK") {
          inTransaction = false;
          staged = null;
          return { rows: [], rowCount: 0 };
        }

        const target = inTransaction ? staged : committed;

        if (normalized === "DELETE FROM product_relations WHERE product_id = ?") {
          const [productId] = params;
          const remaining = target.filter((r) => r.product_id !== productId);
          if (inTransaction) staged = remaining;
          else committed = remaining;
          return { rows: [], rowCount: 0 };
        }

        if (
          normalized.startsWith(
            "INSERT INTO product_relations (product_id, related_product_id, relation_type, weight)",
          )
        ) {
          const [productId, relatedProductId, relationType, weight] = params;

          if (relatedProductId === "BAD-ID-CAUSES-FK-FAILURE") {
            throw new Error(
              "ER_NO_REFERENCED_ROW_2: Cannot add or update a child row: a foreign key constraint fails",
            );
          }

          const row = { product_id: productId, related_product_id: relatedProductId, relation_type: relationType, weight };
          if (inTransaction) staged.push(row);
          else committed.push(row);
          return { rows: [], rowCount: 1 };
        }

        throw new Error(`Unhandled fake SQL in productRelationsTransaction test: ${normalized}`);
      },
      release: () => {},
    };
  };

  return { queryFn, getClientFn, getCommitted: () => committed };
};

const makeReqRes = (productId, relations) => {
  const req = { params: { id: productId }, body: { relations } };
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

test("ISSUE-027: a mid-batch INSERT failure rolls back the DELETE too — the product keeps its original relations, not zero", async () => {
  const db = makeFakeTransactionalDb([
    { product_id: "prod-1", related_product_id: "prod-old", relation_type: "recommend", weight: 1 },
  ]);

  const { req, res } = makeReqRes("prod-1", [
    { related_product_id: "prod-new-1", relation_type: "recommend", weight: 1 },
    { related_product_id: "BAD-ID-CAUSES-FK-FAILURE", relation_type: "recommend", weight: 2 },
  ]);

  await assert.rejects(
    () => setProductRelations(req, res, { queryFn: db.queryFn, getClientFn: db.getClientFn }),
    /foreign key constraint fails/,
  );

  assert.deepEqual(
    db.getCommitted(),
    [{ product_id: "prod-1", related_product_id: "prod-old", relation_type: "recommend", weight: 1 }],
    "a failed batch must leave the ORIGINAL relations intact, not zero and not a partial new set",
  );
});

test("ISSUE-027 regression: a fully successful relations update still replaces the old set with the new one, committed", async () => {
  const db = makeFakeTransactionalDb([
    { product_id: "prod-1", related_product_id: "prod-old", relation_type: "recommend", weight: 1 },
  ]);

  const { req, res } = makeReqRes("prod-1", [
    { related_product_id: "prod-new-1", relation_type: "recommend", weight: 5 },
    { related_product_id: "prod-new-2", relation_type: "recommend", weight: 3 },
  ]);

  await setProductRelations(req, res, { queryFn: db.queryFn, getClientFn: db.getClientFn });

  assert.equal(res.body.message, "Relations set");
  assert.deepEqual(
    db.getCommitted().map((r) => r.related_product_id).sort(),
    ["prod-new-1", "prod-new-2"],
  );
});

test("ISSUE-027 regression: clearing all relations (empty array) commits an empty set, not a rollback", async () => {
  const db = makeFakeTransactionalDb([
    { product_id: "prod-1", related_product_id: "prod-old", relation_type: "recommend", weight: 1 },
  ]);

  const { req, res } = makeReqRes("prod-1", []);

  await setProductRelations(req, res, { queryFn: db.queryFn, getClientFn: db.getClientFn });

  assert.equal(res.body.message, "Relations cleared");
  assert.deepEqual(db.getCommitted(), []);
});
