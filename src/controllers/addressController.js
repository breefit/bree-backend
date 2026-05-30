import { query } from "../config/database.js";

// GET /api/addresses
export const getAddresses = async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at ASC",
    [req.user.id],
  );
  res.json(rows);
};

// POST /api/addresses
export const addAddress = async (req, res) => {
  const {
    label = "Home",
    line1,
    line2,
    city,
    state,
    pincode,
    country = "India",
    isDefault = false,
  } = req.body;

  // If marking default, clear other defaults first
  if (isDefault) {
    await query("UPDATE addresses SET is_default = false WHERE user_id = ?", [
      req.user.id,
    ]);
  }

  await query(
    `INSERT INTO addresses (user_id, label, line1, line2, city, state, pincode, country, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      label,
      line1,
      line2 || null,
      city,
      state,
      pincode,
      country,
      isDefault,
    ],
  );

  const { rows } = await query(
    `SELECT * FROM addresses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    [req.user.id],
  );
  res.status(201).json(rows[0]);
};

// PUT /api/addresses/:id
export const updateAddress = async (req, res) => {
  const { label, line1, line2, city, state, pincode, country, isDefault } =
    req.body;

  // Verify ownership
  const existing = await query(
    "SELECT id FROM addresses WHERE id = ? AND user_id = ?",
    [req.params.id, req.user.id],
  );
  if (!existing.rows.length)
    return res.status(404).json({ message: "Address not found" });

  if (isDefault) {
    await query("UPDATE addresses SET is_default = false WHERE user_id = ?", [
      req.user.id,
    ]);
  }

  await query(
    `UPDATE addresses SET label = ?, line1 = ?, line2 = ?, city = ?, state = ?,
       pincode = ?, country = ?, is_default = ? WHERE id = ?`,
    [
      label,
      line1,
      line2 || null,
      city,
      state,
      pincode,
      country || "India",
      isDefault || false,
      req.params.id,
    ],
  );

  const { rows } = await query(`SELECT * FROM addresses WHERE id = ? LIMIT 1`, [
    req.params.id,
  ]);
  res.json(rows[0]);
};

// DELETE /api/addresses/:id
export const deleteAddress = async (req, res) => {
  const { rows } = await query(
    "SELECT id FROM addresses WHERE id = ? AND user_id = ? LIMIT 1",
    [req.params.id, req.user.id],
  );
  if (!rows.length)
    return res.status(404).json({ message: "Address not found" });

  await query("DELETE FROM addresses WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.user.id,
  ]);
  res.json({ message: "Address deleted" });
};

// PUT /api/addresses/:id/default
export const setDefault = async (req, res) => {
  const existing = await query(
    "SELECT id FROM addresses WHERE id = ? AND user_id = ?",
    [req.params.id, req.user.id],
  );
  if (!existing.rows.length)
    return res.status(404).json({ message: "Address not found" });

  await query("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [
    req.user.id,
  ]);
  await query("UPDATE addresses SET is_default = 1 WHERE id = ?", [
    req.params.id,
  ]);
  const { rows } = await query("SELECT * FROM addresses WHERE id = ? LIMIT 1", [
    req.params.id,
  ]);
  res.json(rows[0]);
};
