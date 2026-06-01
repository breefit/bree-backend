import crypto from "crypto";
import { randomUUID } from "crypto";
import { query } from "../config/database.js";

const HASH_ALGORITHM = "sha256";
const REFRESH_TOKEN_SIZE = 64;

const DEFAULT_REFRESH_DAYS =
  parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS, 10) || 7;

const hashToken = (token) =>
  crypto.createHash(HASH_ALGORITHM).update(token).digest("hex");

export const createRefreshToken = async (
  userId,
  { userAgent, ipAddress } = {},
) => {
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_SIZE).toString("hex");

  const tokenHash = hashToken(refreshToken);

  const expiresDate = new Date(
    Date.now() + DEFAULT_REFRESH_DAYS * 24 * 60 * 60 * 1000,
  );

  const expiresAt = expiresDate
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  const tokenId = randomUUID();

  await query(
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
      expiresAt,
    ],
  );

  return {
    id: tokenId,
    refreshToken,
    expiresAt,
  };
};

export const findRefreshTokenByValue = async (token) => {
  const tokenHash = hashToken(token);

  const { rows } = await query(
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

export const revokeRefreshTokenById = async (id) => {
  if (!id) return null;

  const result = await query(
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
  { userAgent, ipAddress } = {},
) => {
  const existingToken = await findRefreshTokenByValue(currentToken);

  if (
    !existingToken ||
    existingToken.revoked ||
    new Date(existingToken.expires_at) <= new Date()
  ) {
    return null;
  }

  await revokeRefreshTokenById(existingToken.id);

  return createRefreshToken(existingToken.user_id, {
    userAgent,
    ipAddress,
  });
};

export const revokeUserRefreshTokens = async (userId) => {
  if (!userId) return null;

  const result = await query(
    `
      UPDATE refresh_tokens
      SET revoked = 1
      WHERE user_id = ?
      `,
    [userId],
  );

  return result.rowCount;
};

export const loadUserById = async (userId) => {
  const { rows } = await query(
    `
    SELECT
      id,
      name,
      email,
      phone,
      picture,
      provider,
      role
    FROM users
    WHERE id = ?
    `,
    [userId],
  );

  return rows[0];
};
