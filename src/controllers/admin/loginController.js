import bcrypt from "bcryptjs";
import { query } from "../../config/database.js";
import { revokeAdminSession, disconnectAdminSockets } from "../../services/socketAuth.js";
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

    res.json({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
    });
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

// FIX (Socket.IO admin session revocation): logout used to clear only the
// cookie. The admin JWT itself stayed valid, so every open tab's socket kept
// receiving admin order events and a reconnect re-joined the admin room.
// Now the session token(s) presented on this request are recorded as
// revoked (refused at every later socket handshake, on every backend
// process) and every socket of THIS session — all its tabs — is
// disconnected. The admin's other sessions/devices, other admins and
// customers are untouched. HTTP authorization is unchanged.
// `deps` is injectable only for tests; Express passes `next` here, which
// simply falls back to the defaults.
export const adminLogout = async (req, res, deps) => {
  const queryFn = typeof deps?.queryFn === "function" ? deps.queryFn : query;
  const authHeader = req.headers?.authorization;
  const tokens = [
    req.cookies?.[ADMIN_COOKIE_NAME],
    authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null,
  ].filter(Boolean);
  const adminId = req.admin?.id;

  for (const token of new Set(tokens)) {
    try {
      const { revoked, tokenHash } = await revokeAdminSession({ adminId, token }, { queryFn });
      if (revoked) {
        const disconnected = await disconnectAdminSockets(req.app?.locals?.io, { adminId, tokenHash });
        console.info("[ADMIN_LOGOUT] session revoked", { adminId, socketsDisconnected: disconnected });
      }
    } catch (error) {
      console.error("[ADMIN_LOGOUT] could not revoke admin session", { adminId, error: error?.message });
    }
  }

  res.clearCookie(ADMIN_COOKIE_NAME, {
    ...ADMIN_COOKIE_OPTIONS,
    maxAge: 0,
  });
  res.json({ message: "Logged out successfully" });
};
