import { getRedisClient, buildCacheKeyFromUrl, cacheGet, cacheSet } from "../lib/cache.js";

const TMDB_ORIGIN = "https://api.themoviedb.org";

export async function handleTmdbProxy(request, env) {
  if (!env.TMDB_API_KEY) {
    return new Response("TMDB_API_KEY is missing", { status: 500 });
  }

  const incomingUrl = new URL(request.url);
  console.log("request received: /3/* (tmdb proxy)", incomingUrl.toString());
  const cacheKey = buildCacheKeyFromUrl(incomingUrl);

  // TTL: prefer explicit env, fall back to tmdb_cache default
  const ttl = Number(env.TMDB_CACHE_SECONDS || env.REDIS_CACHE_TTL || 24 * 60 * 60 * 30);

  try {
    const cached = await cacheGet(env, cacheKey);
    if (cached && cached.body !== undefined) {
      console.log("redis -> responded (tmdb proxy)", { key: cacheKey });
      return new Response(cached.body, {
        status: cached.status || 200,
        headers: {
          "content-type": cached.content_type || "application/json; charset=utf-8",
        },
      });
    }
  } catch (e) {
    // redis failure should not block proxying
    console.warn("redis get failed", { key: cacheKey, err: e?.message ?? e });
  }

  const targetUrl = new URL(TMDB_ORIGIN);
  targetUrl.pathname = incomingUrl.pathname;
  incomingUrl.searchParams.forEach((value, key) => {
    if (key.toLowerCase() === "api_key") return;
    targetUrl.searchParams.append(key, value);
  });
  targetUrl.searchParams.set("api_key", env.TMDB_API_KEY);

  const response = await fetch(targetUrl.toString(), {
    method: "GET",
    headers: {
      "accept-language": request.headers.get("accept-language") || "",
    },
  });
  console.log("tmdb -> fetched", { url: targetUrl.toString() });
  const body = await response.text();
  const contentType = response.headers.get("content-type") || "";

  // cache the response (best-effort)
  try {
    await cacheSet(env, cacheKey, { body, status: response.status, content_type: contentType }, ttl);
    console.log("redis <- cached (tmdb proxy)", { key: cacheKey, ttl });
  } catch (e) {
    console.warn("redis set failed", { key: cacheKey, err: e?.message ?? e });
  }

  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": contentType || "application/json; charset=utf-8",
    },
  });
}
