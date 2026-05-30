import { verifyUserToken, COOKIE_NAME } from "../utils/jwt.js";
import { query } from "../config/database.js";

const getToken = (req) => {
  const cookieToken = req.cookies[COOKIE_NAME];
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;
  return cookieToken || bearerToken || null;
};

const auth = async (req, res, next) => {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  let decoded;
  try {
    decoded = verifyUserToken(token);
  } catch (err) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const { rows } = await query(
    "SELECT id, name, email, phone, picture, provider, role FROM users WHERE id = ?",
    [decoded.userId],
  );

  if (!rows.length) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  req.user = rows[0];
  next();
};

export const optionalAuth = async (req, res, next) => {
  const token = getToken(req);
  if (token) {
    try {
      const decoded = verifyUserToken(token);
      const { rows } = await query(
        "SELECT id, name, email, phone, picture, provider, role FROM users WHERE id = ?",
        [decoded.userId],
      );
      if (rows.length) req.user = rows[0];
    } catch {
      // Invalid or expired token; proceed as unauthenticated.
    }
  }
  next();
};

export default auth;
