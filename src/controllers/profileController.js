import bcrypt from "bcryptjs";
import { query } from "../config/database.js";
import { ensureUserCustomerNumber } from "../utils/customerNumber.js";

// GET /api/profile
export const getProfile = async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT id, name, email, phone, picture, provider, customer_number, created_at FROM users WHERE id = ?",
      [req.user.id],
    );
    const user = rows[0];
    if (user && !user.customer_number) {
      user.customer_number = await ensureUserCustomerNumber(user.id);
    }
    res.json(user);
  } catch (err) {
    next(err);
  }
};

// PUT /api/profile
export const updateProfile = async (req, res, next) => {
  try {
    const { name, email, phone } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      updates.push(`name  = $${idx++}`);
      params.push(name.trim());
    }
    if (phone !== undefined) {
      updates.push(`phone = $${idx++}`);
      params.push(phone.trim());
    }
    if (email !== undefined) {
      const normalizedEmail = email.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
        return res.status(400).json({ message: "Invalid email address" });
      }
      const { rows: emailOwners } = await query(
        "SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1",
        [normalizedEmail, req.user.id],
      );
      if (emailOwners.length) {
        return res.status(409).json({ message: "Email is already in use" });
      }
      updates.push(`email = $${idx++}`);
      params.push(normalizedEmail);
    }

    if (!updates.length)
      return res.status(400).json({ message: "No fields to update" });

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(req.user.id);

    await query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);

    const { rows } = await query(
      `SELECT id, name, email, phone, picture, customer_number FROM users WHERE id = ?`,
      [req.user.id],
    );
    const user = rows[0];
    if (user && !user.customer_number) {
      user.customer_number = await ensureUserCustomerNumber(user.id);
    }
    res.json(user);
  } catch (err) {
    next(err);
  }
};

// PUT /api/profile/password
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const { rows } = await query(
      "SELECT password, provider FROM users WHERE id = ?",
      [req.user.id],
    );
    if (!rows.length)
      return res.status(404).json({ message: "User not found" });

    const user = rows[0];
    if (user.provider !== "email") {
      return res
        .status(400)
        .json({ message: "Password change not available for Google accounts" });
    }

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid)
      return res.status(401).json({ message: "Current password is incorrect" });

    const hashed = await bcrypt.hash(newPassword, 12);
    await query(
      "UPDATE users SET password = ?, updated_at = now() WHERE id = ?",
      [hashed, req.user.id],
    );
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    next(err);
  }
};
