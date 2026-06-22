import { query } from "../../config/database.js";
import { getOrderSchemaInfo } from "../../utils/orderSchema.js";
import cache from "../../utils/cache.js";

const DASHBOARD_TTL = 120;

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
        WHERE order_status = 'pending'
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
          o.created_at
        FROM orders o
        ORDER BY o.created_at DESC
        LIMIT 5
      `),
    ]);

    const payload = {
      total_orders: Number(ordersRes.rows?.[0]?.total || 0),

      total_revenue: Number(revenueRes.rows?.[0]?.total || 0),

      total_customers: Number(customersRes.rows?.[0]?.total || 0),

      pending_orders: Number(pendingRes.rows?.[0]?.total || 0),

      total_bulk_bookings: Number(bulkBookingsRes.rows?.[0]?.total || 0),

      revenue_this_month: Number(monthlyRevRes.rows?.[0]?.total || 0),

      orders_this_week: Number(weeklyOrdersRes.rows?.[0]?.total || 0),

      recent_orders: recentOrdersRes.rows || [],
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