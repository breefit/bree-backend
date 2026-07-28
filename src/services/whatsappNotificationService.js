import axios from "axios";

/*
|--------------------------------------------------------------------------
| Waplify API Configuration
|--------------------------------------------------------------------------
*/

const WAPLIFY_BASE_URL =
  process.env.WAPLIFY_BASE_URL || "https://server.waplify.io";

const WAPLIFY_API_KEY = process.env.WAPLIFY_API_KEY;

const WAPLIFY_MESSAGES_ENDPOINT = "/api/v1/messages/send";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/*
|--------------------------------------------------------------------------
| Networking / Retry Constants
|--------------------------------------------------------------------------
|
| Kept as module-level constants (rather than re-declared per call) so
| they are computed once and never reallocated on the hot send path.
|
*/

const REQUEST_TIMEOUT_MS = 10000;

const MAX_RETRIES = 3;

const BASE_RETRY_DELAY_MS = 1000;

const MAX_RETRY_DELAY_MS = 8000;

const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// Axios error codes that indicate a network-level failure (no HTTP
// response was ever received) and are therefore safe to retry.
const RETRYABLE_NETWORK_ERROR_CODES = [
  "ECONNABORTED", // timeout
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
];

const DEFAULT_CONTACT_NAME = "BREE Customer";

/*
|--------------------------------------------------------------------------
| Template Names
|--------------------------------------------------------------------------
|
| Configure these in your .env
|
| Example:
|
| WAPLIFY_TEMPLATE_ORDER_CONFIRMED=order_confirmed
| WAPLIFY_TEMPLATE_ORDER_STATUS=order_status_update
|
| WAPLIFY_TEMPLATE_SUBSCRIPTION_STATUS=subscription_status_update
|
| WAPLIFY_TEMPLATE_PAYMENT_STATUS=payment_status
|
*/

const TEMPLATES = {
  ORDER_CONFIRMED: process.env.WAPLIFY_TEMPLATE_ORDER_CONFIRMED,

  ORDER_STATUS: process.env.WAPLIFY_TEMPLATE_ORDER_STATUS,

  SUBSCRIPTION_STATUS: process.env.WAPLIFY_TEMPLATE_SUBSCRIPTION_STATUS,

  PAYMENT_STATUS: process.env.WAPLIFY_TEMPLATE_PAYMENT_STATUS,
};

// Maps each TEMPLATES key to the env var name that configures it, so
// missing-template errors can name the exact variable to set.
const TEMPLATE_ENV_VAR_NAMES = {
  ORDER_CONFIRMED: "WAPLIFY_TEMPLATE_ORDER_CONFIRMED",
  ORDER_STATUS: "WAPLIFY_TEMPLATE_ORDER_STATUS",
  SUBSCRIPTION_STATUS: "WAPLIFY_TEMPLATE_SUBSCRIPTION_STATUS",
  PAYMENT_STATUS: "WAPLIFY_TEMPLATE_PAYMENT_STATUS",
};

/*
|--------------------------------------------------------------------------
| Axios Instance
|--------------------------------------------------------------------------
|
| A single, reusable Axios instance for all Waplify API calls. Using one
| instance (instead of calling axios.post directly) avoids re-creating
| config on every request and gives us one place to manage the base URL,
| default headers, and timeout.
|
*/

const waplifyClient = axios.create({
  baseURL: WAPLIFY_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    "Content-Type": "application/json",
  },
});

// The API key is attached per-request (rather than baked into the
// instance at module-load time) so that env vars loaded after this
// module is first imported (e.g. in some test setups) are still picked
// up correctly.
waplifyClient.interceptors.request.use((config) => {
  config.headers.Authorization = `Bearer ${WAPLIFY_API_KEY}`;
  return config;
});

/*
|--------------------------------------------------------------------------
| Validation Helpers
|--------------------------------------------------------------------------
*/

/**
 * Validates that the mandatory Waplify credentials (base URL + API key)
 * are present. This is the lightweight check run on every single send,
 * so it intentionally does NOT validate individual templates — a given
 * call only needs the one template it's using, and that is validated
 * separately by {@link validateTemplate}.
 *
 * @throws {Error} If `WAPLIFY_BASE_URL` or `WAPLIFY_API_KEY` is missing.
 */
