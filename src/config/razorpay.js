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

const getCredentialDiagnostics = () => {
  const rawKeyId = process.env.RAZORPAY_KEY_ID;
  const rawKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const keyId = normalizeCredential(rawKeyId);
  const keySecret = normalizeCredential(rawKeySecret);

  return {
    keyIdPresent: Boolean(keyId),
    keyIdPrefix: keyId.slice(0, 9) || null,
    keyIdMasked: keyId ? maskKeyId(keyId) : null,
    keyIdLooksLive: keyId.startsWith("rzp_live_"),
    keyIdLooksTest: keyId.startsWith("rzp_test_"),
    keyIdFormatValid: /^rzp_(live|test)_[A-Za-z0-9]+$/.test(keyId),
    keyIdContainsNonAscii: /[^\x00-\x7F]/.test(keyId),
    keyIdContainsWhitespace: hasCredentialWhitespace(rawKeyId || ""),
    keySecretPresent: Boolean(keySecret),
    keySecretLength: keySecret.length,
    keySecretContainsWhitespace: hasCredentialWhitespace(rawKeySecret || ""),
    keySecretContainsNewline: /[\r\n]/.test(rawKeySecret || ""),
    keySecretWrappedInQuotes:
      typeof rawKeySecret === "string" &&
      rawKeySecret.length >= 2 &&
      ((rawKeySecret.startsWith('"') && rawKeySecret.endsWith('"')) ||
        (rawKeySecret.startsWith("'") && rawKeySecret.endsWith("'"))),
  };
};

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

  if (
    /[\r\n]/.test(process.env.RAZORPAY_KEY_ID || "") ||
    /[\r\n]/.test(process.env.RAZORPAY_KEY_SECRET || "")
  ) {
    throw new Error(
      "Razorpay credentials contain a newline; remove quotes and newlines",
    );
  }

  if (process.env.NODE_ENV === "production" && !keyId.startsWith("rzp_live_")) {
    throw new Error(
      "Production Razorpay configuration must use a live key ID (rzp_live_*)",
    );
  }

  if (!/^rzp_(live|test)_[A-Za-z0-9]+$/.test(keyId)) {
    throw new Error(
      "Razorpay key ID format is invalid; use the exact ASCII key ID from the matching Razorpay account",
    );
  }

  return { keyId, keySecret, mode };
};

export const getSafeRazorpayConfig = () => {
  const diagnostics = getCredentialDiagnostics();
  try {
    const { keyId, keySecret, mode } = getRazorpayConfig();
    return {
      configured: true,
      mode,
      ...diagnostics,
    };
  } catch (err) {
    return {
      configured: false,
      mode: process.env.NODE_ENV === "production" ? "live" : "test-or-live",
      ...diagnostics,
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
