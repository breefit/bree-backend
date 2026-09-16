import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import app from "../src/app.js";
import { closePool } from "../src/config/database.js";

/**
 * PHASE 3 — Medium Issue #1: send-otp/resend-otp previously had no
 * dedicated rate limit — only the shared 200 req/min/IP limiter and a 30s
 * per-MOBILE cooldown, so one IP could cycle through many different mobile
 * numbers to spam WhatsApp OTPs. A dedicated 10-requests/15min/IP limiter
 * was added in app.js, scoped to send-otp/resend-otp only (verify-otp keeps
 * its own attempt-based brute-force guard and must not be extra-limited).
 *
 * This drives real HTTP requests against the actual Express app (no
 * production DB — validation fails before any DB/WhatsApp call, and no real
 * WAPLIFY send happens either way since the limiter fires before the
 * request reaches the controller).
 */

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const httpServer = app.listen(0, "127.0.0.1", () => resolve(httpServer));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePool();
});

const postOtp = (path, mobile) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile }),
  });

test("send-otp is rate-limited per IP after 10 requests within the window, even across DIFFERENT mobile numbers", async () => {
  const responses = [];
  for (let i = 0; i < 11; i += 1) {
    // A different mobile number each time — proves this isn't just the
    // pre-existing 30s-per-mobile cooldown, but a real per-IP ceiling that
    // can't be bypassed by cycling numbers.
    const mobile = String(9000000000 + i);
    // eslint-disable-next-line no-await-in-loop
    responses.push(await postOtp("/api/auth/send-otp", mobile));
  }

  const statuses = responses.map((r) => r.status);
  const limited = statuses.filter((s) => s === 429);
  assert.ok(limited.length >= 1, "the 11th request within the window must be rate-limited (429)");
  assert.equal(statuses[10], 429, "specifically the 11th request must be the one rejected");
});

test("resend-otp shares the same per-IP limiter budget as send-otp (both count against the same 10/15min ceiling)", async () => {
  // Exhaust the budget via send-otp, then confirm resend-otp is ALSO
  // blocked — proving they share one limiter instance/IP bucket, not two
  // independent 10-request budgets that would double the real ceiling.
  for (let i = 0; i < 10; i += 1) {
    const mobile = String(9100000000 + i);
    // eslint-disable-next-line no-await-in-loop
    await postOtp("/api/auth/send-otp", mobile);
  }

  const resendResponse = await postOtp("/api/auth/resend-otp", "9199999999");
  assert.equal(resendResponse.status, 429);
});

test("verify-otp is NOT subject to the new send/resend limiter (its own attempt-based guard is the correct control)", async () => {
  // Exhaust the send/resend budget first.
  for (let i = 0; i < 10; i += 1) {
    const mobile = String(9200000000 + i);
    // eslint-disable-next-line no-await-in-loop
    await postOtp("/api/auth/send-otp", mobile);
  }

  const verifyResponse = await fetch(`${baseUrl}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile: "9299999999", otp: "123456" }),
  });

  // Must reach route validation/controller logic (400 for "no active OTP"),
  // not be blocked by the send/resend limiter (429).
  assert.notEqual(verifyResponse.status, 429);
});

test("the shared authLimiter is no longer bound to nonexistent /register or /login routes", async () => {
  // These routes don't exist in routes/auth.js at all — confirm they 404,
  // not get caught by leftover dead rate-limiter middleware in some way
  // that would mask the real 404.
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, { method: "POST" });
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, { method: "POST" });
  assert.equal(registerResponse.status, 404);
  assert.equal(loginResponse.status, 404);
});
