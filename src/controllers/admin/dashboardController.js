import { query } from "../../config/database.js";
import { getOrderSchemaInfo } from "../../utils/orderSchema.js";
import cache from "../../utils/cache.js";

const DASHBOARD_TTL = 120;

const normalizeRecentOrderItems = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

// GET /api/admin/dashboard
export const getDashboardStats = async (req, res) => {
  try {
    const cacheKey = "admin:dashboard";

    const cached = cache.get(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const now = new Date();

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const startOfWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const schemaInfo = await getOrderSchemaInfo();

    const nameExpr = schemaInfo.isNewOrderSchema
      ? "contact_name"
      : "customer_name";

    const emailExpr = schemaInfo.isNewOrderSchema ? "contact_email" : "email";

    const amountExpr = "COALESCE(total, amount)";
    const amountExprWithAlias = "COALESCE(o.total, o.amount)";

    const [
      ordersRes,
      revenueRes,
      customersRes,
      pendingRes,
      bulkBookingsRes,
      monthlyRevRes,
      weeklyOrdersRes,
      recentOrdersRes,
    ] = await Promise.all([
      query(`
        SELECT COUNT(*) AS total
        FROM orders
      `),

      query(`
        SELECT COALESCE(SUM(${amountExpr}), 0) AS total
        FROM orders
        WHERE payment_status = 'paid'
      `),

      query(`
        SELECT COUNT(*) AS total
        FROM users
      `),

      query(`
        SELECT COUNT(*) AS total
        FROM orders
        WHERE order_status = 'pending_payment'
      `),

      query(`
        SELECT COUNT(*) AS total
        FROM bulk_bookings
      `),

      query(
        `
        SELECT COALESCE(SUM(${amountExpr}), 0) AS total
        FROM orders
        WHERE payment_status = 'paid'
        AND created_at >= ?
        `,
        [startOfMonth],
      ),

      query(
        `
        SELECT COUNT(*) AS total
        FROM orders
        WHERE created_at >= ?
        `,
        [startOfWeek],
      ),

      query(`
        SELECT
          o.id,
          o.order_number,
          o.${nameExpr} AS customer_name,
          o.${emailExpr} AS email,
          ${amountExprWithAlias} AS amount,
          o.order_status,
          o.payment_status,
          o.created_at,
          COALESCE(
            (
              SELECT GROUP_CONCAT(DISTINCT COALESCE(p.name, oi2.product_name) ORDER BY oi2.created_at ASC SEPARATOR ', ')
              FROM order_items oi2
              LEFT JOIN products p ON p.id = oi2.product_id
              WHERE oi2.order_id = o.id
            ),
            ''
          ) AS product_names,
          COALESCE(
            (
              SELECT JSON_ARRAYAGG(JSON_OBJECT(
                'id', oi3.id,
                'product_id', oi3.product_id,
                'product_name', COALESCE(p2.name, oi3.product_name),
                'name', COALESCE(p2.name, oi3.product_name),
                'quantity', oi3.quantity,
                'unit_price', oi3.product_price,
                'total_price', oi3.subtotal
              ))
              FROM order_items oi3
              LEFT JOIN products p2 ON p2.id = oi3.product_id
              WHERE oi3.order_id = o.id
            ),
            JSON_ARRAY()
          ) AS items
        FROM orders o
        ORDER BY o.created_at DESC
        LIMIT 5
      `),
    ]);

    const recentOrders = (recentOrdersRes.rows || []).map((order) => ({
      ...order,
      items: normalizeRecentOrderItems(order.items),
    }));

    const payload = {
      total_orders: Number(ordersRes.rows?.[0]?.total || 0),

      total_revenue: Number(revenueRes.rows?.[0]?.total || 0),

      total_customers: Number(customersRes.rows?.[0]?.total || 0),

      pending_orders: Number(pendingRes.rows?.[0]?.total || 0),

      total_bulk_bookings: Number(bulkBookingsRes.rows?.[0]?.total || 0),

      revenue_this_month: Number(monthlyRevRes.rows?.[0]?.total || 0),

      orders_this_week: Number(weeklyOrdersRes.rows?.[0]?.total || 0),

      recent_orders: recentOrders,
    };

    cache.set(cacheKey, payload, DASHBOARD_TTL);

    return res.json(payload);
  } catch (error) {
    console.error("Dashboard Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load dashboard statistics",
      error: error.message,
    });
  }
};
