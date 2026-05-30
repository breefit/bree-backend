import bcrypt from "bcryptjs";
import { query } from "../../config/database.js";
import {
  signAdminToken,
  ADMIN_COOKIE_NAME,
  ADMIN_COOKIE_OPTIONS,
} from "../../utils/jwt.js";

// POST /api/admin/login
export const adminLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const { rows } = await query("SELECT * FROM admins WHERE email = ?", [
      email.toLowerCase(),
    ]);
    if (!rows.length) {
      return res.status(401).json({ message: "Invalid admin credentials" });
    }

    const admin = rows[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      return res.status(401).json({ message: "Invalid admin credentials" });
    }

    const token = signAdminToken(admin.id);
    res.cookie(ADMIN_COOKIE_NAME, token, ADMIN_COOKIE_OPTIONS);
    res.json({ admin: { id: admin.id, email: admin.email, name: admin.name } });
  } catch (err) {
    next(err);
  }
};

export const adminMe = async (req, res, next) => {
  try {
    res.json({ admin: req.admin });
  } catch (err) {
    next(err);
  }
};

export const adminLogout = (req, res) => {
  res.clearCookie(ADMIN_COOKIE_NAME, {
    ...ADMIN_COOKIE_OPTIONS,
    maxAge: 0,
  });
  res.json({ message: "Logged out successfully" });
};
