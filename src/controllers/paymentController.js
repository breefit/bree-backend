import { getRazorpay } from "../config/razorpay.js";
import {
  verifyPaymentSignature,
  verifyWebhookSignature,
} from "../utils/razorpay.js";
import { query, getClient } from "../config/database.js";
import { sendOrderConfirmationEmail } from "../services/orderEmailService.js";

// POST /api/payment/create-order
export const createOrder = async (req, res) => {
  const { amount, items, customerName, email, mobileNumber, shippingAddress } =
    req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Cart is empty" });
  }

  if (!customerName || !email || !mobileNumber || !shippingAddress) {
    return res
      .status(400)
      .json({ message: "Missing customer or shipping details" });
  }

  const validatedItems = [];
  let serverTotal = 0;

  for (const item of items) {
    const productId = item.product_id || item.productId;
    const quantity = Number(item.quantity ?? item.qty ?? 0);

    if (!productId || quantity <= 0) {
      return res.status(400).json({ message: "Invalid cart item submitted" });
    }

    const { rows } = await query(
      "SELECT id, name, image, price AS price, stock_qty FROM products WHERE id = ? AND is_active = 1 AND status = 'In Stock'",
      [productId],
    );

    if (!rows.length) {
      return res
        .status(400)
        .json({ message: `Product ${productId} not found` });
    }

    const product = rows[0];

    if (product.stock_qty < quantity) {
      return res
        .status(400)
        .json({ message: `Insufficient stock for "${product.name}"` });
    }

    const itemPrice = Number(product.price);
    const itemTotal = itemPrice * quantity;
    serverTotal += itemTotal;

    const validatedItem = {
      product_id: product.id,
      name: product.name,
      image: product.image || null,
      quantity,
      price: itemPrice,
    };

    validatedItems.push(validatedItem);
  }

  if (Math.abs(serverTotal - Number(amount)) > 1) {
    return res
      .status(400)
      .json({ message: "Price mismatch — please refresh and try again." });
  }

  const rzp = getRazorpay();
  const rzpOrder = await rzp.orders.create({
    amount: Math.round(serverTotal * 100),
    currency: "INR",
    receipt: `bree_${Date.now()}`,
  });

  const client = await getClient();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orders
         (user_id, contact_name, contact_email, contact_phone,
          subtotal, total, order_status, payment_status, razorpay_order_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)`,
      [
        req.user?.id || null,
        customerName || req.user?.name || "Guest",
        email || req.user?.email || "",
        mobileNumber || "",
        serverTotal,
        serverTotal,
        rzpOrder.id,
      ],
    );

    const { rows: orderRows } = await client.query(
      `SELECT id FROM orders WHERE razorpay_order_id = ? LIMIT 1`,
      [rzpOrder.id],
    );
    const orderId = orderRows[0]?.id;

    for (const item of validatedItems) {
      const insertValues = [
        orderId,
        item.product_id,
        item.name,
        item.image || null,
        item.price,
        item.quantity,
        item.price * item.quantity,
      ];

      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, product_image, product_price, quantity, subtotal)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        insertValues,
      );
    }

    await client.query(
      `INSERT INTO payments (order_id, razorpay_order_id, amount, status)
       VALUES (?, ?, ?, 'created')`,
      [orderId, rzpOrder.id, serverTotal],
    );
    await client.query(
      `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [
        orderId,
        null,
        "pending",
        req.user?.id || null,
        "Order created via payment.create-order",
      ],
    );

    await client.query("COMMIT");

    try {
      const io = req.app?.locals?.io;
      if (io)
        io.emit("order:updated", { id: orderId, order_status: "pending" });
    } catch (e) {}

    res.json({
      razorpay_order_id: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      order_db_id: orderId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// POST /api/payment/verify
export const verifyPayment = async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ message: "Missing payment fields" });
  }

  // ── CRITICAL: Verify HMAC signature ─────────────────────────────────────
  const isValid = verifyPaymentSignature({
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  });
  if (!isValid) {
    console.warn("Payment verification failed: invalid signature", {
      razorpay_order_id,
      razorpay_payment_id,
    });
    return res.status(400).json({ message: "Invalid payment signature" });
  }

  const { rows: existingPaymentRows } = await query(
    "SELECT * FROM orders WHERE razorpay_payment_id = ?",
    [razorpay_payment_id],
  );

  if (existingPaymentRows.length) {
    const existingOrder = existingPaymentRows[0];
    console.info("Duplicate verify blocked: payment already processed", {
      orderId: existingOrder.id,
      razorpay_payment_id,
    });

    return res.json({
      success: true,
      order_id: existingOrder.id,
      payment_id: razorpay_payment_id,
      message: "Payment already processed",
    });
  }

  const { rows: orderRows } = await query(
    "SELECT * FROM orders WHERE razorpay_order_id = ?",
    [razorpay_order_id],
  );

  if (!orderRows.length) {
    console.warn("Order not found for Razorpay order", { razorpay_order_id });
    return res.status(404).json({ message: "Order not found" });
  }

  const order = orderRows[0];

  // Ensure we have a reliable numeric total for legacy and new schemas
  const dbTotal = order.total ?? order.amount ?? 0;

  if (order.payment_status === "paid") {
    if (order.razorpay_payment_id === razorpay_payment_id) {
      console.info("Duplicate verify blocked: order already paid", {
        orderId: order.id,
        razorpay_payment_id,
      });
      return res.json({
        success: true,
        order_id: order.id,
        payment_id: razorpay_payment_id,
        message: "Order already paid",
      });
    }

    console.warn("Payment already marked as paid with a different payment id", {
      orderId: order.id,
      existingPaymentId: order.razorpay_payment_id,
      newPaymentId: razorpay_payment_id,
    });
    return res.status(409).json({
      message: "Order already processed with a different payment id",
    });
  }

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
      console.info(
        "Duplicate verify blocked inside transaction: already paid",
        {
          orderId: lockedOrder.id,
        },
      );
      return res.json({
        success: true,
        order_id: lockedOrder.id,
        payment_id: lockedOrder.razorpay_payment_id || razorpay_payment_id,
        message: "Order already paid",
      });
    }

    await client.query(
      `UPDATE orders SET payment_status='paid', order_status='confirmed',
          transaction_id = ?, razorpay_payment_id = ?, updated_at = now(), paid_at = now() WHERE id = ?`,
      [razorpay_payment_id, razorpay_payment_id, order.id],
    );

    const paymentUpdate = await client.query(
      `UPDATE payments SET razorpay_payment_id = ?, razorpay_signature = ?,
          status = 'captured', updated_at = now() WHERE razorpay_order_id = ?`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id],
    );

    if (paymentUpdate.rowCount === 0) {
      console.info(
        "No existing payment row found. Inserting fallback payment record.",
        {
          orderId: order.id,
          razorpay_order_id,
          razorpay_payment_id,
        },
      );
      await client.query(
        `INSERT INTO payments (order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount, currency, status)
         VALUES (?, ?, ?, ?, ?, 'INR', 'captured')`,
        [
          order.id,
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature,
          dbTotal,
        ],
      );
    }

    const { rows: items } = await client.query(
      "SELECT product_id, quantity FROM order_items WHERE order_id = ?",
      [order.id],
    );

    for (const item of items) {
      const stockResult = await client.query(
        "UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?",
        [item.quantity, item.product_id, item.quantity],
      );

      if (!stockResult.rowCount) {
        await client.query("ROLLBACK");
        console.warn("Stock update failed during payment verification", {
          orderId: order.id,
          productId: item.product_id,
          quantity: item.quantity,
        });
        return res.status(400).json({
          message:
            "Unable to finalize the order because one or more products are out of stock. Please contact support.",
        });
      }

      console.info("Stock updated for order item", {
        orderId: order.id,
        productId: item.product_id,
        quantity: item.quantity,
      });
    }

    await client.query(
      `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [order.id, order.order_status, "confirmed", null, "Payment captured"],
    );

    await client.query("COMMIT");

    console.info("Order finalized successfully", {
      orderId: order.id,
      razorpay_payment_id,
    });

    try {
      const io = req.app?.locals?.io;
      if (io)
        io.emit("order:updated", { id: order.id, order_status: "confirmed" });
    } catch (e) {}
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error during payment verify transaction", err);
    throw err;
  } finally {
    client.release();
  }

  const { rows: itemRows } = await query(
    "SELECT product_name AS name, quantity, product_price AS price, subtotal FROM order_items WHERE order_id = ?",
    [order.id],
  );
  sendOrderConfirmationEmail({
    to: order.contact_email,
    name: order.contact_name,
    orderId: order.id,
    amount: dbTotal,
    items: itemRows,
  }).catch(() => {});

  res.json({
    success: true,
    order_id: order.id,
    payment_id: razorpay_payment_id,
  });
};

// GET /api/payment/status/:paymentId
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
     FROM order_items
     WHERE order_id = ?`,
    [order.order_id],
  );

  const quantity =
    items.reduce((sum, item) => sum + (item.quantity || 0), 0) || 1;
  const metadata = {
    product_name: items[0]?.name || "BREE Wellness Shot",
    quantity,
  };

  res.json({
    payment_status: order.payment_status,
    status: order.payment_status === "paid" ? "paid" : "pending",
    amount_total: Math.round(Number(order.total ?? order.amount ?? 0) * 100),
    metadata,
    order_id: order.order_id,
    customer_name: order.contact_name,
    email: order.contact_email,
    mobile_number: order.contact_phone,
  });
};

