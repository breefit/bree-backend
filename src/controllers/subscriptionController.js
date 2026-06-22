import { randomUUID } from "crypto";
import { getNextOrderNumber } from "../utils/orderNumber.js";

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

// FIX (Requirement §1): Removed the global `const orderNumber = await getNextOrderNumber(client);`
// statement that was crashing Node on import because `client` did not exist yet.

export const createSubscription = async (req, res) => {
  const userId = req.user?.id || null;

  console.log("[SUBSCRIPTION] createSubscription called", {
    userId,
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

  if (!Array.isArray(items) || items.length === 0) {
    console.warn("[SUBSCRIPTION] Rejected: items missing or empty", {
      items,
      body: req.body,
    });
    return res
      .status(400)
      .json({ message: "Subscription requires at least one item" });
  }

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

  // ── Duplicate active-subscription guard ─────────────────────────────────
  try {
    const duplicateProductId = validatedItems[0].product_id;

    const { rows: existingSubRows } = await query(
      `SELECT o.id,
              o.order_number,
              o.subscription_status,
              oi.product_id
       FROM orders o
       JOIN order_items oi
         ON oi.order_id = o.id
       WHERE o.user_id = ?
         AND oi.product_id = ?
         AND o.is_subscription = 1
         AND o.subscription_status IN (
             'active',
             'authenticated',
             'pending',
             'paused',
             'cancellation_requested'
         )
       LIMIT 1`,
      [userId, duplicateProductId],
    );

    if (existingSubRows.length) {
      console.warn("[SUBSCRIPTION] Rejected: duplicate active subscription", {
        userId,
        productId: duplicateProductId,
        existingOrderId: existingSubRows[0].id,
        existingStatus: existingSubRows[0].subscription_status,
      });
      return res.status(409).json({
        success: false,
        message:
          "You already have an active subscription for this product. Please manage it from My Subscriptions.",
      });
    }
  } catch (dupErr) {
    console.error("[SUBSCRIPTION] Duplicate-check query failed", {
      message: dupErr?.message || String(dupErr),
      stack: dupErr?.stack,
    });
    return res
      .status(500)
      .json({ message: "Failed to validate existing subscriptions" });
  }

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

  // ── Use product-level Razorpay plan ─────────────────────────────
  let razorpayPlanId;

  try {
    if (validatedItems.length !== 1) {
      return res.status(400).json({
        message: "Only one subscription product is allowed",
      });
    }

    const productId = validatedItems[0].product_id;

    const { rows: productRows } = await query(
      `SELECT id, name, razorpay_plan_id, is_subscription
       FROM products WHERE id = ? LIMIT 1`,
      [productId],
    );

    if (!productRows.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    const product = productRows[0];

    if (!product.is_subscription) {
      return res.status(400).json({
        message: "Selected product is not a subscription product",
      });
    }

    if (!product.razorpay_plan_id) {
      return res.status(400).json({
        message: "Subscription plan not configured for this product",
      });
    }

    razorpayPlanId = product.razorpay_plan_id;
    console.log("[SUBSCRIPTION] Using Product Plan:", razorpayPlanId);
  } catch (error) {
    console.error("[SUBSCRIPTION] Failed to load product plan", error);
    return res
      .status(500)
      .json({ message: "Failed to load subscription plan" });
  }

  // ── Create Razorpay subscription ────────────────────────────────────────────
  let subscription;
  try {
    subscription = await rzp.subscriptions.create({
      plan_id: razorpayPlanId,
      total_count: 12,
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

  const nextBillingDate = null;

  // ── DB transaction ───────────────────────────────────────────────────────────
  const client = await getClient();
  try {
    await client.query("BEGIN");

    const orderId = randomUUID();

    // FIX (Requirement §2): Generate order number here, after client exists
    const orderNumber = await getNextOrderNumber(client);

    console.log("[SUBSCRIPTION] Inserting order", {
      orderId,
      orderNumber,
      userId,
      subscriptionId: subscription.id,
      planId: razorpayPlanId,
      amount: serverTotal,
    });

    console.log("orderId:", orderId);
    console.log("orderNumber:", orderNumber);
    console.log("userId:", userId);
    console.log("addressId:", addressId);
    console.log("subscriptionId:", subscription.id);
    console.log("planId:", razorpayPlanId);

    // FIX (Requirements §3 & §4): Added order_number to INSERT columns and VALUES
    await client.query(
      `INSERT INTO orders (
          id,
          order_number,
          user_id,
          address_id,
          customer_name,
          email,
          mobile_number,
          shipping_address,
          contact_name,
          contact_email,
          contact_phone,
          subtotal,
          total,
          order_status,
          payment_status,
          is_subscription,
          razorpay_plan_id,
          razorpay_subscription_id,
          subscription_status,
          next_billing_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?)`,
      [
        orderId,
        orderNumber,
        userId,
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
      [orderId, null, "pending", userId, "Subscription order created"],
    );

    await client.query("COMMIT");

    console.log("[SUBSCRIPTION] Order committed successfully", {
      orderId,
      orderNumber,
      subscriptionId: subscription.id,
    });

    try {
      const io = req.app?.locals?.io;
      if (io)
        io.emit("order:updated", { id: orderId, order_status: "pending" });
    } catch (e) {
      console.warn("[SUBSCRIPTION] Socket emit failed", e);
    }

    // FIX (Requirement §5): Added order_number to response
    return res.json({
      success: true,
      order_db_id: orderId,
      order_number: orderNumber,
      subscription_id: subscription.id,
      plan_id: razorpayPlanId,
      amount: Math.round(serverTotal * 100),
      currency: "INR",
      key_id: process.env.RAZORPAY_KEY_ID,
      next_billing_date: nextBillingDate,
    });
  } catch (err) {
    await client.query("ROLLBACK");
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
    const userId = req.user?.id;

    // FIX (Requirement §6): Added o.order_number to SELECT
    const { rows } = await query(
      `SELECT
         o.id AS order_id,
         o.order_number,
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
        order_number: row.order_number,
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

    const rzp = getRazorpay();

    for (const sub of subscriptions) {
      if (!sub.razorpay_subscription_id) continue;

      try {
        const liveSub = await rzp.subscriptions.fetch(
          sub.razorpay_subscription_id,
        );

        if (!liveSub) {
          console.warn(
            "[SUBSCRIPTION FETCH] Empty response",
            sub.razorpay_subscription_id,
          );
          continue;
        }

        const { rows: currentRows } = await query(
          `SELECT subscription_status
   FROM orders
   WHERE razorpay_subscription_id = ?`,
          [sub.razorpay_subscription_id],
        );

        const currentStatus = currentRows[0]?.subscription_status;

        // FIX: Admin cancellation sets subscription_status = "cancellation_requested"
        // and order_status = "cancelled" in our DB. Razorpay keeps returning
        // status = "active" until the billing cycle ends (cancel_at_cycle_end=1).
        // We must NEVER overwrite a locally-set terminal/pending-cancel status
        // with Razorpay's stale "active" value. Protect both states:
        //   "cancellation_requested" — cancellation triggered, cycle still running
        //   "cancelled"              — cycle ended, webhook flipped it
        const PROTECTED_STATUSES = ["cancellation_requested", "cancelled"];
        const finalStatus = PROTECTED_STATUSES.includes(currentStatus)
          ? currentStatus
          : liveSub.status;
        console.log("[SYNC STATUS]", {
          currentStatus,
          razorpayStatus: liveSub.status,
          finalStatus,
        });

        sub.subscription_status = finalStatus;

        if (liveSub.charge_at) {
          sub.next_billing_date = new Date(liveSub.charge_at * 1000);
        }

        await query(
          `UPDATE orders
   SET subscription_status = ?, next_billing_date = ?
   WHERE razorpay_subscription_id = ?`,
          [finalStatus, sub.next_billing_date, sub.razorpay_subscription_id],
        );
      } catch (err) {
        console.error(
          "[SUBSCRIPTION SYNC FAILED]",
          sub.razorpay_subscription_id,
          err.message,
        );
      }
    }

    res.json(subscriptions);
  } catch (error) {
    console.error("[SUBSCRIPTION] Failed to load subscriptions", {
      message: error?.message || String(error),
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to fetch subscriptions" });
  }
};

// ── Shared DB update helper ─────────────────────────────────────────────────
const updateSubscriptionOrder = async ({
  orderId,
  subscriptionStatus,
  orderStatus,
  paymentStatus,
  nextBillingDate,
  notes,
}) => {
  const updates = [];
  const params = [];

  if (subscriptionStatus !== undefined) {
    updates.push("subscription_status = ?");
    params.push(subscriptionStatus);
  }
  if (orderStatus !== undefined) {
    updates.push("order_status = ?");
    params.push(orderStatus);
  }
  if (paymentStatus !== undefined) {
    updates.push("payment_status = ?");
    params.push(paymentStatus);
  }
  if (nextBillingDate !== undefined) {
    updates.push("next_billing_date = ?");
    params.push(nextBillingDate);
  }

  if (!updates.length) return;

  params.push(orderId);
  await query(
    `UPDATE orders SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
    params,
  );

  await query(
    `INSERT INTO order_status_history
       (order_id, previous_status, new_status, changed_by, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [
      orderId,
      null,
      orderStatus ?? subscriptionStatus ?? "updated",
      null,
      notes ?? null,
    ],
  );
};

// ── cancelSubscription ──────────────────────────────────────────────────────
export const cancelSubscription = async (req, res) => {
  const { id: razorpaySubscriptionId } = req.params;
  const userId = req.user?.id;

  try {
    const { rows } = await query(
      `SELECT id, razorpay_subscription_id, order_status, contact_email, contact_name
       FROM orders
       WHERE razorpay_subscription_id = ?
         AND user_id = ?
         AND is_subscription = 1`,
      [razorpaySubscriptionId, userId],
    );

    if (!rows.length) {
      console.warn("[CANCEL] Subscription not found", {
        razorpaySubscriptionId,
        userId,
      });
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];

    console.log("[CANCEL]", {
      routeId: razorpaySubscriptionId,
      dbSubscriptionId: order.razorpay_subscription_id,
      orderId: order.id,
      currentStatus: order.order_status,
    });

    const rzp = getRazorpay();
    let response;
    try {
      response = await rzp.subscriptions.cancel(
        order.razorpay_subscription_id,
        {
          cancel_at_cycle_end: 1,
          customer_notify: 1,
        },
      );
    } catch (rzpErr) {
      console.error("[CANCEL] Razorpay API call failed", {
        razorpaySubscriptionId: order.razorpay_subscription_id,
        message:
          rzpErr?.message || rzpErr?.error?.description || String(rzpErr),
        statusCode: rzpErr?.statusCode,
        error: rzpErr?.error || rzpErr,
      });
      return res.status(502).json({
        message:
          "Failed to cancel subscription with the payment gateway. Please try again.",
      });
    }

    console.log("[RAZORPAY CANCEL RESPONSE]", {
      subscriptionId: order.razorpay_subscription_id,
      status: response.status,
      cancelAt: response.cancel_at,
      endAt: response.end_at,
    });

    try {
      // CRITICAL: Only update subscription_status. order_status is a
      // fulfillment field and must NEVER be overwritten by a billing/cancel
      // event. The fulfillment team manages order_status independently.
      await updateSubscriptionOrder({
        orderId: order.id,
        subscriptionStatus: "cancellation_requested",
        notes: "Subscription cancellation requested by user",
      });
    } catch (dbErr) {
      console.error("[CANCEL] DB update failed after Razorpay cancel", {
        orderId: order.id,
        message: dbErr?.message || String(dbErr),
        stack: dbErr?.stack,
      });
    }

    sendSubscriptionCancellationEmail({
      to: order.contact_email,
      name: order.contact_name,
      orderId: order.id,
      subscriptionId: order.razorpay_subscription_id,
    }).catch((err) => console.error("[EMAIL] Cancellation email failed", err));

    return res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    console.error("[CANCEL] Unexpected error", {
      razorpaySubscriptionId,
      message: error?.message || String(error),
      stack: error?.stack,
    });
    return res.status(500).json({
      message: "An unexpected error occurred. Please try again.",
    });
  }
};

// ── pauseSubscription ───────────────────────────────────────────────────────
export const pauseSubscription = async (req, res) => {
  const { id: razorpaySubscriptionId } = req.params;
  const userId = req.user?.id;

  try {
    const { rows } = await query(
      `SELECT id, razorpay_subscription_id
       FROM orders
       WHERE razorpay_subscription_id = ?
         AND user_id = ?
         AND is_subscription = 1`,
      [razorpaySubscriptionId, userId],
    );

    if (!rows.length) {
      console.warn("[PAUSE] Subscription not found", {
        razorpaySubscriptionId,
        userId,
      });
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];

    console.log("[PAUSE]", {
      razorpaySubscriptionId: order.razorpay_subscription_id,
      orderId: order.id,
    });

    const rzp = getRazorpay();
    console.log("RAZORPAY VERSION TEST");
    console.log("subscriptions:", rzp.subscriptions);
    console.log("pause method:", typeof rzp.subscriptions.pause);
    console.log("resume method:", typeof rzp.subscriptions.resume);
    let response;
    try {
      console.log("PAUSING SUB:", order.razorpay_subscription_id);

      response = await rzp.subscriptions.pause(order.razorpay_subscription_id, {
        pause_at_cycle_end: 0,
        customer_notify: 1,
      });

      console.log("PAUSE RAW RESPONSE:", response);
    } catch (rzpErr) {
      console.error("[PAUSE] Razorpay API call failed", {
        razorpaySubscriptionId: order.razorpay_subscription_id,
        message:
          rzpErr?.message || rzpErr?.error?.description || String(rzpErr),
        statusCode: rzpErr?.statusCode,
        error: rzpErr?.error || rzpErr,
      });
      return res.status(502).json({
        message:
          "Failed to pause subscription with the payment gateway. Please try again.",
      });
    }

    console.log("[RAZORPAY PAUSE RESPONSE]", {
      subscriptionId: order.razorpay_subscription_id,
      status: response.status,
    });

    try {
      // CRITICAL: Only update subscription_status. order_status is a
      // fulfillment field and must NEVER be overwritten by a billing event.
      await updateSubscriptionOrder({
        orderId: order.id,
        subscriptionStatus: "paused",
        notes: "Subscription paused by user",
      });
    } catch (dbErr) {
      console.error("[PAUSE] DB update failed after Razorpay pause", {
        orderId: order.id,
        message: dbErr?.message || String(dbErr),
        stack: dbErr?.stack,
      });
    }

    return res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    console.error("[PAUSE] Unexpected error", {
      razorpaySubscriptionId,
      message: error?.message || String(error),
      stack: error?.stack,
    });
    return res.status(500).json({
      message: "An unexpected error occurred. Please try again.",
    });
  }
};

// ── resumeSubscription ──────────────────────────────────────────────────────
export const resumeSubscription = async (req, res) => {
  const { id: razorpaySubscriptionId } = req.params;
  const userId = req.user?.id;

  try {
    const { rows } = await query(
      `SELECT id, razorpay_subscription_id, contact_email, contact_name
       FROM orders
       WHERE razorpay_subscription_id = ?
         AND user_id = ?
         AND is_subscription = 1`,
      [razorpaySubscriptionId, userId],
    );

    if (!rows.length) {
      console.warn("[RESUME] Subscription not found", {
        razorpaySubscriptionId,
        userId,
      });
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];

    console.log("[RESUME]", {
      razorpaySubscriptionId: order.razorpay_subscription_id,
      orderId: order.id,
    });

    const rzp = getRazorpay();
    let response;
    try {
      response = await rzp.subscriptions.resume(
        order.razorpay_subscription_id,
        { customer_notify: 1 },
      );
    } catch (rzpErr) {
      console.error("[RESUME] Razorpay API call failed", {
        razorpaySubscriptionId: order.razorpay_subscription_id,
        message:
          rzpErr?.message || rzpErr?.error?.description || String(rzpErr),
        statusCode: rzpErr?.statusCode,
        error: rzpErr?.error || rzpErr,
      });
      return res.status(502).json({
        message:
          "Failed to resume subscription with the payment gateway. Please try again.",
      });
    }

    console.log("[RAZORPAY RESUME RESPONSE]", {
      subscriptionId: order.razorpay_subscription_id,
      status: response.status,
      chargeAt: response.charge_at,
    });

    const nextBillingDate = response.charge_at
      ? toMySQLDateTime(response.charge_at * 1000)
      : undefined;

    try {
      await updateSubscriptionOrder({
        orderId: order.id,
        subscriptionStatus: response.status || "active",
        nextBillingDate,
        notes: "Subscription resumed by user",
      });
    } catch (dbErr) {
      console.error("[RESUME] DB update failed after Razorpay resume", {
        orderId: order.id,
        message: dbErr?.message || String(dbErr),
        stack: dbErr?.stack,
      });
    }

    sendSubscriptionResumeEmail({
      to: order.contact_email,
      name: order.contact_name,
      orderId: order.id,
      subscriptionId: order.razorpay_subscription_id,
    }).catch((err) => console.error("[EMAIL] Resume email failed", err));

    return res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    console.error("[RESUME] Unexpected error", {
      razorpaySubscriptionId,
      message: error?.message || String(error),
      stack: error?.stack,
    });
    return res.status(500).json({
      message: "An unexpected error occurred. Please try again.",
    });
  }
};
