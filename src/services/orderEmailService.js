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

const getFrontendUrl = () => {
  const configuredUrl = (
    process.env.FRONTEND_URL || "https://www.breefit.in"
  ).trim();
  const embeddedAbsoluteUrl = configuredUrl.match(/\/((?:https?:\/\/).+)$/);
  const candidateUrl = embeddedAbsoluteUrl?.[1] || configuredUrl;
  const absoluteUrl = candidateUrl.match(/^https?:\/\//)
    ? candidateUrl
    : `https://${candidateUrl}`;
  const frontendUrl = new URL(absoluteUrl);

  if (frontendUrl.hostname === "breefit.in") {
    frontendUrl.hostname = "www.breefit.in";
  }

  return frontendUrl.origin.replace(/\/+$/, "");
};

const sendEmail = async ({ to, subject, html }) => {
  // No recipient on file is a data condition, not a system failure — every
  // caller of the higher-level senders (sendOutForDeliveryEmail etc.)
  // already skips calling this at all when there's no email, so this is
  // just a defensive no-op, same as before.
  if (!to) {
    console.log("[EMAIL] Skipping — no recipient address");
    return;
  }

  // FIX (notification marked "sent" before the provider actually
  // succeeded): missing SMTP credentials used to hit this same silent
  // `return` as "no recipient" above — every caller (including
  // sendOrderStatusNotificationOnce, which resolves its `send` callback
  // normally and marks the row 'sent') then treated the email as
  // successfully delivered when nothing was ever sent. This is a genuine
  // system misconfiguration, not a data condition, so it must throw and
  // be recorded as 'failed' like any other provider error.
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP_USER/SMTP_PASS not configured");
  }

  await createTransporter().sendMail({
    from: getFromAddress(),
    to,
    subject,
    html,
  });
};

export const buildOrderTrackingUrl = (orderId) =>
  `${getFrontendUrl()}/order/${orderId}/tracking`;

const WEBSITE_URL = "https://www.breefit.in/";

// ==================================================
// BREE brand palette
// ==================================================
const COLORS = {
  primary: "#004B52", // dark teal
  text: "#222222", // dark text
  muted: "#666666", // muted text
  bg: "#F7F8F7", // light background
  border: "#E5E5E5",
  white: "#FFFFFF",
};

const formatOrderRef = (orderId) => String(orderId).slice(-8).toUpperCase();

const formatCurrency = (value) => `₹${Number(value || 0).toLocaleString()}`;

// ==================================================
// Reusable email building blocks
// ==================================================

const buildHeader = (frontendUrl) => {
  const logoUrl = `https://www.breefit.in/images/logo.PNG`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.white};">
      <tr>
        <td style="padding:32px 24px 20px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="width:100%;">
                <img src="${logoUrl}" alt="BREE Wellness" width="160" style="display:block;width:160px;max-width:160px;height:auto;margin:0 auto;" />
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
};

const buildIntro = ({ name, heading, subtext }) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:8px 24px 24px 24px;">
        <h1 style="margin:0 0 16px 0;color:${COLORS.primary};font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:34px;font-weight:700;text-align:center;">
          ${heading}
        </h1>
        <p style="margin:0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;text-align:center;">
          ${subtext}
        </p>
      </td>
    </tr>
  </table>
