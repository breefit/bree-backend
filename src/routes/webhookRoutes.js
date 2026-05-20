// StaffArc — Razorpay Webhook Handler
// Prepared by: Swaroop | staffarc.in

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// Step 1: Define your webhook endpoint (register this URL in Razorpay dashboard)
router.post('/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {

  // Step 2: Verify the webhook signature (VERY IMPORTANT for security)
  const signature = req.headers['x-razorpay-signature'];
  const secret   = process.env.RAZORPAY_WEBHOOK_SECRET;
  const body     = req.body.toString();

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  // If signatures don't match — reject! Could be a fake request.
  if (signature !== expectedSig) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Step 3: Parse the event
  const event = JSON.parse(body);

  // Step 4: Handle each event type
  switch (event.event) {

    case 'payment.captured':
      await handlePaymentSuccess(event.payload.payment.entity);
      // → Update order status to PAID
      // → Send confirmation email to customer
      // → Trigger fulfillment / shipping
      break;

    case 'payment.failed':
      await handlePaymentFailure(event.payload.payment.entity);
      // → Mark order as FAILED
      // → Send retry notification to customer
      break;

    case 'refund.created':
      await handleRefund(event.payload.refund.entity);
      break;

    default:
      console.log(`Unhandled event: ${event.event}`);
  }

  // Step 5: Always respond 200 OK quickly (within 5 seconds!)
  // If you don't respond in time, Razorpay will retry the webhook.
  res.status(200).json({ received: true });
});