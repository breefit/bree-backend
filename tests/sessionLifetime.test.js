import test from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  createRefreshToken,
  findRefreshTokenByValue,
  rotateRefreshToken,
  revokeRefreshTokenById,
  revokeUserRefreshTokens,
} from "../src/services/authService.js";
import {
  signUserToken,
  signAdminToken,
  verifyUserToken,
  verifyAdminToken,
  REFRESH_TOKEN_DAYS,
  COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
  ADMIN_COOKIE_OPTIONS,
} from "../src/utils/jwt.js";

/**
 * Session-lifetime audit — customer/user session must persist 30 days via
 * the refresh-token mechanism; admin session (no refresh mechanism, the
 * JWT/cookie pair IS the session) must persist 7 days.
 *
 * These are REAL behavioral tests: real signUserToken/signAdminToken/
 * createRefreshToken/rotateRefreshToken/revokeRefreshTokenById/
 * revokeUserRefreshTokens execute against an in-memory fake `refresh_tokens`
 * table (via the queryFn injection added to authService.js for this audit)
 * and real JWTs are signed/verified with jsonwebtoken. Wall-clock boundaries
 * are proven with node:test's built-in fake Date timers instead of actually
 * waiting days. No production database, no real external API, anywhere in
 * this file.
 *
 * TIMEZONE FIX (this file's fake DB models it symmetrically): config/
 * database.js's mysql2 pool is configured with timezone: "+05:30" — the
 * driver uses that SAME setting both to serialize a Date query PARAMETER
 * into the DATETIME string sent to MySQL, and to parse a stored DATETIME
 * COLUMN back into a Date object on read. createRefreshToken previously
 * pre-formatted its expiry into a naive UTC-face-value string, bypassing
 * the write-side half of that conversion — so the value written and the
 * value later re-read disagreed by exactly the UTC/+05:30 offset (5.5
 * hours), making the effective refresh-token session ~29 days 18.5 hours
 * instead of 30. The fix passes the real Date object as the query
 * parameter so mysql2 applies the identical +05:30 conversion on write
 * that it already applies on read. The fake DB below models BOTH halves
 * of that (write: Date -> naive +05:30 string; read: naive +05:30 string
 * -> Date) so these tests prove the real, now-correct, round trip.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Mirrors mysql2's real Connection#format/escape behavior for this pool's
// timezone: "+05:30" config (verified directly against the installed
// mysql2 package while diagnosing this bug).
const formatAsRealDriverWould = (date) =>
  new Date(date.getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

const parseAsRealDriverWould = (naiveString) =>
  new Date(naiveString.replace(" ", "T") + "+05:30");

// ── In-memory refresh_tokens table, modeling the exact SQL statement
// shapes authService.js issues, including the real driver's timezone
// conversion on both the write and read side. ────────────────────────────
const createFakeRefreshTokensDb = () => {
  const rows = new Map(); // id -> row (expires_at stored as the naive DB string)

  const queryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("INSERT INTO refresh_tokens")) {
      const [id, userId, tokenHash, userAgent, ipAddress, expiresAtParam] = params;
      assert.ok(
        expiresAtParam instanceof Date,
        "createRefreshToken must pass a real Date object for expires_at, not a pre-formatted string, " +
          "so the driver's own timezone-aware serialization is used",
      );
      rows.set(id, {
        id,
        user_id: userId,
        token_hash: tokenHash,
        user_agent: userAgent,
        ip_address: ipAddress,
        revoked: 0,
        expires_at: formatAsRealDriverWould(expiresAtParam),
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      normalized ===
      "SELECT id, user_id, revoked, expires_at FROM refresh_tokens WHERE token_hash = ?"
    ) {
      const [tokenHash] = params;
      const match = [...rows.values()].find((r) => r.token_hash === tokenHash);
      return {
        rows: match
          ? [{ ...match, expires_at: parseAsRealDriverWould(match.expires_at) }]
          : [],
        rowCount: match ? 1 : 0,
      };
    }

    if (normalized === "UPDATE refresh_tokens SET revoked = 1 WHERE id = ?") {
      const [id] = params;
      const row = rows.get(id);
      if (row) row.revoked = 1;
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized === "UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?") {
      const [userId] = params;
      let count = 0;
      for (const row of rows.values()) {
        if (row.user_id === userId) {
          row.revoked = 1;
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    throw new Error(`Unhandled fake SQL in sessionLifetime test: ${normalized}`);
  };

  return { queryFn, rows };
};

// Reads a stored row's real (round-tripped) expiry instant, exactly as
// authService.js itself would see it via a SELECT.
const effectiveExpiryMs = (db, id) =>
  parseAsRealDriverWould(db.rows.get(id).expires_at).getTime();

test.afterEach(() => {
  // Every test that enables fake timers must not leak fake time into the
  // next test in this file.
  try {
    mock.timers.reset();
  } catch {
    // not enabled — fine
  }
});

// ── 1. Centralized configuration values ──────────────────────────────────

test("customer refresh/session lifetime is configured for 30 days", () => {
  assert.equal(REFRESH_TOKEN_DAYS, 30);
  assert.equal(REFRESH_COOKIE_OPTIONS.maxAge, 30 * DAY_MS);
});

test("admin session cookie lifetime is configured for 7 days", () => {
  assert.equal(ADMIN_COOKIE_OPTIONS.maxAge, 7 * DAY_MS);
});

test("the customer access-token cookie stays short-lived, not bumped to the full 30-day session length", () => {
  // The architecture deliberately keeps the access token short-lived and
  // lets the refresh token carry the 30-day session — the access-token
  // cookie must never be as long as (or longer than) the refresh cookie.
  assert.ok(COOKIE_OPTIONS.maxAge < REFRESH_COOKIE_OPTIONS.maxAge);
});

// ── 2. JWT lifetime — proves the ACCESS token stays short (not silently
// made 30 days) and the ADMIN token (which IS the whole admin session,
// unaffected by the DB-timezone fix below) is exactly 7 days. ────────────

test("signed user ACCESS JWT is short-lived (7 days), not the 30-day session length itself", () => {
  const token = signUserToken("user-1");
  const decoded = jwt.decode(token);
  assert.equal(decoded.exp - decoded.iat, 7 * 24 * 60 * 60);
});

test("signed admin JWT — the entire admin session — is exactly 7 days, no more, no less", () => {
  const token = signAdminToken("admin-1");
  const decoded = jwt.decode(token);
  assert.equal(decoded.exp - decoded.iat, 7 * 24 * 60 * 60);
});

test("admin JWT is accepted by verifyAdminToken just before 7 days elapse, and rejected just after (unaffected by the DB-timezone fix — admin has no refresh-token DB row)", () => {
  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(1_700_000_000_000);

  const token = signAdminToken("admin-1");

  mock.timers.tick(7 * DAY_MS - 1000);
  assert.doesNotThrow(() => verifyAdminToken(token), "still valid 1s before the 7-day boundary");

  mock.timers.tick(2000); // now 1s past the 7-day boundary
  assert.throws(
    () => verifyAdminToken(token),
    /jwt expired/i,
    "must be rejected once the 7-day admin session has elapsed",
  );
});

test("user ACCESS JWT is accepted by verifyUserToken just before 7 days elapse, and rejected just after (silent refresh then takes over)", () => {
  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(1_700_000_000_000);

  const token = signUserToken("user-1");

  mock.timers.tick(7 * DAY_MS - 1000);
  assert.doesNotThrow(() => verifyUserToken(token));

  mock.timers.tick(2000);
  assert.throws(() => verifyUserToken(token), /jwt expired/i);
});

// ── 3. Refresh-token session mechanics — this is what makes the customer's
// EFFECTIVE session exactly 30 days (post timezone-fix): login succeeds,
// refresh works inside the window, an expired session is rejected at the
// correct boundary, and logout invalidates it. ───────────────────────────

test("login: createRefreshToken issues a refresh token whose EFFECTIVE (round-tripped) database expiry is exactly 30 days from now — no timezone drift", async () => {
  const db = createFakeRefreshTokensDb();

  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(1_700_000_000_000);

  const issued = await createRefreshToken("user-1", { queryFn: db.queryFn });

  assert.equal(
    effectiveExpiryMs(db, issued.id),
    1_700_000_000_000 + 30 * DAY_MS,
    "the round-tripped (write-then-read) expiry must land exactly on the 30-day mark, not ~5.5 hours short of it",
  );

  // The informational return value also reflects the true intended instant.
  assert.equal(issued.expiresAt, new Date(1_700_000_000_000 + 30 * DAY_MS).toISOString());
});

test("refresh token remains valid at day 29 (well within the 30-day window)", async () => {
  const db = createFakeRefreshTokensDb();
  mock.timers.enable({ apis: ["Date"] });
  const createdAtMs = 1_700_000_000_000;
  mock.timers.setTime(createdAtMs);
  const issued = await createRefreshToken("user-1", { queryFn: db.queryFn });

  mock.timers.tick(29 * DAY_MS);

  const stored = await findRefreshTokenByValue(issued.refreshToken, { queryFn: db.queryFn });
  assert.ok(stored);
  assert.equal(stored.revoked, 0);
  assert.ok(new Date(stored.expires_at) > new Date(), "must not yet be expired at day 29 of a 30-day session");
});

test("refresh works within the 30-day session: rotating a token created 29 days ago succeeds and issues a new 30-day token", async () => {
  const db = createFakeRefreshTokensDb();

  mock.timers.enable({ apis: ["Date"] });
  const createdAtMs = 1_700_000_000_000;
  mock.timers.setTime(createdAtMs);
  const issued = await createRefreshToken("user-1", { queryFn: db.queryFn });

  mock.timers.tick(29 * DAY_MS); // still within the 30-day window

  const rotated = await rotateRefreshToken(issued.refreshToken, { queryFn: db.queryFn });
  assert.ok(rotated, "rotation must succeed while the session is still within its 30-day window");
  assert.notEqual(rotated.refreshToken, issued.refreshToken, "rotation must issue a NEW token (single-use)");

  // The user keeps returning within the window, so their session keeps
  // rolling forward another 30 days from the moment of refresh — this is
  // what "the user remains logged in for up to 30 days through the
  // refresh mechanism" means in practice. With the timezone fix, this is
  // exactly 30 days, not ~29 days 18.5 hours.
  assert.equal(
    effectiveExpiryMs(db, rotated.id),
    createdAtMs + 29 * DAY_MS + 30 * DAY_MS,
  );

  // And the old (rotated-away) token is now revoked — single-use rotation.
  const oldRow = db.rows.get(issued.id);
  assert.equal(oldRow.revoked, 1);
});

test("reload: a valid, non-expired refresh token can be looked up and still authenticates (findRefreshTokenByValue), matching the cookie/refresh reload flow", async () => {
  const db = createFakeRefreshTokensDb();
  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(1_700_000_000_000);

  const issued = await createRefreshToken("user-1", { queryFn: db.queryFn });

  mock.timers.tick(10 * DAY_MS);

  const stored = await findRefreshTokenByValue(issued.refreshToken, { queryFn: db.queryFn });
  assert.ok(stored);
  assert.equal(stored.revoked, 0);
  assert.ok(new Date(stored.expires_at) > new Date(), "must not yet be expired 10 days into a 30-day session");
});

test("expired session is rejected exactly at the intended 30-day boundary — no early (timezone-drift) rejection, no late one either", async () => {
  const db = createFakeRefreshTokensDb();
  mock.timers.enable({ apis: ["Date"] });
  const createdAtMs = 1_700_000_000_000;
  mock.timers.setTime(createdAtMs);
  const issued = await createRefreshToken("user-1", { queryFn: db.queryFn });

  const intendedBoundaryMs = createdAtMs + 30 * DAY_MS;

  // 1 second before the TRUE 30-day boundary: must still succeed. Before
  // the fix this would already have been rejected (effective boundary was
  // ~5.5 hours early).
  mock.timers.setTime(intendedBoundaryMs - 1000);
  const stillValid = await rotateRefreshToken(issued.refreshToken, { queryFn: db.queryFn });
  assert.ok(stillValid, "must still succeed 1s before the true 30-day boundary");

  // Fresh token for a clean boundary check (the previous one was rotated away).
  mock.timers.setTime(createdAtMs);
  const issued2 = await createRefreshToken("user-1", { queryFn: db.queryFn });

  // Advance the fake clock exactly to the true 30-day boundary: the check
  // is `expires_at <= now`, so this must already be rejected.
  mock.timers.setTime(createdAtMs + 30 * DAY_MS);
  const atBoundary = await rotateRefreshToken(issued2.refreshToken, { queryFn: db.queryFn });
  assert.equal(atBoundary, null, "a session exactly at its true 30-day expiry must be rejected, not accepted");

  // And well past 30 days, it must certainly still be rejected.
  mock.timers.setTime(createdAtMs + 31 * DAY_MS);
  const wellPastExpiry = await rotateRefreshToken(issued2.refreshToken, { queryFn: db.queryFn });
  assert.equal(wellPastExpiry, null);
});

test("logout invalidates the session: revokeUserRefreshTokens revokes the token, and a subsequent refresh attempt fails", async () => {
  const db = createFakeRefreshTokensDb();
  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(1_700_000_000_000);

  const issued = await createRefreshToken("user-1", { queryFn: db.queryFn });

  // Well within the 30-day window — would normally still refresh fine.
  mock.timers.tick(1 * DAY_MS);

  await revokeUserRefreshTokens("user-1", { queryFn: db.queryFn });

  const rotated = await rotateRefreshToken(issued.refreshToken, { queryFn: db.queryFn });
  assert.equal(rotated, null, "a revoked (logged-out) session must not be refreshable, even well inside the 30-day window");
});

test("logout via a single token id (revokeRefreshTokenById) also blocks further refresh with that token", async () => {
  const db = createFakeRefreshTokensDb();
  const issued = await createRefreshToken("user-1", { queryFn: db.queryFn });

  await revokeRefreshTokenById(issued.id, { queryFn: db.queryFn });

  const rotated = await rotateRefreshToken(issued.refreshToken, { queryFn: db.queryFn });
  assert.equal(rotated, null);
});

test("an unknown/garbage refresh token is rejected outright (never crashes, never authenticates)", async () => {
  const db = createFakeRefreshTokensDb();
  const rotated = await rotateRefreshToken("not-a-real-token", { queryFn: db.queryFn });
  assert.equal(rotated, null);
});
