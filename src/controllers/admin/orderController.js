import { query } from "../../config/database.js";
import { getOrderSchemaInfo } from "../../utils/orderSchema.js";
import {
  VALID_ORDER_STATUSES,
  VALID_PAYMENT_STATUSES,
  normalizeOrderStatus,
  DISPATCH_STATUSES,
} from "../../constants/orderStatus.js";
import {
  sendOrderStatusUpdateEmail,
  sendOrderDeliveredEmail,
  sendOrderCancelledEmail,
} from "../../services/orderEmailService.js";

const VALID_SORTS = ["created_at", "amount", "customer_name", "order_status"];

// GET /api/admin/orders
export const getOrders = async (req, res) => {
  const {
    search = "",
    page = 1,
    limit = 10,
    sort = "created_at",
    dir = "desc",
    order_status = "all",
    date = "all",
  } = req.query;

  const safeSort = VALID_SORTS.includes(sort) ? sort : "created_at";
  const safeDir = dir === "asc" ? "ASC" : "DESC";
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const schemaInfo = await getOrderSchemaInfo();
  const customerNameExpr = schemaInfo.isNewOrderSchema
    ? "o.contact_name"
    : "o.customer_name";
  const emailExpr = schemaInfo.isNewOrderSchema ? "o.contact_email" : "o.email";
  const phoneExpr = schemaInfo.isNewOrderSchema
    ? "o.contact_phone"
    : "o.mobile_number";
  // Prefer `total` (new schema) but fall back to legacy `amount` if present
  const amountExpr = "COALESCE(o.total, o.amount)";
  const transactionExpr = schemaInfo.isNewOrderSchema
    ? "o.razorpay_payment_id"
    : "o.transaction_id";
  const shippingAddressExpr = schemaInfo.isNewOrderSchema
    ? "COALESCE(o.address_id, '')"
    : "COALESCE(o.shipping_address, '')";
  const notesExpr = schemaInfo.hasOrderNotes ? "o.notes" : "''";
  // After MySQL migration, `order_items` uses `product_name`/`product_price`.
  // Use those columns to avoid referencing legacy `name`/`price` which no longer exist.
  const itemNameExpr = "oi.product_name";
  const itemPriceExpr = "oi.product_price";

  const sortExpressions = {
    created_at: "o.created_at",
    amount: amountExpr,
    customer_name: customerNameExpr,
    order_status: "o.order_status",
  };

  const conditions = [];
  const params = [];
  let idx = 1;

  if (search) {
    conditions.push(`(
      ${customerNameExpr} LIKE ? OR
      ${emailExpr} LIKE ? OR
      ${phoneExpr} LIKE ? OR
      o.id LIKE ?
    )`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    idx += 4;
  }

  if (order_status !== "all" && VALID_ORDER_STATUSES.includes(order_status)) {
    if (order_status === "dispatched") {
      conditions.push(`o.order_status IN ('${DISPATCH_STATUSES.join("','")}')`);
    } else {
      conditions.push(`o.order_status = ?`);
      params.push(order_status);
    }
  }

  if (date !== "all") {
    const days = { today: 0, "7days": 7, "30days": 30, "90days": 90 }[date];
    if (days !== undefined) {
      const since = new Date();
      if (days === 0) since.setHours(0, 0, 0, 0);
      else since.setDate(since.getDate() - days);
      conditions.push(`o.created_at >= ?`);
      params.push(since.toISOString());
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sortColumn = sortExpressions[safeSort] || "o.created_at";

  // Use a subquery for items so the outer query needs no GROUP BY and is
  // fully compatible with MySQL's ONLY_FULL_GROUP_BY mode. The subquery
  // also avoids the JSON_ARRAYAGG([null]) problem that occurs when a LEFT
  // JOIN finds no matching order_items rows.
  const itemsSubquery = `(
    SELECT COALESCE(
      JSON_ARRAYAGG(JSON_OBJECT(
        'id',       oi2.id,
        'name',     ${itemNameExpr.replace(/\boi\b/g, "oi2")},
        'quantity', oi2.quantity,
        'price',    ${itemPriceExpr.replace(/\boi\b/g, "oi2")}
      )),
      JSON_ARRAY()
    )
    FROM order_items oi2
    WHERE oi2.order_id = o.id
  )`;

  const firstItemSubquery = `(
    SELECT ${itemNameExpr.replace(/\boi\b/g, "oi3")}
    FROM order_items oi3
    WHERE oi3.order_id = o.id
    ORDER BY oi3.created_at ASC
    LIMIT 1
  )`;

  const ordersSql = `SELECT o.id,
              ${customerNameExpr} AS customer_name,
              ${emailExpr}        AS email,
              ${phoneExpr}        AS mobile_number,
              ${shippingAddressExpr} AS shipping_address,
              ${amountExpr}       AS amount,
              o.order_status,
              o.payment_status,
              ${transactionExpr}  AS transaction_id,
              ${notesExpr}        AS notes,
              o.created_at,
              COALESCE(${firstItemSubquery}, '') AS product_name,
              ${itemsSubquery}                    AS items
       FROM orders o
       ${where}
       ORDER BY ${sortColumn} ${safeDir}
       LIMIT ? OFFSET ?`;

  const [ordersRes, countRes] = await Promise.all([
    query(ordersSql, [...params, parseInt(limit, 10), offset]),
    query(`SELECT COUNT(*) AS total FROM orders o ${where}`, params),
  ]);

  res.json({
    orders: ordersRes.rows,
    total: countRes.rows[0].total,
    page: parseInt(page, 10),
    totalPages: Math.ceil(countRes.rows[0].total / parseInt(limit, 10)),
  });
};

// GET /api/admin/orders/:id
export const getOrder = async (req, res) => {
  const schemaInfo = await getOrderSchemaInfo();
  const customerNameExpr = schemaInfo.isNewOrderSchema
    ? "o.contact_name"
    : "o.customer_name";
  const emailExpr = schemaInfo.isNewOrderSchema ? "o.contact_email" : "o.email";
  const phoneExpr = schemaInfo.isNewOrderSchema
    ? "o.contact_phone"
    : "o.mobile_number";
  // Prefer `total` (new schema) but fall back to legacy `amount` if present
  const amountExpr = "COALESCE(o.total, o.amount)";
  const transactionExpr = schemaInfo.isNewOrderSchema
    ? "o.razorpay_payment_id"
    : "o.transaction_id";
  const notesExpr = schemaInfo.hasOrderNotes ? "o.notes" : "''";
  // Use new product_name/product_price in detail query as well.
  const itemNameExpr = "oi.product_name";
  const itemPriceExpr = "oi.product_price";

  const itemsSubqueryDetail = `(
    SELECT COALESCE(
      JSON_ARRAYAGG(JSON_OBJECT(
        'id',         oi2.id,
        'name',       ${itemNameExpr.replace(/\boi\b/g, "oi2")},
        'quantity',   oi2.quantity,
        'price',      ${itemPriceExpr.replace(/\boi\b/g, "oi2")},
        'product_id', oi2.product_id
      )),
      JSON_ARRAY()
    )
    FROM order_items oi2
    WHERE oi2.order_id = o.id
  )`;

  const firstItemSubqueryDetail = `(
    SELECT ${itemNameExpr.replace(/\boi\b/g, "oi3")}
    FROM order_items oi3
    WHERE oi3.order_id = o.id
    ORDER BY oi3.created_at ASC
    LIMIT 1
  )`;

  const { rows } = await query(
    `SELECT o.id,
            ${customerNameExpr}         AS customer_name,
            ${emailExpr}                AS email,
            ${phoneExpr}                AS mobile_number,
            ${amountExpr}               AS amount,
            o.order_status,
            o.payment_status,
            ${transactionExpr}          AS transaction_id,
            ${notesExpr}                AS notes,
            o.created_at,
            COALESCE(${firstItemSubqueryDetail}, '') AS product_name,
            ${itemsSubqueryDetail}                    AS items
     FROM orders o
     WHERE o.id = ?`,
    [req.params.id],
  );

  if (!rows.length) return res.status(404).json({ message: "Order not found" });
  res.json(rows[0]);
};

// PATCH /api/admin/orders/:id/status
export const updateOrderStatus = async (req, res) => {
  const { status, paymentStatus, notes } = req.body;
  const schemaInfo = await getOrderSchemaInfo();
  // Use transaction so we can insert history + emit consistently
  const client = await (await import("../../config/database.js")).getClient();
  try {
    await client.query("BEGIN");

    const { rows: found } = await client.query(
      "SELECT * FROM orders WHERE id = ? FOR UPDATE",
      [req.params.id],
    );
    if (!found.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Order not found" });
    }

    const order = found[0];
    const updates = [];
    const params = [];

    // Strict lifecycle enforcement
    const ORDER_STEPS = [
      "pending",
      "confirmed",
      "processing",
      "dispatched",
      "delivered",
    ];
    const idxOf = (s) => ORDER_STEPS.indexOf(normalizeOrderStatus(s));

    if (status) {
      if (!VALID_ORDER_STATUSES.includes(status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `Invalid status "${status}"` });
      }
      // Validate transition
      const prev = normalizeOrderStatus(order.order_status);
      const next = normalizeOrderStatus(status);
      const prevIdx = idxOf(prev);
      const nextIdx = idxOf(next);
      // Allow cancellation from any non-delivered state
      if (next === "cancelled") {
        if (prev === "delivered") {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ message: "Cannot cancel a delivered order" });
        }
      } else {
        // Enforce sequential progression (nextIdx === prevIdx + 1) or idempotent (same)
        if (!(nextIdx === prevIdx + 1 || nextIdx === prevIdx)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: `Invalid status transition from ${prev} to ${next}`,
          });
        }
      }

      updates.push(`order_status = ?`);
      params.push(status);
    }

    if (paymentStatus) {
      if (!VALID_PAYMENT_STATUSES.includes(paymentStatus)) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: `Invalid payment status "${paymentStatus}"` });
      }
      updates.push(`payment_status = ?`);
      params.push(paymentStatus);
    }

    if (notes !== undefined && schemaInfo.hasOrderNotes) {
      updates.push(`notes = ?`);
      params.push(notes);
    }

    if (!updates.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No fields to update" });
    }

    // always update updated_at
    updates.push("updated_at = CURRENT_TIMESTAMP");

    params.push(req.params.id);
    await client.query(
      `UPDATE orders SET ${updates.join(", ")} WHERE id = ?`,
      params,
    );
    const {
      rows: [updated],
    } = await client.query(`SELECT * FROM orders WHERE id = ? LIMIT 1`, [
      req.params.id,
    ]);

    // Insert into history table if status changed
    if (status && order.order_status !== status) {
      await client.query(
        `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes) VALUES (?, ?, ?, ?, ?)`,
        [
          req.params.id,
          order.order_status,
          status,
          req.user?.id || null,
          notes || null,
        ],
      );
    }

    await client.query("COMMIT");

    const recipientEmail = updated.contact_email || updated.email;
    const recipientName =
      updated.contact_name || updated.customer_name || "Customer";
    if (status && status !== "pending" && recipientEmail) {
      const emailPromise = (() => {
        if (status === "delivered") {
          return sendOrderDeliveredEmail({
            to: recipientEmail,
            name: recipientName,
            orderId: updated.id,
          });
        }

        if (status === "cancelled") {
          return sendOrderCancelledEmail({
            to: recipientEmail,
            name: recipientName,
            orderId: updated.id,
            notes,
          });
        }

        return sendOrderStatusUpdateEmail({
          to: recipientEmail,
          name: recipientName,
          orderId: updated.id,
          status,
          notes,
        });
      })();

      emailPromise.catch((error) => {
        console.warn("Order status email failed", error?.message || error);
      });
    }

    // Emit socket event (best-effort)
    try {
      const io = req.app?.locals?.io;
      if (io) io.emit("order:updated", updated);
    } catch (e) {
      // ignore socket errors
    }

    res.json({ success: true, message: "Order updated", order: updated });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Failed to update order" });
  } finally {
    client.release();
  }
};

