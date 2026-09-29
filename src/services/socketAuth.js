/**
 * Socket.IO handshake authentication (FIX: Socket.IO security audit).
 *
 * Reuses the existing HTTP auth architecture — no second auth system:
 *   admin    → ADMIN_COOKIE_NAME cookie or `auth.adminToken`, verified with
 *              verifyAdminToken + an `admins` row (same as middleware/adminAuth.js)
 *   customer → COOKIE_NAME cookie or `auth.token`, verified with
 *              verifyUserToken + a `users` row (same as middleware/auth.js)
 * The `auth.*` fallbacks carry the same in-memory tokens lib/tokenStore.js
 * already attaches as `Authorization: Bearer` to HTTP requests (the Safari
 * cross-site cookie workaround).
 *
 * Rooms are assigned HERE, server-side, from verified identities only.
 * No event lets a client join `admins` or any `customer:<id>` room.
 *
 * Cross-site WebSocket hijacking: browsers attach cookies to a WebSocket
 * handshake from ANY page, and Socket.IO's `cors` option does not stop a
 * websocket upgrade. So ambient cookies are honored only when the
 * handshake's Origin is one of the app's own origins (or absent — a
 * non-browser client, which can only hold cookies it owns). Explicit
 * `auth` tokens are not ambient and need no origin check.
 *
 * Unauthenticated sockets still connect (product:* events are public) but
 * join no private room; they can only follow an order whose UUID they
 * present via "order:track" (see services/orderRealtime.js).
 */
import { createHash } from "node:crypto";
import { query } from "../config/database.js";
import {
  verifyAdminToken,
  verifyUserToken,
  ADMIN_COOKIE_NAME,
  COOKIE_NAME,
} from "../utils/jwt.js";
import { ADMIN_ROOM, customerRoom, orderTrackingRoom } from "./orderRealtime.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TRACKED_ORDERS_PER_SOCKET = 5;
// setTimeout's ceiling; a longer-lived token is re-checked on reconnect.
const MAX_TIMER_MS = 2_147_483_647;

export const parseCookieHeader = (header) => {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || cookies[name] !== undefined) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
};

// FIX (Socket.IO admin session revocation): a logged-out admin session is
// identified by the SHA-256 of its token (the token itself is never stored).
export const hashAdminToken = (token) => createHash("sha256").update(String(token)).digest("hex");

// How often connected admin sockets are re-checked against the DB (admin
// row deleted directly in the database, or a session logged out on another
// backend process). Env-overridable; 0 disables (tests call it directly).
const DEFAULT_ADMIN_REVALIDATE_MS = 60_000;

const normalizeOrigin = (origin) => String(origin || "").trim().replace(/\/$/, "");

const verifyOrNull = (verify, token) => {
  if (!token || typeof token !== "string") return null;
  try {
    return verify(token);
  } catch {
    return null;
  }
};

/**
 * Resolves who a handshake belongs to. Never throws.
 * @returns {Promise<{ adminId: string|null, adminExp: number|null, userId: string|null, userExp: number|null }>}
 */
