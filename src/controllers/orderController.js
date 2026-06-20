import crypto from "crypto";
import { query, getClient } from "../config/database.js";
import {
  formatAddressSnapshot,
  getOrderSchemaInfo,
} from "../utils/orderSchema.js";

const normalizeOrderStatus = (s) => {
  if (!s) return null;
  const l = String(s).toLowerCase();
  if (["processing", "shipped", "out_for_delivery", "dispatched"].includes(l))
    return "dispatched";
  if (["pending", "confirmed", "delivered", "cancelled"].includes(l)) return l;
  return l;
};

// ========================================
// VALIDATE CART BEFORE CHECKOUT
// ========================================
export const validateCart = async (req, res) => {
  try {
    const { cartItems } = req.body;

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({
        valid: false,
        message: "Cart is empty",
      });
    }

    const validationResults = [];
    let hasErrors = false;

    for (const item of cartItems) {
      const { rows: productRows } = await query(
        `SELECT id, name, price, stock_qty, is_active, status
         FROM products
         WHERE id = ?`,
        [item.id],
      );

      if (
        !productRows.length ||
        !productRows[0].is_active ||
        productRows[0].status !== "In Stock"
      ) {
        validationResults.push({
          productId: item.id,
          valid: false,
          productName: item.name || "Product",
          reason: "Product not available or out of stock",
        });
        hasErrors = true;
        continue;
      }

      const product = productRows[0];
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

    res.json({
      valid: !hasErrors,
      cartItems: validationResults,
      message: hasErrors
        ? "Some items in your cart need attention"
        : "Cart is valid",
    });
  } catch (error) {
    console.error("Error validating cart:", error);
    res.status(500).json({ valid: false, message: "Cart validation failed" });
  }
};

