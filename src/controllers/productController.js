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
    p.price::float,
    p.mrp::float,
    p.quantity,
    p.stock_qty,
    p.image,
    p.features,
    p.popular,
    p.status,
    p.recommended_product_ids,

    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', rp.id,
            'name', rp.name,
            'slug', rp.slug,
            'category', rp.category,
            'description', rp.description,
            'price', rp.price::float,
            'mrp', rp.mrp::float,
            'quantity', rp.quantity,
            'stock_qty', rp.stock_qty,
            'image', rp.image,
            'features', rp.features,
            'popular', rp.popular,
            'status', rp.status
          )
        )
        FROM products rp
        WHERE rp.id::uuid = ANY(p.recommended_product_ids)
        AND rp.is_active = true
      ),
      '[]'::json
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
      WHERE p.is_active = true
      ${hasCategory ? "AND p.category = $1" : ""}
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
      WHERE (p.id = $1 OR p.slug = $1)
      AND p.is_active = true
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
      WHERE p.is_active = true
      AND p.quantity = 7
      LIMIT 1
    `);

    const featuredRes = await query(`
      ${PRODUCT_SELECT}
      WHERE p.is_active = true
      AND p.popular = true
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
        WHERE p.is_active = true
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
      `SELECT DISTINCT category FROM products WHERE is_active = true AND category IS NOT NULL ORDER BY category ASC`
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
        id: 'hero',
        title: 'Pure Amla Wellness',
        subtitle: 'Every day natural immunity in a shot',
        image: '/images/home-banner-1.png',
      },
      {
        id: 'shipping',
        title: 'Free Shipping',
        subtitle: 'On all orders above ₹499',
        image: '/images/home-banner-2.png',
      },
    ];

    const [featuredRes, popularRes, categoriesRes, testimonialsRes] = await Promise.all([
      query(`
        ${PRODUCT_SELECT}
        WHERE p.is_active = true
        AND p.quantity = 7
        LIMIT 1
      `),
      query(`
        ${PRODUCT_SELECT}
        WHERE p.is_active = true
        AND p.popular = true
        LIMIT 4
      `),
      query(`SELECT DISTINCT category FROM products WHERE is_active = true AND category IS NOT NULL ORDER BY category ASC`),
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
      WHERE (id = $1 OR slug = $1)
      AND is_active = true
      LIMIT 1
      `,
      [prodId],
    );

    if (!prodRows.length) {
      return res.status(404).json({
        message: "Product not found",
      });
    }

    const recommendedIds = prodRows[0].recommended_product_ids || [];

    if (!recommendedIds.length) {
      cache.set(cacheKey, [], RECOMMENDATIONS_TTL);
      return res.json([]);
    }

    const { rows } = await query(
      `
      SELECT
        id,
        name,
        slug,
        category,
        description,
        price::float,
        mrp::float,
        quantity,
        stock_qty,
        image,
        features,
        popular,
        status
      FROM products
      WHERE id::uuid = ANY($1::uuid[])
      AND is_active = true
      ORDER BY array_position($1::uuid[], id::uuid)
      `,
      [recommendedIds],
    );

    cache.set(cacheKey, rows, RECOMMENDATIONS_TTL);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching recommendations:", error);

    res.status(500).json({
      message: "Failed to fetch recommendations",
    });
  }
};
