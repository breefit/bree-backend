import { Router } from "express";
import {
  getBulkBookings,
  getBulkBooking,
  updateBulkBooking,
  getBulkBookingStats,
} from "../../controllers/bulkController.js";

const router = Router();

// ── Bulk Bookings Management (Admin only) ──────────────────────────────────────
// GET /api/admin/bulk-bookings - List all bookings with pagination & search
router.get("/bulk-bookings", getBulkBookings);

// GET /api/admin/bulk-bookings/stats - Get bulk booking statistics
router.get("/bulk-bookings/stats", getBulkBookingStats);

// GET /api/admin/bulk-bookings/:id - Get single booking details
router.get("/bulk-bookings/:id", getBulkBooking);

// PUT /api/admin/bulk-bookings/:id - Update booking (status, quote, notes, etc)
router.put("/bulk-bookings/:id", updateBulkBooking);

export default router;
