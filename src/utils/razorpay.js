import crypto from "crypto";

/**
 * Verify Razorpay payment signature.
 * Used for:
 *  - One-time payments
 *  - Subscriptions
 */
export const verifyPaymentSignature = ({
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
  razorpay_subscription_id,
}) => {
  const body = razorpay_subscription_id
    ? `${razorpay_payment_id}|${razorpay_subscription_id}`
    : `${razorpay_order_id}|${razorpay_payment_id}`;

  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  if (!razorpay_signature) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const signatureBuffer = Buffer.from(razorpay_signature, "utf8");

  // timingSafeEqual requires equal-length buffers
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
};

/**
 * Verify Razorpay webhook signature.
 * body MUST be the raw request body (Buffer/string).
 */
export const verifyWebhookSignature = (body, signature) => {
  if (!signature) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const signatureBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
};
