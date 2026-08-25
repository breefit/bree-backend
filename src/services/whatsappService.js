import axios from "axios";

const WAPLIFY_BASE_URL = (
  process.env.WAPLIFY_BASE_URL || "https://server.waplify.io"
).replace(/\/+$/, "");
const WAPLIFY_API_KEY = process.env.WAPLIFY_API_KEY;
const WAPLIFY_OTP_TEMPLATE = process.env.WAPLIFY_OTP_TEMPLATE || "otp_login";

// Default contact name when no customer name is available. Replace with an
// actual customer name where one is known, e.g. contact_name: customerName || DEFAULT_CONTACT_NAME
const DEFAULT_CONTACT_NAME = "BREE User";

// Retry configuration for transient/upstream failures.
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const validateConfig = () => {
  if (!WAPLIFY_BASE_URL) {
    throw new Error("WAPLIFY_BASE_URL is missing.");
  }

  if (!WAPLIFY_API_KEY) {
    throw new Error("WAPLIFY_API_KEY is missing.");
  }

  if (!WAPLIFY_API_KEY.startsWith("wapl_")) {
    throw new Error("Invalid WAPLIFY_API_KEY format.");
  }

  if (!WAPLIFY_OTP_TEMPLATE) {
    throw new Error("WAPLIFY_OTP_TEMPLATE is missing.");
  }
};

const validateInput = (mobile, otp) => {
  if (!mobile) {
    throw new Error("Mobile number is required.");
  }

  if (!otp) {
    throw new Error("OTP is required.");
  }

  // Strip a pre-existing "91" country code prefix (if present) before
  // checking that the underlying subscriber number is exactly 10 digits.
  const bareNumber =
    mobile.startsWith("91") && mobile.length === 12 ? mobile.slice(2) : mobile;

  if (!/^\d{10}$/.test(bareNumber)) {
    throw new Error(
      "Invalid mobile number - expected exactly 10 digits before formatting.",
    );
  }

  if (!/^\d{6}$/.test(otp)) {
    throw new Error("Invalid OTP - expected exactly 6 digits.");
  }
};

const getApiUrl = () => `${WAPLIFY_BASE_URL}/api/v1/messages/send`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Masks all but the first 2 and last 2 digits of the subscriber number.
// Never used for the actual API payload - logging only.
const maskMobile = (formattedMobile) => {
  const countryCode = formattedMobile.slice(0, 2);
  const number = formattedMobile.slice(2);

  if (number.length <= 4) {
    return `+${countryCode} ${"*".repeat(number.length)}`;
  }

  const masked =
    number.slice(0, 2) + "*".repeat(number.length - 4) + number.slice(-2);

  return `+${countryCode} ${masked}`;
};

const getErrorDetails = (error) => {
  const status = error.response?.status;
  const data = error.response?.data;

  return {
    status,
    code: data?.error,
    message: data?.message || error.message || "Failed to send WhatsApp OTP.",
    requestId:
      error.response?.headers?.["x-request-id"] || data?.request_id || null,
  };
};

const describeHttpError = (status) => {
  switch (status) {
    case 400:
      return "Bad request - check template_name, contact_phone, or body_data.";
    case 401:
      return "Unauthorized - WAPLIFY_API_KEY is missing, invalid, or expired.";
    case 403:
      return "Forbidden - action not allowed by Waplify for this request.";
    case 404:
      return "Not found - the template or contact does not exist.";
    case 429:
      return "Rate limit exceeded - too many requests sent too fast.";
    case 500:
      return "Internal server error on Waplify's end.";
    case 502:
      return "Bad gateway from Waplify.";
    case 503:
      return "Waplify service unavailable.";
    case 504:
      return "Gateway timeout from Waplify.";
    default:
      return "Unexpected error from Waplify.";
  }
};

