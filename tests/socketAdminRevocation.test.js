/**
 * Socket.IO admin session revocation (FIX: runtime audit hardening gap).
 *
 * A REAL Socket.IO server with registerSocketSecurity() (as server.js
 * installs it), REAL socket.io-client WebSocket connections, the REAL
 * adminLogout controller and the REAL revalidateAdminSockets sweep.
 * The DB is an in-memory fake modelling admins / users /
 * admin_session_revocations; the last test runs the real SQL against a
 * throwaway MySQL (TEST_DATABASE_URL — never production), skipped without it.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { io as ioClient } from "socket.io-client";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-user-jwt-secret";
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "test-only-admin-jwt-secret";

const {
  registerSocketSecurity,
  revalidateAdminSockets,
  revokeAdminSession,
  hashAdminToken,
} = await import("../src/services/socketAuth.js");
const { publishOrderUpdate } = await import("../src/services/orderRealtime.js");
const { adminLogout } = await import("../src/controllers/admin/loginController.js");
const { ADMIN_COOKIE_NAME, COOKIE_NAME } = await import("../src/utils/jwt.js");

const HAS_TEST_DB = Boolean(process.env.TEST_DATABASE_URL?.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "https://www.breefit.test";

// ── In-memory DB ─────────────────────────────────────────────────────────────
const store = {
  admins: new Set(["admin-A", "admin-B", "admin-R"]),
  users: new Set(["user-C"]),
  revocations: new Map(), // token_hash -> { adminId, expiresAtMs }
};
const live = (hash) => {
  const r = store.revocations.get(hash);
  return Boolean(r && r.expiresAtMs > Date.now());
};
const queryFn = async (sql, params = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (q === "SELECT id FROM admins WHERE id = ? LIMIT 1") return { rows: store.admins.has(params[0]) ? [{ id: params[0] }] : [] };
  if (q === "SELECT id FROM users WHERE id = ? LIMIT 1") return { rows: store.users.has(params[0]) ? [{ id: params[0] }] : [] };
  if (q === "SELECT token_hash FROM admin_session_revocations WHERE token_hash = ? AND expires_at > NOW() LIMIT 1") {
    return { rows: live(params[0]) ? [{ token_hash: params[0] }] : [] };
  }
  if (q.startsWith("INSERT IGNORE INTO admin_session_revocations")) {
    const [hash, adminId, expSeconds] = params;
    if (!store.revocations.has(hash)) store.revocations.set(hash, { adminId, expiresAtMs: expSeconds * 1000 });
    return { rows: [], rowCount: 1 };
  }
  if (q.startsWith("SELECT id FROM admins WHERE id IN (")) return { rows: params.filter((id) => store.admins.has(id)).map((id) => ({ id })) };
  if (q.startsWith("SELECT token_hash FROM admin_session_revocations WHERE expires_at > NOW() AND token_hash IN (")) {
    return { rows: params.filter(live).map((token_hash) => ({ token_hash })) };
  }
  if (q === "DELETE FROM admin_session_revocations WHERE expires_at <= NOW()") return { rows: [], rowCount: 0 };
  throw new Error(`unexpected SQL in revocation test: ${q}`);
};

// Each call = a distinct login session. (Two real logins by the same admin
// within the same second would yield byte-identical JWTs — see report.)
const adminToken = (adminId) => jwt.sign({ adminId, jti: randomUUID() }, process.env.ADMIN_JWT_SECRET, { expiresIn: "7d" });
const userToken = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });

// ── Server + clients ─────────────────────────────────────────────────────────
let httpServer;
let io;
let url;
let otherAdmin;
let customer;
const clients = [];
before(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  registerSocketSecurity(io, { allowedOrigins: [ORIGIN], queryFn, adminRevalidateMs: 0 });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${httpServer.address().port}`;
  otherAdmin = await connect("admin-B", { adminCookie: adminToken("admin-B") });
  customer = await connect("customer-C", { userCookie: userToken("user-C") });
});
after(async () => {
  for (const c of clients) c.socket.close();
  io.close();
  await new Promise((r) => httpServer.close(r));
});

const connect = async (label, { adminCookie, bearerAdmin, userCookie } = {}) => {
  const cookies = [];
  if (adminCookie) cookies.push(`${ADMIN_COOKIE_NAME}=${adminCookie}`);
  if (userCookie) cookies.push(`${COOKIE_NAME}=${userCookie}`);
  // Same client options the frontend uses (reconnection on).
  const socket = ioClient(url, {
    transports: ["websocket"],
    extraHeaders: { origin: ORIGIN, ...(cookies.length ? { cookie: cookies.join("; ") } : {}) },
    auth: bearerAdmin ? { adminToken: bearerAdmin } : {},
    forceNew: true,
    reconnectionDelay: 50,
    reconnectionDelayMax: 100,
  });
  const client = { label, socket, events: [], disconnects: [] };
  socket.on("order:updated", (p) => client.events.push(p));
  socket.on("disconnect", (reason) => client.disconnects.push(reason));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", (e) => reject(new Error(`${label}: connect_error ${e.message} (${url})`)));
  });
  await sleep(40);
  clients.push(client);
  return client;
};
const inAdminRoom = async (client) => {
  const s = (await io.fetchSockets()).find((x) => x.id === client.socket.id);
  return Boolean(s?.rooms.has("admins"));
};
const publish = async () => {
  const id = randomUUID();
  await publishOrderUpdate(io, { id, order_status: "shipped", user_id: "user-C" });
  await sleep(80);
  return id;
};
const gotEvent = (client, id) => client.events.some((e) => e.id === id);

const logout = async ({ adminId, cookieToken, bearerToken }) => {
  const cleared = [];
  const res = {
    statusCode: 200,
    clearCookie: (name) => cleared.push(name),
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  await adminLogout(
    {
      admin: { id: adminId },
      cookies: cookieToken ? { [ADMIN_COOKIE_NAME]: cookieToken } : {},
      headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : {},
      app: { locals: { io } },
    },
    res,
    { queryFn },
  );
  return { res, cleared };
};

// Fixed actors (connected in before()), present for the whole file.
const assertBystandersUnaffected = async () => {
  assert.equal(otherAdmin.socket.connected, true, "another admin is never disconnected");
  assert.deepEqual(otherAdmin.disconnects, []);
  assert.equal(await inAdminRoom(otherAdmin), true);
  assert.equal(customer.socket.connected, true, "customers are never disconnected");
  assert.deepEqual(customer.disconnects, []);
  const id = await publish();
  assert.ok(gotEvent(otherAdmin, id), "another admin still receives admin order events");
  assert.ok(gotEvent(customer, id), "the customer still receives their own order events");
};

// ════════════════════════════════════════════════════════════════════════════
test("one admin / one socket: logout disconnects it (server-side, no auto-reconnect) and the session can never re-join", async () => {
  const token = adminToken("admin-A");
  const tab = await connect("A-tab", { adminCookie: token });
  assert.equal(await inAdminRoom(tab), true);

  const { res, cleared } = await logout({ adminId: "admin-A", cookieToken: token });
  assert.equal(res.body.message, "Logged out successfully");
  assert.deepEqual(cleared, [ADMIN_COOKIE_NAME], "HTTP session still invalidated as before (cookie cleared)");
  await sleep(150);
  assert.equal(tab.socket.connected, false);
  assert.deepEqual(tab.disconnects, ["io server disconnect"]);
  await sleep(300);
  assert.equal(tab.socket.connected, false, "does not auto-reconnect");

  const reuse = await connect("A-reuse", { adminCookie: token });
  assert.equal(await inAdminRoom(reuse), false, "a logged-out token is refused at handshake");
  const id = await publish();
  assert.equal(gotEvent(reuse, id), false);
  await assertBystandersUnaffected();
});

test("one admin / two sockets (two tabs, same session): logout disconnects BOTH; the admin's other device is untouched", async () => {
  const session = adminToken("admin-A");
  const otherDeviceToken = adminToken("admin-A");
  const tab1 = await connect("A-tab1", { adminCookie: session });
  const tab2 = await connect("A-tab2", { bearerAdmin: session }); // in-memory Bearer token path
  const laptop = await connect("A-laptop", { adminCookie: otherDeviceToken });

  await logout({ adminId: "admin-A", cookieToken: session, bearerToken: session });
  await sleep(150);
  assert.equal(tab1.socket.connected, false);
  assert.equal(tab2.socket.connected, false);
  assert.deepEqual([tab1.disconnects, tab2.disconnects], [["io server disconnect"], ["io server disconnect"]]);

  assert.equal(laptop.socket.connected, true, "a different session of the same admin is not logged out");
  assert.equal(await inAdminRoom(laptop), true);
  const id = await publish();
  assert.ok(gotEvent(laptop, id));
  assert.equal(gotEvent(tab1, id) || gotEvent(tab2, id), false);
  await assertBystandersUnaffected();
});

test("revoked (deleted) admin: every socket is disconnected by the re-validation sweep and cannot reconnect to the admins room", async () => {
  const token = adminToken("admin-R");
  const r1 = await connect("R-tab1", { adminCookie: token });
  const r2 = await connect("R-tab2", { bearerAdmin: token });
  assert.equal(await inAdminRoom(r1), true);

  store.admins.delete("admin-R"); // deleted directly in the database — no endpoint exists
  const disconnected = await revalidateAdminSockets(io, { queryFn });
  assert.equal(disconnected, 2, "exactly the deleted admin's two sockets");
  await sleep(150);
  assert.equal(r1.socket.connected, false);
  assert.equal(r2.socket.connected, false);

  const again = await connect("R-again", { adminCookie: token });
  assert.equal(await inAdminRoom(again), false);
  const id = await publish();
  assert.equal(gotEvent(again, id), false);

  // A sweep with nothing to revoke disconnects nobody.
  assert.equal(await revalidateAdminSockets(io, { queryFn }), 0);
  await assertBystandersUnaffected();
});

test("a session logged out on ANOTHER backend process (revocation row only) is disconnected here by the sweep", async () => {
  const token = adminToken("admin-A");
  const tab = await connect("A-elsewhere", { adminCookie: token });
  assert.equal(await inAdminRoom(tab), true);
  await revokeAdminSession({ adminId: "admin-A", token }, { queryFn }); // what process B's logout wrote
  assert.equal(await revalidateAdminSockets(io, { queryFn }), 1);
  await sleep(150);
  assert.equal(tab.socket.connected, false);
  await assertBystandersUnaffected();
});

test("logout cannot be used to revoke another admin's session", async () => {
  const bToken = adminToken("admin-B");
  const { revoked } = await revokeAdminSession({ adminId: "admin-A", token: bToken }, { queryFn });
  assert.equal(revoked, false);
  assert.equal(live(hashAdminToken(bToken)), false);
  await assertBystandersUnaffected();
});

test("real SQL: revocation insert, handshake lookup, re-validation IN() queries and expiry purge work on MySQL", { skip: HAS_TEST_DB ? false : "TEST_DATABASE_URL not configured" }, async () => {
  const db = await import("../src/config/database.js");
  try {
    await db.ensureAdminSessionRevocationsTable();
    const adminId = randomUUID();
    await db.query(`INSERT INTO admins (id, email, password, name) VALUES (?, ?, 'x', 'Revocation Test')`, [adminId, `rev-${adminId}@bree.test`]);
    const token = adminToken(adminId);
    const { revoked, tokenHash } = await revokeAdminSession({ adminId, token });
    assert.equal(revoked, true);
    await revokeAdminSession({ adminId, token }); // idempotent (INSERT IGNORE)
    const { rows } = await db.query(
      "SELECT token_hash, admin_id, expires_at > NOW() AS active FROM admin_session_revocations WHERE token_hash = ?",
      [tokenHash],
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].active), 1);
    const exp = jwt.decode(token).exp;
    const { rows: [e] } = await db.query("SELECT UNIX_TIMESTAMP(expires_at) AS t FROM admin_session_revocations WHERE token_hash = ?", [tokenHash]);
    assert.equal(Number(e.t), exp, "kept exactly until the token's own expiry (no timezone shift)");

    // Handshake path on the real DB.
    const { authenticateHandshake } = await import("../src/services/socketAuth.js");
    const identity = await authenticateHandshake({ headers: {}, auth: { adminToken: token } });
    assert.equal(identity.adminId, null, "revoked token refused by the real SQL");
    const fresh = jwt.sign({ adminId, n: 2 }, process.env.ADMIN_JWT_SECRET, { expiresIn: "7d" });
    const freshIdentity = await authenticateHandshake({ headers: {}, auth: { adminToken: fresh } });
    assert.equal(freshIdentity.adminId, adminId);

    // Re-validation sweep's IN() queries on the real DB (socket list stubbed).
    const stubSocket = (identity) => ({ data: { identity }, disconnected: false, disconnect() { this.disconnected = true; } });
    const revokedSocket = stubSocket({ adminId, adminTokenHash: tokenHash });
    const liveSocket = stubSocket({ adminId, adminTokenHash: freshIdentity.adminTokenHash });
    const stubIo = { in: () => ({ fetchSockets: async () => [revokedSocket, liveSocket] }) };
    assert.equal(await revalidateAdminSockets(stubIo), 1);
    assert.deepEqual([revokedSocket.disconnected, liveSocket.disconnected], [true, false]);
    await db.query("DELETE FROM admins WHERE id = ?", [adminId]);
    const deletedSocket = stubSocket({ adminId, adminTokenHash: freshIdentity.adminTokenHash });
    assert.equal(await revalidateAdminSockets({ in: () => ({ fetchSockets: async () => [deletedSocket] }) }), 1, "deleted admin detected by the real IN() query");

    await db.query("UPDATE admin_session_revocations SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE token_hash = ?", [tokenHash]);
    await db.query("DELETE FROM admin_session_revocations WHERE expires_at <= NOW()");
    assert.equal((await db.query("SELECT 1 FROM admin_session_revocations WHERE token_hash = ?", [tokenHash])).rows.length, 0);
  } finally {
    await db.closePool();
  }
});
