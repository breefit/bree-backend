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
| META_TEMPLATE_ORDER_PROCESSING=order_processing
| META_TEMPLATE_ORDER_READY_TO_SHIP=order_ready_to_ship
| META_TEMPLATE_ORDER_SHIPPED=order_shipped
| META_TEMPLATE_ORDER_OUT_FOR_DELIVERY=order_out_for_delivery
| META_TEMPLATE_ORDER_DELIVERED=order_delivered
| META_TEMPLATE_ORDER_CANCELLED=order_cancelled
|
| META_TEMPLATE_SUBSCRIPTION_CREATED=subscription_created
| META_TEMPLATE_SUBSCRIPTION_RENEWED=subscription_renewed
| META_TEMPLATE_SUBSCRIPTION_FAILED=subscription_failed
| META_TEMPLATE_SUBSCRIPTION_CANCELLED=subscription_cancelled
| META_TEMPLATE_SUBSCRIPTION_RESUMED=subscription_resumed
|
*/

const TEMPLATES = {
  ORDER_CONFIRMED: process.env.META_TEMPLATE_ORDER_CONFIRMED,

  ORDER_PROCESSING: process.env.META_TEMPLATE_ORDER_PROCESSING,

  ORDER_READY_TO_SHIP: process.env.META_TEMPLATE_ORDER_READY_TO_SHIP,

  ORDER_SHIPPED: process.env.META_TEMPLATE_ORDER_SHIPPED,

  ORDER_OUT_FOR_DELIVERY: process.env.META_TEMPLATE_ORDER_OUT_FOR_DELIVERY,

  ORDER_DELIVERED: process.env.META_TEMPLATE_ORDER_DELIVERED,

  ORDER_CANCELLED: process.env.META_TEMPLATE_ORDER_CANCELLED,

  ORDER_RETURNED: process.env.META_TEMPLATE_ORDER_RETURNED,

  SUBSCRIPTION_CREATED: process.env.META_TEMPLATE_SUBSCRIPTION_CREATED,

  SUBSCRIPTION_RENEWED: process.env.META_TEMPLATE_SUBSCRIPTION_RENEWED,

  SUBSCRIPTION_FAILED: process.env.META_TEMPLATE_SUBSCRIPTION_FAILED,

  SUBSCRIPTION_CANCELLED: process.env.META_TEMPLATE_SUBSCRIPTION_CANCELLED,

  SUBSCRIPTION_RESUMED: process.env.META_TEMPLATE_SUBSCRIPTION_RESUMED,

  SUBSCRIPTION_PAUSED: process.env.META_TEMPLATE_SUBSCRIPTION_PAUSED,

  SUBSCRIPTION_EXPIRING: process.env.META_TEMPLATE_SUBSCRIPTION_EXPIRING,

  PAYMENT_SUCCESS: process.env.META_TEMPLATE_PAYMENT_SUCCESS,

  PAYMENT_FAILED: process.env.META_TEMPLATE_PAYMENT_FAILED,

  TRACKING_LINK: process.env.META_TEMPLATE_TRACKING_LINK,

  ORDER_STATUS: process.env.META_TEMPLATE_ORDER_STATUS,
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
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {number|string} params.orderAmount - Order total amount (without currency symbol).
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendOrderConfirmationWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  orderAmount,
  orderDate,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_CONFIRMED,
    parameters: [customerName, orderNumber, `₹${orderAmount}`, orderDate],
  });
};

/**
 * Sends the "order processing" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendOrderProcessingWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_PROCESSING,
    parameters: [customerName, orderNumber],
  });
};

/**
 * Sends the "ready to ship" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendReadyToShipWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_READY_TO_SHIP,
    parameters: [customerName, orderNumber],
  });
};

/**
 * Sends the "order shipped" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {string} params.courierName - Name of the courier partner.
 * @param {string} params.trackingNumber - Shipment tracking/AWB number.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendShippedWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  courierName,
  trackingNumber,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_SHIPPED,
    parameters: [customerName, orderNumber, courierName, trackingNumber],
  });
};

/**
 * Sends the "out for delivery" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendOutForDeliveryWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_OUT_FOR_DELIVERY,
    parameters: [customerName, orderNumber],
  });
};

/**
 * Sends the "order delivered" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendDeliveredWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_DELIVERED,
    parameters: [customerName, orderNumber],
  });
};

/**
 * Sends the "order cancelled" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {string} [params.reason] - Cancellation reason. Defaults to "Not specified".
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendOrderCancelledWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  reason,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_CANCELLED,
    parameters: [customerName, orderNumber, reason || "Not specified"],
  });
};

/**
 * Sends the "order returned" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendOrderReturnedWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_RETURNED,
    parameters: [customerName, orderNumber],
  });
};

/*
|--------------------------------------------------------------------------
| Subscription Notifications
|--------------------------------------------------------------------------
*/

