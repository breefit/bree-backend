import { query } from '../config/database.js';

// GET /api/addresses
export const getAddresses = async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC',
    [req.user.id]
  );
  res.json(rows);
};

// POST /api/addresses
export const addAddress = async (req, res) => {
  const { label = 'Home', line1, line2, city, state, pincode, country = 'India', isDefault = false } = req.body;

  // If marking default, clear other defaults first
  if (isDefault) {
    await query('UPDATE addresses SET is_default=false WHERE user_id=$1', [req.user.id]);
  }

  const { rows } = await query(
    `INSERT INTO addresses (user_id, label, line1, line2, city, state, pincode, country, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.user.id, label, line1, line2 || null, city, state, pincode, country, isDefault]
  );
  res.status(201).json(rows[0]);
};

// PUT /api/addresses/:id
export const updateAddress = async (req, res) => {
  const { label, line1, line2, city, state, pincode, country, isDefault } = req.body;

  // Verify ownership
  const existing = await query('SELECT id FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!existing.rows.length) return res.status(404).json({ message: 'Address not found' });

  if (isDefault) {
    await query('UPDATE addresses SET is_default=false WHERE user_id=$1', [req.user.id]);
  }

  const { rows } = await query(
    `UPDATE addresses SET label=$1,line1=$2,line2=$3,city=$4,state=$5,
       pincode=$6,country=$7,is_default=$8 WHERE id=$9 RETURNING *`,
    [label, line1, line2||null, city, state, pincode, country||'India', isDefault||false, req.params.id]
  );
  res.json(rows[0]);
};

// DELETE /api/addresses/:id
export const deleteAddress = async (req, res) => {
  const { rows } = await query(
    'DELETE FROM addresses WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Address not found' });
  res.json({ message: 'Address deleted' });
};

// PUT /api/addresses/:id/default
export const setDefault = async (req, res) => {
  const existing = await query('SELECT id FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!existing.rows.length) return res.status(404).json({ message: 'Address not found' });

  await query('UPDATE addresses SET is_default=false WHERE user_id=$1', [req.user.id]);
  const { rows } = await query(
    'UPDATE addresses SET is_default=true WHERE id=$1 RETURNING *', [req.params.id]
  );
  res.json(rows[0]);
};
