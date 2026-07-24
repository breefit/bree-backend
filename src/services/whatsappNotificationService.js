import axios from "axios";

/*
|--------------------------------------------------------------------------
| Meta WhatsApp Cloud API Configuration
|--------------------------------------------------------------------------
*/

const META_API_VERSION = process.env.META_API_VERSION || "v23.0";

const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

const LANGUAGE_CODE = process.env.META_DEFAULT_LANGUAGE || "en";

/*
|--------------------------------------------------------------------------
| Template Names
|--------------------------------------------------------------------------
|
| Configure these in your .env
|
| Example:
|
| META_TEMPLATE_ORDER_CONFIRMED=order_confirmed
| META_TEMPLATE_ORDER_STATUS=order_status_update
|
| META_TEMPLATE_SUBSCRIPTION_STATUS=subscription_status_update
|
| META_TEMPLATE_PAYMENT_STATUS=payment_status
|
*/

const TEMPLATES = {
  ORDER_CONFIRMED: process.env.META_TEMPLATE_ORDER_CONFIRMED,

  ORDER_STATUS: process.env.META_TEMPLATE_ORDER_STATUS,

  SUBSCRIPTION_STATUS: process.env.META_TEMPLATE_SUBSCRIPTION_STATUS,

  PAYMENT_STATUS: process.env.META_TEMPLATE_PAYMENT_STATUS,
};

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

/**
 * Validates that all mandatory Meta WhatsApp Cloud API credentials/config
 * are present and non-empty. Throws a single, combined, meaningful error
 * listing every missing value.
 *
 * @throws {Error} If any mandatory config value is missing or empty.
 */
const validateConfig = () => {
  const errors = [];

  if (!PHONE_NUMBER_ID || !String(PHONE_NUMBER_ID).trim()) {
    errors.push("META_PHONE_NUMBER_ID missing.");
  }

  if (!ACCESS_TOKEN || !String(ACCESS_TOKEN).trim()) {
    errors.push("META_ACCESS_TOKEN missing.");
  }

  if (!META_API_VERSION || !String(META_API_VERSION).trim()) {
    errors.push("META_API_VERSION missing.");
  }

  if (!LANGUAGE_CODE || !String(LANGUAGE_CODE).trim()) {
    errors.push("META_DEFAULT_LANGUAGE missing.");
  }

  if (errors.length) {
    throw new Error(errors.join(" "));
  }
};