`;

const buildOrderInfoCard = ({ orderId, orderDate }) => {
  const orderRef = formatOrderRef(orderId);
  const dateCell = orderDate
    ? `
      <td style="padding:16px 20px;border-left:1px solid ${COLORS.border};">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-right:10px;vertical-align:top;font-family:Arial,Helvetica,sans-serif;font-size:16px;">📅</td>
            <td>
              <p style="margin:0 0 4px 0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">Order Placed On</p>
              <p style="margin:0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;">${orderDate}</p>
            </td>
          </tr>
        </table>
      </td>
    `
    : "";

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;background:${COLORS.bg};border-radius:8px;">
      <tr>
        <td style="padding:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="padding:16px 20px;">
                <p style="margin:0 0 4px 0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">Order ID</p>
                <p style="margin:0;color:${COLORS.primary};font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;">#${orderRef}</p>
              </td>
              ${dateCell}
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
};

const buildOrderItemsTable = (items = []) => {
  if (!items.length) return "";

  const rows = items
    .map((item) => {
      const price = Number(item.price || item.unit_price || 0);
      return `
        <tr>
          <td style="padding:12px 16px;border-top:1px solid ${COLORS.border};color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;">${item.name}</td>
          <td align="center" style="padding:12px 16px;border-top:1px solid ${COLORS.border};color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;">${item.quantity}</td>
          <td align="right" style="padding:12px 16px;border-top:1px solid ${COLORS.border};color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;">${formatCurrency(price)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
      <tr>
        <td>
          <p style="margin:0 0 12px 0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;">Order Items</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${COLORS.border};border-radius:6px;overflow:hidden;border-collapse:separate;">
            <tr style="background:${COLORS.bg};">
              <td style="padding:12px 16px;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">Product</td>
              <td align="center" style="padding:12px 16px;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">Qty</td>
              <td align="right" style="padding:12px 16px;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">Price</td>
            </tr>
            ${rows}
          </table>
        </td>
      </tr>
    </table>
  `;
};

const buildOrderTotalRow = (amount) => {
  if (amount === undefined || amount === null) return "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:-16px 0 24px 0;">
      <tr>
        <td style="padding:12px 16px;background:${COLORS.bg};border:1px solid ${COLORS.border};border-top:none;border-radius:0 0 6px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;">Total</td>
              <td align="right" style="color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;">${formatCurrency(amount)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
};

const buildShippingAddressCard = (shippingAddress) => {
  if (!shippingAddress || !shippingAddress.trim()) return "";

  const lines = shippingAddress
    .split(",")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("<br/>");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px 0;background:${COLORS.bg};border-radius:8px;">
      <tr>
        <td style="padding:18px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-right:10px;vertical-align:top;font-family:Arial,Helvetica,sans-serif;font-size:16px;">📍</td>
              <td>
                <p style="margin:0 0 6px 0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;">Shipping To:</p>
                <p style="margin:0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;">${lines}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
};

const buildInfoCard = (rows = []) => {
  const filteredRows = rows.filter((row) => row && row.value);
  if (!filteredRows.length) return "";

  const rowsHtml = filteredRows
    .map(
      (row) => `
        <tr>
          <td style="padding:10px 20px;${row === filteredRows[0] ? "" : `border-top:1px solid ${COLORS.border};`}">
            <p style="margin:0 0 4px 0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">${row.label}</p>
            <p style="margin:0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;">${row.value}</p>
          </td>
        </tr>
      `,
    )
    .join("");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;background:${COLORS.bg};border-radius:8px;">
      ${rowsHtml}
    </table>
  `;
};

const buildPrimaryButton = (url, label) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:500px;">
          <tr>
            <td align="center" bgcolor="${COLORS.primary}" style="border-radius:6px;">
              <a href="${url}" target="_blank" style="display:block;padding:16px 24px;color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;text-align:center;letter-spacing:0.3px;">
                ${label} &nbsp;&rarr;
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
`;

const buildSecondaryButton = (url, label) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:500px;">
          <tr>
            <td align="center" bgcolor="${COLORS.white}" style="border-radius:6px;border:2px solid ${COLORS.primary};">
              <a href="${url}" target="_blank" style="display:block;padding:14px 24px;color:${COLORS.primary};font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;text-align:center;letter-spacing:0.3px;">
                ${label} &nbsp;&#8599;
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
`;

const buildSupportingText = (text) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:0 24px 24px 24px;">
        <p style="margin:0;color:${COLORS.muted};font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;text-align:center;">
          ${text}
        </p>
      </td>
    </tr>
  </table>
