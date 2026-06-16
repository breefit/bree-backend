import { randomUUID } from "crypto";
import { query } from "../config/database.js";
import crypto from "crypto";

// GET /api/addresses
export const getAddresses = async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at ASC",
    [req.user.id],
  );
  res.json(rows);
};

const addressId = crypto.randomUUID();

// POST /api/addresses
export const addAddress = async (req, res) => {
  // console.log("[addAddress] req.user:", req.user);
  // console.log("[addAddress] req.userId:", req.userId);
  // console.log("[addAddress] req.body:", req.body);
  const resolvedUserId = req.user?.id || req.userId || null;
  // console.log("[addAddress] resolved userId:", resolvedUserId);
  const addressId = randomUUID();

  const {
    label = "Home",
    address_line1,
    address_line2,
    city,
    state,
    pincode,
    country = "India",
    isDefault = false,
  } = req.body;

  // Check if this is the first address — make it default automatically
  const { rows: existingAddrs } = await query(
    "SELECT COUNT(*) as count FROM addresses WHERE user_id = ?",
    [req.user.id],
  );
  const isFirstAddress = parseInt(existingAddrs[0].count) === 0;
  const shouldBeDefault = isDefault || isFirstAddress;

  // If marking default, clear other defaults first
  if (shouldBeDefault) {
    await query("UPDATE addresses SET is_default = false WHERE user_id = ?", [
      req.user.id,
    ]);
  }

  // console.log("req.user =", req.user);
  // console.log("req.user.id =", req.user?.id);

  await query(
    `INSERT INTO addresses (id, user_id, label, address_line1, address_line2, city, state, pincode, country, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      addressId,
      req.user.id,
      label,
      address_line1,
      address_line2 || null,
      city,
      state,
      pincode,
      country,
      shouldBeDefault,
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
  const {
    label,
    address_line1,
    address_line2,
    city,
    state,
    pincode,
    country,
    isDefault,
  } = req.body;

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
    `UPDATE addresses SET label = ?, address_line1 = ?, address_line2 = ?, city = ?, state = ?,
       pincode = ?, country = ?, is_default = ? WHERE id = ?`,
    [
      label,
      address_line1,
      address_line2 || null,
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

  // If deleted address was default, set next address as default
  const { rows: remaining } = await query(
    "SELECT id FROM addresses WHERE user_id = ? ORDER BY created_at ASC LIMIT 1",
    [req.user.id],
  );
  if (remaining.length) {
    await query("UPDATE addresses SET is_default = 1 WHERE id = ?", [
      remaining[0].id,
    ]);
  }

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
