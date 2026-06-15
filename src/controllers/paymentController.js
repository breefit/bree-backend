import { randomUUID } from "crypto";
import { getRazorpay } from "../config/razorpay.js";
import {
  verifyPaymentSignature,
  verifyWebhookSignature,
} from "../utils/razorpay.js";
import { query, getClient } from "../config/database.js";
import { sendOrderConfirmationEmail } from "../services/orderEmailService.js";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/create-order
//
// Magic Checkout flow: frontend sends only cart items (and optionally pre-fill
// fields). Customer name/email/phone/address are collected inside the Razorpay
// popup and returned after payment in the verify call.
//
// Legacy flow (non-Magic): frontend sends customerName, email, mobileNumber,
// shippingAddress upfront — still supported for backward compat.
// ─────────────────────────────────────────────────────────────────────────────
export const createOrder = async (req, res) => {
  console.log("[CREATE_ORDER] Received request", {
    userId: req.user?.id,
    itemCount: req.body?.items?.length,
  });

  const {
    items,
    // Optional pre-fill / legacy fields — may be absent in Magic Checkout flow
    amount,
    customerName,
    email,
    mobileNumber,
    shippingAddress,
    addressId,
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "Cart is empty" });
  }

  // ── Server-side cart validation & total calculation ───────────────────────
  const validatedItems = [];
  let serverTotal = 0;

  for (const item of items) {
    const productId = item.product_id || item.productId;
    const quantity = Number(item.quantity ?? item.qty ?? 0);

    if (!productId || quantity <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid cart item submitted" });
    }

    const { rows } = await query(
      `SELECT id, name, image, price, stock_qty
       FROM products
       WHERE id = ? AND is_active = 1 AND status = 'In Stock'`,
      [productId],
    );

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: `Product ${productId} not found or unavailable`,
      });
    }

    const product = rows[0];

    if (product.stock_qty < quantity) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock for "${product.name}"`,
      });
    }

    const itemPrice = Number(product.price);
    serverTotal += itemPrice * quantity;

    validatedItems.push({
      product_id: product.id,
      name: product.name,
      image: product.image || null,
      quantity,
      price: itemPrice,
    });
  }

  // If frontend supplied an amount, sanity-check it (allow ₹1 tolerance for
  // floating-point rounding). If absent (Magic Checkout), skip the check.
  if (amount !== undefined && Math.abs(serverTotal - Number(amount)) > 1) {
    console.warn("[CREATE_ORDER] Price mismatch", {
      frontend: amount,
      server: serverTotal,
    });
    return res.status(400).json({
      success: false,
      message: "Price mismatch — please refresh and try again.",
    });
  }

  // ── Idempotency: reuse a recent pending order for the same user & amount ──
  // Only applies when we have a user session; guest Magic Checkout always
  // creates a fresh Razorpay order.
  //
  // The cached Razorpay order is verified with the Razorpay API before reuse.
  // Razorpay orders expire after ~15 minutes (status becomes 'attempted' or
  // the popup rejects it). Returning an expired order causes silent failures,
  // so we fall through to create a fresh one whenever the cached order is no
  // longer in 'created' status.
  if (req.user?.id) {
    const { rows: existingOrders } = await query(
      `SELECT id, razorpay_order_id FROM orders
       WHERE user_id = ? AND payment_status = 'pending'
         AND total = ?
         AND created_at > NOW() - INTERVAL 30 MINUTE
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, serverTotal],
    );

    if (existingOrders.length) {
      const existing = existingOrders[0];

      // Verify the Razorpay order is still open before returning it
      let rzpOrderStillValid = false;
      try {
        const rzp = getRazorpay();
        const rzpExisting = await rzp.orders.fetch(existing.razorpay_order_id);
        // 'created' = open and accepting payment; anything else means it was
        // attempted, expired, or paid — do not reuse
        rzpOrderStillValid = rzpExisting.status === "created";
      } catch (err) {
        // If the fetch fails (network blip, order not found), fall through
        // and create a fresh order rather than blocking the customer
        console.warn(
          "[CREATE_ORDER] Could not verify existing Razorpay order — creating fresh",
          {
            razorpayOrderId: existing.razorpay_order_id,
            error: err?.message || err,
          },
        );
      }

      if (rzpOrderStillValid) {
        console.log("[CREATE_ORDER] Returning verified pending order", {
          orderId: existing.id,
          razorpayOrderId: existing.razorpay_order_id,
        });
        return res.json({
          success: true,
          order_id: existing.razorpay_order_id,
          amount: Math.round(serverTotal * 100),
          currency: "INR",
          key_id: process.env.RAZORPAY_KEY_ID,
          order_db_id: existing.id,
        });
      }

      // Stale or unverifiable — fall through to create a new Razorpay order
      console.log(
        "[CREATE_ORDER] Existing Razorpay order no longer valid — creating fresh",
        {
          orderId: existing.id,
          razorpayOrderId: existing.razorpay_order_id,
        },
      );
    }
  }

  // ── Create Razorpay order ─────────────────────────────────────────────────
  let rzpOrder;
  try {
    const rzp = getRazorpay();
    rzpOrder = await rzp.orders.create({
      amount: Math.round(serverTotal * 100), // paise
      currency: "INR",
      receipt: `bree_${Date.now()}`,
    });
  } catch (err) {
    console.error("[CREATE_ORDER] Razorpay order creation failed:", err);
    return res.status(502).json({
      success: false,
      message: "Failed to create payment order. Please try again.",
    });
  }

  // ── Persist pending order in a transaction ────────────────────────────────
  const client = await getClient();
  try {
    await client.query("BEGIN");

    const orderId = randomUUID();

    // For Magic Checkout, customer details are unknown at this point — stored
    // as NULL and updated after payment verification.
    // For legacy flow, they are provided upfront.
    await client.query(
      `INSERT INTO orders (
        id,
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
        razorpay_order_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)`,
      [
        orderId,
        req.user?.id || null,
        addressId || null,
        customerName || req.user?.name || null,
        email || req.user?.email || null,
        mobileNumber || null,
        shippingAddress || null,
        customerName || req.user?.name || null,
        email || req.user?.email || null,
        mobileNumber || null,
        serverTotal,
        serverTotal,
        rzpOrder.id,
      ],
    );

    // Persist cart snapshot so verify-payment can rebuild order items without
    // trusting frontend data a second time.
    for (const item of validatedItems) {
      await client.query(
        `INSERT INTO order_items (
          id, order_id, product_id, product_name, product_image,
          product_price, quantity, subtotal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          orderId,
          item.product_id,
          item.name,
          item.image,
          item.price,
          item.quantity,
          item.price * item.quantity,
        ],
      );
    }

    // Payment record — status 'created' until captured
    await client.query(
      `INSERT INTO payments (id, order_id, razorpay_order_id, amount, status)
       VALUES (?, ?, ?, ?, 'created')`,
      [randomUUID(), orderId, rzpOrder.id, serverTotal],
    );

    await client.query(
      `INSERT INTO order_status_history
         (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, NULL, 'pending', ?, 'Order created via payment.create-order')`,
      [orderId, req.user?.id || null],
    );

    await client.query("COMMIT");

    console.log("[CREATE_ORDER] Complete", {
      orderId,
      razorpayOrderId: rzpOrder.id,
      amount: rzpOrder.amount,
    });

    // Broadcast to admin dashboard if socket.io is available
    try {
      req.app?.locals?.io?.emit("order:updated", {
        id: orderId,
        order_status: "pending",
      });
    } catch (_) {}

    // Response matches Magic Checkout expected shape:
    // { success, order_id (Razorpay order ID), amount (paise), currency, key_id }
    return res.json({
      success: true,
      order_id: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      order_db_id: orderId, // internal DB id for frontend tracking
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[CREATE_ORDER] Transaction error:", err);
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify
//
// Called by frontend after Razorpay Magic Checkout popup closes successfully.
// Magic Checkout populates handler.response with:
//   razorpay_payment_id, razorpay_order_id, razorpay_signature
//   (and optionally) razorpay_subscription_id
//
// After verification the customer details supplied inside the Razorpay popup
// (name, email, contact, shipping address) are passed by the frontend in the
// same request body — these are written back to the pending order row.
// ─────────────────────────────────────────────────────────────────────────────
export const verifyPayment = async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    razorpay_subscription_id,
    // Customer fields populated by Magic Checkout (may be absent for legacy)
    customerName,
    email,
    mobileNumber,
    shippingAddress,
  } = req.body;

  console.log("[VERIFY_PAYMENT] Request received", {
    razorpay_order_id,
    razorpay_subscription_id,
    razorpay_payment_id,
    razorpay_signature: razorpay_signature ? "[present]" : "[missing]",
  });

  if (!razorpay_payment_id || !razorpay_signature) {
    return res
      .status(400)
      .json({ success: false, message: "Missing payment fields" });
  }

  if (!razorpay_order_id && !razorpay_subscription_id) {
    return res.status(400).json({
      success: false,
      message: "Missing Razorpay order/subscription id",
    });
  }

  // ── HMAC signature verification ───────────────────────────────────────────
  const isValid = verifyPaymentSignature({
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    razorpay_subscription_id,
  });

  if (!isValid) {
    console.warn("[VERIFY_PAYMENT] Invalid signature", {
      razorpay_order_id,
      razorpay_payment_id,
    });
    return res
      .status(400)
      .json({ success: false, message: "Invalid payment signature" });
  }

  // ── Idempotency — already processed? ─────────────────────────────────────
  const { rows: alreadyProcessed } = await query(
    "SELECT id FROM orders WHERE razorpay_payment_id = ?",
    [razorpay_payment_id],
  );
  if (alreadyProcessed.length) {
    console.info(
      "[VERIFY_PAYMENT] Duplicate blocked (payment_id seen before)",
      {
        orderId: alreadyProcessed[0].id,
      },
    );
    return res.json({
      success: true,
      order_id: alreadyProcessed[0].id,
      payment_id: razorpay_payment_id,
      message: "Payment already processed",
    });
  }

  // ── Load the pending order ────────────────────────────────────────────────
  const lookupField = razorpay_subscription_id
    ? "razorpay_subscription_id"
    : "razorpay_order_id";
  const lookupValue = razorpay_subscription_id || razorpay_order_id;

  const { rows: orderRows } = await query(
    `SELECT * FROM orders WHERE ${lookupField} = ?`,
    [lookupValue],
  );

  if (!orderRows.length) {
    console.warn("[VERIFY_PAYMENT] Order not found", {
      lookupField,
      lookupValue,
    });
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  const order = orderRows[0];
  const dbTotal = Number(order.total ?? order.amount ?? 0);
  const isSubscriptionOrder = Boolean(order.is_subscription);

  // ── Verify payment amount against Razorpay API ────────────────────────────────────
  // Fetches the authoritative amount from Razorpay to prevent tampering.
  // Skipped for subscription orders (amount is set by the plan, not order total).
  if (!isSubscriptionOrder) {
    try {
      const rzp = getRazorpay();
      const rzpPayment = await rzp.payments.fetch(razorpay_payment_id);
      if (Number(rzpPayment.amount) !== Math.round(dbTotal * 100)) {
        console.warn("[VERIFY_PAYMENT] Amount mismatch", {
          razorpayAmount: rzpPayment.amount,
          expectedPaise: Math.round(dbTotal * 100),
          orderId: order.id,
        });
        return res.status(400).json({
          success: false,
          message: "Payment amount mismatch",
        });
      }
    } catch (err) {
      console.error(
        "[VERIFY_PAYMENT] Razorpay payment fetch failed:",
        err?.message || err,
      );
      return res.status(502).json({
        success: false,
        message:
          "Could not verify payment with Razorpay. Please contact support.",
      });
    }
  }
  // ── Already paid? ─────────────────────────────────────────────────────────
  if (order.payment_status === "paid") {
    if (order.razorpay_payment_id === razorpay_payment_id) {
      return res.json({
        success: true,
        order_id: order.id,
        payment_id: razorpay_payment_id,
        message: "Order already paid",
      });
    }
    console.warn("[VERIFY_PAYMENT] Already paid with different payment_id", {
      orderId: order.id,
      existing: order.razorpay_payment_id,
      incoming: razorpay_payment_id,
    });
    return res.status(409).json({
      success: false,
      message: "Order already processed with a different payment id",
    });
  }

  // ── Transaction: confirm order, reduce stock, record payment history ──────
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // Re-read with row lock to prevent duplicate concurrent verifications
    const { rows: lockedRows } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [order.id],
    );
    const lockedOrder = lockedRows[0];

    if (lockedOrder.payment_status === "paid") {
      await client.query("COMMIT");
      return res.json({
        success: true,
        order_id: lockedOrder.id,
        payment_id: lockedOrder.razorpay_payment_id || razorpay_payment_id,
        message: "Order already paid",
      });
    }

    // Merge customer details: prefer Magic Checkout values from this request,
    // fall back to whatever was stored at create-order time.
    const resolvedName =
      customerName || lockedOrder.customer_name || lockedOrder.contact_name;
    const resolvedEmail =
      email || lockedOrder.email || lockedOrder.contact_email;
    const resolvedPhone =
      mobileNumber || lockedOrder.mobile_number || lockedOrder.contact_phone;
    const resolvedAddress =
      shippingAddress || lockedOrder.shipping_address || null;

    // Validate email format if present
    if (resolvedEmail && !/^\S+@\S+\.\S+$/.test(resolvedEmail)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    // Determine new statuses
    const newOrderStatus = isSubscriptionOrder ? "active" : "confirmed";
    const newPaymentStatus = "paid";

    // Update order row — write back customer details from Magic Checkout popup
    await client.query(
      `UPDATE orders SET
        payment_status   = ?,
        order_status     = ?,
        customer_name    = ?,
        email            = ?,
        mobile_number    = ?,
        shipping_address = ?,
        contact_name     = ?,
        contact_email    = ?,
        contact_phone    = ?,
        transaction_id   = ?,
        razorpay_payment_id = ?,
        ${isSubscriptionOrder ? "subscription_status = 'active'," : ""}
        paid_at          = NOW(),
        updated_at       = NOW()
      WHERE id = ?`,
      [
        newPaymentStatus,
        newOrderStatus,
        resolvedName,
        resolvedEmail,
        resolvedPhone,
        resolvedAddress,
        resolvedName,
        resolvedEmail,
        resolvedPhone,
        razorpay_payment_id,
        razorpay_payment_id,
        order.id,
      ],
    );

    // Update payments row (created at create-order time)
    const paymentUpdate = await client.query(
      `UPDATE payments SET
        razorpay_payment_id = ?,
        razorpay_signature  = ?,
        status              = 'captured',
        updated_at          = NOW()
       WHERE ${isSubscriptionOrder ? "razorpay_subscription_id" : "razorpay_order_id"} = ?`,
      [razorpay_payment_id, razorpay_signature, lookupValue],
    );

    // Fallback: insert payment row if the UPDATE matched nothing (edge case
    // when the create-order transaction failed silently or was skipped).
    // Use affectedRows for MySQL compatibility — the database wrapper
    // normalises to rowCount as well, so we check both defensively.
    if (!paymentUpdate.affectedRows && !paymentUpdate.rowCount) {
      console.info(
        "[VERIFY_PAYMENT] No existing payment row — inserting fallback",
      );
      await client.query(
        `INSERT INTO payments (
          id, order_id, razorpay_order_id, razorpay_subscription_id,
          razorpay_payment_id, razorpay_signature, amount, currency, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'INR', 'captured')`,
        [
          randomUUID(),
          order.id,
          razorpay_order_id || null,
          razorpay_subscription_id || null,
          razorpay_payment_id,
          razorpay_signature,
          dbTotal,
        ],
      );
    }

    // ── Reduce stock ────────────────────────────────────────────────────────
    // IMPORTANT — webhook safety note:
    // Stock reduction currently happens here inside verifyPayment(), which is
    // called synchronously by the frontend after the Razorpay popup closes.
    //
    // If the architecture ever shifts so that the Razorpay webhook becomes the
    // authoritative source of truth for payment confirmation (i.e. stock is
    // also reduced inside handleWebhook → payment.captured), you MUST ensure
    // stock is only reduced once per order. Recommended approach:
    //   - Add a column `stock_deducted TINYINT(1) DEFAULT 0` on orders, OR
    //   - Check `order_status = 'confirmed'` before deducting inside the webhook
    //     (verifyPayment sets it to 'confirmed' first; webhook sees it already done).
    // Do NOT reduce stock in both places without that guard.
    const { rows: items } = await client.query(
      "SELECT product_id, quantity FROM order_items WHERE order_id = ?",
      [order.id],
    );

    for (const item of items) {
      const stockResult = await client.query(
        `UPDATE products
         SET stock_qty = stock_qty - ?
         WHERE id = ? AND stock_qty >= ?`,
        [item.quantity, item.product_id, item.quantity],
      );

      if (!stockResult.affectedRows && !stockResult.rowCount) {
        await client.query("ROLLBACK");
        console.warn("[VERIFY_PAYMENT] Stock insufficient — rolling back", {
          orderId: order.id,
          productId: item.product_id,
        });
        return res.status(400).json({
          success: false,
          message:
            "Unable to finalise the order: one or more products ran out of stock. Please contact support.",
        });
      }
    }

    // ── Order status history ────────────────────────────────────────────────
    await client.query(
      `INSERT INTO order_status_history
         (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, ?, ?, NULL, 'Payment completed via Razorpay')`,
      [order.id, lockedOrder.order_status, newOrderStatus],
    );

    await client.query("COMMIT");

    console.log("[VERIFY_PAYMENT] Order finalised", {
      orderId: order.id,
      razorpay_payment_id,
    });

    // Broadcast to admin dashboard
    try {
      req.app?.locals?.io?.emit("order:updated", {
        id: order.id,
        order_status: newOrderStatus,
      });
    } catch (_) {}
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[VERIFY_PAYMENT] Transaction error:", err);
    throw err;
  } finally {
    client.release();
  }

  // ── Send confirmation email (non-blocking) ────────────────────────────────
  const { rows: itemRows } = await query(
    `SELECT product_name AS name, quantity, product_price AS price, subtotal
     FROM order_items WHERE order_id = ?`,
    [order.id],
  );

  sendOrderConfirmationEmail({
    to: email || order.email || order.contact_email,
    name: customerName || order.customer_name || order.contact_name,
    orderId: order.id,
    amount: dbTotal,
    items: itemRows,
    shippingAddress: shippingAddress || order.shipping_address || null,
  }).catch((err) => {
    console.error("[EMAIL] Confirmation email failed:", err?.message || err);
  });

  return res.json({
    success: true,
    order_id: order.id,
    payment_id: razorpay_payment_id,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/shipping-info
// Magic Checkout callback — returns available shipping methods for the address
// ─────────────────────────────────────────────────────────────────────────────
export const getShippingInfo = async (req, res) => {
  const { items, shippingAddress } = req.body;

  if (!Array.isArray(items) || !items.length || !shippingAddress) {
    return res.status(400).json({
      message: "Shipping info request requires items and shippingAddress",
    });
  }

  const subtotal = items.reduce(
    (sum, item) => sum + Number(item.price ?? 0) * Number(item.quantity ?? 1),
    0,
  );
  const isFreeShipping = subtotal >= 500;

  const shippingMethods = [
    {
      id: "standard",
      label: isFreeShipping ? "Free Standard Delivery" : "Standard Delivery",
      amount: isFreeShipping ? 0 : 4900,
      currency: "INR",
      estimated_delivery: "3-5 business days",
    },
    {
      id: "express",
      label: "Express Delivery",
      amount: 4900,
      currency: "INR",
      estimated_delivery: "1-2 business days",
    },
  ];

  return res.json({
    shipping_address: shippingAddress,
    default_shipping_method: "standard",
    shipping_methods: shippingMethods,
    shipping_total: isFreeShipping ? 0 : 4900,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/promotions
// Magic Checkout callback — returns applicable coupon offers
// ─────────────────────────────────────────────────────────────────────────────
export const getPromotions = async (req, res) => {
  const { items, email, amount } = req.body;

  if (!Array.isArray(items) || !items.length) {
    return res
      .status(400)
      .json({ message: "Promotions request requires cart items" });
  }

  const subtotal = Number(
    amount ??
      items.reduce(
        (sum, item) =>
          sum +
          Number(item.price ?? 0) * Number(item.quantity ?? item.qty ?? 1),
        0,
      ),
  );

  const allCoupons = [
    {
      code: "FLAT10",
      summary: "₹10 off on your order",
      description: "Get a flat ₹10 discount on your order",
      type: "flat",
      discount_amount: 1000,
      min_order_amount: 0,
      is_applicable: true,
    },
    {
      code: "10PER",
      summary: "10% off on your order",
      description: "Get 10% off on your entire order",
      type: "percentage",
      discount_amount: Math.round(subtotal * 0.1 * 100),
      min_order_amount: 0,
      is_applicable: true,
    },
    {
      code: "BREE20",
      summary: "₹20 off on orders above ₹500",
      description: "Exclusive BREE Wellness offer — ₹20 off on orders ₹500+",
      type: "flat",
      discount_amount: 2000,
      min_order_amount: 50000,
      is_applicable: subtotal >= 500,
    },
  ];

  return res.json({
    promotions: allCoupons.filter((c) => c.is_applicable),
    email: email || null,
    amount: subtotal,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/status/:paymentId
// ─────────────────────────────────────────────────────────────────────────────
export const getPaymentStatus = async (req, res) => {
  const { paymentId } = req.params;
  if (!paymentId) {
    return res.status(400).json({ message: "Payment ID is required" });
  }

  const { rows } = await query(
    `SELECT
       o.id AS order_id,
       COALESCE(o.total, o.amount) AS amount,
       o.order_status,
       o.payment_status,
       o.razorpay_order_id,
       o.razorpay_payment_id AS transaction_id,
       o.contact_name,
       o.contact_email,
       o.contact_phone
     FROM orders o
     WHERE o.razorpay_payment_id = ? OR o.razorpay_order_id = ?`,
    [paymentId, paymentId],
  );

  if (!rows.length) {
    return res.status(404).json({ message: "Order not found" });
  }

  const order = rows[0];
  const { rows: items } = await query(
    `SELECT product_name AS name, quantity, product_price AS price, subtotal
     FROM order_items WHERE order_id = ?`,
    [order.order_id],
  );

  const quantity = items.reduce((sum, i) => sum + (i.quantity || 0), 0) || 1;

  return res.json({
    payment_status: order.payment_status,
    status: order.payment_status === "paid" ? "paid" : "pending",
    amount_total: Math.round(Number(order.amount ?? 0) * 100),
    metadata: {
      product_name: items[0]?.name || "BREE Wellness Shot",
      quantity,
    },
    order_id: order.order_id,
    customer_name: order.contact_name,
    email: order.contact_email,
    mobile_number: order.contact_phone,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/webhook — Razorpay async event notifications
// ─────────────────────────────────────────────────────────────────────────────
export const handleWebhook = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody =
    req.rawBody ||
    (req.body
      ? typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body)
      : "");

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn("[WEBHOOK] Signature invalid");
    return res.status(400).json({ message: "Invalid webhook signature" });
  }

  let payload = req.body;
  if (!payload?.event) {
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      console.error("[WEBHOOK] Parse failed", err);
      return res.status(400).json({ message: "Invalid webhook payload" });
    }
  }

  const { event, payload: eventPayload } = payload;
  console.log("[WEBHOOK] Event:", event);

  const paymentEntity = eventPayload?.payment?.entity;
  const subscriptionEntity = eventPayload?.subscription?.entity;
  const rzpOrderId = paymentEntity?.order_id;
  const rzpSubscriptionId =
    subscriptionEntity?.id || paymentEntity?.subscription_id;
  const rzpPaymentId = paymentEntity?.id;
  const amount = paymentEntity?.amount
    ? Number(paymentEntity.amount) / 100
    : null;

  const emitUpdate = (orderId, status) => {
    try {
      req.app?.locals?.io?.emit("order:updated", {
        id: orderId,
        order_status: status,
      });
    } catch (_) {}
  };

  const addHistory = (orderId, prevStatus, newStatus, notes) =>
    query(
      `INSERT INTO order_status_history
         (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, ?, ?, NULL, ?)`,
      [orderId, prevStatus, newStatus, notes],
    );

  const loadBySubscription = async () => {
    const { rows } = await query(
      "SELECT * FROM orders WHERE razorpay_subscription_id = ? LIMIT 1",
      [rzpSubscriptionId],
    );
    return rows[0];
  };

  const loadByRazorpayOrder = async () => {
    const { rows } = await query(
      "SELECT * FROM orders WHERE razorpay_order_id = ? LIMIT 1",
      [rzpOrderId],
    );
    return rows[0];
  };

  switch (event) {
    case "payment.captured": {
      if (rzpSubscriptionId) {
        // Subscription renewal — handled by subscription flow (do not touch)
        const order = await loadBySubscription();
        if (order) {
          await query(
            `UPDATE orders SET
               payment_status = 'paid', order_status = 'active',
               subscription_status = 'active', updated_at = NOW()
             WHERE id = ?`,
            [order.id],
          );
          await addHistory(
            order.id,
            order.order_status,
            "active",
            "Subscription payment captured",
          );
          emitUpdate(order.id, "active");
        }
      } else if (rzpOrderId) {
        // One-time order fallback (Magic Checkout may also fire this)
        const order = await loadByRazorpayOrder();
        if (order && order.payment_status === "paid") {
          // Already finalised by verifyPayment — nothing to do
          return res.json({ status: "already_processed" });
        }
        if (order && order.payment_status !== "paid") {
          // FIX: wrap in transaction so orders, payments, and history are
          // updated atomically. Prevents partial writes if any query fails.
          const whClient = await getClient();
          try {
            await whClient.query("BEGIN");

            await whClient.query(
              `UPDATE orders SET
                 payment_status = 'paid', order_status = 'confirmed', updated_at = NOW()
               WHERE id = ?`,
              [order.id],
            );

            // FIX: keep payments table in sync with orders table
            await whClient.query(
              `UPDATE payments
               SET status = 'captured', razorpay_payment_id = ?, updated_at = NOW()
               WHERE razorpay_order_id = ?`,
              [rzpPaymentId, rzpOrderId],
            );

            await whClient.query(
              `INSERT INTO order_status_history
                 (order_id, previous_status, new_status, changed_by, notes)
               VALUES (?, ?, 'confirmed', NULL, 'Payment captured via webhook')`,
              [order.id, order.order_status],
            );

            await whClient.query("COMMIT");
          } catch (err) {
            await whClient.query("ROLLBACK");
            console.error(
              "[WEBHOOK] payment.captured transaction failed:",
              err,
            );
            throw err;
          } finally {
            whClient.release();
          }

          emitUpdate(order.id, "confirmed");
        }
      }
      break;
    }

    case "payment.failed": {
      if (rzpSubscriptionId) {
        const order = await loadBySubscription();
        if (order) {
          await query(
            `UPDATE orders SET
               payment_status = 'failed', subscription_status = 'past_due', updated_at = NOW()
             WHERE id = ?`,
            [order.id],
          );
          await addHistory(
            order.id,
            order.order_status,
            "past_due",
            "Subscription payment failed",
          );
          emitUpdate(order.id, "past_due");
        }
      } else if (rzpOrderId) {
        const order = await loadByRazorpayOrder();
        if (order) {
          await query(
            `UPDATE orders SET payment_status = 'failed', updated_at = NOW() WHERE id = ?`,
            [order.id],
          );
          await addHistory(
            order.id,
            order.order_status,
            "payment_failed",
            "Payment failed via webhook",
          );
          emitUpdate(order.id, "payment_failed");
        }
      }
      break;
    }

    // Subscription lifecycle events — do not modify subscription-related
    // logic; these are handled by subscriptionController.js
    case "subscription.activated":
    case "subscription.created":
    case "subscription.charged":
    case "subscription.paused":
    case "subscription.halted":
    case "subscription.resumed":
    case "subscription.cancelled":
      console.log(
        "[WEBHOOK] Subscription event forwarded to subscription handler:",
        event,
      );
      break;

    default:
      console.log("[WEBHOOK] Unhandled event:", event);
  }

  return res.json({ status: "ok" });
};
