import dotenv from "dotenv";
import express from "express";
import { getRedisClient } from "./lib/cache.js";
import { createDbShim } from "./lib/db_shim.js";
import { errorResponse, jsonResponse } from "./lib/response.js";
import {
  handleMovieById,
  handleMovieLookup,
  handleSearch,
} from "./routes/movie.js";
import {
  handleSeriesById,
  handleSeriesEpisode,
  handleSeriesSearch,
  handleSeriesSeason,
} from "./routes/series.js";
import { handleStreamUrl } from "./routes/stream.js";
import { handleTmdbProxy } from "./routes/tmdb_proxy.js";

dotenv.config();

// Provide a simple caches.default shim used by some route code (no-op cache)
global.caches = {
  default: {
    async match() {
      return null;
    },
    async put() {
      return;
    },
  },
};

const app = express();

const env = {
  TMDB_API_KEY: process.env.TMDB_API_KEY,
  STREAM_SIGNING_SECRET: process.env.STREAM_SIGNING_SECRET,
  STREAM_PROXY_BASE: process.env.STREAM_PROXY_BASE,
  STREAM_FORWARD_HEADERS: process.env.STREAM_FORWARD_HEADERS,
  FORWARD_HEADERS: process.env.FORWARD_HEADERS,
  REDIS_URL: process.env.REDIS_URL,
  TMDB_CACHE_SECONDS: Number(
    process.env.TMDB_CACHE_SECONDS || 24 * 60 * 60 * 30
  ),
};

// If a real env.DB is not provided (sqlite removed), provide a Redis-backed shim
if (!env.DB) {
  env.DB = createDbShim(env);
}

// Warm up redis client (lazy-creates if REDIS_URL provided)
try {
  getRedisClient(env);
} catch (e) {
  console.warn("redis client init failed", e?.message ?? e);
}

async function ensureRedisReady(env) {
  const client = getRedisClient(env);
  const waitSeconds = Number(process.env.REDIS_WAIT_SECONDS || 60);
  const intervalMs = Number(process.env.REDIS_WAIT_INTERVAL_MS || 500);
  const deadline = Date.now() + waitSeconds * 1000;
  console.log(
    `Waiting for redis at ${env.REDIS_URL || "local"} (timeout ${waitSeconds}s)`
  );
  while (Date.now() < deadline) {
    try {
      const res = await client.ping();
      if (res === "PONG" || res === "pong") {
        console.log("Redis is ready");
        return true;
      }
    } catch (err) {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Redis did not become ready within ${waitSeconds}s`);
}

function makeCtx() {
  return {
    waitUntil(promise) {
      try {
        if (promise && typeof promise.then === "function")
          promise.catch(() => {});
      } catch (e) {}
    },
  };
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders();
  Object.keys(cors).forEach((key) => headers.set(key, cors[key]));
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

app.use(async (req, res) => {
  try {
    const proto = req.protocol;
    const host = req.get("host");
    const fullUrl = `${proto}://${host}${req.originalUrl}`;

    const request = new Request(fullUrl, {
      method: req.method,
      headers: req.headers,
    });

    const ctx = makeCtx();

    // OPTIONS preflight
    if (request.method === "OPTIONS") {
      const ch = corsHeaders();
      Object.entries(ch).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(204).send();
    }

    if (request.method !== "GET") {
      const resp = withCors(errorResponse(405, "method not allowed"));
      for (const [k, v] of resp.headers) res.setHeader(k, v);
      res.status(resp.status);
      return res.send(await resp.text());
    }

    const url = new URL(request.url);
    let response;
    if (url.pathname === "/v1/health") {
      response = withCors(jsonResponse({ ok: true }));
    } else if (url.pathname === "/v1/search") {
      response = withCors(await handleSearch(request, env, ctx));
    } else if (url.pathname === "/v1/movie/lookup") {
      response = withCors(await handleMovieLookup(request, env));
    } else if (url.pathname === "/v1/movie") {
      // Support requests like /v1/movie?title=...&channelId=...
      response = withCors(await handleMovieLookup(request, env));
    } else if (url.pathname.startsWith("/v1/movie/")) {
      response = withCors(await handleMovieLookup(request, env, ctx));
    } else if (url.pathname.match(/^\/v1\/movie\/\d+\/\d+$/)) {
      response = withCors(await handleMovieById(request, env));
    } else if (url.pathname === "/v1/stream-url") {
      response = withCors(await handleStreamUrl(request, env));
    } else if (url.pathname === "/v1/series/search") {
      response = withCors(await handleSeriesSearch(request, env));
    } else if (
      url.pathname === "/v1/series" ||
      url.pathname === "/v1/series/"
    ) {
      // Support requests like /v1/series?title=...&channelId=...
      response = withCors(await handleSeriesSearch(request, env));
    } else if (
      url.pathname.match(/^\/v1\/series\/\d+\/season\/\d+\/episode\/\d+$/)
    ) {
      response = withCors(await handleSeriesEpisode(request, env));
    } else if (url.pathname.match(/^\/v1\/series\/\d+\/season\/\d+$/)) {
      response = withCors(await handleSeriesSeason(request, env));
    } else if (url.pathname.startsWith("/v1/series/")) {
      response = withCors(await handleSeriesById(request, env));
    } else if (url.pathname.startsWith("/3/")) {
      response = withCors(await handleTmdbProxy(request, env));
    } else {
      response = withCors(errorResponse(404, "not found"));
    }

    // copy headers
    for (const [key, value] of response.headers) {
      res.setHeader(key, value);
    }

    res.status(response.status);
    const body = await response.text();
    res.send(body);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const PORT = process.env.PORT || 3000;

(async function startServer() {
  try {
    if (env.REDIS_URL) {
      await ensureRedisReady(env);
    }
    app.listen(PORT, () => {
      console.log(`API server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err?.message ?? err);
    process.exit(1);
  }
})();
