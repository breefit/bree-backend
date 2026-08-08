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
// EMAIL: unchanged from before — still one HTML email per notification via
// the shared transporter from services/email.js. This file intentionally
// does not touch the email infrastructure.
//
// Deliberately thin otherwise: every send goes through the *existing*
// generic infrastructure (shared transporter, and sendCustomWhatsAppNotification
// / safelySendWhatsApp from whatsappNotificationService.js). No new HTTP
// clients, retry logic, or logging plumbing is introduced here.
//
// PAYMENT FLOW NOTE: Bulk Order payment goes through Razorpay Standard
// Checkout, triggered by the customer clicking "Make Payment" on the quote
// page after approving their quote. There is no admin-side "send payment
// link" step and no separate payment-link notification — the customer
// goes straight from the quote-ready notification to the quote page,
// approves, and pays via the standard checkout flow themselves.
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
    console.log("[BULK_EMAIL] Skipping — missing recipient");
    return;
  }
  await transporter.sendMail({ from: getFromAddress(), to, subject, html });
};

const emailShell = (title, bodyHtml) => `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
    <h2 style="color:#047857;">${title}</h2>
    ${bodyHtml}
    <p style="color:#6b7280;font-size:13px;margin-top:28px;">— The BREE Wellness Team</p>
  </div>
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
const notifyBulkStatusUpdate = async ({
  mobileNumber,
  contactPerson,
  status,
  message,
  details = "",
}) => {
  const templateName = process.env.WAPLIFY_TEMPLATE_BULK_UPDATE;

  if (!isTemplateConfigured(templateName, "bulk-status-update")) {
    return;
  }

  await safelySendWhatsApp("bulk-status-update", () =>
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
    await sendEmail({
      to: email,
      subject: "We received your Bulk Order enquiry — BREE Wellness",
      html: emailShell(
        `Hi ${greet(contactPerson)}, thanks for reaching out!`,
        `<p>We've received your bulk order enquiry${
          companyName ? ` for <strong>${escapeHtml(companyName)}</strong>` : ""
        }. Our team will review it and share a quotation shortly.</p>`,
      ),
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
 * Standard Checkout ("Make Payment") themselves — this is a quote URL,
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
  const quoteLink = `${getFrontendUrl()}/bulk-order/${bookingId}`;

  try {
    await sendEmail({
      to: email,
      subject: "Your Bulk Order quote is ready — BREE Wellness",
      html: emailShell(
        `Hi ${greet(contactPerson)}, your quote is ready!`,
        `<p>Quote amount: <strong>${formatINR(quotePrice)}</strong></p>
         <p>Estimated delivery: <strong>${escapeHtml(deliveryDate)}</strong></p>
         <p>Review and approve your quote here: <a href="${quoteLink}">${quoteLink}</a></p>`,
      ),
    });
  } catch (err) {
    console.error("[BULK_NOTIFY] quote-ready email failed", err?.message);
  }

  await notifyBulkStatusUpdate({
    mobileNumber,
    contactPerson,
    status: "Quote Ready",
    message: `Quote amount: ${formatINR(quotePrice)}. Estimated delivery: ${deliveryDate}.`,
    details: quoteLink,
  });
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
    await sendEmail({
      to: email,
      subject: "Your Bulk Order is confirmed — BREE Wellness",
      html: emailShell(
        `Hi ${greet(contactPerson)}, your bulk order is confirmed!`,
        `<p>Order Number: <strong>${escapeHtml(orderNumber || "-")}</strong></p>
         ${quotePrice ? `<p>Amount: <strong>${formatINR(quotePrice)}</strong></p>` : ""}
         <p>Our team will begin processing your order shortly.</p>`,
      ),
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
    await sendEmail({
      to: email,
      subject: "Your Bulk Order has been dispatched — BREE Wellness",
      html: emailShell(
        `Hi ${greet(contactPerson)}, your order is on its way!`,
        `<p>Order Number: <strong>${escapeHtml(orderNumber || "-")}</strong></p>
         <p>Your bulk order has been dispatched and is on its way to you.</p>`,
      ),
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
