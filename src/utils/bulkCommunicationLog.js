// Shared by bulkController.js and bulkOrderService.js so both can log to
// bulk_booking_communications without duplicating the INSERT. See
// config/database.js ensureBulkBookingCommunicationsTable for the schema.

import { randomUUID } from "crypto";
import { query } from "../config/database.js";

/**
 * Records one customer-notification send against a bulk booking. Never
 * throws — a logging failure must not fail whatever triggered the
 * notification it's recording.
 */
export const logBulkCommunication = async (
  bulkBookingId,
  type,
  label,
  sentBy = null,
) => {
  try {
    await query(
      `INSERT INTO bulk_booking_communications (id, bulk_booking_id, type, label, sent_by)
       VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), bulkBookingId, type, label, sentBy || null],
    );
  } catch (err) {
    console.error("[BULK] Failed to log communication history", {
      bulkBookingId,
      type,
      error: err?.message,
    });
  }
};