`;

const buildSignOff = (message) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td style="padding:0 24px;">
        <hr style="border:none;border-top:1px solid ${COLORS.border};margin:0 0 24px 0;" />
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:0 24px 32px 24px;">
        <p style="margin:0 0 12px 0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;text-align:center;">${message}</p>
        <p style="margin:0 0 6px 0;color:${COLORS.primary};font-family:Arial,Helvetica,sans-serif;font-size:18px;text-align:center;">&#9825;</p>
        <p style="margin:0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;text-align:center;">Team BREE</p>
      </td>
    </tr>
  </table>
`;

const buildFooter = () => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.primary};">
    <tr>
      <td align="center" style="padding:32px 24px;">
        <p style="margin:0 0 4px 0;color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;letter-spacing:2px;">BREE</p>
        <p style="margin:0 0 16px 0;color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;">WELLNESS</p>
        <p style="margin:0;color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;opacity:0.85;">
          © ${new Date().getFullYear()} BREE Wellness.<br/>All rights reserved.
        </p>
      </td>
    </tr>
  </table>
`;

/**
 * Wraps arbitrary body content in the shared BREE branded shell:
 * white container, logo header, body content, footer.
 */
const buildBrandedEmail = ({ frontendUrl, content, preheader }) => `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>BREE Wellness</title>
    </head>
    <body style="margin:0;padding:0;background:${COLORS.bg};">
      ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>` : ""}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};padding:24px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${COLORS.white};border-radius:10px;overflow:hidden;">
              <tr>
                <td>
                  ${buildHeader(frontendUrl)}
                  ${content}
                  ${buildFooter()}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>
`;

const buildActionSection = ({ trackingLink }) => `
  ${buildPrimaryButton(trackingLink, "TRACK YOUR ORDER")}
  ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
  ${buildSupportingText("You can track your order anytime or visit our website for more information.")}
`;

// ==================================================
// Email functions (business logic preserved)
// ==================================================

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

  const frontendUrl = getFrontendUrl();
  const trackingLink = buildOrderTrackingUrl(orderId);

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},<br/>your order is confirmed!`,
      subtext:
        "Thank you for shopping with BREE Wellness.<br/>We've received your order and will keep you updated on its progress.",
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildOrderItemsTable(items)}
          ${buildOrderTotalRow(amount)}
          ${buildShippingAddressCard(shippingAddress || "")}
          ${buildActionSection({ trackingLink })}
        </td>
      </tr>
    </table>
    ${buildSignOff("Thanks for choosing BREE Wellness.")}
  `;

  await sendEmail({
    to,
    subject: `Order Confirmed — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness order is confirmed.",
    }),
  });
};

export const sendOrderStatusUpdateEmail = async ({
  to,
  name,
  orderId,
  orderNumber,
  status,
  notes,
}) => {
  const label = getOrderStatusLabel(status);
  const frontendUrl = getFrontendUrl();
  const trackingLink = buildOrderTrackingUrl(orderId);
  const orderReference = orderNumber || orderId;

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your order <strong>#${formatOrderRef(orderReference)}</strong> is now <strong>${label}</strong>.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId: orderReference })}
          ${buildInfoCard([{ label: "Note", value: notes }])}
          ${buildActionSection({ trackingLink })}
        </td>
      </tr>
    </table>
    ${buildSignOff("Thanks for shopping with BREE Wellness.")}
  `;

  await sendEmail({
    to,
    subject: `Order Status Updated — ${label} (#${formatOrderRef(orderReference)})`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: `Your order status is now ${label}.`,
    }),
  });
};

