/**
 * Socket.IO security (FIX: Socket.IO security audit).
 *
 * A REAL Socket.IO server (the same registerSocketSecurity() server.js
 * installs) on 127.0.0.1 with REAL socket.io-client connections over
 * WebSocket — admins, customers and anonymous clients — and the real
 * controllers publishing through it. Tokens are signed with the same
 * jsonwebtoken secrets utils/jwt.js verifies with. The database is an
 * in-memory fake (admins/users/orders lookups only); no production DB.
 *
 * Every payload any client receives is captured and scanned recursively
 * for sensitive keys and for the actual sensitive VALUES seeded into the
 * order rows the controllers publish.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { io as ioClient } from "socket.io-client";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-user-jwt-secret";
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "test-only-admin-jwt-secret";

const { registerSocketSecurity, parseCookieHeader, MAX_TRACKED_ORDERS_PER_SOCKET } = await import(
  "../src/services/socketAuth.js"
);
const { publishOrderUpdate, toSafeOrderEvent, SAFE_ORDER_EVENT_FIELDS } = await import(
  "../src/services/orderRealtime.js"
);
const { approveReturn, rejectRefund } = await import("../src/controllers/admin/returnController.js");
const { handleWebhook } = await import("../src/controllers/paymentController.js");
const { setProductVisibility } = await import("../src/controllers/admin/productController.js");
const { ADMIN_COOKIE_NAME, COOKIE_NAME } = await import("../src/utils/jwt.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_ORIGIN = "https://www.breefit.test";

// ── Fixtures ─────────────────────────────────────────────────────────────────
const ADMIN_A = "admin-a-0000";
const ADMIN_B = "admin-b-0000";
const CUSTOMER_1 = "user-1111";
const CUSTOMER_2 = "user-2222";
const ORDER_1 = "11111111-1111-4111-8111-111111111111"; // owned by CUSTOMER_1
const ORDER_2 = "22222222-2222-4222-8222-222222222222"; // owned by CUSTOMER_2
const GUEST_ORDER = "33333333-3333-4333-8333-333333333333";

// A full orders row, exactly the shape `SELECT * FROM orders` returns.
const fullOrderRow = (id, userId, overrides = {}) => ({
  id,
  user_id: userId,
  order_number: `BREE-${id.slice(0, 6)}`,
  order_status: "delivered",
  payment_status: "paid",
  customer_name: "Asha Secretname",
  contact_name: "Asha Secretname",
  email: "asha.secret@example.test",
  contact_email: "asha.secret@example.test",
  mobile_number: "9876512345",
  contact_phone: "9876512345",
  shipping_address: "12 Secret Lane, Bengaluru 560001",
  shipping_address_line1: "12 Secret Lane",
  shipping_city: "Bengaluru",
  shipping_pincode: "560001",
  address_id: "addr-secret-1",
  razorpay_order_id: "order_SECRETrzp",
  razorpay_payment_id: "pay_SECRETrzp",
  razorpay_signature: "sig_SECRET",
  refund_reference: "rfnd_SECRETrzp",
  refund_amount: 950,
  total: 950,
  awb_number: "AWBSECRET1",
  reverse_awb: "RAWBSECRET1",
  return_reason: "Secret reason",
  return_notes: "Secret admin note",
  return_status: null,
  inspection_status: null,
  refund_status: null,
  reverse_tracking_status: null,
  reverse_delhivery_response: '{"secret":"payload"}',
  notes: "internal secret",
  updated_at: new Date("2026-09-28T10:00:00Z"),
  ...overrides,
});
const SENSITIVE_VALUES = [
  "Asha Secretname",
  "asha.secret@example.test",
  "9876512345",
  "12 Secret Lane",
  "addr-secret-1",
  "order_SECRETrzp",
  "pay_SECRETrzp",
  "sig_SECRET",
  "rfnd_SECRETrzp",
  "AWBSECRET1",
  "RAWBSECRET1",
  "Secret reason",
  "Secret admin note",
  "internal secret",
  "secret\":\"payload",
];
const SENSITIVE_KEY =
  /password|token|secret|signature|phone|mobile|email|address|pincode|razorpay|refund_id|refund_reference|refund_amount|customer|contact|name|user_id|awb|notes|reason|delhivery_response|total|amount/i;

const db = {
  admins: new Set([ADMIN_A, ADMIN_B]),
  users: new Set([CUSTOMER_1, CUSTOMER_2]),
  orders: new Map([
    [ORDER_1, CUSTOMER_1],
    [ORDER_2, CUSTOMER_2],
    [GUEST_ORDER, null],
  ]),
};
const queryFn = async (sql, params = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (q === "SELECT id FROM admins WHERE id = ? LIMIT 1") return { rows: db.admins.has(params[0]) ? [{ id: params[0] }] : [] };
  if (q === "SELECT id FROM users WHERE id = ? LIMIT 1") return { rows: db.users.has(params[0]) ? [{ id: params[0] }] : [] };
  if (q === "SELECT id FROM orders WHERE id = ? LIMIT 1") return { rows: db.orders.has(params[0]) ? [{ id: params[0] }] : [] };
  if (q.startsWith("SELECT token_hash FROM admin_session_revocations")) return { rows: [] }; // no logged-out sessions in this file
  throw new Error(`unexpected SQL in socket test: ${q}`);
};
const lookupUserId = async (orderId) => db.orders.get(orderId) ?? null;

const adminToken = (adminId, opts = {}) => jwt.sign({ adminId }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h", ...opts });
const userToken = (userId, opts = {}) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "1h", ...opts });

// ── Server + clients ─────────────────────────────────────────────────────────
let httpServer;
let io;
let url;
const clients = [];
const received = []; // { client, event, payload }

before(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer, { cors: { origin: [APP_ORIGIN], credentials: true } });
  registerSocketSecurity(io, { allowedOrigins: [APP_ORIGIN], queryFn, adminRevalidateMs: 0 });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  for (const c of clients) c.socket.close();
  io.close();
  await new Promise((r) => httpServer.close(r));
});

const connect = async (label, { cookies = {}, origin = APP_ORIGIN, auth = {} } = {}) => {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  const extraHeaders = {};
  if (origin) extraHeaders.origin = origin;
  if (cookieHeader) extraHeaders.cookie = cookieHeader;
  const socket = ioClient(url, { transports: ["websocket"], extraHeaders, auth, reconnection: false, forceNew: true });
  const client = { label, socket };
  for (const event of ["order:updated", "product:created", "product:updated", "product:deleted"]) {
    socket.on(event, (payload) => received.push({ client: label, event, payload }));
  }
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  await sleep(30); // server-side room assignment
  clients.push(client);
  return client;
};
const roomsOf = async (client) => {
  const sockets = await io.fetchSockets();
  const s = sockets.find((x) => x.id === client.socket.id);
  return s ? [...s.rooms].filter((r) => r !== s.id).sort() : null;
};
const eventsFor = (label, event = "order:updated") =>
  received.filter((r) => r.client === label && r.event === event).map((r) => r.payload);
const settle = () => sleep(80);
const reset = () => {
  received.length = 0;
};

// Recursive leak scan over every payload any client ever received.
const scanForLeaks = (value, where = "payload") => {
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      assert.ok(!SENSITIVE_KEY.test(key), `sensitive key "${key}" found at ${where}`);
      scanForLeaks(v, `${where}.${key}`);
    }
  }
  const text = typeof value === "string" ? value : "";
  for (const secret of SENSITIVE_VALUES) {
    assert.ok(!text.includes(secret), `sensitive value "${secret}" found at ${where}`);
  }
};
const assertNoLeaks = () => {
  for (const r of received) {
    scanForLeaks(r.payload, `${r.client}/${r.event}`);
    assert.ok(!SENSITIVE_VALUES.some((s) => JSON.stringify(r.payload).includes(s)), `leak in ${r.client}/${r.event}`);
  }
};

// ════════════════════════════════════════════════════════════════════════════
let anon;
let adminA;
let adminB;
let customer1;
let customer2;

test("setup: connect anonymous, two admins (cookie / explicit token) and two customers", async () => {
  anon = await connect("anon");
  adminA = await connect("adminA", { cookies: { [ADMIN_COOKIE_NAME]: adminToken(ADMIN_A) } });
  adminB = await connect("adminB", { auth: { adminToken: adminToken(ADMIN_B) }, origin: null });
  customer1 = await connect("customer1", { cookies: { [COOKIE_NAME]: userToken(CUSTOMER_1) } });
  customer2 = await connect("customer2", { auth: { token: userToken(CUSTOMER_2) } });
});

test("A: an unauthenticated socket connects but is in no private room", async () => {
  assert.deepEqual(await roomsOf(anon), []);
});

test("B: a customer is never placed in the admin room — even presenting its customer JWT as adminToken", async () => {
  assert.deepEqual(await roomsOf(customer1), [`customer:${CUSTOMER_1}`]);
  const sneaky = await connect("sneakyCustomer", { auth: { adminToken: userToken(CUSTOMER_1) } });
  assert.deepEqual(await roomsOf(sneaky), []);
});

test("C: an admin (cookie from the app origin, or explicit admin token) joins the admin room", async () => {
  assert.deepEqual(await roomsOf(adminA), ["admins"]);
  assert.deepEqual(await roomsOf(adminB), ["admins"]);
});

test("C-negative: forged/expired/unknown-admin tokens and cross-site cookies never grant the admin room", async () => {
  const forged = await connect("forged", { auth: { adminToken: jwt.sign({ adminId: ADMIN_A }, "wrong-secret") } });
  const expired = await connect("expired", { auth: { adminToken: adminToken(ADMIN_A, { expiresIn: -10 }) } });
  const deleted = await connect("deletedAdmin", { auth: { adminToken: adminToken("admin-deleted") } });
  // Cross-site WebSocket hijacking: a malicious page opens a socket and the
  // browser attaches the admin's cookie — Origin is the attacker's site.
  const hijack = await connect("hijack", {
    origin: "https://evil.example",
    cookies: { [ADMIN_COOKIE_NAME]: adminToken(ADMIN_A), [COOKIE_NAME]: userToken(CUSTOMER_1) },
  });
  for (const c of [forged, expired, deleted, hijack]) assert.deepEqual(await roomsOf(c), [], c.label);
});

test("D/E/F/H/I/J: a full orders row published → admins get the safe payload, the owner gets it, anonymous and other customers get nothing", async () => {
  reset();
  await publishOrderUpdate(io, fullOrderRow(ORDER_1, CUSTOMER_1, { return_status: "approved" }));
  await settle();

  const expected = {
    id: ORDER_1,
    order_status: "delivered",
    payment_status: "paid",
    return_status: "approved",
    inspection_status: null,
    refund_status: null,
    reverse_tracking_status: null,
    updated_at: "2026-09-28T10:00:00.000Z",
  };
  assert.deepEqual(eventsFor("adminA"), [expected]);
  assert.deepEqual(eventsFor("adminB"), [expected]);
  assert.deepEqual(eventsFor("customer1"), [expected]);
  assert.deepEqual(eventsFor("customer2"), [], "another customer's order never reaches customer2");
  for (const label of ["anon", "sneakyCustomer", "forged", "expired", "deletedAdmin", "hijack"]) {
    assert.deepEqual(eventsFor(label), [], `${label} receives no order data`);
  }
  assert.deepEqual(Object.keys(expected).sort(), [...SAFE_ORDER_EVENT_FIELDS].sort());
  assertNoLeaks();
});

test("10: two customers never receive each other's events; a guest order reaches admins only", async () => {
  reset();
  await Promise.all([
    publishOrderUpdate(io, fullOrderRow(ORDER_1, CUSTOMER_1, { order_status: "shipped" })),
    publishOrderUpdate(io, fullOrderRow(ORDER_2, CUSTOMER_2, { order_status: "cancelled" })),
    publishOrderUpdate(io, { id: GUEST_ORDER, order_status: "paid" }, { lookupUserId }),
  ]);
  await settle();
  assert.deepEqual(eventsFor("customer1").map((e) => e.id), [ORDER_1]);
  assert.deepEqual(eventsFor("customer2").map((e) => e.id), [ORDER_2]);
  assert.deepEqual(eventsFor("adminA").map((e) => e.id).sort(), [ORDER_1, ORDER_2, GUEST_ORDER].sort());
  assert.deepEqual(eventsFor("adminB").map((e) => e.id).sort(), [ORDER_1, ORDER_2, GUEST_ORDER].sort());
  assert.deepEqual(eventsFor("anon"), []);
  assertNoLeaks();
});

test("G: there is no way to self-join a private room — arbitrary join events are ignored and order:track refuses room names/bad ids", async () => {
  for (const [event, arg] of [
    ["join", "admins"],
    ["join", `customer:${CUSTOMER_2}`],
    ["join", { userId: CUSTOMER_2 }],
    ["subscribe", "admins"],
  ]) {
    customer1.socket.emit(event, arg);
    anon.socket.emit(event, arg);
  }
  const replies = await Promise.all(
    ["admins", `customer:${CUSTOMER_2}`, "not-a-uuid", { id: ORDER_2 }].map(
      (arg) => new Promise((r) => anon.socket.emit("order:track", arg, r)),
    ),
  );
  assert.ok(replies.every((r) => r.ok === false && r.error === "invalid_order_id"));
  const missing = await new Promise((r) => anon.socket.emit("order:track", "44444444-4444-4444-8444-444444444444", r));
  assert.deepEqual(missing, { ok: false, error: "not_found" });
  await sleep(30);
  assert.deepEqual(await roomsOf(anon), []);
  assert.deepEqual(await roomsOf(customer1), [`customer:${CUSTOMER_1}`]);

  reset();
  await publishOrderUpdate(io, fullOrderRow(ORDER_2, CUSTOMER_2));
  await settle();
  assert.deepEqual(eventsFor("customer1"), []);
  assert.deepEqual(eventsFor("anon"), []);
});

test("public tracking page: a socket that presents an order's UUID gets `{ id }` only for THAT order — never another order, never data", async () => {
  const tracker = await connect("tracker");
  const ok = await new Promise((r) => tracker.socket.emit("order:track", ORDER_1, r));
  assert.deepEqual(ok, { ok: true });
  reset();
  await publishOrderUpdate(io, fullOrderRow(ORDER_1, CUSTOMER_1, { refund_status: "completed" }));
  await publishOrderUpdate(io, fullOrderRow(ORDER_2, CUSTOMER_2));
  await settle();
  assert.deepEqual(eventsFor("tracker"), [{ id: ORDER_1 }]);
  assertNoLeaks();

  // Bounded: a socket cannot fan out over many orders.
  const greedy = await connect("greedy");
  const ids = Array.from({ length: MAX_TRACKED_ORDERS_PER_SOCKET + 1 }, (_, i) => {
    const id = `5555555${i}-5555-4555-8555-555555555555`;
    db.orders.set(id, null);
    return id;
  });
  const results = [];
  for (const id of ids) results.push(await new Promise((r) => greedy.socket.emit("order:track", id, r)));
  assert.equal(results.filter((r) => r.ok).length, MAX_TRACKED_ORDERS_PER_SOCKET);
  assert.deepEqual(results.at(-1), { ok: false, error: "too_many_tracked_orders" });
});

test("K: a real approveReturn (full SELECT * row with PII) reaches both admins with return_status, the owner too, nobody else, no PII", async () => {
  reset();
  const row = fullOrderRow(ORDER_1, CUSTOMER_1, { delivered_at: new Date(Date.now() - 3600_000) });
  const client = {
    query: async (sql) => {
      const q = sql.replace(/\s+/g, " ").trim();
      if (q.includes("FOR UPDATE")) return { rows: [{ ...row }] };
      if (q.startsWith("UPDATE orders")) return { rows: [], rowCount: 1 };
      if (q.startsWith("UPDATE daily_reminders")) return { rows: [], rowCount: 0 };
      if (q.startsWith("SELECT * FROM orders")) return { rows: [{ ...row, return_status: "approved" }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await approveReturn(
    { params: { orderId: ORDER_1 }, body: { reason: "Secret reason" }, admin: { id: ADMIN_A }, app: { locals: { io } } },
    res,
    { getClientFn: async () => client },
  );
  assert.equal(res.statusCode, 200);
  await settle();
  assert.equal(eventsFor("adminA")[0]?.return_status, "approved");
  assert.equal(eventsFor("adminB")[0]?.return_status, "approved");
  assert.equal(eventsFor("customer1")[0]?.return_status, "approved");
  assert.deepEqual(eventsFor("customer2"), []);
  assert.deepEqual(eventsFor("anon"), []);
  assertNoLeaks();
});

test("L: a real rejectRefund and a real refund.processed webhook reach the admins with refund state, no refund id/amount", async () => {
  reset();
  const row = fullOrderRow(ORDER_1, CUSTOMER_1, {
    return_status: "returned",
    inspection_status: "approved",
    refund_status: null,
    contact_email: null,
    email: null,
    contact_phone: null,
    mobile_number: null,
  });
  const client = {
    query: async (sql) => {
      const q = sql.replace(/\s+/g, " ").trim();
      if (q.includes("FOR UPDATE")) return { rows: [{ ...row }] };
      if (q.startsWith("UPDATE orders")) return { rows: [], rowCount: 1 };
      if (q.startsWith("SELECT * FROM orders")) return { rows: [{ ...row, refund_status: "rejected" }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await rejectRefund(
    { params: { orderId: ORDER_1 }, body: { reason: "Secret reason" }, admin: { id: ADMIN_A }, app: { locals: { io } } },
    res,
    { getClientFn: async () => client },
  );
  assert.equal(res.statusCode, 200);

  // refund.processed webhook — the payment controller's emit path.
  const initiated = fullOrderRow(ORDER_2, CUSTOMER_2, { refund_status: "initiated", refund_reference: "rfnd_SECRETrzp" });
  const webhookDb = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("INSERT INTO webhook_events")) return { rows: [], rowCount: 1 };
    if (q.startsWith("UPDATE webhook_events")) return { rows: [], rowCount: 1 };
    if (q.startsWith("SELECT * FROM orders WHERE refund_reference")) return { rows: [{ ...initiated }] };
    if (q.startsWith("UPDATE orders SET refund_status = 'completed'")) return { rows: [], rowCount: 1 };
    if (q.startsWith("UPDATE payments")) return { rows: [], rowCount: 1 };
    if (q.startsWith("INSERT INTO order_status_history")) return { rows: [], rowCount: 1 };
    if (q === "SELECT * FROM orders WHERE id = ? LIMIT 1") return { rows: [{ ...initiated, refund_status: "completed" }] };
    return { rows: [], rowCount: 0 };
  };
  process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "test-only-webhook-secret";
  const payload = {
    event: "refund.processed",
    payload: { refund: { entity: { id: "rfnd_SECRETrzp", payment_id: "pay_SECRETrzp", status: "processed" } } },
  };
  const rawBody = JSON.stringify(payload);
  const { createHmac } = await import("node:crypto");
  const signature = createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const hookRes = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handleWebhook(
    { headers: { "x-razorpay-signature": signature }, rawBody, body: payload, app: { locals: { io } } },
    hookRes,
    { queryFn: webhookDb, notifyRefundEvent: () => {} },
  );
  await settle();

  const adminEvents = eventsFor("adminA");
  assert.ok(adminEvents.some((e) => e.id === ORDER_1 && e.refund_status === "rejected"), JSON.stringify(adminEvents));
  assert.ok(adminEvents.some((e) => e.id === ORDER_2 && e.order_status === "delivered"), "webhook update reaches admins");
  assert.deepEqual(eventsFor("adminB").map((e) => e.id).sort(), adminEvents.map((e) => e.id).sort());
  assert.deepEqual(eventsFor("anon"), []);
  assertNoLeaks();
});

test("M: shipping/status updates publish through the same admin-room path (safe payload)", async () => {
  reset();
  // Exactly what admin/orderController.updateOrderStatus passes: the
  // `SELECT * FROM orders` row after a shipping status change.
  await publishOrderUpdate(io, fullOrderRow(ORDER_2, CUSTOMER_2, { order_status: "shipped" }));
  await settle();
  assert.equal(eventsFor("adminA")[0].order_status, "shipped");
  assert.equal(eventsFor("customer2")[0].order_status, "shipped");
  assert.deepEqual(eventsFor("customer1"), []);
  assert.deepEqual(eventsFor("anon"), []);
  assertNoLeaks();
});

test("11: product events carry { id } only (no razorpay_plan_id / admin-only columns) and still reach the storefront", async () => {
  reset();
  const productRow = {
    id: "prod-1",
    name: "Amla 7 Day",
    price: 950,
    is_visible: 1,
    is_active: 1,
    razorpay_plan_id: "plan_SECRETrzp",
    display_order: 3,
    discount: 5,
  };
  const productDb = async (sql) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id, name, is_visible FROM products")) return { rows: [{ id: "prod-1", name: "Amla 7 Day", is_visible: 0 }] };
    if (q.startsWith("UPDATE products")) return { rows: [], rowCount: 1 };
    if (q.startsWith("SELECT * FROM products")) return { rows: [productRow] };
    return { rows: [] };
  };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await setProductVisibility(
    { params: { id: "prod-1" }, body: { is_visible: true }, admin: { id: ADMIN_A }, app: { locals: { io } } },
    res,
    { queryFn: productDb },
  );
  await settle();
  for (const label of ["anon", "customer1", "adminA"]) {
    assert.deepEqual(eventsFor(label, "product:updated"), [{ id: "prod-1" }], label);
  }
  assert.ok(!JSON.stringify(received).includes("plan_SECRETrzp"));
});

test("token expiry: a socket leaves the admin room when the admin JWT that granted it expires", async () => {
  // exp has 1-second granularity: 2s guarantees ≥1s of validity at connect.
  const token = adminToken(ADMIN_A, { expiresIn: 2 });
  const { exp } = jwt.decode(token);
  const shortLived = await connect("shortLivedAdmin", { auth: { adminToken: token } });
  assert.deepEqual(await roomsOf(shortLived), ["admins"]);
  await sleep(exp * 1000 - Date.now() + 300);
  assert.deepEqual(await roomsOf(shortLived), []);
  reset();
  await publishOrderUpdate(io, fullOrderRow(ORDER_1, CUSTOMER_1));
  await settle();
  assert.deepEqual(eventsFor("shortLivedAdmin"), []);
});

test("unit: toSafeOrderEvent whitelists fields and never invents missing keys (a merge never blanks other fields)", () => {
  assert.deepEqual(toSafeOrderEvent({ id: "x", order_status: "paid", contact_phone: "9", razorpay_payment_id: "p" }), {
    id: "x",
    order_status: "paid",
  });
  assert.deepEqual(parseCookieHeader(`a=1; ${ADMIN_COOKIE_NAME}=tok%2Ben; a=2`), { a: "1", [ADMIN_COOKIE_NAME]: "tok+en" });
});

test("static: no backend file emits on the Socket.IO server except services/orderRealtime.js", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        const rel = path.relative(root, full);
        if (rel === path.join("src", "services", "orderRealtime.js")) continue;
        fs.readFileSync(full, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) return;
            // Any emit on the server: io.emit(...), io.to/in/except(...)...emit(...),
            // req.app.locals.io.emit(...), socket.broadcast.emit(...). Reads such
            // as io.in(room).fetchSockets() (admin revocation) are allowed.
            if (/\bio\??\.emit\s*\(|\bio\??\.(to|in|except)\s*\(.*\.emit\s*\(|locals\??\.io\??\.emit|\.broadcast\.emit\s*\(/.test(line)) {
              offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
            }
          });
      }
    }
  };
  walk(path.join(root, "src"));
  walk(path.join(root, "cron"));
  assert.deepEqual(offenders, []);
});
