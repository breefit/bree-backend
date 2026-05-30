import { query } from "../../config/database.js";
import cache from "../../utils/cache.js";

const invalidateTestimonialsCache = () => {
  cache.del("testimonials:approved");
  cache.del("home:data");
};

// ─── Customers ────────────────────────────────────────────────────────────────

export const getCustomers = async (req, res) => {
  const { search = "", page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const where = search ? `WHERE u.name LIKE ? OR u.email LIKE ?` : "";
  const params = search
    ? [`%${search}%`, `%${search}%`, parseInt(limit), offset]
    : [parseInt(limit), offset];
  const pIdx = search ? { l: "?", o: "?" } : { l: "?", o: "?" };

  const [usersRes, countRes] = await Promise.all([
    query(
      `SELECT u.id, u.name, u.email, u.phone, u.provider, u.created_at,
              COUNT(o.id) AS order_count,
              COALESCE(SUM(CASE WHEN o.payment_status='paid' THEN COALESCE(o.total, o.amount) ELSE 0 END),0) AS total_spent
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
       ${where}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      params,
    ),
    query(
      `SELECT COUNT(*) AS total FROM users u ${where}`,
      search ? [`%${search}%`, `%${search}%`] : [],
    ),
  ]);

  res.json({ customers: usersRes.rows, total: countRes.rows[0].total });
};

// ─── Inquiries ────────────────────────────────────────────────────────────────

export const getInquiries = async (req, res) => {
  const { page = 1, limit = 20, contacted = "all" } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const where =
    contacted !== "all" ? `WHERE contacted = ${contacted === "true"}` : "";

  const [rows, countRes] = await Promise.all([
    query(
      `SELECT * FROM contact_inquiries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), offset],
    ),
    query(`SELECT COUNT(*) AS total FROM contact_inquiries ${where}`),
  ]);

  res.json({ inquiries: rows.rows, total: countRes.rows[0].total });
};

export const markContacted = async (req, res) => {
  const { notes } = req.body;
  const result = await query(
    "UPDATE contact_inquiries SET contacted = 1, notes = ? WHERE id = ?",
    [notes || null, req.params.id],
  );
  if (!result.rowCount)
    return res.status(404).json({ message: "Inquiry not found" });

  const { rows } = await query(
    "SELECT * FROM contact_inquiries WHERE id = ? LIMIT 1",
    [req.params.id],
  );

  res.json(rows[0]);
};

export const deleteInquiry = async (req, res) => {
  const { rows } = await query(
    "SELECT id FROM contact_inquiries WHERE id = ? LIMIT 1",
    [req.params.id],
  );
  if (!rows.length)
    return res.status(404).json({ message: "Inquiry not found" });

  await query("DELETE FROM contact_inquiries WHERE id = ?", [req.params.id]);
  res.json({ message: "Inquiry deleted" });
};

// ─── Testimonials ─────────────────────────────────────────────────────────────

import {
  getAdminTestimonials as fetchAdminTestimonials,
  updateTestimonialStatus,
  deleteTestimonialById,
} from "../../services/testimonialService.js";

export const getAdminTestimonials = async (req, res) => {
  const status = req.query.status || "all";
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = (page - 1) * limit;

  const rows = await fetchAdminTestimonials({ status, limit, offset });
  res.json(rows);
};

export const approveTestimonial = async (req, res) => {
  const testimonial = await updateTestimonialStatus(
    req.params.id,
    true,
    "approved",
  );
  if (!testimonial)
    return res.status(404).json({ message: "Testimonial not found" });
  invalidateTestimonialsCache();
  res.json(testimonial);
};

export const rejectTestimonial = async (req, res) => {
  const testimonial = await updateTestimonialStatus(
    req.params.id,
    false,
    "rejected",
  );
  if (!testimonial)
    return res.status(404).json({ message: "Testimonial not found" });
  invalidateTestimonialsCache();
  res.json(testimonial);
};

export const deleteTestimonial = async (req, res) => {
  const testimonial = await deleteTestimonialById(req.params.id);
  if (!testimonial)
    return res.status(404).json({ message: "Testimonial not found" });
  invalidateTestimonialsCache();
  res.json({ message: "Testimonial deleted" });
};
