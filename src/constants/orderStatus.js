// backend/src/constants/orderStatus.js

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "dispatched",
  "delivered",
  "cancelled",
];

export const VALID_ORDER_STATUSES = ORDER_STATUSES;

export const DISPATCH_STATUSES = ["processing", "dispatched"];

export const VALID_PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"];

export const normalizeOrderStatus = (status) => {
  if (!status) return null;

  const lower = String(status).toLowerCase().trim();

  return ORDER_STATUSES.includes(lower) ? lower : lower;
};

export const getOrderStatusLabel = (status) => {
  const lower = String(status || "").toLowerCase();

  return (
    {
      pending: "Order Placed",
      confirmed: "Confirmed",
      processing: "Processing",
      dispatched: "Dispatched",
      delivered: "Delivered",
      cancelled: "Cancelled",
    }[lower] || status
  );
};

export const STATUS_EMAIL_SUBJECTS = {
  pending: "📝 Order Received",
  confirmed: "✅ Your BREE Order Has Been Confirmed",
  processing: "🔄 Your BREE Order Is Being Prepared",
  dispatched: "🚚 Your BREE Order Has Been Dispatched",
  delivered: "🎉 Your BREE Order Has Been Delivered",
  cancelled: "❌ Your BREE Order Has Been Cancelled",
};

export const getStatusEmailSubject = (status) => {
  const lower = String(status || "").toLowerCase();

  return (
    STATUS_EMAIL_SUBJECTS[lower] ||
    `Order Status Updated - ${getOrderStatusLabel(status)}`
  );
};
