import axios from "axios";

const META_API_VERSION = process.env.META_API_VERSION || "v23.0";
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const OTP_TEMPLATE_NAME = process.env.META_OTP_TEMPLATE_NAME;
const OTP_LANGUAGE_CODE = process.env.META_OTP_LANGUAGE_CODE || "en_US";

// Authentication templates with a "Copy Code" / one-tap autofill URL button
// require a button component (sub_type: "url") whose parameter is the OTP
// itself, since Meta appends it to the template's registered URL suffix.
// Default true because this is what the reported #131008 error requires;
// set META_OTP_HAS_URL_BUTTON=false if your template has no button.
const OTP_HAS_URL_BUTTON = process.env.META_OTP_HAS_URL_BUTTON !== "false";

const validateConfig = () => {
  if (!PHONE_NUMBER_ID) {
    throw new Error("META_PHONE_NUMBER_ID is missing.");
  }

  if (!ACCESS_TOKEN) {
    throw new Error("META_ACCESS_TOKEN is missing.");
  }

  if (!OTP_TEMPLATE_NAME) {
    throw new Error("META_OTP_TEMPLATE_NAME is missing.");
  }
};

const getApiUrl = () =>
  `https://graph.facebook.com/${META_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

export const sendWhatsAppOtp = async (mobile, otp) => {
  validateConfig();

  const formattedMobile = mobile.startsWith("91") ? mobile : `91${mobile}`;
  const apiUrl = getApiUrl();

  // Authentication (OTP) templates only accept a single body parameter (the
  // code itself) plus, if the template was configured with a one-tap
  // autofill button, a matching button component. They do NOT support
  // header/footer parameters the way Utility templates do.
  const components = [
    {
      type: "body",
      parameters: [
        {
          type: "text",
          text: otp,
        },
      ],
    },
  ];

  if (OTP_HAS_URL_BUTTON) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [
        {
          type: "text",
          text: otp,
        },
      ],
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    to: formattedMobile,
    type: "template",
    template: {
      name: OTP_TEMPLATE_NAME,
      language: {
        code: OTP_LANGUAGE_CODE,
      },
      components,
    },
  };

  console.log("[WhatsApp OTP] Template Name:", OTP_TEMPLATE_NAME);
  console.log("[WhatsApp OTP] Language:", OTP_LANGUAGE_CODE);
  console.log("[WhatsApp OTP] Mobile Number:", formattedMobile);
  console.log("[WhatsApp OTP] API URL:", apiUrl);
  console.log(
    "[WhatsApp OTP] Request Payload:",
    JSON.stringify(payload, null, 2),
  );

  try {
    const response = await axios.post(apiUrl, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    console.log(`[WhatsApp OTP] OTP sent successfully to ${formattedMobile}`);

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    console.error(
      "[WhatsApp OTP] Failed:",
      error.response?.data || error.message,
    );

    throw new Error(
      error.response?.data?.error?.message || "Failed to send WhatsApp OTP.",
    );
  }
};

export default {
  sendWhatsAppOtp,
};
