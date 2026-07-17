import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { query } from "../config/database.js";
import firebaseAuth from "../config/firebaseAdmin.js";
import {
  signUserToken,
  verifyUserToken,
  COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from "../utils/jwt.js";
import {
  createRefreshToken,
  findRefreshTokenByValue,
  rotateRefreshToken,
  revokeRefreshTokenById,
  revokeUserRefreshTokens,
  loadUserById,
} from "../services/authService.js";
import { ensureUserCustomerNumber } from "../utils/customerNumber.js";
import { sendWhatsAppOtp } from "../services/whatsappService.js";

const SALT_ROUNDS = 12;
const OTP_EXPIRY_MINUTES = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_MIN_INTERVAL_MS = 30 * 1000; // 30 seconds

const safeUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  picture: u.picture,
  provider: u.provider,
  role: u.role || "user",
  customer_number: u.customer_number || null,
});

const setAuthCookies = async (res, userId, req) => {
  // console.log("[authController] setAuthCookies called with userId:", userId);
  const accessToken = signUserToken(userId);
  const refreshToken = await createRefreshToken(userId, {
    userAgent: req.get("User-Agent"),
    ipAddress: req.ip,
  });

  res.cookie(COOKIE_NAME, accessToken, COOKIE_OPTIONS);
  res.cookie(
    REFRESH_COOKIE_NAME,
    refreshToken.refreshToken,
    REFRESH_COOKIE_OPTIONS,
  );

  return accessToken;
};

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization;
  return authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
};

const loadUser = async (userId) => {
  const user = await loadUserById(userId);
  if (!user) throw new Error("User not found");
  return user;
};

// ---- OTP helpers (DB-backed) ----

const isValidMobile = (mobile) =>
  typeof mobile === "string" && /^\d{10}$/.test(mobile);

const isValidOtpFormat = (otp) =>
  typeof otp === "string" && /^\d{6}$/.test(otp);

const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

