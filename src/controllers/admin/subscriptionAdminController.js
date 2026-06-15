import { query } from "../../config/database.js";
import { getRazorpay } from "../../config/razorpay.js";

const formatDate = (dateValue) => {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const normalizeStatusFilter = (status) => {
  if (!status || status === "all") return null;
  if (status === "payment_failed") return "past_due";
  return status;
};

const buildSubscriptionFilters = ({
  search,
  status,
  product,
  startDate,
  endDate,
}) => {
  const conditions = ["o.is_subscription = 1"];
  const params = [];

  if (search) {
    conditions.push(
      `(o.id LIKE ? OR o.contact_name LIKE ? OR o.email LIKE ? OR o.contact_phone LIKE ? OR o.razorpay_subscription_id LIKE ?)`,
    );
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }

  const normalizedStatus = normalizeStatusFilter(status);
  if (normalizedStatus) {
    conditions.push("o.subscription_status = ?");
    params.push(normalizedStatus);
  }

  if (product) {
    conditions.push(
      "EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id AND oi2.product_name LIKE ?)",
    );
    params.push(`%${product}%`);
  }

  if (startDate) {
    conditions.push("DATE(o.created_at) >= ?");
    params.push(startDate);
  }

  if (endDate) {
    conditions.push("DATE(o.created_at) <= ?");
    params.push(endDate);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
};

export const getSubscriptions = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      100,
    );
    const offset = (page - 1) * limit;

    const { search, status, product, startDate, endDate } = req.query;
    const { where, params } = buildSubscriptionFilters({
      search,
      status,
      product,
      startDate,
      endDate,
    });

    const [rowsResult, totalResult] = await Promise.all([
      query(
        `SELECT
           o.id,
           o.contact_name AS customer_name,
           o.email,
           o.contact_phone AS phone,
           o.razorpay_subscription_id AS razorpay_subscription_id,
           o.razorpay_plan_id AS razorpay_plan_id,
           o.total AS amount,
           o.subscription_status AS status,
           o.created_at AS start_date,
           o.next_billing_date AS next_billing_date,
           COUNT(DISTINCT oi.id) AS item_count,
           GROUP_CONCAT(DISTINCT oi.product_name SEPARATOR ', ') AS product_names,
           (SELECT COUNT(*) FROM orders o2 WHERE o2.razorpay_subscription_id = o.razorpay_subscription_id) AS renewal_count
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         ${where}
         GROUP BY o.id
         ORDER BY o.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) AS total FROM orders o ${where}`, params),
    ]);

    const subscriptions = rowsResult.rows.map((row) => ({
      id: row.id,
      customerName: row.customer_name,
      email: row.email,
      phone: row.phone,
      product: row.product_names || "-",
      frequency: "Monthly",
      amount: Number(row.amount || 0),
      status: row.status,
      startDate: row.start_date,
      nextBillingDate: row.next_billing_date,
      renewalCount: Number(row.renewal_count || 0),
      razorpaySubscriptionId: row.razorpay_subscription_id,
      razorpayPlanId: row.razorpay_plan_id,
    }));

    res.json({ subscriptions, total: totalResult.rows[0]?.total || 0 });
  } catch (error) {
    console.error("[ADMIN SUBSCRIPTIONS] Failed to load subscriptions", error);
    res.status(500).json({ message: "Failed to fetch subscriptions" });
  }
};

