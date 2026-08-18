import crypto from "crypto";
import { query, getClient } from "../config/database.js";
import { getOrderSchemaInfo } from "../utils/orderSchema.js";
import { getNextOrderNumber } from "../utils/orderNumber.js";

// ==========================================================================
// Constants
// ==========================================================================

/** Order lifecycle values used by this controller (order_status column). */
export const ORDER_STATUS = {
  PENDING_PAYMENT: "pending_payment",
  PAID: "paid",
  PROCESSING: "processing",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
};

/** Payment lifecycle values used by this controller (payment_status column). */
export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
  REFUNDED: "refunded",
};

/** User-facing error messages, centralized so they stay consistent across endpoints. */
const ERROR_MESSAGES = {
  INVALID_ORDER_ID: "Invalid order ID",
  ORDER_NOT_FOUND: "Order not found",
  ADDRESS_NOT_FOUND: "Address not found",
  USER_NOT_FOUND: "User not found",
  CART_EMPTY: "Cart is empty",
  MISSING_FIELDS: "Missing required fields",
  INVALID_CART_ITEM: "Invalid cart item",
  UNSUPPORTED_ORDERS_SCHEMA: "Unsupported orders schema",
  UNSUPPORTED_ORDER_ITEMS_SCHEMA: "Unsupported order_items schema",
};

// ==========================================================================
// Logging
// ==========================================================================

/**
 * Lightweight, dependency-free structured logger. Every entry is a single
 * JSON line: { level, event, timestamp, ...meta }. Never logs PII (emails,
 * phone numbers, addresses) — only IDs, counts, and amounts. A logging
 * failure never interrupts the request.
 *
 * @param {"info"|"error"} level
 * @param {string} event - dot-namespaced event name, e.g. "order.created"
 * @param {object} [meta] - structured context (requestId, orderId, error, ...)
 */
