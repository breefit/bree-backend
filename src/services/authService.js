import crypto from "crypto";
import { randomUUID } from "crypto";
import { query } from "../config/database.js";
import { ensureUserCustomerNumber } from "../utils/customerNumber.js";
import { REFRESH_TOKEN_DAYS } from "../utils/jwt.js";

const HASH_ALGORITHM = "sha256";
const REFRESH_TOKEN_SIZE = 64;

// FIX (session-lifetime audit): this used to read REFRESH_TOKEN_EXPIRES_IN_DAYS
// independently, with its own fallback (7) that disagreed with the
// refresh-token COOKIE's hardcoded 30-day maxAge in utils/jwt.js — a
// refresh token whose database row expired after 7 days while its cookie
// was still sitting in the browser for 30. Now imports the exact same
// resolved value jwt.js's REFRESH_COOKIE_OPTIONS.maxAge is computed from,
// so the token's real (database-enforced) validity and its cookie's
// browser-side lifetime can never disagree.
const DEFAULT_REFRESH_DAYS = REFRESH_TOKEN_DAYS;

const hashToken = (token) =>
  crypto.createHash(HASH_ALGORITHM).update(token).digest("hex");

export const createRefreshToken = async (
  userId,
  { userAgent, ipAddress, queryFn = query } = {},
) => {
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_SIZE).toString("hex");

  const tokenHash = hashToken(refreshToken);

  const expiresDate = new Date(
    Date.now() + DEFAULT_REFRESH_DAYS * 24 * 60 * 60 * 1000,
  );

  const tokenId = randomUUID();

  // FIX (timezone audit): this used to pre-format expiresDate into a
  // naive UTC-face-value string (`toISOString().slice(0,19)`) before
  // handing it to the query. That bypassed mysql2's own timezone-aware
  // Date serialization — config/database.js's pool is configured with
  // `timezone: "+05:30"` (matching the "SET time_zone = '+05:30'" used
  // for transactional connections), which mysql2 uses BOTH to convert a
  // real Date parameter into the DATETIME string it sends to MySQL, and
  // to convert a stored DATETIME value back into a Date object when
  // reading a row. A naive UTC string sidesteps the write-side half of
  // that conversion, so the value written and the value later re-read
  // disagreed by exactly the UTC/+05:30 offset (5.5 hours) — the
  // refresh-token session was effectively ~29 days 18.5 hours, not 30.
  // Passing the Date object itself (not a pre-formatted string) lets
  // mysql2 apply the identical +05:30 conversion on write that it
  // already applies on read, so the two are symmetric and the stored
  // value round-trips to the exact original instant.
  await queryFn(
    `
    INSERT INTO refresh_tokens
    (
      id,
      user_id,
      token_hash,
      user_agent,
      ip_address,
      expires_at
    )
    VALUES
    (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    )
    `,
    [
      tokenId,
      userId,
      tokenHash,
      userAgent?.slice(0, 255) || null,
      ipAddress || null,
      expiresDate,
    ],
  );

  return {
    id: tokenId,
    refreshToken,
    expiresAt: expiresDate.toISOString(),
  };
};

export const findRefreshTokenByValue = async (token, { queryFn = query } = {}) => {
  const tokenHash = hashToken(token);

  const { rows } = await queryFn(
    `
    SELECT
      id,
      user_id,
      revoked,
      expires_at
    FROM refresh_tokens
    WHERE token_hash = ?
    `,
    [tokenHash],
  );

  return rows[0];
};

export const revokeRefreshTokenById = async (id, { queryFn = query } = {}) => {
  if (!id) return null;

  const result = await queryFn(
    `
    UPDATE refresh_tokens
    SET revoked = 1
    WHERE id = ?
    `,
    [id],
  );

  return result.rowCount ? { id } : null;
};

export const rotateRefreshToken = async (
  currentToken,
  { userAgent, ipAddress, queryFn = query } = {},
) => {
  const existingToken = await findRefreshTokenByValue(currentToken, { queryFn });

  if (
    !existingToken ||
    existingToken.revoked ||
    new Date(existingToken.expires_at) <= new Date()
  ) {
    return null;
  }

  await revokeRefreshTokenById(existingToken.id, { queryFn });

  return createRefreshToken(existingToken.user_id, {
    userAgent,
    ipAddress,
    queryFn,
  });
};

export const revokeUserRefreshTokens = async (userId, { queryFn = query } = {}) => {
  if (!userId) return null;

  const result = await queryFn(
    `
      UPDATE refresh_tokens
      SET revoked = 1
      WHERE user_id = ?
      `,
    [userId],
  );

  return result.rowCount;
};

export const loadUserById = async (userId, { queryFn = query } = {}) => {
  const { rows } = await queryFn(
    `
    SELECT
      id,
      name,
      email,
      phone,
      picture,
      provider,
      role,
      customer_number
    FROM users
    WHERE id = ?
    `,
    [userId],
  );

  return rows[0];
};
