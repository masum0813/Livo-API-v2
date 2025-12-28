import { buildCacheKeyFromUrl } from "../lib/cache.js";
import { CACHE_TTL_SECONDS } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { RedisClient } from "../lib/redisClient.js";
import { errorResponse, jsonResponse } from "../lib/response.js";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const CACHE_INTERVAL_SECONDS = 30 * 24 * 60 * 60;
const MAX_CAST = 10;

function normalizeLanguage(raw) {
  return raw ? raw.trim() : "";
}

function safeDecode(value) {
  if (!value || typeof value !== "string") return value;
  try {
    // Only decode if there is a percent-encoded sequence
    if (/%[0-9A-Fa-f]{2}/.test(value)) return decodeURIComponent(value);
    return value;
  } catch (e) {
    return value;
  }
}

function extractYear(title) {
  const match = title.match(/(?<!\d)(19|20)\d{2}(?!\d)/);
  return match ? Number(match[0]) : null;
}

function removeYear(title) {
  return title
    .replace(/(?<!\d)(19|20)\d{2}(?!\d)/g, "")
    .replace(/\(\)/g, "")
    .replace(/\[\]/g, "")
    .replace(/\{\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

function parseJsonArray(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // fallthrough
    }
    // treat comma-separated string as list
    if (v.indexOf(",") !== -1) return v.split(",").map((s) => s.trim());
    return [v];
  }
  return [v];
}

function shouldRefresh(row) {
  if (!row) {
    return true;
  }
  const rating = row.rating ?? 0;
  const ratingCount = row.rating_count ?? 0;
  if (rating === 0 && ratingCount === 0) {
    return true;
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - row.updated_at;
  return ageSeconds > CACHE_INTERVAL_SECONDS;
}

async function tmdbFetch(path, query, env) {
  if (!env.TMDB_API_KEY) {
    throw new Error("TMDB_API_KEY is missing");
  }
  const url = new URL(`${TMDB_BASE_URL}/${path}`);
  url.searchParams.set("api_key", env.TMDB_API_KEY);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text();
    const message = `TMDB error ${response.status}: ${body}`;
    throw new Error(message);
  }
  return response.json();
}

async function cacheMatch(request) {
  const cache = caches.default;
  return cache.match(request);
}

async function cachePut(request, response, ctx) {
  const cache = caches.default;
  ctx.waitUntil(cache.put(request, response.clone()));
}

export async function handleSearch(request, env, ctx) {
  const url = new URL(request.url);
  logger.info("request received: /v1/search", { url: url.toString() });
  const query = safeDecode(url.searchParams.get("query"));
  if (!query) {
    return errorResponse(400, "query is required");
  }
  const cacheKey = buildCacheKeyFromUrl(url);
  const redis = new RedisClient(env);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info("redis -> responded (search)", {
        key: cacheKey,
        url: url.toString(),
      });
      return jsonResponse(cached);
    }
  } catch (e) {
    logger.warn("redis get failed", e?.message ?? e);
  }

  const language = normalizeLanguage(url.searchParams.get("language"));
  const data = await tmdbFetch(
    "search/movie",
    {
      query,
      include_adult: "false",
      language: language || undefined,
    },
    env
  );
  logger.info("tmdb -> responded (search)", { query, language });
  const response = jsonResponse(data);
  try {
    const ttl = CACHE_TTL_SECONDS;
    await redis.set(cacheKey, data, ttl);
    logger.info("redis <- cached (search)", { key: cacheKey, ttl });
  } catch (e) {
    logger.warn("redis set failed", e?.message ?? e);
  }
  return response;
}

