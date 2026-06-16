import { randomUUID } from "crypto";
import { getRazorpay } from "../config/razorpay.js";
import { query, getClient } from "../config/database.js";
import {
  sendOrderConfirmationEmail,
  sendSubscriptionChargeReceiptEmail,
  sendSubscriptionFailedEmail,
  sendSubscriptionCancellationEmail,
  sendSubscriptionResumeEmail,
} from "../services/orderEmailService.js";

const formatShippingAddress = (address) => {
  if (!address || !address.trim()) return "";
  return address
    .split(",")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");
};

const toMySQLDateTime = (date) => {
  if (!date) return null;

  return new Date(date).toLocaleString("sv-SE", {
    timeZone: "Asia/Kolkata",
  });
};

export const createSubscription = async (req, res) => {
  // ── FIX: use req.user.id throughout — req.userId is never set by auth middleware ──
  // The auth middleware populates req.user = { id, name, email }.
  // req.userId does not exist and is always undefined.
  const userId = req.user?.id || null;

  console.log("[SUBSCRIPTION] createSubscription called", {
    userId, // FIX: was req.userId (always undefined)
    email: req.body?.email,
    itemCount: req.body?.items?.length,
    hasCustomerName: !!req.body?.customerName,
    hasShippingAddress: !!req.body?.shippingAddress,
    hasMobileNumber: !!req.body?.mobileNumber,
  });

  const {
    items,
    customerName,
    email,
    mobileNumber,
    shippingAddress,
    addressId,
  } = req.body;

  // ── Guard 1: items array ────────────────────────────────────────────────────
  if (!Array.isArray(items) || items.length === 0) {
    console.warn("[SUBSCRIPTION] Rejected: items missing or empty", {
      items,
      body: req.body,
    });
    return res
      .status(400)
      .json({ message: "Subscription requires at least one item" });
  }

  // ── Guard 2: required customer fields ────────────────────────────────────────
  // Log exactly which field is missing so the 400 reason is visible in server logs.
  if (!customerName || !email || !mobileNumber || !shippingAddress) {
    console.warn("[SUBSCRIPTION] Rejected: missing required fields", {
      hasCustomerName: !!customerName,
      hasEmail: !!email,
      hasMobileNumber: !!mobileNumber,
      hasShippingAddress: !!shippingAddress,
    });
    return res
      .status(400)
      .json({ message: "Missing customer or shipping information" });
  }

  const validatedItems = [];
  let serverTotal = 0;

  for (const item of items) {
    const productId = item.product_id || item.productId || item.id;
    const quantity = Number(item.quantity ?? item.qty ?? 1);

    if (!productId || quantity <= 0) {
      console.warn("[SUBSCRIPTION] Rejected: invalid item", { item });
      return res
        .status(400)
        .json({ message: "Invalid subscription item provided" });
    }

    // ── FIX: wrap each DB query in try/catch so failures surface immediately ──
    let productRows;
    try {
      const result = await query(
        "SELECT id, name, image, price, stock_qty FROM products WHERE id = ? AND is_active = 1 AND status = 'In Stock'",
        [productId],
      );
      productRows = result.rows;
    } catch (dbErr) {
      console.error("[SUBSCRIPTION] DB error fetching product", {
        productId,
        message: dbErr.message,
        stack: dbErr.stack,
      });
      return res
        .status(500)
        .json({ message: "Failed to validate subscription items" });
    }

    if (!productRows.length) {
      console.warn("[SUBSCRIPTION] Rejected: product not found or inactive", {
        productId,
      });
      return res
        .status(400)
        .json({ message: `Product ${productId} not found` });
    }

    const product = productRows[0];
    if (product.stock_qty < quantity) {
      console.warn("[SUBSCRIPTION] Rejected: insufficient stock", {
        productId,
        productName: product.name,
        requested: quantity,
        available: product.stock_qty,
      });
      return res
        .status(400)
        .json({ message: `Insufficient stock for ${product.name}` });
    }

    const itemPrice = Number(product.price);
    serverTotal += itemPrice * quantity;

    validatedItems.push({
      product_id: product.id,
      name: product.name,
      image: product.image || null,
      quantity,
      price: itemPrice,
      subtotal: itemPrice * quantity,
    });
  }

  // ── Razorpay calls — wrapped individually so failures are logged precisely ──
  let rzp;
  try {
    rzp = getRazorpay();
  } catch (rzpInitErr) {
    console.error("[SUBSCRIPTION] Razorpay init failed", {
      message: rzpInitErr.message,
      stack: rzpInitErr.stack,
    });
    return res
      .status(500)
      .json({ message: "Payment gateway initialisation failed" });
  }

  const planName =
    validatedItems.length === 1
      ? `${validatedItems[0].name} Monthly Subscription`
      : "BREE Monthly Wellness Subscription";

  const amountInPaise = Math.round(serverTotal * 100);

  // ── Plan reuse logic ────────────────────────────────────────────────────────
  let razorpayPlanId;
  try {
    const { rows: existingPlans } = await query(
      `SELECT razorpay_plan_id FROM razorpay_plans
       WHERE amount_paise = ? AND period = 'monthly' AND interval_val = 1
       LIMIT 1`,
      [amountInPaise],
    );

    if (existingPlans.length > 0) {
      razorpayPlanId = existingPlans[0].razorpay_plan_id;
      console.log("[SUBSCRIPTION] Reusing plan:", razorpayPlanId);
    } else {
      const newPlan = await rzp.plans.create({
        period: "monthly",
        interval: 1,
        item: {
          name: planName,
          amount: amountInPaise,
          currency: "INR",
          description: "30-day recurring wellness subscription",
        },
      });
      razorpayPlanId = newPlan.id;

      await query(
        `INSERT INTO razorpay_plans
         (id, razorpay_plan_id, amount_paise, period, interval_val, plan_name)
         VALUES (?, ?, ?, 'monthly', 1, ?)`,
        [randomUUID(), razorpayPlanId, amountInPaise, planName],
      );
      console.log("[SUBSCRIPTION] Created new plan:", razorpayPlanId);
    }
  } catch (planErr) {
    // Surface the real error — Razorpay returns plain objects, not Error instances,
    // so log both the object and message/stack if present.
    console.error("[SUBSCRIPTION] Plan create/fetch failed", {
      message:
        planErr?.message || planErr?.error?.description || String(planErr),
      statusCode: planErr?.statusCode,
      error: planErr?.error || planErr,
      stack: planErr?.stack,
    });
    return res
      .status(500)
      .json({ message: "Failed to create subscription plan" });
  }

  // ── Create Razorpay subscription ────────────────────────────────────────────
  let subscription;
  try {
    subscription = await rzp.subscriptions.create({
      plan_id: razorpayPlanId,
      total_count: 120,
      quantity: 1,
      customer_notify: 1,
      notes: {
        created_via: "frontend-subscription",
        shipping_address: formatShippingAddress(shippingAddress),
      },
    });
  } catch (subErr) {
    console.error("[SUBSCRIPTION] Razorpay subscription.create failed", {
      planId: razorpayPlanId,
      message: subErr?.message || subErr?.error?.description || String(subErr),
      statusCode: subErr?.statusCode,
      error: subErr?.error || subErr,
      stack: subErr?.stack,
    });
    return res
      .status(500)
      .json({ message: "Failed to create Razorpay subscription" });
  }

  const nextBillingDate = subscription.current_end
    ? toMySQLDateTime(subscription.current_end * 1000)
    : null;

  // ── DB transaction ───────────────────────────────────────────────────────────
  const client = await getClient();
  try {
    await client.query("BEGIN");

    const orderId = randomUUID();

    console.log("[SUBSCRIPTION] Inserting order", {
      orderId,
      userId, // FIX: was req.userId (always undefined)
      subscriptionId: subscription.id,
      planId: razorpayPlanId,
      amount: serverTotal,
    });

    console.log("orderId:", orderId);
    console.log("userId:", userId);
    console.log("addressId:", addressId);
    console.log("subscriptionId:", subscription.id);
    console.log("planId:", razorpayPlanId);

    await client.query(
      `INSERT INTO orders (
        id, user_id, address_id, customer_name, email, mobile_number,
        shipping_address, contact_name, contact_email, contact_phone,
        subtotal, total, order_status, payment_status,
        is_subscription, razorpay_plan_id, razorpay_subscription_id,
        subscription_status, next_billing_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?)`,
      [
        orderId,
        userId, // FIX: was req.userId (always undefined) — now req.user?.id
        addressId || null,
        customerName,
        email,
        mobileNumber,
        formatShippingAddress(shippingAddress),
        customerName,
        email,
        mobileNumber,
        serverTotal,
        serverTotal,
        1,
        razorpayPlanId,
        subscription.id,
        subscription.status || "created",
        nextBillingDate,
      ],
    );

    for (const item of validatedItems) {
      const orderItemId = randomUUID();
      await client.query(
        `INSERT INTO order_items (
          id, order_id, product_id, product_name, product_image,
          product_price, quantity, subtotal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderItemId,
          orderId,
          item.product_id,
          item.name,
          item.image,
          item.price,
          item.quantity,
          item.subtotal,
        ],
      );
    }

    const paymentId = randomUUID();
    await client.query(
      `INSERT INTO payments (
        id, order_id, razorpay_subscription_id, amount, currency, status
      ) VALUES (?, ?, ?, ?, 'INR', 'created')`,
      [paymentId, orderId, subscription.id, serverTotal],
    );

    await client.query(
      `INSERT INTO order_status_history (
        order_id, previous_status, new_status, changed_by, notes
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        orderId,
        null,
        "pending",
        userId, // FIX: was req.userId (always undefined) — now req.user?.id
        "Subscription order created",
      ],
    );

    await client.query("COMMIT");

    console.log("[SUBSCRIPTION] Order committed successfully", {
      orderId,
      subscriptionId: subscription.id,
    });

    try {
      const io = req.app?.locals?.io;
      if (io)
        io.emit("order:updated", { id: orderId, order_status: "pending" });
    } catch (e) {
      console.warn("[SUBSCRIPTION] Socket emit failed", e);
    }

    return res.json({
      success: true,
      order_db_id: orderId,
      subscription_id: subscription.id,
      plan_id: razorpayPlanId,
      amount: Math.round(serverTotal * 100),
      currency: "INR",
      key_id: process.env.RAZORPAY_KEY_ID,
      next_billing_date: nextBillingDate,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    // FIX: log full error details before re-throwing so the failure is
    // always visible in server logs, even when Express error handler
    // swallows the detail.
    console.error("[SUBSCRIPTION] DB transaction failed", {
      message: err?.message || String(err),
      code: err?.code,
      sqlMessage: err?.sqlMessage,
      sql: err?.sql,
      stack: err?.stack,
    });
    throw err;
  } finally {
    client.release();
  }
};

export const getMySubscriptions = async (req, res) => {
  try {
    // FIX: use req.user.id — req.userId is never set by auth middleware
    const userId = req.user?.id;

    const { rows } = await query(
      `SELECT
         o.id AS order_id,
         o.contact_name,
         o.contact_email,
         o.contact_phone,
         o.total,
         o.order_status,
         o.payment_status,
         o.subscription_status,
         o.next_billing_date,
         o.razorpay_subscription_id,
         o.razorpay_plan_id,
         o.created_at,
         oi.product_name AS item_name,
         oi.product_price AS item_price,
         oi.quantity AS item_quantity
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = ? AND o.is_subscription = 1
       ORDER BY o.created_at DESC`,
      [userId],
    );

    const subscriptions = rows.reduce((acc, row) => {
      const existing = acc.find((item) => item.order_id === row.order_id);
      const product = {
        name: row.item_name,
        price: row.item_price,
        quantity: row.item_quantity,
      };

      if (existing) {
        if (row.item_name) {
          existing.items.push(product);
        }
        return acc;
      }

      acc.push({
        order_id: row.order_id,
        contact_name: row.contact_name,
        contact_email: row.contact_email,
        contact_phone: row.contact_phone,
        total: Number(row.total ?? 0),
        order_status: row.order_status,
        payment_status: row.payment_status,
        subscription_status: row.subscription_status,
        next_billing_date: row.next_billing_date,
        razorpay_subscription_id: row.razorpay_subscription_id,
        razorpay_plan_id: row.razorpay_plan_id,
        created_at: row.created_at,
        items: row.item_name ? [product] : [],
      });

      return acc;
    }, []);

    res.json(subscriptions);
  } catch (error) {
    console.error("[SUBSCRIPTION] Failed to load subscriptions", {
      message: error?.message || String(error),
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to fetch subscriptions" });
  }
};

const updateSubscriptionOrder = async ({
  orderId,
  subscriptionStatus,
  orderStatus,
  nextBillingDate,
  notes,
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
  if (nextBillingDate !== undefined) {
    updates.push("next_billing_date = ?");
    params.push(nextBillingDate);
  }
  if (!updates.length) return;

  params.push(orderId);
  await query(
    `UPDATE orders SET ${updates.join(", ")}, updated_at = now() WHERE id = ?`,
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

export const cancelSubscription = async (req, res) => {
  const { id } = req.params;
  // FIX: use req.user.id — req.userId is never set by auth middleware
  const userId = req.user?.id;

  try {
    const { rows } = await query(
      "SELECT id, razorpay_subscription_id, order_status, contact_email, contact_name FROM orders WHERE id = ? AND user_id = ? AND is_subscription = 1",
      [id, userId],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];
    if (!order.razorpay_subscription_id) {
      return res.status(400).json({
        message: "Subscription does not have a Razorpay subscription ID",
      });
    }

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
      notes: "Subscription cancellation requested",
    });

    sendSubscriptionCancellationEmail({
      to: order.contact_email,
      name: order.contact_name,
      orderId: order.id,
      subscriptionId: order.razorpay_subscription_id,
    }).catch((err) => console.error("[EMAIL] Cancellation email failed", err));

    res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    console.error("[SUBSCRIPTION] cancelSubscription failed", {
      message: error?.message || error?.error?.description || String(error),
      statusCode: error?.statusCode,
    });
    res.status(502).json({
      message:
        "Failed to cancel subscription with the payment gateway. Please try again.",
    });
  }
};

export const pauseSubscription = async (req, res) => {
  const { id } = req.params;
  // FIX: use req.user.id — req.userId is never set by auth middleware
  const userId = req.user?.id;

  try {
    const { rows } = await query(
      "SELECT id, razorpay_subscription_id FROM orders WHERE id = ? AND user_id = ? AND is_subscription = 1",
      [id, userId],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];
    if (!order.razorpay_subscription_id) {
      return res.status(400).json({
        message: "Subscription does not have a Razorpay subscription ID",
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
    console.error("[SUBSCRIPTION] pauseSubscription failed", {
      message: error?.message || error?.error?.description || String(error),
      statusCode: error?.statusCode,
    });
    res.status(502).json({
      message:
        "Failed to pause subscription with the payment gateway. Please try again.",
    });
  }
};

export const resumeSubscription = async (req, res) => {
  const { id } = req.params;
  // FIX: use req.user.id — req.userId is never set by auth middleware
  const userId = req.user?.id;

  try {
    const { rows } = await query(
      "SELECT id, razorpay_subscription_id, contact_email, contact_name FROM orders WHERE id = ? AND user_id = ? AND is_subscription = 1",
      [id, userId],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];
    if (!order.razorpay_subscription_id) {
      return res.status(400).json({
        message: "Subscription does not have a Razorpay subscription ID",
      });
    }

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

    sendSubscriptionResumeEmail({
      to: order.contact_email,
      name: order.contact_name,
      orderId: order.id,
      subscriptionId: order.razorpay_subscription_id,
    }).catch((err) => console.error("[EMAIL] Resume email failed", err));

    res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    console.error("[SUBSCRIPTION] resumeSubscription failed", {
      message: error?.message || error?.error?.description || String(error),
      statusCode: error?.statusCode,
    });
    res.status(502).json({
      message:
        "Failed to resume subscription with the payment gateway. Please try again.",
    });
  }
};
