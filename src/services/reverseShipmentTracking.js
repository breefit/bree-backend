/**
 * Reverse (return) shipment tracking — Delhivery reverse pickups ("RVP").
 *
 * FORWARD SHIPMENT ≠ REVERSE SHIPMENT. The forward tracking cron
 * (cron/shippingTrackingCron.js → syncShippingTracking) owns awb_number,
 * tracking_status, delhivery_response and order_status. This module owns
 * ONLY the reverse_* tracking columns and the return_status transitions a
 * Delhivery reverse-pickup event can prove. It never reads or writes a
 * forward column.
 *
 * Delhivery reverse-pickup lifecycle (StatusType/Status), from Delhivery's
 * "Reverse Pickups" reference
 * (https://delhivery-express-api-doc.readme.io/reference/reverse-pickups):
 *
 *   PP/Open        "When pick up request is created in our system."
 *   PP/Scheduled   "When picks up request is scheduled for a time to pick up"
 *   PP/Dispatched  "When FE is Out in field to collect this package from the end customer."
 *   PU/In Transit  "When pick up shipment is in transit to RPC from DC after physical pick up."
 *   PU/Pending     "When pickup shipment has reached RPC but not yet dispatched for delivery to the client."
 *   PU/Dispatched  "When pickup shipment is dispatched for delivery to the client from RPC."
 *   DL/DTO         "When pickup shipment is accepted by client and POD is received."
 *   CN/Canceled    "When a Reverse Pickup shipment is canceled before getting picked up from customer"
 *   CN/Closed      "When a Reverse Pickup shipment is canceled and Request is Closed"
 *
 * Only DL/DTO proves the parcel reached BREE. Any other combination —
 * including DL/"Delivered", which is the END of a FORWARD shipment — maps
 * to 'unknown': recorded and logged, never a transition.
 */
import { query } from "../config/database.js";
import delhiveryService from "./delhiveryService.js";
import { extractDelhiveryTrackingDetails } from "../controllers/shippingController.js";
import { appendStatusHistory } from "../models/Order.js";
import { notifyReturnEvent } from "../controllers/admin/returnController.js";
import {
  RETURN_STATUS,
  REVERSE_SHIPMENT_TYPE_RVP,
  REVERSE_TRACKING_STATUS,
  RETURNED_SOURCE,
} from "../constants/returnStatus.js";

const S = REVERSE_TRACKING_STATUS;

const REVERSE_STATUS_MAP = Object.freeze({
  "PP/open": S.PICKUP_REQUESTED,
  "PP/scheduled": S.PICKUP_SCHEDULED,
  "PP/dispatched": S.OUT_FOR_PICKUP,
  "PU/in transit": S.IN_TRANSIT,
  "PU/pending": S.IN_TRANSIT,
  "PU/dispatched": S.IN_TRANSIT,
  "DL/dto": S.DELIVERED_TO_BREE,
  "CN/canceled": S.CANCELLED,
  "CN/closed": S.CANCELLED,
});

export const normalizeReverseTrackingStatus = (statusType, status) => {
  const key = `${String(statusType || "").trim().toUpperCase()}/${String(status || "")
    .trim()
    .toLowerCase()}`;
  return REVERSE_STATUS_MAP[key] || S.UNKNOWN;
};

// Which Delhivery states are evidence of each milestone. Later states imply
// earlier ones (Delhivery cannot deliver to BREE a parcel it never picked up).
const PICKUP_SCHEDULED_EVIDENCE = [S.PICKUP_SCHEDULED, S.OUT_FOR_PICKUP, S.IN_TRANSIT, S.DELIVERED_TO_BREE];
const PICKED_UP_EVIDENCE = [S.IN_TRANSIT, S.DELIVERED_TO_BREE];

/** The return_status a normalized reverse state proves, or null. */
export const returnStatusProvenBy = (normalized) => {
  if (normalized === S.DELIVERED_TO_BREE) return RETURN_STATUS.RETURNED;
  if (PICKUP_SCHEDULED_EVIDENCE.includes(normalized)) return RETURN_STATUS.PICKUP_SCHEDULED;
  return null;
};

// Forward-only: the only automatic transitions allowed.
const ALLOWED_TRANSITIONS = Object.freeze({
  [RETURN_STATUS.REVERSE_SHIPMENT_CREATED]: [RETURN_STATUS.PICKUP_SCHEDULED, RETURN_STATUS.RETURNED],
  [RETURN_STATUS.PICKUP_SCHEDULED]: [RETURN_STATUS.RETURNED],
});

