import { verifyAdminToken, ADMIN_COOKIE_NAME } from "../utils/jwt.js";
import { query } from "../config/database.js";

const adminAuth = async (req, res, next) => {
  const tokenFromCookie = req.cookies?.[ADMIN_COOKIE_NAME];
  const authHeader = req.headers.authorization;
  const token =
    tokenFromCookie ||
    (authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null);

  if (!token) {
    return res.status(401).json({ message: "Admin token required" });
  }

  let decoded;
  try {
    decoded = verifyAdminToken(token);
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired admin token" });
  }

  const { rows } = await query(
    "SELECT id, email, name FROM admins WHERE id = ?",
    [decoded.adminId],
  );

  if (!rows.length) {
    return res.status(401).json({ message: "Admin not found" });
  }

  req.admin = rows[0];
  next();
};

export default adminAuth;
