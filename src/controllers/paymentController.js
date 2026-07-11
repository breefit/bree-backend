import { randomUUID } from "crypto";
import { getRazorpay } from "../config/razorpay.js";
import {
  verifyPaymentSignature,
  verifyWebhookSignature,
} from "../utils/razorpay.js";
import { query, getClient } from "../config/database.js";
import { getNextOrderNumber } from "../utils/orderNumber.js";
import { sendOrderConfirmationEmail } from "../services/orderEmailService.js";
import { createRenewalOrder } from "../services/renewalService.js";

let productShippingColumnsAvailable = null;

const getProductShippingColumnsAvailable = async () => {
  if (productShippingColumnsAvailable !== null) {
    return productShippingColumnsAvailable;
  }

  try {
    const { rows } = await query(
      "SHOW COLUMNS FROM products LIKE 'is_free_shipping'",
    );
    productShippingColumnsAvailable = rows.length > 0;
  } catch {
    productShippingColumnsAvailable = false;
  }

  return productShippingColumnsAvailable;
};

// ─────────────────────────────────────────────────────────────────────────────
// Build Razorpay Magic Checkout line_items from server-validated cart items
// (DB-verified price/name/image from `validatedItems` — never the frontend's
// own line_items, to stay consistent with this endpoint's existing "don't
// trust frontend pricing" pattern).
//
// NOTE: variant_id is mandatory per Razorpay's docs. BREE's products table
// has no distinct variant concept today, so this falls back to product id.
// Update if/when real product variants are introduced.
// ─────────────────────────────────────────────────────────────────────────────
const buildLineItemsFromValidatedItems = (validatedItems) =>
  validatedItems.map((item) => {
    const unitPricePaise = Math.round(item.price * 100);
    return {
      sku: String(item.product_id),
      variant_id: String(item.product_id),
      name: item.name,
      description: item.name,
      image_url: item.image || "",
      price: unitPricePaise,
      offer_price: unitPricePaise, // no per-item discount applied currently
      quantity: item.quantity,
    };
  });

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/create-order
//
// Magic Checkout flow: frontend sends cart items plus line_items/
// line_items_total. Customer name/email/phone/address are collected inside
// the Razorpay popup and returned after payment in the verify call.
//
// Legacy flow (non-Magic): frontend sends customerName, email, mobileNumber,
// shippingAddress upfront — still supported for backward compat.
// ─────────────────────────────────────────────────────────────────────────────
export const createOrder = async (req, res) => {
  console.info("[CREATE_ORDER] Received request", {
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
    line_items, // NEW — presence/non-empty signals a Magic Checkout request
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "Cart is empty" });
  }

  // ── Server-side cart validation & total calculation ───────────────────────
  const validatedItems = [];
  let serverSubtotal = 0;
  let shippingCharge = 0;
  let serverTotal = 0;

  for (const item of items) {
    const productId = item.product_id || item.productId;
    const quantity = Number(item.quantity ?? item.qty ?? 0);

    if (!productId || quantity <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid cart item submitted" });
    }

    const hasShippingColumns = await getProductShippingColumnsAvailable();
    const shippingSelect = hasShippingColumns
      ? ", is_free_shipping, shipping_charge, estimated_delivery"
      : "";
    const { rows } = await query(
      `SELECT id, name, image, price, stock_qty${shippingSelect}
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
    const isFreeShipping =
      product.is_free_shipping === true ||
      product.is_free_shipping === 1 ||
      product.is_free_shipping === "true" ||
      product.is_free_shipping === "1";
    const parsedShippingCharge = Number(product.shipping_charge ?? 0);
    const itemShippingCharge = isFreeShipping
      ? 0
      : Number.isFinite(parsedShippingCharge)
        ? Math.max(0, parsedShippingCharge)
        : 0;

    serverSubtotal += itemPrice * quantity;
    shippingCharge += itemShippingCharge;
    serverTotal = serverSubtotal + shippingCharge;

    validatedItems.push({
      product_id: product.id,
      name: product.name,
      image: product.image || null,
      quantity,
      price: itemPrice,
      is_free_shipping: isFreeShipping,
      shipping_charge: itemShippingCharge,
      estimated_delivery:
        String(product.estimated_delivery || "").trim() || null,
    });
  }

  // NEW — presence of a non-empty line_items array from the frontend signals
  // this is a Magic Checkout request. The values themselves are NOT trusted;
  // see buildLineItemsFromValidatedItems above.
  const isMagicCheckout = Array.isArray(line_items) && line_items.length > 0;
  console.info("[CREATE_ORDER] isMagicCheckout:", isMagicCheckout);

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
        console.info("[CREATE_ORDER] Returning verified pending order", {
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
      console.info(
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

    const orderPayload = {
      amount: Math.round(serverTotal * 100), // paise
      currency: "INR",
      receipt: `bree_${Date.now()}`,
    };

    // NEW — Magic Checkout requires line_items + line_items_total on the
    // actual Razorpay order, or Razorpay silently serves Standard Checkout
    // instead, regardless of any client-side option.
    if (isMagicCheckout) {
      orderPayload.line_items =
        buildLineItemsFromValidatedItems(validatedItems);
      orderPayload.line_items_total = orderPayload.amount;
    }

    rzpOrder = await rzp.orders.create(orderPayload);
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

    // FIX (Order Number feature): generate the human-friendly order_number
    // in the same transaction as order creation. Does not touch rzpOrder.id,
    // the Razorpay order payload, or any other Razorpay mapping field —
    // purely an additional column on our own orders row.
    const orderNumber = await getNextOrderNumber(client);

    // TEMP DEBUG — remove once order_number generation is confirmed stable
    // in production.
    // console.log("[ORDER_NUMBER] Generated:", orderNumber);

    // For Magic Checkout, customer details are unknown at this point — stored
    // as NULL and updated after payment verification.
    // For legacy flow, they are provided upfront.
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
        shipping,
        total,
        is_free_shipping,
        shipping_charge,
        estimated_delivery,
        order_status,
        payment_status,
        razorpay_order_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        orderNumber,
        req.user?.id || null,
        addressId || null,
        customerName || req.user?.name || null,
        email || req.user?.email || null,
        mobileNumber || null,
        shippingAddress || null,
        customerName || req.user?.name || null,
        email || req.user?.email || null,
        mobileNumber || null,
        serverSubtotal,
        shippingCharge,
        serverTotal,
        validatedItems.every((item) => item.is_free_shipping) ? 1 : 0,
        shippingCharge,
        validatedItems.find((item) => item.estimated_delivery)
          ?.estimated_delivery || null,
        "pending_payment",
        "pending",
        rzpOrder.id,
      ],
    );

    // TEMP DEBUG — confirms the value actually landed in the row, not just
    // that getNextOrderNumber() returned something. Remove once confirmed.
    // console.log("[ORDER_NUMBER] Saved:", orderId, orderNumber);

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

    console.info("[CREATE_ORDER] Complete", {
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
// Format a Razorpay Magic Checkout `customer_details.shipping_address` object
// into the single-string format this codebase's `orders.shipping_address`
// column already expects (matches the comma-joined snapshot format used
// elsewhere in the orders controller).
// ─────────────────────────────────────────────────────────────────────────────
const formatRazorpayShippingAddress = (addr) => {
  if (!addr) return null;
  return (
    [
      addr.name,
      addr.line1,
      addr.line2,
      addr.city,
      addr.state,
      addr.zipcode,
      addr.country,
    ]
      .filter(Boolean)
      .join(", ") || null
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify
//
// Called by frontend after Razorpay Magic Checkout popup closes successfully.
// Magic Checkout populates handler.response with:
//   razorpay_payment_id, razorpay_order_id, razorpay_signature
//   (and optionally) razorpay_subscription_id
//
// For one-time (non-subscription) orders, customer/address details are
// fetched directly from Razorpay's Order API as the source of truth — see
// the new block below — rather than trusted from the frontend request body.
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

  // console.log("================================");
  // console.log("VERIFY PAYMENT HIT");
  // console.log(req.body);
  // console.log("================================");

  console.info("[VERIFY_PAYMENT] Request received", {
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
    // console.log("VERIFY STARTED");
    // console.log("subscription id:", razorpay_subscription_id);
    // console.log("payment id:", razorpay_payment_id);
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

  // ── Verify payment amount against Razorpay API ────────────────────────────
  // Fetches the authoritative amount from Razorpay to prevent tampering.
  // Skipped for subscription orders (amount is set by the plan, not order total).
  // FIX 3: If the Razorpay API call fails due to a transient network/API issue,
  // log the error and continue — the HMAC signature above already proves the
  // payment is authentic. Do not return 502 and block a confirmed payment.
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
      // Transient Razorpay API failure — HMAC signature already verified above.
      // Do NOT block the customer. Log for ops follow-up; webhook will reconcile.
      console.error(
        "[VERIFY_PAYMENT] Razorpay payment fetch failed — continuing on HMAC trust:",
        err?.message || err,
      );
      // Fall through; amount check skipped on API error only.
    }
  }

  // ── NEW: Fetch authoritative customer/address details from Razorpay ───────
  // Magic Checkout (One-time orders only)
  //
  // Only applicable to one-time orders. For legacy/Standard Checkout orders,
  // Razorpay's Fetch Order response simply won't contain `customer_details`,
  // so this stays null and every downstream fallback below behaves exactly
  // as it did before this change. Intentionally non-fatal: a failure here
  // must not block payment confirmation — the payment is already verified
  // by signature + amount above.
  let razorpayCustomerDetails = null;
  if (!isSubscriptionOrder && razorpay_order_id) {
    try {
      const rzp = getRazorpay();
      const rzpOrderDetails = await rzp.orders.fetch(razorpay_order_id);
      if (rzpOrderDetails?.customer_details) {
        razorpayCustomerDetails = rzpOrderDetails.customer_details;
      }
    } catch (err) {
      console.warn(
        "[VERIFY_PAYMENT] Could not fetch Razorpay order for customer_details — continuing without it",
        err?.message || err,
      );
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

  // FIX 2: Hoist resolved customer detail variables outside the transaction
  // block so they are accessible when sending the confirmation email below.
  // These are populated inside the transaction and used after it commits.
  let resolvedName;
  let resolvedEmail;
  let resolvedPhone;
  let resolvedAddress;

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

    // CHANGED — Merge customer details with new priority order:
    // 1. Razorpay's customer_details (Magic Checkout) — source of truth
    // 2. Frontend-supplied values from this request (legacy/Standard Checkout)
    // 3. Whatever was stored at create-order time — final fallback
    const razorpayShippingAddress = formatRazorpayShippingAddress(
      razorpayCustomerDetails?.shipping_address,
    );

    // FIX 2: Assign to hoisted variables (not const) so they are visible
    // outside this try block when the confirmation email is sent.
    resolvedName =
      razorpayCustomerDetails?.shipping_address?.name ||
      customerName ||
      lockedOrder.customer_name ||
      lockedOrder.contact_name;
    resolvedEmail =
      razorpayCustomerDetails?.email ||
      email ||
      lockedOrder.email ||
      lockedOrder.contact_email;
    resolvedPhone =
      razorpayCustomerDetails?.contact ||
      mobileNumber ||
      lockedOrder.mobile_number ||
      lockedOrder.contact_phone;
    resolvedAddress =
      razorpayShippingAddress ||
      shippingAddress ||
      lockedOrder.shipping_address ||
      null;

    // Validate email format if present
    if (resolvedEmail && !/^\S+@\S+\.\S+$/.test(resolvedEmail)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    // Determine new statuses.
    // Both one-time and subscription orders move to order_status = 'paid'
    // when payment is verified. 'paid' means payment received and the order
    // is ready for fulfillment — it is NOT a billing concept.
    //
    // subscription_status is updated separately (set to 'active' below via the
    // conditional SQL fragment) and is the correct place for billing state.
    const newOrderStatus = "paid";
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
    // FIX (audit Section 2 / Fix 2): guarded by `stock_deducted` so this can
    // never double-deduct against the payment.captured webhook (or itself,
    // on a retried request) — whichever of the two paths processes the order
    // first flips the flag atomically inside this same row-locked
    // transaction; the other sees stockGuardAffected === 0 and skips.
    const stockGuard = await client.query(
      `UPDATE orders SET stock_deducted = 1 WHERE id = ? AND stock_deducted = 0`,
      [order.id],
    );
    const stockGuardAffected =
      stockGuard.affectedRows || stockGuard.rowCount || 0;

    if (stockGuardAffected > 0) {
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
    } else {
      console.info(
        "[VERIFY_PAYMENT] Stock already deducted (webhook or prior request) — skipping",
        { orderId: order.id },
      );
    }

    // ── Order status history ────────────────────────────────────────────────
    await client.query(
      `INSERT INTO order_status_history
         (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, ?, ?, NULL, 'Payment completed via Razorpay')`,
      [order.id, lockedOrder.order_status, newOrderStatus],
    );

    await client.query("COMMIT");

    console.info("[VERIFY_PAYMENT] Order finalised", {
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
  // FIX 2: Use the resolved variables populated during the transaction.
  // These correctly reflect Magic Checkout customer_details from Razorpay
  // (or legacy/DB fallbacks), not the stale pre-transaction order snapshot.
  const { rows: itemRows } = await query(
    `SELECT product_name AS name, quantity, product_price AS price, subtotal
     FROM order_items WHERE order_id = ?`,
    [order.id],
  );

  sendOrderConfirmationEmail({
    to: resolvedEmail,
    name: resolvedName,
    orderId: order.id,
    amount: dbTotal,
    items: itemRows,
    shippingAddress: resolvedAddress,
  }).catch((err) => {
    console.error("[EMAIL] Confirmation email failed:", err?.message || err);
  });

  // ── For subscriptions: fetch charge_at from Razorpay and write
  // next_billing_date so SubscriptionSuccess and MySubscriptions pages can
  // display it immediately without waiting for a webhook.
  let nextBillingDate = null;
  if (isSubscriptionOrder && razorpay_subscription_id) {
    try {
      const rzpForBilling = getRazorpay();
      const liveSub = await rzpForBilling.subscriptions.fetch(
        razorpay_subscription_id,
      );
      if (liveSub?.charge_at) {
        // charge_at is a Unix timestamp — convert to MySQL-compatible datetime
        nextBillingDate = new Date(liveSub.charge_at * 1000).toLocaleString(
          "sv-SE",
          { timeZone: "Asia/Kolkata" },
        );
        await query(
          `UPDATE orders SET next_billing_date = ?, updated_at = NOW()
           WHERE id = ?`,
          [nextBillingDate, order.id],
        );
        console.info("[VERIFY_PAYMENT] next_billing_date written", {
          orderId: order.id,
          nextBillingDate,
        });
      }
    } catch (billingErr) {
      // Non-blocking — the webhook (subscription.charged) will sync it later.
      console.warn(
        "[VERIFY_PAYMENT] Could not fetch charge_at from Razorpay",
        billingErr?.message || billingErr,
      );
    }
  }

  return res.json({
    success: true,
    order_id: order.id,
    order_number: order.order_number || null,
    payment_id: razorpay_payment_id,
    ...(isSubscriptionOrder && {
      subscription_status: "active",
      next_billing_date: nextBillingDate,
    }),
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/shipping-info
// Magic Checkout callback — returns available shipping methods for the address
// ─────────────────────────────────────────────────────────────────────────────
export const getShippingInfo = async (req, res) => {
  console.log("========== SHIPPING INFO REQUEST ==========");
  console.log("Method:", req.method);
  console.log("URL:", req.originalUrl);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("Query:", JSON.stringify(req.query, null, 2));
  console.log("Params:", JSON.stringify(req.params, null, 2));
  console.log("===========================================");

  const rawBodyValue =
    typeof req.rawBody === "string"
      ? req.rawBody
      : Buffer.isBuffer(req.rawBody)
        ? req.rawBody.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : undefined;

  const body = req.body || {};
  const parsedBody =
    typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body);
          } catch {
            return {};
          }
        })()
      : body;

  const contentType = req.headers?.["content-type"] || "";
  console.info("[SHIPPING_INFO] incoming request", {
    method: req.method,
    headers: req.headers,
    contentType,
    rawBody: rawBodyValue,
    parsedBody,
  });

  const items = Array.isArray(parsedBody?.items)
    ? parsedBody.items
    : Array.isArray(parsedBody?.line_items)
      ? parsedBody.line_items
      : [];

  const shippingAddress =
    parsedBody?.shippingAddress ||
    parsedBody?.shipping_address ||
    parsedBody?.customer_details?.shipping_address ||
    parsedBody?.customer_details?.shippingAddress ||
    null;

  if (!Array.isArray(items) || !items.length || !shippingAddress) {
    console.warn("[SHIPPING_INFO] invalid payload", {
      method: req.method,
      contentType,
      parsedBody,
    });
    console.log("[SHIPPING INFO] Validation Failed");

    return res.status(400).json({
      success: false,
      message: "Shipping info request requires items and shippingAddress",
    });
  }

  const shippingCharge = items.reduce((sum, item) => {
    const isFreeShipping =
      item.is_free_shipping === true ||
      item.is_free_shipping === 1 ||
      item.is_free_shipping === "true" ||
      item.is_free_shipping === "1";
    const parsedShippingCharge = Number(item.shipping_charge ?? 0);
    const itemShippingCharge = isFreeShipping
      ? 0
      : Number.isFinite(parsedShippingCharge)
        ? Math.max(0, parsedShippingCharge)
        : 0;
    return sum + itemShippingCharge;
  }, 0);

  const firstPaidItem = items.find((item) => {
    const isFreeShipping =
      item.is_free_shipping === true ||
      item.is_free_shipping === 1 ||
      item.is_free_shipping === "true" ||
      item.is_free_shipping === "1";
    return !isFreeShipping;
  });
  const estimatedDelivery =
    firstPaidItem?.estimated_delivery ??
    firstPaidItem?.estimatedDelivery ??
    null;

  const shippingMethods = [
    {
      id: "standard",
      label:
        shippingCharge > 0 ? "Standard Delivery" : "Free Standard Delivery",
      amount: shippingCharge > 0 ? Math.round(shippingCharge * 100) : 0,
      currency: "INR",
      estimated_delivery: estimatedDelivery || "3-5 business days",
    },
  ];

  const responseData = {
    success: true,
    shipping_address: shippingAddress,
    default_shipping_method: "standard",
    shipping_methods: shippingMethods,
    shipping_total: shippingCharge,
  };

  console.log(
    "[SHIPPING INFO] Success Response:",
    JSON.stringify(responseData, null, 2),
  );

  return res.json(responseData);
};

const parsePromotionRequestBody = (req) => {
  const rawBodyValue =
    typeof req.rawBody === "string"
      ? req.rawBody
      : Buffer.isBuffer(req.rawBody)
        ? req.rawBody.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : undefined;

  const body = req.body || {};
  const parsedBody =
    typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body);
          } catch {
            return {};
          }
        })()
      : body;

  return { rawBodyValue, body: parsedBody };
};

const getPromotionItems = (body) => {
  const items = Array.isArray(body?.items)
    ? body.items
    : Array.isArray(body?.line_items)
      ? body.line_items
      : [];

  return Array.isArray(items) ? items : [];
};

const calculatePromotionSubtotal = (items, fallbackAmount) =>
  Number(
    fallbackAmount ??
      items.reduce(
        (sum, item) =>
          sum +
          Number(item.price ?? 0) * Number(item.quantity ?? item.qty ?? 1),
        0,
      ),
  );

const getPromotionCatalog = (subtotal) =>
  [
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
  ].filter((coupon) => coupon.is_applicable);

const normalizePromotionCode = (value) =>
  String(value ?? "")
    .trim()
    .toUpperCase();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/promotions
// Magic Checkout callback — returns applicable coupon offers
// ─────────────────────────────────────────────────────────────────────────────
export const getPromotions = async (req, res) => {
  const { body } = parsePromotionRequestBody(req);
  const items = getPromotionItems(body);

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({
      success: false,
      message: "Promotions request requires cart items",
    });
  }

  const subtotal = calculatePromotionSubtotal(items, body.amount);
  const promotions = getPromotionCatalog(subtotal);

  return res.json({
    success: true,
    promotions,
    email: body.email || null,
    amount: subtotal,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/apply-promotions
// Magic Checkout callback — applies a specific promotion code to the cart
// ─────────────────────────────────────────────────────────────────────────────
export const applyPromotions = async (req, res) => {
  const { body } = parsePromotionRequestBody(req);
  const items = getPromotionItems(body);

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({
      success: false,
      message: "Apply promotions request requires cart items",
    });
  }

  const promotionCode = normalizePromotionCode(
    body.promotion_code ||
      body.promotionCode ||
      body.code ||
      body.coupon_code ||
      body.couponCode ||
      body.promo_code ||
      body.promoCode ||
      body.coupon ||
      body.promotion,
  );

  if (!promotionCode) {
    return res.status(400).json({
      success: false,
      message: "Promotion code is required",
    });
  }

  const subtotal = calculatePromotionSubtotal(items, body.amount);
  const promotions = getPromotionCatalog(subtotal);
  const matchedPromotion = promotions.find(
    (promotion) => normalizePromotionCode(promotion.code) === promotionCode,
  );

  if (!matchedPromotion) {
    return res.status(404).json({
      success: false,
      message: "Promotion not applicable",
    });
  }

  const discountAmount = Number(matchedPromotion.discount_amount ?? 0);
  const finalAmount = Math.max(0, subtotal - discountAmount);

  return res.json({
    success: true,
    applied: true,
    promotion: matchedPromotion,
    discount_amount: discountAmount,
    amount: subtotal,
    final_amount: finalAmount,
    currency: "INR",
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
       o.user_id,
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

  // ── PII guard ───────────────────────────────────────────────────────────
  // This endpoint is publicly accessible (Razorpay Magic Checkout redirects
  // here without a session). PII is only returned to the order owner or admin.
  const isAuthorized =
    (req.user?.id && req.user.id === order.user_id) ||
    req.user?.role === "admin";

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
    customer_name: isAuthorized ? order.contact_name : null,
    email: isAuthorized ? order.contact_email : null,
    mobile_number: isAuthorized ? order.contact_phone : null,
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
  console.info("[WEBHOOK] Event:", event);

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
    // Always load the ORIGINAL subscription order (is_renewal_order = 0).
    // After Phase 2, multiple rows share razorpay_subscription_id — the origin
    // plus one renewal order per charge. Webhook handlers that update
    // subscription_status / next_billing_date must target the origin row; the
    // renewal rows are fulfillment orders whose status is managed by the admin.
    const { rows } = await query(
      `SELECT * FROM orders
       WHERE razorpay_subscription_id = ?
         AND is_renewal_order = 0
       ORDER BY created_at ASC
       LIMIT 1`,
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
        // Subscription renewal — update billing/subscription fields ONLY.
        // CRITICAL: order_status is a fulfillment field and must NEVER be
        // overwritten by a billing event. The fulfillment team manages
        // order_status independently (pending → confirmed → processing →
        // dispatched → delivered).
        const order = await loadBySubscription();
        if (order) {
          await query(
            `UPDATE orders SET
               payment_status = 'paid',
               subscription_status = 'active',
               updated_at = NOW()
             WHERE id = ?`,
            [order.id],
          );
          await addHistory(
            order.id,
            order.subscription_status,
            "active",
            "Subscription payment captured",
          );
          emitUpdate(order.id, order.order_status);
        }
      } else if (rzpOrderId) {
        // One-time order fallback (Magic Checkout may also fire this)
        const order = await loadByRazorpayOrder();
        if (order && order.payment_status === "paid") {
          // Already finalised by verifyPayment — nothing to do
          return res.json({ status: "already_processed" });
        }
        if (order && order.payment_status !== "paid") {
          // FIX 1: Wrap in a transaction with a FOR UPDATE row lock so that
          // concurrent webhook deliveries (Razorpay retries) cannot both pass
          // the payment_status check and write duplicate history rows.
          const whClient = await getClient();
          try {
            await whClient.query("BEGIN");

            // Re-read with row lock — prevents duplicate concurrent processing
            const { rows: lockedWh } = await whClient.query(
              "SELECT payment_status, order_status FROM orders WHERE id = ? FOR UPDATE",
              [order.id],
            );
            if (lockedWh[0]?.payment_status === "paid") {
              // Already processed (by verifyPayment or a concurrent webhook)
              await whClient.query("COMMIT");
              break;
            }

            await whClient.query(
              `UPDATE orders SET
                 payment_status = 'paid', order_status = 'paid', updated_at = NOW()
               WHERE id = ?`,
              [order.id],
            );

            // Keep payments table in sync with orders table
            await whClient.query(
              `UPDATE payments
               SET status = 'captured', razorpay_payment_id = ?, updated_at = NOW()
               WHERE razorpay_order_id = ?`,
              [rzpPaymentId, rzpOrderId],
            );

            // FIX (audit Section 2 / Fix 2): deduct stock here too, guarded
            // by `stock_deducted` so this can never double-deduct against
            // verifyPayment() (or a concurrent webhook retry) — whichever
            // path reaches this row first under FOR UPDATE wins the flag;
            // the other sees 0 affected rows and skips deduction entirely.
            const whStockGuard = await whClient.query(
              `UPDATE orders SET stock_deducted = 1 WHERE id = ? AND stock_deducted = 0`,
              [order.id],
            );
            const whStockGuardAffected =
              whStockGuard.affectedRows || whStockGuard.rowCount || 0;

            if (whStockGuardAffected > 0) {
              const { rows: whItems } = await whClient.query(
                "SELECT product_id, quantity FROM order_items WHERE order_id = ?",
                [order.id],
              );

              for (const item of whItems) {
                // Note: unlike verifyPayment, the webhook cannot reject the
                // payment if stock is insufficient (Razorpay already
                // captured the charge). Clamp at 0 instead of blocking, and
                // log loudly for manual reconciliation.
                const whStockResult = await whClient.query(
                  `UPDATE products
                   SET stock_qty = GREATEST(stock_qty - ?, 0)
                   WHERE id = ?`,
                  [item.quantity, item.product_id],
                );
                if (!whStockResult.affectedRows && !whStockResult.rowCount) {
                  console.error(
                    "[WEBHOOK] Stock deduction found no matching product row",
                    { orderId: order.id, productId: item.product_id },
                  );
                }
              }
            } else {
              console.info(
                "[WEBHOOK] Stock already deducted (verifyPayment or prior webhook) — skipping",
                { orderId: order.id },
              );
            }

            await whClient.query(
              `INSERT INTO order_status_history
                 (order_id, previous_status, new_status, changed_by, notes)
               VALUES (?, ?, 'paid', NULL, 'Payment captured via webhook')`,
              [order.id, lockedWh[0].order_status],
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

          emitUpdate(order.id, "paid");
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
            "failed",
            "Payment failed via webhook",
          );
          emitUpdate(order.id, "failed");
        }
      }
      break;
    }

    // ── Subscription lifecycle events ────────────────────────────────────────
    // These were previously no-ops. They now update the DB so subscription
    // status stays consistent even when the frontend verifyPayment call
    // is missed (e.g. popup closed early, network failure).

    case "subscription.activated": {
      const order = await loadBySubscription();
      if (order) {
        const chargeAt = subscriptionEntity?.charge_at;
        const nextBilling = chargeAt
          ? new Date(chargeAt * 1000).toLocaleString("sv-SE", {
              timeZone: "Asia/Kolkata",
            })
          : null;
        // CRITICAL: Only update subscription_status and billing fields.
        // order_status is a fulfillment field — NEVER overwrite it here.
        await query(
          `UPDATE orders SET
             subscription_status = 'active',
             payment_status = 'paid',
             next_billing_date = COALESCE(?, next_billing_date),
             updated_at = NOW()
           WHERE id = ?`,
          [nextBilling, order.id],
        );
        await addHistory(
          order.id,
          order.subscription_status,
          "active",
          "Subscription activated via webhook",
        );
        emitUpdate(order.id, order.order_status);
      }
      break;
    }

    case "subscription.created": {
      // Razorpay fires this when the subscription object is first created.
      // We already write status='created' at createSubscription time; nothing to do.
      console.info("[WEBHOOK] subscription.created — no DB action needed");
      break;
    }

    case "subscription.charged": {
      // ── Phase 2: create a new fulfillment order for this renewal charge ────
      //
      // Every successful recurring charge creates an independent fulfillment
      // order so the warehouse team can pack and ship the renewal separately
      // from previous cycles. The renewal order:
      //   • gets its own BREE-XXXXXX order number
      //   • copies all product items from the original subscription order
      //   • copies all customer / address fields
      //   • starts at order_status='paid', payment_status='paid'
      //   • is linked back to the origin via parent_order_id
      //
      // The ORIGINAL order's subscription_status and next_billing_date are
      // updated inside createRenewalOrder's transaction — we do NOT issue a
      // separate UPDATE here to avoid a race condition.
      //
      // CRITICAL: order_status on the original order is NEVER touched here.
      // Fulfillment state is managed independently by the admin.
      if (!rzpSubscriptionId) {
        console.warn(
          "[WEBHOOK] subscription.charged fired without subscription ID — skipping",
        );
        break;
      }

      try {
        const { renewalOrderId, renewalOrderNumber } = await createRenewalOrder(
          rzpSubscriptionId,
          paymentEntity,
          subscriptionEntity,
        );

        console.info("[WEBHOOK] Renewal order created", {
          renewalOrderId,
          renewalOrderNumber,
          rzpSubscriptionId,
          rzpPaymentId,
        });

        // Emit socket update so admin order lists refresh in real-time
        emitUpdate(renewalOrderId, "paid");

        // Non-blocking renewal confirmation email
        const { sendSubscriptionChargeReceiptEmail } =
          await import("../services/orderEmailService.js").catch(() => ({}));

        if (sendSubscriptionChargeReceiptEmail) {
          // Load the origin order to get contact details (renewal order has them
          // too, but loadBySubscription() is already scoped to the origin)
          const originOrder = await loadBySubscription();
          if (originOrder) {
            sendSubscriptionChargeReceiptEmail({
              to: originOrder.contact_email || originOrder.email,
              name: originOrder.contact_name || originOrder.customer_name,
              orderId: renewalOrderId,
              orderNumber: renewalOrderNumber,
              subscriptionId: rzpSubscriptionId,
              amount,
            }).catch((e) =>
              console.error("[WEBHOOK] Renewal charge receipt email failed", e),
            );
          }
        }
      } catch (err) {
        // Log and continue — Razorpay expects a 200 OK regardless.
        // The webhook will retry; idempotency guard in createRenewalOrder
        // prevents duplicate renewal orders on retry.
        console.error(
          "[WEBHOOK] subscription.charged — createRenewalOrder failed",
          {
            rzpSubscriptionId,
            rzpPaymentId,
            error: err?.message || String(err),
            stack: err?.stack,
          },
        );
      }
      break;
    }

    case "subscription.paused": {
      const order = await loadBySubscription();
      if (order) {
        await query(
          `UPDATE orders SET
             subscription_status = 'paused',
             next_billing_date = NULL,
             updated_at = NOW()
           WHERE id = ?`,
          [order.id],
        );
        await addHistory(
          order.id,
          order.subscription_status,
          "paused",
          "Subscription paused via webhook",
        );
        emitUpdate(order.id, "paused");
      }
      break;
    }

    case "subscription.resumed": {
      const order = await loadBySubscription();
      if (order) {
        const chargeAt = subscriptionEntity?.charge_at;
        const nextBilling = chargeAt
          ? new Date(chargeAt * 1000).toLocaleString("sv-SE", {
              timeZone: "Asia/Kolkata",
            })
          : null;
        // CRITICAL: Only update subscription_status and billing fields.
        // order_status is a fulfillment field — NEVER overwrite it here.
        await query(
          `UPDATE orders SET
             subscription_status = 'active',
             next_billing_date = COALESCE(?, next_billing_date),
             updated_at = NOW()
           WHERE id = ?`,
          [nextBilling, order.id],
        );
        await addHistory(
          order.id,
          order.subscription_status,
          "active",
          "Subscription resumed via webhook",
        );
        emitUpdate(order.id, order.order_status);
      }
      break;
    }

    case "subscription.halted": {
      const order = await loadBySubscription();
      if (order) {
        await query(
          `UPDATE orders SET
             subscription_status = 'halted',
             payment_status = 'failed',
             updated_at = NOW()
           WHERE id = ?`,
          [order.id],
        );
        await addHistory(
          order.id,
          order.subscription_status,
          "halted",
          "Subscription halted via webhook (payment failures)",
        );
        emitUpdate(order.id, "halted");
      }
      break;
    }

    case "subscription.cancelled": {
      const order = await loadBySubscription();
      if (order) {
        // Only update if not already marked cancelled — preserves idempotency.
        if (order.subscription_status !== "cancelled") {
          // CRITICAL: Only update subscription_status and billing fields.
          // order_status is a fulfillment field — NEVER overwrite it here.
          // The fulfillment team may have already progressed order_status to
          // 'delivered' or 'dispatched' — that history must be preserved.
          // Example of CORRECT end state:
          //   subscription_status = 'cancelled'  (billing ended)
          //   order_status        = 'delivered'  (fulfillment history intact)
          await query(
            `UPDATE orders SET
               subscription_status = 'cancelled',
               next_billing_date = NULL,
               updated_at = NOW()
             WHERE id = ?`,
            [order.id],
          );
          await addHistory(
            order.id,
            order.subscription_status,
            "cancelled",
            "Subscription cancelled via webhook",
          );
          emitUpdate(order.id, order.order_status);
        }
      }
      break;
    }

    default:
      console.info("[WEBHOOK] Unhandled event:", event);
  }

  return res.json({ status: "ok" });
};
