import { cacheGet, cacheSet } from "./cache.js";

/**
 * Lightweight Redis client wrapper around existing cache helpers.
 * Keeps call sites simple and centralizes future Redis logic.
 */
export class RedisClient {
  constructor(env) {
    this.env = env;
  }

  async get(key) {
    return cacheGet(this.env, key);
  }

  async set(key, value, ttlSeconds) {
    return cacheSet(this.env, key, value, ttlSeconds);
  }
}

export default RedisClient;
