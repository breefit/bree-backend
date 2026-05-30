import { query } from "../config/database.js";

// Append a status history record for an order.
export const appendStatusHistory = async ({
  orderId,
  previousStatus = null,
  newStatus,
  changedBy = null,
  notes = null,
}) => {
  return query(
    `INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by, notes) VALUES (?, ?, ?, ?, ?)`,
    [orderId, previousStatus, newStatus, changedBy, notes],
  );
};

// Fetch status history for an order ordered asc by created_at
export const getStatusHistory = async (orderId) => {
  const { rows } = await query(
    `SELECT id, previous_status, new_status, changed_by, notes, created_at FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC`,
    [orderId],
  );
  return rows;
};

export default {
  appendStatusHistory,
  getStatusHistory,
};
