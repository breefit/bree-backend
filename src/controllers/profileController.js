import bcrypt from 'bcryptjs';
import { query } from '../config/database.js';

// GET /api/profile
export const getProfile = async (req, res) => {
  const { rows } = await query(
    'SELECT id, name, email, phone, picture, provider, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  res.json(rows[0]);
};

// PUT /api/profile
export const updateProfile = async (req, res) => {
  const { name, phone } = req.body;
  const updates = [];
  const params  = [];
  let   idx     = 1;

  if (name  !== undefined) { updates.push(`name  = $${idx++}`); params.push(name.trim()); }
  if (phone !== undefined) { updates.push(`phone = $${idx++}`); params.push(phone.trim()); }

  if (!updates.length) return res.status(400).json({ message: 'No fields to update' });

  updates.push(`updated_at = now()`);
  params.push(req.user.id);

  const { rows } = await query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, name, email, phone, picture`,
    params
  );
  res.json(rows[0]);
};

// PUT /api/profile/password
export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const { rows } = await query('SELECT password, provider FROM users WHERE id = $1', [req.user.id]);
  if (!rows.length) return res.status(404).json({ message: 'User not found' });

  const user = rows[0];
  if (user.provider !== 'email') {
    return res.status(400).json({ message: 'Password change not available for Google accounts' });
  }

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.status(401).json({ message: 'Current password is incorrect' });

  const hashed = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password=$1, updated_at=now() WHERE id=$2', [hashed, req.user.id]);
  res.json({ message: 'Password updated successfully' });
};
