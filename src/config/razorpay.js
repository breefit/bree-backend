import Razorpay from "razorpay";

let razorpayInstance = null;

const normalizeCredential = (value) => {
  if (typeof value !== "string") return "";

  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
};

const hasCredentialWhitespace = (value) => /\s/.test(value);

const maskKeyId = (keyId) =>
  keyId.length > 13
    ? `${keyId.slice(0, 9)}...${keyId.slice(-4)}`
    : `${keyId.slice(0, 3)}...`;

export const getRazorpayConfig = () => {
  const keyId = normalizeCredential(process.env.RAZORPAY_KEY_ID);
  const keySecret = normalizeCredential(process.env.RAZORPAY_KEY_SECRET);
  const mode = process.env.NODE_ENV === "production" ? "live" : "test-or-live";

  if (!keyId) {
    throw new Error("RAZORPAY_KEY_ID is missing or empty");
  }

  if (!keySecret) {
    throw new Error("RAZORPAY_KEY_SECRET is missing or empty");
  }

  if (hasCredentialWhitespace(keyId) || hasCredentialWhitespace(keySecret)) {
    throw new Error(
      "Razorpay credentials contain whitespace; remove quotes, spaces, and newlines",
    );
  }

  if (process.env.NODE_ENV === "production" && !keyId.startsWith("rzp_live_")) {
    throw new Error(
      "Production Razorpay configuration must use a live key ID (rzp_live_*)",
    );
  }

  return { keyId, keySecret, mode };
};

export const getSafeRazorpayConfig = () => {
  try {
    const { keyId, keySecret, mode } = getRazorpayConfig();
    return {
      configured: true,
      keyIdPresent: true,
      keyIdMasked: maskKeyId(keyId),
      keySecretPresent: Boolean(keySecret),
      mode,
    };
  } catch (err) {
    return {
      configured: false,
      keyIdPresent: Boolean(normalizeCredential(process.env.RAZORPAY_KEY_ID)),
      keySecretPresent: Boolean(
        normalizeCredential(process.env.RAZORPAY_KEY_SECRET),
      ),
      mode: process.env.NODE_ENV === "production" ? "live" : "test-or-live",
      error: err.message,
    };
  }
};

export const getRazorpay = () => {
  if (razorpayInstance) {
    return razorpayInstance;
  }

  const { keyId, keySecret, mode } = getRazorpayConfig();

  razorpayInstance = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });

  console.info("[RAZORPAY] initialized", {
    keyIdPresent: true,
    keyIdMasked: maskKeyId(keyId),
    keySecretPresent: true,
    mode,
  });

  // console.log("Subscriptions API Available:", !!razorpayInstance.subscriptions);

  // console.log("Pause Method:", typeof razorpayInstance.subscriptions?.pause);

  // console.log("Resume Method:", typeof razorpayInstance.subscriptions?.resume);

  // console.log("Fetch Method:", typeof razorpayInstance.subscriptions?.fetch);

  // console.log("Create Method:", typeof razorpayInstance.subscriptions?.create);

  return razorpayInstance;
};

export default getRazorpay;
