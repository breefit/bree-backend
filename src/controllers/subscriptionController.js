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
import {
  sendSubscriptionStatusWhatsApp,
  sendPaymentStatusWhatsApp,
} from "../services/whatsappNotificationService.js";

// ── Shared logger ────────────────────────────────────────────────────────────
// NOTE: No shared logging utility was found/confirmed in this codebase during
// this refactor. This local wrapper preserves every existing log message and
// call site while giving you a single place to swap in a real shared logger
// (e.g. `import logger from "../utils/logger.js"`) later without touching
// the rest of the file.
const logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

// ── Subscription/order status constants ─────────────────────────────────────
// Centralizes the literal strings used throughout this file. Stored values
// are unchanged — these constants resolve to the exact same strings that
// were previously hardcoded.
const SUBSCRIPTION_STATUS = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  PAUSED: "paused",
  CANCELLED: "cancelled",
  AUTHENTICATED: "authenticated",
  CANCELLATION_REQUESTED: "cancellation_requested",
  CREATED: "created",
});

const ACTIVE_SUBSCRIPTION_STATUSES = [
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.AUTHENTICATED,
  SUBSCRIPTION_STATUS.PENDING,
  SUBSCRIPTION_STATUS.PAUSED,
  SUBSCRIPTION_STATUS.CANCELLATION_REQUESTED,
];

const PROTECTED_SYNC_STATUSES = [
  SUBSCRIPTION_STATUS.CANCELLATION_REQUESTED,
  SUBSCRIPTION_STATUS.CANCELLED,
];

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

// ── WhatsApp notification helper ────────────────────────────────────────────
// Fire-and-forget wrapper: never awaited by callers before a response is
// sent, and swallows/logs its own errors so a WhatsApp failure can never
// fail an API response or trigger a DB rollback.
const sendWhatsAppSafe = async (fn, payload, label) => {
  try {
    await fn(payload);
  } catch (err) {
    logger.error(`[WHATSAPP] ${label} notification failed`, {
      message: err?.message || String(err),
      stack: err?.stack,
    });
  }
};

// ── Validation helpers ───────────────────────────────────────────────────────
// Extracted so createSubscription's top-level flow reads linearly. Behavior,
// messages, and status codes are identical to the original inline checks.

const validateSubscriptionRequest = (body) => {
  const {
    items,
    customerName,
    email,
    mobileNumber,
    shippingAddress,
    addressId,
  } = body;

  if (!Array.isArray(items) || items.length === 0) {
    return {
      valid: false,
      status: 400,
      message: "Subscription requires at least one item",
      logContext: { items, body },
      logMessage: "[SUBSCRIPTION] Rejected: items missing or empty",
    };
  }

  if (!customerName || !email || !mobileNumber || !shippingAddress) {
    return {
      valid: false,
      status: 400,
      message: "Missing customer or shipping information",
      logContext: {
        hasCustomerName: !!customerName,
        hasEmail: !!email,
        hasMobileNumber: !!mobileNumber,
        hasShippingAddress: !!shippingAddress,
      },
      logMessage: "[SUBSCRIPTION] Rejected: missing required fields",
    };
  }

  return {
    valid: true,
    items,
    customerName,
    email,
    mobileNumber,
    shippingAddress,
    addressId,
  };
};

// Pass 1: presence/shape validation only (no DB access needed). Mirrors the
// original per-item presence check, short-circuiting on the first bad item
// in the same order as before.
const extractRequestedItems = (items) => {
  const requested = [];

  for (const item of items) {
    const productId = item.product_id || item.productId || item.id;
    const quantity = Number(item.quantity ?? item.qty ?? 1);

    if (!productId || quantity <= 0) {
      logger.warn("[SUBSCRIPTION] Rejected: invalid item", { item });
      return {
        valid: false,
        status: 400,
        message: "Invalid subscription item provided",
      };
    }

    requested.push({ productId: String(productId), quantity });
  }

  return { valid: true, requested };
};

// Pass 2: existence and price validation against an already-fetched product
// map (O(1) lookup per item instead of one query per item). Same messages,
// status codes, and short-circuit order as the original loop.
const validateSubscriptionItems = (requestedItems, productMap) => {
  const validatedItems = [];
  let serverTotal = 0;

  for (const { productId, quantity } of requestedItems) {
    const product = productMap.get(productId);

    if (!product) {
      logger.warn("[SUBSCRIPTION] Rejected: product not found or inactive", {
        productId,
      });
      return {
        valid: false,
        status: 400,
        message: `Product ${productId} not found`,
      };
    }

    const itemPrice = Number(product.price);
    const subtotal = itemPrice * quantity;
    serverTotal += subtotal;

    validatedItems.push({
      product_id: product.id,
      name: product.name,
      image: product.image || null,
      quantity,
      price: itemPrice,
      subtotal,
      razorpay_plan_id: product.razorpay_plan_id,
      is_subscription: product.is_subscription,
    });
  }

  return { valid: true, validatedItems, serverTotal };
};