export const sendOrderDeliveredEmail = async ({
  to,
  name,
  orderId,
  orderNumber,
}) => {
  const frontendUrl = getFrontendUrl();
  const trackingLink = buildOrderTrackingUrl(orderId);
  const orderReference = orderNumber || orderId;

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Great news — your order <strong>#${formatOrderRef(orderReference)}</strong> has been delivered.<br/>We hope you love it. If you have any questions, feel free to reach out.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId: orderReference })}
          ${buildActionSection({ trackingLink })}
        </td>
      </tr>
    </table>
    ${buildSignOff("Thank you for choosing BREE Wellness.")}
  `;

  await sendEmail({
    to,
    subject: `Order Delivered — BREE #${formatOrderRef(orderReference)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness order has been delivered.",
    }),
  });
};

export const sendOrderCancelledEmail = async ({ to, name, orderId, notes }) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your order <strong>#${formatOrderRef(orderId)}</strong> has been cancelled.<br/>If you would like help placing a replacement order, we are here to support you.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([{ label: "Reason", value: notes }])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("Sincerely, BREE Wellness.")}
  `;

  await sendEmail({
    to,
    subject: `Order Cancelled — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness order has been cancelled.",
    }),
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
  const frontendUrl = getFrontendUrl();
  const trackingLink = buildOrderTrackingUrl(orderId);

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your shipment for order <strong>#${formatOrderRef(orderId)}</strong> has been created.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([
            { label: "Courier", value: courier },
            { label: "AWB Number", value: awbNumber || "Pending" },
            { label: "Expected Delivery", value: expectedDeliveryDate },
          ])}
          ${buildActionSection({ trackingLink })}
        </td>
      </tr>
    </table>
    ${buildSignOff("Thanks for choosing BREE Wellness.")}
  `;

  await sendEmail({
    to,
    subject: `Shipment Created — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness shipment has been created.",
    }),
  });
};

export const sendOutForDeliveryEmail = async ({
  to,
  name,
  orderId,
  orderNumber,
  awbNumber,
  trackingUrl,
  currentLocation,
  expectedDeliveryDate,
}) => {
  const frontendUrl = getFrontendUrl();
  const trackingLink = buildOrderTrackingUrl(orderId);
  const orderReference = orderNumber || orderId;

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your order <strong>#${formatOrderRef(orderReference)}</strong> is out for delivery.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId: orderReference })}
          ${buildInfoCard([
            { label: "AWB Number", value: awbNumber || "Pending" },
            { label: "Current Location", value: currentLocation },
            { label: "Expected Delivery", value: expectedDeliveryDate },
          ])}
          ${buildActionSection({ trackingLink })}
        </td>
      </tr>
    </table>
    ${buildSignOff("Thanks for choosing BREE Wellness.")}
  `;

  await sendEmail({
    to,
    subject: `Out for Delivery — BREE #${formatOrderRef(orderReference)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness order is out for delivery.",
    }),
  });
};

export const sendShipmentDeliveredEmail = async ({
  to,
  name,
  orderId,
  orderNumber,
}) => {
  const frontendUrl = getFrontendUrl();
  const orderReference = orderNumber || orderId;

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Delivery confirmation for order <strong>#${formatOrderRef(orderReference)}</strong> is complete.<br/>Thank you for choosing BREE Wellness. We hope you enjoy your order.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId: orderReference })}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("Thank you for choosing BREE Wellness.")}
  `;

  await sendEmail({
    to,
    subject: `Delivered — BREE #${formatOrderRef(orderReference)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness order has been delivered.",
    }),
  });
};

export const sendShipmentCancelledEmail = async ({
  to,
  name,
  orderId,
  cancellationReason,
}) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your shipment for order <strong>#${formatOrderRef(orderId)}</strong> has been cancelled.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([{ label: "Reason", value: cancellationReason }])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("For support, reach out anytime.")}
  `;

  await sendEmail({
    to,
    subject: `Shipment Cancelled — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness shipment has been cancelled.",
    }),
  });
};