const validateConfig = () => {
  const errors = [];

  if (!WAPLIFY_BASE_URL || !String(WAPLIFY_BASE_URL).trim()) {
    errors.push("WAPLIFY_BASE_URL missing.");
  }

  if (!WAPLIFY_API_KEY || !String(WAPLIFY_API_KEY).trim()) {
    errors.push("WAPLIFY_API_KEY missing.");
  }

  if (errors.length) {
    throw new Error(errors.join(" "));
  }
};

/**
 * Validates a template name before it is used to send a message.
 *
 * @param {*} templateName - The value to validate.
 * @throws {Error} If `templateName` is missing, empty, or not a string.
 */
const validateTemplate = (templateName) => {
  if (templateName === undefined || templateName === null) {
    throw new Error("WhatsApp template name missing.");
  }

  if (typeof templateName !== "string") {
    throw new Error(
      `WhatsApp template name must be a string, received ${typeof templateName}.`,
    );
  }

  if (!templateName.trim()) {
    throw new Error("WhatsApp template name missing.");
  }
};

// Matches a bare 10-digit Indian mobile number starting with 6-9.
const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

// Matches the same number prefixed with the 91 country code.
const INDIAN_MOBILE_WITH_COUNTRY_CODE_REGEX = /^91[6-9]\d{9}$/;

/**
 * Validates and normalizes an Indian mobile number.
 *
 * Accepts only:
 *   - 10-digit numbers starting with 6-9 (e.g. `9876543210`)
 *   - The same number prefixed with the `91` country code (e.g. `919876543210`)
 *
 * Rejects `null`/`undefined`/empty input, non-numeric input, and any
 * number that is too short, too long, or does not start with a valid
 * Indian mobile prefix.
 *
 * @param {string|number} mobile - Raw mobile number input.
 * @returns {string} The normalized number in `91XXXXXXXXXX` format (no `+`).
 * @throws {Error} A descriptive error if the input is not a valid
 * 10-digit Indian mobile number (optionally prefixed with `91`).
 *
 * @example
 * validateMobile("9876543210");    // -> "919876543210"
 * validateMobile("919876543210");  // -> "919876543210"
 * validateMobile("12345");         // -> throws Error
 */
const validateMobile = (mobile) => {
  if (mobile === null || mobile === undefined) {
    throw new Error("Mobile number is required.");
  }

  const raw = String(mobile).trim();

  if (!raw) {
    throw new Error("Mobile number is required.");
  }

  const digits = raw.replace(/\D/g, "");

  if (!digits) {
    throw new Error(`Invalid mobile number: "${raw}" contains no digits.`);
  }

  if (digits.length < 10) {
    throw new Error(
      `Invalid mobile number: "${raw}" is too short. Expected a 10-digit Indian mobile number.`,
    );
  }

  if (digits.length > 12) {
    throw new Error(
      `Invalid mobile number: "${raw}" is too long. Expected a 10-digit Indian mobile number.`,
    );
  }

  if (INDIAN_MOBILE_REGEX.test(digits)) {
    return `91${digits}`;
  }

  if (INDIAN_MOBILE_WITH_COUNTRY_CODE_REGEX.test(digits)) {
    return digits;
  }

  throw new Error(
    `Invalid mobile number: "${raw}". Expected a 10-digit Indian mobile number starting with 6-9, optionally prefixed with 91.`,
  );
};

// Retained as an alias for backward compatibility with any internal
// callers/tests referencing the previous helper name.
const normalizeMobile = validateMobile;

/**
 * Masks a normalized mobile number for safe logging, revealing only the
 * country code and the last 4 digits.
 *
 * @param {string} mobile - A normalized mobile number (e.g. `919876543210`).
 * @returns {string} The masked number (e.g. `91******3210`), or an empty
 * string if no mobile number was provided.
 *
 * @example
 * maskMobile("916281241187"); // -> "91******1187"
 */
const maskMobile = (mobile) => {
  if (!mobile) {
    return "";
  }

  const value = String(mobile);

  if (value.length <= 6) {
    // Too short to safely partially mask — mask it entirely.
    return "*".repeat(value.length);
  }

  const visiblePrefix = value.slice(0, 2);
  const visibleSuffix = value.slice(-4);
  const maskedLength =
    value.length - visiblePrefix.length - visibleSuffix.length;

  return `${visiblePrefix}${"*".repeat(Math.max(maskedLength, 0))}${visibleSuffix}`;
};

