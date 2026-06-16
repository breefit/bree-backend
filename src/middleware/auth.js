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
  console.log(
    "[auth] request",
    req.method,
    req.originalUrl,
    "tokenPresent:",
    !!token,
  );
  // console.log("[auth] req.user before auth:", req.user);
  // console.log("[auth] req.userId before auth:", req.userId);
  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  let decoded;
  try {
    decoded = verifyUserToken(token);
    // console.log("[auth] decoded token:", decoded);
  } catch (err) {
    // console.log("[auth] token verification failed:", err?.message || err);
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const { rows } = await query(
    "SELECT id, name, email, phone, picture, provider, role FROM users WHERE id = ?",
    [decoded.userId],
  );
  // console.log("[auth] user lookup rows:", rows.length, rows[0]);

  if (!rows.length) {
    // console.log("[auth] no user found for decoded.userId:", decoded.userId);
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  req.user = rows[0];
  // console.log("[auth] req.user after auth:", req.user);
  // console.log("[auth] req.userId after auth:", req.userId);
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