// Resolves how long to wait before retrying a 429. Prefers the Retry-After
// header (seconds); falls back to exponential backoff if absent/invalid.
const resolveRetryDelay = (error, attemptNumber) => {
  const status = error.response?.status;
  const retryAfterHeader = error.response?.headers?.["retry-after"];

  if (status === 429 && retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return retryAfterSeconds * 1000;
    }
  }

  return RETRY_DELAY_MS * attemptNumber;
};

const logAttemptHeader = ({
  templateName,
  formattedMobile,
  apiUrl,
  attemptNumber,
}) => {
  // console.log("========== WAPLIFY OTP ==========");
  // console.log("Template:", templateName);
  // console.log("Phone:", maskMobile(formattedMobile));
  // console.log("API URL:", apiUrl);
  // console.log("Attempt:", attemptNumber);
};

const logSuccess = (response, templateName) => {
  const requestId = response.headers?.["x-request-id"] || null;
  const timestamp = response.data?.timestamp || new Date().toISOString();

  // console.log("Template Name:", templateName);
  // console.log("Request ID:", requestId);
  // console.log("Message ID:", response.data?.message_id);
  // console.log("Status:", response.data?.status);
  // console.log("Response Status:", response.status);
  // console.log("Timestamp:", timestamp);

  // Full response body is verbose - keep production logs concise.
  if (process.env.NODE_ENV !== "production") {
    console.log("Response Data:", response.data);
  }

  // console.log("================================");
};

const logFailure = (error) => {
  const { status, code, message, requestId } = getErrorDetails(error);

  if (status) {
    console.error(`[WAPLIFY OTP] HTTP ${status}: ${describeHttpError(status)}`);
  }
  console.error("[WAPLIFY OTP] Error Code:", code || "N/A");
  console.error("[WAPLIFY OTP] Error Message:", message);
  console.error("[WAPLIFY OTP] Request ID:", requestId || "N/A");
  console.log("================================");
};

// Generic template-message sender: handles the HTTP call, retry policy,
// and logging. Future methods (order confirmation, order status,
// subscription status, payment status, etc.) can reuse this unchanged.
const sendTemplateRequest = async ({
  payload,
  templateName,
  formattedMobile,
}) => {
  const apiUrl = getApiUrl();
  let retryCount = 0;

  while (true) {
    const attemptNumber = retryCount + 1;
    logAttemptHeader({ templateName, formattedMobile, apiUrl, attemptNumber });

    try {
      const response = await axios.post(apiUrl, payload, {
        headers: {
          Authorization: `Bearer ${WAPLIFY_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      });

      logSuccess(response, templateName);

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      logFailure(error);

      const status = error.response?.status;
      const isRetryable = RETRYABLE_STATUS_CODES.includes(status);

      if (isRetryable && retryCount < MAX_RETRIES) {
        const delay = resolveRetryDelay(error, retryCount + 1);
        console.warn(
          `[WAPLIFY OTP] Retrying (${retryCount + 1}/${MAX_RETRIES}) after ${delay}ms due to HTTP ${status}...`,
        );
        await sleep(delay);
        retryCount += 1;
        continue;
      }

      throw new Error(getErrorDetails(error).message);
    }
  }
};

export const sendWhatsAppOtp = async (mobile, otp) => {
  validateConfig();

  mobile = String(mobile).trim();
  otp = String(otp).trim();

  validateInput(mobile, otp);

  const formattedMobile = mobile.startsWith("91") ? mobile : `91${mobile}`;

  const payload = {
    template_name: WAPLIFY_OTP_TEMPLATE,
    contact_phone: formattedMobile,
    contact_name: DEFAULT_CONTACT_NAME,
    // Positional variable "1" carries the OTP. If your approved template
    // uses named variables instead (e.g. {{otp}}), update the key below -
    // the rest of the payload/logic does not need to change.
    body_data: {
      "1": otp,
    },
  };

  return sendTemplateRequest({
    payload,
    templateName: WAPLIFY_OTP_TEMPLATE,
    formattedMobile,
  });
};

export default {
  sendWhatsAppOtp,
};


