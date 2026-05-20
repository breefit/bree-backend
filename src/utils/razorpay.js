import crypto from 'crypto';

/**
 * Verify Razorpay payment signature.
 * NEVER skip this — it's the only way to confirm a payment is real.
 */
export const verifyPaymentSignature = ({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) => {
  const body     = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  return expected === razorpay_signature;
};

/**
 * Verify Razorpay webhook signature.
 */
export const verifyWebhookSignature = (body, signature) => {
  // `body` should be the raw request body (Buffer or string). Do not
  // JSON.stringify the parsed body — that can change key order/formatting
  // and will cause signature mismatches.
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  return expected === signature;
};
