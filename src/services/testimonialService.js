import { query } from '../config/database.js';

export const getApprovedTestimonials = async () => {
  const { rows } = await query(
    `SELECT id, user_id, name, role, avatar, text, rating, created_at, updated_at
     FROM testimonials
     WHERE status = 'approved'
     ORDER BY created_at DESC`
  );
  return rows;
};

export const createTestimonial = async ({ userId, name, role, text, rating }) => {
  // Prevent obvious duplicates: same name + text
  const dup = await query(
    `SELECT id FROM testimonials WHERE name = $1 AND text = $2 LIMIT 1`,
    [name, text]
  );
  if (dup.rows.length) return null;

  const { rows } = await query(
    `INSERT INTO testimonials (user_id, name, role, text, rating, approved, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, false, 'pending', now(), now())
     RETURNING id, user_id, name, role, avatar, text, rating, approved, status, created_at, updated_at`,
    [userId, name, role, text, rating]
  );
  return rows[0];
};

export const getAdminTestimonials = async ({ status = 'all', limit = 20, offset = 0 }) => {
  const whereClause = status !== 'all'
    ? `WHERE status = $1`
    : '';

  const params = status !== 'all'
    ? [status, limit, offset]
    : [limit, offset];

  const { rows } = await query(
    `SELECT id, user_id, name, role, avatar, text, rating, approved, status, created_at, updated_at
     FROM testimonials
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${status !== 'all' ? '2' : '1'}
     OFFSET $${status !== 'all' ? '3' : '2'}`,
    params
  );

  return rows;
};

export const updateTestimonialStatus = async (id, approved, status) => {
  const { rows } = await query(
    `UPDATE testimonials
     SET approved = $2,
         status = $3,
         updated_at = now()
     WHERE id = $1
     RETURNING id, user_id, name, role, avatar, text, rating, approved, status, created_at, updated_at`,
    [id, approved, status]
  );
  return rows[0];
};

export const deleteTestimonialById = async (id) => {
  const { rows } = await query(
    `DELETE FROM testimonials WHERE id = $1 RETURNING id`,
    [id]
  );
  return rows[0];
};
