import { query } from "../config/database.js";
import cache from "../utils/cache.js";

const PRODUCT_LIST_TTL = 300;
const PRODUCT_DETAIL_TTL = 600;
const CATEGORY_LIST_TTL = 600;
const HOME_DATA_TTL = 600;
const RECOMMENDATIONS_TTL = 300;

// ============================================================
// COMMON PRODUCT SELECT
// ============================================================
// journey_level and show_recommendations are included in every
// product query so frontend components have them available without
// extra round-trips.

const PRODUCT_SELECT = `
 SELECT
  p.id,
  p.name,
  p.slug,
  p.category,
  p.description,
  p.price,
  p.mrp,
  p.quantity,
  p.stock_qty,
  p.image,
  p.features,
  p.popular,
  p.status,
  p.is_subscription,
  p.journey_level,
  p.show_recommendations

  FROM products p
`;

// ============================================================
// GET ALL PRODUCTS
// ============================================================

export const getProducts = async (req, res) => {
  try {
    const category = req.query.category?.trim();
    const cacheKey = category
      ? `products:category:${category.toLowerCase()}`
      : "products:all";

    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const hasCategory = Boolean(category);
    const queryText = `
      ${PRODUCT_SELECT}
      WHERE p.is_active = 1
      ${hasCategory ? "AND p.category = ?" : ""}
      ORDER BY p.display_order ASC, p.created_at ASC
    `;
    const params = hasCategory ? [category] : [];

    const { rows } = await query(queryText, params);
    cache.set(cacheKey, rows, PRODUCT_LIST_TTL);

    res.json(rows);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ message: "Failed to fetch products" });
  }
};

// ============================================================
// GET SINGLE PRODUCT
// ============================================================

