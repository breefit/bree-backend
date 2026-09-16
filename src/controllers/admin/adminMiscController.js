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
  const where = search
    ? `WHERE u.customer_number LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?`
    : "";
  const params = search
    ? [
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        parseInt(limit),
        offset,
      ]
    : [parseInt(limit), offset];

  const [usersRes, countRes] = await Promise.all([
    query(
      `SELECT u.id, u.name, u.email, u.phone, u.customer_number, u.provider, u.created_at,
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
      search
        ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`]
        : [],
    ),
  ]);

  res.json({ customers: usersRes.rows, total: countRes.rows[0].total });
};

// ─── Inquiries ────────────────────────────────────────────────────────────────

// FIX (ISSUE-022 — Contact Inquiries search was a no-op): the frontend has
// always sent a `search` query param, but it was never read here at all —
// every request returned the same unfiltered (contacted-filtered only)
// page regardless of what was typed. Matches name/email/phone/message, the
// same field set ContactInquiries.js's UI actually displays per row.
// Also parameterizes the `contacted` filter, which previously built the
// clause via raw string interpolation (`contacted = ${contacted ===
// "true"}`) — not attacker-reachable in a dangerous way since it only ever
// resolves to the literal `true`/`false`, but there's no reason for a
// value that varies per-request to not go through a placeholder like
// every other filter in this codebase.
// `queryFn` injectable only for tests (default to the real pool).
export const getInquiries = async (req, res, { queryFn = query } = {}) => {
  const { page = 1, limit = 20, contacted = "all", search = "" } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const trimmedSearch = String(search || "").trim();

  const conditions = [];
  const whereParams = [];

  if (contacted !== "all") {
    conditions.push(`contacted = ?`);
    whereParams.push(contacted === "true" ? 1 : 0);
  }

  if (trimmedSearch) {
    conditions.push(`(name LIKE ? OR email LIKE ? OR phone LIKE ? OR message LIKE ?)`);
    const searchTerm = `%${trimmedSearch}%`;
    whereParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows, countRes] = await Promise.all([
    queryFn(
      `SELECT * FROM contact_inquiries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...whereParams, parseInt(limit), offset],
    ),
    queryFn(`SELECT COUNT(*) AS total FROM contact_inquiries ${where}`, whereParams),
  ]);

  res.json({ inquiries: rows.rows, total: countRes.rows[0].total });
};

export const markContacted = async (req, res) => {
  const { notes, contacted } = req.body;
  const contactedValue = contacted !== undefined ? (contacted ? 1 : 0) : 1;

  const result = await query(
    "UPDATE contact_inquiries SET contacted = ?, notes = ? WHERE id = ?",
    [contactedValue, notes || null, req.params.id],
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

// FIX (ISSUE-023 — capped at 20, no pagination): used to return a bare
// array with no total count — the admin frontend had no way to build real
// pagination even if it tried, only ever seeing whatever fit on the first
// page. Now returns `{ testimonials, total }`, matching the shape
// Customers/Contact Inquiries already use, plus an optional `search` param
// (name/role/text).
export const getAdminTestimonials = async (req, res, { queryFn } = {}) => {
  const status = req.query.status || "all";
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = (page - 1) * limit;
  const search = req.query.search || "";

  const { rows, total } = await fetchAdminTestimonials({
    status,
    limit,
    offset,
    search,
    ...(queryFn ? { queryFn } : {}),
  });
  res.json({ testimonials: rows, total });
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