export const isAllowedReturnTransition = (from, to) =>
  Boolean(ALLOWED_TRANSITIONS[from]?.includes(to));

const log = (level, event, meta = {}) => {
  const entry = JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...meta });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
};

// Error text safe to log/store: Delhivery's formatted { status, message }
// only — never request config/headers (which carry the API token).
const describeTrackingError = (error) => {
  if (!error) return "Unknown error";
  const status = error.status ? `HTTP ${error.status}: ` : "";
  return `${status}${error.message || String(error)}`.slice(0, 300);
};

const TRACKABLE_SQL = `
  SELECT id, order_number, order_status, return_status, reverse_awb,
         reverse_shipment_type, reverse_tracking_status, reverse_delivered_at,
         reverse_tracking_failure_count
  FROM orders
  WHERE reverse_awb IS NOT NULL
    AND reverse_awb <> ''
    AND COALESCE(reverse_tracking_status, '') NOT IN ('${S.DELIVERED_TO_BREE}', '${S.CANCELLED}')
    AND (
      return_status IN ('${RETURN_STATUS.REVERSE_SHIPMENT_CREATED}', '${RETURN_STATUS.PICKUP_SCHEDULED}')
      OR (
        return_status = '${RETURN_STATUS.RETURNED}'
        AND reverse_shipment_type = '${REVERSE_SHIPMENT_TYPE_RVP}'
        AND reverse_delivered_at IS NULL
      )
    )`;

/**
 * Records one Delhivery observation for one reverse AWB and applies at most
 * one forward-only return_status transition. Idempotent: re-applying the
 * same observation changes nothing but reverse_tracking_updated_at, and
 * writes no history and sends no notification.
 */
const applyObservation = async (order, parsed, rawResponse, { queryFn, notify, historyFn }) => {
  const normalized = normalizeReverseTrackingStatus(parsed.statusType, parsed.trackingStatus);
  const rawStatus = `${parsed.statusType || "?"}/${parsed.trackingStatus}`.slice(0, 120);
  const isRvp = order.reverse_shipment_type === REVERSE_SHIPMENT_TYPE_RVP;

  // Milestone timestamps are when BREE first OBSERVED the state (≤ one cron
  // interval after Delhivery's event). Delhivery's own event time stays in
  // reverse_delhivery_response. Never overwritten once set (COALESCE).
  const scheduled = isRvp && PICKUP_SCHEDULED_EVIDENCE.includes(normalized);
  const pickedUp = isRvp && PICKED_UP_EVIDENCE.includes(normalized);
  const delivered = isRvp && normalized === S.DELIVERED_TO_BREE;

  await queryFn(
    `UPDATE orders
     SET reverse_tracking_status = ?,
         reverse_tracking_raw_status = ?,
         reverse_tracking_updated_at = NOW(),
         reverse_delhivery_response = ?,
         reverse_tracking_failure_count = 0,
         reverse_pickup_scheduled_at = CASE WHEN ? = 1 THEN COALESCE(reverse_pickup_scheduled_at, NOW()) ELSE reverse_pickup_scheduled_at END,
         reverse_picked_up_at = CASE WHEN ? = 1 THEN COALESCE(reverse_picked_up_at, NOW()) ELSE reverse_picked_up_at END,
         reverse_delivered_at = CASE WHEN ? = 1 THEN COALESCE(reverse_delivered_at, NOW()) ELSE reverse_delivered_at END
     WHERE id = ?`,
    [
      normalized,
      rawStatus,
      JSON.stringify(rawResponse),
      scheduled ? 1 : 0,
      pickedUp ? 1 : 0,
      delivered ? 1 : 0,
      order.id,
    ],
  );

  if (normalized === S.UNKNOWN) {
    log("warn", "reverse_tracking.unknown_status", {
      orderId: order.id,
      reverseAwb: order.reverse_awb,
      delhiveryStatus: rawStatus,
      legacyShipment: !isRvp,
    });
    return { normalized, transitioned: null };
  }

  if (normalized === S.CANCELLED) {
    log("error", "reverse_tracking.pickup_cancelled", {
      orderId: order.id,
      reverseAwb: order.reverse_awb,
      delhiveryStatus: rawStatus,
      action: "Delhivery cancelled the reverse pickup — needs admin follow-up",
    });
  }

  if (!isRvp) {
    // Legacy return shipment (forward Prepaid, BREE → BREE): its tracking
    // cannot prove a customer pickup, so it never drives return_status.
    log("warn", "reverse_tracking.legacy_shipment_not_synchronized", {
      orderId: order.id,
      reverseAwb: order.reverse_awb,
      delhiveryStatus: rawStatus,
    });
    return { normalized, transitioned: null };
  }

  const target = returnStatusProvenBy(normalized);
  if (!target || !isAllowedReturnTransition(order.return_status, target)) {
    return { normalized, transitioned: null };
  }

  const setReturned =
    target === RETURN_STATUS.RETURNED
      ? `, returned_at = COALESCE(returned_at, NOW()), returned_source = '${RETURNED_SOURCE.DELHIVERY}',
         inspection_status = COALESCE(inspection_status, 'pending')`
      : "";

  // Conditional on the state we read: a concurrent cron process or admin
  // action that already moved it makes this a no-op (0 rows) — so exactly
  // one caller writes history and notifies.
  const result = await queryFn(
    `UPDATE orders
     SET return_status = ?${setReturned}, updated_at = NOW()
     WHERE id = ? AND return_status = ?`,
    [target, order.id, order.return_status],
  );
  if (!Number(result?.rowCount || 0)) {
    return { normalized, transitioned: null };
  }

  const note =
    target === RETURN_STATUS.RETURNED
      ? `Return delivered to BREE — Delhivery reverse status ${rawStatus} (POD received). Reverse AWB: ${order.reverse_awb}`
      : `Return pickup scheduled by Delhivery — reverse status ${rawStatus}. Reverse AWB: ${order.reverse_awb}`;
  await historyFn({
    orderId: order.id,
    previousStatus: order.order_status,
    newStatus: order.order_status,
    changedBy: null,
    notes: note,
  }).catch((error) =>
    log("error", "reverse_tracking.history_failed", { orderId: order.id, error: error?.message }),
  );

  log("info", "reverse_tracking.transition", {
    orderId: order.id,
    from: order.return_status,
    to: target,
    delhiveryStatus: rawStatus,
  });

  const { rows } = await queryFn("SELECT * FROM orders WHERE id = ? LIMIT 1", [order.id]);
  if (rows[0]) {
    // Same labels, and the same exactly-once notification claim
    // (order_status_notifications), the admin buttons already used.
    notify(rows[0], target === RETURN_STATUS.RETURNED ? "Return Received" : "Return Pickup Scheduled", null);
  }

  return { normalized, transitioned: target };
};

