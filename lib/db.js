// SQLite removed. This project now expects Redis for storage/cache.
// To avoid accidental usage without migration, `createDb` will throw a
// clear error explaining next steps.

export function createDb() {
  throw new Error(
    "SQLite support removed. Please migrate DB access to Redis or provide a compatible replacement for `createDb`.\n" +
      "Suggested steps:\n" +
      "1) Add a Redis client (e.g. ioredis) and implement the queries used in routes.\n" +
      "2) For quick dev, run Redis and update code to use key/value storage for cache tables (tmdb_cache, series_search_cache).\n" +
      "3) If you want, I can help port specific route DB calls to Redis."
  );
}
