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
import { createPackagePurchaseFromOrder } from "../services/packageFulfillmentService.js";
import { createDailyReminder } from "../services/dailyReminderService.js";
import delhiveryService from "../services/delhiveryService.js";
import { calculateOrderTotals } from "../utils/orderTotals.js";
import {
  safelySendWhatsApp,
  sendOrderConfirmationWhatsApp,
} from "../services/whatsappNotificationService.js";

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
// Normalise any error thrown by the Razorpay Node SDK into a flat, loggable
// object.
// ─────────────────────────────────────────────────────────────────────────────
const describeRazorpayError = (err) => ({
  message: err?.message || String(err),
  statusCode: err?.statusCode,
  code: err?.error?.code,
  description: err?.error?.description,
  field: err?.error?.field,
  source: err?.error?.source,
  step: err?.error?.step,
  reason: err?.error?.reason,
});

// ─────────────────────────────────────────────────────────────────────────────
// Build Razorpay Magic Checkout line_items from server-validated cart items.
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
// ─────────────────────────────────────────────────────────────────────────────
export const createOrder = async (req, res) => {
  console.info("[CREATE_ORDER] Received request", {
    userId: req.user?.id,
    itemCount: req.body?.items?.length,
    remindersCount: req.body?.reminders?.length,
  });

  const {
    items,
    amount,
    customerName,
    email,
    mobileNumber,
    shippingAddress,
    addressId,
    line_items,
    reminders,
    discountAmount,
    discount_amount,
  } = req.body;

  const parsedDiscountAmount = Math.max(
    0,
    Number(discountAmount ?? discount_amount ?? 0),
  );

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "Cart is empty" });
  }

  const hasShippingColumns = await getProductShippingColumnsAvailable();
  const shippingSelect = hasShippingColumns
    ? ", is_free_shipping, shipping_charge, estimated_delivery"
    : "";

  const validatedItems = [];
  let serverSubtotal = 0;
  let shippingCharge = 0;
  let reminderCharges = 0;
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
      `SELECT id, name, image, price${shippingSelect}
       FROM products
       WHERE id = ? AND is_active = 1`,
      [productId],
    );

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: `Product ${productId} not found or unavailable`,
      });
    }

    const product = rows[0];

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

  // ── Validate and process reminders ────────────────────────────────────────
  const validatedReminders = [];
  const ALLOWED_REMINDER_TIMES = ["04:00", "04:30", "05:00", "05:30", "06:00"];

  if (Array.isArray(reminders) && reminders.length > 0) {
    for (const reminder of reminders) {
      if (!reminder.enabled) continue; // Skip disabled reminders

      const reminderProductId = reminder.product_id;
      const reminderTime = reminder.time;
      const reminderQuantity = Number(reminder.quantity ?? 1); // Quantity for this product from cart
      const reminderTotalPrice = Number(reminder.price ?? 0); // Frontend-calculated total (price × quantity)

      // Validate reminder time
      if (!ALLOWED_REMINDER_TIMES.includes(reminderTime)) {
        return res.status(400).json({
          success: false,
          message: `Invalid reminder time: ${reminderTime}`,
        });
      }

      // Validate that product exists and has reminder enabled
      const { rows: productRows } = await query(
        `SELECT id, daily_reminder_enabled, daily_reminder_price
         FROM products
         WHERE id = ? AND is_active = 1`,
        [reminderProductId],
      );

      if (!productRows.length) {
        return res.status(400).json({
          success: false,
          message: `Reminder product ${reminderProductId} not found`,
        });
      }

      const reminderProduct = productRows[0];
      if (!reminderProduct.daily_reminder_enabled) {
        return res.status(400).json({
          success: false,
          message: `Reminder not available for product ${reminderProductId}`,
        });
      }

      // Calculate expected reminder charge from database and verify
      const dbReminderPricePerUnit = Number(
        reminderProduct.daily_reminder_price,
      );
      const expectedReminderCharge = dbReminderPricePerUnit * reminderQuantity;

      // Verify total price matches database (prevent price tampering)
      // Allow 0.5 tolerance due to rounding with multiple items
      if (Math.abs(reminderTotalPrice - expectedReminderCharge) > 0.5) {
        console.warn("[CREATE_ORDER] Reminder price mismatch", {
          productId: reminderProductId,
          frontend: reminderTotalPrice,
          calculated: expectedReminderCharge,
          dbPrice: dbReminderPricePerUnit,
          quantity: reminderQuantity,
        });
        return res.status(400).json({
          success: false,
          message: `Reminder price mismatch for product ${reminderProductId}`,
        });
      }

      validatedReminders.push({
        product_id: reminderProductId,
        time: reminderTime,
        price: expectedReminderCharge, // Use backend-calculated price (always correct)
      });

      reminderCharges += expectedReminderCharge;
    }
  }

  const orderTotals = calculateOrderTotals({
    productSubtotal: serverSubtotal,
    deliveryCharge: shippingCharge,
    dailyReminderPrice: reminderCharges,
    actualDiscount: parsedDiscountAmount,
  });
  const finalServerTotal = orderTotals.finalTotal;
  serverTotal = finalServerTotal;

  console.info("========== PAYMENT CALCULATION ==========");
  console.info("Product Subtotal:", serverSubtotal);
  console.info("Reminder Amount:", reminderCharges);
  console.info("Shipping Charge:", shippingCharge);
  console.info("Discount:", parsedDiscountAmount);
  console.info("Final Payable Amount:", serverTotal);
  console.info("Razorpay Amount (paise):", Math.round(serverTotal * 100));
  console.info("Magic Checkout Shipping Fee (paise):", 0);
  console.info("==========================================");

  console.info("[CREATE_ORDER] Price breakdown", {
    subtotal: serverSubtotal,
    shipping: shippingCharge,
    reminders: reminderCharges,
    discount: parsedDiscountAmount,
    total: serverTotal,
  });

  const isMagicCheckout = Array.isArray(line_items) && line_items.length > 0;
  console.info("[CREATE_ORDER] isMagicCheckout:", isMagicCheckout);

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

  if (req.user?.id && !isMagicCheckout) {
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

      let rzpOrderStillValid = false;
      try {
        const rzp = getRazorpay();
        const rzpExisting = await rzp.orders.fetch(existing.razorpay_order_id);
        rzpOrderStillValid = rzpExisting.status === "created";
      } catch (err) {
        console.warn(
          "[CREATE_ORDER] Could not verify existing Razorpay order — creating fresh",
          {
            razorpayOrderId: existing.razorpay_order_id,
            ...describeRazorpayError(err),
          },
        );
      }

      if (rzpOrderStillValid) {
        console.info("[CREATE_ORDER] Returning verified pending order", {
          orderId: existing.id,
          razorpayOrderId: existing.razorpay_order_id,
          amountRupees: serverTotal,
        });
        return res.json({
          success: true,
          order_id: existing.razorpay_order_id,
          amount: Math.round(serverTotal * 100), // in paise
          currency: "INR",
          key_id: process.env.RAZORPAY_KEY_ID,
          order_db_id: existing.id,
        });
      }

      console.info(
        "[CREATE_ORDER] Existing Razorpay order no longer valid — creating fresh",
        {
          orderId: existing.id,
          razorpayOrderId: existing.razorpay_order_id,
        },
      );
    }
  }

  const client = await getClient();
  let orderId;
  let orderNumber;
  let rzpOrder;

  try {
    await client.query("BEGIN");

    orderId = randomUUID();
    orderNumber = await getNextOrderNumber(client);

    try {
      const rzp = getRazorpay();

      const orderPayload = {
        amount: Math.round(serverTotal * 100), // paise — authoritative final payable amount
        currency: "INR",
        receipt: orderNumber,
      };

      if (isMagicCheckout) {
        orderPayload.line_items =
          buildLineItemsFromValidatedItems(validatedItems);
        const lineItemsTotalExclusiveOfShipping = Math.max(
          0,
          orderTotals.productSubtotal +
            orderTotals.dailyReminderPrice -
            orderTotals.actualDiscount,
        );
        orderPayload.line_items_total = Math.round(
          lineItemsTotalExclusiveOfShipping * 100,
        );
      }

      rzpOrder = await rzp.orders.create(orderPayload);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(
        "[CREATE_ORDER] Razorpay order creation failed",
        describeRazorpayError(err),
      );
      return res.status(502).json({
        success: false,
        message: "Failed to create payment order. Please try again.",
      });
    }

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

    await client.query(
      `INSERT INTO payments (id, order_id, razorpay_order_id, amount, status)
       VALUES (?, ?, ?, ?, 'created')`,
      [randomUUID(), orderId, rzpOrder.id, Math.round(serverTotal * 100) / 100], // Store in rupees, not paise
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
      amountPaise: rzpOrder.amount,
      amountRupees: serverTotal,
      isMagicCheckout,
    });

    try {
      req.app?.locals?.io?.emit("order:updated", {
        id: orderId,
        order_status: "pending",
      });
    } catch (_) {}

    return res.json({
      success: true,
      order_id: rzpOrder.id,
      amount: rzpOrder.amount, // in paise
      currency: rzpOrder.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      order_db_id: orderId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[CREATE_ORDER] Transaction error", {
      razorpayOrderId: rzpOrder?.id,
      message: err?.message || String(err),
      stack: err?.stack,
    });
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Format a Razorpay Magic Checkout `customer_details.shipping_address` object
// into the single-string format `orders.shipping_address` already expects.
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
// Find-or-create a structured row in the existing `addresses` table for the
// customer address returned by Razorpay Magic Checkout's
// customer_details.shipping_address.
//
// Schema (existing table, untouched — confirmed against the uploaded dump):
//   addresses(id, user_id CHAR(36) NOT NULL, label, address_line1,
//             address_line2, city, state, pincode, country, is_default,
//             created_at)
//
// *** FIX ***: addresses.user_id is NOT NULL. The previous implementation
// wrote `userId || null` straight into the INSERT and built a dedup WHERE
// clause with an `(user_id IS NULL AND ? IS NULL)` branch that could never
// match a NOT NULL column. For any guest / unauthenticated order (orders.
// user_id IS NULL — these exist in production, e.g. the "Guest" order in the
// dump) this would have thrown a MySQL "Column 'user_id' cannot be null"
// error, rolling back the ENTIRE verifyPayment() transaction — i.e. a
// successfully-charged guest order would fail to be marked paid.
//
// Fix: this function now refuses to run (returns null, no DB write) unless
// it is given a real, non-null userId. The caller (verifyPayment) only
// invokes it when the order has an owning user; guest orders keep their
// flattened `shipping_address` string on the order row and simply have no
// addresses-table row / address_id, which is the correct behaviour given
// the schema constraint.
//
// Dedup rule ("identical address"): same user_id AND same
// address_line1/address_line2/city/state/pincode/country, compared
// case- and whitespace-insensitively.
//
// Runs inside the CALLER's transaction (uses `client`, never the bare
// `query` import) and takes a row lock via FOR UPDATE on the dedup lookup so
// two concurrent verifyPayment() calls for the same customer can't both miss
// the dedup check and insert duplicate rows.
//
// is_default is set to 1 only when this is the very first address on file
// for the user. Never throws internally — a failure here propagates to the
// caller's own try/catch, which already rolls back the whole verifyPayment()
// transaction.
// ─────────────────────────────────────────────────────────────────────────────
const upsertStructuredAddressForOrder = async (
  client,
  { userId, line1, line2, city, state, pincode, country },
) => {
  // Guard the NOT NULL constraint on addresses.user_id.
  if (!userId) {
    console.info(
      "[VERIFY_PAYMENT] Skipping structured address persistence — no user_id (guest order); addresses.user_id is NOT NULL",
    );
    return null;
  }

  const normLine1 = String(line1 || "").trim();
  const normLine2 = String(line2 || "").trim();
  const normCity = String(city || "").trim();
  const normState = String(state || "").trim();
  const normPincode = String(pincode || "").trim();
  const normCountry = String(country || "")
    .trim()
    .toUpperCase();

  // Not enough structured data to build a usable, shippable address row —
  // bail out rather than persisting a half-populated record.
  if (!normLine1 || !normCity || !normPincode) {
    return null;
  }

  // ── Dedup lookup, row-locked ────────────────────────────────────────────
  const { rows: existing } = await client.query(
    `SELECT id FROM addresses
     WHERE user_id = ?
       AND UPPER(TRIM(address_line1)) = UPPER(?)
       AND UPPER(TRIM(COALESCE(address_line2, ''))) = UPPER(?)
       AND UPPER(TRIM(city)) = UPPER(?)
       AND UPPER(TRIM(state)) = UPPER(?)
       AND TRIM(pincode) = ?
       AND UPPER(TRIM(country)) = UPPER(?)
     LIMIT 1
     FOR UPDATE`,
    [
      userId,
      normLine1,
      normLine2,
      normCity,
      normState,
      normPincode,
      normCountry,
    ],
  );

  if (existing.length) {
    console.info("[VERIFY_PAYMENT] Existing address reused", {
      addressId: existing[0].id,
      userId,
    });
    return existing[0].id;
  }

  // ── is_default: only true if the user has no addresses yet ────────────
  const { rows: countRows } = await client.query(
    "SELECT COUNT(*) AS cnt FROM addresses WHERE user_id = ?",
    [userId],
  );
  const existingCount = Number(countRows?.[0]?.cnt ?? 0);
  const isDefault = existingCount === 0 ? 1 : 0;

  const addressId = randomUUID();
  await client.query(
    `INSERT INTO addresses (
       id, user_id, label, address_line1, address_line2,
       city, state, pincode, country, is_default, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      addressId,
      userId,
      "Home",
      normLine1,
      normLine2 || null,
      normCity,
      normState || null,
      normPincode,
      normCountry || null,
      isDefault,
    ],
  );

  console.info("[VERIFY_PAYMENT] New address inserted", {
    addressId,
    userId,
    isDefault: Boolean(isDefault),
  });

  return addressId;
};

// ─────────────────────────────────────────────────────────────────────────────
// Normalise a Delhivery serviceability response into a boolean.
// ─────────────────────────────────────────────────────────────────────────────
const isPostalCodeServiceable = (postalCode) => {
  if (!postalCode || typeof postalCode !== "object") return false;
  const prePaid = String(postalCode.pre_paid ?? "")
    .trim()
    .toUpperCase();
  const pickup = String(postalCode.pickup ?? "")
    .trim()
    .toUpperCase();
  return prePaid === "Y" && pickup === "Y";
};

const readDeliveryCodes = (obj) => {
  if (!obj || typeof obj !== "object") return null;
  const deliveryCodes = obj.delivery_codes;
  if (!Array.isArray(deliveryCodes) || deliveryCodes.length === 0) {
    return null;
  }
  return deliveryCodes.some((entry) =>
    isPostalCodeServiceable(entry?.postal_code),
  );
};

const readFlags = (obj) => {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.serviceable === "boolean") return obj.serviceable;
  if (typeof obj.is_serviceable === "boolean") return obj.is_serviceable;
  if (typeof obj.isServiceable === "boolean") return obj.isServiceable;
  if (typeof obj.serviceability === "boolean") return obj.serviceability;
  const status = obj.delivery_status || obj.status || obj.deliveryStatus;
  if (typeof status === "string") {
    return /serviceable|available|yes/i.test(status);
  }
  return null;
};

const parseDelhiveryServiceability = (delhiveryResponse) => {
  if (typeof delhiveryResponse === "boolean") {
    return delhiveryResponse;
  }

  if (Array.isArray(delhiveryResponse)) {
    if (delhiveryResponse.length === 0) return false;
    return delhiveryResponse.every((entry) => {
      const deliveryCodesFlag = readDeliveryCodes(entry);
      if (deliveryCodesFlag !== null) return deliveryCodesFlag;
      return readFlags(entry) !== false;
    });
  }

  if (delhiveryResponse && typeof delhiveryResponse === "object") {
    const deliveryCodesFlag = readDeliveryCodes(delhiveryResponse);
    if (deliveryCodesFlag !== null) return deliveryCodesFlag;

    const direct = readFlags(delhiveryResponse);
    if (direct !== null) return direct;

    const nested =
      delhiveryResponse.data && typeof delhiveryResponse.data === "object"
        ? delhiveryResponse.data
        : null;
    if (nested) {
      const nestedDeliveryCodesFlag = readDeliveryCodes(nested);
      if (nestedDeliveryCodesFlag !== null) return nestedDeliveryCodesFlag;

      const nestedFlag = readFlags(nested);
      if (nestedFlag !== null) return nestedFlag;
    }
  }

  return false;
};

const extractPostalCodeLogFields = (delhiveryResponse) => {
  try {
    const source = Array.isArray(delhiveryResponse)
      ? delhiveryResponse[0]
      : delhiveryResponse;
    const deliveryCodes = source?.delivery_codes;
    const postalCode = Array.isArray(deliveryCodes)
      ? deliveryCodes[0]?.postal_code
      : null;

    if (!postalCode || typeof postalCode !== "object") return null;

    return {
      pin: postalCode.pin,
      pre_paid: postalCode.pre_paid,
      pickup: postalCode.pickup,
      cash: postalCode.cash,
      repl: postalCode.repl,
    };
  } catch {
    return null;
  }
};

const isIndiaCountry = (country) => {
  const normalized = String(country || "")
    .trim()
    .toUpperCase();
  return normalized === "IN" || normalized === "IND" || normalized === "INDIA";
};

const withTimeout = (promise, ms) => {
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ __timedOut: true }), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutHandle);
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify
// ─────────────────────────────────────────────────────────────────────────────
export const verifyPayment = async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    razorpay_subscription_id,
    customerName,
    email,
    mobileNumber,
    shippingAddress,
    reminders,
  } = req.body;

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

  const { rows: alreadyProcessed } = await query(
    "SELECT id FROM orders WHERE razorpay_payment_id = ?",
    [razorpay_payment_id],
  );
  if (alreadyProcessed.length) {
    console.info(
      "[VERIFY_PAYMENT] Duplicate blocked (payment_id seen before)",
      {
        orderId: alreadyProcessed[0].id,
        razorpay_payment_id,
      },
    );
    return res.json({
      success: true,
      order_id: alreadyProcessed[0].id,
      payment_id: razorpay_payment_id,
      message: "Payment already processed",
    });
  }

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
        "[VERIFY_PAYMENT] Razorpay payment fetch failed — continuing on HMAC trust",
        { orderId: order.id, ...describeRazorpayError(err) },
      );
    }
  }

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
        { orderId: order.id, ...describeRazorpayError(err) },
      );
    }
  }

  console.info("[VERIFY_PAYMENT] Razorpay shipping address received", {
    orderId: order.id,
    shippingAddress: razorpayCustomerDetails?.shipping_address || null,
  });

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

  let resolvedName;
  let resolvedEmail;
  let resolvedPhone;
  let resolvedAddress;
  let resolvedAddressId;

  const client = await getClient();
  try {
    await client.query("BEGIN");

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

    const razorpayShippingAddrObj = razorpayCustomerDetails?.shipping_address;
    const razorpayShippingAddress = formatRazorpayShippingAddress(
      razorpayShippingAddrObj,
    );

    resolvedName =
      razorpayShippingAddrObj?.name ||
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

    // ── Structured address (addresses table) ────────────────────────────────
    // Keep an existing address_id untouched if the order already has one
    // (legacy checkout sets it at create-order time). Only resolve/create a
    // structured address when address_id is NULL — the Magic Checkout case.
    resolvedAddressId = lockedOrder.address_id || null;

    // *** FIX (ReferenceError) ***: this used to log an object built from
    // `userId, line1, line2, city, state, pincode, country` — none of which
    // were ever declared in this scope. That threw a ReferenceError on
    // every single verifyPayment() call (not conditionally — this line
    // always executed), which meant the transaction below never ran and
    // NO Magic Checkout payment could ever be finalised. Fixed to log the
    // actual resolved values instead.
    //
    // addresses.user_id is NOT NULL in the schema, so a structured address
    // row can only be created/reused when the order belongs to a real user.
    // Guest orders (lockedOrder.user_id === null) keep the flattened
    // `resolvedAddress` string but intentionally get no addresses-table row.
    const addressUserId = lockedOrder.user_id || null;

    console.info("[VERIFY_PAYMENT] Address values received", {
      orderId: order.id,
      userId: addressUserId,
      line1: razorpayShippingAddrObj?.line1 || null,
      line2: razorpayShippingAddrObj?.line2 || null,
      city: razorpayShippingAddrObj?.city || null,
      state: razorpayShippingAddrObj?.state || null,
      pincode: razorpayShippingAddrObj?.zipcode || null,
      country: razorpayShippingAddrObj?.country || null,
    });

    if (!resolvedAddressId && razorpayShippingAddrObj && addressUserId) {
      resolvedAddressId = await upsertStructuredAddressForOrder(client, {
        userId: addressUserId,
        line1: razorpayShippingAddrObj.line1,
        line2: razorpayShippingAddrObj.line2,
        city: razorpayShippingAddrObj.city,
        state: razorpayShippingAddrObj.state,
        pincode: razorpayShippingAddrObj.zipcode,
        country: razorpayShippingAddrObj.country,
      });

      if (resolvedAddressId) {
        console.info("[VERIFY_PAYMENT] Updated orders.address_id", {
          orderId: order.id,
          addressId: resolvedAddressId,
        });
      }
    } else if (
      !resolvedAddressId &&
      razorpayShippingAddrObj &&
      !addressUserId
    ) {
      console.info(
        "[VERIFY_PAYMENT] Skipping structured address persistence — guest order (no user_id)",
        { orderId: order.id },
      );
    }

    if (resolvedEmail && !/^\S+@\S+\.\S+$/.test(resolvedEmail)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    const newOrderStatus = "paid";
    const newPaymentStatus = "paid";

    await client.query(
      `UPDATE orders SET
        payment_status   = ?,
        order_status     = ?,
        address_id       = ?,
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
        resolvedAddressId,
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

    const paymentUpdate = await client.query(
      `UPDATE payments SET
        razorpay_payment_id = ?,
        razorpay_signature  = ?,
        status              = 'captured',
        updated_at          = NOW()
       WHERE ${isSubscriptionOrder ? "razorpay_subscription_id" : "razorpay_order_id"} = ?`,
      [razorpay_payment_id, razorpay_signature, lookupValue],
    );

    if (!paymentUpdate.affectedRows && !paymentUpdate.rowCount) {
      console.info(
        "[VERIFY_PAYMENT] No existing payment row — inserting fallback",
        { orderId: order.id },
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

    await client.query(
      `INSERT INTO order_status_history
         (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, ?, ?, NULL, 'Payment completed via Razorpay')`,
      [order.id, lockedOrder.order_status, newOrderStatus],
    );

    // ── Create daily reminders if provided ─────────────────────────────────
    if (Array.isArray(reminders) && reminders.length > 0 && order.user_id) {
      try {
        const ALLOWED_REMINDER_TIMES = [
          "04:00",
          "04:30",
          "05:00",
          "05:30",
          "06:00",
        ];

        for (const reminder of reminders) {
          const productId = reminder.product_id;
          const reminderTime = reminder.time;
          const reminderPrice = Number(reminder.price ?? 0);

          // Validate reminder time (prevent fraud)
          if (!ALLOWED_REMINDER_TIMES.includes(reminderTime)) {
            console.warn(
              "[VERIFY_PAYMENT] Skipping reminder with invalid time",
              { orderId: order.id, productId, reminderTime },
            );
            continue;
          }

          // Fetch product details (reminder enabled, original price, duration)
          const { rows: prodRows } = await client.query(
            `SELECT daily_reminder_enabled, daily_reminder_original_price,
                    package_duration_days
             FROM products
             WHERE id = ? AND is_active = 1`,
            [productId],
          );

          if (!prodRows.length || !prodRows[0].daily_reminder_enabled) {
            console.warn(
              "[VERIFY_PAYMENT] Skipping reminder for unavailable product",
              { orderId: order.id, productId },
            );
            continue;
          }

          const product = prodRows[0];

          // Fetch order_item to link reminder to order_item
          const { rows: oiRows } = await client.query(
            `SELECT id FROM order_items
             WHERE order_id = ? AND product_id = ?
             LIMIT 1`,
            [order.id, productId],
          );

          if (!oiRows.length) {
            console.warn("[VERIFY_PAYMENT] Order item not found for reminder", {
              orderId: order.id,
              productId,
            });
            continue;
          }

          const orderItemId = oiRows[0].id;

          // Create daily reminder
          try {
            await createDailyReminder({
              userId: order.user_id,
              orderId: order.id,
              orderItemId,
              productId,
              reminderTime,
              reminderPricePaid: reminderPrice,
              reminderOriginalPrice:
                Number(product.daily_reminder_original_price) || reminderPrice,
              packageDurationDays: Number(product.package_duration_days) || 30,
            });

            console.info("[VERIFY_PAYMENT] Daily reminder created", {
              orderId: order.id,
              productId,
              reminderTime,
            });
          } catch (reminderErr) {
            console.error("[VERIFY_PAYMENT] Failed to create daily reminder", {
              orderId: order.id,
              productId,
              error: reminderErr.message,
            });
            // Continue with other reminders even if one fails
          }
        }
      } catch (remindersErr) {
        console.error("[VERIFY_PAYMENT] Error processing reminders", {
          orderId: order.id,
          error: remindersErr.message,
        });
        // Don't roll back transaction — order payment is valid even if reminders fail
      }
    }

    await client.query("COMMIT");

    console.info("[VERIFY_PAYMENT] Order finalised", {
      orderId: order.id,
      razorpay_payment_id,
      razorpay_order_id,
      addressId: resolvedAddressId,
    });

    try {
      req.app?.locals?.io?.emit("order:updated", {
        id: order.id,
        order_status: newOrderStatus,
      });
    } catch (_) {}
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[VERIFY_PAYMENT] Transaction error", {
      orderId: order.id,
      razorpay_payment_id,
      message: err?.message || String(err),
      stack: err?.stack,
    });
    throw err;
  } finally {
    client.release();
  }

  const { rows: itemRows } = await query(
    `SELECT product_name AS name, quantity, product_price AS price, subtotal
     FROM order_items WHERE order_id = ?`,
    [order.id],
  );

  // Recurring package detection — no-op for every normal order (only fires
  // when the order actually contains an is_recurring_package product).
  // Fire-and-forget: must never affect the already-successful payment
  // response, and is itself idempotent (safe if the webhook already ran).
  createPackagePurchaseFromOrder(order.id).catch((err) => {
    console.error("[PACKAGE] createPackagePurchaseFromOrder failed", {
      orderId: order.id,
      message: err?.message || String(err),
    });
  });

  sendOrderConfirmationEmail({
    to: resolvedEmail,
    name: resolvedName,
    orderId: order.id,
    amount: dbTotal,
    items: itemRows,
    shippingAddress: resolvedAddress,
  }).catch((err) => {
    console.error("[EMAIL] Confirmation email failed", {
      orderId: order.id,
      message: err?.message || String(err),
    });
  });

  console.info("[WHATSAPP] Preparing order confirmation", {
    orderId: order.id,
    orderNumber: order.order_number,
    hasPhone: Boolean(resolvedPhone),
  });

  if (resolvedPhone) {
    await safelySendWhatsApp("Order Confirmed", () =>
      sendOrderConfirmationWhatsApp({
        mobile: resolvedPhone,
        customerName: resolvedName,
        orderNumber: order.order_number || order.id,
        orderAmount: dbTotal,
        orderDate: new Date(order.paid_at || Date.now()).toLocaleDateString(
          "en-IN",
        ),
        orderUuid: order.id,
      }),
    );
  } else {
    console.warn("[WhatsApp] Skipped: No mobile number found.");
  }

  let nextBillingDate = null;
  if (isSubscriptionOrder && razorpay_subscription_id) {
    try {
      const rzpForBilling = getRazorpay();
      const liveSub = await rzpForBilling.subscriptions.fetch(
        razorpay_subscription_id,
      );
      if (liveSub?.charge_at) {
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
      console.warn("[VERIFY_PAYMENT] Could not fetch charge_at from Razorpay", {
        orderId: order.id,
        ...describeRazorpayError(billingErr),
      });
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
// ─────────────────────────────────────────────────────────────────────────────
const DELHIVERY_SERVICEABILITY_TIMEOUT_MS = 5000;

export const getShippingInfo = async (req, res) => {
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

  console.info("[SHIPPING_INFO] Incoming request", {
    method: req.method,
    url: req.originalUrl,
    host: req.headers?.host,
    userAgent: req.headers?.["user-agent"],
    contentType: req.headers?.["content-type"],
    realIp: req.headers?.["x-real-ip"] || req.headers?.["x-forwarded-for"],
    rawBodyPresent: rawBodyValue !== undefined,
    body: parsedBody,
  });

  const {
    order_id: receiptOrderId,
    razorpay_order_id: razorpayOrderId,
    contact,
    addresses,
  } = parsedBody;

  if (!receiptOrderId && !razorpayOrderId) {
    return res.status(400).json({
      message: "order_id or razorpay_order_id is required",
    });
  }

  if (!contact) {
    return res.status(400).json({
      message: "contact is required",
    });
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({
      message: "addresses is required",
    });
  }

  for (const [index, address] of addresses.entries()) {
    const missingFields = ["id", "zipcode", "country"].filter(
      (field) => !address?.[field],
    );
    if (missingFields.length) {
      console.warn("[SHIPPING_INFO] Address validation failed", {
        razorpayOrderId,
        index,
        addressId: address?.id,
        missingFields,
      });
      return res.status(400).json({
        message: `Address at index ${index} is missing required field(s): ${missingFields.join(", ")}.`,
      });
    }
  }

  let lookupSql;
  let lookupParams;
  let lookupKeyUsed;

  if (razorpayOrderId && receiptOrderId) {
    lookupSql = "razorpay_order_id = ? OR order_number = ?";
    lookupParams = [razorpayOrderId, receiptOrderId];
    lookupKeyUsed = "razorpay_order_id_or_order_number";
  } else if (razorpayOrderId) {
    lookupSql = "razorpay_order_id = ?";
    lookupParams = [razorpayOrderId];
    lookupKeyUsed = "razorpay_order_id";
  } else {
    lookupSql = "order_number = ?";
    lookupParams = [receiptOrderId];
    lookupKeyUsed = "order_number";
  }

  console.info("[SHIPPING_INFO] Order lookup", {
    receiptOrderId,
    razorpayOrderId,
    lookupKeyUsed,
  });

  const { rows: orderRows } = await query(
    `SELECT
       id,
       shipping,
       shipping_charge,
       is_free_shipping,
       estimated_delivery,
       razorpay_order_id,
       order_number
     FROM orders
     WHERE ${lookupSql}
     LIMIT 1`,
    lookupParams,
  );

  let order = orderRows[0] || null;

  // Magic Checkout's "Shipping Info" callback URL is configured once,
  // account-wide, in the Razorpay Dashboard — Razorpay calls this SAME
  // endpoint for Bulk Order payments now too (migrated from Standard
  // Checkout), but a Bulk Booking has no `orders` row yet at payment time
  // (that row is only created after payment succeeds — see
  // bulkOrderService.createOrderFromBulkBooking). Fall back to
  // bulk_bookings, keyed the same way — razorpay_order_id primarily.
  //
  // FIX (Shipping Info debugging report): the bulk_booking_number match was
  // never reliable because the Razorpay receipt for a bulk booking is
  // "bulk_<bulk_booking_number>" (buildBulkReceipt in bulkController.js),
  // not the bare number — e.g. receipt "bulk_BB-100001" vs. the stored
  // bulk_booking_number "BB-100001". If a given callback ever doesn't carry
  // a usable razorpay_order_id, that mismatched prefix made the fallback
  // key fail too, producing "Order not found" even though the booking
  // existed. Strip the "bulk_" prefix off receiptOrderId before comparing
  // it against bulk_booking_number so this key matches the way it was
  // always intended to.
  const normalizedBulkBookingNumber = receiptOrderId?.startsWith("bulk_")
    ? receiptOrderId.slice(5)
    : receiptOrderId;

  let isBulkBooking = false;
  if (!order) {
    console.info("[SHIPPING_INFO] Bulk lookup", {
      razorpayOrderId,
      receiptOrderId,
      normalizedBulkBookingNumber,
    });

    const { rows: bulkRows } = await query(
      `SELECT id, bulk_booking_number, razorpay_order_id, delivery_date
       FROM bulk_bookings
       WHERE razorpay_order_id = ? OR bulk_booking_number = ?
       LIMIT 1`,
      [razorpayOrderId || null, normalizedBulkBookingNumber || null],
    );

    console.info("[SHIPPING_INFO] Bulk lookup result", {
      found: bulkRows.length > 0,
      bookingId: bulkRows[0]?.id,
      bulkBookingNumber: bulkRows[0]?.bulk_booking_number,
      dbRazorpayOrderId: bulkRows[0]?.razorpay_order_id,
    });

    if (bulkRows.length) {
      const bulkBooking = bulkRows[0];
      isBulkBooking = true;
      // Bulk quotes are all-inclusive (no separate shipping line) — treat
      // as free shipping for the popup's shipping-method summary.
      order = {
        id: bulkBooking.id,
        shipping: 0,
        shipping_charge: 0,
        is_free_shipping: 1,
        estimated_delivery: bulkBooking.delivery_date
          ? new Date(bulkBooking.delivery_date).toLocaleDateString("en-IN")
          : "",
        razorpay_order_id: bulkBooking.razorpay_order_id,
        order_number: bulkBooking.bulk_booking_number,
      };
    }
  }

  if (!order) {
    console.warn("[SHIPPING_INFO] Order not found", {
      receiptOrderId,
      razorpayOrderId,
      lookupKeyUsed,
    });
    return res.status(404).json({ message: "Order not found", addresses: [] });
  }

  console.info("[SHIPPING_INFO] Order loaded", {
    orderId: order.id,
    razorpayOrderId: order.razorpay_order_id,
    orderNumber: order.order_number,
    isBulkBooking,
  });

  const isFreeShipping =
    order.is_free_shipping === true ||
    order.is_free_shipping === 1 ||
    order.is_free_shipping === "true" ||
    order.is_free_shipping === "1";

  const storedShippingCharge = Number(
    order.shipping ?? order.shipping_charge ?? 0,
  );
  const shippingFee = isFreeShipping
    ? 0
    : Number.isFinite(storedShippingCharge)
      ? Math.max(0, storedShippingCharge)
      : 0;
  // Delivery is already included in the application-calculated Razorpay
  // order amount. Magic Checkout must only validate serviceability here;
  // returning the product delivery amount as shipping_fee charges it again.
  const razorpayShippingFeePaise = 0;

  const estimatedDelivery =
    String(order.estimated_delivery || "").trim() || "3-5 business days";

  console.info("[SHIPPING_INFO] Shipping fee resolved", {
    orderId: order.id,
    isFreeShipping,
    shippingFee,
    razorpayShippingFeePaise,
    estimatedDelivery,
  });

  const responseAddresses = await Promise.all(
    addresses.map(async (address) => {
      const zipcode = address.zipcode;
      const country = String(address.country || "");

      let serviceable = true;

      if (!isIndiaCountry(country)) {
        serviceable = false;
        console.warn("[SHIPPING_INFO] Unsupported country", {
          orderId: order.id,
          addressId: address.id,
          country,
        });
      } else {
        try {
          const delhiveryResult = await withTimeout(
            delhiveryService.checkServiceability(String(zipcode)),
            DELHIVERY_SERVICEABILITY_TIMEOUT_MS,
          );

          if (delhiveryResult?.__timedOut) {
            serviceable = true;
            console.warn(
              "[SHIPPING_INFO] Delhivery request timed out — assuming serviceable (fail-open)",
              {
                orderId: order.id,
                addressId: address.id,
                zipcode,
                timeoutMs: DELHIVERY_SERVICEABILITY_TIMEOUT_MS,
              },
            );
          } else {
            serviceable = parseDelhiveryServiceability(delhiveryResult);
            const logFields = extractPostalCodeLogFields(delhiveryResult);
            console.info("[SHIPPING_INFO] Delhivery response", {
              orderId: order.id,
              addressId: address.id,
              zipcode,
              pin: logFields?.pin,
              pre_paid: logFields?.pre_paid,
              pickup: logFields?.pickup,
              cash: logFields?.cash,
              repl: logFields?.repl,
              serviceable,
              delhiveryResponse: delhiveryResult,
            });
          }
        } catch (error) {
          serviceable = true;
          console.error(
            "[SHIPPING_INFO] Delhivery error — assuming serviceable (fail-open)",
            {
              orderId: order.id,
              addressId: address.id,
              zipcode,
              message: error?.message || String(error),
            },
          );
        }
      }

      return {
        id: address.id,
        zipcode,
        country: address.country,
        shipping_methods: [
          {
            id: "standard",
            name: "Standard Delivery",
            description: `Delivery in ${estimatedDelivery}`,
            serviceable,
            shipping_fee: razorpayShippingFeePaise,
            cod: false,
            cod_fee: 0,
          },
        ],
      };
    }),
  );

  console.info("[SHIPPING_INFO] Response ready", {
    orderId: order.id,
    razorpayOrderId: order.razorpay_order_id,
    addressCount: responseAddresses.length,
    serviceableCount: responseAddresses.filter((a) =>
      a.shipping_methods.some((m) => m.serviceable),
    ).length,
  });

  return res.json({ addresses: responseAddresses });
};

const parsePromotionRequestBody = (req) => {
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

  return { body: parsedBody };
};

const loadOrderForPromotionCallback = async (body) => {
  const receiptOrderId = body.order_id;
  const razorpayOrderId = body.razorpay_order_id;

  if (!receiptOrderId && !razorpayOrderId) {
    return { order: null, lookupKeyUsed: null };
  }

  let lookupSql;
  let lookupParams;
  let lookupKeyUsed;

  if (razorpayOrderId && receiptOrderId) {
    lookupSql = "razorpay_order_id = ? OR order_number = ?";
    lookupParams = [razorpayOrderId, receiptOrderId];
    lookupKeyUsed = "razorpay_order_id_or_order_number";
  } else if (razorpayOrderId) {
    lookupSql = "razorpay_order_id = ?";
    lookupParams = [razorpayOrderId];
    lookupKeyUsed = "razorpay_order_id";
  } else {
    lookupSql = "order_number = ?";
    lookupParams = [receiptOrderId];
    lookupKeyUsed = "order_number";
  }

  const { rows } = await query(
    `SELECT
       id,
       order_number,
       razorpay_order_id,
       subtotal,
       shipping,
       total,
       is_free_shipping,
       email,
       contact_email
     FROM orders
     WHERE ${lookupSql}
     LIMIT 1`,
    lookupParams,
  );

  return { order: rows[0] || null, lookupKeyUsed };
};

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
// ─────────────────────────────────────────────────────────────────────────────
export const getPromotions = async (req, res) => {
  const { body } = parsePromotionRequestBody(req);

  const { order, lookupKeyUsed } = await loadOrderForPromotionCallback(body);

  if (!order) {
    console.warn("[PROMOTIONS] Order not found", {
      order_id: body.order_id,
      razorpay_order_id: body.razorpay_order_id,
      lookupKeyUsed,
    });
    return res.status(404).json({
      success: false,
      message: "Order not found",
    });
  }

  const subtotal = Number(order.subtotal ?? 0);
  const promotions = getPromotionCatalog(subtotal);

  console.info("[PROMOTIONS] Resolved", {
    orderId: order.id,
    orderNumber: order.order_number,
    lookupKeyUsed,
    subtotal,
    applicableCount: promotions.length,
  });

  return res.json({
    success: true,
    promotions,
    email: order.email || order.contact_email || null,
    amount: subtotal,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/apply-promotions
// ─────────────────────────────────────────────────────────────────────────────
export const applyPromotions = async (req, res) => {
  const { body } = parsePromotionRequestBody(req);

  const { order, lookupKeyUsed } = await loadOrderForPromotionCallback(body);

  if (!order) {
    console.warn("[APPLY_PROMOTIONS] Order not found", {
      order_id: body.order_id,
      razorpay_order_id: body.razorpay_order_id,
      lookupKeyUsed,
    });
    return res.status(404).json({
      success: false,
      message: "Order not found",
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

  const subtotal = Number(order.subtotal ?? 0);
  const promotions = getPromotionCatalog(subtotal);
  const matchedPromotion = promotions.find(
    (promotion) => normalizePromotionCode(promotion.code) === promotionCode,
  );

  if (!matchedPromotion) {
    console.warn("[APPLY_PROMOTIONS] Not applicable", {
      orderId: order.id,
      promotionCode,
      subtotal,
    });
    return res.status(404).json({
      success: false,
      message: "Promotion not applicable",
    });
  }

  const discountAmount = Number(matchedPromotion.discount_amount ?? 0);
  const finalAmount = Math.max(0, subtotal - discountAmount);

  console.info("[APPLY_PROMOTIONS] Applied", {
    orderId: order.id,
    promotionCode,
    subtotal,
    discountAmount,
    finalAmount,
  });

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
      console.error("[WEBHOOK] Parse failed", {
        message: err?.message || String(err),
      });
      return res.status(400).json({ message: "Invalid webhook payload" });
    }
  }

  const { event, payload: eventPayload } = payload;

  const paymentEntity = eventPayload?.payment?.entity;
  const subscriptionEntity = eventPayload?.subscription?.entity;
  const rzpOrderId = paymentEntity?.order_id;
  const rzpSubscriptionId =
    subscriptionEntity?.id || paymentEntity?.subscription_id;
  const rzpPaymentId = paymentEntity?.id;
  const amount = paymentEntity?.amount
    ? Number(paymentEntity.amount) / 100
    : null;

  console.info("[WEBHOOK] Event received", {
    event,
    rzpOrderId,
    rzpSubscriptionId,
    rzpPaymentId,
  });

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
        const order = await loadByRazorpayOrder();
        if (order && order.payment_status === "paid") {
          return res.json({ status: "already_processed" });
        }
        if (order && order.payment_status !== "paid") {
          const whClient = await getClient();
          try {
            await whClient.query("BEGIN");

            const { rows: lockedWh } = await whClient.query(
              "SELECT payment_status, order_status FROM orders WHERE id = ? FOR UPDATE",
              [order.id],
            );
            if (lockedWh[0]?.payment_status === "paid") {
              await whClient.query("COMMIT");
              break;
            }

            await whClient.query(
              `UPDATE orders SET
                 payment_status = 'paid', order_status = 'paid', updated_at = NOW()
               WHERE id = ?`,
              [order.id],
            );

            await whClient.query(
              `UPDATE payments
               SET status = 'captured', razorpay_payment_id = ?, updated_at = NOW()
               WHERE razorpay_order_id = ?`,
              [rzpPaymentId, rzpOrderId],
            );

            await whClient.query(
              `INSERT INTO order_status_history
                 (order_id, previous_status, new_status, changed_by, notes)
               VALUES (?, ?, 'paid', NULL, 'Payment captured via webhook')`,
              [order.id, lockedWh[0].order_status],
            );

            await whClient.query("COMMIT");
          } catch (err) {
            await whClient.query("ROLLBACK");
            console.error("[WEBHOOK] payment.captured transaction failed", {
              orderId: order.id,
              message: err?.message || String(err),
              stack: err?.stack,
            });
            throw err;
          } finally {
            whClient.release();
          }

          emitUpdate(order.id, "paid");

          createPackagePurchaseFromOrder(order.id).catch((err) => {
            console.error(
              "[PACKAGE] createPackagePurchaseFromOrder (webhook) failed",
              {
                orderId: order.id,
                message: err?.message || String(err),
              },
            );
          });
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

    case "subscription.activated": {
      const order = await loadBySubscription();
      if (order) {
        const chargeAt = subscriptionEntity?.charge_at;
        const nextBilling = chargeAt
          ? new Date(chargeAt * 1000).toLocaleString("sv-SE", {
              timeZone: "Asia/Kolkata",
            })
          : null;
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
      console.info("[WEBHOOK] subscription.created — no DB action needed");
      break;
    }

    case "subscription.charged": {
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

        emitUpdate(renewalOrderId, "paid");

        const { sendSubscriptionChargeReceiptEmail } =
          await import("../services/orderEmailService.js").catch(() => ({}));

        if (sendSubscriptionChargeReceiptEmail) {
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
              console.error("[WEBHOOK] Renewal charge receipt email failed", {
                renewalOrderId,
                message: e?.message || String(e),
              }),
            );
          }
        }
      } catch (err) {
        console.error(
          "[WEBHOOK] subscription.charged — createRenewalOrder failed",
          {
            rzpSubscriptionId,
            rzpPaymentId,
            message: err?.message || String(err),
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
        if (order.subscription_status !== "cancelled") {
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