/**
 * One reverse-tracking pass: every return shipment still in flight.
 * A failed Delhivery call / malformed response never changes return_status;
 * it increments reverse_tracking_failure_count and is retried next run.
 */
export const syncReverseShipmentTracking = async ({
  queryFn = query,
  trackShipment = (awb) => delhiveryService.trackShipment(awb),
  notify = notifyReturnEvent,
  historyFn = appendStatusHistory,
} = {}) => {
  const { rows: orders } = await queryFn(TRACKABLE_SQL);
  const summary = { checked: orders.length, transitioned: 0, failed: 0, unknown: 0 };

  for (const order of orders) {
    try {
      const response = await trackShipment(order.reverse_awb);
      if (!response || response.success === false) {
        throw Object.assign(new Error(response?.message || "Empty tracking response"), {
          status: response?.status,
        });
      }
      const parsed = extractDelhiveryTrackingDetails(response);
      if (!parsed.success) throw new Error(`Malformed tracking response: ${parsed.message}`);

      const result = await applyObservation(order, parsed, response, {
        queryFn,
        notify,
        historyFn: (entry) => historyFn({ ...entry, queryExecutor: queryFn }),
      });
      if (result.transitioned) summary.transitioned++;
      if (result.normalized === S.UNKNOWN) summary.unknown++;
    } catch (error) {
      summary.failed++;
      const message = describeTrackingError(error);
      log("error", "reverse_tracking.fetch_failed", {
        orderId: order.id,
        reverseAwb: order.reverse_awb,
        error: message,
      });
      await queryFn(
        `UPDATE orders SET reverse_tracking_failure_count = reverse_tracking_failure_count + 1 WHERE id = ?`,
        [order.id],
      ).catch(() => {});
    }
  }

  log("info", "reverse_tracking.run_complete", summary);
  return summary;
};

export default syncReverseShipmentTracking;
