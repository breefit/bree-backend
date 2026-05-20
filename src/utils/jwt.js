import jwt from 'jsonwebtoken';

const isProduction = process.env.NODE_ENV === 'production';
const defaultSameSite = 'none';
const defaultSecure = isProduction;

export const signUserToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });

export const signAdminToken = (adminId) =>
  jwt.sign({ adminId }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '1d',
  });

export const verifyUserToken = (token) =>
  jwt.verify(token, process.env.JWT_SECRET);

export const verifyAdminToken = (token) =>
  jwt.verify(token, process.env.ADMIN_JWT_SECRET);

export const COOKIE_NAME = 'auth_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';
export const ADMIN_COOKIE_NAME = 'admin_auth_token';

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: defaultSecure,
  sameSite: defaultSameSite,
  path: '/',
  maxAge: 15 * 60 * 1000, // 15 minutes in ms
};

export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: defaultSecure,
  sameSite: defaultSameSite,
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

export const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: defaultSecure,
  sameSite: defaultSameSite,
  path: '/',
  maxAge: 24 * 60 * 60 * 1000, // 1 day in ms
};
