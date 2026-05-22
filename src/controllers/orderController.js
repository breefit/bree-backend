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
        `SELECT id, name, price::float, stock_qty, is_active, status
         FROM products
         WHERE id = $1`,
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
      "SELECT id FROM users WHERE id = $1 LIMIT 1",
      [userId],
    );
    if (!userRows.length) {
      await client.query("ROLLBACK");
      return res.status(401).json({ message: "User not found" });
    }

    const { rows: addressRows } = await client.query(
      `SELECT id, full_name, phone, address_line_1, address_line_2, city, state, pincode, country
       FROM user_addresses
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [addressId, userId],
    );

    let address = addressRows[0];
    let addressFromLegacy = false;
    if (!address) {
      const { rows: fallbackRows } = await client.query(
        `SELECT id, label, line1, line2, city, state, pincode, country
         FROM addresses
         WHERE id = $1 AND user_id = $2
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

      const { rows: prodRows } = await client.query(
        `SELECT id, name, image, price::float AS price, mrp::float AS mrp, quantity AS pack_size, stock_qty, is_active, status
         FROM products
         WHERE id = $1
         LIMIT 1`,
        [productId],
      );

      if (
        !prodRows.length ||
        !prodRows[0].is_active ||
        prodRows[0].status !== "In Stock"
      ) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Product ${productId} not available` });
      }

      const product = prodRows[0];
      if (product.stock_qty < quantity) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Insufficient stock for ${product.name}` });
      }

      const itemSubtotal = parseFloat(product.price) * quantity;
      calculatedSubtotal += itemSubtotal;

      orderItems.push({
        productId: product.id,
        productName: product.name,
        productImage: product.image,
        productPrice: parseFloat(product.price),
        productMrp: product.mrp ? parseFloat(product.mrp) : null,
        productQuantityPack: product.pack_size,
        quantity,
        subtotal: itemSubtotal,
      });
    }

    const shippingCost = Number(shipping ?? 0);
    const taxCost = Number(tax ?? 0);
    const calculatedTotal =
      parseFloat(calculatedSubtotal) + shippingCost + taxCost;

    let order;
    if (isNewOrderSchema) {
      // If the selected address came from the legacy `addresses` table (text id),
      // insert it into `user_addresses` (uuid id) so it can be referenced by orders.address_id
      let finalAddressId = addressId;
      if (addressFromLegacy) {
        const insertAddr = `INSERT INTO user_addresses (user_id, full_name, phone, address_line_1, address_line_2, city, state, pincode, country, is_default)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false) RETURNING id`;
        const { rows: newAddrRows } = await client.query(insertAddr, [
          userId,
          contactName || null,
          contactPhone || null,
          address.line1 || null,
          address.line2 || null,
          address.city || null,
          address.state || null,
          address.pincode || null,
          address.country || "India",
        ]);
        finalAddressId = newAddrRows[0].id;
      }

      const insertOrder = `INSERT INTO orders (user_id, address_id, contact_email, contact_phone, contact_name, subtotal, shipping, tax, total, payment_status, order_status)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','pending') RETURNING *`;
      const { rows: createdOrderRows } = await client.query(insertOrder, [
        userId,
        finalAddressId,
        contactEmail,
        contactPhone,
        contactName,
        calculatedSubtotal,
        shippingCost,
        taxCost,
        calculatedTotal,
      ]);
      order = createdOrderRows[0];
    } else {
      const shippingAddress = formatAddressSnapshot(address);
      const insertOrder = `INSERT INTO orders (user_id, customer_name, email, mobile_number, shipping_address, amount, payment_status, order_status)
                           VALUES ($1,$2,$3,$4,$5,$6,'pending','pending') RETURNING *`;
      const { rows: createdOrderRows } = await client.query(insertOrder, [
        userId,
        contactName,
        contactEmail,
        contactPhone,
        shippingAddress,
        calculatedTotal,
      ]);
      order = createdOrderRows[0];
    }

    for (const oi of orderItems) {
      if (hasNewOrderItems) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, product_image, product_price, product_mrp, product_quantity_pack, quantity, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            order.id,
            oi.productId,
            oi.productName,
            oi.productImage,
            oi.productPrice,
            oi.productMrp,
            oi.productQuantityPack,
            oi.quantity,
            oi.subtotal,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, name, quantity, price)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            order.id,
            oi.productId,
            oi.productName,
            oi.quantity,
            oi.productPrice,
          ],
        );
      }

      const { rowCount } = await client.query(
        "UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2 AND stock_qty >= $1",
        [oi.quantity, oi.productId],
      );

      if (!rowCount) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Failed to reserve stock for ${oi.productName}` });
      }
    }

    await client.query("COMMIT");

    // Append initial status history for tracking
    try {
      await client.query(
        `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, null, order.order_status, userId || null, "Order created"],
      );
    } catch (e) {
      // non-fatal if history insert fails
      console.warn(
        "Failed to insert order_status_history on create:",
        e?.message || e,
      );
    }

    // Emit realtime event for new order
    try {
      const io = req.app?.locals?.io;
      if (io)
        io.emit("order:updated", {
          id: order.id,
          order_status: order.order_status,
        });
    } catch (e) {}

    const orderResponse = {
      id: order.id,
      userId: order.user_id,
      contactName: isNewOrderSchema ? order.contact_name : order.customer_name,
      contactEmail: isNewOrderSchema ? order.contact_email : order.email,
      contactPhone: isNewOrderSchema
        ? order.contact_phone
        : order.mobile_number,
      addressId: isNewOrderSchema ? order.address_id : null,
      shippingAddress: isNewOrderSchema ? null : order.shipping_address,
      subtotal: isNewOrderSchema
        ? parseFloat(order.subtotal)
        : calculatedSubtotal,
      shipping: isNewOrderSchema ? parseFloat(order.shipping) : shippingCost,
      tax: isNewOrderSchema ? parseFloat(order.tax) : taxCost,
      total: isNewOrderSchema
        ? parseFloat(order.total)
        : parseFloat(order.amount ?? calculatedTotal),
      paymentStatus: order.payment_status,
      orderStatus: order.order_status,
      createdAt: order.created_at,
      items: orderItems,
    };

    return res.status(201).json({
      orderId: order.id,
      order: orderResponse,
      message: "Order created successfully",
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (e) {
      // ignore rollback errors
    }

    console.error("Error creating order:", err);
    return res
      .status(500)
      .json({ message: "Failed to create order", error: err.message });
  } finally {
    client.release();
  }
};