const getLatestOtpRecord = async (mobile) => {
  const { rows } = await query(
    `SELECT id, mobile, otp_hash, expires_at, attempts, verified, created_at
     FROM otp_verifications
     WHERE mobile = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [mobile],
  );
  return rows[0] || null;
};

const clearOtpRecords = async (mobile) => {
  await query("DELETE FROM otp_verifications WHERE mobile = ?", [mobile]);
};

const isWithinResendCooldown = (record) =>
  Boolean(record) &&
  Date.now() - new Date(record.created_at).getTime() < RESEND_MIN_INTERVAL_MS;

const issueOtp = async (mobile) => {
  // Remove any previous active OTP for this mobile before issuing a new one.
  await clearOtpRecords(mobile);

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await query(
    `INSERT INTO otp_verifications (
      id,
      mobile,
      otp_hash,
      expires_at,
      attempts,
      verified
    ) VALUES (?, ?, ?, ?, 0, FALSE)`,
    [randomUUID(), mobile, otpHash, expiresAt],
  );

  await sendWhatsAppOtp(mobile, otp);
};

// Creates a phone-provider user and its customer number as a single unit.
// Wrapped in a transaction so a failure between the two steps doesn't
// leave a user row without a customer number.
const createPhoneUserWithCustomerNumber = async (mobile) => {
  const userId = randomUUID();

  await query("START TRANSACTION");
  try {
    await query(
      `INSERT INTO users (
        id,
        phone,
        provider
      ) VALUES (?, ?, 'phone')`,
      [userId, mobile],
    );

    await ensureUserCustomerNumber(userId);

    await query("COMMIT");
  } catch (error) {
    await query("ROLLBACK");
    throw error;
  }

  const { rows: created } = await query(
    `SELECT id, name, email, phone, picture, provider, role, customer_number
     FROM users WHERE id = ?`,
    [userId],
  );
  return created[0];
};

// POST /api/auth/google
export const googleSignIn = async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res
      .status(400)
      .json({ message: "Firebase auth token is required." });
  }

  let decodedToken;
  try {
    decodedToken = await firebaseAuth.verifyIdToken(token);
  } catch (error) {
    console.error("Firebase token verification failed:", error);
    return res
      .status(401)
      .json({ message: "Invalid or expired Google authentication token." });
  }

  const email = decodedToken.email?.toLowerCase();
  if (!email) {
    return res.status(400).json({ message: "Google user email is required." });
  }

  const name = decodedToken.name || email.split("@")[0];
  const picture = decodedToken.picture || null;
  const userId = randomUUID();

  try {
    await query(
      `INSERT INTO users (
      id,
      name,
      email,
      picture,
      provider
   )
   VALUES (?, ?, ?, ?, 'google')
   ON DUPLICATE KEY UPDATE
     name = VALUES(name),
     picture = VALUES(picture),
     provider = 'google',
     updated_at = CURRENT_TIMESTAMP`,
      [userId, name.trim(), email, picture],
    );

    const { rows } = await query(
      `SELECT id, name, email, phone, picture, provider, role, customer_number
       FROM users WHERE email = ?`,
      [email],
    );

    const user = rows[0];
    if (user) {
      user.customer_number = await ensureUserCustomerNumber(user.id);
    }
    // console.log("[authController] googleSignIn created/loaded user row:", user);
    const accessToken = await setAuthCookies(res, user.id, req);
    return res.json({ ...safeUser(user), accessToken });
  } catch (error) {
    console.error("Error creating or updating Google user:", error);
    return res
      .status(500)
      .json({ message: "Unable to complete Google sign-in at this time." });
  }
};

// POST /api/auth/send-otp
export const sendOtp = async (req, res, next) => {
  try {
    const { mobile } = req.body;

    if (!isValidMobile(mobile)) {
      return res.status(400).json({
        message: "A valid 10-digit mobile number is required.",
      });
    }

    const existing = await getLatestOtpRecord(mobile);
    if (isWithinResendCooldown(existing)) {
      return res.status(429).json({
        message: "Please wait before requesting another OTP.",
      });
    }

    await issueOtp(mobile);

    return res.json({ message: "OTP sent successfully." });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/verify-otp
export const verifyOtp = async (req, res, next) => {
  try {
    const { mobile, otp } = req.body;

    if (!isValidMobile(mobile)) {
      return res.status(400).json({
        message: "A valid 10-digit mobile number is required.",
      });
    }

    if (!isValidOtpFormat(otp)) {
      return res
        .status(400)
        .json({ message: "A valid 6-digit OTP is required." });
    }

    const record = await getLatestOtpRecord(mobile);

    if (!record || record.verified) {
      return res.status(400).json({
        message: "No OTP request found for this mobile number.",
      });
    }

    if (new Date(record.expires_at) <= new Date()) {
      return res
        .status(400)
        .json({ message: "OTP has expired. Please request a new one." });
    }

    if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many incorrect attempts. Please request a new OTP.",
      });
    }

    const isMatch = await bcrypt.compare(otp, record.otp_hash);
    if (!isMatch) {
      await query(
        "UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?",
        [record.id],
      );
      return res.status(401).json({ message: "Incorrect OTP." });
    }

    // OTP verified — delete the record instead of just flagging it,
    // since a used OTP has no reason to stay in the table.
    await query("DELETE FROM otp_verifications WHERE id = ?", [record.id]);

    const { rows } = await query(
      `SELECT id, name, email, phone, picture, provider, role, customer_number
       FROM users WHERE phone = ?`,
      [mobile],
    );

    let user = rows[0];

    if (!user) {
      user = await createPhoneUserWithCustomerNumber(mobile);
    } else {
      user.customer_number = await ensureUserCustomerNumber(user.id);
    }

    const accessToken = await setAuthCookies(res, user.id, req);
    return res.json({ ...safeUser(user), accessToken });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/resend-otp
export const resendOtp = async (req, res, next) => {
  try {
    const { mobile } = req.body;

    if (!isValidMobile(mobile)) {
      return res.status(400).json({
        message: "A valid 10-digit mobile number is required.",
      });
    }

    const existing = await getLatestOtpRecord(mobile);
    if (isWithinResendCooldown(existing)) {
      return res.status(429).json({
        message: "Please wait before requesting another OTP.",
      });
    }

    await issueOtp(mobile);

    return res.json({ message: "OTP resent successfully." });
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/verify
export const verifyAuth = async (req, res) => {
  const accessToken = req.cookies[COOKIE_NAME] || getBearerToken(req);
  const refreshToken = req.cookies[REFRESH_COOKIE_NAME] || null;

  if (accessToken) {
    try {
      const verified = verifyUserToken(accessToken);
      const user = await loadUser(verified.userId);
      return res.json({ ...safeUser(user), accessToken });
    } catch {
      // Access token invalid or expired.
    }
  }

  if (!refreshToken) {
    return res.status(401).json({ message: "Session expired" });
  }

  const stored = await findRefreshTokenByValue(refreshToken);
  if (!stored || stored.revoked || new Date(stored.expires_at) <= new Date()) {
    return res.status(401).json({ message: "Session expired" });
  }

  const user = await loadUser(stored.user_id);
  if (!user) {
    return res.status(401).json({ message: "User not found" });
  }

  const rotated = await rotateRefreshToken(refreshToken, {
    userAgent: req.get("User-Agent"),
    ipAddress: req.ip,
  });

  if (!rotated) {
    return res.status(401).json({ message: "Session refresh failed" });
  }

  const accessTokenValue = signUserToken(user.id);
  res.cookie(COOKIE_NAME, accessTokenValue, COOKIE_OPTIONS);
  res.cookie(REFRESH_COOKIE_NAME, rotated.refreshToken, REFRESH_COOKIE_OPTIONS);
  res.json({ ...safeUser(user), accessToken: accessTokenValue });
};

// GET /api/auth/me
export const getMe = async (req, res) => {
  res.json(safeUser(req.user));
};

// POST /api/auth/logout
export const logout = async (req, res) => {
  const refreshToken = req.cookies[REFRESH_COOKIE_NAME];
  if (refreshToken) {
    const stored = await findRefreshTokenByValue(refreshToken);
    if (stored) await revokeRefreshTokenById(stored.id);
  }

  if (req.user?.id) {
    await revokeUserRefreshTokens(req.user.id);
  }

  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: 0, path: "/" });
  res.clearCookie(REFRESH_COOKIE_NAME, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: 0,
    path: "/",
  });
  res.json({ message: "Logged out successfully" });
};
