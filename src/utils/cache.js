const CACHE_PREFIX = 'bree_cache:';
const defaultTtl = 300; // default 5 minutes

const cacheStore = new Map();
const now = () => Date.now();

const getStoreKey = (key) => `${CACHE_PREFIX}${key}`;

const cleanupExpired = (key) => {
  const storeKey = getStoreKey(key);
  const entry = cacheStore.get(storeKey);
  if (!entry) return false;
  if (entry.expiresAt <= now()) {
    cacheStore.delete(storeKey);
    return false;
  }
  return true;
};

export const get = (key) => {
  const storeKey = getStoreKey(key);
  if (!cleanupExpired(key)) return null;
  return cacheStore.get(storeKey).value;
};

export const set = (key, value, ttlSeconds = defaultTtl) => {
  const storeKey = getStoreKey(key);
  cacheStore.set(storeKey, {
    value,
    expiresAt: now() + ttlSeconds * 1000,
  });
};

export const del = (key) => {
  cacheStore.delete(getStoreKey(key));
};

export const delPrefix = (prefix) => {
  const prefixKey = getStoreKey(prefix);
  for (const key of Array.from(cacheStore.keys())) {
    if (key.startsWith(prefixKey)) {
      cacheStore.delete(key);
    }
  }
};

export const wrap = async (key, ttlSeconds, factory) => {
  const cached = get(key);
  if (cached !== null) return cached;
  const value = await factory();
  set(key, value, ttlSeconds);
  return value;
};

export const flush = () => {
  cacheStore.clear();
};

export default { get, set, del, delPrefix, wrap, flush };
