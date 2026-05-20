import crypto from 'crypto';
import { query } from '../config/database.js';

const HASH_ALGORITHM = 'sha256';
const REFRESH_TOKEN_SIZE = 64;
const DEFAULT_REFRESH_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS, 10) || 7;

const hashToken = (token) =>
  crypto.createHash(HASH_ALGORITHM).update(token).digest('hex');

export const createRefreshToken = async (userId, { userAgent, ipAddress } = {}) => {
  const refreshToken = crypto.randomBytes(REFRESH_TOKEN_SIZE).toString('hex');
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + DEFAULT_REFRESH_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { rows } = await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, tokenHash, userAgent?.slice(0, 255) || null, ipAddress || null, expiresAt]
  );

  return { id: rows[0]?.id, refreshToken, expiresAt };
};

export const findRefreshTokenByValue = async (token) => {
  const tokenHash = hashToken(token);
  const { rows } = await query(
    `SELECT id, user_id, revoked, expires_at
     FROM refresh_tokens
     WHERE token_hash = $1`,
    [tokenHash]
  );
  return rows[0];
};

export const revokeRefreshTokenById = async (id) => {
  if (!id) return null;
  const { rows } = await query(
    `UPDATE refresh_tokens SET revoked = true WHERE id = $1 RETURNING id`,
    [id]
  );
  return rows[0];
};

export const rotateRefreshToken = async (currentToken, { userAgent, ipAddress } = {}) => {
  const existingToken = await findRefreshTokenByValue(currentToken);
  if (!existingToken || existingToken.revoked || new Date(existingToken.expires_at) <= new Date()) {
    return null;
  }

  await revokeRefreshTokenById(existingToken.id);
  return createRefreshToken(existingToken.user_id, { userAgent, ipAddress });
};

export const revokeUserRefreshTokens = async (userId) => {
  if (!userId) return null;
  const { rows } = await query(
    `UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 RETURNING id`,
    [userId]
  );
  return rows;
};

export const loadUserById = async (userId) => {
  const { rows } = await query(
    `SELECT id, name, email, phone, picture, provider, role
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0];
};
