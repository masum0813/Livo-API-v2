import { buildCacheKeyFromUrl, cacheGet, cacheSet } from "../lib/cache.js";
import { logger } from "../lib/logger.js";
import { errorResponse, jsonResponse } from "../lib/response.js";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const CACHE_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

function normalizeLanguage(raw) {
  return raw ? raw.trim() : "";
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

function rowToSeries(row, seasons) {
  if (!row) {
    return null;
  }
  return {
    id: row.tmdb_id,
    genre_ids: parseJsonArray(row.genre_ids),
    original_language: row.original_language,
    overview: row.overview,
    original_name: row.original_name,
    created_by: parseJsonArray(row.created_by),
    number_of_episodes: row.number_of_episodes ?? 0,
    number_of_seasons: row.number_of_seasons ?? 0,
    posterPath: row.poster_path,
    first_air_date: row.first_air_date,
    name: row.name,
    vote_average: row.vote_average ?? 0,
    vote_count: row.vote_count ?? 0,
    seasons: Array.isArray(seasons) ? seasons : [],
  };
}

function buildSeriesPayload(details, genreIds) {
  return {
    id: details.id,
    genre_ids: Array.isArray(genreIds) ? genreIds : [],
    original_language: details.original_language,
    overview: details.overview,
    original_name: details.original_name,
    created_by: Array.isArray(details.created_by) ? details.created_by : [],
    number_of_episodes: details.number_of_episodes,
    number_of_seasons: details.number_of_seasons,
    posterPath: details.poster_path,
    first_air_date: details.first_air_date,
    name: details.name,
    vote_average: details.vote_average,
    vote_count: details.vote_count,
    seasons: Array.isArray(details.seasons) ? details.seasons : [],
  };
}

function buildSeriesPayloadFromSearch(item) {
  return {
    id: item.id,
    genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids : [],
    original_language: item.original_language,
    overview: item.overview,
    original_name: item.original_name,
    posterPath: item.poster_path,
    first_air_date: item.first_air_date,
    name: item.name,
    vote_average: item.vote_average,
    vote_count: item.vote_count,
  };
}

function extractGenreIdsFromDetails(details) {
  if (!details || !Array.isArray(details.genres)) {
    return [];
  }
  return details.genres
    .map((genre) => (genre && typeof genre.id === "number" ? genre.id : null))
    .filter((genreId) => genreId !== null);
}

function shouldRefresh(row) {
  if (!row) {
    return true;
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - row.updated_at;
  return ageSeconds > CACHE_INTERVAL_SECONDS;
}

function isExtendedDataMissing(row) {
  const createdBy = parseJsonArray(row.created_by);
  const episodes = row.number_of_episodes;
  const seasonsCount = row.number_of_seasons;
  const looksLikeSearchOnly =
    createdBy.length === 0 &&
    (episodes === 0 || episodes === null) &&
    (seasonsCount === 0 || seasonsCount === null);
  return (
    row.created_by === undefined ||
    row.created_by === null ||
    row.seasons === undefined ||
    row.seasons === null ||
    row.number_of_episodes === undefined ||
    row.number_of_episodes === null ||
    row.number_of_seasons === undefined ||
    row.number_of_seasons === null ||
    looksLikeSearchOnly
  );
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
    throw new Error(`TMDB error ${response.status}: ${body}`);
  }
  return response.json();
}

async function upsertSeasons(env, seriesId, language, seasons) {
  const now = Math.floor(Date.now() / 1000);
  if (!Array.isArray(seasons)) {
    return;
  }
  for (const season of seasons) {
    if (!season || typeof season.id !== "number") {
      continue;
    }
  }
}

async function getSeasonCacheMeta(env, seriesId, seasonNumber, language) {
  const row = await env.DB.prepare(
    `SELECT COUNT(1) as count, MAX(updated_at) as updated_at
     FROM series_episodes
     WHERE series_id = ? AND language = ? AND season_number = ?`
  )
    .bind(seriesId, language, seasonNumber)
    .first();
  return row || { count: 0, updated_at: null };
}

async function readSeasonEpisodes(env, seriesId, seasonNumber, language) {
  const episodesResult = await env.DB.prepare(
    `SELECT episode_id as id, episode_number, name, overview, still_path, air_date,
            vote_average, vote_count
     FROM series_episodes
     WHERE series_id = ? AND language = ? AND season_number = ?
     ORDER BY episode_number ASC`
  )
    .bind(seriesId, language, seasonNumber)
    .all();
  const episodes = episodesResult.results || [];

  const guestResult = await env.DB.prepare(
    `SELECT episode_id, episode_number, guest_id as id, name, original_name, character, profile_path, order_index
     FROM episode_guest_stars
     WHERE series_id = ? AND language = ? AND season_number = ?
     ORDER BY order_index ASC`
  )
    .bind(seriesId, language, seasonNumber)
    .all();
  const guests = guestResult.results || [];

  const byEpisode = new Map();
  for (const guest of guests) {
    const key = guest.episode_id;
    const list = byEpisode.get(key) || [];
    list.push({
      series_id: seriesId,
      id: guest.id,
      name: guest.name,
      original_name: guest.original_name,
      character: guest.character,
      profile_path: guest.profile_path,
      order: guest.order_index,
    });
    byEpisode.set(key, list);
  }

  return episodes.map((episode) => ({
    series_id: seriesId,
    id: episode.id,
    episode_id: episode.id,
    episode_number: episode.episode_number,
    name: episode.name,
    overview: episode.overview,
    still_path: episode.still_path,
    air_date: episode.air_date,
    vote_average: episode.vote_average ?? 0,
    vote_count: episode.vote_count ?? 0,
    guest_stars: byEpisode.get(episode.id) || [],
  }));
}

async function readEpisode(
  env,
  seriesId,
  seasonNumber,
  episodeNumber,
  language
) {
  const episodeRow = await env.DB.prepare(
    `SELECT episode_id as id, episode_number, name, overview, still_path, air_date,
            vote_average, vote_count, updated_at
     FROM series_episodes
     WHERE series_id = ? AND language = ? AND season_number = ? AND episode_number = ?
     LIMIT 1`
  )
    .bind(seriesId, language, seasonNumber, episodeNumber)
    .first();
  if (!episodeRow) {
    return null;
  }

  const guestResult = await env.DB.prepare(
    `SELECT guest_id as id, name, original_name, character, profile_path, order_index
     FROM episode_guest_stars
     WHERE series_id = ? AND language = ? AND season_number = ? AND episode_number = ?
     ORDER BY order_index ASC`
  )
    .bind(seriesId, language, seasonNumber, episodeRow.episode_number)
    .all();
  const guests = (guestResult.results || []).map((guest) => ({
    series_id: seriesId,
    id: guest.id,
    name: guest.name,
    original_name: guest.original_name,
    character: guest.character,
    profile_path: guest.profile_path,
    order: guest.order_index,
  }));

  return {
    series_id: seriesId,
    id: episodeRow.id,
    episode_id: episodeRow.id,
    episode_number: episodeRow.episode_number,
    name: episodeRow.name,
    overview: episodeRow.overview,
    still_path: episodeRow.still_path,
    air_date: episodeRow.air_date,
    vote_average: episodeRow.vote_average ?? 0,
    vote_count: episodeRow.vote_count ?? 0,
    guest_stars: guests,
    updated_at: episodeRow.updated_at,
  };
}

function buildEpisodePayload(seriesId, episode) {
  return {
    series_id: seriesId,
    id: episode.id,
    episode_id: episode.id,
    episode_number: episode.episode_number,
    name: episode.name,
    overview: episode.overview,
    still_path: episode.still_path,
    air_date: episode.air_date,
    vote_average: episode.vote_average ?? 0,
    vote_count: episode.vote_count ?? 0,
    guest_stars: Array.isArray(episode.guest_stars)
      ? episode.guest_stars.map((guest) => ({
          series_id: seriesId,
          id: guest.id,
          name: guest.name,
          original_name: guest.original_name,
          character: guest.character,
          profile_path: guest.profile_path,
          order: guest.order ?? null,
        }))
      : [],
  };
}

async function upsertSeasonEpisodes(
  env,
  seriesId,
  seasonNumber,
  language,
  episodes
) {
  if (!Array.isArray(episodes)) {
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  for (const episode of episodes) {
    if (!episode || typeof episode.id !== "number") {
      continue;
    }
    await env.DB.prepare(
      `INSERT INTO series_episodes (
        series_id, language, season_number, episode_id, episode_number, name, overview,
        still_path, air_date, vote_average, vote_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        episode_number = excluded.episode_number,
        name = excluded.name,
        overview = excluded.overview,
        still_path = excluded.still_path,
        air_date = excluded.air_date,
        vote_average = excluded.vote_average,
        vote_count = excluded.vote_count,
        updated_at = excluded.updated_at`
    )
      .bind(
        seriesId,
        language,
        seasonNumber,
        episode.id,
        episode.episode_number,
        episode.name,
        episode.overview,
        episode.still_path,
        episode.air_date,
        episode.vote_average ?? 0,
        episode.vote_count ?? 0,
        now
      )
      .run();

    if (Array.isArray(episode.guest_stars)) {
      for (const guest of episode.guest_stars) {
        if (!guest || typeof guest.id !== "number") {
          continue;
        }
        await env.DB.prepare(
          `INSERT INTO episode_guest_stars (
            series_id, language, season_number, episode_id, episode_number, guest_id, name,
            original_name, character, profile_path, order_index, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET
            name = excluded.name,
            original_name = excluded.original_name,
            character = excluded.character,
            profile_path = excluded.profile_path,
            order_index = excluded.order_index,
            updated_at = excluded.updated_at`
        )
          .bind(
            seriesId,
            language,
            seasonNumber,
            episode.id,
            episode.episode_number,
            guest.id,
            guest.name,
            guest.original_name,
            guest.character,
            guest.profile_path,
            guest.order ?? null,
            now
          )
          .run();
      }
    }
  }
}

async function cacheSearch(env, query, language, body) {
  try {
    const key = `/series/search?query=${encodeURIComponent(
      query
    )}&language=${encodeURIComponent(language || "")}`;
    await cacheSet(
      env,
      key,
      { body, updated_at: Math.floor(Date.now() / 1000) },
      CACHE_INTERVAL_SECONDS
    );
  } catch (e) {
    // ignore cache write errors
  }
}

async function readSearchCache(env, query, language) {
  try {
    const key = `/series/search?query=${encodeURIComponent(
      query
    )}&language=${encodeURIComponent(language || "")}`;
    const cached = await cacheGet(env, key);
    if (!cached || !cached.body || !cached.updated_at) return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - cached.updated_at;
    if (ageSeconds > CACHE_INTERVAL_SECONDS) return null;
    return cached.body;
  } catch (e) {
    return null;
  }
}

export async function handleSeriesSearch(request, env) {
  if (request.method !== "GET") {
    return errorResponse(405, "method not allowed");
  }
  const url = new URL(request.url);
  logger.info("request received: /v1/series/search", { url: url.toString() });
  const query = url.searchParams.get("query");
  if (!query) {
    return errorResponse(400, "query is required");
  }
  const language = normalizeLanguage(url.searchParams.get("language"));
  const topRaw = Number(url.searchParams.get("top") || 1);
  const top = Number.isFinite(topRaw) && topRaw > 0 ? Math.floor(topRaw) : 1;

  const cached = await readSearchCache(env, query, language);
  const data =
    cached ||
    (await tmdbFetch(
      "search/tv",
      {
        query,
        include_adult: "false",
        language: language || undefined,
      },
      env
    ));

  if (cached) {
    logger.info("redis -> responded (series search)", { query, language });
  } else {
    logger.info("tmdb -> responded (series search)", { query, language });
    await cacheSearch(env, query, language, data);
    logger.info("redis <- cached (series search)", { query, language });
  }

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    return errorResponse(404, "TMDB series not found");
  }

  const limited = results.slice(0, Math.min(top, results.length));
  const payload = limited
    .filter((item) => item && typeof item.id === "number")
    .map(buildSeriesPayloadFromSearch);

  return jsonResponse(payload);
}

export async function handleSeriesById(request, env) {
  if (request.method !== "GET") {
    return errorResponse(405, "method not allowed");
  }
  const url = new URL(request.url);
  const idPart = url.pathname.split("/").pop();
  const seriesId = Number(idPart);
  if (!Number.isInteger(seriesId)) {
    return errorResponse(400, "invalid series id");
  }
  const language = normalizeLanguage(url.searchParams.get("language"));
  logger.info("request received: /v1/series/{id}", { url: url.toString() });

  const cachedRow = await env.DB.prepare(
    `SELECT * FROM series_by_id WHERE tmdb_id = ? AND language = ? LIMIT 1`
  )
    .bind(seriesId, language)
    .first();
  if (
    cachedRow &&
    !shouldRefresh(cachedRow) &&
    !isExtendedDataMissing(cachedRow)
  ) {
    const seasons = await readSeasons(env, seriesId, language);
    if (seasons.length > 0) {
      logger.info("db -> responded (series by id)", { seriesId, language });
      return jsonResponse(rowToSeries(cachedRow, seasons));
    }
  }

  const cacheKey = buildCacheKeyFromUrl(url);
  try {
    const cached = await cacheGet(env, cacheKey);
    if (cached) {
      logger.info("redis -> responded (series by id)", { key: cacheKey });
      return jsonResponse(cached);
    }
  } catch (e) {
    logger.warn("redis get failed", { key: cacheKey, err: e?.message ?? e });
  }

  const data = await tmdbFetch(
    `tv/${seriesId}`,
    { language: language || undefined },
    env
  );
  const genreIds = extractGenreIdsFromDetails(data);
  const payload = buildSeriesPayload(data, genreIds);

  try {
    const ttl = Number(
      env.TMDB_CACHE_SECONDS || env.REDIS_CACHE_TTL || CACHE_INTERVAL_SECONDS
    );
    await cacheSet(
      env,
      cacheKey,
      { ...payload, seasons: payload.seasons },
      ttl
    );
    logger.info("redis <- cached (series by id)", { key: cacheKey, ttl });
  } catch (e) {
    logger.warn("redis set failed", { key: cacheKey, err: e?.message ?? e });
  }

  return jsonResponse({ ...payload, seasons: payload.seasons });
}

export async function handleSeriesSeason(request, env) {
  if (request.method !== "GET") {
    return errorResponse(405, "method not allowed");
  }
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const seriesId = Number(parts[2]);
  const seasonNumber = Number(parts[4]);
  if (!Number.isInteger(seriesId) || !Number.isInteger(seasonNumber)) {
    return errorResponse(400, "invalid series or season id");
  }
  const language = normalizeLanguage(url.searchParams.get("language"));
  logger.info("request received: /v1/series/{id}/season/{season}", {
    url: url.toString(),
  });

  const cacheMeta = await getSeasonCacheMeta(
    env,
    seriesId,
    seasonNumber,
    language
  );
  if (cacheMeta.count > 0) {
    const ageSeconds = Math.floor(Date.now() / 1000) - cacheMeta.updated_at;
    if (ageSeconds <= CACHE_INTERVAL_SECONDS) {
      const cached = await readSeasonEpisodes(
        env,
        seriesId,
        seasonNumber,
        language
      );
      if (cached.length > 0) {
        return jsonResponse(cached);
      }
    }
  }

  const cacheKey = buildCacheKeyFromUrl(url);
  try {
    const cached = await cacheGet(env, cacheKey);
    if (cached) {
      logger.info("redis -> responded (series season)", { key: cacheKey });
      return jsonResponse(cached);
    }
  } catch (e) {
    logger.warn("redis get failed", { key: cacheKey, err: e?.message ?? e });
  }

  const data = await tmdbFetch(
    `tv/${seriesId}/season/${seasonNumber}`,
    { language: language || undefined },
    env
  );
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  await upsertSeasonEpisodes(env, seriesId, seasonNumber, language, episodes);
  try {
    const ttl = Number(
      env.TMDB_CACHE_SECONDS || env.REDIS_CACHE_TTL || CACHE_INTERVAL_SECONDS
    );
    await cacheSet(env, cacheKey, episodes, ttl);
    logger.info("redis <- cached (series season)", { key: cacheKey, ttl });
  } catch (e) {
    console.warn("redis set failed", { key: cacheKey, err: e?.message ?? e });
  }
  const payload = episodes.map((episode) => ({
    series_id: seriesId,
    id: episode.id,
    episode_number: episode.episode_number,
    name: episode.name,
    overview: episode.overview,
    still_path: episode.still_path,
    air_date: episode.air_date,
    vote_average: episode.vote_average ?? 0,
    vote_count: episode.vote_count ?? 0,
    guest_stars: Array.isArray(episode.guest_stars)
      ? episode.guest_stars.map((guest) => ({
          series_id: seriesId,
          id: guest.id,
          name: guest.name,
          original_name: guest.original_name,
          character: guest.character,
          profile_path: guest.profile_path,
          order: guest.order ?? null,
        }))
      : [],
  }));

  return jsonResponse(payload);
}

export async function handleSeriesEpisode(request, env) {
  if (request.method !== "GET") {
    return errorResponse(405, "method not allowed");
  }
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const seriesId = Number(parts[2]);
  const seasonNumber = Number(parts[4]);
  const episodeNumber = Number(parts[6]);
  if (
    !Number.isInteger(seriesId) ||
    !Number.isInteger(seasonNumber) ||
    !Number.isInteger(episodeNumber)
  ) {
    return errorResponse(400, "invalid series, season, or episode");
  }
  const language = normalizeLanguage(url.searchParams.get("language"));
  logger.info("request received: /v1/series/{id}/season/{s}/episode/{e}", {
    url: url.toString(),
  });

  const cached = await readEpisode(
    env,
    seriesId,
    seasonNumber,
    episodeNumber,
    language
  );
  if (cached) {
    const ageSeconds = Math.floor(Date.now() / 1000) - cached.updated_at;
    const hasGuestStars = Array.isArray(cached.guest_stars)
      ? cached.guest_stars.length > 0
      : false;
    if (ageSeconds <= CACHE_INTERVAL_SECONDS && hasGuestStars) {
      const { updated_at, ...payload } = cached;
      return jsonResponse(payload);
    }
  }

  const cacheKey = buildCacheKeyFromUrl(url);
  try {
    const cached = await cacheGet(env, cacheKey);
    if (cached) {
      logger.info("redis -> responded (series episode)", { key: cacheKey });
      return jsonResponse(cached);
    }
  } catch (e) {
    logger.warn("redis get failed", { key: cacheKey, err: e?.message ?? e });
  }

  const data = await tmdbFetch(
    `tv/${seriesId}/season/${seasonNumber}/episode/${episodeNumber}`,
    { language: language || undefined },
    env
  );
  const payload = buildEpisodePayload(seriesId, data);
  await upsertSeasonEpisodes(env, seriesId, seasonNumber, language, [data]);

  try {
    const ttl = Number(
      env.TMDB_CACHE_SECONDS || env.REDIS_CACHE_TTL || CACHE_INTERVAL_SECONDS
    );
    await cacheSet(env, cacheKey, payload, ttl);
    logger.info("redis <- cached (series episode)", { key: cacheKey, ttl });
  } catch (e) {
    logger.warn("redis set failed", { key: cacheKey, err: e?.message ?? e });
  }
  return jsonResponse(payload);
}
