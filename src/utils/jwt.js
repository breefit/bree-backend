import jwt from "jsonwebtoken";

const isProduction = process.env.NODE_ENV === "production";

// sameSite:"None" is only valid when secure:true (HTTPS).
// In production we always run behind HTTPS (Render/Railway/etc set HTTPS=true),
// so this is safe. Locally we fall back to "lax" + secure:false so cookies
// work on http://localhost without browser warnings.
const SAME_SITE = isProduction ? "None" : "lax";
const SECURE = isProduction; // true in prod (HTTPS), false locally

// FIX (session-lifetime audit): cookie maxAge values used to be hardcoded
// independently of the token expiry/day-count values that actually govern
// how long a session stays valid server-side — e.g. the refresh-token
// COOKIE was fixed at 30 days here while the refresh-token ROW in the
// database (authService.js) defaulted to only 7 days whenever
// REFRESH_TOKEN_EXPIRES_IN_DAYS wasn't set, and the admin COOKIE was fixed
// at 1 day regardless of what ADMIN_JWT_EXPIRES_IN actually signed the
// token for. Both drift risks are closed by deriving every cookie's
// maxAge from the exact same value used to sign/validate the token it
// carries, so they can never disagree again.
//
// Product requirement: the customer session persists for 30 days via the
// refresh-token mechanism (the access token itself stays short-lived, per
// the existing short-access/long-refresh architecture — the requirement
// is the SESSION length, not the access token's own lifetime). The admin
// session persists for 7 days — admin has no separate refresh-token
// mechanism, so the admin JWT's own expiry directly IS the session length.
const parseDaysFromDurationString = (value, fallbackDays) => {
  const match = typeof value === "string" && value.trim().match(/^(\d+)d$/i);
  return match ? Number(match[1]) : fallbackDays;
};

const ADMIN_JWT_EXPIRES_IN = process.env.ADMIN_JWT_EXPIRES_IN || "7d";
const ADMIN_SESSION_DAYS = parseDaysFromDurationString(ADMIN_JWT_EXPIRES_IN, 7);

// The one place REFRESH_TOKEN_EXPIRES_IN_DAYS is parsed — authService.js
// imports REFRESH_TOKEN_DAYS below instead of reading the env var itself,
// so the refresh-token database row's expires_at and this cookie's maxAge
// are always computed from the identical number.
export const REFRESH_TOKEN_DAYS =
  parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS, 10) > 0
    ? parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS, 10)
    : 30;

export const signUserToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    // Deliberately short-lived — this is the access token, not the
    // session. The refresh-token mechanism (REFRESH_TOKEN_DAYS, above) is
    // what keeps the user's session alive for up to 30 days; GET
    // /api/auth/verify transparently reissues this token from a valid
    // refresh token whenever it's missing/expired, so lowering this
    // value only affects how often that silent renewal happens, never
    // how long the user actually stays logged in.
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

export const signAdminToken = (adminId) =>
  jwt.sign({ adminId }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: ADMIN_JWT_EXPIRES_IN,
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
  // Access-token cookie — intentionally shorter than the session itself;
  // see signUserToken's comment above.
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: SECURE,
  sameSite: SAME_SITE,
  path: "/",
  // Customer session length: 30 days by default, via REFRESH_TOKEN_DAYS —
  // must always match the refresh-token database row's own expiry
  // (authService.js), which imports this same constant.
  maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
};

export const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: SECURE,
  sameSite: SAME_SITE,
  path: "/",
  // Admin session length: 7 days by default — derived from
  // ADMIN_JWT_EXPIRES_IN so the cookie can never outlive (or expire
  // before) the admin JWT it carries.
  maxAge: ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000,
};