export const getSubscriptionDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT
         o.*, 
         u.name AS user_name,
         u.email AS user_email,
         u.phone AS user_phone,
         ua.full_name AS address_name,
         ua.phone AS address_phone,
         ua.address_line_1,
         ua.address_line_2,
         ua.city,
         ua.state,
         ua.pincode,
         ua.country,
         ua.address_type
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN user_addresses ua ON ua.id = o.address_id
       WHERE o.id = ? AND o.is_subscription = 1
       LIMIT 1`,
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const subscription = rows[0];

    const itemsResult = await query(
      `SELECT id, product_name, product_image, product_price, quantity, subtotal FROM order_items WHERE order_id = ?`,
      [id],
    );

    const billingResult = await query(
      `SELECT id, order_id, razorpay_payment_id, amount, currency, status, created_at, updated_at
       FROM payments
       WHERE razorpay_subscription_id = ?
       ORDER BY updated_at DESC`,
      [subscription.razorpay_subscription_id],
    );

    const renewalOrdersResult = await query(
      `SELECT id, total, order_status, payment_status, razorpay_order_id, razorpay_payment_id, created_at
       FROM orders
       WHERE razorpay_subscription_id = ?
       ORDER BY created_at DESC`,
      [subscription.razorpay_subscription_id],
    );

    res.json({
      subscription: {
        id: subscription.id,
        customerName: subscription.contact_name,
        email: subscription.email,
        phone: subscription.contact_phone,
        subscriptionStatus: subscription.subscription_status,
        paymentStatus: subscription.payment_status,
        razorpaySubscriptionId: subscription.razorpay_subscription_id,
        razorpayPlanId: subscription.razorpay_plan_id,
        amount: Number(subscription.total || 0),
        startDate: subscription.created_at,
        nextBillingDate: subscription.next_billing_date,
        lastRenewal: billingResult.rows.find(
          (payment) =>
            String(payment.status).toLowerCase() === "captured" ||
            String(payment.status).toLowerCase() === "paid",
        )?.updated_at,
        productItems: itemsResult.rows,
        address: {
          fullName: subscription.address_name || subscription.contact_name,
          phone: subscription.address_phone || subscription.contact_phone,
          line1: subscription.address_line_1,
          line2: subscription.address_line_2,
          city: subscription.city,
          state: subscription.state,
          pincode: subscription.pincode,
          country: subscription.country,
          addressType: subscription.address_type,
          raw: subscription.shipping_address,
        },
        razorpayOrderId: subscription.razorpay_order_id,
        cancelReason: subscription.cancel_reason || null,
        cancelledBy: subscription.cancelled_by || null,
        cancelledAt: subscription.cancelled_at || null,
      },
      billingHistory: billingResult.rows,
      renewalOrders: renewalOrdersResult.rows,
    });
  } catch (error) {
    console.error(
      "[ADMIN SUBSCRIPTIONS] Failed to load subscription details",
      error,
    );
    res.status(500).json({ message: "Failed to load subscription details" });
  }
};

const updateSubscriptionOrder = async ({
  orderId,
  subscriptionStatus,
  orderStatus,
  notes,
  cancelReason,
  cancelledBy,
  cancelledAt,
}) => {
  const updates = [];
  const params = [];

  if (subscriptionStatus) {
    updates.push("subscription_status = ?");
    params.push(subscriptionStatus);
  }
  if (orderStatus) {
    updates.push("order_status = ?");
    params.push(orderStatus);
  }
  if (notes !== undefined) {
    updates.push("notes = ?");
    params.push(notes);
  }
  if (cancelReason !== undefined) {
    updates.push("cancel_reason = ?");
    params.push(cancelReason);
  }
  if (cancelledBy !== undefined) {
    updates.push("cancelled_by = ?");
    params.push(cancelledBy);
  }
  if (cancelledAt !== undefined) {
    updates.push("cancelled_at = ?");
    params.push(cancelledAt);
  }

  if (!updates.length) return;
  params.push(orderId);

  await query(
    `UPDATE orders SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
    params,
  );

  await query(
    `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [
      orderId,
      null,
      orderStatus || subscriptionStatus || "updated",
      null,
      notes || null,
    ],
  );
};

export const pauseSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      "SELECT id, razorpay_subscription_id FROM orders WHERE id = ? AND is_subscription = 1",
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];
    const rzp = getRazorpay();
    const response = await rzp.subscriptions.pause(
      order.razorpay_subscription_id,
      {
        pause_at_cycle_end: 0,
        customer_notify: 1,
      },
    );

    await updateSubscriptionOrder({
      orderId: order.id,
      subscriptionStatus: response.status || "paused",
      notes: "Subscription paused",
    });

    res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    console.error("[ADMIN SUBSCRIPTIONS] Pause failed", error);
    res.status(500).json({ message: "Failed to pause subscription" });
  }
};

export const resumeSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      "SELECT id, razorpay_subscription_id FROM orders WHERE id = ? AND is_subscription = 1",
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];
    const rzp = getRazorpay();
    const response = await rzp.subscriptions.resume(
      order.razorpay_subscription_id,
      {
        customer_notify: 1,
      },
    );

    await updateSubscriptionOrder({
      orderId: order.id,
      subscriptionStatus: response.status || "active",
      notes: "Subscription resumed",
    });

    res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    console.error("[ADMIN SUBSCRIPTIONS] Resume failed", error);
    res.status(500).json({ message: "Failed to resume subscription" });
  }
};

export const cancelSubscription = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const admin = req.admin;

    const { rows } = await query(
      "SELECT id, razorpay_subscription_id FROM orders WHERE id = ? AND is_subscription = 1",
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];
    const rzp = getRazorpay();
    const response = await rzp.subscriptions.cancel(
      order.razorpay_subscription_id,
      {
        cancel_at_cycle_end: 1,
        customer_notify: 1,
      },
    );

    await updateSubscriptionOrder({
      orderId: order.id,
      subscriptionStatus: response.status || "cancelled",
      orderStatus: "cancelled",
      notes: "Subscription cancelled by admin",
      cancelReason: reason || null,
      cancelledBy: admin?.email || admin?.id || null,
      cancelledAt: new Date().toLocaleString("sv-SE", {
        timeZone: "Asia/Kolkata",
      }),
    });

    res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    console.error("[ADMIN SUBSCRIPTIONS] Cancel failed", error);
    res.status(500).json({ message: "Failed to cancel subscription" });
  }
};

export const getSubscriptionAnalytics = async (req, res) => {
  try {
    const [summaryResult, statusResult, trendResult, paymentResult] =
      await Promise.all([
        query(`
        SELECT
          SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) AS active_subscriptions,
          SUM(CASE WHEN subscription_status = 'paused' THEN 1 ELSE 0 END) AS paused_subscriptions,
          SUM(CASE WHEN subscription_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_subscriptions,
          SUM(CASE WHEN subscription_status = 'active' THEN total ELSE 0 END) AS monthly_recurring_revenue,
          SUM(CASE WHEN subscription_status = 'active' THEN total ELSE 0 END) AS expected_next_month_revenue,
          COUNT(*) AS total_subscriptions
        FROM orders
        WHERE is_subscription = 1`),
        query(`
        SELECT subscription_status AS status, COUNT(*) AS count
        FROM orders
        WHERE is_subscription = 1
        GROUP BY subscription_status`),
        query(`
        SELECT DATE_FORMAT(created_at, '%b %Y') AS month,
               COUNT(*) AS count,
               SUM(total) AS revenue
        FROM orders
        WHERE is_subscription = 1
          AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
        GROUP BY month
        ORDER BY MIN(created_at) ASC`),
        query(`
        SELECT
          SUM(CASE WHEN status IN ('captured','paid') THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
        FROM payments
        WHERE razorpay_subscription_id IS NOT NULL
          AND updated_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`),
      ]);

    const summary = summaryResult.rows[0] || {};
    const paymentStats = paymentResult.rows[0] || {};
    const success = Number(paymentStats.success_count || 0);
    const failed = Number(paymentStats.failed_count || 0);
    const renewalSuccessRate =
      success + failed > 0
        ? Number(((success / (success + failed)) * 100).toFixed(1))
        : 0;

    const statusBreakdown = statusResult.rows.map((row) => ({
      status: row.status,
      count: Number(row.count || 0),
    }));

    const monthlyTrend = trendResult.rows.map((row) => ({
      month: row.month,
      count: Number(row.count || 0),
      revenue: Number(row.revenue || 0),
    }));

    res.json({
      totalActiveSubscriptions: Number(summary.active_subscriptions || 0),
      pausedSubscriptions: Number(summary.paused_subscriptions || 0),
      cancelledSubscriptions: Number(summary.cancelled_subscriptions || 0),
      monthlyRecurringRevenue: Number(summary.monthly_recurring_revenue || 0),
      expectedNextMonthRevenue: Number(
        summary.expected_next_month_revenue || 0,
      ),
      renewalSuccessRate,
      statusBreakdown,
      monthlyTrend,
    });
  } catch (error) {
    console.error("[ADMIN SUBSCRIPTIONS] Analytics failed", error);
    res.status(500).json({ message: "Failed to fetch subscription analytics" });
  }
};

export const getUpcomingRenewals = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        SUM(CASE WHEN DATE(next_billing_date) = CURDATE() THEN 1 ELSE 0 END) AS renewing_today,
        SUM(CASE WHEN DATE(next_billing_date) = DATE_ADD(CURDATE(), INTERVAL 1 DAY) THEN 1 ELSE 0 END) AS renewing_tomorrow,
        SUM(CASE WHEN DATE(next_billing_date) > CURDATE() AND DATE(next_billing_date) <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS renewing_this_week
      FROM orders
      WHERE is_subscription = 1
        AND subscription_status = 'active'
        AND next_billing_date IS NOT NULL`);

    res.json({
      renewingToday: Number(rows[0]?.renewing_today || 0),
      renewingTomorrow: Number(rows[0]?.renewing_tomorrow || 0),
      renewingThisWeek: Number(rows[0]?.renewing_this_week || 0),
    });
  } catch (error) {
    console.error("[ADMIN SUBSCRIPTIONS] Upcoming renewals failed", error);
    res.status(500).json({ message: "Failed to fetch upcoming renewals" });
  }
};

export const getFailedRenewals = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        p.id AS payment_id,
        p.order_id,
        p.razorpay_payment_id,
        p.amount,
        p.status,
        p.updated_at AS failure_date,
        o.contact_name AS customer_name,
        o.email,
        oi.product_name AS product_name
      FROM payments p
      JOIN orders o ON o.razorpay_subscription_id = p.razorpay_subscription_id AND o.is_subscription = 1
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE p.status = 'failed'
        AND p.razorpay_subscription_id IS NOT NULL
      GROUP BY p.id
      ORDER BY p.updated_at DESC
      LIMIT 10`);

    res.json({ failedRenewals: rows });
  } catch (error) {
    console.error("[ADMIN SUBSCRIPTIONS] Failed renewals failed", error);
    res.status(500).json({ message: "Failed to fetch failed renewals" });
  }
};
