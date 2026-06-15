import { randomUUID } from "crypto";
import { query } from "../config/database.js";
import transporter from "../services/email.js";

// Valid statuses for bulk bookings
const VALID_STATUSES = [
  "new",
  "in_progress",
  "quoted",
  "confirmed",
  "completed",
  "cancelled",
];

/**
 * Create a new bulk booking from customer form
 */
export const createBulkBooking = async (req, res) => {
  try {
    const {
      companyName,
      contactPerson,
      email,
      mobileNumber,
      location,
      quantity,
      requirements,
    } = req.body;

    if (!companyName || !contactPerson || !email || !mobileNumber) {
      return res.status(400).json({
        message: "Please fill all required fields",
      });
    }

    const bookingId = randomUUID();

    await query(
      `INSERT INTO bulk_bookings
      (
        id,
        company_name,
        contact_person,
        email,
        mobile_number,
        location,
        quantity,
        requirements,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bookingId,
        companyName,
        contactPerson,
        email,
        mobileNumber,
        location,
        quantity || null,
        requirements || null,
        "new",
      ],
    );

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: "bree.fit.india@gmail.com",
      subject: "New Bulk Booking Request",
      html: `
        <h2>New Bulk Booking Request</h2>

        <p><strong>Company:</strong> ${companyName}</p>
        <p><strong>Contact Person:</strong> ${contactPerson}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Mobile:</strong> ${mobileNumber}</p>
        <p><strong>Location:</strong> ${location}</p>
        <p><strong>Quantity:</strong> ${quantity}</p>
        <p><strong>Requirements:</strong> ${requirements}</p>
      `,
    });

    res.status(201).json({
      success: true,
      message:
        "Quote request submitted successfully. Our team will contact you soon.",
    });
  } catch (error) {
    console.error("❌ Error creating bulk booking:", error);

    res.status(500).json({
      message: "Internal server error",
    });
  }
};

/**
 * Get all bulk bookings with pagination and search
 */
export const getBulkBookings = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const search = req.query.search?.trim() || "";

    const offset = (page - 1) * limit;

    let whereClause = "1=1";
    const params = [];

    // Search in company_name, contact_person, email, mobile_number
    if (search) {
      whereClause += ` AND (
        company_name LIKE ? OR 
        contact_person LIKE ? OR 
        email LIKE ? OR 
        mobile_number LIKE ?
      )`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Get total count
    const countResult = await query(
      `
      SELECT COUNT(*) as total
      FROM bulk_bookings
      WHERE ${whereClause}
    `,
      params,
    );

    const total = countResult.rows[0]?.total || 0;

    // Get paginated results
    const result = await query(
      `
      SELECT *
      FROM bulk_bookings
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
      [...params, limit, offset],
    );

    const bookings = result.rows;

    res.status(200).json({
      success: true,
      data: bookings,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("❌ Error fetching bulk bookings:", error.message);
    console.error("Stack:", error.stack);

    res.status(500).json({
      success: false,
      message: "Failed to fetch bulk bookings",
    });
  }
};

/**
 * Get single bulk booking details
 */
export const getBulkBooking = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID required",
      });
    }

    const result = await query(
      `
      SELECT *
      FROM bulk_bookings
      WHERE id = ?
    `,
      [id],
    );

    const booking = result.rows[0];

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Bulk booking not found",
      });
    }

    res.status(200).json({
      success: true,
      data: booking,
    });
  } catch (error) {
    console.error("❌ Error fetching bulk booking:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch bulk booking",
    });
  }
};

/**
 * Update bulk booking (admin only)
 */
