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
    // FIX (Requirement §2): Added o.order_number to search conditions
    conditions.push(
      `(o.id LIKE ? OR o.order_number LIKE ? OR o.contact_name LIKE ? OR o.email LIKE ? OR o.contact_phone LIKE ? OR o.razorpay_subscription_id LIKE ?)`,
    );
    const searchTerm = `%${search}%`;
    params.push(
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
    );
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
           o.order_number,
           o.contact_name AS customer_name,
           o.email,
           o.contact_phone AS phone,
           o.razorpay_subscription_id AS razorpay_subscription_id,
           o.razorpay_plan_id AS razorpay_plan_id,
           o.total AS amount,
           o.subscription_status AS status,
           o.order_status AS order_status,
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

    // FIX (Requirement §1 & §5): Added orderNumber to every subscription object
    const subscriptions = rowsResult.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      customerName: row.customer_name,
      email: row.email,
      phone: row.phone,
      product: row.product_names || "-",
      frequency: "Monthly",
      amount: Number(row.amount || 0),
      status: row.status,
      orderStatus: row.order_status || null,
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
  // console.log("[DETAILS PARAM]", req.params.id);

  try {
    const { id } = req.params;

    // console.log("[SUB DETAILS] QUERY START", { subscriptionId: id });

    const { rows } = await query(
      `SELECT
         o.*,
         u.name  AS user_name,
         u.email AS user_email,
         u.phone AS user_phone,

         -- user_addresses columns (preferred — richer data)
         ua2.full_name      AS ua2_full_name,
         ua2.phone          AS ua2_phone,
         ua2.address_line_1 AS ua2_line1,
         ua2.address_line_2 AS ua2_line2,
         ua2.city           AS ua2_city,
         ua2.state          AS ua2_state,
         ua2.pincode        AS ua2_pincode,
         ua2.country        AS ua2_country,
         ua2.address_type   AS ua2_address_type,

         -- addresses columns (fallback — FK target)
         a1.label           AS a1_label,
         a1.address_line1   AS a1_line1,
         a1.address_line2   AS a1_line2,
         a1.city            AS a1_city,
         a1.state           AS a1_state,
         a1.pincode         AS a1_pincode,
         a1.country         AS a1_country

       FROM orders o
       LEFT JOIN users u        ON u.id   = o.user_id
       LEFT JOIN addresses a1   ON a1.id  = o.address_id
       LEFT JOIN user_addresses ua2 ON ua2.id = o.address_id
       WHERE o.id = ? AND o.is_subscription = 1
       LIMIT 1`,
      [id],
    );

    // console.log("[SUB DETAILS] QUERY START", { subscriptionId: id });
    // console.log("[MAIN QUERY RESULT]", rows);

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const s = rows[0];

    // console.log("[SUB DETAILS] QUERY START items", { orderId: id });

    const itemsResult = await query(
      `SELECT id, product_name, product_image, product_price, quantity, subtotal
       FROM order_items
       WHERE order_id = ?`,
      [id],
    );
    // console.log("[ITEMS RESULT]", itemsResult.rows);

    // console.log("[SUB DETAILS] QUERY START payments", {
    //   razorpaySubscriptionId: s.razorpay_subscription_id,
    // });

    let billingRows = [];
    if (s.razorpay_subscription_id) {
      const billingResult = await query(
        `SELECT p.id, p.order_id, p.razorpay_payment_id, p.amount, p.currency,
                p.status, p.created_at, p.updated_at,
                o.order_number AS order_number
         FROM payments p
         LEFT JOIN orders o ON o.id = p.order_id
         WHERE p.razorpay_subscription_id = ?
         ORDER BY p.updated_at DESC`,
        [s.razorpay_subscription_id],
      );
      billingRows = billingResult.rows;
    }
    // console.log("[PAYMENTS RESULT]", billingRows);

    // FIX (Requirement §4): Added order_number to renewal orders query
    // console.log("[SUB DETAILS] QUERY START renewals", {
    //   razorpaySubscriptionId: s.razorpay_subscription_id,
    // });

    let renewalRows = [];
    if (s.razorpay_subscription_id) {
      // Phase 2: is_renewal_order = 1 filters to only the new fulfillment
      // orders created by the subscription.charged webhook. The original
      // subscription order (is_renewal_order = 0) is the row we're already
      // displaying on this page — including it in renewalRows would show it as
      // its own renewal, which is incorrect.
      const renewalResult = await query(
        `SELECT id, order_number, total, order_status, payment_status,
                subscription_status, razorpay_payment_id, created_at
         FROM orders
         WHERE razorpay_subscription_id = ?
           AND is_renewal_order = 1
         ORDER BY created_at DESC`,
        [s.razorpay_subscription_id],
      );
      renewalRows = renewalResult.rows.map((row) => ({
        id: row.id,
        orderNumber: row.order_number,
        total: row.total,
        order_status: row.order_status,
        payment_status: row.payment_status,
        subscription_status: row.subscription_status,
        razorpay_payment_id: row.razorpay_payment_id,
        created_at: row.created_at,
      }));
    }
    // console.log("[RENEWALS RESULT]", renewalRows);

    // Resolve address fields from whichever table was actually populated
    const addressName = s.ua2_full_name || s.contact_name || null;
    const addressPhone = s.ua2_phone || s.contact_phone || null;
    const addressLine1 = s.ua2_line1 || s.a1_line1 || null;
    const addressLine2 = s.ua2_line2 || s.a1_line2 || null;
    const addressCity = s.ua2_city || s.a1_city || null;
    const addressState = s.ua2_state || s.a1_state || null;
    const addressPincode = s.ua2_pincode || s.a1_pincode || null;
    const addressCountry = s.ua2_country || s.a1_country || null;
    const addressType = s.ua2_address_type || null;

    const lastRenewal =
      billingRows.find(
        (p) =>
          String(p.status).toLowerCase() === "captured" ||
          String(p.status).toLowerCase() === "paid",
      )?.updated_at ?? null;

    return res.json({
      subscription: {
        id: s.id,
        orderNumber: s.order_number,
        customerName: s.contact_name,
        email: s.email,
        phone: s.contact_phone,
        subscriptionStatus: s.subscription_status,
        orderStatus: s.order_status,
        paymentStatus: s.payment_status,
        razorpaySubscriptionId: s.razorpay_subscription_id,
        razorpayPlanId: s.razorpay_plan_id,
        // planName: derived from the first order_item's product_name so the
        // admin UI can display the actual product (e.g. "30-Day Pack") rather
        // than a hard-coded "Monthly". Works for any future subscription product.
        planName: itemsResult.rows[0]?.product_name || null,
        amount: Number(s.total || 0),
        startDate: s.created_at,
        nextBillingDate: s.next_billing_date,
        lastRenewal,
        productItems: itemsResult.rows,
        address: {
          fullName: addressName,
          phone: addressPhone,
          line1: addressLine1,
          line2: addressLine2,
          city: addressCity,
          state: addressState,
          pincode: addressPincode,
          country: addressCountry,
          addressType: addressType,
          raw: s.shipping_address || null,
        },
        razorpayOrderId: s.razorpay_order_id || null,
        cancelReason: s.cancel_reason || null,
        cancelledBy: s.cancelled_by || null,
        cancelledAt: s.cancelled_at || null,
      },
      billingHistory: billingRows,
      renewalOrders: renewalRows,
    });
  } catch (error) {
    console.error("================================");
    console.error("[SUB DETAILS ERROR]");
    console.error("MESSAGE:", error.message);
    console.error("SQL MESSAGE:", error.sqlMessage);
    console.error("SQL STATE:", error.sqlState);
    console.error("SQL CODE:", error.code);
    console.error("SQL:", error.sql);
    console.error(error.stack);
    console.error("================================");
    return res.status(500).json({
      success: false,
      message: error.message,
      sqlMessage: error.sqlMessage || null,
      code: error.code || null,
    });
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
      "SELECT id, razorpay_subscription_id, subscription_status FROM orders WHERE id = ? AND is_subscription = 1",
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({
        message: "Subscription not found",
      });
    }

    const order = rows[0];

    if (order.subscription_status === "cancelled") {
      return res.status(400).json({
        message: "Cancelled subscriptions cannot be modified.",
      });
    }

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
    res.status(500).json({
      message:
        error?.error?.description ||
        error?.message ||
        "Failed to pause subscription",
    });
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

    // CRITICAL: Only set subscription_status = 'cancellation_requested'.
    // order_status is a fulfillment field and must NEVER be set to 'cancelled'
    // here. The fulfillment team manages order_status independently.
    // When Razorpay eventually fires the subscription.cancelled webhook (at
    // billing cycle end), subscription_status will be flipped to 'cancelled'
    // by the webhook handler — and order_status will still be untouched.
    await updateSubscriptionOrder({
      orderId: order.id,
      subscriptionStatus: "cancellation_requested",
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