const log = (level, event, meta = {}) => {
  try {
    const entry = {
      level,
      event,
      timestamp: new Date().toISOString(),
      ...meta,
    };
    if (level === "error") {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  } catch {
    // Never let logging break the request.
  }
};

// ==========================================================================
// Response helpers
// ==========================================================================
// Thin wrappers around res.status().json() — they standardize *how* a
// response is sent, not its shape. Each call site still controls its own
// JSON body, so existing response formats are unaffected.

/** Sends a JSON response with the given status and body, unchanged. */
const sendJson = (res, status, body) => res.status(status).json(body);

/** Sends the common `{ message }` error shape used by most failure paths. */
const sendError = (res, status, message) => sendJson(res, status, { message });

// ==========================================================================
// Validation helpers
// ==========================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Low-level UUID v4-ish format check. */
const isValidUUID = (value) => typeof value === "string" && UUID_RE.test(value);

/** Domain-named wrapper: is `id` a well-formed order ID? */
const validateOrderId = (id) => isValidUUID(id);

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

const toSafeNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

/**
 * Validates the top-level fields of a checkout request before any database
 * work happens.
 *
 * @param {Array} cart - normalized cart array (items or cartItems)
 * @param {object} fields - { addressId, contactEmail, contactPhone, contactName }
 * @returns {string|null} an error message if invalid, otherwise null
 */
const validateCheckoutRequest = (
  cart,
  { addressId, contactEmail, contactPhone, contactName },
) => {
  if (!cart.length) {
    return ERROR_MESSAGES.CART_EMPTY;
  }
  if (!addressId || !contactEmail || !contactPhone || !contactName) {
    return ERROR_MESSAGES.MISSING_FIELDS;
  }
  return null;
};

/** Checks that both status fields are present for a payment-status update. */
const validateStatusFields = (payment_status, order_status) =>
  Boolean(payment_status) && Boolean(order_status);

// ==========================================================================
// Schema/column detection cache
// ==========================================================================

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

// ==========================================================================
// Address formatting helpers
// ==========================================================================

/** Joins non-empty address parts into the single-line format stored/displayed everywhere. */
const formatAddressLine = (parts) => parts.filter(Boolean).join(", ");

/**
 * Builds the flattened shipping-address snapshot string stored on the
 * order row at creation time. Mirrors the exact field order used for both
 * the `user_addresses` (new) and legacy `addresses` tables.
 *
 * @param {object} address - row from user_addresses or addresses
 * @param {boolean} isLegacy - true if `address` came from the legacy table
 * @returns {string}
 */
const buildShippingAddressSnapshot = (address, isLegacy) => {
  const parts = isLegacy
    ? [
        address.label || address.full_name,
        address.address_line1,
        address.address_line2,
        address.city,
        address.state,
        address.pincode,
        address.country,
      ]
    : [
        address.full_name,
        address.address_line_1,
        address.address_line_2,
        address.city,
        address.state,
        address.pincode,
        address.country,
      ];
  return formatAddressLine(parts);
};

// ==========================================================================
// Order-creation helpers
// ==========================================================================

/**
 * Locks every product row involved in an order (SELECT ... FOR UPDATE)
 * within the current transaction, so two concurrent checkouts against the
 * same stock can't both pass validation and oversell it. Batches what was
 * previously a per-item product lookup into a single query.
 *
 * @param {object} client - transaction-bound DB client
 * @param {string[]} productIds
 * @param {boolean} shippingColumnsAvailable
 * @returns {Promise<Map<string, object>>} productId -> locked product row
 */
const lockProductsForOrder = async (
  client,
  productIds,
  shippingColumnsAvailable,
) => {
  if (!productIds.length) return new Map();

  const shippingSelect = shippingColumnsAvailable
    ? ", is_free_shipping, shipping_charge, estimated_delivery"
    : "";

  const { rows } = await client.query(
    `SELECT id, name, image, price, stock_qty${shippingSelect}
     FROM products
     WHERE id IN (?) AND is_active = 1
     FOR UPDATE`,
    [productIds],
  );

  const map = new Map();
  for (const row of rows) map.set(row.id, row);
  return map;
};

/**
 * Computes the order-item snapshot (pricing, shipping) for a locked
 * product row and requested quantity.
 *
 * @param {object} product - locked product row
 * @param {number} quantity
 * @returns {object} order item snapshot
 */
const buildOrderItem = (product, quantity) => {
  const price = parseFloat(product.price);
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

  return {
    product_id: product.id,
    name: product.name,
    image: product.image || null,
    price,
    quantity,
    subtotal: price * quantity,
    is_free_shipping: isFreeShipping,
    shipping_charge: itemShippingCharge,
    estimated_delivery: String(product.estimated_delivery || "").trim() || null,
  };
};

/**
 * Batch-inserts order_items in a single multi-row INSERT instead of one
 * INSERT per line, for both the new and legacy order_items schemas.
 *
 * @param {object} client - transaction-bound DB client
 * @param {string} orderId
 * @param {object[]} orderItems
 * @param {boolean} hasNewOrderItems
 */
const insertOrderItemsBatch = async (
  client,
  orderId,
  orderItems,
  hasNewOrderItems,
) => {
  if (!orderItems.length) return;

  if (hasNewOrderItems) {
    const placeholders = orderItems
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    const values = [];
    for (const item of orderItems) {
      values.push(
        crypto.randomUUID(),
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
      `INSERT INTO order_items (id, order_id, product_id, product_name, product_image, product_price, quantity, subtotal)
       VALUES ${placeholders}`,
      values,
    );
  } else {
    const placeholders = orderItems.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const values = [];
    for (const item of orderItems) {
      values.push(
        crypto.randomUUID(),
        orderId,
        item.product_id,
        item.name,
        item.price,
        item.quantity,
      );
    }
    await client.query(
      `INSERT INTO order_items (id, order_id, product_id, name, price, quantity)
       VALUES ${placeholders}`,
      values,
    );
  }
};

// ==========================================================================
// VALIDATE CART BEFORE CHECKOUT
// ==========================================================================

/**
 * Validates a cart payload against live product data (stock, price, status).
 * Batches product lookups into a single query instead of one per line item.
 *
 * @route POST /api/cart/validate (or equivalent)
 * @param {import('express').Request} req - body: { cartItems: Array }
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON: { valid, cartItems, message }
 */
export const validateCart = async (req, res) => {
  try {
    const { cartItems } = req.body;

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return sendJson(res, 400, {
        valid: false,
        message: ERROR_MESSAGES.CART_EMPTY,
      });
    }

    const productIds = [
      ...new Set(cartItems.map((item) => item.id).filter(Boolean)),
    ];

    let productMap = new Map();
    if (productIds.length) {
      const { rows: productRows } = await query(
        `SELECT id, name, price, stock_qty, is_active, status
         FROM products
         WHERE id IN (?)`,
        [productIds],
      );
      productMap = new Map(productRows.map((row) => [row.id, row]));
    }

    const validationResults = [];
    let hasErrors = false;

    for (const item of cartItems) {
      const product = productMap.get(item.id);

      if (!product || !product.is_active || product.status !== "In Stock") {
        validationResults.push({
          productId: item.id,
          valid: false,
          productName: item.name || "Product",
          reason: "Product not available or out of stock",
        });
        hasErrors = true;
        continue;
      }

      const priceMatch =
        Math.abs(parseFloat(product.price) - parseFloat(item.price)) < 0.01;

      if (product.stock_qty < item.quantity) {
        validationResults.push({
          productId: item.id,
          productName: product.name,
          valid: false,
          reason: "Insufficient stock",
          availableQuantity: product.stock_qty,
        });
        hasErrors = true;
      } else if (!priceMatch) {
        validationResults.push({
          productId: item.id,
          productName: product.name,
          valid: false,
          reason: "Price updated",
          currentPrice: product.price,
          previousPrice: item.price,
          priceChanged: true,
        });
        hasErrors = true;
      } else {
        validationResults.push({
          productId: item.id,
          productName: product.name,
          valid: true,
        });
      }
    }

    sendJson(res, 200, {
      valid: !hasErrors,
      cartItems: validationResults,
      message: hasErrors
        ? "Some items in your cart need attention"
        : "Cart is valid",
    });
  } catch (error) {
    log("error", "cart.validate_failed", { error: error?.message });
    sendJson(res, 500, { valid: false, message: "Cart validation failed" });
  }
};

// ==========================================================================
// CREATE ORDER (ENTERPRISE CHECKOUT FLOW)
// ==========================================================================

/**
 * Creates an order from a validated cart.
 *
 * Business flow:
 *   1. Validate request shape (cart, address fields, per-line quantities).
 *   2. Open a transaction; verify the user and resolve the shipping address
 *      (new `user_addresses` table, falling back to the legacy `addresses`
 *      table).
 *   3. Detect the active orders/order_items schema (new vs legacy).
 *   4. Lock every product row (FOR UPDATE) and validate stock.
 *   5. Compute totals, generate the order number, write the order,
 *      order_items (batched), and status-history rows.
 *   6. Commit, then best-effort emit a Socket.IO update.
 *
 * @route POST /api/orders
 * @param {import('express').Request} req - body: { items|cartItems, addressId, contactEmail, contactPhone, contactName, tax }
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON: { success, orderId, orderNumber, addressId, total, shippingAddress }
 * @throws Rethrows unexpected errors after rollback, for the upstream Express error handler.
 */
export const createOrder = async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const client = await getClient();

  try {
    const userId = req.user?.id;
    const {
      items,
      cartItems,
      addressId,
      contactEmail,
      contactPhone,
      contactName,
      tax = 0,
    } = req.body;

    console.log("========== CREATE ORDER REQUEST ==========");
    console.log({
      addressId,
      contactName,
      contactEmail,
      contactPhone,
      userId,
    });
    console.log(req.body);
    console.log("==========================================");

    const cart =
      Array.isArray(items) && items.length
        ? items
        : Array.isArray(cartItems)
          ? cartItems
          : [];

    const checkoutError = validateCheckoutRequest(cart, {
      addressId,
      contactEmail,
      contactPhone,
      contactName,
    });
    if (checkoutError) {
      return sendError(res, 400, checkoutError);
    }

    // Validate the shape of every cart line before opening a transaction
    // or touching the database at all.
    const normalizedCart = [];
    for (const it of cart) {
      const productId = it.product_id || it.productId || it.id;
      const quantity = parseInt(it.quantity || it.qty || 0, 10);
      if (!productId || !isPositiveInteger(quantity)) {
        return sendError(res, 400, ERROR_MESSAGES.INVALID_CART_ITEM);
      }
      normalizedCart.push({ productId, quantity });
    }

    const safeTax = toSafeNumber(tax, 0);

    await client.query("BEGIN");

    const { rows: userRows } = await client.query(
      "SELECT id FROM users WHERE id = ? LIMIT 1",
      [userId],
    );
    if (!userRows.length) {
      await client.query("ROLLBACK");
      return sendError(res, 401, ERROR_MESSAGES.USER_NOT_FOUND);
    }

    const { rows: addressRows } = await client.query(
      `SELECT id, full_name, phone, address_line_1, address_line_2, city, state, pincode, country
       FROM user_addresses
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [addressId, userId],
    );

    let address = addressRows[0];
    let addressFromLegacy = false;
    if (!address) {
      const { rows: fallbackRows } = await client.query(
        `SELECT id, label, address_line1, address_line2, city, state, pincode, country
         FROM addresses
         WHERE id = ? AND user_id = ?
         LIMIT 1`,
        [addressId, userId],
      );
      address = fallbackRows[0];
      if (address) addressFromLegacy = true;
    }

    if (!address) {
      await client.query("ROLLBACK");
      return sendError(res, 404, ERROR_MESSAGES.ADDRESS_NOT_FOUND);
    }

    const shippingAddressSnapshot = buildShippingAddressSnapshot(
      address,
      addressFromLegacy,
    );

    const schemaInfo = await getOrderSchemaInfo(client);
    const {
      isNewOrderSchema,
      isLegacyOrderSchema,
      hasNewOrderItems,
      hasLegacyOrderItems,
    } = schemaInfo;

    if (!isNewOrderSchema && !isLegacyOrderSchema) {
      await client.query("ROLLBACK");
      return sendError(res, 500, ERROR_MESSAGES.UNSUPPORTED_ORDERS_SCHEMA);
    }

    if (isLegacyOrderSchema && !hasLegacyOrderItems) {
      await client.query("ROLLBACK");
      return sendError(res, 500, ERROR_MESSAGES.UNSUPPORTED_ORDER_ITEMS_SCHEMA);
    }

    // Lock every product row up front (single batched query) instead of
    // one SELECT per cart line, and hold FOR UPDATE locks for the rest of
    // the transaction to prevent concurrent oversell.
    const hasShippingColumns = await getProductShippingColumnsAvailable();
    const productIds = [...new Set(normalizedCart.map((c) => c.productId))];
    const productMap = await lockProductsForOrder(
      client,
      productIds,
      hasShippingColumns,
    );

    let calculatedSubtotal = 0;
    let shippingCharge = 0;
    const orderItems = [];

    for (const { productId, quantity } of normalizedCart) {
      const product = productMap.get(productId);

      if (!product) {
        await client.query("ROLLBACK");
        return sendError(res, 400, `Product ${productId} not found`);
      }
      if (product.stock_qty < quantity) {
        await client.query("ROLLBACK");
        return sendError(res, 400, `Insufficient stock for "${product.name}"`);
      }

      const orderItem = buildOrderItem(product, quantity);
      calculatedSubtotal += orderItem.subtotal;
      shippingCharge += orderItem.shipping_charge;
      orderItems.push(orderItem);
    }

    const total = calculatedSubtotal + shippingCharge + safeTax;
    const orderId = crypto.randomUUID();

    // Order number is generated atomically inside this same transaction
    // (see getNextOrderNumber) — UUID orderId remains the primary key /
    // source of truth, order_number is the human-friendly display value.
    const orderNumber = await getNextOrderNumber(client);

    if (isNewOrderSchema) {
      await client.query(
        `INSERT INTO orders (
          id, order_number, user_id, address_id, contact_name, contact_email, contact_phone,
          customer_name, email, mobile_number,
          shipping_address, subtotal, shipping, tax, total,
          is_free_shipping, shipping_charge, estimated_delivery,
          payment_status, order_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${PAYMENT_STATUS.PENDING}', '${ORDER_STATUS.PENDING_PAYMENT}')`,
        [
          orderId,
          orderNumber,
          userId,
          addressId,
          contactName,
          contactEmail,
          contactPhone,
          contactName,
          contactEmail,
          contactPhone,
          shippingAddressSnapshot,
          calculatedSubtotal,
          shippingCharge,
          safeTax,
          total,
          orderItems.every((item) => item.is_free_shipping) ? 1 : 0,
          shippingCharge,
          orderItems.find((item) => item.estimated_delivery)
            ?.estimated_delivery || null,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO orders (id, order_number, user_id, address_id, customer_name, email, mobile_number, shipping_address, amount, payment_status, order_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '${PAYMENT_STATUS.PENDING}', '${ORDER_STATUS.PENDING_PAYMENT}')`,
        [
          orderId,
          orderNumber,
          userId,
          addressId,
          contactName,
          contactEmail,
          contactPhone,
          shippingAddressSnapshot,
          total,
        ],
      );
    }

    await insertOrderItemsBatch(client, orderId, orderItems, hasNewOrderItems);

    await client.query(
      `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [
        orderId,
        null,
        ORDER_STATUS.PENDING_PAYMENT,
        userId || null,
        "Order created via checkout flow",
      ],
    );

    await client.query("COMMIT");

    // Socket failures must never fail the order — it already committed.
    try {
      const io = req.app?.locals?.io;
      if (io) {
        io.emit("order:updated", {
          id: orderId,
          order_status: ORDER_STATUS.PENDING_PAYMENT,
        });
      }
    } catch (socketError) {
      log("error", "order.socket_emit_failed", {
        requestId,
        orderId,
        error: socketError?.message,
      });
    }

    log("info", "order.created", {
      requestId,
      userId,
      orderId,
      orderNumber,
      itemCount: orderItems.length,
      total,
      processingTimeMs: Date.now() - startedAt,
    });

    sendJson(res, 200, {
      success: true,
      orderId,
      orderNumber,
      addressId,
      total,
      shippingAddress: shippingAddressSnapshot,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      log("error", "order.rollback_failed", {
        requestId,
        error: rollbackError?.message,
      });
    }
    log("error", "order.create_failed", {
      requestId,
      error: err?.message,
      processingTimeMs: Date.now() - startedAt,
    });
    throw err;
  } finally {
    client.release();
  }
};

// ==========================================================================
// GET ORDER BY ID
// ==========================================================================

/**
 * Fetches a single order and its line items.
 *
 * @route GET /api/orders/:id
 * @param {import('express').Request} req - params: { id }; req.user optional (optionalAuth)
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON: order fields spread + { items }
 */
export const getOrder = async (req, res) => {
  try {
    // Route uses optionalAuth, so req.user may be undefined for
    // guest/expired sessions. Coerce to null (mysql2 rejects `undefined`
    // bind params) — the `user_id = ? OR user_id IS NULL` clause below is
    // unchanged, so a non-guest order still requires a matching,
    // authenticated user_id.
    const userId = req.user?.id || null;
    const { id } = req.params;

    if (!validateOrderId(id)) {
      return sendError(res, 400, ERROR_MESSAGES.INVALID_ORDER_ID);
    }

    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;
    const useNewOrderItems = schemaInfo.hasNewOrderItems;

    const orderQuery = isNewOrderSchema
      ? `SELECT id, order_number, user_id, contact_email, contact_phone, contact_name,
         shipping_address, subtotal, shipping, tax, total, is_free_shipping, shipping_charge, estimated_delivery,
         payment_status, order_status,
         razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, paid_at, subscription_status,
         next_billing_date, created_at, updated_at
       FROM orders
       WHERE id = ? AND (user_id = ? OR user_id IS NULL)`
      : `SELECT id, order_number, user_id, email AS contact_email, mobile_number AS contact_phone,
         customer_name AS contact_name, shipping_address, amount AS total, is_free_shipping, shipping_charge, estimated_delivery,
         payment_status,
         order_status, razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, paid_at,
         subscription_status, next_billing_date, created_at, updated_at
       FROM orders
       WHERE id = ? AND (user_id = ? OR user_id IS NULL)`;

    const { rows: orderRows } = await query(orderQuery, [id, userId]);
    if (!orderRows.length) {
      return sendError(res, 404, ERROR_MESSAGES.ORDER_NOT_FOUND);
    }

    const itemQuery = useNewOrderItems
      ? `SELECT id, product_id, product_name AS name, product_image, product_price AS price,
               product_mrp AS mrp, product_quantity_pack AS quantity_pack, quantity, subtotal
         FROM order_items
         WHERE order_id = ?`
      : `SELECT id, product_id, name AS product_name, NULL AS product_image,
               price AS product_price, NULL AS product_mrp,
               NULL AS product_quantity_pack, quantity, (price * quantity) AS subtotal
         FROM order_items
         WHERE order_id = ?`;

    const { rows: itemRows } = await query(itemQuery, [id]);

    sendJson(res, 200, {
      ...orderRows[0],
      items: itemRows,
    });
  } catch (error) {
    log("error", "order.get_failed", {
      orderId: req.params?.id,
      error: error?.message,
    });
    sendError(res, 500, "Failed to fetch order");
  }
};

// ==========================================================================
// GET ORDER HISTORY
// ==========================================================================

/**
 * Fetches an order's status-change history.
 *
 * @route GET /api/orders/:id/history
 * @param {import('express').Request} req - params: { id }
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON: { success, history }
 */
export const getOrderHistory = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!validateOrderId(id)) {
      return sendError(res, 400, ERROR_MESSAGES.INVALID_ORDER_ID);
    }

    const { rows: orderRows } = await query(
      "SELECT id, order_number FROM orders WHERE id = ? AND (user_id = ? OR user_id IS NULL)",
      [id, userId],
    );

    if (!orderRows.length) {
      return sendError(res, 404, ERROR_MESSAGES.ORDER_NOT_FOUND);
    }

    const { rows: historyRows } = await query(
      `SELECT id, previous_status, new_status, changed_by, notes, created_at
       FROM order_status_history
       WHERE order_id = ?
       ORDER BY created_at ASC`,
      [id],
    );

    sendJson(res, 200, { success: true, history: historyRows });
  } catch (error) {
    log("error", "order.get_history_failed", {
      orderId: req.params?.id,
      error: error?.message,
    });
    sendError(res, 500, "Failed to fetch order history");
  }
};

