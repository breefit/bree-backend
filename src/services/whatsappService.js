import axios from "axios";

const META_API_VERSION = process.env.META_API_VERSION || "v23.0";
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const OTP_TEMPLATE_NAME = process.env.META_OTP_TEMPLATE_NAME;
const OTP_LANGUAGE_CODE = process.env.META_OTP_LANGUAGE_CODE || "en_US";

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

  try {
    const response = await axios.post(
      getApiUrl(),
      {
        messaging_product: "whatsapp",
        to: formattedMobile,
        type: "template",
        template: {
          name: OTP_TEMPLATE_NAME,
          language: {
            code: OTP_LANGUAGE_CODE,
          },
          components: [
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  text: otp,
                },
              ],
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

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
