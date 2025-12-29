import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { logger } from "../lib/logger.js";
import { errorResponse, jsonResponse } from "../lib/response.js";
import { RedisClient } from "../lib/redisClient.js";
import { buildCacheKeyFromUrl } from "../lib/cache.js";
import { CACHE_TTL_SECONDS } from "../lib/config.js";

const execFileAsync = promisify(execFile);

/**
 * Handle metadata extraction from remote video using HTTP range requests.
 * Expects `?url=` query parameter pointing to a direct video file (mp4/mkv).
 * Steps:
 *  - HEAD request to verify `Accept-Ranges: bytes` and get content-length
 *  - Range request for first ~2MB
 *  - Optionally Range request for last ~2MB (for MP4s with moov at end)
 *  - Write merged sample to a temp file and call `ffprobe` to get JSON metadata
 */
export async function handleMetadata(request, env) {
  const url = new URL(request.url);
  logger.info("request received: /v1/metadata", { url: url.toString() });
  const fileUrl = url.searchParams.get("url");
  if (!fileUrl) return errorResponse(400, "url is required");

  // cache key based on request URL (path + relevant query params)
  const cacheKey = buildCacheKeyFromUrl(url);
  const redis = new RedisClient(env);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info("redis -> responded (metadata)", { key: cacheKey });
      return jsonResponse(cached);
    }
  } catch (e) {
    logger.warn("redis get failed", e?.message ?? e);
  }

  try {
    // HEAD
    const headResp = await fetch(fileUrl, { method: "HEAD" });
    if (!headResp.ok) {
      return errorResponse(502, `upstream HEAD failed: ${headResp.status}`);
    }

    const acceptRanges = (
      headResp.headers.get("accept-ranges") || ""
    ).toLowerCase();
    const contentLengthHeader = headResp.headers.get("content-length");
    const contentLength = contentLengthHeader
      ? Number(contentLengthHeader)
      : null;

    const rangesSupported = acceptRanges.includes("bytes");
    if (!rangesSupported) {
      logger.info("upstream did not advertise Accept-Ranges; will still attempt Range requests as a fallback", {
        url: fileUrl,
      });
    }

    const chunkSize = 2 * 1024 * 1024; // 2MB

    // Helper: read up to maxBytes from a response stream safely (cancels if server sends more)
    async function readUpTo(response, maxBytes) {
      if (!response.body || typeof response.body.getReader !== "function") {
        // fallback to arrayBuffer (may allocate full response)
        const ab = await response.arrayBuffer();
        return Buffer.from(ab).slice(0, maxBytes);
      }
      const reader = response.body.getReader();
      const parts = [];
      let received = 0;
      try {
        while (received < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          parts.push(chunk);
          received += chunk.length;
          if (received >= maxBytes) {
            // stop reading further
            await reader.cancel();
            break;
          }
        }
      } catch (e) {
        try {
          await reader.cancel();
        } catch (er) {}
      }
      return Buffer.concat(parts).slice(0, Math.min(received, maxBytes));
    }

    // Fetch first chunk (try Range even if not advertised)
    const firstRange = `bytes=0-${chunkSize - 1}`;
    const firstResp = await fetch(fileUrl, { headers: { Range: firstRange } });
    if (!(firstResp.status === 206 || firstResp.status === 200)) {
      return errorResponse(502, `range fetch failed: ${firstResp.status}`);
    }
    const firstBuf = await readUpTo(firstResp, chunkSize);

    // Optionally fetch tail if content-length suggests it may be needed
    let buffers = [firstBuf];
    if (contentLength && contentLength > chunkSize) {
      const tailStart = Math.max(0, contentLength - chunkSize);
      const tailRange = `bytes=${tailStart}-${contentLength - 1}`;
      try {
        const tailResp = await fetch(fileUrl, {
          headers: { Range: tailRange },
        });
        if (tailResp.status === 206) {
          buffers.push(await readUpTo(tailResp, chunkSize));
        } else {
          // server didn't honor tail range; ignore tail (can't safely download whole file)
          logger.info("tail range not supported or returned whole file; skipping tail sample", {
            status: tailResp.status,
            url: fileUrl,
          });
        }
      } catch (e) {
        // non-fatal; continue with first chunk
        logger.warn("tail range fetch failed", e?.message ?? e);
      }
    }

    const sample = Buffer.concat(buffers);

    // Write sample to temp file
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "livo-meta-")
    );
    const ext = fileUrl.toLowerCase().endsWith(".mkv") ? ".mkv" : ".mp4";
    const tmpPath = path.join(tmpDir, `sample${ext}`);
    await fs.promises.writeFile(tmpPath, sample);

    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          tmpPath,
        ],
        { maxBuffer: 10 * 1024 * 1024 }
      );
      const raw = JSON.parse(stdout);

      // Compact the ffprobe output to only fields our app needs
      function pick(v, keys) {
        const out = {};
        for (const k of keys) if (v?.[k] !== undefined) out[k] = v[k];
        return out;
      }

      const format = raw.format || {};
      const streams = Array.isArray(raw.streams) ? raw.streams : [];

      const videoStream = streams.find((s) => s.codec_type === "video") || null;
      const audioStreams = streams.filter((s) => s.codec_type === "audio");
      const subtitleStreams = streams.filter((s) => s.codec_type === "subtitle");

      // duration helper: prefer numeric duration fields, fallback to format.duration or tags.DURATION strings
      function parseDurationString(d) {
        if (d == null) return null;
        if (typeof d === "number") return d;
        // ffprobe sometimes emits strings like "02:13:38.803000000"
        if (typeof d === "string" && d.includes(":")) {
          const parts = d.split(":").map((p) => p.trim());
          // HH:MM:SS(.ms) or MM:SS
          let secs = 0;
          if (parts.length === 3) {
            const h = Number(parts[0]) || 0;
            const m = Number(parts[1]) || 0;
            const s = Number(parts[2]) || 0;
            secs = h * 3600 + m * 60 + s;
            return secs;
          }
          if (parts.length === 2) {
            const m = Number(parts[0]) || 0;
            const s = Number(parts[1]) || 0;
            secs = m * 60 + s;
            return secs;
          }
        }
        // numeric string
        const n = Number(d);
        return Number.isFinite(n) ? n : null;
      }

      const compact = {
        format: {
          format_name: format.format_name || null,
          format_long_name: format.format_long_name || null,
          duration: format.duration ? Number(format.duration) : null,
          size: format.size ? Number(format.size) : null,
          bit_rate: format.bit_rate ? Number(format.bit_rate) : null,
        },
        video: videoStream
          ? {
              codec: videoStream.codec_name || null,
              profile: videoStream.profile || null,
              width: videoStream.width || null,
              height: videoStream.height || null,
              pix_fmt: videoStream.pix_fmt || null,
              r_frame_rate: videoStream.r_frame_rate || null,
              avg_frame_rate: videoStream.avg_frame_rate || null,
              level: videoStream.level || null,
              // try stream.duration -> tags.DURATION (stream or format) -> format.duration
              duration:
                (videoStream.duration && Number(videoStream.duration)) ||
                parseDurationString(videoStream.tags?.DURATION) ||
                parseDurationString(format.tags?.DURATION) ||
                (format.duration ? Number(format.duration) : null),
            }
          : null,
        audio: audioStreams.map((a) => ({
          codec: a.codec_name || null,
          profile: a.profile || null,
          sample_rate: a.sample_rate ? Number(a.sample_rate) : null,
          channels: a.channels || null,
          channel_layout: a.channel_layout || null,
          language: a.tags?.language || null,
          duration:
            (a.duration && Number(a.duration)) ||
            parseDurationString(a.tags?.DURATION) ||
            parseDurationString(format.tags?.DURATION) ||
            (format.duration ? Number(format.duration) : null),
        })),
        subtitles: subtitleStreams.map((s) => ({
          codec: s.codec_name || null,
          language: s.tags?.language || s.tags?.LANGUAGE || null,
          forced: !!s.disposition?.forced,
        })),
        probe_score: raw.format?.probe_score ?? raw.probe_score ?? null,
      };

      try {
        await redis.set(cacheKey, compact, CACHE_TTL_SECONDS);
        logger.info("redis <- cached (metadata)", { key: cacheKey, ttl: CACHE_TTL_SECONDS });
      } catch (e) {
        logger.warn("redis set failed", e?.message ?? e);
      }
      return jsonResponse(compact);
    } catch (e) {
      logger.warn("ffprobe failed", e?.message ?? e);
      return errorResponse(500, "ffprobe failed");
    } finally {
      try {
        await fs.promises.unlink(tmpPath);
        await fs.promises.rmdir(tmpDir);
      } catch (e) {
        // ignore cleanup errors
      }
    }
  } catch (err) {
    logger.error("metadata handler error", err?.message ?? err);
    return errorResponse(500, err?.message ?? String(err));
  }
}