export const sendSubscriptionChargeReceiptEmail = async ({
  to,
  name,
  orderId,
  amount,
  subscriptionId,
}) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `We received your subscription payment successfully for order <strong>#${formatOrderRef(orderId)}</strong>.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([
            { label: "Subscription ID", value: subscriptionId },
            { label: "Amount Charged", value: formatCurrency(amount) },
          ])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("Thank you for continuing your wellness journey with BREE.")}
  `;

  await sendEmail({
    to,
    subject: `Subscription Renewal Received — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness subscription payment was received.",
    }),
  });
};

export const sendSubscriptionActivationEmail = async ({
  to,
  name,
  orderId,
  amount,
  subscriptionId,
}) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your subscription for order <strong>#${formatOrderRef(orderId)}</strong> is now active.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([
            { label: "Subscription ID", value: subscriptionId },
            { label: "Amount", value: formatCurrency(amount) },
          ])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("Thank you for choosing BREE Wellness.")}
  `;

  await sendEmail({
    to,
    subject: `Subscription Activated — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness subscription is now active.",
    }),
  });
};

export const sendSubscriptionFailedEmail = async ({
  to,
  name,
  orderId,
  subscriptionId,
  notes,
}) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your subscription payment for order <strong>#${formatOrderRef(orderId)}</strong> could not be processed.<br/>Please update your payment details or contact support to avoid interruption.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([
            { label: "Subscription ID", value: subscriptionId },
            { label: "Details", value: notes },
          ])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("— The BREE Team")}
  `;

  await sendEmail({
    to,
    subject: `Subscription Payment Failed — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "We couldn't process your BREE Wellness subscription payment.",
    }),
  });
};

export const sendSubscriptionCancellationEmail = async ({
  to,
  name,
  orderId,
  subscriptionId,
}) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your subscription for order <strong>#${formatOrderRef(orderId)}</strong> has been cancelled.<br/>If you wish to restart your plan, you can subscribe again anytime from your account.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([{ label: "Subscription ID", value: subscriptionId }])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("— The BREE Team")}
  `;

  await sendEmail({
    to,
    subject: `Subscription Cancelled — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness subscription has been cancelled.",
    }),
  });
};

export const sendSubscriptionResumeEmail = async ({
  to,
  name,
  orderId,
  subscriptionId,
}) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your subscription for order <strong>#${formatOrderRef(orderId)}</strong> has been resumed.<br/>We will continue delivering your monthly wellness plan as scheduled.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([{ label: "Subscription ID", value: subscriptionId }])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("— The BREE Team")}
  `;

  await sendEmail({
    to,
    subject: `Subscription Resumed — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness subscription has been resumed.",
    }),
  });
};

export const sendSubscriptionPauseEmail = async ({
  to,
  name,
  orderId,
  subscriptionId,
}) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your subscription for order <strong>#${formatOrderRef(orderId)}</strong> has been paused.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([{ label: "Subscription ID", value: subscriptionId }])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("You can resume your subscription whenever you are ready.")}
  `;

  await sendEmail({
    to,
    subject: `Subscription Paused — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness subscription has been paused.",
    }),
  });
};

export const sendSubscriptionHaltedEmail = async ({
  to,
  name,
  orderId,
  subscriptionId,
  notes,
}) => {
  const frontendUrl = getFrontendUrl();

  const content = `
    ${buildIntro({
      name,
      heading: `Hi ${name || "there"},`,
      subtext: `Your subscription for order <strong>#${formatOrderRef(orderId)}</strong> has been halted because recurring payment could not be completed.`,
    })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 24px;">
          ${buildOrderInfoCard({ orderId })}
          ${buildInfoCard([
            { label: "Subscription ID", value: subscriptionId },
            { label: "Details", value: notes },
          ])}
          ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
        </td>
      </tr>
    </table>
    ${buildSignOff("Please contact support if you need help restarting your subscription.")}
  `;

  await sendEmail({
    to,
    subject: `Subscription Halted — BREE #${formatOrderRef(orderId)}`,
    html: buildBrandedEmail({
      frontendUrl,
      content,
      preheader: "Your BREE Wellness subscription has been halted.",
    }),
  });
};