/**
 * Converts an ordered list of template parameters into Waplify's
 * 1-indexed `body_data` / `header_data` object format. Used for both
 * body and header parameters since the transform is identical.
 *
 * Defensive against `null`/`undefined`/non-array input — anything that
 * isn't a non-empty array simply yields `undefined` so the caller can
 * omit the field entirely rather than sending a malformed payload.
 *
 * @param {Array<string|number>} [values] - Ordered parameter values.
 * @returns {Object|undefined} The keyed data object, or `undefined` if
 * no valid values were supplied.
 *
 * @example
 * formatBodyData(["A", "B", "C"]); // -> { "1": "A", "2": "B", "3": "C" }
 */
const formatBodyData = (values) => {
  if (!Array.isArray(values) || !values.length) {
    return undefined;
  }

  const data = {};

  for (let i = 0; i < values.length; i += 1) {
    data[String(i + 1)] = String(values[i] ?? "");
  }

  return data;
};

/**
 * Converts the legacy Meta-style `buttonParameters` (dynamic URL button
 * suffixes) into Waplify's indexed `url_button_data` format, so callers that
 * pass a tracking-link suffix (e.g. an order/subscription UUID) keep
 * working unchanged.
 *
 * Defensive against malformed entries — a button with no `parameters`
 * array (or a non-array value) simply contributes nothing rather than
 * throwing.
 *
 * @param {Array<{subType?: string, sub_type?: string, index?: number|string, parameters?: Array<string|number>}>} [buttonParameters]
 * @returns {Object|undefined} The keyed button data object, or `undefined`
 * if no valid button parameters were supplied.
 */
const formatButtonData = (buttonParameters) => {
  if (!Array.isArray(buttonParameters) || !buttonParameters.length) {
    return undefined;
  }

  const data = {};

  buttonParameters.forEach((button) => {
    if (
      button &&
      Array.isArray(button.parameters) &&
      button.parameters.length > 0
    ) {
      data[String(button.index ?? 0)] = String(button.parameters[0]);
    }
  });

  return Object.keys(data).length ? data : undefined;
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
 * Determines whether a failed Waplify API call is safe to retry.
 *
 * Retries are only appropriate for transient failures: network-level
 * errors (no response received — timeout, connection reset, DNS
 * failure, etc.) and rate limit / server errors (HTTP 429, 500, 502,
 * 503, 504). Other client errors (4xx) — invalid template, bad
 * parameters, auth issues, etc. — are never retried since retrying
 * would fail identically every time.
 *
 * @param {Object} error - The Axios error thrown by the failed request.
 * @returns {boolean} `true` if the request should be retried.
 */
const isRetryableError = (error) => {
  if (!error?.response) {
    // No response at all means a network-level failure. Treat as
    // retryable by default; RETRYABLE_NETWORK_ERROR_CODES is used only
    // to make the intent explicit for common cases (timeouts, resets).
    return true;
  }

  return RETRYABLE_STATUS_CODES.includes(error.response.status);
};

/**
 * Computes how long to wait before the next retry attempt.
 *
 * Honors the API's `Retry-After` header when present (either as a
 * number of seconds or an HTTP date), and otherwise falls back to
 * exponential backoff capped at `MAX_RETRY_DELAY_MS`.
 *
 * @param {Object} error - The Axios error from the failed attempt.
 * @param {number} attempt - The retry attempt number (0-indexed, i.e.
 * the number of attempts already made).
 * @returns {number} Delay in milliseconds before the next attempt.
 */
const getRetryDelayMs = (error, attempt) => {
  const retryAfterHeader = error?.response?.headers?.["retry-after"];

  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);

    if (!Number.isNaN(asSeconds)) {
      return Math.max(asSeconds * 1000, 0);
    }

    const asDate = Date.parse(retryAfterHeader);

    if (!Number.isNaN(asDate)) {
      return Math.max(asDate - Date.now(), 0);
    }
  }

  // Exponential backoff: 1s, 2s, 4s, ... capped at MAX_RETRY_DELAY_MS.
  const exponentialDelay = BASE_RETRY_DELAY_MS * 2 ** attempt;

  return Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
};

