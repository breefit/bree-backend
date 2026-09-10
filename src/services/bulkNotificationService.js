// ─────────────────────────────────────────────────────────────────────────────
// bulkNotificationService.js
//
// Customer-facing notifications for the Bulk Order workflow:
// New → In Progress → Quoted → Confirmed → Dispatched/Completed, and
// Cancelled.
//
// WHATSAPP: every status update goes through ONE generic Waplify template
// (WAPLIFY_TEMPLATE_BULK_UPDATE) via notifyBulkStatusUpdate(). There are
// deliberately no per-status WhatsApp templates — the template takes a
// status label, a status-specific message, and an optional details/URL
// string, all filled in by the caller. Do not add a new WAPLIFY_TEMPLATE_*
// env var for an individual status; extend the status copy in the relevant
// notify* function below instead.
//
// EMAIL: still one HTML email per notification via the shared transporter
// from services/email.js — transport/infra is unchanged. The HTML template
// has been redesigned to the same BREE branded shell (logo header, teal
// accent, info cards, primary/secondary buttons, dark-teal footer) used in
// orderemailservice.js, so bulk-order emails look consistent with the rest
// of the customer-facing emails. This file still does not touch the email
// infrastructure itself — only the markup returned by the local template
// helpers below.
//
// Deliberately thin otherwise: every send goes through the *existing*
// generic infrastructure (shared transporter, and sendCustomWhatsAppNotification
// / safelySendWhatsApp from whatsappNotificationService.js). No new HTTP
// clients, retry logic, or logging plumbing is introduced here.
//
// PAYMENT FLOW NOTE: Bulk Order payment goes through Razorpay Magic
// Checkout, triggered by the customer clicking "Make Payment" on the quote
// page after approving their quote. There is no admin-side "send payment
// link" step and no separate payment-link notification — the customer
// goes straight from the quote-ready notification to the quote page,
// approves, and pays via Magic Checkout themselves (which also collects
// their final shipping address at that point).
//
// NOTE: There is deliberately no "payment successful" notification here.
// bulkOrderService.js already sends the Order Confirmation notification
// (see notifyBulkOrderConfirmation) immediately after order creation —
// adding a second "payment successful" message would duplicate that
// notification to the customer over both channels.
// ─────────────────────────────────────────────────────────────────────────────

import { transporter } from "./email.js";
import {
  safelySendWhatsApp,
  sendCustomWhatsAppNotification,
} from "./whatsappNotificationService.js";

const getFromAddress = () =>
  process.env.SMTP_FROM ||
  process.env.SMTP_USER ||
  "BREE Wellness <no-reply@breewellness.com>";

const getFrontendUrl = () =>
  (process.env.FRONTEND_URL || "https://breefit.in").replace(/\/$/, "");

const WEBSITE_URL = "https://www.breefit.in/";

/** Minimal HTML-escaping for user-supplied strings interpolated into email templates. */
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );

const formatINR = (amount) => `₹${Number(amount).toLocaleString("en-IN")}`;

const greet = (contactPerson) => escapeHtml(contactPerson || "there");

/** Sends an email via the shared transporter, silently skipping if `to` is missing. */
const sendEmail = async ({ to, subject, html }) => {
  if (!to) {
    console.error(
      "[BULK_EMAIL] Skipping quote notification — missing recipient",
    );
    return;
  }
  await transporter.sendMail({ from: getFromAddress(), to, subject, html });
};

// ==================================================
// BREE brand palette — matches orderemailservice.js
// ==================================================
const COLORS = {
  primary: "#004B52", // dark teal
  text: "#222222", // dark text
  muted: "#666666", // muted text
  bg: "#F7F8F7", // light background
  border: "#E5E5E5",
  white: "#FFFFFF",
};

// ==================================================
// Reusable branded email building blocks
// ==================================================

