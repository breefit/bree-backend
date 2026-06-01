import jwt from "jsonwebtoken";

const isProduction = process.env.NODE_ENV === "production";

// sameSite:"None" is only valid when secure:true (HTTPS).
// In production we always run behind HTTPS (Render/Railway/etc set HTTPS=true),
// so this is safe. Locally we fall back to "lax" + secure:false so cookies
// work on http://localhost without browser warnings.
const SAME_SITE = isProduction ? "None" : "lax";
const SECURE = isProduction; // true in prod (HTTPS), false locally

export const signUserToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

export const signAdminToken = (adminId) =>
  jwt.sign({ adminId }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || "1d",
  });

export const verifyUserToken = (token) =>
  jwt.verify(token, process.env.JWT_SECRET);

export const verifyAdminToken = (token) =>
  jwt.verify(token, process.env.ADMIN_JWT_SECRET);

export const COOKIE_NAME = "auth_token";
export const REFRESH_COOKIE_NAME = "refresh_token";
export const ADMIN_COOKIE_NAME = "admin_auth_token";

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: SECURE,
  sameSite: SAME_SITE,
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: SECURE,
  sameSite: SAME_SITE,
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

export const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: SECURE,
  sameSite: SAME_SITE,
  path: "/",
  maxAge: 24 * 60 * 60 * 1000,
};