// POST /api/payment/webhook  — Razorpay async events
export const handleWebhook = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  // Prefer the preserved raw body set by the raw middleware; fall back to
  // the stringified parsed body if not available (defensive).
  const raw = req.rawBody ?? (req.body ? JSON.stringify(req.body) : "");
  if (!verifyWebhookSignature(raw, signature)) {
    return res.status(400).json({ message: "Invalid webhook signature" });
  }

  const { event, payload } = req.body;

  if (event === "payment.failed") {
    const rzpOrderId = payload.payment?.entity?.order_id;
    if (rzpOrderId) {
      await query(
        `UPDATE orders SET payment_status='failed', updated_at=now()
         WHERE razorpay_order_id = ?`,
        [rzpOrderId],
      );
      try {
        const { rows } = await query(
          "SELECT id, order_status FROM orders WHERE razorpay_order_id = ?",
          [rzpOrderId],
        );
        if (rows[0]) {
          await query(
            `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes) VALUES (?, ?, ?, ?, ?)`,
            [
              rows[0].id,
              rows[0].order_status,
              "payment_failed",
              null,
              "Payment failed (webhook)",
            ],
          );
          try {
            const io = req.app?.locals?.io;
            if (io)
              io.emit("order:updated", {
                id: rows[0].id,
                order_status: "payment_failed",
              });
          } catch (e) {}
        }
      } catch (e) {
        console.warn("Webhook history insert error", e);
      }
    }
  }

  res.json({ status: "ok" });
};
