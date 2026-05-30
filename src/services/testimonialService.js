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

  await query(
    `INSERT INTO testimonials (user_id, name, role, text, rating, approved, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [userId, name, role, text, rating],
  );

  const { rows } = await query(
    `SELECT id, user_id, name, role, avatar, text, rating, approved, status, created_at, updated_at
     FROM testimonials
     WHERE user_id = ? AND name = ? AND text = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, name, text],
  );

  return rows[0];
};

export const getAdminTestimonials = async ({
  status = "all",
  limit = 20,
  offset = 0,
}) => {
  const whereClause = status !== "all" ? `WHERE status = ?` : "";

  const params = status !== "all" ? [status, limit, offset] : [limit, offset];

  const { rows } = await query(
    `SELECT id, user_id, name, role, avatar, text, rating, approved, status, created_at, updated_at
     FROM testimonials
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT ?
     OFFSET ?`,
    params,
  );

  return rows;
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