// PATCH /api/admin/orders/bulk-status
export const bulkUpdateStatus = async (req, res) => {
  const { ids, status } = req.body;

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: "ids must be a non-empty array" });
  }
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ message: `Invalid status "${status}"` });
  }

  // Perform transactional bulk update and return list of updated orders
  const client = await (await import("../../config/database.js")).getClient();
  try {
    await client.query("BEGIN");

    // Lock matching rows
    const placeholders = ids.map(() => "?").join(",");
    const selectSql = `SELECT * FROM orders WHERE id IN (${placeholders}) FOR UPDATE`;
    const { rows: found } = await client.query(selectSql, ids);
    if (!found.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No matching orders found" });
    }

    // Validate transitions for all orders
    const ORDER_STEPS = ["pending", "confirmed", "dispatched", "delivered"];
    const idxOf = (s) => ORDER_STEPS.indexOf(normalizeOrderStatus(s));
    for (const o of found) {
      const prev = normalizeOrderStatus(o.order_status);
      const next = normalizeOrderStatus(status);
      const prevIdx = idxOf(prev);
      const nextIdx = idxOf(next);
      if (next === "cancelled") {
        if (prev === "delivered") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: `Order ${o.id} cannot be cancelled after delivery`,
          });
        }
      } else {
        if (!(nextIdx === prevIdx + 1 || nextIdx === prevIdx)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: `Invalid transition for order ${o.id} from ${prev} to ${next}`,
          });
        }
      }
    }

    // Update rows
    await client.query(
      `UPDATE orders SET order_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      [status, ...ids],
    );

    const { rows: updated } = await client.query(
      `SELECT * FROM orders WHERE id IN (${placeholders})`,
      ids,
    );

    // Insert history rows
    const historyStmt = `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by) VALUES `;
    const historyValues = [];
    const historyParams = [];
    for (const o of found) {
      historyParams.push(o.id, o.order_status, status, req.user?.id || null);
      historyValues.push("(?, ?, ?, ?)");
    }
    if (historyValues.length) {
      await client.query(historyStmt + historyValues.join(", "), historyParams);
    }

    await client.query("COMMIT");

    if (status && status !== "pending") {
      const emailPromises = updated.map((orderItem) => {
        const recipientEmail = orderItem.contact_email || orderItem.email;
        const recipientName =
          orderItem.contact_name || orderItem.customer_name || "Customer";
        if (!recipientEmail) return Promise.resolve();

        if (status === "delivered") {
          return sendOrderDeliveredEmail({
            to: recipientEmail,
            name: recipientName,
            orderId: orderItem.id,
          });
        }

        if (status === "cancelled") {
          return sendOrderCancelledEmail({
            to: recipientEmail,
            name: recipientName,
            orderId: orderItem.id,
          });
        }

        return sendOrderStatusUpdateEmail({
          to: recipientEmail,
          name: recipientName,
          orderId: orderItem.id,
          status,
        });
      });

      Promise.allSettled(emailPromises).catch(() => {});
    }

    // Emit events for each updated order
    try {
      const io = req.app?.locals?.io;
      if (io) {
        updated.forEach((u) => io.emit("order:updated", u));
      }
    } catch (e) {
      // ignore socket errors
    }

    res.json({
      success: true,
      message: `${updated.length} order(s) updated`,
      orders: updated,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error in bulk update:", err);
    res.status(500).json({ message: "Bulk update failed" });
  } finally {
    client.release();
  }
};
