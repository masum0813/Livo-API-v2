import IORedis from "ioredis";

let _client = null;

export function getRedisClient(env) {
  if (_client) return _client;
  const url = env.REDIS_URL || process.env.REDIS_URL || "redis://127.0.0.1:6379";
  _client = new IORedis(url);
  return _client;
}

export function buildCacheKeyFromUrl(url) {
  // Accept string or URL
  const u = typeof url === "string" ? new URL(url, "http://localhost") : url;
  const params = new URLSearchParams();
  const entries = Array.from(u.searchParams.entries()).filter(([k]) => k.toLowerCase() !== "api_key");
  entries.sort(([a], [b]) => a.localeCompare(b));
  entries.forEach(([k, v]) => params.append(k, v));
  const query = params.toString();
  return query ? `${u.pathname}?${query}` : u.pathname;
}

export async function cacheGet(env, key) {
  const client = getRedisClient(env);
  const raw = await client.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export async function cacheSet(env, key, valueObj, ttlSeconds) {
  const client = getRedisClient(env);
  const raw = JSON.stringify(valueObj);
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    await client.set(key, raw, "EX", Math.floor(ttlSeconds));
  } else {
    await client.set(key, raw);
  }
}