export const updateBulkBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, quote_price, delivery_date, admin_notes } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID required",
      });
    }

    // Validate status if provided
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    // Validate delivery_date format if provided
    if (delivery_date) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(delivery_date)) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format. Use YYYY-MM-DD",
        });
      }
    }

    // Validate quote_price if provided
    if (quote_price !== undefined && quote_price !== null) {
      const price = parseFloat(quote_price);
      if (isNaN(price) || price < 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid quote price",
        });
      }
    }

    // Check if booking exists
    const existingResult = await query(
      `
      SELECT id FROM bulk_bookings WHERE id = ?
    `,
      [id],
    );

    const existing = existingResult.rows[0];

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Bulk booking not found",
      });
    }

    // Build update query dynamically
    const updates = [];
    const params = [];

    if (status !== undefined) {
      updates.push("status = ?");
      params.push(status);
    }

    if (quote_price !== undefined) {
      updates.push("quote_price = ?");
      params.push(quote_price === null ? null : parseFloat(quote_price));
    }

    if (delivery_date !== undefined) {
      updates.push("delivery_date = ?");
      params.push(delivery_date === null ? null : delivery_date);
    }

    if (admin_notes !== undefined) {
      updates.push("admin_notes = ?");
      params.push(admin_notes === null ? null : admin_notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    // Always update updated_at
    updates.push("updated_at = NOW()");
    params.push(id);

    try {
      await query(
        `
        UPDATE bulk_bookings
        SET ${updates.join(", ")}
        WHERE id = ?
      `,
        params,
      );
    } catch (updateErr) {
      // If update fails due to missing columns (migration not applied)
      if (updateErr.message && updateErr.message.includes("Unknown column")) {
        console.warn(
          "⚠️ CRM workflow columns not available (migration pending)",
        );
        return res.status(400).json({
          success: false,
          message:
            "CRM workflow features require database migration. Please apply migration 006_bulk_bookings_workflow.sql",
        });
      }
      throw updateErr;
    }

    // Fetch updated booking
    const updatedResult = await query(
      `
      SELECT *
      FROM bulk_bookings
      WHERE id = ?
    `,
      [id],
    );

    const updated = updatedResult.rows[0];

    res.status(200).json({
      success: true,
      message: "Bulk booking updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("❌ Error updating bulk booking:", error);

    res.status(500).json({
      success: false,
      message: "Failed to update bulk booking",
    });
  }
};

/**
 * Get bulk booking statistics (admin only)
 * Works with or without migration (graceful fallback)
 */
export const getBulkBookingStats = async (req, res) => {
  try {
    // Try to get detailed stats with status breakdown (requires migration)
    let stats = {};

    try {
      const result = await query(`
        SELECT 
          COUNT(*) as totalBookings,
          SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as newBookings,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as inProgressBookings,
          SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) as quotedBookings,
          SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmedBookings,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completedBookings,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelledBookings,
          SUM(quantity) as totalQuantity,
          SUM(CASE WHEN status IN ('quoted', 'confirmed', 'completed') AND quote_price IS NOT NULL THEN quote_price ELSE 0 END) as totalQuoteValue
        FROM bulk_bookings
      `);

      stats = result.rows[0] || {};
    } catch (detailError) {
      // If detailed stats fail, fall back to basic stats
      console.warn(
        "⚠️ Detailed stats not available (migration may not be applied), using basic stats",
      );

      const result = await query(`
        SELECT 
          COUNT(*) as totalBookings,
          SUM(quantity) as totalQuantity
        FROM bulk_bookings
      `);

      stats = result.rows[0] || {};
    }

    res.status(200).json({
      success: true,
      data: {
        totalBookings: stats.totalBookings || 0,
        newBookings: stats.newBookings || 0,
        inProgressBookings: stats.inProgressBookings || 0,
        quotedBookings: stats.quotedBookings || 0,
        confirmedBookings: stats.confirmedBookings || 0,
        completedBookings: stats.completedBookings || 0,
        cancelledBookings: stats.cancelledBookings || 0,
        totalQuantity: stats.totalQuantity || 0,
        totalQuoteValue: parseFloat(stats.totalQuoteValue) || 0,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching bulk booking statistics:", error.message);
    console.error("Stack:", error.stack);

    res.status(500).json({
      success: false,
      message: "Failed to fetch bulk booking statistics",
    });
  }
};