function mapTmdbToMovie(details, credits) {
  const director = credits.crew?.find(
    (member) => String(member.job || "").toLowerCase() === "director"
  );
  const castSorted = (credits.cast || [])
    .slice()
    .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))
    .slice(0, MAX_CAST);
  return {
    id: details.id,
    title: details.title,
    overview: details.overview,
    releaseDate: details.release_date,
    posterPath: details.poster_path,
    genres: ensureArray(
      (details.genres || []).map((genre) => ({
        id: genre.id ?? null,
        name: genre.name ?? null,
      }))
    ),
    rating: details.vote_average,
    ratingCount: details.vote_count,
    directorName: director?.name ?? null,
    cast: ensureArray(
      castSorted.map((member) => ({
        name: member.name,
        order: typeof member.order === "number" ? member.order : null,
        profile_path: member.profile_path ?? null,
      }))
    ),
  };
}

async function fetchMovieDetails(movieId, language, env) {
  const [details, credits] = await Promise.all([
    tmdbFetch(`movie/${movieId}`, { language: language || undefined }, env),
    tmdbFetch(`movie/${movieId}/credits`, {}, env),
  ]);
  return mapTmdbToMovie(details, credits);
}

export async function handleMovieLookup(request, env) {
  const url = new URL(safeDecode(request.url));
  logger.info("request received: /v1/movie/lookup", { url: url.toString() });
  const channelId = url.searchParams.get("channelId");
  const title = url.searchParams.get("title");
  const language = normalizeLanguage(url.searchParams.get("language"));
  if (!channelId || !title) {
    return errorResponse(400, "channelId and title are required");
  }

  const cacheKey = buildCacheKeyFromUrl(url);
  const redis = new RedisClient(env);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info("redis -> responded (movie lookup)", {
        key: cacheKey,
        url: url.toString(),
      });
      return jsonResponse(cached);
    }
  } catch (e) {
    logger.warn("redis get failed", e?.message ?? e);
  }

  const cleanTitle = title.trim();
  const releaseYear = extractYear(cleanTitle);
  const strippedTitle = removeYear(cleanTitle);

  const search = await tmdbFetch(
    "search/movie",
    {
      query: strippedTitle,
      include_adult: "false",
      language: language || undefined,
      year: releaseYear || undefined,
    },
    env
  );
  logger.info("tmdb -> search for lookup", {
    strippedTitle,
    releaseYear,
    language,
  });
  const first = search.results?.[0];
  if (!first) {
    return errorResponse(404, "TMDB movie not found");
  }

  const moviePayload = await fetchMovieDetails(first.id, language, env);
  if (!moviePayload.title) {
    moviePayload.title = first.title || strippedTitle;
  }

  const responsePayload = { ...moviePayload, channelId };
  try {
    const ttl = CACHE_TTL_SECONDS;
    await redis.set(cacheKey, responsePayload, ttl);
    logger.info("redis <- cached (movie lookup)", { key: cacheKey, ttl });
  } catch (e) {
    logger.warn("redis set failed", e?.message ?? e);
  }

  return jsonResponse(responsePayload);
}

export async function handleMovieById(request, env, ctx) {
  const url = new URL(request.url);
  logger.info("request received: /v1/movie/{id}", { url: url.toString() });
  const idPart = url.pathname.split("/").pop();
  const movieId = Number(idPart);
  if (!Number.isInteger(movieId)) {
    return errorResponse(400, "invalid movie id");
  }
  const language = normalizeLanguage(url.searchParams.get("language"));

  const cacheKey = buildCacheKeyFromUrl(url);
  const redis = new RedisClient(env);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info("redis -> responded (movie)", {
        key: cacheKey,
        url: url.toString(),
      });
      return jsonResponse(cached);
    }
  } catch (e) {
    logger.warn("redis get failed", e?.message ?? e);
  }

  const moviePayload = await fetchMovieDetails(movieId, language, env);

  const response = jsonResponse(moviePayload);
  try {
    const ttl = CACHE_TTL_SECONDS;
    await redis.set(cacheKey, moviePayload, ttl);
    logger.info("redis <- cached (movie)", { key: cacheKey, ttl });
  } catch (e) {
    logger.warn("redis set failed", e?.message ?? e);
  }
  return response;
}
