import { buildCacheKeyFromUrl, cacheGet, cacheSet } from "../lib/cache.js";
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

function rowToMovie(row, channelId) {
  if (!row) {
    return null;
  }
  return {
    channelId: channelId ?? null,
    movieId: row.tmdb_id,
    title: row.title,
    overview: row.overview,
    releaseDate: row.release_date,
    posterPath: row.poster_path,
    genres: parseJsonArray(row.genres),
    rating: row.rating ?? 0,
    ratingCount: row.rating_count ?? 0,
    directorName: row.director_name,
    cast: parseJsonArray(row.cast_names),
    castProfilePaths: parseJsonArray(row.cast_profile_paths),
    updatedAt: row.updated_at,
  };
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
  console.log("request received: /v1/search", url.toString());
  const query = safeDecode(url.searchParams.get("query"));
  if (!query) {
    return errorResponse(400, "query is required");
  }
  const cacheKey = buildCacheKeyFromUrl(url);
  try {
    const cached = await cacheGet(env, cacheKey);
    if (cached) {
      console.log("redis -> responded (search)", {
        key: cacheKey,
        url: url.toString(),
      });
      return jsonResponse(cached);
    }
  } catch (e) {
    console.warn("redis get failed", e?.message ?? e);
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
  console.log("tmdb -> responded (search)", { query, language });
  const response = jsonResponse(data);
  try {
    const ttl = Number(
      env.TMDB_CACHE_SECONDS || env.REDIS_CACHE_TTL || 24 * 60 * 60 * 30
    );
    await cacheSet(env, cacheKey, data, ttl);
    console.log("redis <- cached (search)", { key: cacheKey, ttl });
  } catch (e) {
    console.warn("redis set failed", e?.message ?? e);
  }
  return response;
}

async function upsertMovieByChannel(env, channelId, language, payload) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    `INSERT INTO movies_by_channel (
      channel_id, language, tmdb_id, title, overview, release_date, poster_path,
      genres, rating, rating_count, director_name, cast_names, cast_profile_paths, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, language) DO UPDATE SET
      tmdb_id = excluded.tmdb_id,
      title = excluded.title,
      overview = excluded.overview,
      release_date = excluded.release_date,
      poster_path = excluded.poster_path,
      genres = excluded.genres,
      rating = excluded.rating,
      rating_count = excluded.rating_count,
      director_name = excluded.director_name,
      cast_names = excluded.cast_names,
      cast_profile_paths = excluded.cast_profile_paths,
      updated_at = excluded.updated_at`
  );
  await stmt
    .bind(
      channelId,
      language,
      payload.movieId,
      payload.title,
      payload.overview,
      payload.releaseDate,
      payload.posterPath,
      JSON.stringify(payload.genres || []),
      payload.rating ?? 0,
      payload.ratingCount ?? 0,
      payload.directorName,
      JSON.stringify(payload.cast || []),
      JSON.stringify(payload.castProfilePaths || []),
      now
    )
    .run();
}

async function upsertMovieById(env, language, payload) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    `INSERT INTO movies_by_id (
      tmdb_id, language, title, overview, release_date, poster_path,
      genres, rating, rating_count, director_name, cast_names, cast_profile_paths, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tmdb_id, language) DO UPDATE SET
      title = excluded.title,
      overview = excluded.overview,
      release_date = excluded.release_date,
      poster_path = excluded.poster_path,
      genres = excluded.genres,
      rating = excluded.rating,
      rating_count = excluded.rating_count,
      director_name = excluded.director_name,
      cast_names = excluded.cast_names,
      cast_profile_paths = excluded.cast_profile_paths,
      updated_at = excluded.updated_at`
  );
  await stmt
    .bind(
      payload.movieId,
      language,
      payload.title,
      payload.overview,
      payload.releaseDate,
      payload.posterPath,
      JSON.stringify(payload.genres || []),
      payload.rating ?? 0,
      payload.ratingCount ?? 0,
      payload.directorName,
      JSON.stringify(payload.cast || []),
      JSON.stringify(payload.castProfilePaths || []),
      now
    )
    .run();
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
    movieId: details.id,
    title: details.title,
    overview: details.overview,
    releaseDate: details.release_date,
    posterPath: details.poster_path,
    genres: (details.genres || []).map((genre) => genre.name),
    rating: details.vote_average,
    ratingCount: details.vote_count,
    directorName: director?.name ?? null,
    cast: castSorted.map((member) => member.name),
    castProfilePaths: castSorted.map((member) => member.profile_path ?? null),
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
  console.log("request received: /v1/movie/lookup", url.toString());
  const channelId = url.searchParams.get("channelId");
  const title = url.searchParams.get("title");
  const language = normalizeLanguage(url.searchParams.get("language"));
  if (!channelId || !title) {
    return errorResponse(400, "channelId and title are required");
  }

  const cachedRow = await env.DB.prepare(
    `SELECT * FROM movies_by_channel WHERE channel_id = ? AND language = ? LIMIT 1`
  )
    .bind(channelId, language)
    .first();
  if (cachedRow && !shouldRefresh(cachedRow)) {
    console.log("db -> responded (lookup)", { channelId, language });
    return jsonResponse(rowToMovie(cachedRow, channelId));
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
  console.log("tmdb -> search for lookup", {
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

  await upsertMovieByChannel(env, channelId, language, moviePayload);
  console.log("db <- upserted (lookup)", {
    channelId,
    language,
    movieId: moviePayload.movieId,
  });
  await upsertMovieById(env, language, moviePayload);

  return jsonResponse({ ...moviePayload, channelId });
}

export async function handleMovieById(request, env, ctx) {
  const url = new URL(request.url);
  console.log("request received: /movies/{id}", url.toString());
  const idPart = url.pathname.split("/").pop();
  const movieId = Number(idPart);
  if (!Number.isInteger(movieId)) {
    return errorResponse(400, "invalid movie id");
  }
  const language = normalizeLanguage(url.searchParams.get("language"));

  const cachedRow = await env.DB.prepare(
    `SELECT * FROM movies_by_id WHERE tmdb_id = ? AND language = ? LIMIT 1`
  )
    .bind(movieId, language)
    .first();
  if (cachedRow && !shouldRefresh(cachedRow)) {
    console.log("cache hit: movie d1", { movieId, language });
    return jsonResponse(rowToMovie(cachedRow, null));
  }

  const cacheKey = buildCacheKeyFromUrl(url);
  try {
    const cached = await cacheGet(env, cacheKey);
    if (cached) {
      console.log("redis -> responded (movie)", {
        key: cacheKey,
        url: url.toString(),
      });
      return jsonResponse(cached);
    }
  } catch (e) {
    console.warn("redis get failed", e?.message ?? e);
  }

  const moviePayload = await fetchMovieDetails(movieId, language, env);
  await upsertMovieById(env, language, moviePayload);

  const response = jsonResponse(moviePayload);
  try {
    const ttl = Number(
      env.TMDB_CACHE_SECONDS || env.REDIS_CACHE_TTL || 24 * 60 * 60 * 30
    );
    await cacheSet(env, cacheKey, moviePayload, ttl);
    console.log("redis <- cached (movie)", { key: cacheKey, ttl });
  } catch (e) {
    console.warn("redis set failed", e?.message ?? e);
  }
  return response;
}
