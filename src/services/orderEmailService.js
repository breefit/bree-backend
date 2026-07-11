import nodemailer from "nodemailer";
import { getOrderStatusLabel } from "../constants/orderStatus.js";

const createTransporter = () =>
  nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

const getFromAddress = () =>
  process.env.SMTP_FROM ||
  process.env.SMTP_USER ||
  "BREE Wellness <no-reply@breewellness.com>";

const getFrontendUrl = () =>
  (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");

const sendEmail = async ({ to, subject, html }) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !to) {
    console.log("[EMAIL] Skipping — SMTP not configured or missing recipient");
    return;
  }

  await createTransporter().sendMail({
    from: getFromAddress(),
    to,
    subject,
    html,
  });
};

const formatOrderItems = (items = []) => {
  if (!items.length) return "<p>No items found</p>";
  const rows = items
    .map(
      (item) =>
        `<tr><td style="padding:8px;border:1px solid #e5e7eb">${item.name}</td><td style="padding:8px;border:1px solid #e5e7eb;text-align:center">${item.quantity}</td><td style="padding:8px;border:1px solid #e5e7eb;text-align:right">₹${Number(item.price || item.unit_price || 0).toLocaleString()}</td></tr>`,
    )
    .join("");

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr style="background:#f3f4f6;color:#111827;text-align:left;">
          <th style="padding:10px;border:1px solid #e5e7eb">Product</th>
          <th style="padding:10px;border:1px solid #e5e7eb">Qty</th>
          <th style="padding:10px;border:1px solid #e5e7eb;text-align:right">Price</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
};

const getOrderTrackingLink = (orderId) =>
  `${getFrontendUrl()}/order/${orderId}/tracking`;

/**
 * Format a shipping address block for email display.
 * Returns an HTML string if address is available, or empty string.
 *
 * FIX: Uses order.shipping_address as primary source.
 * Falls back to passed address object only if shipping_address is empty.
 */
const formatAddressBlock = (shippingAddress) => {
  if (!shippingAddress || !shippingAddress.trim()) return "";
  return `
    <div style="margin-top:8px;padding:10px 14px;background:#f9fafb;border-radius:6px;color:#374151;font-size:14px;">
      <strong>Shipping To:</strong><br/>
      ${shippingAddress.replace(/,\s*/g, "<br/>")}
    </div>
  `;
};

export const sendOrderConfirmationEmail = async ({
  to,
  name,
  orderId,
  amount,
  items,
  shippingAddress, // FIX: now explicitly passed from paymentController
}) => {
  console.log(
    "[EMAIL] sendOrderConfirmationEmail orderId:",
    orderId,
    "to:",
    to,
    "address present:",
    !!shippingAddress,
  );

  // FIX: Use shippingAddress directly — do NOT fall back to "Address Not Found"
  // If it's empty we simply omit the address block rather than showing a bad message
  const addressBlock = formatAddressBlock(shippingAddress || "");

  await sendEmail({
    to,
    subject: `Order Confirmed — BREE #${String(orderId).slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"}, your order is confirmed!</h2>
        <p>Order ID: <strong>#${String(orderId).slice(-8).toUpperCase()}</strong></p>
        ${formatOrderItems(items)}
        <p style="font-weight:700;margin-top:16px;">Total: ₹${Number(amount || 0).toLocaleString()}</p>
        ${addressBlock}
        <p style="margin-top:24px;">Track your order anytime: <a href="${getOrderTrackingLink(orderId)}">${getOrderTrackingLink(orderId)}</a></p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">Thanks for choosing BREE Wellness.</p>
      </div>
    `,
  });
};

