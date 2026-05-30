import { query } from "../config/database.js";
import cache from "../utils/cache.js";

const PRODUCT_LIST_TTL = 300; // 5 minutes
const PRODUCT_DETAIL_TTL = 600; // 10 minutes
const CATEGORY_LIST_TTL = 600; // 10 minutes
const HOME_DATA_TTL = 600; // 10 minutes
const RECOMMENDATIONS_TTL = 300; // 5 minutes

// ========================================
// COMMON PRODUCT SELECT
// ========================================

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
    p.recommended_product_ids,

    COALESCE(
      (
        SELECT JSON_ARRAYAGG(
          JSON_OBJECT(
            'id', rp.id,
            'name', rp.name,
            'slug', rp.slug,
            'category', rp.category,
            'description', rp.description,
            'price', rp.price,
            'mrp', rp.mrp,
            'quantity', rp.quantity,
            'stock_qty', rp.stock_qty,
            'image', rp.image,
            'features', rp.features,
            'popular', rp.popular,
            'status', rp.status
          )
        )
        FROM products rp
        WHERE JSON_CONTAINS(p.recommended_product_ids, JSON_QUOTE(rp.id))
        AND rp.is_active = 1
      ),
      JSON_ARRAY()
    ) AS recommendations

  FROM products p
`;

// ========================================
// GET ALL PRODUCTS
// ========================================

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
      ORDER BY p.popular DESC, p.created_at ASC
    `;
    const params = hasCategory ? [category] : [];

    const { rows } = await query(queryText, params);
    cache.set(cacheKey, rows, PRODUCT_LIST_TTL);

    res.json(rows);
  } catch (error) {
    console.error("Error fetching products:", error);

    res.status(500).json({
      message: "Failed to fetch products",
    });
  }
};

// ========================================
// GET SINGLE PRODUCT
// ========================================

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
      [req.params.id],
    );

    if (!rows.length) {
      return res.status(404).json({
        message: "Product not found",
      });
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

    res.status(500).json({
      message: "Failed to fetch product",
    });
  }
};

// ========================================
// GET HOME PRODUCTS
// ========================================

export const getHomeProducts = async (req, res) => {
  try {
    const cacheKey = "products:home";
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const trialRes = await query(`
      ${PRODUCT_SELECT}
      WHERE p.is_active = 1
      AND p.quantity = 7
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
        ORDER BY p.popular DESC, p.created_at ASC
        LIMIT 2
      `);
      cache.set(cacheKey, rows, PRODUCT_LIST_TTL);
      return res.json(rows);
    }

    cache.set(cacheKey, results, PRODUCT_LIST_TTL);
    res.json(results);
  } catch (error) {
    console.error("Error fetching home products:", error);

    res.status(500).json({
      message: "Failed to fetch home products",
    });
  }
};

// ========================================
// HOME DATA
// ========================================

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
        AND p.quantity = 7
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

// ========================================
// GET PRODUCT RECOMMENDATIONS
// ========================================

export const getRecommendations = async (req, res) => {
  try {
    const prodId = req.params.id;
    const cacheKey = `products:${prodId}:recommendations`;
    const cached = cache.get(cacheKey);
    if (cached) {

      return res.json(cached);
    }

    const { rows: prodRows } = await query(
      `
      SELECT recommended_product_ids
      FROM products
      WHERE (id = ? OR slug = ?)
      AND is_active = 1
      LIMIT 1
      `,
      [prodId, prodId],
    );

    if (!prodRows.length) {
      console.log("❌ Product not found:", prodId);
      return res.status(404).json({
        message: "Product not found",
      });
    }

    let recommendedIds = prodRows[0].recommended_product_ids || [];

    // Parse JSON if it's a string (shouldn't happen with mysql2 but just in case)
    if (typeof recommendedIds === "string") {
      try {
        recommendedIds = JSON.parse(recommendedIds);
      } catch (e) {
        console.warn(
          "Failed to parse recommended_product_ids:",
          recommendedIds,
        );
        recommendedIds = [];
      }
    }


    if (!Array.isArray(recommendedIds) || !recommendedIds.length) {
      console.log("⚠️  No recommendations found for product:", prodId);
      cache.set(cacheKey, [], RECOMMENDATIONS_TTL);
      return res.json([]);
    }

    const placeholders = recommendedIds.map(() => "?").join(",");
    const { rows } = await query(
      `SELECT
         id,
         name,
         slug,
         category,
         description,
         price,
         mrp,
         quantity,
         stock_qty,
         image,
         features,
         popular,
         status
       FROM products
       WHERE id IN (${placeholders})
       AND is_active = 1
       AND stock_qty > 0
       ORDER BY FIELD(id, ${placeholders})`,
      [...recommendedIds, ...recommendedIds],
    );


    // Format response
    const formattedRecommendations = rows.map((prod) => ({
      id: prod.id,
      name: prod.name,
      image: prod.image,
      price: parseFloat(prod.price),
      mrp: parseFloat(prod.mrp),
      quantity: prod.quantity,
    }));


    cache.set(cacheKey, formattedRecommendations, RECOMMENDATIONS_TTL);
    res.json(formattedRecommendations);
  } catch (error) {
    console.error("❌ Error fetching recommendations:", error);

    res.status(500).json({
      message: "Failed to fetch recommendations",
    });
  }
};