export const getProduct = async (req, res) => {
  try {
    const cacheKey = `products:id:${req.params.id}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const { rows } = await query(
      `
      ${PRODUCT_SELECT}
      WHERE (p.id = ? OR p.slug = ?)
      AND p.is_active = 1
      LIMIT 1
      `,
      [req.params.id, req.params.id],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    const product = rows[0];
    cache.set(cacheKey, product, PRODUCT_DETAIL_TTL);
    if (product.slug) {
      cache.set(`products:id:${product.slug}`, product, PRODUCT_DETAIL_TTL);
    }
    if (product.id) {
      cache.set(`products:id:${product.id}`, product, PRODUCT_DETAIL_TTL);
    }

    res.json(product);
  } catch (error) {
    console.error("Error fetching product:", error);
    res.status(500).json({ message: "Failed to fetch product" });
  }
};

// ============================================================
// GET HOME PRODUCTS
// ============================================================

export const getHomeProducts = async (req, res) => {
  try {
    const cacheKey = "products:home";
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Lead with journey_level=1 product (trial), then popular product
    const trialRes = await query(`
      ${PRODUCT_SELECT}
      WHERE p.is_active = 1
      AND p.journey_level = 1
      LIMIT 1
    `);

    const featuredRes = await query(`
      ${PRODUCT_SELECT}
      WHERE p.is_active = 1
      AND p.popular = 1
      LIMIT 1
    `);

    const results = [];

    if (trialRes.rows.length) {
      results.push(trialRes.rows[0]);
    }

    if (
      featuredRes.rows.length &&
      (!trialRes.rows.length || featuredRes.rows[0].id !== trialRes.rows[0].id)
    ) {
      results.push(featuredRes.rows[0]);
    }

    if (results.length < 2) {
      const { rows } = await query(`
        ${PRODUCT_SELECT}
        WHERE p.is_active = 1
        ORDER BY p.display_order ASC, p.created_at ASC
        LIMIT 2
      `);
      cache.set(cacheKey, rows, PRODUCT_LIST_TTL);
      return res.json(rows);
    }

    cache.set(cacheKey, results, PRODUCT_LIST_TTL);
    res.json(results);
  } catch (error) {
    console.error("Error fetching home products:", error);
    res.status(500).json({ message: "Failed to fetch home products" });
  }
};

// ============================================================
// CATEGORIES
// ============================================================

export const getCategories = async (req, res) => {
  try {
    const cacheKey = "products:categories";
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const { rows } = await query(
      `SELECT DISTINCT category FROM products WHERE is_active = 1 AND category IS NOT NULL ORDER BY category ASC`,
    );

    const categories = rows.map((row) => row.category).filter(Boolean);
    cache.set(cacheKey, categories, CATEGORY_LIST_TTL);
    res.json(categories);
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
};

// ============================================================
// HOME DATA
// ============================================================

export const getHomeData = async (req, res) => {
  try {
    const cacheKey = "home:data";
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const banners = [
      {
        id: "hero",
        title: "Pure Amla Wellness",
        subtitle: "Every day natural immunity in a shot",
        image: "/images/home-banner-1.png",
      },
      {
        id: "shipping",
        title: "Free Shipping",
        subtitle: "On all orders above ₹499",
        image: "/images/home-banner-2.png",
      },
    ];

    const [featuredRes, popularRes, categoriesRes, testimonialsRes] =
      await Promise.all([
        query(`
          ${PRODUCT_SELECT}
          WHERE p.is_active = 1
          AND p.journey_level = 1
          LIMIT 1
        `),
        query(`
          ${PRODUCT_SELECT}
          WHERE p.is_active = 1
          AND p.popular = 1
          LIMIT 4
        `),
        query(
          `SELECT DISTINCT category FROM products WHERE is_active = 1 AND category IS NOT NULL ORDER BY category ASC`,
        ),
        query(`
          SELECT id, user_id, name, role, avatar, text, rating, created_at, updated_at
          FROM testimonials
          WHERE status = 'approved'
          ORDER BY created_at DESC
          LIMIT 10
        `),
      ]);

    const data = {
      banners,
      featured_products: featuredRes.rows,
      recommendations: popularRes.rows,
      categories: categoriesRes.rows.map((row) => row.category).filter(Boolean),
      testimonials: testimonialsRes.rows,
    };

    cache.set(cacheKey, data, HOME_DATA_TTL);
    res.json(data);
  } catch (error) {
    console.error("Error fetching home data:", error);
    res.status(500).json({ message: "Failed to fetch home data" });
  }
};

// ============================================================
// GET PRODUCT RECOMMENDATIONS — Journey-based, admin-safe
// ============================================================
//
// Logic (mirrors the business rules, zero hardcoded IDs/names):
//
//   show_recommendations = 0  → return []
//   is_subscription = 1       → return []
//   journey_level = 0         → return []  (unclassified product)
//   journey_level = 1         → next level only   (level 2)
//   journey_level = 2         → next 2 levels     (level 3, 4)  — non-sub only
//   journey_level = 3         → next level only   (level 4)
//   journey_level = 4         → return []          (highest level)
//   journey_level = 5+        → return []
//
// Filters applied automatically:
//   - inactive products excluded  (is_active = 1)
//   - subscription products excluded from upgrade suggestions
//   - out-of-stock products excluded  (stock_qty > 0 AND status != 'Out Of Stock')
//
// The caller (CartDrawer) further filters products already in the cart.

export const getRecommendations = async (req, res) => {
  try {
    const prodId = req.params.id;
    const cacheKey = `products:${prodId}:recommendations`;

    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // 1. Fetch the source product
    const { rows: prodRows } = await query(
      `
      SELECT id, name, journey_level, show_recommendations, is_subscription
      FROM products
      WHERE (id = ? OR slug = ?)
        AND is_active = 1
      LIMIT 1
      `,
      [prodId, prodId],
    );

    if (!prodRows.length) {
      // console.log(
      //   "⚠️ Product not found, returning empty recommendations:",
      //   prodId,
      // );
      cache.set(cacheKey, [], RECOMMENDATIONS_TTL);
      return res.json([]);
    }

    const product = prodRows[0];

    // Debug logs as required
    // console.log("Current Product:", product.name);
    // console.log("Journey Level:", product.journey_level);
    // console.log("Is Subscription:", product.is_subscription);

    // 2. Guard clauses — return early with no recommendations
    if (
      product.show_recommendations === 0 ||
      product.is_subscription === 1 ||
      product.journey_level === 0 ||
      product.journey_level >= 4
    ) {
      // console.log("Recommended Products: [] (suppressed by rules)");
      cache.set(cacheKey, [], RECOMMENDATIONS_TTL);
      return res.json([]);
    }

    // 3. Determine which journey levels to fetch
    //    level 1 → [2]
    //    level 2 → [3, 4]
    //    level 3 → [4]
    const levelMap = {
      1: [2],
      2: [3, 4],
      3: [4],
    };

    const targetLevels = levelMap[product.journey_level];
    if (!targetLevels || targetLevels.length === 0) {
      // console.log("Recommended Products: []");
      cache.set(cacheKey, [], RECOMMENDATIONS_TTL);
      return res.json([]);
    }

    // 4. Fetch matching products — dynamic, no hardcoded IDs
    const placeholders = targetLevels.map(() => "?").join(",");
    const { rows } = await query(
      `
      SELECT
        id,
        name,
        slug,
        description,
        price,
        mrp,
        quantity,
        stock_qty,
        image,
        features,
        popular,
        status,
        is_subscription,
        journey_level,
        show_recommendations
      FROM products
      WHERE journey_level IN (${placeholders})
        AND is_active = 1
        AND is_subscription = 0
        AND stock_qty > 0
        AND status != 'Out Of Stock'
      ORDER BY journey_level ASC
      `,
      targetLevels,
    );

    const recommendations = rows.map((prod) => ({
      id: prod.id,
      name: prod.name,
      slug: prod.slug,
      image: prod.image,
      price: parseFloat(prod.price),
      mrp: parseFloat(prod.mrp),
      quantity: prod.quantity,
      is_subscription: prod.is_subscription,
      journey_level: prod.journey_level,
    }));

    // console.log(
    //   "Recommended Products:",
    //   recommendations.map((r) => r.name),
    // );

    cache.set(cacheKey, recommendations, RECOMMENDATIONS_TTL);
    res.json(recommendations);
  } catch (error) {
    console.error("❌ Error fetching recommendations:", error);
    res.status(500).json({ message: "Failed to fetch recommendations" });
  }
};
