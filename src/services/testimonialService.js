import { randomUUID } from "crypto";
import { query } from "../config/database.js";

export const getApprovedTestimonials = async () => {
  const { rows } = await query(
    `SELECT id, user_id, name, role, avatar, text, rating, created_at, updated_at
     FROM testimonials
     WHERE status = 'approved'
     ORDER BY created_at DESC`,
  );
  return rows;
};

export const createTestimonial = async ({
  userId,
  name,
  role,
  text,
  rating,
}) => {
  // Prevent obvious duplicates: same name + text
  const dup = await query(
    `SELECT id FROM testimonials WHERE name = ? AND text = ? LIMIT 1`,
    [name, text],
  );
  if (dup.rows.length) return null;

  const id = randomUUID();

  await query(
    `INSERT INTO testimonials (id, user_id, name, role, text, rating, approved, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, userId, name, role, text, rating],
  );

  const { rows } = await query(
    `SELECT id, user_id, name, role, avatar, text, rating, approved, status, created_at, updated_at
     FROM testimonials
     WHERE id = ?
     LIMIT 1`,
    [id],
  );

  return rows[0];
};

// FIX (ISSUE-023 — admin Testimonials capped at 20, no pagination): this
// used to return a bare array with no total count at all, so the admin
// frontend had no way to build real pagination even if it wanted to —
// only ever showing whatever fit on the first page. Now returns
// `{ rows, total }`, matching the shape Customers/Contact Inquiries
// already use, and accepts an optional `search` (name/role/text) so the
// admin list can filter server-side instead of only ever seeing the first
// page's worth of rows.
// `queryFn` injectable only for tests (default to the real pool).
export const getAdminTestimonials = async ({
  status = "all",
  limit = 20,
  offset = 0,
  search = "",
  queryFn = query,
}) => {
  const conditions = [];
  const params = [];

  if (status !== "all") {
    conditions.push(`status = ?`);
    params.push(status);
  }

  const trimmedSearch = String(search || "").trim();
  if (trimmedSearch) {
    conditions.push(`(name LIKE ? OR role LIKE ? OR text LIKE ?)`);
    const searchTerm = `%${trimmedSearch}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [{ rows }, { rows: countRows }] = await Promise.all([
    queryFn(
      `SELECT id, user_id, name, role, avatar, text, rating, approved, status, created_at, updated_at
       FROM testimonials
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ?
       OFFSET ?`,
      [...params, limit, offset],
    ),
    queryFn(`SELECT COUNT(*) AS total FROM testimonials ${whereClause}`, params),
  ]);

  return { rows, total: countRows[0]?.total || 0 };
};

export const updateTestimonialStatus = async (id, approved, status) => {
  await query(
    `UPDATE testimonials
     SET approved = ?,
         status = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [approved, status, id],
  );

  const { rows } = await query(
    `SELECT id, user_id, name, role, avatar, text, rating, approved, status, created_at, updated_at
     FROM testimonials
     WHERE id = ?`,
    [id],
  );
  return rows[0];
};

export const deleteTestimonialById = async (id) => {
  const { rows } = await query(`SELECT id FROM testimonials WHERE id = ?`, [
    id,
  ]);
  if (!rows.length) return null;

  await query(`DELETE FROM testimonials WHERE id = ?`, [id]);
  return { id };
};
