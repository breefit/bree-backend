// backend/src/constants/orderStatus.js

export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "processing",
  "ready_to_ship",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "returned",
];

export const VALID_ORDER_STATUSES = ORDER_STATUSES;

export const DISPATCH_STATUSES = [
  "processing",
  "ready_to_ship",
  "shipped",
  "out_for_delivery",
];

export const VALID_PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"];

export const normalizeOrderStatus = (status) => {
  if (!status) return null;

  const lower = String(status).toLowerCase().trim();
  const aliases = {
    pending: "pending_payment",
    confirmed: "paid",
    dispatched: "shipped",
    shipped: "shipped",
    "out for delivery": "out_for_delivery",
    out_for_delivery: "out_for_delivery",
    "ready to ship": "ready_to_ship",
    ready_to_ship: "ready_to_ship",
    delivered: "delivered",
    cancelled: "cancelled",
    returned: "returned",
  };

  return aliases[lower] || (ORDER_STATUSES.includes(lower) ? lower : lower);
};

export const getOrderStatusLabel = (status) => {
  const lower = String(status || "").toLowerCase();

  return (
    {
      pending_payment: "Pending Payment",
      paid: "Paid",
      processing: "Processing",
      ready_to_ship: "Ready To Ship",
      shipped: "Shipped",
      out_for_delivery: "Out For Delivery",
      delivered: "Delivered",
      cancelled: "Cancelled",
      returned: "Returned",
    }[lower] || status
  );
};

export const getOrderStatusFlow = (status) => {
  const normalized = normalizeOrderStatus(status);

  if (!normalized || ["cancelled", "returned"].includes(normalized)) {
    return [normalized].filter(Boolean);
  }

  const startIndex = ORDER_STATUSES.indexOf(normalized);
  const endIndex = ORDER_STATUSES.indexOf("delivered");

  if (startIndex < 0 || endIndex < 0) return [normalized];

  return ORDER_STATUSES.slice(startIndex, endIndex + 1);
};

export const STATUS_EMAIL_SUBJECTS = {
  pending_payment: "📝 Order Received",
  paid: "✅ Your BREE Order Has Been Paid",
  processing: "🔄 Your BREE Order Is Being Prepared",
  ready_to_ship: "📦 Your BREE Order Is Ready To Ship",
  shipped: "🚚 Your BREE Order Has Been Shipped",
  out_for_delivery: "🚚 Your BREE Order Is Out For Delivery",
  delivered: "🎉 Your BREE Order Has Been Delivered",
  cancelled: "❌ Your BREE Order Has Been Cancelled",
  returned: "↩️ Your BREE Order Has Been Returned",
};

export const getStatusEmailSubject = (status) => {
  const lower = String(status || "").toLowerCase();

  return (
    STATUS_EMAIL_SUBJECTS[lower] ||
    `Order Status Updated - ${getOrderStatusLabel(status)}`
  );
};
