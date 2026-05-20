import { query } from '../../config/database.js';
import { getOrderSchemaInfo } from '../../utils/orderSchema.js';
import cache from '../../utils/cache.js';

const DASHBOARD_TTL = 120; // 2 minutes

// GET /api/admin/dashboard
export const getDashboardStats = async (req, res) => {
  const cacheKey = 'admin:dashboard';
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }
  const now          = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const startOfWeek  = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const schemaInfo = await getOrderSchemaInfo();
  const useNew = schemaInfo.isNewOrderSchema;
  const amountExpr = useNew ? 'total' : 'amount';
  const nameExpr = useNew ? 'contact_name' : 'customer_name';
  const emailExpr = useNew ? 'contact_email' : 'email';

  const [
    ordersRes, revenueRes, customersRes, pendingRes,
    monthlyRevRes, weeklyOrdersRes, recentOrdersRes,
  ] = await Promise.all([
    query('SELECT COUNT(*)::int AS total FROM orders'),
    query(`SELECT COALESCE(SUM(${amountExpr}),0)::float AS total FROM orders WHERE payment_status='paid'`),
    query(`SELECT COUNT(*)::int AS total FROM users`),
    query(`SELECT COUNT(*)::int AS total FROM orders WHERE order_status='pending'`),
    query(`SELECT COALESCE(SUM(${amountExpr}),0)::float AS total FROM orders WHERE payment_status='paid' AND created_at >= $1`, [startOfMonth]),
    query(`SELECT COUNT(*)::int AS total FROM orders WHERE created_at >= $1`, [startOfWeek]),
    query(`SELECT o.id, o.${nameExpr} AS customer_name, o.${emailExpr} AS email, o.${amountExpr}::float AS amount, o.order_status,
                  o.payment_status, o.created_at
           FROM orders o ORDER BY o.created_at DESC LIMIT 5`),
  ]);

  const payload = {
    total_orders:       ordersRes.rows[0].total,
    total_revenue:      revenueRes.rows[0].total,
    total_customers:    customersRes.rows[0].total,
    pending_orders:     pendingRes.rows[0].total,
    revenue_this_month: monthlyRevRes.rows[0].total,
    orders_this_week:   weeklyOrdersRes.rows[0].total,
    recent_orders:      recentOrdersRes.rows,
  };

  cache.set(cacheKey, payload, DASHBOARD_TTL);
  res.json(payload);
};