/**
 * Extracts a request/trace ID from a Waplify response (success or
 * error), checking the common places an API might surface one.
 *
 * @param {Object} [response] - An Axios response object.
 * @returns {string} The request ID, or `"N/A"` if none was found.
 */
const extractRequestId = (response) => {
  return (
    response?.data?.request_id ||
    response?.data?.id ||
    response?.headers?.["x-request-id"] ||
    "N/A"
  );
};

/**
 * Builds a human-readable error message from a failed Waplify API call,
 * preserving as much detail from the original error as possible.
 *
 * @param {Object} error - The Axios error thrown by the failed request.
 * @param {string} templateName - The template that was being sent.
 * @returns {string} A descriptive error message including HTTP status,
 * template name, request ID, and the underlying Waplify error message.
 */
const buildErrorMessage = (error, templateName) => {
  const status = error?.response?.status ?? "N/A";
  const requestId = extractRequestId(error?.response);
  const waplifyMessage =
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    "Failed to send WhatsApp notification.";

  return `${waplifyMessage} [template=${templateName}, status=${status}, requestId=${requestId}]`;
};

/*
|--------------------------------------------------------------------------
| Generic Template Sender
|--------------------------------------------------------------------------
*/

/**
 * Sends a WhatsApp template message via the Waplify API.
 *
 * Supports optional header parameters (for templates with a text header
 * variable) and optional button parameters (for templates with a
 * dynamic URL/CTA button, e.g. a tracking link suffix), in addition to
 * the standard body parameters. Both are opt-in and fully backward
 * compatible — existing callers that only pass `parameters` (body text)
 * continue to work unchanged.
 *
 * Automatically retries transient failures (network errors, HTTP 429,
 * and HTTP 5xx responses) up to `MAX_RETRIES` times, honoring the
 * `Retry-After` header when present and otherwise using exponential
 * backoff. Other client errors (4xx — invalid template/parameters/auth)
 * are not retried.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's Indian mobile number
 * (`9876543210` or `919876543210`).
 * @param {string} params.templateName - Name of the approved Waplify template.
 * @param {Array<string|number>} [params.parameters] - Ordered body text parameters.
 * @param {Array<string|number>} [params.headerParameters] - Ordered header text
 * parameters, for templates with a text header variable.
 * @param {Array<{subType?: string, index?: number|string, parameters?: Array<string|number>}>} [params.buttonParameters]
 * - Ordered button components (e.g. a URL button's dynamic suffix).
 * @param {string} [params.mediaUrl] - Optional media URL for media-header templates.
 * @returns {Promise<Object>} The raw Waplify API response data.
 * @throws {Error} If config is invalid, the mobile number is invalid, the
 * template name is invalid, or the Waplify API call fails after all
 * retries are exhausted. The thrown error's message includes the HTTP
 * status, template name, request ID, and Waplify's error message.
 *
 * @example
 * await sendTemplateMessage({
 *   mobile: "9876543210",
 *   templateName: "order_confirmed",
 *   parameters: ["Jane Doe", "BREE-100001", "₹999", "28 Jul 2026"],
 * });
 */
