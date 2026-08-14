import { Router } from "express";
import adminAuth from "../../middleware/adminAuth.js";
import {
  getBulkBookings,
  getBulkBooking,
  updateBulkBooking,
  getBulkBookingStats,
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

// POST /api/admin/bulk-bookings/:id/send-confirmation
// Manually resend the bulk order confirmation notification.
router.post("/bulk-bookings/:id/send-confirmation", sendBulkConfirmation);

// POST /api/admin/bulk-bookings/:id/send-dispatch
// Manually send the bulk order dispatch notification.
router.post("/bulk-bookings/:id/send-dispatch", sendBulkDispatch);

export default router;
