/**
 * Customer-facing order events (return / refund / cancel-and-refund) — the
 * ONLY content that services/customerOrderNotifications.js may put in a
 * customer email or WhatsApp for these events.
 *
 * FIX (notification privacy audit): notifyReturnEvent used to take a free-
 * text `notes` argument, and callers passed admin-authored text into it —
 * the admin's "verification notes" on Approve Return, rejection notes, QC
 * failure notes. That text was emailed to the customer as the "Note" box.
 * Every customer-visible string now lives here, written in advance and
 * reviewed as customer copy. Callers name an event; they cannot supply text.
 * Admin notes, override reasons, QC notes, Razorpay refund ids, RRNs and
 * Delhivery diagnostics stay in order_status_history / logs only.
 *
 * Fields:
 *   slug        notification-key segment (order:{id}:status:{slug}:channel:*)
 *               — identical to the slugs already stored in
 *               order_status_notifications, so existing rows keep deduping.
 *   label       WhatsApp {{3}} / email "Status".
 *   message     WhatsApp {{4}} / email "Update" line.
 *   emailMessage(order)  optional email-only line built from approved,
 *               customer-owned fields (refund amount only).
 *   emailSubject(ref)    optional subject override.
 *   isCurrent(order)     whether the event still describes the order's
 *               state — a retry of a superseded event is dropped instead of
 *               sending stale news (e.g. "Refund Initiated" after completion).
 *   recovery    optional { where, timestampColumn } — events produced by
 *               webhooks/crons, whose notification must be recoverable if
 *               the process dies after the state commit (see
 *               services/notificationReconciliation.js).
 */

const formatRupees = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
};

const SUPPORT_LINE = "Please contact BREE Support for assistance.";

const EVENTS = [
  {
    name: "Return Approved",
    slug: "return_approved",
    label: "Return Approved",
    message:
      "Your return request has been approved. We will arrange the pickup shortly.",
    isCurrent: (o) => o.return_status === "approved",
  },
  {
    name: "Return Rejected",
    slug: "return_rejected",
    label: "Return Rejected",
    message:
      "Your return request could not be approved. Please contact BREE Support for details.",
    isCurrent: (o) => o.return_status === "rejected",
  },
  {
    name: "Return Shipment Created",
    slug: "return_shipment_created",
    label: "Return Shipment Created",
    message:
      "Your return shipment has been created. Our courier partner will pick up the item shortly.",
    isCurrent: (o) => o.return_status === "reverse_shipment_created",
  },
  {
    name: "Return Pickup Scheduled",
    slug: "return_pickup_scheduled",
    label: "Return Pickup Scheduled",
    message: "A pickup has been scheduled for your return.",
    // Only while Delhivery still reports the pickup as scheduled / courier
    // out for pickup — never once the parcel is already picked up.
    isCurrent: (o) =>
      o.return_status === "pickup_scheduled" &&
      ["pickup_scheduled", "out_for_pickup"].includes(o.reverse_tracking_status),
    recovery: {
      where:
        "return_status = 'pickup_scheduled' AND reverse_tracking_status IN ('pickup_scheduled', 'out_for_pickup')",
      timestampColumn: "reverse_pickup_scheduled_at",
    },
  },
  {
    name: "Return Received",
    slug: "return_received",
    label: "Return Received",
    message: "We have received your returned item and are reviewing it.",
    isCurrent: (o) => o.return_status === "returned" && o.inspection_status === "pending",
    recovery: {
      where: "return_status = 'returned' AND inspection_status = 'pending'",
      timestampColumn: "returned_at",
    },
  },
  {
    name: "Return Inspection Approved",
    slug: "return_inspection_approved",
    label: "Return Inspection Approved",
    message:
      "Your returned item has passed our quality check and is approved for a refund.",
    isCurrent: (o) =>
      o.inspection_status === "approved" &&
      !["initiated", "completed", "failed", "rejected"].includes(o.refund_status),
  },
  {
    name: "Return Quality Check Failed",
    slug: "return_quality_check_failed",
    label: "Return Quality Check Failed",
    message:
      "Your returned item did not pass our quality check, so a refund cannot be processed for this return. Please contact BREE Support for details.",
    isCurrent: (o) => o.inspection_status === "rejected",
  },
  {
    name: "Refund Initiated",
    slug: "refund_initiated",
    label: "Refund Initiated",
    message: "Your refund has been initiated and will reflect in your account soon.",
    isCurrent: (o) => o.refund_status === "initiated",
  },
  {
    name: "Refund Completed",
    slug: "refund_completed",
    label: "Refund Completed",
    message: "Your refund has been completed successfully.",
    isCurrent: (o) => o.refund_status === "completed",
    recovery: {
      where: "refund_status = 'completed'",
      timestampColumn: "refund_completed_at",
    },
  },
  {
    // FIX (audit finding 2): a Razorpay refund failure used to be silent
    // for the customer. Deliberately generic — no gateway reason, refund
    // id or RRN; those stay in admin history.
    name: "Refund Failed",
    slug: "refund_failed",
    label: "Refund Update",
    message: `Your refund could not be completed at this time. ${SUPPORT_LINE}`,
    emailSubject: (ref) => `Refund Update — #${ref}`,
    isCurrent: (o) => o.refund_status === "failed",
    recovery: {
      where: "refund_status = 'failed'",
      timestampColumn: "updated_at",
    },
  },
  {
    name: "Refund Rejected",
    slug: "refund_rejected",
    label: "Refund Rejected",
    message:
      "Your refund request could not be approved. Please contact BREE Support if you need assistance.",
    isCurrent: (o) => o.refund_status === "rejected",
  },
  {
    // Admin "Cancel Order & Refund". Slug "cancelled" deliberately shares
    // the admin status-change key (order:{id}:status:cancelled:channel:*),
    // so a cancellation is announced once whichever path cancels.
    name: "cancelled",
    slug: "cancelled",
    label: "Cancelled",
    message: "Your order has been cancelled.",
    emailMessage: (o) => {
      const amount = formatRupees(o.refund_amount);
      return amount
        ? `Your order has been cancelled and a refund of ${amount} is being processed to your original payment method.`
        : "Your order has been cancelled.";
    },
    isCurrent: (o) => o.order_status === "cancelled",
  },
];

export const CUSTOMER_ORDER_EVENTS = Object.freeze(
  Object.fromEntries(EVENTS.map((event) => [event.name, Object.freeze(event)])),
);

const BY_SLUG = new Map(EVENTS.map((event) => [event.slug, CUSTOMER_ORDER_EVENTS[event.name]]));

/** Event by its name ("Refund Completed") or slug ("refund_completed"); null if unknown. */
export const resolveCustomerOrderEvent = (nameOrSlug) =>
  CUSTOMER_ORDER_EVENTS[nameOrSlug] || BY_SLUG.get(nameOrSlug) || null;

export const getCustomerOrderEventBySlug = (slug) => BY_SLUG.get(slug) || null;

/** Events whose missing notification can be recovered from order state. */
export const RECOVERABLE_CUSTOMER_ORDER_EVENTS = Object.freeze(
  EVENTS.filter((event) => event.recovery).map((event) => CUSTOMER_ORDER_EVENTS[event.name]),
);

/** label → WhatsApp {{4}} line, for buildOrderStatusMessage's lookup. */
export const CUSTOMER_ORDER_EVENT_MESSAGES = Object.freeze(
  Object.fromEntries(
    EVENTS.filter((event) => event.name === event.label).map((event) => [event.label, event.message]),
  ),
);

export default CUSTOMER_ORDER_EVENTS;
