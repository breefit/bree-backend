import express from "express";
import auth from "../middleware/auth.js";
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

// Create Bulk Booking — login required (same `auth` middleware every other
// authenticated route uses; mirrors subscriptionRouter.post("/create", auth, ...)).
// Everything downstream of an already-created booking (quote view/approval,
// payment, verification — reached via the booking's own id, e.g. from an
// emailed link) stays public/unauthenticated, unchanged.
router.post("/", auth, createBulkBooking);

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
