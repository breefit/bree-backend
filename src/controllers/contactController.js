import { randomUUID } from "crypto";
import { query } from "../config/database.js";
import { sendContactAck } from "../services/email.js";

// POST /api/contact
export const submitInquiry = async (req, res) => {
  const { name, email, phone, message } = req.body;

  const id = randomUUID();

  await query(
    `INSERT INTO contact_inquiries
     (id, name, email, phone, message)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name.trim(), email.toLowerCase(), phone || null, message.trim()],
  );

  // Send ack email (non-blocking)
  sendContactAck({ to: email, name }).catch(() => {});

  res.status(201).json({
    message: "Thank you! We will get back to you within 24 hours.",
    id,
  });
};

// PATCH /api/admin/inquiries/:id
export const updateInquiryStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const { contacted } = req.body;

    await query(
      `UPDATE contact_inquiries
       SET contacted = ?
       WHERE id = ?`,
      [contacted, id],
    );

    const { rows } = await query(
      `SELECT * FROM contact_inquiries WHERE id = ? LIMIT 1`,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Inquiry not found",
      });
    }

    res.status(200).json({
      success: true,
      inquiry: rows[0],
    });
  } catch (error) {
    console.error("Update inquiry status error:", error);

    res.status(500).json({
      message: "Failed to update inquiry status",
    });
  }
};
