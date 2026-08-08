import { Router } from "express";
import adminAuth from "../../middleware/adminAuth.js";
import {
  getBulkBookings,
  getBulkBooking,
  updateBulkBooking,
  getBulkBookingStats,
  sharePaymentLink,
  sendBulkConfirmation,
  sendBulkDispatch,
} from "../../controllers/bulkController.js";

const router = Router();

// Protect all Bulk Booking admin routes
router.use(adminAuth);

/* ==========================================================================
   Bulk Bookings Management
   ========================================================================== */

// GET /api/admin/bulk-bookings
// List all bulk bookings with pagination, search, and filters
router.get("/bulk-bookings", getBulkBookings);

// GET /api/admin/bulk-bookings/stats
// Dashboard statistics for bulk bookings
router.get("/bulk-bookings/stats", getBulkBookingStats);

// GET /api/admin/bulk-bookings/:id
// Get a single bulk booking by ID
router.get("/bulk-bookings/:id", getBulkBooking);

// PUT /api/admin/bulk-bookings/:id
// Update booking status, quote price, delivery date, and admin notes.
// Setting status = "confirmed" triggers the full confirm-and-create-order
// workflow (see bulkController.updateBulkBooking).
router.put("/bulk-bookings/:id", updateBulkBooking);

// POST /api/admin/bulk-bookings/:id/share-payment-link
// Generate a Razorpay order for the approved quote and notify the customer.
// New route — additive only, existing routes above are unchanged.
router.post("/bulk-bookings/:id/share-payment-link", sharePaymentLink);

// FIX (audit): the admin UI (BulkOrders.js COMMUNICATION_ENDPOINTS) has
// always called these two — they just never existed on the backend.
router.post("/bulk-bookings/:id/send-confirmation", sendBulkConfirmation);
router.post("/bulk-bookings/:id/send-dispatch", sendBulkDispatch);

export default router;