export const authenticateHandshake = async (
  handshake,
  {
    allowedOrigins = [],
    queryFn = query,
    verifyAdminTokenFn = verifyAdminToken,
    verifyUserTokenFn = verifyUserToken,
  } = {},
) => {
  const identity = { adminId: null, adminExp: null, adminTokenHash: null, userId: null, userExp: null };
  const headers = handshake?.headers || {};
  const origin = normalizeOrigin(headers.origin);
  const cookiesTrusted = !origin || allowedOrigins.map(normalizeOrigin).includes(origin);
  const cookies = cookiesTrusted ? parseCookieHeader(headers.cookie) : {};
  const auth = handshake?.auth || {};

  let adminClaims = null;
  let adminToken = null;
  for (const candidate of [auth.adminToken, cookies[ADMIN_COOKIE_NAME]]) {
    adminClaims = verifyOrNull(verifyAdminTokenFn, candidate);
    if (adminClaims) {
      adminToken = candidate;
      break;
    }
  }
  if (adminClaims?.adminId) {
    try {
      const { rows } = await queryFn("SELECT id FROM admins WHERE id = ? LIMIT 1", [adminClaims.adminId]);
      const tokenHash = hashAdminToken(adminToken);
      // A session that was explicitly logged out can never re-join.
      const { rows: revoked } = rows.length
        ? await queryFn(
            "SELECT token_hash FROM admin_session_revocations WHERE token_hash = ? AND expires_at > NOW() LIMIT 1",
            [tokenHash],
          )
        : { rows: [] };
      if (rows.length && !revoked.length) {
        identity.adminId = rows[0].id;
        identity.adminExp = adminClaims.exp || null;
        identity.adminTokenHash = tokenHash;
      }
    } catch {
      // Fail closed: no admin room.
    }
  }

  const userClaims =
    verifyOrNull(verifyUserTokenFn, auth.token) ||
    verifyOrNull(verifyUserTokenFn, cookies[COOKIE_NAME]);
  if (userClaims?.userId) {
    try {
      const { rows } = await queryFn("SELECT id FROM users WHERE id = ? LIMIT 1", [userClaims.userId]);
      if (rows.length) {
        identity.userId = rows[0].id;
        identity.userExp = userClaims.exp || null;
      }
    } catch {
      // Fail closed: no customer room.
    }
  }

  return identity;
};

// Leaves a room when the token that granted it expires, so a socket that
// outlives its session stops receiving that room's events.
const leaveAtExpiry = (socket, room, expSeconds) => {
  if (!expSeconds) return;
  const delay = expSeconds * 1000 - Date.now();
  if (delay <= 0) {
    socket.leave(room);
    return;
  }
  if (delay > MAX_TIMER_MS) return;
  const timer = setTimeout(() => socket.leave(room), delay);
  timer.unref?.();
  socket.on("disconnect", () => clearTimeout(timer));
};

/**
 * Records a logged-out admin session so its token can never re-join the
 * admin room (checked at every handshake, on every backend process).
 * Kept only until the token would have expired anyway.
 */
export const revokeAdminSession = async (
  { adminId, token },
  { queryFn = query, verifyAdminTokenFn = verifyAdminToken } = {},
) => {
  const claims = verifyOrNull(verifyAdminTokenFn, token);
  if (!claims?.adminId || String(claims.adminId) !== String(adminId)) return { revoked: false };
  const tokenHash = hashAdminToken(token);
  const expSeconds = claims.exp || Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  await queryFn(
    `INSERT IGNORE INTO admin_session_revocations (token_hash, admin_id, expires_at)
     VALUES (?, ?, FROM_UNIXTIME(?))`,
    [tokenHash, String(adminId), expSeconds],
  );
  return { revoked: true, tokenHash };
};

/**
 * Disconnects this process's sockets that belong to one admin — every tab —
 * optionally only those authenticated with one specific session token.
 * Other admins, customers and anonymous sockets are never touched. A
 * server-side disconnect: the client does not auto-reconnect.
 * @returns {Promise<number>} sockets disconnected
 */
export const disconnectAdminSockets = async (io, { adminId, tokenHash } = {}) => {
  if (!io || !adminId) return 0;
  const sockets = await io.in(ADMIN_ROOM).fetchSockets();
  let count = 0;
  for (const socket of sockets) {
    const identity = socket.data?.identity || {};
    if (String(identity.adminId) !== String(adminId)) continue;
    if (tokenHash && identity.adminTokenHash !== tokenHash) continue;
    socket.disconnect(true);
    count += 1;
  }
  return count;
};

/**
 * Re-checks every admin socket connected to this process: the admin row
 * must still exist and its session must not have been logged out (possibly
 * on another process). Catches admins deleted directly in the database —
 * there is no admin-deletion endpoint to hook. Never throws.
 * @returns {Promise<number>} sockets disconnected
 */
