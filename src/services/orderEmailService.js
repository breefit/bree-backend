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
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !to) return;

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

export const sendOrderConfirmationEmail = async ({
  to,
  name,
  orderId,
  amount,
  items,
}) => {
  await sendEmail({
    to,
    subject: `Order Confirmed — BREE #${String(orderId).slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#047857;">Hi ${name || "there"}, your order is confirmed!</h2>
        <p>Order ID: <strong>#${String(orderId).slice(-8).toUpperCase()}</strong></p>
        ${formatOrderItems(items)}
        <p style="font-weight:700;margin-top:16px;">Total: ₹${Number(amount || 0).toLocaleString()}</p>
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
