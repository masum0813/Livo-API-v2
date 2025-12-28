import { errorResponse, jsonResponse } from "../lib/response.js";

const DEFAULT_TTL_SECONDS = 300;

const DISALLOWED_FORWARDED_HEADERS = new Set([
  "host",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

const DEFAULT_FORWARD_HEADER_LIST = [
  "user-agent",
  "accept",
  "accept-language",
  "origin",
  "referer",
  "x-channel-id",
  "x-resume-key",
];

const REDIRECT_RESOLVE_MAX_TIME_MS = 8000;

/**
 * Builds a signed, time-limited stream proxy URL for a given upstream HTTP resource.
 *
 * @param {Request} request Incoming request.
 * @param {Record<string, any>} env Worker environment bindings.
 * @returns {Promise<Response>} JSON response containing the signed proxy URL.
 */
export async function handleStreamUrl(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET") {
    return errorResponse(405, "method not allowed");
  }

  console.log("stream-url-request", {
    method: request.method,
    path: url.pathname,
    headers: redactHeadersForLog(request.headers),
  });

  const target = url.searchParams.get("url");
  if (!target) {
    return errorResponse(400, "url is required");
  }

  if (!env.STREAM_SIGNING_SECRET) {
    return errorResponse(500, "STREAM_SIGNING_SECRET is missing");
  }
  if (!env.STREAM_PROXY_BASE) {
    return errorResponse(500, "STREAM_PROXY_BASE is missing");
  }

  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    return errorResponse(400, "invalid url");
  }
  if (upstream.protocol !== "http:") {
    return errorResponse(403, "only http sources allowed");
  }

  const ttl = Number(url.searchParams.get("ttl") || DEFAULT_TTL_SECONDS);
  const ttlSeconds =
    Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const forwardHeaderEnv = env.STREAM_FORWARD_HEADERS ?? env.FORWARD_HEADERS;
  const forwardedHeadersPayload = buildForwardedHeadersPayload(
    request,
    forwardHeaderEnv
  );

  const resolvedUpstream = await resolveFinalUpstreamUrl(upstream, forwardedHeadersPayload);
  if (!resolvedUpstream) {
    return errorResponse(502, "failed to resolve upstream");
  }
  if (resolvedUpstream.protocol !== "http:") {
    return errorResponse(403, "only http sources allowed");
  }

  const fh =
    Object.keys(forwardedHeadersPayload).length > 0
      ? JSON.stringify(forwardedHeadersPayload)
      : "";
  const payload = fh
    ? `${resolvedUpstream.toString()}|${exp}|${fh}`
    : `${resolvedUpstream.toString()}|${exp}`;
  const sig = await hmacHex(env.STREAM_SIGNING_SECRET, payload);

  const proxyBase = new URL(env.STREAM_PROXY_BASE);
  proxyBase.pathname = "/proxy";
  proxyBase.searchParams.set("url", resolvedUpstream.toString());
  proxyBase.searchParams.set("exp", String(exp));
  proxyBase.searchParams.set("sig", sig);
  if (fh) {
    proxyBase.searchParams.set("fh", fh);
  }

  return jsonResponse({
    url: proxyBase.toString(),
    exp,
    ttl: ttlSeconds,
  });
}

async function resolveFinalUpstreamUrl(initialUpstreamUrl, forwardedHeadersPayload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REDIRECT_RESOLVE_MAX_TIME_MS);
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(forwardedHeadersPayload ?? {})) {
      headers.set(name, value);
    }

    // Prefer HEAD to avoid downloading the media. Fallback to a small ranged GET when HEAD is blocked.
    let resp = await fetch(initialUpstreamUrl.toString(), {
      method: "HEAD",
      redirect: "follow",
      headers,
      signal: controller.signal,
    });

    if (resp.status === 405 || resp.status === 403) {
      headers.set("range", "bytes=0-0");
      resp = await fetch(initialUpstreamUrl.toString(), {
        method: "GET",
        redirect: "follow",
        headers,
        signal: controller.signal,
      });
    }

    // `resp.url` is the final URL after redirects.
    return resp?.url ? new URL(resp.url) : initialUpstreamUrl;
  } catch (error) {
    console.warn(
      "upstream-resolve-failed",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildForwardedHeadersPayload(request, forwardHeaderEnv) {
  const forwardHeaderList = (forwardHeaderEnv ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const headerNames =
    forwardHeaderList.length > 0 ? forwardHeaderList : DEFAULT_FORWARD_HEADER_LIST;

  const result = {};
  for (const headerName of headerNames) {
    if (DISALLOWED_FORWARDED_HEADERS.has(headerName)) {
      continue;
    }
    const value = request.headers.get(headerName);
    if (value) {
      result[headerName] = value;
    }
  }
  return result;
}

function redactHeadersForLog(headers) {
  const redactedNames = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
  ]);
  const result = {};
  for (const [name, value] of headers.entries()) {
    const lowerName = name.toLowerCase();
    if (redactedNames.has(lowerName)) {
      result[lowerName] = "[REDACTED]";
      continue;
    }
    result[lowerName] = value;
  }
  return result;
}

async function hmacHex(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