// ==========================================================================
// GET ORDER SUCCESS DETAILS
// ==========================================================================

/**
 * Fetches the full order-confirmation payload shown on the post-checkout
 * success page: canonical order, items, and payment details.
 *
 * Shipping address is resolved via a 3-tier fallback:
 *   1. `shipping_address` column (set at order creation — most reliable)
 *   2. `user_addresses` / legacy `addresses` lookup via `address_id`
 *   3. Empty string — UI shows "Not Available" only if all tiers fail
 *
 * @route GET /api/orders/:id/success
 * @param {import('express').Request} req - params: { id }
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON: { order, items, paymentDetails }
 */
export const getOrderSuccess = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!validateOrderId(id)) {
      return sendError(res, 400, ERROR_MESSAGES.INVALID_ORDER_ID);
    }

    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;
    const useNewOrderItems = schemaInfo.hasNewOrderItems;

    const orderQuery = isNewOrderSchema
      ? `SELECT id, order_number, user_id, contact_name, contact_email,
           contact_phone, address_id, shipping_address, subtotal, shipping, tax, total,
           is_free_shipping, shipping_charge, estimated_delivery,
           payment_status, order_status, razorpay_order_id, razorpay_subscription_id,
           razorpay_payment_id, paid_at, subscription_status, next_billing_date,
           created_at, updated_at
         FROM orders
         WHERE id = ? AND (user_id = ? OR user_id IS NULL)`
      : `SELECT id, order_number, user_id, customer_name AS contact_name, email AS contact_email,
           mobile_number AS contact_phone, shipping_address, amount AS total,
           is_free_shipping, shipping_charge, estimated_delivery,
           payment_status, order_status, razorpay_order_id, razorpay_subscription_id,
           razorpay_payment_id, paid_at, subscription_status, next_billing_date,
           created_at, updated_at
         FROM orders
         WHERE id = ? AND (user_id = ? OR user_id IS NULL)`;

    const { rows: orderRows } = await query(orderQuery, [id, userId]);
    if (!orderRows.length) {
      return sendError(res, 404, ERROR_MESSAGES.ORDER_NOT_FOUND);
    }

    const orderRow = orderRows[0];

    // ── Shipping address resolution (3-tier fallback, see JSDoc above) ──
    let shippingAddress = "";

    const tier1 = orderRow.shipping_address;
    if (tier1 && tier1.trim()) {
      shippingAddress = tier1.trim();
    } else if (orderRow.address_id) {
      const { rows: addressRows } = await query(
        `SELECT full_name, phone, address_line_1, address_line_2, city, state, pincode, country
         FROM user_addresses
         WHERE id = ? LIMIT 1`,
        [orderRow.address_id],
      );
      let address = addressRows[0];

      if (!address) {
        try {
          const { rows: legacyRows } = await query(
            `SELECT label, address_line1, address_line2, city, state, pincode, country, full_name, phone
             FROM addresses
             WHERE id = ? LIMIT 1`,
            [orderRow.address_id],
          );
          if (legacyRows[0]) {
            address = {
              full_name: legacyRows[0].full_name || legacyRows[0].label,
              phone: legacyRows[0].phone,
              address_line_1: legacyRows[0].address_line1,
              address_line_2: legacyRows[0].address_line2,
              city: legacyRows[0].city,
              state: legacyRows[0].state,
              pincode: legacyRows[0].pincode,
              country: legacyRows[0].country,
            };
          }
        } catch (legacyError) {
          log("error", "order.legacy_address_lookup_failed", {
            orderId: id,
            error: legacyError?.message,
          });
        }
      }

      if (address) {
        shippingAddress = formatAddressLine([
          address.full_name,
          address.address_line_1,
          address.address_line_2,
          address.city,
          address.state,
          address.pincode,
          address.country,
        ]);
      }
    }

    if (!shippingAddress) {
      log("info", "order.shipping_address_unresolved", { orderId: id });
    }

    const canonicalOrder = {
      id: orderRow.id,
      userId: orderRow.user_id,
      contactName: orderRow.contact_name,
      contactEmail: orderRow.contact_email,
      contactPhone: orderRow.contact_phone,
      shippingAddress,
      subtotal: parseFloat(orderRow.subtotal ?? 0),
      shipping: parseFloat(orderRow.shipping ?? 0),
      isFreeShipping: Boolean(orderRow.is_free_shipping),
      shippingCharge: parseFloat(orderRow.shipping_charge ?? 0),
      estimatedDelivery: orderRow.estimated_delivery || null,
      tax: parseFloat(orderRow.tax ?? 0),
      total: parseFloat(orderRow.total ?? orderRow.amount ?? 0),
      paymentStatus: orderRow.payment_status,
      orderStatus: orderRow.order_status,
      razorpayOrderId: orderRow.razorpay_order_id,
      razorpaySubscriptionId: orderRow.razorpay_subscription_id,
      subscriptionStatus: orderRow.subscription_status,
      nextBillingDate: orderRow.next_billing_date,
      razorpayPaymentId: orderRow.razorpay_payment_id,
      paidAt: orderRow.paid_at,
      createdAt: orderRow.created_at,
      updatedAt: orderRow.updated_at,
    };

    const itemQuery = useNewOrderItems
      ? `SELECT product_id, product_name AS name, product_image AS image, product_price AS unit_price,
               quantity, subtotal
         FROM order_items
         WHERE order_id = ?`
      : `SELECT product_id, name AS name, NULL AS image, price AS unit_price,
               quantity, (price * quantity) AS subtotal
         FROM order_items
         WHERE order_id = ?`;

    const { rows: itemRows } = await query(itemQuery, [id]);

    const { rows: paymentRows } = await query(
      `SELECT id, order_id, razorpay_order_id, razorpay_payment_id, amount, currency, status,
              created_at, updated_at
       FROM payments
       WHERE order_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [id],
    );

    const paymentDetails = paymentRows[0] || {
      razorpay_order_id: canonicalOrder.razorpayOrderId,
      razorpay_payment_id: canonicalOrder.razorpayPaymentId,
      amount: canonicalOrder.total,
      currency: "INR",
      status: canonicalOrder.paymentStatus,
    };

    return sendJson(res, 200, {
      order: canonicalOrder,
      items: itemRows,
      paymentDetails,
    });
  } catch (error) {
    log("error", "order.get_success_failed", {
      orderId: req.params?.id,
      error: error?.message,
    });
    sendError(res, 500, "Failed to fetch order details");
  }
};

// ==========================================================================
// GET USER ORDERS (EXISTING - KEPT FOR COMPATIBILITY)
// ==========================================================================

/**
 * Fetches the current user's order list.
 *
 * @route GET /api/orders/mine
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON: array of order summary rows
 */
export const getMyOrders = async (req, res) => {
  try {
    const userId = req.user?.id;
    console.info("[ORDERS] Customer identity", { userId });

    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;

    // FIX (Profile → Orders missing bulk/renewal orders): the source-type
    // columns (is_bulk_order/bulk_booking_number/company_name/
    // is_subscription/is_renewal_order) already exist on `orders` — reused
    // here, not introduced — so the frontend can tell a bulk order or a
    // subscription renewal apart from a normal one instead of rendering
    // every row identically. The WHERE clause itself (`o.user_id = ?`) is
    // unchanged: it was never too restrictive — the real bug was that
    // bulk-created orders had user_id written as NULL (see
    // bulkOrderService.js's INSERT), so this exact filter correctly
    // excluded them. Subscription/renewal orders already carry the correct
    // user_id (copied from the original order in renewalService.js) and
    // were never excluded by this query.
    const orderQuery = isNewOrderSchema
      ? `SELECT o.id, o.order_number, o.contact_name, o.contact_email, o.contact_phone, o.total,
           o.payment_status, o.order_status, o.is_free_shipping, o.shipping_charge, o.estimated_delivery,
           o.razorpay_order_id, o.razorpay_subscription_id,
           o.subscription_status, o.next_billing_date, o.created_at,
           o.parent_package_id, o.fulfillment_cycle,
           o.is_bulk_order, o.bulk_booking_id, o.bulk_booking_number, o.company_name,
           o.is_subscription, o.is_renewal_order, o.parent_order_id,
           pkg.package_number, pkg.total_cycles AS package_total_cycles,
           pkg.next_fulfillment_date AS package_next_fulfillment_date,
           pkg.status AS package_status
         FROM orders o
         LEFT JOIN package_purchases pkg ON pkg.id = o.parent_package_id
         WHERE o.user_id = ?
         ORDER BY o.created_at DESC`
      : `SELECT o.id, o.order_number, o.customer_name AS contact_name, o.email AS contact_email,
           o.mobile_number AS contact_phone, o.amount AS total,
           o.payment_status, o.order_status, o.is_free_shipping, o.shipping_charge, o.estimated_delivery,
           o.razorpay_order_id, o.razorpay_subscription_id,
           o.subscription_status, o.next_billing_date, o.created_at,
           o.parent_package_id, o.fulfillment_cycle,
           o.is_bulk_order, o.bulk_booking_id, o.bulk_booking_number, o.company_name,
           o.is_subscription, o.is_renewal_order, o.parent_order_id,
           pkg.package_number, pkg.total_cycles AS package_total_cycles,
           pkg.next_fulfillment_date AS package_next_fulfillment_date,
           pkg.status AS package_status
         FROM orders o
         LEFT JOIN package_purchases pkg ON pkg.id = o.parent_package_id
         WHERE o.user_id = ?
         ORDER BY o.created_at DESC`;

    console.info("[ORDERS] Query filters", {
      userId,
      isNewOrderSchema,
      filter: "o.user_id = ?",
    });

    const { rows: orderRows } = await query(orderQuery, [userId]);

    console.info("[ORDERS] Orders found", {
      userId,
      count: orderRows.length,
      bulkOrderCount: orderRows.filter((o) => o.is_bulk_order).length,
      renewalOrderCount: orderRows.filter((o) => o.is_renewal_order).length,
      subscriptionOrderCount: orderRows.filter((o) => o.is_subscription).length,
    });

    orderRows.forEach((o) => {
      if (o.is_bulk_order) {
        console.info("[ORDERS] Bulk order included", {
          userId,
          orderId: o.id,
          orderNumber: o.order_number,
          bulkBookingNumber: o.bulk_booking_number,
        });
      }
      if (o.is_renewal_order) {
        console.info("[ORDERS] Subscription renewal included", {
          userId,
          orderId: o.id,
          orderNumber: o.order_number,
          parentOrderId: o.parent_order_id,
        });
      }
    });

    sendJson(res, 200, orderRows);
  } catch (error) {
    log("error", "order.get_my_orders_failed", { error: error?.message });
    sendError(res, 500, "Failed to fetch orders");
  }
};

// ==========================================================================
// UPDATE PAYMENT STATUS
// ==========================================================================

/**
 * Updates an order's payment_status and order_status.
 *
 * @route PATCH /api/orders/:id/payment-status
 * @param {import('express').Request} req - params: { id }; body: { payment_status, order_status }
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON: { success }
 */
export const updatePaymentStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { payment_status, order_status } = req.body;

    if (!validateOrderId(id)) {
      return sendError(res, 400, ERROR_MESSAGES.INVALID_ORDER_ID);
    }
    if (!validateStatusFields(payment_status, order_status)) {
      return sendError(res, 400, ERROR_MESSAGES.MISSING_FIELDS);
    }

    const { rows: orderRows } = await query(
      "SELECT id FROM orders WHERE id = ? AND user_id = ?",
      [id, userId],
    );

    if (!orderRows.length) {
      return sendError(res, 404, ERROR_MESSAGES.ORDER_NOT_FOUND);
    }

    await query(
      "UPDATE orders SET payment_status = ?, order_status = ?, updated_at = now() WHERE id = ?",
      [payment_status, order_status, id],
    );

    sendJson(res, 200, { success: true });
  } catch (error) {
    log("error", "order.update_payment_status_failed", {
      orderId: req.params?.id,
      error: error?.message,
    });
    sendError(res, 500, "Failed to update payment status");
  }
};

// ==========================================================================
// GET ORDER TRACKING
// ==========================================================================

/**
 * Fetches shipment-tracking details for an order: order + resolved
 * shipping address, line items, and status history. Address resolution
 * joins `user_addresses` and legacy `addresses` directly in the main
 * query rather than the multi-query fallback used by getOrderSuccess.
 *
 * @route GET /api/orders/:id/tracking
 * @param {import('express').Request} req - params: { id }
 * @param {import('express').Response} res
 * @returns {Promise<void>} JSON: { success, order, items, history }
 */
export const getOrderTracking = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!validateOrderId(id)) {
      return sendError(res, 400, ERROR_MESSAGES.INVALID_ORDER_ID);
    }

    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;

    const orderQuery = isNewOrderSchema
      ? `SELECT o.id, o.order_number, o.user_id, o.order_status, o.payment_status, o.shipping_address,
           o.subtotal, o.shipping, o.tax, o.total, o.is_free_shipping, o.shipping_charge, o.estimated_delivery, o.created_at,
           o.delivered_at, o.return_status,
           o.parent_package_id, o.fulfillment_cycle,
           pkg.package_number, pkg.total_cycles AS package_total_cycles,
           o.contact_name, o.contact_email,
           ua.full_name AS ua_full_name,
           ua.phone AS ua_phone,
           ua.address_line_1 AS ua_address_line_1,
           ua.address_line_2 AS ua_address_line_2,
           ua.city AS ua_city,
           ua.state AS ua_state,
           ua.pincode AS ua_pincode,
           ua.country AS ua_country,
           la.label AS la_label,
           la.address_line1 AS la_address_line1,
           la.address_line2 AS la_address_line2,
           la.city AS la_city,
           la.state AS la_state,
           la.pincode AS la_pincode,
           la.country AS la_country
         FROM orders o
         LEFT JOIN user_addresses ua ON ua.id = o.address_id AND ua.user_id = o.user_id
         LEFT JOIN addresses la ON la.id = o.address_id AND la.user_id = o.user_id
         LEFT JOIN package_purchases pkg ON pkg.id = o.parent_package_id
         WHERE o.id = ? AND (o.user_id = ? OR o.user_id IS NULL)`
      : `SELECT o.id, o.order_number, o.user_id, o.order_status, o.payment_status, o.shipping_address,
           o.subtotal, o.shipping, o.tax, o.total, o.is_free_shipping, o.shipping_charge, o.estimated_delivery, o.created_at,
           o.delivered_at, o.return_status,
           o.parent_package_id, o.fulfillment_cycle,
           pkg.package_number, pkg.total_cycles AS package_total_cycles,
           o.customer_name AS contact_name, o.email AS contact_email,
           ua.full_name AS ua_full_name,
           ua.phone AS ua_phone,
           ua.address_line_1 AS ua_address_line_1,
           ua.address_line_2 AS ua_address_line_2,
           ua.city AS ua_city,
           ua.state AS ua_state,
           ua.pincode AS ua_pincode,
           ua.country AS ua_country,
           la.label AS la_label,
           la.address_line1 AS la_address_line1,
           la.address_line2 AS la_address_line2,
           la.city AS la_city,
           la.state AS la_state,
           la.pincode AS la_pincode,
           la.country AS la_country
         FROM orders o
         LEFT JOIN user_addresses ua ON ua.id = o.address_id AND ua.user_id = o.user_id
         LEFT JOIN addresses la ON la.id = o.address_id AND la.user_id = o.user_id
         LEFT JOIN package_purchases pkg ON pkg.id = o.parent_package_id
         WHERE o.id = ? AND (o.user_id = ? OR o.user_id IS NULL)`;

    const { rows: orderRows } = await query(orderQuery, [id, userId]);

    if (!orderRows.length) {
      return sendError(res, 404, ERROR_MESSAGES.ORDER_NOT_FOUND);
    }

    const order = orderRows[0];

    const [{ rows: orderItems }, { rows: historyRows }] = await Promise.all([
      query(
        `SELECT id, product_name, product_image, product_price, quantity, subtotal
         FROM order_items
         WHERE order_id = ?`,
        [order.id],
      ),
      query(
        `SELECT id, previous_status, new_status, changed_by, notes, created_at
         FROM order_status_history
         WHERE order_id = ?
         ORDER BY created_at ASC`,
        [order.id],
      ),
    ]);

    const resolvedShippingAddress =
      order.shipping_address ||
      formatAddressLine([
        order.ua_full_name,
        order.ua_address_line_1,
        order.ua_address_line_2,
        order.ua_city,
        order.ua_state,
        order.ua_pincode,
        order.ua_country,
      ]) ||
      formatAddressLine([
        order.la_label,
        order.la_address_line1,
        order.la_address_line2,
        order.la_city,
        order.la_state,
        order.la_pincode,
        order.la_country,
      ]);

    const responseOrder = {
      ...order,
      shipping_address: resolvedShippingAddress,
      items: orderItems,
    };

    sendJson(res, 200, {
      success: true,
      order: responseOrder,
      items: orderItems,
      history: historyRows,
    });
  } catch (error) {
    log("error", "order.get_tracking_failed", {
      orderId: req.params?.id,
      error: error?.message,
    });
    sendError(res, 500, "Failed to fetch tracking info");
  }
};