const getApiUrl = () =>
  `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

/**
 * Normalizes and validates an Indian mobile number.
 *
 * Accepts:
 *   - 10-digit numbers starting with 6-9 (e.g. 9876543210)
 *   - The same number prefixed with the 91 country code (e.g. 919876543210)
 *
 * Any other format (wrong length, non-Indian prefix, invalid leading
 * digit, non-numeric input, etc.) is rejected.
 *
 * @param {string|number} mobile - Raw mobile number input.
 * @returns {string} The normalized number in `91XXXXXXXXXX` format.
 * @throws {Error} "Invalid mobile number." if the input does not match
 * a valid Indian mobile number format.
 */
const normalizeMobile = (mobile) => {
  const digits = String(mobile ?? "")
    .trim()
    .replace(/\D/g, "");

  // 10-digit Indian mobile number starting with 6, 7, 8, or 9
  if (/^[6-9]\d{9}$/.test(digits)) {
    return `91${digits}`;
  }

  // Already prefixed with the 91 country code
  if (/^91[6-9]\d{9}$/.test(digits)) {
    return digits;
  }

  throw new Error("Invalid mobile number.");
};

const buildParameters = (values = []) =>
  values.map((value) => ({
    type: "text",
    text: String(value ?? ""),
  }));

/**
 * Builds the `components` array for a Meta template message payload,
 * optionally including a header component and one or more button
 * components alongside the always-present body component.
 *
 * @param {Object} options
 * @param {Array<string|number>} [options.bodyParameters] - Ordered body text parameters.
 * @param {Array<string|number>} [options.headerParameters] - Ordered header text parameters
 * (used only when the template has a text header variable).
 * @param {Array<{subType?: string, sub_type?: string, index?: number|string, parameters?: Array<string|number>}>} [options.buttonParameters]
 * - Ordered button components, e.g. a URL/CTA button with a dynamic suffix.
 * @returns {Array<Object>} Components array ready to send to the Meta API.
 */
const buildComponents = ({
  bodyParameters = [],
  headerParameters,
  buttonParameters,
} = {}) => {
  const components = [];

  if (headerParameters && headerParameters.length) {
    components.push({
      type: "header",
      parameters: buildParameters(headerParameters),
    });
  }

  components.push({
    type: "body",
    parameters: buildParameters(bodyParameters),
  });

  if (buttonParameters && buttonParameters.length) {
    buttonParameters.forEach((button, index) => {
      components.push({
        type: "button",
        sub_type: button.subType || button.sub_type || "url",
        index: String(button.index ?? index),
        parameters: buildParameters(button.parameters || []),
      });
    });
  }

  return components;
};

/**
 * Resolves after the given number of milliseconds. Used to back off
 * between retry attempts.
 *
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Determines whether a failed Meta API call is safe to retry.
 *
 * Retries are only appropriate for transient failures: network-level
 * errors (no response received, e.g. timeout/connection reset) and
 * HTTP 5xx server errors. Client errors (4xx) — invalid template,
 * bad parameters, auth issues, etc. — are never retried since retrying
 * would fail identically every time.
 *
 * @param {Object} error - The Axios error thrown by the failed request.
 * @returns {boolean} `true` if the request should be retried.
 */
const isRetryableError = (error) => {
  if (!error?.response) {
    // No response at all means a network-level failure (timeout, DNS,
    // connection reset, etc.) — safe to retry.
    return true;
  }

  const status = error.response.status;

  return status >= 500 && status <= 599;
};

/**
 * Logs that a WhatsApp send attempt is starting. Kept separate from
 * success/failure logging so request lifecycles are easy to trace.
 *
 * @param {string} templateName - Template being sent.
 * @param {string} mobile - Normalized recipient mobile number.
 */
const logRequestStart = (templateName, mobile) => {
  console.log(`[WhatsApp] START | ${templateName} | ${mobile}`);
};

/*
|--------------------------------------------------------------------------
| Generic Template Sender
|--------------------------------------------------------------------------
*/

/**
 * Sends a WhatsApp template message via the Meta WhatsApp Cloud API.
 *
 * Supports optional header parameters (for templates with a text header
 * variable) and optional button parameters (for templates with a
 * dynamic URL/CTA button), in addition to the standard body parameters.
 * Both are opt-in and fully backward compatible — existing callers that
 * only pass `parameters` (body text) continue to work unchanged.
 *
 * Automatically retries transient failures (network errors and HTTP 5xx
 * responses) up to 2 times, with a 1-second delay between attempts.
 * Client errors (4xx — invalid template/parameters/auth) are not retried.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's Indian mobile number.
 * @param {string} params.templateName - Name of the approved Meta template.
 * @param {Array<string|number>} [params.parameters] - Ordered body text parameters.
 * @param {Array<string|number>} [params.headerParameters] - Ordered header text
 * parameters, for templates with a text header variable.
 * @param {Array<{subType?: string, index?: number|string, parameters?: Array<string|number>}>} [params.buttonParameters]
 * - Ordered button components (e.g. a URL button's dynamic suffix).
 * @returns {Promise<Object>} The raw Meta API response data.
 * @throws {Error} If config is invalid, the mobile number is invalid, or
 * the Meta API call fails after all retries are exhausted.
 */
export const sendTemplateMessage = async ({
  mobile,
  templateName,
  parameters = [],
  headerParameters,
  buttonParameters,
}) => {
  validateConfig();

  if (!templateName) {
    throw new Error("WhatsApp template name missing.");
  }

  const formattedMobile = normalizeMobile(mobile);

  const payload = {
    messaging_product: "whatsapp",

    to: formattedMobile,

    type: "template",

    template: {
      name: templateName,

      language: {
        code: LANGUAGE_CODE,
      },

      components: buildComponents({
        bodyParameters: parameters,
        headerParameters,
        buttonParameters,
      }),
    },
  };

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 1000;

  logRequestStart(templateName, formattedMobile);

  const startedAt = Date.now();
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      console.log("========== META REQUEST ==========");
      console.log("Template:", templateName);
      console.log("Mobile:", formattedMobile);
      console.log("Payload:", JSON.stringify(payload, null, 2));
      console.log("=================================");
      const response = await axios.post(getApiUrl(), payload, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },

        timeout: 10000,
      });

      logNotificationSuccess(templateName, formattedMobile, templateName, {
        durationMs: Date.now() - startedAt,
      });

      return response.data;
    } catch (error) {
      const shouldRetry = attempt < MAX_RETRIES && isRetryableError(error);

      if (!shouldRetry) {
        logNotificationFailure(
          templateName,
          formattedMobile,
          templateName,
          error,
          { durationMs: Date.now() - startedAt },
        );

        throw new Error(
          error.response?.data?.error?.message ||
            error.message ||
            "Failed to send WhatsApp notification.",
        );
      }

      attempt += 1;

      console.warn(
        `[WhatsApp] RETRY ${attempt}/${MAX_RETRIES} | ${templateName} | ${formattedMobile}`,
      );

      await sleep(RETRY_DELAY_MS);
    }
  }
};

/*
|--------------------------------------------------------------------------
| Order Notifications
|--------------------------------------------------------------------------
*/

/**
 * Sends the "order confirmed" WhatsApp notification.
 *
 * The `order_confirmed` template now carries a dynamic "Track Order"
 * URL button, so an optional `orderUuid` is accepted and passed as the
 * button's dynamic suffix. Existing body parameters are unchanged.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {number|string} params.orderAmount - Order total amount (without currency symbol).
 * @param {string} params.orderDate - Order date.
 * @param {string} [params.orderUuid] - Order UUID for the Track Order button
 * (https://www.breefit.in/order/{orderUuid}/tracking). Button is omitted if not provided.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendOrderConfirmationWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  orderAmount,
  orderDate,
  orderUuid,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_CONFIRMED,
    parameters: [customerName, orderNumber, `₹${orderAmount}`, orderDate],
    buttonParameters: orderUuid
      ? [
          {
            subType: "url",
            index: 0,
            parameters: [orderUuid],
          },
        ]
      : undefined,
  });
};

/**
 * Maps an internal order status value to the body message shown in
 * template variable {{4}} of `order_status_update`.
 *
 * @param {string} status - Internal order status value (e.g. "shipped").
 * @returns {string} The status message line, or a generic fallback if
 * the status is unrecognized.
 */
export const buildOrderStatusMessage = (status) => {
  const messages = {
    pending_payment: "Your order has been placed and is awaiting payment.",
    paid: "Payment received successfully. Your order has been confirmed.",
    processing: "Our team has started preparing your order.",
    ready_to_ship: "Your order has been packed and is ready for shipment.",
    shipped: "Your order has been shipped.",
    out_for_delivery: "Your order is out for delivery.",
    delivered: "Your order has been delivered successfully.",
    cancelled: "Your order has been cancelled.",
    returned: "Your returned order has been received.",
  };

  return messages[status] || "Your order status has been updated.";
};

/**
 * Maps an internal order status value to the human-readable label shown
 * in template variable {{3}} of `order_status_update`.
 *
 * @param {string} status - Internal order status value (e.g. "out_for_delivery").
 * @returns {string} The readable label, or a title-cased fallback if
 * the status is unrecognized.
 */
export const getReadableOrderStatus = (status) => {
  const labels = {
    pending_payment: "Pending Payment",
    paid: "Confirmed",
    processing: "Processing",
    ready_to_ship: "Ready to Ship",
    shipped: "Shipped",
    out_for_delivery: "Out for Delivery",
    delivered: "Delivered",
    cancelled: "Cancelled",
    returned: "Returned",
  };

  if (labels[status]) {
    return labels[status];
  }

  return String(status || "Updated")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

/**
 * Sends the consolidated order status update WhatsApp notification via
 * the `order_status_update` template. This single function replaces the
 * previous per-status senders and should be called for every order
 * status change after the initial order confirmation.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number (e.g. BREE-100001).
 * @param {string} [params.orderUuid] - Order UUID, sent as the tracking button's
 * dynamic URL suffix (https://www.breefit.in/order/{orderUuid}/tracking).
 * The button is omitted entirely if this is not provided.
 * @param {string} params.status - Internal order status value (e.g. "shipped").
 * @returns {Promise<Object>} The Meta API response data.
 * @throws {Error} If `customerName`, `orderNumber`, or `status` is missing.
 */
export const sendOrderStatusUpdateWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  orderUuid,
  status,
}) => {
  if (!customerName || !String(customerName).trim()) {
    throw new Error("customerName is required");
  }

  if (!orderNumber || !String(orderNumber).trim()) {
    throw new Error("orderNumber is required");
  }

  if (!status || !String(status).trim()) {
    throw new Error("status is required");
  }

  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_STATUS,
    parameters: [
      customerName,
      orderNumber,
      getReadableOrderStatus(status),
      buildOrderStatusMessage(status),
    ],
    buttonParameters: orderUuid
      ? [
          {
            subType: "url",
            index: 0,
            parameters: [orderUuid],
          },
        ]
      : undefined,
  });
};

/*
|--------------------------------------------------------------------------
| Subscription Notifications
|--------------------------------------------------------------------------
*/

/**
 * Maps an internal subscription status/event value to the body message
 * shown in template variable {{4}} of `subscription_status_update`.
 *
 * @param {string} status - Internal subscription status value (e.g. "renewed").
 * @returns {string} The status message line, or a generic fallback if
 * the status is unrecognized.
 */
export const buildSubscriptionStatusMessage = (status) => {
  const messages = {
    created: "Your subscription has been activated successfully.",
    renewed: "Your subscription has been renewed successfully.",
    payment_failed:
      "We couldn't process your subscription payment. Please update your payment method.",
    paused: "Your subscription has been paused successfully.",
    resumed: "Your subscription has been resumed successfully.",
    cancelled: "Your subscription has been cancelled successfully.",
    expiring:
      "Your subscription will expire soon. Please renew it to continue enjoying your benefits.",
  };

  return messages[status] || "Your subscription status has been updated.";
};

/**
 * Maps an internal subscription status/event value to the human-readable
 * label shown in template variable {{3}} of `subscription_status_update`.
 *
 * @param {string} status - Internal subscription status value (e.g. "payment_failed").
 * @returns {string} The readable label, or a title-cased fallback if
 * the status is unrecognized.
 */
export const getReadableSubscriptionStatus = (status) => {
  const labels = {
    created: "Active",
    renewed: "Renewed",
    payment_failed: "Payment Failed",
    paused: "Paused",
    resumed: "Active",
    cancelled: "Cancelled",
    expiring: "Expiring Soon",
  };

  if (labels[status]) {
    return labels[status];
  }

  return String(status || "Updated")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

/**
 * Sends the consolidated subscription status update WhatsApp
 * notification via the `subscription_status_update` template. This
 * single function replaces the previous per-event senders (created,
 * renewed, payment failed, paused, resumed, cancelled, expiring) and
 * should be called for every subscription status change.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.planName - Name of the subscribed plan.
 * @param {string} [params.subscriptionUuid] - Subscription UUID, sent as the
 * "Manage Subscription" button's dynamic URL suffix
 * (https://www.breefit.in/subscriptions/{subscriptionUuid}). The button
 * is omitted entirely if this is not provided.
 * @param {string} params.status - Internal subscription status value (e.g. "renewed").
 * @returns {Promise<Object>} The Meta API response data.
 * @throws {Error} If `customerName`, `planName`, or `status` is missing.
 */
export const sendSubscriptionStatusUpdateWhatsApp = async ({
  mobile,
  customerName,
  planName,
  subscriptionUuid,
  status,
}) => {
  if (!customerName || !String(customerName).trim()) {
    throw new Error("customerName is required");
  }

  if (!planName || !String(planName).trim()) {
    throw new Error("planName is required");
  }

  if (!status || !String(status).trim()) {
    throw new Error("status is required");
  }

  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.SUBSCRIPTION_STATUS,
    parameters: [
      customerName,
      planName,
      getReadableSubscriptionStatus(status),
      buildSubscriptionStatusMessage(status),
    ],
    buttonParameters: subscriptionUuid
      ? [
          {
            subType: "url",
            index: 0,
            parameters: [subscriptionUuid],
          },
        ]
      : undefined,
  });
};

/*
|--------------------------------------------------------------------------
| Payment Notifications
|--------------------------------------------------------------------------
*/

/**
 * Maps an internal payment status value to the human-readable label
 * shown in template variable {{3}} of `payment_status`.
 *
 * @param {string} status - Internal payment status value (e.g. "refunded").
 * @returns {string} The readable label, or a title-cased fallback if
 * the status is unrecognized.
 */
export const getReadablePaymentStatus = (status) => {
  const labels = {
    success: "Success",
    failed: "Failed",
    pending: "Pending",
    refunded: "Refunded",
  };

  if (labels[status]) {
    return labels[status];
  }

  return String(status || "Updated")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

/**
 * Maps an internal payment status value to the body message shown in
 * template variable {{5}} of `payment_status`.
 *
 * @param {string} status - Internal payment status value (e.g. "pending").
 * @returns {string} The status message line, or a generic fallback if
 * the status is unrecognized.
 */
export const buildPaymentStatusMessage = (status) => {
  const messages = {
    success: "Your payment has been received successfully.",
    failed: "Your payment could not be completed. Please try again.",
    pending: "Your payment is currently pending confirmation.",
    refunded: "Your payment has been refunded successfully.",
  };

  return messages[status] || "Your payment status has been updated.";
};

/**
 * Sends the consolidated payment status update WhatsApp notification via
 * the `payment_status` template. This single function replaces the
 * previous per-outcome senders (success, failed) and should be called
 * for every payment status change. `referenceNumber` works for both
 * order numbers and subscription numbers.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.referenceNumber - Order number or subscription number.
 * @param {number|string} params.amount - Payment amount (without currency symbol).
 * @param {string} params.status - Internal payment status value (e.g. "success").
 * @returns {Promise<Object>} The Meta API response data.
 * @throws {Error} If `customerName`, `referenceNumber`, `amount`, or `status` is missing.
 */
export const sendPaymentStatusWhatsApp = async ({
  mobile,
  customerName,
  referenceNumber,
  amount,
  status,
}) => {
  if (!customerName || !String(customerName).trim()) {
    throw new Error("customerName is required");
  }

  if (!referenceNumber || !String(referenceNumber).trim()) {
    throw new Error("referenceNumber is required");
  }

  if (amount === undefined || amount === null || amount === "") {
    throw new Error("amount is required");
  }

  if (!status || !String(status).trim()) {
    throw new Error("status is required");
  }

  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.PAYMENT_STATUS,
    parameters: [
      customerName,
      referenceNumber,
      getReadablePaymentStatus(status),
      `₹${amount}`,
      buildPaymentStatusMessage(status),
    ],
  });
};

/*
|--------------------------------------------------------------------------
| Generic Custom Notification
|--------------------------------------------------------------------------
*/

/**
 * Sends an arbitrary WhatsApp template not covered by a dedicated helper.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.templateName - Name of the approved Meta template.
 * @param {Array<string|number>} [params.parameters] - Ordered body parameters.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendCustomWhatsAppNotification = async ({
  mobile,
  templateName,
  parameters = [],
}) => {
  return sendTemplateMessage({
    mobile,
    templateName,
    parameters,
  });
};

/*
|--------------------------------------------------------------------------
| Safe Notification Wrapper
|--------------------------------------------------------------------------
|
| Sends WhatsApp notifications without breaking the main application flow.
| If WhatsApp fails, the error is logged but not re-thrown.
|
*/

/**
 * Runs a WhatsApp-sending callback without letting failures propagate to
 * the caller. Useful for firing notifications from side-effect flows
 * (order/payment/subscription handlers) where a WhatsApp failure should
 * never break the main application flow.
 *
 * @param {string} notificationName - Human-readable name used for logging.
 * @param {() => Promise<Object>} callback - Function that performs the send.
 * @returns {Promise<{success: boolean, result?: Object, error?: Error}>}
 * An object describing whether the send succeeded.
 */
export const safelySendWhatsApp = async (notificationName, callback) => {
  try {
    const result = await callback();

    logNotificationSuccess(notificationName, "", notificationName);

    return {
      success: true,
      result,
    };
  } catch (error) {
    logNotificationFailure(notificationName, "", notificationName, error);

    return {
      success: false,
      error,
    };
  }
};

/*
|--------------------------------------------------------------------------
| Bulk Notifications
|--------------------------------------------------------------------------
*/

/**
 * Sends multiple WhatsApp notifications concurrently. A failure in one
 * notification never stops the others from being sent — every entry is
 * attempted and a result is returned for each, in the original order.
 *
 * @param {Array<{name: string, mobile: string|number, templateName: string, parameters?: Array<string|number>}>} [notifications]
 * - List of notifications to send.
 * @returns {Promise<Array<{success: boolean, result?: Object, error?: Error}>>}
 * Results in the same order as the input array.
 */
export const sendBulkWhatsAppNotifications = async (notifications = []) => {
  const settled = await Promise.allSettled(
    notifications.map((notification) =>
      safelySendWhatsApp(notification.name, () =>
        sendTemplateMessage({
          mobile: notification.mobile,
          templateName: notification.templateName,
          parameters: notification.parameters || [],
        }),
      ),
    ),
  );

  return settled.map((outcome, index) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }

    // safelySendWhatsApp already catches its own errors, so this branch
    // only triggers on unexpected failures (e.g. a bad notification entry).
    const notification = notifications[index];

    logNotificationFailure(
      notification?.name,
      notification?.mobile,
      notification?.templateName,
      outcome.reason,
    );

    return {
      success: false,
      error: outcome.reason,
    };
  });
};

/*
|--------------------------------------------------------------------------
| Notification Logger
|--------------------------------------------------------------------------
*/

/**
 * Logs a successful WhatsApp notification send.
 *
 * @param {string} type - Notification type/name.
 * @param {string} mobile - Recipient's mobile number.
 * @param {string} template - Template name used.
 * @param {Object} [meta] - Optional extra context.
 * @param {number} [meta.durationMs] - Execution time in milliseconds.
 */
export const logNotificationSuccess = (type, mobile, template, meta = {}) => {
  const { durationMs } = meta;

  const durationSuffix = durationMs != null ? ` | ${durationMs}ms` : "";

  console.log(
    `[WhatsApp] SUCCESS | ${type} | ${mobile} | ${template}${durationSuffix}`,
  );
};

/**
 * Logs a failed WhatsApp notification send, including the underlying
 * Meta API error message when available.
 *
 * @param {string} type - Notification type/name.
 * @param {string} mobile - Recipient's mobile number.
 * @param {string} template - Template name used.
 * @param {Error|Object} error - The error that occurred.
 * @param {Object} [meta] - Optional extra context.
 * @param {number} [meta.durationMs] - Execution time in milliseconds.
 */
export const logNotificationFailure = (
  type,
  mobile,
  template,
  error,
  meta = {},
) => {
  const { durationMs } = meta;

  const durationSuffix = durationMs != null ? ` | ${durationMs}ms` : "";

  const metaErrorMessage =
    error?.response?.data?.error?.message || error?.message || error;

  console.error(
    `[WhatsApp] FAILED | ${type} | ${mobile} | ${template}${durationSuffix} | ${metaErrorMessage}`,
  );

  console.error(error?.response?.data || error?.message || error);
};

/*
|--------------------------------------------------------------------------
| Notification Health Check
|--------------------------------------------------------------------------
*/

/**
 * Validates mandatory Meta credentials/config and reports which optional
 * message templates are configured vs. missing. Only throws when
 * mandatory credentials (phone number ID, access token, API version,
 * language code) are missing — missing templates are reported, not
 * thrown, since not every deployment needs every template.
 *
 * @returns {boolean} `true` if mandatory config is present.
 * @throws {Error} If mandatory Meta credentials/config are missing.
 */
export const validateWhatsAppConfiguration = () => {
  validateConfig();

  console.log("================================");
  console.log("WhatsApp Configuration");
  console.log("================================");

  console.log("API Version:", META_API_VERSION);
  console.log("Phone Number ID:", PHONE_NUMBER_ID);
  console.log("Language:", LANGUAGE_CODE);

  const missingTemplates = Object.entries(TEMPLATES)
    .filter(([, value]) => !value || !String(value).trim())
    .map(([key]) => key);

  if (missingTemplates.length) {
    console.warn(
      "[WhatsApp] Missing template configuration for:",
      missingTemplates.join(", "),
    );
  } else {
    console.log("All WhatsApp templates configured.");
  }

  console.log("================================");

  return true;
};

/*
|--------------------------------------------------------------------------
| Default Export
|--------------------------------------------------------------------------
*/

export default {
  // Generic
  sendTemplateMessage,
  sendCustomWhatsAppNotification,

  // Order Notifications
  sendOrderConfirmationWhatsApp,
  sendOrderStatusUpdateWhatsApp,
  buildOrderStatusMessage,
  getReadableOrderStatus,

  // Subscription Notifications
  sendSubscriptionStatusUpdateWhatsApp,
  buildSubscriptionStatusMessage,
  getReadableSubscriptionStatus,

  // Payment Notifications
  sendPaymentStatusWhatsApp,
  buildPaymentStatusMessage,
  getReadablePaymentStatus,

  // Helpers
  safelySendWhatsApp,
  sendBulkWhatsAppNotifications,
  validateWhatsAppConfiguration,
  logNotificationSuccess,
  logNotificationFailure,
};
