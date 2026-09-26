// Canonical orders.return_status values (see controllers/admin/returnController.js):
//   approved -> reverse_shipment_created -> pickup_scheduled -> returned
//   (or: rejected)
export const RETURN_STATUS = Object.freeze({
  APPROVED: "approved",
  REJECTED: "rejected",
  REVERSE_SHIPMENT_CREATED: "reverse_shipment_created",
  PICKUP_SCHEDULED: "pickup_scheduled",
  RETURNED: "returned",
});

// orders.reverse_shipment_type — 'rvp' only for a return shipment created
// with Delhivery's reverse-pickup contract (payment_mode "Pickup"). NULL is
// a legacy return shipment created before that fix (a forward Prepaid
// shipment), whose Delhivery tracking is recorded but never allowed to
// change return_status.
export const REVERSE_SHIPMENT_TYPE_RVP = "rvp";

// orders.reverse_tracking_status — BREE's normalized view of Delhivery's
// reverse-pickup (StatusType/Status) lifecycle. See
// services/reverseShipmentTracking.js for the exact mapping.
export const REVERSE_TRACKING_STATUS = Object.freeze({
  PICKUP_REQUESTED: "pickup_requested",
  PICKUP_SCHEDULED: "pickup_scheduled",
  OUT_FOR_PICKUP: "out_for_pickup",
  IN_TRANSIT: "in_transit",
  DELIVERED_TO_BREE: "delivered_to_bree",
  CANCELLED: "cancelled",
  UNKNOWN: "unknown",
});

// orders.returned_source — who established return_status = 'returned'.
export const RETURNED_SOURCE = Object.freeze({
  DELHIVERY: "delhivery",
  MANUAL_OVERRIDE: "manual_override",
});