export const revalidateAdminSockets = async (io, { queryFn = query } = {}) => {
  try {
    const sockets = await io.in(ADMIN_ROOM).fetchSockets();
    if (!sockets.length) return 0;
    const adminIds = [...new Set(sockets.map((s) => String(s.data?.identity?.adminId)))];
    const hashes = [...new Set(sockets.map((s) => s.data?.identity?.adminTokenHash).filter(Boolean))];
    const { rows: existing } = await queryFn(
      `SELECT id FROM admins WHERE id IN (${adminIds.map(() => "?").join(", ")})`,
      adminIds,
    );
    const { rows: revoked } = hashes.length
      ? await queryFn(
          `SELECT token_hash FROM admin_session_revocations
           WHERE expires_at > NOW() AND token_hash IN (${hashes.map(() => "?").join(", ")})`,
          hashes,
        )
      : { rows: [] };
    const liveAdmins = new Set(existing.map((r) => String(r.id)));
    const revokedHashes = new Set(revoked.map((r) => r.token_hash));
    let count = 0;
    for (const socket of sockets) {
      const identity = socket.data?.identity || {};
      if (!liveAdmins.has(String(identity.adminId)) || revokedHashes.has(identity.adminTokenHash)) {
        socket.disconnect(true);
        count += 1;
      }
    }
    await queryFn("DELETE FROM admin_session_revocations WHERE expires_at <= NOW()").catch(() => {});
    return count;
  } catch (error) {
    console.error("[SOCKET_AUTH] admin socket re-validation failed", { error: error?.message });
    return 0;
  }
};

/**
 * Wires authentication + room assignment onto a Socket.IO server.
 * Called once from server.js.
 */
export const registerSocketSecurity = (io, deps = {}) => {
  const {
    queryFn = query,
    adminRevalidateMs = Number(process.env.ADMIN_SOCKET_REVALIDATE_MS ?? DEFAULT_ADMIN_REVALIDATE_MS),
  } = deps;

  if (adminRevalidateMs > 0) {
    const timer = setInterval(() => {
      revalidateAdminSockets(io, { queryFn });
    }, adminRevalidateMs);
    timer.unref?.();
  }

  io.use(async (socket, next) => {
    try {
      socket.data.identity = await authenticateHandshake(socket.handshake, deps);
    } catch {
      socket.data.identity = { adminId: null, adminExp: null, adminTokenHash: null, userId: null, userExp: null };
    }
    next();
  });

  io.on("connection", (socket) => {
    const identity = socket.data.identity || {};

    if (identity.adminId) {
      socket.join(ADMIN_ROOM);
      leaveAtExpiry(socket, ADMIN_ROOM, identity.adminExp);
    }
    if (identity.userId) {
      const room = customerRoom(identity.userId);
      socket.join(room);
      leaveAtExpiry(socket, room, identity.userExp);
    }

    // Public tracking page: follow ONE order by presenting its UUID — the
    // same credential GET /api/orders/:id/tracking already accepts. The
    // room only ever receives `{ id }` (a "refetch" signal).
    const tracked = new Set();
    socket.on("order:track", async (orderId, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        if (typeof orderId !== "string" || !UUID_RE.test(orderId)) {
          return reply({ ok: false, error: "invalid_order_id" });
        }
        if (!tracked.has(orderId) && tracked.size >= MAX_TRACKED_ORDERS_PER_SOCKET) {
          return reply({ ok: false, error: "too_many_tracked_orders" });
        }
        const { rows } = await queryFn("SELECT id FROM orders WHERE id = ? LIMIT 1", [orderId]);
        if (!rows.length) return reply({ ok: false, error: "not_found" });
        tracked.add(orderId);
        socket.join(orderTrackingRoom(orderId));
        return reply({ ok: true });
      } catch {
        return reply({ ok: false, error: "unavailable" });
      }
    });
  });
};

export default registerSocketSecurity;