/**
 * Sends the "subscription created" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.subscriptionId - Subscription reference ID.
 * @param {string} params.planName - Name of the subscribed plan.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendSubscriptionCreatedWhatsApp = async ({
  mobile,
  customerName,
  subscriptionId,
  planName,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.SUBSCRIPTION_CREATED,
    parameters: [customerName, subscriptionId, planName],
  });
};

/**
 * Sends the "subscription renewed" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.subscriptionId - Subscription reference ID.
 * @param {string} params.planName - Name of the subscribed plan.
 * @param {number|string} params.amount - Renewal amount (without currency symbol).
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendSubscriptionRenewedWhatsApp = async ({
  mobile,
  customerName,
  subscriptionId,
  planName,
  amount,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.SUBSCRIPTION_RENEWED,
    parameters: [customerName, subscriptionId, planName, `₹${amount}`],
  });
};

/**
 * Sends the "subscription payment failed" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.subscriptionId - Subscription reference ID.
 * @param {string} [params.reason] - Failure reason. Defaults to "Payment failed".
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendSubscriptionFailedWhatsApp = async ({
  mobile,
  customerName,
  subscriptionId,
  reason,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.SUBSCRIPTION_FAILED,
    parameters: [customerName, subscriptionId, reason || "Payment failed"],
  });
};

/**
 * Sends the "subscription cancelled" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.subscriptionId - Subscription reference ID.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendSubscriptionCancelledWhatsApp = async ({
  mobile,
  customerName,
  subscriptionId,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.SUBSCRIPTION_CANCELLED,
    parameters: [customerName, subscriptionId],
  });
};

/**
 * Sends the "subscription resumed" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.subscriptionId - Subscription reference ID.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendSubscriptionResumedWhatsApp = async ({
  mobile,
  customerName,
  subscriptionId,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.SUBSCRIPTION_RESUMED,
    parameters: [customerName, subscriptionId],
  });
};

/**
 * Sends the "subscription paused" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.subscriptionId - Subscription reference ID.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendSubscriptionPausedWhatsApp = async ({
  mobile,
  customerName,
  subscriptionId,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.SUBSCRIPTION_PAUSED,
    parameters: [customerName, subscriptionId],
  });
};

/**
 * Sends the "subscription expiring soon" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.subscriptionId - Subscription reference ID.
 * @param {string} params.renewalDate - Upcoming renewal date.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendSubscriptionExpiringWhatsApp = async ({
  mobile,
  customerName,
  subscriptionId,
  renewalDate,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.SUBSCRIPTION_EXPIRING,
    parameters: [customerName, subscriptionId, renewalDate],
  });
};

/*
|--------------------------------------------------------------------------
| Payment Notifications
|--------------------------------------------------------------------------
*/

/**
 * Sends the "payment success" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {number|string} params.amount - Payment amount (without currency symbol).
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendPaymentSuccessWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  amount,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.PAYMENT_SUCCESS,
    parameters: [customerName, orderNumber, `₹${amount}`],
  });
};

/**
 * Sends the "payment failed" WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {number|string} params.amount - Payment amount (without currency symbol).
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendPaymentFailedWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  amount,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.PAYMENT_FAILED,
    parameters: [customerName, orderNumber, `₹${amount}`],
  });
};

/*
|--------------------------------------------------------------------------
| Tracking Notifications
|--------------------------------------------------------------------------
*/

/**
 * Sends the "tracking link" WhatsApp notification.
 *
 * Uses a Meta WhatsApp URL button component to carry the tracking URL
 * (the `TRACKING_LINK` template must be configured with a dynamic URL
 * button) rather than sending the link as plain body text — this gives
 * the customer a tappable "Track Order" style button.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {string} params.courierName - Name of the courier partner.
 * @param {string} params.trackingNumber - Shipment tracking/AWB number.
 * @param {string} params.trackingUrl - Public tracking URL, sent as the
 * dynamic suffix of the template's URL button.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendTrackingLinkWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  courierName,
  trackingNumber,
  trackingUrl,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.TRACKING_LINK,
    parameters: [customerName, orderNumber, courierName, trackingNumber],
    buttonParameters: trackingUrl
      ? [
          {
            subType: "url",
            index: 0,
            parameters: [trackingUrl],
          },
        ]
      : undefined,
  });
};

/*
|--------------------------------------------------------------------------
| Generic Status Notification
|--------------------------------------------------------------------------
*/

/**
 * Sends a generic order status update WhatsApp notification.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {string} params.status - Human-readable status text.
 * @returns {Promise<Object>} The Meta API response data.
 */
export const sendOrderStatusUpdateWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  status,
}) => {
  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_STATUS,
    parameters: [customerName, orderNumber, status],
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
  sendOrderProcessingWhatsApp,
  sendReadyToShipWhatsApp,
  sendShippedWhatsApp,
  sendOutForDeliveryWhatsApp,
  sendDeliveredWhatsApp,
  sendOrderCancelledWhatsApp,
  sendOrderReturnedWhatsApp,
  sendOrderStatusUpdateWhatsApp,
  sendTrackingLinkWhatsApp,

  // Payment Notifications
  sendPaymentSuccessWhatsApp,
  sendPaymentFailedWhatsApp,

  // Subscription Notifications
  sendSubscriptionCreatedWhatsApp,
  sendSubscriptionRenewedWhatsApp,
  sendSubscriptionFailedWhatsApp,
  sendSubscriptionCancelledWhatsApp,
  sendSubscriptionResumedWhatsApp,
  sendSubscriptionPausedWhatsApp,
  sendSubscriptionExpiringWhatsApp,

  // Helpers
  safelySendWhatsApp,
  sendBulkWhatsAppNotifications,
  validateWhatsAppConfiguration,
  logNotificationSuccess,
  logNotificationFailure,
};
