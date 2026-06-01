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

const SALT_ROUNDS = 12;

const safeUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  picture: u.picture,
  provider: u.provider,
  role: u.role || "user",
});

const setAuthCookies = async (res, userId, req) => {
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

// POST /api/auth/register
export const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    const existing = await query(
      "SELECT id FROM users WHERE email = ?",
      [email.toLowerCase()]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        message: "Email already in use",
      });
    }

    const userId = randomUUID();
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);

    await query(
      `INSERT INTO users (
        id,
        name,
        email,
        password,
        provider
      ) VALUES (?, ?, ?, ?, 'email')`,
      [
        userId,
        name.trim(),
        email.toLowerCase(),
        hashed,
      ]
    );

    const { rows } = await query(
      `SELECT id, name, email, phone, picture, provider, role
       FROM users
       WHERE id = ?`,
      [userId]
    );

    const user = rows[0];

    const accessToken = await setAuthCookies(
      res,
      user.id,
      req
    );

    return res.status(201).json({
      ...safeUser(user),
      accessToken,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/login
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const { rows } = await query(
      "SELECT id, name, email, phone, picture, provider, role, password FROM users WHERE email = ?",
      [email.toLowerCase()],
    );

    if (!rows.length) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = rows[0];
    if (!user.password) {
      return res.status(400).json({
        message:
          "This account was created with Google. Please sign in with Google instead.",
      });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const accessToken = await setAuthCookies(res, user.id, req);
    res.json({ ...safeUser(user), accessToken });
  } catch (error) {
    next(error);
  }
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
  [userId, name.trim(), email, picture]
);

    const { rows } = await query(
      `SELECT id, name, email, phone, picture, provider, role
       FROM users WHERE email = ?`,
      [email],
    );

    const user = rows[0];
    const accessToken = await setAuthCookies(res, user.id, req);
    return res.json({ ...safeUser(user), accessToken });
  } catch (error) {
    console.error("Error creating or updating Google user:", error);
    return res
      .status(500)
      .json({ message: "Unable to complete Google sign-in at this time." });
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