// ========================================
// CREATE ORDER (ENTERPRISE CHECKOUT FLOW)
// ========================================
export const createOrder = async (req, res) => {
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
      shipping = 0,
      tax = 0,
    } = req.body;

    console.log("[CREATE_ORDER] addressId:", addressId, "userId:", userId);

    const cart =
      Array.isArray(items) && items.length
        ? items
        : Array.isArray(cartItems)
          ? cartItems
          : [];
    if (!cart.length) {
      return res.status(400).json({ message: "Cart is empty" });
    }
    if (!addressId || !contactEmail || !contactPhone || !contactName) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    await client.query("BEGIN");

    const { rows: userRows } = await client.query(
      "SELECT id FROM users WHERE id = ? LIMIT 1",
      [userId],
    );
    if (!userRows.length) {
      await client.query("ROLLBACK");
      return res.status(401).json({ message: "User not found" });
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
      return res.status(404).json({ message: "Address not found" });
    }

    // ── Build shipping_address snapshot ──────────────────────────────────────
    let shippingAddressSnapshot = "";
    if (!addressFromLegacy) {
      shippingAddressSnapshot = [
        address.full_name,
        address.address_line_1,
        address.address_line_2,
        address.city,
        address.state,
        address.pincode,
        address.country,
      ]
        .filter(Boolean)
        .join(", ");
    } else {
      shippingAddressSnapshot = [
        address.label || address.full_name,
        address.address_line1,
        address.address_line2,
        address.city,
        address.state,
        address.pincode,
        address.country,
      ]
        .filter(Boolean)
        .join(", ");
    }
    console.log("[ADDRESS_SAVE] Snapshot:", shippingAddressSnapshot);

    const schemaInfo = await getOrderSchemaInfo(client);
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;
    const isLegacyOrderSchema = schemaInfo.isLegacyOrderSchema;
    const hasNewOrderItems = schemaInfo.hasNewOrderItems;
    const hasLegacyOrderItems = schemaInfo.hasLegacyOrderItems;

    if (!isNewOrderSchema && !isLegacyOrderSchema) {
      await client.query("ROLLBACK");
      return res.status(500).json({ message: "Unsupported orders schema" });
    }

    if (isLegacyOrderSchema && !hasLegacyOrderItems) {
      await client.query("ROLLBACK");
      return res
        .status(500)
        .json({ message: "Unsupported order_items schema" });
    }

    let calculatedSubtotal = 0;
    const orderItems = [];

    for (const it of cart) {
      const productId = it.product_id || it.productId || it.id;
      const quantity = parseInt(it.quantity || it.qty || 0, 10);
      if (!productId || quantity <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid cart item" });
      }

      const { rows: productRows } = await client.query(
        "SELECT id, name, image, price, stock_qty FROM products WHERE id = ? AND is_active = 1 LIMIT 1",
        [productId],
      );
      if (!productRows.length) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Product ${productId} not found` });
      }

      const product = productRows[0];
      if (product.stock_qty < quantity) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Insufficient stock for "${product.name}"` });
      }

      const price = parseFloat(product.price);
      calculatedSubtotal += price * quantity;
      orderItems.push({
        product_id: product.id,
        name: product.name,
        image: product.image || null,
        price,
        quantity,
        subtotal: price * quantity,
      });
    }

    const total = calculatedSubtotal + parseFloat(shipping) + parseFloat(tax);
    const orderId = crypto.randomUUID();

    console.log("[CREATE_ORDER] orderId:", orderId, "total:", total);

    if (isNewOrderSchema) {
      await client.query(
        `INSERT INTO orders (
          id, user_id, address_id, contact_name, contact_email, contact_phone,
          customer_name, email, mobile_number,
          shipping_address, subtotal, shipping, tax, total,
          payment_status, order_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`,
        [
          orderId,
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
          shipping,
          tax,
          total,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO orders (id, user_id, address_id, customer_name, email, mobile_number, shipping_address, amount, payment_status, order_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`,
        [
          orderId,
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

    console.log("[ORDER_SAVE] Saved order:", orderId);

    for (const item of orderItems) {
      const itemId = crypto.randomUUID();
      if (hasNewOrderItems) {
        await client.query(
          `INSERT INTO order_items (id, order_id, product_id, product_name, product_image, product_price, quantity, subtotal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            itemId,
            orderId,
            item.product_id,
            item.name,
            item.image,
            item.price,
            item.quantity,
            item.subtotal,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO order_items (id, order_id, product_id, name, price, quantity)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            itemId,
            orderId,
            item.product_id,
            item.name,
            item.price,
            item.quantity,
          ],
        );
      }
    }

    await client.query(
      `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [
        orderId,
        null,
        "pending",
        userId || null,
        "Order created via checkout flow",
      ],
    );

    await client.query("COMMIT");

    console.log("[CREATE_ORDER] Complete. orderId:", orderId);

    try {
      const io = req.app?.locals?.io;
      if (io)
        io.emit("order:updated", { id: orderId, order_status: "pending" });
    } catch (e) {}

    let responseShippingAddress = shippingAddressSnapshot;

    res.json({
      success: true,
      orderId,
      addressId,
      total,
      shippingAddress: responseShippingAddress,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[CREATE_ORDER] Error:", err);
    throw err;
  } finally {
    client.release();
  }
};

// ========================================
// GET ORDER BY ID
// ========================================
export const getOrder = async (req, res) => {
  try {
    // FIX (audit Section 2 / Fix 1): route now uses optionalAuth, so
    // req.user may be undefined for guest/expired sessions. Coerce to null
    // (mysql2 rejects `undefined` bind params) — the existing
    // `user_id = ? OR user_id IS NULL` clause below is unchanged, so a
    // non-guest order still requires a matching, authenticated user_id.
    const userId = req.user?.id || null;
    const { id } = req.params;

    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;
    const useNewOrderItems = schemaInfo.hasNewOrderItems;

    // FIX: Include shipping_address in new schema query
    const orderQuery = isNewOrderSchema
      ? `SELECT id, user_id, contact_email, contact_phone, contact_name,
         shipping_address, subtotal, shipping, tax, total, payment_status, order_status,
         razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, paid_at, subscription_status,
         next_billing_date, created_at, updated_at
       FROM orders
       WHERE id = ? AND (user_id = ? OR user_id IS NULL)`
      : `SELECT id, user_id, email AS contact_email, mobile_number AS contact_phone,
         customer_name AS contact_name, shipping_address, amount AS total, payment_status,
         order_status, razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, paid_at,
         subscription_status, next_billing_date, created_at, updated_at
       FROM orders
       WHERE id = ? AND (user_id = ? OR user_id IS NULL)`;

    const { rows: orderRows } = await query(orderQuery, [id, userId]);
    if (!orderRows.length) {
      return res.status(404).json({ message: "Order not found" });
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

    res.json({
      ...orderRows[0],
      items: itemRows,
    });
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({ message: "Failed to fetch order" });
  }
};

// ========================================
// GET ORDER HISTORY
// ========================================
export const getOrderHistory = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    const { rows: orderRows } = await query(
      "SELECT id FROM orders WHERE id = ? AND (user_id = ? OR user_id IS NULL)",
      [id, userId],
    );

    if (!orderRows.length) {
      return res.status(404).json({ message: "Order not found" });
    }

    const { rows: historyRows } = await query(
      `SELECT id, previous_status, new_status, changed_by, notes, created_at
       FROM order_status_history
       WHERE order_id = ?
       ORDER BY created_at ASC`,
      [id],
    );

    res.json({ success: true, history: historyRows });
  } catch (error) {
    console.error("Error fetching order history:", error);
    res.status(500).json({ message: "Failed to fetch order history" });
  }
};

// ========================================
// GET ORDER SUCCESS DETAILS
// ========================================
export const getOrderSuccess = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    console.log("[ORDER_SUCCESS] Fetching orderId:", id, "userId:", userId);

    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;
    const useNewOrderItems = schemaInfo.hasNewOrderItems;

    // FIX: new-schema query now includes shipping_address column
    const orderQuery = isNewOrderSchema
      ? `SELECT id, user_id, contact_name, contact_email,
           contact_phone, address_id, shipping_address, subtotal, shipping, tax, total,
           payment_status, order_status, razorpay_order_id, razorpay_subscription_id,
           razorpay_payment_id, paid_at, subscription_status, next_billing_date,
           created_at, updated_at
         FROM orders
         WHERE id = ? AND (user_id = ? OR user_id IS NULL)`
      : `SELECT id, user_id, customer_name AS contact_name, email AS contact_email,
           mobile_number AS contact_phone, shipping_address, amount AS total,
           payment_status, order_status, razorpay_order_id, razorpay_subscription_id,
           razorpay_payment_id, paid_at, subscription_status, next_billing_date,
           created_at, updated_at
         FROM orders
         WHERE id = ? AND (user_id = ? OR user_id IS NULL)`;

    const { rows: orderRows } = await query(orderQuery, [id, userId]);
    if (!orderRows.length) {
      console.warn("[ORDER_SUCCESS] Order not found:", id);
      return res.status(404).json({ message: "Order not found" });
    }

    const orderRow = orderRows[0];
    console.log("[ORDER_SUCCESS] orderRow:", JSON.stringify(orderRow));

    // ── Shipping address resolution (3-tier fallback) ────────────────────────
    // Tier 1: shipping_address column (set at order creation time — most reliable)
    // Tier 2: user_addresses / addresses lookup via address_id
    // Tier 3: empty string — UI will show "Not Available" only if all tiers fail
    let shippingAddress = "";

    const tier1 = orderRow.shipping_address;
    console.log("[ORDER_SUCCESS] Tier-1 shipping_address from DB:", tier1);

    if (tier1 && tier1.trim()) {
      shippingAddress = tier1.trim();
      console.log("[ORDER_SUCCESS] Using Tier-1 shipping_address");
    } else if (orderRow.address_id) {
      console.log(
        "[ORDER_SUCCESS] Tier-1 empty, trying Tier-2 address_id:",
        orderRow.address_id,
      );

      // Tier 2a: user_addresses table
      const { rows: addressRows } = await query(
        `SELECT full_name, phone, address_line_1, address_line_2, city, state, pincode, country
         FROM user_addresses
         WHERE id = ? LIMIT 1`,
        [orderRow.address_id],
      );
      let address = addressRows[0];

      // Tier 2b: legacy addresses table
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
        } catch (e) {
          console.warn(
            "[ORDER_SUCCESS] Legacy address lookup failed:",
            e?.message || e,
          );
        }
      }

      if (address) {
        shippingAddress = [
          address.full_name,
          address.address_line_1,
          address.address_line_2,
          address.city,
          address.state,
          address.pincode,
          address.country,
        ]
          .filter(Boolean)
          .join(", ");
        console.log("[ORDER_SUCCESS] Using Tier-2 address:", shippingAddress);
      }
    }

    if (!shippingAddress) {
      console.warn(
        "[ORDER_SUCCESS] All tiers failed — shippingAddress will be empty for order:",
        id,
      );
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

    console.log(
      "[ORDER_SUCCESS] canonicalOrder.shippingAddress:",
      canonicalOrder.shippingAddress,
    );

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

    const responseBody = {
      order: canonicalOrder,
      items: itemRows,
      paymentDetails,
    };

    console.log(
      "[ORDER_SUCCESS] Response shippingAddress:",
      canonicalOrder.shippingAddress || "(empty)",
    );
    return res.json(responseBody);
  } catch (error) {
    console.error("[ORDER_SUCCESS] Error:", error);
    res.status(500).json({ message: "Failed to fetch order details" });
  }
};

// ========================================
// GET USER ORDERS (EXISTING - KEPT FOR COMPATIBILITY)
// ========================================
export const getMyOrders = async (req, res) => {
  try {
    const userId = req.user?.id;
    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;

    const orderQuery = isNewOrderSchema
      ? `SELECT id, contact_name, contact_email, contact_phone, total,
           payment_status, order_status, razorpay_order_id, razorpay_subscription_id,
           subscription_status, next_billing_date, created_at
         FROM orders
         WHERE user_id = ?
         ORDER BY created_at DESC`
      : `SELECT id, customer_name AS contact_name, email AS contact_email,
           mobile_number AS contact_phone, amount AS total,
           payment_status, order_status, razorpay_order_id, razorpay_subscription_id,
           subscription_status, next_billing_date, created_at
         FROM orders
         WHERE user_id = ?
         ORDER BY created_at DESC`;

    const { rows: orderRows } = await query(orderQuery, [userId]);

    res.json(orderRows);
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// ========================================
// UPDATE PAYMENT STATUS
// ========================================
export const updatePaymentStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { payment_status, order_status } = req.body;

    const { rows: orderRows } = await query(
      "SELECT id FROM orders WHERE id = ? AND user_id = ?",
      [id, userId],
    );

    if (!orderRows.length) {
      return res.status(404).json({ message: "Order not found" });
    }

    await query(
      "UPDATE orders SET payment_status = ?, order_status = ?, updated_at = now() WHERE id = ?",
      [payment_status, order_status, id],
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error updating payment status:", error);
    res.status(500).json({ message: "Failed to update payment status" });
  }
};

// GET /api/orders/:id/tracking
export const getOrderTracking = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;

    console.log("[DIAGNOSTIC] Schema Info:", {
      isNewOrderSchema,
      hasNewOrderItems: schemaInfo.hasNewOrderItems,
    });

    const orderQuery = isNewOrderSchema
      ? `SELECT o.id, o.user_id, o.order_status, o.payment_status, o.shipping_address,
           o.subtotal, o.shipping, o.tax, o.total, o.created_at,
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
         WHERE o.id = ? AND (o.user_id = ? OR o.user_id IS NULL)`
      : `SELECT o.id, o.user_id, o.order_status, o.payment_status, o.shipping_address,
           o.subtotal, o.shipping, o.tax, o.total, o.created_at,
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
         WHERE o.id = ? AND (o.user_id = ? OR o.user_id IS NULL)`;

    console.log(
      "[DIAGNOSTIC] Using schema:",
      isNewOrderSchema ? "NEW" : "LEGACY",
    );
    console.log(
      "[DIAGNOSTIC] SQL Query (first 200 chars):",
      orderQuery.substring(0, 200) + "...",
    );

    const { rows: orderRows } = await query(orderQuery, [id, userId]);

    if (!orderRows.length) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = orderRows[0];

    console.log("Tracking order id:", id);
    console.log("ORDER ROW:", order);
    console.log(
      "[DIAGNOSTIC] Raw orderRows[0]:",
      JSON.stringify(order, null, 2),
    );
    console.log("[DIAGNOSTIC] orderRows[0].created_at:", order.created_at);
    console.log("[DIAGNOSTIC] orderRows[0] keys:", Object.keys(order));
    console.log("Order ID:", order.id);

    // Ensure we include product_image and subtotal in the tracking API
    const { rows: orderItems } = await query(
      `
SELECT
  id,
  product_name,
  product_image,
  product_price,
  quantity,
  subtotal
FROM order_items
WHERE order_id = ?
`,
      [order.id],
    );

    console.log("ORDER ITEMS RAW:", orderItems);

    const { rows: historyRows } = await query(
      `SELECT id, previous_status, new_status, changed_by, notes, created_at
       FROM order_status_history
       WHERE order_id = ?
       ORDER BY created_at ASC`,
      [order.id],
    );

    const resolvedShippingAddress =
      order.shipping_address ||
      [
        order.ua_full_name,
        order.ua_address_line_1,
        order.ua_address_line_2,
        order.ua_city,
        order.ua_state,
        order.ua_pincode,
        order.ua_country,
      ]
        .filter(Boolean)
        .join(", ") ||
      [
        order.la_label,
        order.la_address_line1,
        order.la_address_line2,
        order.la_city,
        order.la_state,
        order.la_pincode,
        order.la_country,
      ]
        .filter(Boolean)
        .join(", ");

    const responseOrder = {
      ...order,
      shipping_address: resolvedShippingAddress,
      items: orderItems,
    };

    console.log("RESPONSE ORDER:", responseOrder);
    console.log("[DIAGNOSTIC] responseOrder after spread:", {
      id: responseOrder.id,
      created_at: responseOrder.created_at,
      user_id: responseOrder.user_id,
      order_status: responseOrder.order_status,
    });
    console.log("ORDER CREATED_AT:", responseOrder.created_at);
    console.log("ORDER RESPONSE:", responseOrder);

    console.log(
      "[TRACKING API]",
      JSON.stringify(
        {
          order: responseOrder,
          items: orderItems,
          history: historyRows,
        },
        null,
        2,
      ),
    );

    console.log("FINAL ITEMS SENT");
    console.log(JSON.stringify(orderItems, null, 2));

    console.log("FIRST ITEM");
    console.log(orderItems[0]);

    const finalResponse = {
      success: true,
      order: responseOrder,
      items: orderItems,
      history: historyRows,
    };

    console.log("\n📤 FINAL API RESPONSE (to send to client):");
    console.log(JSON.stringify(finalResponse, null, 2));
    console.log(
      "✅ Response includes order.created_at:",
      !!finalResponse.order.created_at,
    );

    res.json(finalResponse);
  } catch (error) {
    console.error("Error fetching order tracking:", error);
    res.status(500).json({ message: "Failed to fetch tracking info" });
  }
};