const buildHeader = () => {
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

const buildIntro = ({ heading, subtext }) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:8px 24px 24px 24px;">
        <h1 style="margin:0 0 16px 0;color:${COLORS.primary};font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;font-weight:700;text-align:center;">
          ${heading}
        </h1>
        <p style="margin:0;color:${COLORS.text};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;text-align:center;">
          ${subtext}
        </p>
      </td>
    </tr>
  </table>
`;

/** Light-teal info card of label/value rows — same shape as orderemailservice.js's buildInfoCard. */
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
 * white container, logo header, body content, footer. Mirrors
 * buildBrandedEmail() in orderemailservice.js so bulk-order emails match
 * the rest of the redesigned email suite.
 */
const buildBrandedEmail = ({ content, preheader }) => `
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
                  ${buildHeader()}
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

/**
 * Confirms a WAPLIFY_TEMPLATE_* env var is set before attempting a send.
 * Logs a distinct warning (vs. a runtime send failure) when it's missing.
 */
const isTemplateConfigured = (templateName, label) => {
  if (!templateName) {
    console.warn(
      `[BULK_NOTIFY] Skipping WhatsApp (${label}) — WAPLIFY template env var not configured`,
    );
    return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Generic WhatsApp status-update sender
//
// ONE Waplify template (WAPLIFY_TEMPLATE_BULK_UPDATE, e.g. "bulk_order_update")
// covers every Bulk Order status. Its four params:
//   {{1}} contactPerson — customer/contact person name
//   {{2}} status        — current customer-facing status label
//   {{3}} message       — status-specific message
//   {{4}} details       — additional info / action / URL (optional)
// ─────────────────────────────────────────────────────────────────────────────
// Returns safelySendWhatsApp's { success, result|error } so callers that
// need to know the outcome (e.g. notifyQuoteReady's per-leg logging) can
// observe it — previously discarded, forcing callers to rely solely on the
// generic [WhatsApp] SUCCESS/FAILED log line to know what happened.
const notifyBulkStatusUpdate = async ({
  mobileNumber,
  contactPerson,
  status,
  message,
  details = "",
}) => {
  const templateName = process.env.WAPLIFY_TEMPLATE_BULK_UPDATE;

  if (!isTemplateConfigured(templateName, "bulk-status-update")) {
    return {
      success: false,
      error: new Error("WAPLIFY_TEMPLATE_BULK_UPDATE not configured"),
    };
  }

  return safelySendWhatsApp("bulk-status-update", () =>
    sendCustomWhatsAppNotification({
      mobile: mobileNumber,
      templateName,
      parameters: [contactPerson || "there", status, message, details],
    }),
  );
};

/**
 * NEW — "Bulk enquiry submitted": sent to the customer right after they
 * submit the enquiry form, confirming it was received (separate from the
 * existing internal admin-notification email, which continues to go to
 * the BREE inbox unchanged).
 */
export const notifyBulkEnquirySubmitted = async ({
  email,
  mobileNumber,
  contactPerson,
  companyName,
}) => {
  try {
    const content = `
      ${buildIntro({
        heading: `Hi ${greet(contactPerson)}, thanks for reaching out!`,
        subtext: `We've received your bulk order enquiry${
          companyName ? ` for <strong>${escapeHtml(companyName)}</strong>` : ""
        }. Our team will review it and share a quotation shortly.`,
      })}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:0 24px;">
            ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
          </td>
        </tr>
      </table>
      ${buildSignOff("Thanks for considering BREE Wellness for your bulk order.")}
    `;

    await sendEmail({
      to: email,
      subject: "We received your Bulk Order enquiry — BREE Wellness",
      html: buildBrandedEmail({
        content,
        preheader: "We've received your BREE Wellness bulk order enquiry.",
      }),
    });
  } catch (err) {
    console.error("[BULK_NOTIFY] enquiry-submitted email failed", err?.message);
  }

  await notifyBulkStatusUpdate({
    mobileNumber,
    contactPerson,
    status: "Enquiry Received",
    message:
      "We have received your bulk order enquiry. Our team will review your requirements and share a quotation shortly.",
    details: companyName || "",
  });
};

/**
 * IN_PROGRESS — "Under Review": sent when a booking moves from New to
 * In Progress, i.e. admin has started working the enquiry but no quote
 * exists yet. WhatsApp-only — there's no dedicated email for this
 * intermediate state.
 */
export const notifyBulkInProgress = async ({ mobileNumber, contactPerson }) => {
  await notifyBulkStatusUpdate({
    mobileNumber,
    contactPerson,
    status: "Under Review",
    message:
      "Our team is currently reviewing your bulk order requirements and preparing your quotation.",
  });
};

/**
 * QUOTED — "Quote ready": sent to the customer when admin shares a
 * quote_price + delivery_date on the booking. Links to the quote/review
 * page, where the customer approves the quote and then pays via Razorpay
 * Magic Checkout ("Make Payment") themselves — this is a quote URL,
 * NOT a payment URL.
 */
export const notifyQuoteReady = async ({
  email,
  mobileNumber,
  contactPerson,
  quotePrice,
  deliveryDate,
  bookingId,
}) => {
  console.log(`[BULK] Quote notification START | bookingId=${bookingId}`);

  const quoteLink = `${getFrontendUrl()}/bulk-order/${bookingId}`;

  try {
    const content = `
      ${buildIntro({
        heading: `Hi ${greet(contactPerson)}, your quote is ready!`,
        subtext:
          "Review the details below and approve your quote whenever you're ready.",
      })}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:0 24px;">
            ${buildInfoCard([
              { label: "Quote Amount", value: formatINR(quotePrice) },
              { label: "Estimated Delivery", value: escapeHtml(deliveryDate) },
            ])}
            ${buildPrimaryButton(quoteLink, "REVIEW YOUR QUOTE")}
            ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
            ${buildSupportingText(
              "Approve your quote on the review page above — payment happens there via secure checkout.",
            )}
          </td>
        </tr>
      </table>
      ${buildSignOff("Thanks for choosing BREE Wellness.")}
    `;

    await sendEmail({
      to: email,
      subject: "Your Bulk Order quote is ready — BREE Wellness",
      html: buildBrandedEmail({
        content,
        preheader: "Your BREE Wellness bulk order quote is ready to review.",
      }),
    });
    console.log(`[BULK] Quote email SUCCESS | bookingId=${bookingId}`);
  } catch (err) {
    console.error(
      `[BULK] Quote email FAILED | bookingId=${bookingId} | ${err?.message}`,
    );
  }

  const whatsappResult = await notifyBulkStatusUpdate({
    mobileNumber,
    contactPerson,
    status: "Quote Ready",
    message: `Quote amount: ${formatINR(quotePrice)}. Estimated delivery: ${deliveryDate}.`,
    details: quoteLink,
  });

  if (whatsappResult?.success) {
    console.log(`[BULK] Quote WhatsApp SUCCESS | bookingId=${bookingId}`);
  } else {
    console.error(
      `[BULK] Quote WhatsApp FAILED | bookingId=${bookingId} | ${whatsappResult?.error?.message || "unknown error"}`,
    );
  }
};

/**
 * CONFIRMED — "Order confirmed": fires once, right after successful
 * payment verification and Order creation in bulkOrderService.js. Also
 * used by admin/BulkOrders.js's "Send Confirmation" button for a manual
 * re-send (e.g. the customer says they never got it) — same content
 * either way.
 */
export const notifyBulkOrderConfirmation = async ({
  email,
  mobileNumber,
  contactPerson,
  orderNumber,
  quotePrice,
}) => {
  try {
    const content = `
      ${buildIntro({
        heading: `Hi ${greet(contactPerson)}, your bulk order is confirmed!`,
        subtext: "Our team will begin processing your order shortly.",
      })}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:0 24px;">
            ${buildInfoCard([
              { label: "Order Number", value: escapeHtml(orderNumber || "-") },
              quotePrice
                ? { label: "Amount", value: formatINR(quotePrice) }
                : null,
            ])}
            ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
          </td>
        </tr>
      </table>
      ${buildSignOff("Thanks for choosing BREE Wellness.")}
    `;

    await sendEmail({
      to: email,
      subject: "Your Bulk Order is confirmed — BREE Wellness",
      html: buildBrandedEmail({
        content,
        preheader: "Your BREE Wellness bulk order is confirmed.",
      }),
    });
  } catch (err) {
    console.error(
      "[BULK_NOTIFY] order-confirmation email failed",
      err?.message,
    );
  }

  await notifyBulkStatusUpdate({
    mobileNumber,
    contactPerson,
    status: "Order Confirmed",
    message:
      "Your payment has been successfully received and your bulk order is now confirmed. Our team will begin processing your order.",
    details: `Order Number: ${orderNumber || "-"}`,
  });
};

/**
 * DISPATCHED / COMPLETED — "Dispatched": admin/BulkOrders.js's "Send
 * Dispatch Details" button, shown once status is "completed". Bulk
 * bookings carry no carrier/AWB/tracking fields today, so this is
 * intentionally a plain dispatch acknowledgement rather than fabricated
 * tracking details.
 */
export const notifyBulkDispatch = async ({
  email,
  mobileNumber,
  contactPerson,
  orderNumber,
}) => {
  try {
    const content = `
      ${buildIntro({
        heading: `Hi ${greet(contactPerson)}, your order is on its way!`,
        subtext:
          "Your bulk order has been dispatched and is on its way to you.",
      })}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:0 24px;">
            ${buildInfoCard([
              { label: "Order Number", value: escapeHtml(orderNumber || "-") },
            ])}
            ${buildSecondaryButton(WEBSITE_URL, "VISIT WEBSITE")}
          </td>
        </tr>
      </table>
      ${buildSignOff("Thanks for choosing BREE Wellness.")}
    `;

    await sendEmail({
      to: email,
      subject: "Your Bulk Order has been dispatched — BREE Wellness",
      html: buildBrandedEmail({
        content,
        preheader: "Your BREE Wellness bulk order has been dispatched.",
      }),
    });
  } catch (err) {
    console.error("[BULK_NOTIFY] dispatch email failed", err?.message);
  }

  await notifyBulkStatusUpdate({
    mobileNumber,
    contactPerson,
    status: "Dispatched",
    message: "Your bulk order has been dispatched and is on its way to you.",
    details: `Order Number: ${orderNumber || "-"}`,
  });
};

/**
 * CANCELLED — "Booking cancelled": sent only after the backend has
 * successfully marked the booking as cancelled (caller's responsibility —
 * this function does not touch booking state itself). WhatsApp-only: no
 * cancellation email exists in the current system, and none is invented
 * here.
 */
export const notifyBulkCancelled = async ({ mobileNumber, contactPerson }) => {
  await notifyBulkStatusUpdate({
    mobileNumber,
    contactPerson,
    status: "Booking Cancelled",
    message: "Your bulk order booking has been cancelled by our team.",
    details:
      "If you have any questions or believe this was cancelled in error, please contact our support team.",
  });
};