export const sendOrderStatusUpdateEmail = async ({
  to,
  name,
  orderId,
  status,
  notes,
}) => {
  const label = getOrderStatusLabel(status);
  await sendEmail({
    to,
    subject: `Order Status Updated — ${label} (#${String(orderId).slice(-8).toUpperCase()})`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"},</h2>
        <p>Your order <strong>#${String(orderId).slice(-8).toUpperCase()}</strong> is now <strong>${label}</strong>.</p>
        ${notes ? `<p><strong>Note:</strong> ${notes}</p>` : ""}
        <p>Track the latest update here: <a href="${getOrderTrackingLink(orderId)}">${getOrderTrackingLink(orderId)}</a></p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">Thanks for shopping with BREE Wellness.</p>
      </div>
    `,
  });
};

export const sendOrderDeliveredEmail = async ({ to, name, orderId }) => {
  await sendEmail({
    to,
    subject: `Order Delivered — BREE #${String(orderId).slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"},</h2>
        <p>Great news — your order <strong>#${String(orderId).slice(-8).toUpperCase()}</strong> has been delivered.</p>
        <p>We hope you love it. If you have any questions, feel free to reach out.</p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">Thank you for choosing BREE Wellness.</p>
      </div>
    `,
  });
};

export const sendOrderCancelledEmail = async ({ to, name, orderId, notes }) => {
  await sendEmail({
    to,
    subject: `Order Cancelled — BREE #${String(orderId).slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#b91c1c;">Hi ${name || "there"},</h2>
        <p>Your order <strong>#${String(orderId).slice(-8).toUpperCase()}</strong> has been cancelled.</p>
        ${notes ? `<p><strong>Reason:</strong> ${notes}</p>` : ""}
        <p>If you would like help placing a replacement order, we are here to support you.</p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">Sincerely, BREE Wellness.</p>
      </div>
    `,
  });
};

export const sendShipmentCreatedEmail = async ({
  to,
  name,
  orderId,
  awbNumber,
  trackingUrl,
  expectedDeliveryDate,
  courier = "Delhivery",
}) => {
  const orderReference = String(orderId).slice(-8).toUpperCase();
  const trackingLink = trackingUrl || getOrderTrackingLink(orderId);
  const frontendUrl = getFrontendUrl();

  await sendEmail({
    to,
    subject: `Shipment Created — BREE #${orderReference}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"},</h2>
        <p>Your shipment for order <strong>#${orderReference}</strong> has been created.</p>
        <p><strong>Courier:</strong> ${courier}</p>
        <p><strong>AWB Number:</strong> ${awbNumber || "Pending"}</p>
        <p><strong>Tracking URL:</strong> <a href="${trackingLink}">${trackingLink}</a></p>
        ${expectedDeliveryDate ? `<p><strong>Expected delivery:</strong> ${expectedDeliveryDate}</p>` : ""}
        <p style="margin-top:20px;"><a href="${trackingLink}" style="background:#047857;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block;">Track Shipment</a></p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">You can also visit <a href="${frontendUrl}">${frontendUrl}</a> for updates.</p>
      </div>
    `,
  });
};

export const sendOutForDeliveryEmail = async ({
  to,
  name,
  orderId,
  awbNumber,
  trackingUrl,
  currentLocation,
  expectedDeliveryDate,
}) => {
  const orderReference = String(orderId).slice(-8).toUpperCase();
  const trackingLink = trackingUrl || getOrderTrackingLink(orderId);
  const frontendUrl = getFrontendUrl();

  await sendEmail({
    to,
    subject: `Out for Delivery — BREE #${orderReference}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"},</h2>
        <p>Your order <strong>#${orderReference}</strong> is out for delivery.</p>
        <p><strong>AWB Number:</strong> ${awbNumber || "Pending"}</p>
        ${currentLocation ? `<p><strong>Current location:</strong> ${currentLocation}</p>` : ""}
        ${expectedDeliveryDate ? `<p><strong>Expected delivery:</strong> ${expectedDeliveryDate}</p>` : ""}
        <p style="margin-top:20px;"><a href="${trackingLink}" style="background:#047857;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block;">Track Shipment</a></p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">Visit <a href="${frontendUrl}">${frontendUrl}</a> for the latest order updates.</p>
      </div>
    `,
  });
};

export const sendShipmentDeliveredEmail = async ({ to, name, orderId }) => {
  const orderReference = String(orderId).slice(-8).toUpperCase();
  const frontendUrl = getFrontendUrl();

  await sendEmail({
    to,
    subject: `Delivered — BREE #${orderReference}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"},</h2>
        <p>Delivery confirmation for order <strong>#${orderReference}</strong> is complete.</p>
        <p>Thank you for choosing BREE Wellness. We hope you enjoy your order.</p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">If you have any questions, visit <a href="${frontendUrl}">${frontendUrl}</a>.</p>
      </div>
    `,
  });
};

export const sendShipmentCancelledEmail = async ({
  to,
  name,
  orderId,
  cancellationReason,
}) => {
  const orderReference = String(orderId).slice(-8).toUpperCase();
  const frontendUrl = getFrontendUrl();

  await sendEmail({
    to,
    subject: `Shipment Cancelled — BREE #${orderReference}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#b91c1c;">Hi ${name || "there"},</h2>
        <p>Your shipment for order <strong>#${orderReference}</strong> has been cancelled.</p>
        ${cancellationReason ? `<p><strong>Reason:</strong> ${cancellationReason}</p>` : ""}
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">For support, please visit <a href="${frontendUrl}">${frontendUrl}</a>.</p>
      </div>
    `,
  });
};

export const sendSubscriptionChargeReceiptEmail = async ({
  to,
  name,
  orderId,
  amount,
  subscriptionId,
}) => {
  await sendEmail({
    to,
    subject: `Subscription Renewal Received — BREE #${String(orderId).slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"},</h2>
        <p>We received your subscription payment successfully for order <strong>#${String(orderId).slice(-8).toUpperCase()}</strong>.</p>
        <p><strong>Subscription ID:</strong> ${subscriptionId}</p>
        <p><strong>Amount charged:</strong> ₹${Number(amount || 0).toLocaleString()}</p>
        <p>Thank you for continuing your wellness journey with BREE.</p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">— The BREE Team</p>
      </div>
    `,
  });
};

export const sendSubscriptionFailedEmail = async ({
  to,
  name,
  orderId,
  subscriptionId,
  notes,
}) => {
  await sendEmail({
    to,
    subject: `Subscription Payment Failed — BREE #${String(orderId).slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#d97706;">Hi ${name || "there"},</h2>
        <p>Your subscription payment for order <strong>#${String(orderId).slice(-8).toUpperCase()}</strong> could not be processed.</p>
        <p><strong>Subscription ID:</strong> ${subscriptionId}</p>
        ${notes ? `<p><strong>Details:</strong> ${notes}</p>` : ""}
        <p>Please update your payment details or contact support to avoid interruption.</p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">— The BREE Team</p>
      </div>
    `,
  });
};

export const sendSubscriptionCancellationEmail = async ({
  to,
  name,
  orderId,
  subscriptionId,
}) => {
  await sendEmail({
    to,
    subject: `Subscription Cancelled — BREE #${String(orderId).slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#b91c1c;">Hi ${name || "there"},</h2>
        <p>Your subscription for order <strong>#${String(orderId).slice(-8).toUpperCase()}</strong> has been cancelled.</p>
        <p><strong>Subscription ID:</strong> ${subscriptionId}</p>
        <p>If you wish to restart your plan, you can subscribe again anytime from your account.</p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">— The BREE Team</p>
      </div>
    `,
  });
};

export const sendSubscriptionResumeEmail = async ({
  to,
  name,
  orderId,
  subscriptionId,
}) => {
  await sendEmail({
    to,
    subject: `Subscription Resumed — BREE #${String(orderId).slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"},</h2>
        <p>Your subscription for order <strong>#${String(orderId).slice(-8).toUpperCase()}</strong> has been resumed.</p>
        <p><strong>Subscription ID:</strong> ${subscriptionId}</p>
        <p>We will continue delivering your monthly wellness plan as scheduled.</p>
        <p style="color:#6b7280;font-size:13px;margin-top:28px;">— The BREE Team</p>
      </div>
    `,
  });
};