// Batched product fetch. Replaces N per-item queries with a single `IN (...)`
// query and reuses the same fetched row for validation and Razorpay-plan
// resolution (no second product query later).
const fetchAndLockProducts = async (productIds) => {
  const uniqueIds = [...new Set(productIds)];
  const client = await getClient();

  try {
    await client.query("BEGIN");

    const placeholders = uniqueIds.map(() => "?").join(", ");
    const { rows } = await client.query(
      `SELECT id, name, image, price, razorpay_plan_id, is_subscription
       FROM products
       WHERE id IN (${placeholders}) AND is_active = 1`,
      uniqueIds,
    );

    await client.query("COMMIT");

    return new Map(rows.map((p) => [String(p.id), p]));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export const createSubscription = async (req, res) => {
  const userId = req.user?.id || null;

  const requestValidation = validateSubscriptionRequest(req.body);
  if (!requestValidation.valid) {
    logger.warn(requestValidation.logMessage, requestValidation.logContext);
    return res
      .status(requestValidation.status)
      .json({ message: requestValidation.message });
  }

  const {
    items,
    customerName,
    email,
    mobileNumber,
    shippingAddress,
    addressId,
  } = requestValidation;

  const itemsExtraction = extractRequestedItems(items);
  if (!itemsExtraction.valid) {
    return res
      .status(itemsExtraction.status)
      .json({ message: itemsExtraction.message });
  }
  const { requested } = itemsExtraction;

  let productMap;
  try {
    productMap = await fetchAndLockProducts(requested.map((r) => r.productId));
  } catch (dbErr) {
    logger.error("[SUBSCRIPTION] DB error fetching products", {
      productIds: requested.map((r) => r.productId),
      message: dbErr.message,
      stack: dbErr.stack,
    });
    return res
      .status(500)
      .json({ message: "Failed to validate subscription items" });
  }

  const itemsValidation = validateSubscriptionItems(requested, productMap);
  if (!itemsValidation.valid) {
    return res
      .status(itemsValidation.status)
      .json({ message: itemsValidation.message });
  }
  const { validatedItems, serverTotal } = itemsValidation;

  // Validate amount before touching Razorpay.
  if (!(serverTotal > 0)) {
    logger.warn("[SUBSCRIPTION] Rejected: non-positive subscription amount", {
      serverTotal,
    });
    return res
      .status(400)
      .json({ message: "Subscription amount must be greater than zero" });
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
         AND o.subscription_status IN (${ACTIVE_SUBSCRIPTION_STATUSES.map(() => "?").join(", ")})
       LIMIT 1`,
      [userId, duplicateProductId, ...ACTIVE_SUBSCRIPTION_STATUSES],
    );

    if (existingSubRows.length) {
      logger.warn("[SUBSCRIPTION] Rejected: duplicate active subscription", {
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
    logger.error("[SUBSCRIPTION] Duplicate-check query failed", {
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
    logger.error("[SUBSCRIPTION] Razorpay init failed", {
      message: rzpInitErr.message,
      stack: rzpInitErr.stack,
    });
    return res
      .status(500)
      .json({ message: "Payment gateway initialisation failed" });
  }

  const amountInPaise = Math.round(serverTotal * 100);

  // ── Resolve product-level Razorpay plan (reused from the already-fetched
  // product row — no second product query) ───────────────────────────────
  let razorpayPlanId;

  if (validatedItems.length !== 1) {
    return res.status(400).json({
      message: "Only one subscription product is allowed",
    });
  }

  const subscriptionProduct = validatedItems[0];

  if (!subscriptionProduct) {
    return res.status(404).json({ message: "Product not found" });
  }

  if (!subscriptionProduct.is_subscription) {
    return res.status(400).json({
      message: "Selected product is not a subscription product",
    });
  }

  if (!subscriptionProduct.razorpay_plan_id) {
    return res.status(400).json({
      message: "Subscription plan not configured for this product",
    });
  }

  razorpayPlanId = subscriptionProduct.razorpay_plan_id;

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
    logger.error("[SUBSCRIPTION] Razorpay subscription.create failed", {
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
    const orderNumber = await getNextOrderNumber(client);

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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        SUBSCRIPTION_STATUS.PENDING,
        SUBSCRIPTION_STATUS.PENDING,
        1,
        razorpayPlanId,
        subscription.id,
        subscription.status || SUBSCRIPTION_STATUS.CREATED,
        nextBillingDate,
      ],
    );

    // Batched order_items insert — single multi-row INSERT instead of one
    // INSERT per item. Transaction semantics (BEGIN/COMMIT/ROLLBACK scope)
    // are unchanged.
    const orderItemsValues = [];
    const orderItemsPlaceholders = [];
    for (const item of validatedItems) {
      const orderItemId = randomUUID();
      orderItemsPlaceholders.push("(?, ?, ?, ?, ?, ?, ?, ?)");
      orderItemsValues.push(
        orderItemId,
        orderId,
        item.product_id,
        item.name,
        item.image,
        item.price,
        item.quantity,
        item.subtotal,
      );
    }
    await client.query(
      `INSERT INTO order_items (
        id, order_id, product_id, product_name, product_image,
        product_price, quantity, subtotal
      ) VALUES ${orderItemsPlaceholders.join(", ")}`,
      orderItemsValues,
    );

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
        SUBSCRIPTION_STATUS.PENDING,
        userId,
        "Subscription order created",
      ],
    );

    await client.query("COMMIT");

    try {
      const io = req.app?.locals?.io;
      if (io)
        io.emit("order:updated", {
          id: orderId,
          order_status: SUBSCRIPTION_STATUS.PENDING,
        });
    } catch (e) {
      logger.warn("[SUBSCRIPTION] Socket emit failed", e);
    }

    // WhatsApp: Subscription Created — fired after commit, never awaited
    // before the response, failure is logged only.
    sendWhatsAppSafe(
      (payload) =>
        sendSubscriptionStatusWhatsApp({
          customerName: payload.name,
          mobile: payload.to,
          planName: payload.planName,
          subscriptionUuid: payload.subscriptionId,
          status: payload.status,
        }),
      {
        to: mobileNumber,
        name: customerName,
        planName: validatedItems[0].name,
        subscriptionId: subscription.id,
        status: "created",
      },
      "Subscription Created",
    );

    return res.json({
      success: true,
      order_db_id: orderId,
      order_number: orderNumber,
      subscription_id: subscription.id,
      plan_id: razorpayPlanId,
      amount: amountInPaise,
      currency: "INR",
      key_id: process.env.RAZORPAY_KEY_ID,
      next_billing_date: nextBillingDate,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("[SUBSCRIPTION] DB transaction failed", {
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
          logger.warn(
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
        const finalStatus = PROTECTED_SYNC_STATUSES.includes(currentStatus)
          ? currentStatus
          : liveSub.status;

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
        logger.error(
          "[SUBSCRIPTION SYNC FAILED]",
          sub.razorpay_subscription_id,
          err.message,
        );
      }
    }

    res.json(subscriptions);
  } catch (error) {
    logger.error("[SUBSCRIPTION] Failed to load subscriptions", {
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
      `SELECT o.id, o.razorpay_subscription_id, o.order_status,
              o.contact_email, o.contact_name, o.contact_phone,
              p.name AS product_name
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p ON p.id = oi.product_id
       WHERE o.razorpay_subscription_id = ?
         AND o.user_id = ?
         AND o.is_subscription = 1`,
      [razorpaySubscriptionId, userId],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];

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
      logger.error("[CANCEL] Razorpay API call failed", {
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

    try {
      // CRITICAL: Only update subscription_status. order_status is a
      // fulfillment field and must NEVER be overwritten by a billing/cancel
      // event. The fulfillment team manages order_status independently.
      await updateSubscriptionOrder({
        orderId: order.id,
        subscriptionStatus: SUBSCRIPTION_STATUS.CANCELLATION_REQUESTED,
        notes: "Subscription cancellation requested by user",
      });

      // WhatsApp: Subscription Cancelled — only fired once the DB update
      // above has succeeded.
      sendWhatsAppSafe(
        (payload) =>
          sendSubscriptionStatusWhatsApp({
            customerName: payload.name,
            mobile: payload.to,
            planName: payload.planName,
            subscriptionUuid: payload.subscriptionId,
            status: payload.status,
          }),
        {
          to: order.contact_phone,
          name: order.contact_name,
          planName: order.product_name,
          subscriptionId: order.razorpay_subscription_id,
          status: "cancelled",
        },
        "Subscription Cancelled",
      );
    } catch (dbErr) {
      logger.error("[CANCEL] DB update failed after Razorpay cancel", {
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
    }).catch((err) => logger.error("[EMAIL] Cancellation email failed", err));

    return res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    logger.error("[CANCEL] Unexpected error", {
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
      `SELECT o.id, o.razorpay_subscription_id,
              o.contact_email, o.contact_name, o.contact_phone,
              p.name AS product_name
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p ON p.id = oi.product_id
       WHERE o.razorpay_subscription_id = ?
         AND o.user_id = ?
         AND o.is_subscription = 1`,
      [razorpaySubscriptionId, userId],
    );

    if (!rows.length) {
      logger.warn("[PAUSE] Subscription not found", {
        razorpaySubscriptionId,
        userId,
      });
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];

    const rzp = getRazorpay();
    let response;
    try {
      response = await rzp.subscriptions.pause(order.razorpay_subscription_id, {
        pause_at_cycle_end: 0,
        customer_notify: 1,
      });
    } catch (rzpErr) {
      logger.error("[PAUSE] Razorpay API call failed", {
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

    try {
      // CRITICAL: Only update subscription_status. order_status is a
      // fulfillment field and must NEVER be overwritten by a billing event.
      await updateSubscriptionOrder({
        orderId: order.id,
        subscriptionStatus: SUBSCRIPTION_STATUS.PAUSED,
        notes: "Subscription paused by user",
      });

      // WhatsApp: Subscription Paused — only fired once the DB update
      // above has succeeded.
      sendWhatsAppSafe(
        (payload) =>
          sendSubscriptionStatusWhatsApp({
            customerName: payload.name,
            mobile: payload.to,
            planName: payload.planName,
            subscriptionUuid: payload.subscriptionId,
            status: payload.status,
          }),
        {
          to: order.contact_phone,
          name: order.contact_name,
          planName: order.product_name,
          subscriptionId: order.razorpay_subscription_id,
          status: "paused",
        },
        "Subscription Paused",
      );
    } catch (dbErr) {
      logger.error("[PAUSE] DB update failed after Razorpay pause", {
        orderId: order.id,
        message: dbErr?.message || String(dbErr),
        stack: dbErr?.stack,
      });
    }

    return res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    logger.error("[PAUSE] Unexpected error", {
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
      `SELECT o.id, o.razorpay_subscription_id,
              o.contact_email, o.contact_name, o.contact_phone,
              p.name AS product_name
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p ON p.id = oi.product_id
       WHERE o.razorpay_subscription_id = ?
         AND o.user_id = ?
         AND o.is_subscription = 1`,
      [razorpaySubscriptionId, userId],
    );

    if (!rows.length) {
      logger.warn("[RESUME] Subscription not found", {
        razorpaySubscriptionId,
        userId,
      });
      return res.status(404).json({ message: "Subscription not found" });
    }

    const order = rows[0];

    const rzp = getRazorpay();
    let response;
    try {
      response = await rzp.subscriptions.resume(
        order.razorpay_subscription_id,
        {
          customer_notify: 1,
        },
      );
    } catch (rzpErr) {
      logger.error("[RESUME] Razorpay API call failed", {
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

    const nextBillingDate = response.charge_at
      ? toMySQLDateTime(response.charge_at * 1000)
      : undefined;

    try {
      await updateSubscriptionOrder({
        orderId: order.id,
        subscriptionStatus: response.status || SUBSCRIPTION_STATUS.ACTIVE,
        nextBillingDate,
        notes: "Subscription resumed by user",
      });

      // WhatsApp: Subscription Resumed — only fired once the DB update
      // above has succeeded.
      sendWhatsAppSafe(
        (payload) =>
          sendSubscriptionStatusWhatsApp({
            customerName: payload.name,
            mobile: payload.to,
            planName: payload.planName,
            subscriptionUuid: payload.subscriptionId,
            status: payload.status,
          }),
        {
          to: order.contact_phone,
          name: order.contact_name,
          planName: order.product_name,
          subscriptionId: order.razorpay_subscription_id,
          status: response.status || SUBSCRIPTION_STATUS.ACTIVE,
        },
        "Subscription Resumed",
      );
    } catch (dbErr) {
      logger.error("[RESUME] DB update failed after Razorpay resume", {
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
    }).catch((err) => logger.error("[EMAIL] Resume email failed", err));

    return res.json({ success: true, subscription_status: response.status });
  } catch (error) {
    logger.error("[RESUME] Unexpected error", {
      razorpaySubscriptionId,
      message: error?.message || String(error),
      stack: error?.stack,
    });
    return res.status(500).json({
      message: "An unexpected error occurred. Please try again.",
    });
  }
};