export const sendTemplateMessage = async ({
  mobile,
  templateName,
  parameters = [],
  headerParameters,
  buttonParameters,
  mediaUrl,
}) => {
  validateConfig();
  validateTemplate(templateName);

  const formattedMobile = validateMobile(mobile);
  const maskedMobile = maskMobile(formattedMobile);

  const bodyData = formatBodyData(parameters);
  const headerData = formatBodyData(headerParameters);
  const buttonData = formatButtonData(buttonParameters);

  const contactName =
    Array.isArray(parameters) && parameters.length && parameters[0]
      ? String(parameters[0])
      : DEFAULT_CONTACT_NAME;

  const payload = {
    template_name: templateName,

    contact_phone: formattedMobile,

    contact_name: contactName,

    ...(bodyData ? { body_data: bodyData } : {}),

    ...(headerData ? { header_data: headerData } : {}),

    ...(buttonData ? { url_button_data: buttonData } : {}),

    ...(mediaUrl ? { media_url: mediaUrl } : {}),
  };

  console.log(`[WhatsApp] START | ${templateName} | ${maskedMobile}`);

  if (!IS_PRODUCTION) {
    console.log("========== WAPLIFY REQUEST ==========");
    console.log("Template:", templateName);
    console.log("Mobile:", maskedMobile);
    console.log(
      "Request URL:",
      `${WAPLIFY_BASE_URL}${WAPLIFY_MESSAGES_ENDPOINT}`,
    );
    console.log(
      "Payload:",
      JSON.stringify({ ...payload, contact_phone: maskedMobile }, null, 2),
    );
    console.log("======================================");
  }

  const startedAt = Date.now();
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const response = await waplifyClient.post(
        WAPLIFY_MESSAGES_ENDPOINT,
        payload,
      );

      const durationMs = Date.now() - startedAt;
      const requestId = extractRequestId(response);

      if (!IS_PRODUCTION) {
        console.log("========== WAPLIFY RESPONSE ==========");
        console.log("HTTP Status:", response.status);
        console.log("Response Body:", JSON.stringify(response.data, null, 2));
        console.log("=======================================");
      }

      logNotificationSuccess(templateName, maskedMobile, templateName, {
        durationMs,
        requestId,
        statusCode: response.status,
      });

      return response.data;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const shouldRetry = attempt < MAX_RETRIES && isRetryableError(error);
      const requestId = extractRequestId(error?.response);

      if (!shouldRetry) {
        logNotificationFailure(
          templateName,
          maskedMobile,
          templateName,
          error,
          { durationMs, requestId, retryAttempt: attempt },
        );

        throw new Error(buildErrorMessage(error, templateName));
      }

      const delayMs = getRetryDelayMs(error, attempt);
      attempt += 1;

      console.warn(
        `[WhatsApp] RETRY ${attempt}/${MAX_RETRIES} | ${templateName} | ${maskedMobile} | status=${error?.response?.status ?? "network"} | waiting ${delayMs}ms`,
      );

      await sleep(delayMs);
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
 * The `order_confirmed_v2` template has a mandatory dynamic "Track Order"
 * URL button, so `orderUuid` is required (not optional) and is always
 * sent as that button's dynamic suffix. The template rejects the
 * message entirely if the button parameter is missing, so we fail fast
 * here instead of silently sending a payload Waplify will reject.
 *
 * @param {Object} params
 * @param {string|number} params.mobile - Recipient's mobile number.
 * @param {string} params.customerName - Customer's display name.
 * @param {string} params.orderNumber - Order reference number.
 * @param {number|string} params.orderAmount - Order total amount (without currency symbol).
 * @param {string} params.orderDate - Order date.
 * @param {string} params.orderUuid - Order UUID (the `orders.id` primary key,
 * NOT the human-readable order number) for the Track Order button
 * (https://www.breefit.in/order/{orderUuid}/tracking). Required.
 * @returns {Promise<Object>} The Waplify API response data.
 * @throws {Error} "Order UUID is required for the Track Order WhatsApp button."
 * if `orderUuid` is missing or empty. Also throws if `mobile` is invalid
 * or the underlying API call fails after retries.
 *
 * @example
 * await sendOrderConfirmationWhatsApp({
 *   mobile: "9876543210",
 *   customerName: "Jane Doe",
 *   orderNumber: "BREE-100001",
 *   orderAmount: 999,
 *   orderDate: "28 Jul 2026",
 *   orderUuid: "b3f1c2...",
 * });
 */
export const sendOrderConfirmationWhatsApp = async ({
  mobile,
  customerName,
  orderNumber,
  orderAmount,
  orderDate,
  orderUuid,
}) => {
  if (!orderUuid || !String(orderUuid).trim()) {
    throw new Error(
      "Order UUID is required for the Track Order WhatsApp button.",
    );
  }

  const buttonParameters = [
    {
      subType: "url",
      index: 0,
      parameters: [orderUuid],
    },
  ];

  if (!IS_PRODUCTION) {
    console.log("Order UUID:", orderUuid);
    console.log("Button Parameters:", buttonParameters);
  }

  return sendTemplateMessage({
    mobile,
    templateName: TEMPLATES.ORDER_CONFIRMED,
    parameters: [customerName, orderNumber, `₹${orderAmount}`, orderDate],
    buttonParameters,
  });
};

/**
 * Maps an internal order status value to the body message shown in
 * template variable {{4}} of `order_status_update`.
 *
 * @param {string} status - Internal order status value (e.g. "shipped").
 * @returns {string} The status message line, or a generic fallback if
 * the status is unrecognized.
 *
 * @example
 * buildOrderStatusMessage("shipped"); // -> "Your order has been shipped."
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
 *
 * @example
 * getReadableOrderStatus("out_for_delivery"); // -> "Out for Delivery"
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
 * @returns {Promise<Object>} The Waplify API response data.
 * @throws {Error} If `customerName`, `orderNumber`, or `status` is missing,
 * if `mobile` is invalid, or if the underlying API call fails after retries.
 *
 * @example
 * await sendOrderStatusUpdateWhatsApp({
 *   mobile: "9876543210",
 *   customerName: "Jane Doe",
 *   orderNumber: "BREE-100001",
 *   orderUuid: "b3f1c2...",
 *   status: "shipped",
 * });
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
 *
 * @example
 * buildSubscriptionStatusMessage("renewed");
 * // -> "Your subscription has been renewed successfully."
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
 *
 * @example
 * getReadableSubscriptionStatus("payment_failed"); // -> "Payment Failed"
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
 * @returns {Promise<Object>} The Waplify API response data.
 * @throws {Error} If `customerName`, `planName`, or `status` is missing,
 * if `mobile` is invalid, or if the underlying API call fails after retries.
 *
 * @example
 * await sendSubscriptionStatusWhatsApp({
 *   mobile: "9876543210",
 *   customerName: "Jane Doe",
 *   planName: "Wellness Monthly",
 *   subscriptionUuid: "a1b2c3...",
 *   status: "renewed",
 * });
 */
export const sendSubscriptionStatusWhatsApp = async ({
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
            parameters: [`${subscriptionUuid}/manage`],
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
 *
 * @example
 * getReadablePaymentStatus("refunded"); // -> "Refunded"
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
 *
 * @example
 * buildPaymentStatusMessage("pending");
 * // -> "Your payment is currently pending confirmation."
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
 * @returns {Promise<Object>} The Waplify API response data.
 * @throws {Error} If `customerName`, `referenceNumber`, `amount`, or `status`
 * is missing, if `mobile` is invalid, or if the underlying API call fails
 * after retries.
 *
 * @example
 * await sendPaymentStatusWhatsApp({
 *   mobile: "9876543210",
 *   customerName: "Jane Doe",
 *   referenceNumber: "BREE-100001",
 *   amount: 999,
 *   status: "success",
 * });
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
 * @param {string} params.templateName - Name of the approved Waplify template.
 * @param {Array<string|number>} [params.parameters] - Ordered body parameters.
 * @returns {Promise<Object>} The Waplify API response data.
 * @throws {Error} If `mobile` or `templateName` is invalid, or the
 * underlying API call fails after retries.
 *
 * @example
 * await sendCustomWhatsAppNotification({
 *   mobile: "9876543210",
 *   templateName: "welcome_message",
 *   parameters: ["Jane Doe"],
 * });
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
 *
 * @example
 * const { success } = await safelySendWhatsApp("order-confirmed", () =>
 *   sendOrderConfirmationWhatsApp({ ... }),
 * );
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
 *
 * @example
 * const results = await sendBulkWhatsAppNotifications([
 *   { name: "order-1", mobile: "9876543210", templateName: "x", parameters: [] },
 *   { name: "order-2", mobile: "9123456789", templateName: "x", parameters: [] },
 * ]);
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
 * Logs a successful WhatsApp notification send. In production, output is
 * kept to a single concise line (template, masked recipient, status,
 * request ID, duration); verbose multi-line logging is reserved for
 * non-production environments.
 *
 * @param {string} type - Notification type/name.
 * @param {string} mobile - Recipient's mobile number (should already be
 * masked by the caller where possible; raw values are masked here too).
 * @param {string} template - Template name used.
 * @param {Object} [meta] - Optional extra context.
 * @param {number} [meta.durationMs] - Execution time in milliseconds.
 * @param {string} [meta.requestId] - Waplify request/trace ID, if available.
 * @param {number} [meta.statusCode] - HTTP status code of the response.
 *
 * @example
 * logNotificationSuccess("order_status_update", "91******3210", "order_status_update", {
 *   durationMs: 214,
 *   requestId: "req_abc123",
 *   statusCode: 200,
 * });
 */
export const logNotificationSuccess = (type, mobile, template, meta = {}) => {
  const { durationMs, requestId, statusCode } = meta;

  const maskedMobile = maskMobile(mobile);
  const durationSuffix = durationMs != null ? ` | ${durationMs}ms` : "";
  const statusSuffix = statusCode != null ? ` | status=${statusCode}` : "";
  const requestIdSuffix = requestId ? ` | requestId=${requestId}` : "";

  console.log(
    `[WhatsApp] SUCCESS | ${type} | ${maskedMobile} | ${template}${statusSuffix}${requestIdSuffix}${durationSuffix}`,
  );
};

/**
 * Logs a failed WhatsApp notification send, including the underlying
 * Waplify API error message when available. In production, output is
 * kept to a single concise line; the full Waplify response body is only
 * dumped in non-production environments to avoid noisy/sensitive prod logs.
 *
 * @param {string} type - Notification type/name.
 * @param {string} mobile - Recipient's mobile number (masked before logging).
 * @param {string} template - Template name used.
 * @param {Error|Object} error - The error that occurred.
 * @param {Object} [meta] - Optional extra context.
 * @param {number} [meta.durationMs] - Execution time in milliseconds.
 * @param {string} [meta.requestId] - Waplify request/trace ID, if available.
 * @param {number} [meta.retryAttempt] - Number of retry attempts made.
 *
 * @example
 * logNotificationFailure("order_status_update", "91******3210", "order_status_update", error, {
 *   durationMs: 512,
 *   requestId: "req_abc123",
 *   retryAttempt: 3,
 * });
 */
export const logNotificationFailure = (
  type,
  mobile,
  template,
  error,
  meta = {},
) => {
  const { durationMs, requestId, retryAttempt } = meta;

  const maskedMobile = maskMobile(mobile);
  const durationSuffix = durationMs != null ? ` | ${durationMs}ms` : "";
  const statusCode = error?.response?.status ?? "N/A";
  const resolvedRequestId = requestId || extractRequestId(error?.response);
  const retrySuffix = retryAttempt != null ? ` | retries=${retryAttempt}` : "";

  const waplifyErrorMessage =
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    error;

  console.error(
    `[WhatsApp] FAILED | ${type} | ${maskedMobile} | ${template} | status=${statusCode} | requestId=${resolvedRequestId}${retrySuffix}${durationSuffix} | ${waplifyErrorMessage}`,
  );

  if (!IS_PRODUCTION) {
    console.error(error?.response?.data || error?.message || error);
  }
};

/*
|--------------------------------------------------------------------------
| Notification Health Check
|--------------------------------------------------------------------------
*/

/**
 * Validates mandatory Waplify credentials/config, then validates that
 * every configured template env var is present. Unlike the lightweight
 * per-request {@link validateConfig}, this is intended to be called once
 * at application startup to fail fast with a clear, actionable error
 * (rather than discovering a missing template mid-request in production).
 *
 * @returns {boolean} `true` if all mandatory config and templates are present.
 * @throws {Error} If mandatory Waplify credentials are missing, or if any
 * of `WAPLIFY_TEMPLATE_ORDER_CONFIRMED`, `WAPLIFY_TEMPLATE_ORDER_STATUS`,
 * `WAPLIFY_TEMPLATE_SUBSCRIPTION_STATUS`, or `WAPLIFY_TEMPLATE_PAYMENT_STATUS`
 * is missing. The error message lists every missing variable by name.
 *
 * @example
 * validateWhatsAppConfiguration();
 * // throws: "Missing WAPLIFY_TEMPLATE_ORDER_CONFIRMED, WAPLIFY_TEMPLATE_PAYMENT_STATUS"
 */
export const validateWhatsAppConfiguration = () => {
  validateConfig();

  const missingTemplateEnvVars = Object.entries(TEMPLATES)
    .filter(([, value]) => !value || !String(value).trim())
    .map(([key]) => TEMPLATE_ENV_VAR_NAMES[key]);

  if (missingTemplateEnvVars.length) {
    throw new Error(`Missing ${missingTemplateEnvVars.join(", ")}`);
  }

  console.log("================================");
  console.log("WhatsApp Configuration (Waplify)");
  console.log("================================");
  console.log("Base URL:", WAPLIFY_BASE_URL);
  console.log("API Key:", WAPLIFY_API_KEY ? "**** (configured)" : "MISSING");
  console.log("All WhatsApp templates configured.");
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
  sendSubscriptionStatusWhatsApp,
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