// ========================================
// GET ORDER DETAILS
// ========================================
export const getOrder = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;
    const useNewOrderItems = schemaInfo.hasNewOrderItems;

    const orderQuery = isNewOrderSchema
      ? `SELECT id, user_id, contact_email, contact_phone, contact_name,
                 subtotal, shipping, tax, total, payment_status, order_status,
                 razorpay_order_id, razorpay_payment_id, created_at, updated_at
         FROM orders
         WHERE id = $1 AND user_id = $2`
      : `SELECT id, user_id, email AS contact_email, mobile_number AS contact_phone,
                 customer_name AS contact_name, amount AS total, payment_status,
                 order_status, razorpay_order_id, created_at, updated_at
         FROM orders
         WHERE id = $1 AND user_id = $2`;
    const { rows: orderRows } = await query(orderQuery, [id, userId]);
    if (!orderRows.length) {
      return res.status(404).json({ message: "Order not found" });
    }

    const itemQuery = useNewOrderItems
      ? `SELECT id, product_id, product_name AS name, product_image, product_price AS price,
                 product_mrp AS mrp, product_quantity_pack AS quantity_pack, quantity, subtotal
         FROM order_items
         WHERE order_id = $1`
      : `SELECT id, product_id, name AS product_name, NULL::text AS product_image,
                 price::float AS product_price, NULL::numeric AS product_mrp,
                 NULL::int AS product_quantity_pack, quantity, (price * quantity)::float AS subtotal
         FROM order_items
         WHERE order_id = $1`;

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
// GET USER ORDERS (EXISTING - KEPT FOR COMPATIBILITY)
// ========================================
export const getMyOrders = async (req, res) => {
  try {
    const schemaInfo = await getOrderSchemaInfo();
    const isNewOrderSchema = schemaInfo.isNewOrderSchema;

    const orderQuery = isNewOrderSchema
      ? `SELECT id, user_id, contact_name AS contact_name, total AS total,
                 payment_status, order_status, created_at
         FROM orders
         WHERE user_id = $1
         ORDER BY created_at DESC`
      : `SELECT id, user_id, customer_name AS contact_name, amount AS total,
                 payment_status, order_status, created_at
         FROM orders
         WHERE user_id = $1
         ORDER BY created_at DESC`;

    const { rows } = await query(orderQuery, [req.user.id]);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching user orders:", error);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// GET /api/orders/:id/tracking
export const getOrderTracking = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    // Ensure user owns the order
    const { rows: orderRows } = await query(
      "SELECT id, user_id, contact_name AS customer_name, contact_email AS email, contact_phone AS mobile_number, subtotal, shipping, tax, total, payment_status, order_status, created_at FROM orders WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    if (!orderRows.length)
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    const order = orderRows[0];

    // Fetch status history
    const { rows: historyRows } = await query(
      `SELECT id, previous_status, new_status, changed_by, notes, created_at
       FROM order_status_history
       WHERE order_id = $1
       ORDER BY created_at ASC`,
      [id],
    );

    // Normalize and build tracking timeline
    const mapStatus = (s) => {
      if (!s) return null;
      const lower = String(s).toLowerCase();
      if (lower === "pending") return "placed";
      if (lower === "confirmed") return "confirmed";
      if (
        ["processing", "shipped", "out_for_delivery", "dispatched"].includes(
          lower,
        )
      )
        return "dispatched";
      if (lower === "delivered") return "delivered";
      if (lower === "cancelled") return "cancelled";
      return lower;
    };

    const timelineKeys = [
      { key: "placed", label: "Order Placed" },
      { key: "confirmed", label: "Confirmed" },
      { key: "dispatched", label: "Dispatched" },
      { key: "delivered", label: "Delivered" },
    ];

    // Build a map of latest timestamp for each normalized status
    const statusTimestamps = {};
    for (const h of historyRows) {
      const norm = mapStatus(h.new_status || h.previous_status);
      if (!norm) continue;
      statusTimestamps[norm] = statusTimestamps[norm] || h.created_at;
    }
    // Ensure 'placed' exists from order.created_at
    statusTimestamps.placed = statusTimestamps.placed || order.created_at;

    const tracking = timelineKeys.map((step) => ({
      key: step.key,
      label: step.label,
      completed:
        !!statusTimestamps[step.key] && order.order_status !== "cancelled",
      timestamp: statusTimestamps[step.key] || null,
    }));

    // If order is cancelled, mark cancelled as special
    if (normalizeOrderStatus(order.order_status) === "cancelled") {
      tracking.push({
        key: "cancelled",
        label: "Order Cancelled",
        completed: true,
        timestamp: statusTimestamps.cancelled || null,
      });
    }

    order.status = normalizeOrderStatus(order.order_status);
    return res.json({ success: true, order, tracking, history: historyRows });
  } catch (err) {
    console.error("Error fetching tracking:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch tracking" });
  }
};

// ========================================
// UPDATE PAYMENT STATUS (FOR RAZORPAY INTEGRATION)
// ========================================
export const updatePaymentStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { paymentStatus, razorpayOrderId, razorpayPaymentId } = req.body;

    const { rows: orderRows } = await query(
      `SELECT id FROM orders WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (!orderRows.length) {
      return res.status(404).json({ message: "Order not found" });
    }

    const schemaInfo = await getOrderSchemaInfo();
    const paidAtClause = schemaInfo.orders.has("paid_at")
      ? `, paid_at = CASE WHEN $1 = 'paid' THEN NOW() ELSE paid_at END`
      : "";

    const { rows } = await query(
      `UPDATE orders
       SET payment_status = $1, razorpay_order_id = $2, razorpay_payment_id = $3${paidAtClause}
       WHERE id = $4
       RETURNING *`,
      [paymentStatus, razorpayOrderId, razorpayPaymentId, id],
    );

    // Emit socket event for updated order (best-effort)
    try {
      const io = req.app?.locals?.io;
      if (io && rows[0]) io.emit("order:updated", rows[0]);
    } catch (e) {
      // ignore socket errors
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Error updating payment status:", error);
    res.status(500).json({ message: "Failed to update payment status" });
  }
};
