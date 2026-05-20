import { query } from '../../config/database.js';
import { getOrderSchemaInfo } from '../../utils/orderSchema.js';

const VALID_STATUSES = ['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled'];
const VALID_SORTS    = ['created_at', 'amount', 'customer_name', 'order_status'];

const normalizeOrderStatus = (status) => {
  if (!status) return null;
  const lower = String(status).toLowerCase();
  if (['processing', 'shipped', 'out_for_delivery', 'dispatched'].includes(lower)) return 'dispatched';
  if (['pending', 'confirmed', 'delivered', 'cancelled'].includes(lower)) return lower;
  return lower;
};

// GET /api/admin/orders
export const getOrders = async (req, res) => {
  const {
    search       = '',
    page         = 1,
    limit        = 10,
    sort         = 'created_at',
    dir          = 'desc',
    order_status = 'all',
    date         = 'all',
  } = req.query;

  const safeSort = VALID_SORTS.includes(sort) ? sort : 'created_at';
  const safeDir  = dir === 'asc' ? 'ASC' : 'DESC';
  const offset   = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const schemaInfo = await getOrderSchemaInfo();
  const customerNameExpr = schemaInfo.isNewOrderSchema ? 'o.contact_name' : 'o.customer_name';
  const emailExpr = schemaInfo.isNewOrderSchema ? 'o.contact_email' : 'o.email';
  const phoneExpr = schemaInfo.isNewOrderSchema ? 'o.contact_phone' : 'o.mobile_number';
  const amountExpr = schemaInfo.isNewOrderSchema ? 'o.total' : 'o.amount';
  const transactionExpr = schemaInfo.isNewOrderSchema ? 'o.razorpay_payment_id' : 'o.transaction_id';
  const shippingAddressExpr = schemaInfo.isNewOrderSchema ? "COALESCE(o.address_id::text, '')" : "COALESCE(o.shipping_address, '')";
  const notesExpr = schemaInfo.hasOrderNotes ? 'o.notes' : "''";
  const itemNameExpr = schemaInfo.hasNewOrderItems ? 'oi.product_name' : 'oi.name';
  const itemPriceExpr = schemaInfo.hasNewOrderItems ? 'oi.product_price' : 'oi.price';

  const sortExpressions = {
    created_at: 'o.created_at',
    amount: amountExpr,
    customer_name: customerNameExpr,
    order_status: 'o.order_status',
  };

  const conditions = [];
  const params = [];
  let idx = 1;

  if (search) {
    conditions.push(`(
      ${customerNameExpr} ILIKE $${idx} OR
      ${emailExpr} ILIKE $${idx} OR
      ${phoneExpr} ILIKE $${idx} OR
      o.id::text ILIKE $${idx}
    )`);
    params.push(`%${search}%`);
    idx++;
  }

  if (order_status !== 'all' && VALID_STATUSES.includes(order_status)) {
    if (order_status === 'dispatched') {
      conditions.push(`o.order_status IN ('processing','shipped','out_for_delivery','dispatched')`);
    } else {
      conditions.push(`o.order_status = $${idx++}`);
      params.push(order_status);
    }
  }

  if (date !== 'all') {
    const days = { today: 0, '7days': 7, '30days': 30, '90days': 90 }[date];
    if (days !== undefined) {
      const since = new Date();
      if (days === 0) since.setHours(0, 0, 0, 0);
      else since.setDate(since.getDate() - days);
      conditions.push(`o.created_at >= $${idx++}`);
      params.push(since.toISOString());
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortColumn = sortExpressions[safeSort] || 'o.created_at';

  const [ordersRes, countRes] = await Promise.all([
    query(
      `SELECT o.id,
              ${customerNameExpr} AS customer_name,
              ${emailExpr} AS email,
              ${phoneExpr} AS mobile_number,
              ${shippingAddressExpr} AS shipping_address,
              ${amountExpr}::float AS amount,
              o.order_status,
              o.payment_status,
              ${transactionExpr} AS transaction_id,
              ${notesExpr} AS notes,
              o.created_at,
              COALESCE(MIN(${itemNameExpr}), '') AS product_name,
              COALESCE(json_agg(json_build_object(
                'id', oi.id,
                'name', ${itemNameExpr},
                'quantity', oi.quantity,
                'price', ${itemPriceExpr}::float
              ) ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       ${where}
       GROUP BY o.id
       ORDER BY ${sortColumn} ${safeDir}
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit, 10), offset],
    ),
    query(`SELECT COUNT(*)::int AS total FROM orders o ${where}`, params),
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
  const customerNameExpr = schemaInfo.isNewOrderSchema ? 'o.contact_name' : 'o.customer_name';
  const emailExpr = schemaInfo.isNewOrderSchema ? 'o.contact_email' : 'o.email';
  const phoneExpr = schemaInfo.isNewOrderSchema ? 'o.contact_phone' : 'o.mobile_number';
  const amountExpr = schemaInfo.isNewOrderSchema ? 'o.total' : 'o.amount';
  const transactionExpr = schemaInfo.isNewOrderSchema ? 'o.razorpay_payment_id' : 'o.transaction_id';
  const notesExpr = schemaInfo.hasOrderNotes ? 'o.notes' : "''";
  const itemNameExpr = schemaInfo.hasNewOrderItems ? 'oi.product_name' : 'oi.name';
  const itemPriceExpr = schemaInfo.hasNewOrderItems ? 'oi.product_price' : 'oi.price';

  const { rows } = await query(
    `SELECT o.id,
            ${customerNameExpr} AS customer_name,
            ${emailExpr} AS email,
            ${phoneExpr} AS mobile_number,
            ${amountExpr}::float AS amount,
            o.order_status,
            o.payment_status,
            ${transactionExpr} AS transaction_id,
            ${notesExpr} AS notes,
            o.created_at,
            COALESCE(MIN(${itemNameExpr}), '') AS product_name,
            COALESCE(json_agg(json_build_object(
              'id', oi.id,
              'name', ${itemNameExpr},
              'quantity', oi.quantity,
              'price', ${itemPriceExpr}::float,
              'product_id', oi.product_id
            ) ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) AS items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.id = $1
     GROUP BY o.id`,
    [req.params.id]
  );

  if (!rows.length) return res.status(404).json({ message: 'Order not found' });
  res.json(rows[0]);
};

// PATCH /api/admin/orders/:id/status
export const updateOrderStatus = async (req, res) => {
  const { status, paymentStatus, notes } = req.body;
  const schemaInfo = await getOrderSchemaInfo();
  // Use transaction so we can insert history + emit consistently
  const client = await (await import('../../config/database.js')).getClient();
  try {
    await client.query('BEGIN');

    const { rows: found } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!found.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Order not found' });
    }

    const order = found[0];
    const updates = [];
    const params = [];

    // Strict lifecycle enforcement
    const ORDER_STEPS = ['pending', 'confirmed', 'dispatched', 'delivered'];
    const idxOf = (s) => ORDER_STEPS.indexOf(normalizeOrderStatus(s));

    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: `Invalid status "${status}"` });
      }
      // Validate transition
      const prev = normalizeOrderStatus(order.order_status);
      const next = normalizeOrderStatus(status);
      const prevIdx = idxOf(prev);
      const nextIdx = idxOf(next);
      // Allow cancellation from any non-delivered state
      if (next === 'cancelled') {
        if (prev === 'delivered') {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: 'Cannot cancel a delivered order' });
        }
      } else {
        // Enforce sequential progression (nextIdx === prevIdx + 1) or idempotent (same)
        if (!(nextIdx === prevIdx + 1 || nextIdx === prevIdx)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: `Invalid status transition from ${prev} to ${next}` });
        }
      }

      updates.push(`order_status = $${params.length + 1}`);
      params.push(status);
    }

    if (paymentStatus) {
      const validPay = ['pending', 'paid', 'failed', 'refunded'];
      if (!validPay.includes(paymentStatus)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: `Invalid payment status "${paymentStatus}"` });
      }
      updates.push(`payment_status = $${params.length + 1}`);
      params.push(paymentStatus);
    }

    if (notes !== undefined && schemaInfo.hasOrderNotes) {
      updates.push(`notes = $${params.length + 1}`);
      params.push(notes);
    }

    if (!updates.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No fields to update' });
    }

    // always update updated_at
    updates.push('updated_at = now()');

    params.push(req.params.id);
    const { rows } = await client.query(`UPDATE orders SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    const updated = rows[0];

    // Insert into history table if status changed
    if (status && order.order_status !== status) {
      await client.query(
        `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes) VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, order.order_status, status, req.user?.id || null, notes || null],
      );
    }

    await client.query('COMMIT');

    // Emit socket event (best-effort)
    try {
      const io = req.app?.locals?.io;
      if (io) io.emit('order:updated', updated);
    } catch (e) {
      // ignore socket errors
    }

    res.json({ success: true, message: 'Order updated', order: updated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating order status:', err);
    res.status(500).json({ message: 'Failed to update order' });
  } finally {
    client.release();
  }
};

// PATCH /api/admin/orders/bulk-status
export const bulkUpdateStatus = async (req, res) => {
  const { ids, status } = req.body;

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: 'ids must be a non-empty array' });
  }
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ message: `Invalid status "${status}"` });
  }

  // Perform transactional bulk update and return list of updated orders
  const client = await (await import('../../config/database.js')).getClient();
  try {
    await client.query('BEGIN');

    // Lock matching rows
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const selectSql = `SELECT * FROM orders WHERE id IN (${placeholders}) FOR UPDATE`;
    const { rows: found } = await client.query(selectSql, ids);
    if (!found.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'No matching orders found' });
    }

    // Validate transitions for all orders
    const ORDER_STEPS = ['pending', 'confirmed', 'dispatched', 'delivered'];
    const idxOf = (s) => ORDER_STEPS.indexOf(normalizeOrderStatus(s));
    for (const o of found) {
      const prev = normalizeOrderStatus(o.order_status);
      const next = normalizeOrderStatus(status);
      const prevIdx = idxOf(prev);
      const nextIdx = idxOf(next);
      if (next === 'cancelled') {
        if (prev === 'delivered') {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: `Order ${o.id} cannot be cancelled after delivery` });
        }
      } else {
        if (!(nextIdx === prevIdx + 1 || nextIdx === prevIdx)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: `Invalid transition for order ${o.id} from ${prev} to ${next}` });
        }
      }
    }

    // Update rows
    const updateSql = `UPDATE orders SET order_status = $${ids.length + 1}, updated_at = now() WHERE id IN (${placeholders}) RETURNING *`;
    const { rows: updated } = await client.query(updateSql, [...ids, status]);

    // Insert history rows
    const historyStmt = `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by) VALUES `;
    const historyValues = [];
    const historyParams = [];
    let pidx = 1;
    for (const o of found) {
      historyParams.push(o.id, o.order_status, status, req.user?.id || null);
      historyValues.push(`($${pidx++}, $${pidx++}, $${pidx++}, $${pidx++})`);
    }
    if (historyValues.length) {
      await client.query(historyStmt + historyValues.join(', '), historyParams);
    }

    await client.query('COMMIT');

    // Emit events for each updated order
    try {
      const io = req.app?.locals?.io;
      if (io) {
        updated.forEach((u) => io.emit('order:updated', u));
      }
    } catch (e) {
      // ignore socket errors
    }

    res.json({ success: true, message: `${updated.length} order(s) updated`, orders: updated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in bulk update:', err);
    res.status(500).json({ message: 'Bulk update failed' });
  } finally {
    client.release();
  }
};
