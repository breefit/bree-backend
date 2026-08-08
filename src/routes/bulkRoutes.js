import express from "express";
import {
  createBulkBooking,
  approveBulkQuote,
  getBulkQuoteForApproval,
  verifyBulkPayment,
  getBulkPaymentDetails,
} from "../controllers/bulkController.js";

const router = express.Router();

/* ==========================================================================
   Customer Bulk Booking
   ========================================================================== */

// Create Bulk Booking
router.post("/", createBulkBooking);

// FIX (audit): the quote-approval email links here (bulkNotificationService
// .notifyQuoteReady), but nothing served it — the only pre-approval GET was
// admin-only. Added so the approval page has data to render before the
// customer clicks Approve.
router.get("/:id/quote", getBulkQuoteForApproval);

// Customer approves quotation
router.post("/:id/approve-quote", approveBulkQuote);

// Customer payment page details
router.get("/:id/payment", getBulkPaymentDetails);

// Verify Razorpay payment
router.post("/:id/verify-payment", verifyBulkPayment);

export default router;
