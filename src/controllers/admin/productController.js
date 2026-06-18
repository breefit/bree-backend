import { query } from "../../config/database.js";
import { randomUUID } from "crypto";
import { cloudinary } from "../../config/cloudinary.js";
import cache from "../../utils/cache.js";

const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

const VALID_PRODUCT_STATUSES = ["In Stock", "Out Of Stock"];

const normalizeFeaturesInput = (features) => {
  if (Array.isArray(features)) {
    return features.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof features === "string") {
    const trimmed = features.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .map((item) => String(item || "").trim())
            .filter(Boolean);
        }
      } catch (err) {
        // fall through to comma-splitting fallback
      }
    }

    return trimmed
      .split(",")
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  if (features && typeof features === "object") {
    return Object.values(features)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  return [];
};

const normalizeProductFeaturesForResponse = (features) => {
  if (Array.isArray(features)) return features;
  if (typeof features === "string") {
    const trimmed = features.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        return trimmed
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (features && typeof features === "object") {
    return Object.values(features)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  return [];
};

const normalizeProductStatus = (status) =>
  VALID_PRODUCT_STATUSES.includes(status) ? status : "In Stock";

const resolveProductStatus = (stockQty, status) => {
  const parsedQty = Number(stockQty);
  if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
    return "Out Of Stock";
  }
  return status !== undefined ? normalizeProductStatus(status) : "In Stock";
};

// BUG FIX 3 & 4 — shared helper so normalisation is identical in create and
// update. Accepts the raw req.body value which can be:
//   boolean true/false  (from JSON body)
//   string "true"/"false"  (from multipart form)
//   integer 1/0  (from a future GET→edit round-trip)
// Returns 1 or 0 for the MySQL TINYINT(1) column.
const normalizeIsSubscription = (value) => {
  if (value === true || value === 1 || value === "true" || value === "1") {
    return 1;
  }
  return 0;
};

const invalidateProductCache = () => {
  cache.delPrefix("products:");
  cache.del("home:data");
};

const emitProductEvent = (req, eventType, product) => {
  try {
    const io = req.app.locals.io;
    if (io) {
      io.emit(`product:${eventType}`, product);
      console.log(`📡 Emitted: product:${eventType}`);
    }
  } catch (err) {
    console.warn("Socket.IO emit failed (non-critical):", err.message);
  }
};

// ============================================================
// GET /api/admin/products
// ============================================================
export const getProducts = async (req, res) => {
  const { page = 1, limit = 20, search = "" } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const where = search ? `WHERE name LIKE ?` : "";
  const params = search
    ? [`%${search}%`, parseInt(limit), offset]
    : [parseInt(limit), offset];

  const [productsRes, countRes] = await Promise.all([
    query(
      // is_subscription included so the admin table can show the flag and
      // so reopening the edit modal always receives the correct value.
      `SELECT id, name, slug, category, description, price, mrp,
              quantity, stock_qty, image, features, popular, display_order,
              status, is_active, is_subscription, created_at
       FROM products ${where} ORDER BY display_order ASC, created_at DESC
       LIMIT ? OFFSET ?`,
      params,
    ),
    query(
      `SELECT COUNT(*) AS total FROM products ${where}`,
      search ? [`%${search}%`] : [],
    ),
  ]);

  const products = productsRes.rows.map((product) => ({
    ...product,
    features: normalizeProductFeaturesForResponse(product.features),
  }));

  res.json({
    products,
    total: countRes.rows[0].total,
    pages: Math.ceil(countRes.rows[0].total / parseInt(limit)),
  });
};

// ============================================================
// POST /api/admin/products
// ============================================================
export const createProduct = async (req, res) => {
  // DEBUG — remove after confirming is_subscription saves correctly
  console.log("CREATE PRODUCT BODY", req.body);

  const {
    name,
    category,
    description,
    price,
    mrp,
    quantity,
    features,
    popular,
    status,
    stockQty,
    displayOrder,
    is_subscription, // snake_case from frontend payload
  } = req.body;

  const image =
    req.file?.path ||
    req.file?.secure_url ||
    req.file?.url ||
    req.body.image ||
    "";
  const slug = slugify(name);

  const normalizedFeatures = normalizeFeaturesInput(features);
  const featuresValue = JSON.stringify(normalizedFeatures);

  const stockQuantity = parseInt(stockQty || 0, 10);
  const productStatus = resolveProductStatus(stockQuantity, status);

  // BUG FIX 3: Previous code used `=== true || === "true"` which silently
  // failed when the value was integer 1 (possible after a round-trip through
  // the edit form). normalizeIsSubscription() handles all four shapes.
  const isSubscriptionValue = normalizeIsSubscription(is_subscription);

  const productId = randomUUID();

  await query(
    `INSERT INTO products
     (id, name, slug, category, description, price, mrp, quantity,
      stock_qty, image, features, popular, status, display_order,
      recommended_product_ids, is_subscription)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      productId,
      name,
      slug,
      category,
      description,
      parseFloat(price),
      parseFloat(mrp || price),
      parseInt(quantity),
      stockQuantity,
      image,
      featuresValue,
      popular === "true" || popular === true ? 1 : 0,
      productStatus,
      displayOrder !== undefined ? parseInt(displayOrder, 10) : 0,
      JSON.stringify([]),
      isSubscriptionValue,
    ],
  );

  const { rows } = await query(`SELECT * FROM products WHERE id = ? LIMIT 1`, [
    productId,
  ]);
  invalidateProductCache();
  emitProductEvent(req, "created", rows[0]);
  res.status(201).json(rows[0]);
};

// ============================================================
// PUT /api/admin/products/:id
// ============================================================
export const updateProduct = async (req, res) => {
  try {
    // DEBUG — remove after confirming is_subscription saves correctly
    // console.log("================================");
    // console.log("UPDATE PRODUCT BODY", req.body);
    // console.log("================================");

    const {
      name,
      category,
      description,
      price,
      mrp,
      quantity,
      features,
      popular,
      status,
      stockQty,
      isActive,
      displayOrder,
      is_subscription, // snake_case from frontend payload
    } = req.body;

    const updates = ["updated_at = now()"];
    const params = [];

    const add = (col, val) => {
      updates.push(`${col} = ?`);
      params.push(val);
    };

    if (name !== undefined) {
      add("name", name);
      add("slug", slugify(name));
    }
    if (category !== undefined) add("category", category);
    if (description !== undefined) add("description", description);
    if (price !== undefined) add("price", parseFloat(price));
    if (mrp !== undefined) add("mrp", parseFloat(mrp));
    if (quantity !== undefined) add("quantity", parseInt(quantity));
    if (popular !== undefined)
      add("popular", popular === "true" || popular === true ? 1 : 0);
    if (displayOrder !== undefined)
      add("display_order", parseInt(displayOrder, 10));
    if (isActive !== undefined)
      add("is_active", isActive === "true" || isActive === true ? 1 : 0);
    if (req.file) {
      const imagePath =
        req.file.path ||
        req.file.secure_url ||
        req.file.url ||
        req.file.filename;
      add("image", imagePath);
    }

    if (features !== undefined) {
      const normalizedFeatures = normalizeFeaturesInput(features);
      add("features", JSON.stringify(normalizedFeatures));
    }

    // BUG FIX 4: Previous code had a typo — "is_Subscription" (capital S)
    // inside the normalisation expression. JavaScript treated it as a new
    // undefined variable, so the expression always evaluated to false and
    // is_subscription was always written as 0 regardless of the checkbox.
    // Fixed by using normalizeIsSubscription() which uses the correct
    // lowercase variable name "is_subscription" throughout.
    if (is_subscription !== undefined) {
      add("is_subscription", normalizeIsSubscription(is_subscription));
    }

    const parsedStockQty =
      stockQty !== undefined ? parseInt(stockQty, 10) : undefined;
    const explicitStatus =
      status !== undefined ? normalizeProductStatus(status) : undefined;

    if (stockQty !== undefined) {
      add("stock_qty", Number.isFinite(parsedStockQty) ? parsedStockQty : 0);
    }

    const resolvedStatus =
      stockQty !== undefined
        ? parsedStockQty <= 0
          ? "Out Of Stock"
          : (explicitStatus ?? "In Stock")
        : explicitStatus;

    if (resolvedStatus !== undefined) {
      add("status", resolvedStatus);
    }

    if (!req.params.id) {
      console.error("Product update failed: missing product id", {
        body: req.body,
        file: req.file,
      });
      return res.status(400).json({
        success: false,
        message: "Product ID is required",
      });
    }

    params.push(req.params.id);

    const sql = `UPDATE products SET ${updates.join(", ")} WHERE id = ?`;
    await query(sql, params);

    const { rows } = await query(
      `SELECT * FROM products WHERE id = ? LIMIT 1`,
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });

    invalidateProductCache();
    emitProductEvent(req, "updated", rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error("Failed to update product:", err);
    return res.status(500).json({
      success: false,
      message: err?.message || "Unable to update product",
    });
  }
};

// ============================================================
// DELETE /api/admin/products/:id  — soft delete
// ============================================================
export const deleteProduct = async (req, res) => {
  await query(
    "UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [req.params.id],
  );

  const { rows } = await query(
    "SELECT id, image FROM products WHERE id = ? LIMIT 1",
    [req.params.id],
  );
  if (!rows.length)
    return res.status(404).json({ message: "Product not found" });

  invalidateProductCache();
  emitProductEvent(req, "deleted", { id: rows[0].id });

  if (rows[0].image?.includes("cloudinary.com")) {
    const publicId = rows[0].image.split("/").pop().split(".")[0];
    cloudinary.uploader
      .destroy(
        `${process.env.CLOUDINARY_UPLOAD_FOLDER || "bree-products"}/${publicId}`,
      )
      .catch(() => {});
  }

  res.json({ message: "Product deactivated" });
};

// ============================================================
// POST /api/admin/products/:id/relations
// ============================================================
export const setProductRelations = async (req, res) => {
  const productId = req.params.id;
  const relations = Array.isArray(req.body.relations) ? req.body.relations : [];

  const { rows: p } = await query(
    "SELECT id FROM products WHERE id = ? LIMIT 1",
    [productId],
  );
  if (!p.length) return res.status(404).json({ message: "Product not found" });

  await query("DELETE FROM product_relations WHERE product_id = ?", [
    productId,
  ]);

  if (relations.length === 0) {
    invalidateProductCache();
    return res.json({ message: "Relations cleared" });
  }

  const inserts = relations.map((r) => {
    const relId = r.related_product_id;
    const type = r.relation_type || "recommend";
    const weight = parseInt(r.weight || 0);
    return query(
      `INSERT INTO product_relations (product_id, related_product_id, relation_type, weight) VALUES (?, ?, ?, ?)`,
      [productId, relId, type, weight],
    );
  });

  await Promise.all(inserts);
  invalidateProductCache();
  res.json({ message: "Relations set" });
};

// ============================================================
// DELETE /api/admin/products/:id/relations/:relId
// ============================================================
export const deleteProductRelation = async (req, res) => {
  const { id, relId } = req.params;
  const { rows } = await query(
    "SELECT id FROM product_relations WHERE product_id = ? AND related_product_id = ? LIMIT 1",
    [id, relId],
  );
  if (!rows.length)
    return res.status(404).json({ message: "Relation not found" });

  await query(
    "DELETE FROM product_relations WHERE product_id = ? AND related_product_id = ?",
    [id, relId],
  );
  invalidateProductCache();
  res.json({ message: "Relation deleted" });
};

// ============================================================
// GET /api/admin/products/:id/relations
// ============================================================
export const getProductRelations = async (req, res) => {
  const productId = req.params.id;

  const { rows } = await query(
    `SELECT pr.related_product_id AS id,
            p.name,
            p.slug,
            p.image,
            pr.relation_type,
            pr.weight
     FROM product_relations pr
     JOIN products p ON p.id = pr.related_product_id
     WHERE pr.product_id = ?
     ORDER BY pr.weight DESC, p.name ASC`,
    [productId],
  );

  res.json(rows);
};
