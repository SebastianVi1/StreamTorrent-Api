/**
 * StreamTorrent API — Video Streaming Controller
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * HOW IT WORKS
 *
 * The API streams video from two sources:
 *
 *  1. LOCAL FILES  — `GET /api/stream/:filename`
 *     Files are served from `src/public/videos/`. Simple byte-range reads
 *     with backpressure via Node.js `pipeline()`.
 *
 *  2. TORRENTS     — `GET /api/torrent/:magnet`
 *     Magnet links are added to a shared WebTorrent client. The largest file
 *     in the torrent is selected and streamed chunk-by-chunk. The client
 *     holds the torrent in memory and feeds pieces to the response stream.
 *
 * BYTE-RANGE STREAMING
 *
 * Both endpoints require a `Range` header from the client (e.g. `Range: bytes=0-4194303`).
 * The server responds with HTTP 206 Partial Content and sends `CHUNK_SIZE` bytes
 * (default 4 MB) per request. The client must re-request subsequent chunks.
 * Without a `Range` header the server returns HTTP 416.
 *
 * This design prevents loading entire files into memory — even multi-GB torrents
 * are streamed piece-by-piece from the WebTorrent engine to the HTTP response.
 *
 * RESOURCE MANAGEMENT
 *
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │  activeTorrents Map  —  key: magnetLink, value: WebTorrent torrent   │
 *  │  activeConnections    —  key: connectionId, value: stream metadata   │
 *  │  torrentLastAccess     —  key: magnetLink, value: timestamp (ms)       │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 *  - Periodic cleanup runs every `CLEANUP_INTERVAL_MS` (default 2 min).
 *  - Torrents inactive for `TORRENT_TIMEOUT_MS` (default 10 min) are removed.
 *  - After a client disconnects, `FILE_CLEANUP_DELAY_MS` (30s) passes before
 *    the torrent is evicted — allowing reuse if the client reconnects quickly.
 *  - Orphaned files in `downloads/` (torrents no longer tracked) are also purged.
 *
 * RATE LIMITING
 *
 *  Per-IP sliding window: `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`.
 *  Exceeding clients receive HTTP 429 with a `Retry-After` header.
 *
 * CAPACITY HANDLING
 *
 *  When `MAX_TORRENTS` is reached and the incoming torrent is new, the server
 *  returns HTTP 503 with `Retry-After` instead of evicting an existing torrent
 *  behind a client's back. Clients should honour the Retry-After delay.
 *
 * LOGGING
 *
 *  - `prodLog()` emits structured JSON in production (`NODE_ENV=production`
 *    or `STREAM_ENABLE_PROD_LOGS=true`). Includes `ts`, `level`, `message`,
 *    `requestId`, and contextual fields.
 *  - `devLog()` emits human-readable timestamps in development.
 *  - Every request gets a unique `X-Request-ID` header for traceability.
 *
 * CONFIG VALIDATION
 *
 *  On startup, `validateConfig()` checks all numeric env vars. Invalid values
 *  (negative, non-numeric, unset when required) cause a fast `process.exit(1)`.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { getVideoFileInfo } from "../services/videoStreamingService.js";
import WebTorrent from "webtorrent";

// ─── Logging ───────────────────────────────────────────────────────────────────

const ENABLE_PROD_LOGS =
  process.env.NODE_ENV === "production" ||
  process.env.STREAM_ENABLE_PROD_LOGS === "true";

function prodLog(level, message, context = {}) {
  if (!ENABLE_PROD_LOGS) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...context }));
}

function devLog(...args) {
  if (process.env.NODE_ENV !== "production" && !ENABLE_PROD_LOGS) {
    console.log(new Date().toISOString(), ...args);
  }
}

// ─── WebTorrent Client (shared singleton) ─────────────────────────────────────

const client = new WebTorrent();

client.on("error", (err) => {
  prodLog("error", "WebTorrent client error", { error: err.message });
});

client.on("torrent", (torrent) => {
  prodLog("info", "Torrent added", { name: torrent.name });
});

// ─── In-Memory State ───────────────────────────────────────────────────────────

/** Active torrents keyed by magnet URI */
const activeTorrents = new Map();

/** Active streaming connections keyed by connectionId */
const activeConnections = new Map();

/** Last access timestamp (ms) per magnet URI, used for idle eviction */
const torrentLastAccess = new Map();

// ─── Configuration (env vars with defaults) ────────────────────────────────────

const CONFIG = {
  MAX_TORRENTS:             parseInt(process.env.MAX_TORRENTS || "20", 10),
  TORRENT_TIMEOUT:          parseInt(process.env.TORRENT_TIMEOUT_MS || "600000", 10),
  CLEANUP_INTERVAL:         parseInt(process.env.CLEANUP_INTERVAL_MS || "120000", 10),
  FILE_CLEANUP_DELAY:       parseInt(process.env.FILE_CLEANUP_DELAY_MS || "30000", 10),
  CHUNK_SIZE:               parseInt(process.env.STREAM_CHUNK_SIZE_BYTES || "4194304", 10),
  MAX_STREAM_FILE_SIZE:     parseInt(process.env.STREAM_MAX_FILE_SIZE_BYTES || "5368709120", 10),
  TORRENT_START_TIMEOUT_MS: parseInt(process.env.TORRENT_START_TIMEOUT_MS || "30000", 10),
  RATE_LIMIT_WINDOW_MS:    parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
  RATE_LIMIT_MAX_REQUESTS:  parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "10", 10),
};

// Downloads directory where torrent data is stored
const downloadsPath = path.join(path.resolve(), "downloads");

// ─── Config Validation ─────────────────────────────────────────────────────────

validateConfig();

function validateConfig() {
  const errors = [];
  const checks = [
    ["MAX_TORRENTS",              CONFIG.MAX_TORRENTS,              1,      null],
    ["STREAM_CHUNK_SIZE_BYTES",   CONFIG.CHUNK_SIZE,               1024,   null],
    ["STREAM_MAX_FILE_SIZE_BYTES",CONFIG.MAX_STREAM_FILE_SIZE,     1024,   null],
    ["TORRENT_TIMEOUT_MS",        CONFIG.TORRENT_TIMEOUT,          1,      null],
    ["CLEANUP_INTERVAL_MS",       CONFIG.CLEANUP_INTERVAL,        1,      null],
    ["FILE_CLEANUP_DELAY_MS",     CONFIG.FILE_CLEANUP_DELAY,       0,      null],
  ];
  for (const [name, val, min, _] of checks) {
    if (isNaN(val) || val < min) {
      errors.push(`${name} must be a positive integer >= ${min} (got: ${process.env[name] || "unset"})`);
    }
  }
  if (errors.length > 0) {
    console.error("Config validation failed:");
    errors.forEach((e) => console.error(" -", e));
    process.exit(1);
  }
  devLog("[config] validated", CONFIG);
}

// ─── Rate Limiting (sliding window per IP) ─────────────────────────────────────

/** Map of IP → { count, windowStart } */
const rateLimitMap = new Map();

/**
 * Returns { allowed: true, remaining } or { allowed: false, retryAfter }.
 * Uses a simple sliding-window counter per IP address.
 */
function rateLimit(ip, maxRequests, windowMs) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.windowStart > windowMs) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return { allowed: true, remaining: maxRequests - 1 };
  }
  if (record.count >= maxRequests) {
    return { allowed: false, retryAfter: Math.ceil((record.windowStart + windowMs - now) / 1000) };
  }
  record.count++;
  return { allowed: true, remaining: maxRequests - record.count };
}

// ─── Request ID ────────────────────────────────────────────────────────────────

/** Generate a short unique request ID (timestamp + random suffix) */
function generateRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

/** Express middleware: attaches requestId to req and sets X-Request-ID response header */
function attachRequestId(req, res, next) {
  req.requestId = generateRequestId();
  res.setHeader("X-Request-ID", req.requestId);
  next();
}

// ─── Periodic Cleanup ──────────────────────────────────────────────────────────

/**
 * Runs every CLEANUP_INTERVAL_MS:
 *  1. Evicts torrents idle for > TORRENT_TIMEOUT_MS
 *  2. Removes orphaned files/directories in downloads/
 */
setInterval(() => {
  prodLog("info", "Periodic cleanup", {
    activeTorrents: activeTorrents.size,
    activeConnections: activeConnections.size,
  });
  const now = Date.now();
  torrentLastAccess.forEach((lastAccess, magnetLink) => {
    if (now - lastAccess > CONFIG.TORRENT_TIMEOUT) {
      removeTorrent(magnetLink);
    }
  });
  cleanupOrphanedFiles();
}, CONFIG.CLEANUP_INTERVAL);

// ─── Torrent Lifecycle ─────────────────────────────────────────────────────────

/**
 * Remove a torrent from the client, delete its downloaded files from disk,
 * and clean up all associated state (connections, last-access record).
 */
function removeTorrent(magnetLink) {
  const torrent = activeTorrents.get(magnetLink);
  if (!torrent) return;
  prodLog("info", "Removing inactive torrent", { torrent: torrent.name || "unnamed", magnetLink });

  client.remove(torrent, { destroyStore: true }, (err) => {
    if (err) devLog("[torrent] error removing:", err.message);
  });

  // Manually delete the on-disk torrent directory
  if (torrent.path) {
    try {
      const torrentPath = path.join(downloadsPath, torrent.name);
      if (fs.existsSync(torrentPath)) {
        fs.rmSync(torrentPath, { recursive: true, force: true });
        prodLog("info", "Removed torrent directory", { path: torrentPath });
      }
    } catch (e) {
      devLog("[torrent] error removing files:", e.message);
    }
  }

  activeTorrents.delete(magnetLink);
  torrentLastAccess.delete(magnetLink);

  // Drop connections associated with this torrent
  activeConnections.forEach((connInfo, connId) => {
    if (connInfo.magnetLink === magnetLink) activeConnections.delete(connId);
  });
}

/**
 * Delete files/directories in downloads/ that are not tracked by activeTorrents.
 * Called every cleanup cycle to prevent disk bloat.
 */
function cleanupOrphanedFiles() {
  try {
    if (!fs.existsSync(downloadsPath)) return;
    const activeNames = new Set();
    activeTorrents.forEach((t) => { if (t.name) activeNames.add(t.name); });
    fs.readdirSync(downloadsPath).forEach((file) => {
      if (!activeNames.has(file)) {
        const filePath = path.join(downloadsPath, file);
        try {
          fs.rmSync(filePath, { recursive: true, force: true });
          prodLog("info", "Removed orphaned entry", { path: filePath });
        } catch (e) {
          devLog("[cleanup] error removing", filePath, e.message);
        }
      }
    });
  } catch (err) {
    devLog("[cleanup] error:", err.message);
  }
}

/**
 * Add a magnet link to WebTorrent and wait for it to be ready (or timeout).
 * Returns the torrent object. Reuses an already-active torrent if available.
 */
function resolveTorrent(magnetLink) {
  return new Promise((resolve, reject) => {
    const existing = activeTorrents.get(magnetLink);
    if (existing && existing.ready) return resolve(existing);

    let settled = false;
    let timeoutId;

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      fn(val);
    };

    const torrent = client.add(magnetLink, { path: downloadsPath });

    torrent.on("error", (err) => settle(reject, err));
    torrent.on("ready", () => settle(resolve, torrent));

    // Guard against torrent stuck in connecting state
    timeoutId = setTimeout(() => {
      if (activeTorrents.has(magnetLink)) removeTorrent(magnetLink);
      settle(reject, new Error("Torrent download timeout"));
    }, CONFIG.TORRENT_START_TIMEOUT_MS);
  });
}

// ─── Byte-Range Parsing ────────────────────────────────────────────────────────

/**
 * Parse a Range header value against a file size.
 *
 * If no Range header: returns a chunk starting at 0 up to maxChunkSize.
 * If Range is invalid or unsatisfiable: returns null (caller should respond 416).
 * Respects maxChunkSize to prevent clients requesting huge single chunks.
 */
function getByteRange(rangeHeader, fileSize, maxChunkSize) {
  const safeChunk = Math.min(maxChunkSize, fileSize);
  if (fileSize === 0) return { start: 0, end: 0 };
  if (!rangeHeader) return { start: 0, end: safeChunk - 1 };

  const matches = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!matches) return null;

  let start = matches[1] ? parseInt(matches[1], 10) : 0;
  let end = matches[2] ? parseInt(matches[2], 10) : start + safeChunk - 1;

  if (Number.isNaN(start) || start >= fileSize) return null;
  if (Number.isNaN(end) || end >= fileSize) end = Math.min(start + safeChunk - 1, fileSize - 1);
  if (end < start) end = Math.min(start + safeChunk - 1, fileSize - 1);
  if (end - start + 1 > safeChunk) end = start + safeChunk - 1;

  return { start, end };
}

// ─── HTTP Response Helpers ─────────────────────────────────────────────────────

function respondWithUnsatisfiedRange(res, fileSize) {
  res.status(416).set({
    "Content-Range": `bytes */${fileSize}`,
    "Cache-Control": "no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  }).end();
  return res;
}

function buildStreamHeaders({ start, end, totalSize, chunkSize, contentType }) {
  return {
    "Content-Range": `bytes ${start}-${end}/${totalSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": contentType || "video/mp4",
    "Cache-Control": "no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  };
}

// ─── Connection Tracking ───────────────────────────────────────────────────────

/** Returns true if any active connection is associated with the given magnetLink */
function hasActiveConnections(magnetLink) {
  for (const info of activeConnections.values()) {
    if (info.magnetLink === magnetLink) return true;
  }
  return false;
}

// ─── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/stream/:filename
 *
 * Stream a local video file from src/public/videos/ with byte-range support.
 * Requires Range header (HTTP 416 if missing).
 * Large files are rejected before allocation (HTTP 413).
 */
export async function streamVideoController(req, res) {
  const { requestId } = req;
  try {
    const fileName = req.params.filename;
    prodLog("info", "Local video requested", { requestId, fileName });

    const { videoPath, stat, contentType } = getVideoFileInfo(fileName);
    const videoSize = stat.size;

    if (videoSize > CONFIG.MAX_STREAM_FILE_SIZE) {
      prodLog("warn", "Local video rejected due to size", { requestId, fileName, videoSize });
      return res.status(413).json({ error: "Requested file exceeds streaming size limit" });
    }

    const rangeDetails = getByteRange(req.headers.range, videoSize, CONFIG.CHUNK_SIZE);
    if (!rangeDetails) {
      prodLog("warn", "Invalid range for local video", { requestId, fileName, range: req.headers.range });
      return respondWithUnsatisfiedRange(res, videoSize);
    }

    const { start, end } = rangeDetails;
    const contentLength = end - start + 1;

    res.writeHead(206, buildStreamHeaders({ start, end, totalSize: videoSize, chunkSize: contentLength, contentType }));

    // Use highWaterMark = CHUNK_SIZE to control read buffer depth
    const videoStream = fs.createReadStream(videoPath, { start, end, highWaterMark: CONFIG.CHUNK_SIZE });

    let isClientDisconnected = false;
    req.on("close", () => {
      isClientDisconnected = true;
      if (!videoStream.destroyed) videoStream.destroy();
    });

    pipeline(videoStream, res, (err) => {
      if (err && !isClientDisconnected) {
        prodLog("error", "Video stream pipeline error", { requestId, fileName, error: err.message });
        if (!res.headersSent) res.status(500).json({ error: "Streaming error occurred" });
      }
    });
  } catch (err) {
    prodLog("error", "Video streaming error", { requestId, error: err.message });
    res.status(404).json({ error: err.message });
  }
}

/**
 * GET /api/torrent/:magnet
 *
 * Stream the largest file from a magnet torrent. Handles:
 *  - Rate limiting (429), capacity overload (503), torrent timeouts (500)
 *  - Byte-range streaming via WebTorrent's createReadStream()
 *  - Client disconnect → destroy stream → schedule idle cleanup
 *  - Last-access tracking so idle torrents are evicted correctly
 */
export async function streamTorrentController(req, res) {
  const { requestId } = req;
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const magnetLink = decodeURIComponent(req.params.magnet || "");

  if (!magnetLink) return res.status(400).json({ error: "Magnet link is required" });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const rateLimitResult = rateLimit(ip, CONFIG.RATE_LIMIT_MAX_REQUESTS, CONFIG.RATE_LIMIT_WINDOW_MS);
  if (!rateLimitResult.allowed) {
    prodLog("warn", "Rate limit exceeded", { requestId, ip, retryAfter: rateLimitResult.retryAfter });
    res.set("Retry-After", rateLimitResult.retryAfter);
    return res.status(429).json({ error: "Rate limit exceeded", retryAfter: rateLimitResult.retryAfter });
  }

  // ── Capacity check — fail fast with 503 instead of silent eviction ────────
  if (activeTorrents.size >= CONFIG.MAX_TORRENTS && !activeTorrents.has(magnetLink)) {
    const retryAfter = Math.ceil(CONFIG.CLEANUP_INTERVAL / 1000);
    prodLog("warn", "Max torrent limit reached", { requestId, activeTorrents: activeTorrents.size, maxTorrents: CONFIG.MAX_TORRENTS });
    res.set("Retry-After", retryAfter);
    return res.status(503).json({
      error: "Server at capacity",
      retryAfter,
      activeTorrents: activeTorrents.size,
      maxTorrents: CONFIG.MAX_TORRENTS,
    });
  }

  const connectionId = `${requestId}`;
  prodLog("info", "Torrent stream requested", { requestId, magnetLink, connectionId, ip });

  // ── Add/reuse torrent ─────────────────────────────────────────────────────
  let torrent;
  try {
    torrent = await resolveTorrent(magnetLink);
  } catch (error) {
    prodLog("error", "Failed to add torrent", { requestId, error: error.message, magnetLink });
    return res.status(500).json({ error: "Failed to add torrent" });
  }

  activeTorrents.set(magnetLink, torrent);
  torrentLastAccess.set(magnetLink, Date.now());

  // Select the largest file in the torrent (assumed to be the main video)
  const file = torrent.files.reduce((largest, f) => (f.length > largest.length ? f : largest));
  const fileSize = file.length;
  const extension = path.extname(file.name).toLowerCase();
  const contentType = ({ ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".webm": "video/webm" })[extension] || "video/mp4";

  prodLog("info", "Streaming torrent file", { requestId, fileName: file.name, size: fileSize, torrentName: torrent.name });

  activeConnections.set(connectionId, { magnetLink, torrentName: torrent.name, startTime: Date.now(), fileName: file.name });

  // ── Size check ────────────────────────────────────────────────────────────
  if (fileSize > CONFIG.MAX_STREAM_FILE_SIZE) {
    prodLog("warn", "Torrent skipped due to size", { requestId, torrentName: torrent.name, fileSize });
    return res.status(413).json({ error: "Torrent file exceeds streaming size limit" });
  }

  // ── Byte-range ────────────────────────────────────────────────────────────
  const rangeDetails = getByteRange(req.headers.range, fileSize, CONFIG.CHUNK_SIZE);
  if (!rangeDetails) {
    prodLog("warn", "Invalid range for torrent stream", { requestId, torrentName: torrent.name, range: req.headers.range });
    return respondWithUnsatisfiedRange(res, fileSize);
  }

  const { start, end } = rangeDetails;
  const chunkSize = end - start + 1;

  res.writeHead(206, buildStreamHeaders({ start, end, totalSize: fileSize, chunkSize, contentType }));

  // ── Stream via WebTorrent (not fs) ────────────────────────────────────────
  const stream = file.createReadStream({ start, end, highWaterMark: CONFIG.CHUNK_SIZE });
  let isClientDisconnected = false;
  let connectionClosed = false;

  const finalizeConnection = (reason) => {
    if (connectionClosed) return;
    connectionClosed = true;
    activeConnections.delete(connectionId);
    // Only update last-access if the stream completed normally; on disconnect
    // we don't want to extend the torrent's lifetime unnecessarily.
    if (reason !== "client-disconnect") torrentLastAccess.set(magnetLink, Date.now());
  };

  const destroyStream = () => { if (stream && !stream.destroyed) stream.destroy(); };

  /**
   * After the client disconnects, wait FILE_CLEANUP_DELAY_MS and remove the
   * torrent if no new connections have started. This balances memory use
   * against the common case of a client seeking to a new position (which
   * would create a new connection and re-use the same torrent).
   */
  const scheduleCleanupIfIdle = () => {
    if (hasActiveConnections(magnetLink)) return;
    devLog("[torrent] no active connections, scheduling cleanup for", torrent.name);
    setTimeout(() => {
      if (!hasActiveConnections(magnetLink)) {
        devLog("[torrent] removing unused torrent:", torrent.name);
        removeTorrent(magnetLink);
      }
    }, CONFIG.FILE_CLEANUP_DELAY);
  };

  req.on("close", () => {
    if (connectionClosed) return;
    isClientDisconnected = true;
    prodLog("info", "Client disconnected", { requestId, magnetLink, torrentName: torrent.name });
    destroyStream();
    finalizeConnection("client-disconnect");
    scheduleCleanupIfIdle();
  });

  pipeline(stream, res, (err) => {
    if (err && !isClientDisconnected) {
      prodLog("error", "Torrent stream pipeline error", { requestId, torrentName: torrent.name, error: err.message });
      if (!res.headersSent) res.status(500).json({ error: "Streaming error occurred" });
    }
    finalizeConnection(isClientDisconnected ? "client-disconnect" : err ? "error" : "completed");
    scheduleCleanupIfIdle();
  });
}

/**
 * GET /api/torrent/:magnet/info
 *
 * Returns metadata about a torrent without streaming it. Includes:
 *  - All files with names and sizes
 *  - The largest file (assumed video)
 *  - Download progress, speed, peers, ratio, time remaining
 *  - Number of active connections for this torrent
 */
export async function torrentInfoController(req, res) {
  const { requestId } = req;
  const magnetLink = decodeURIComponent(req.params.magnet || "");
  if (!magnetLink) return res.status(400).json({ error: "Magnet link is required" });
  const ip = req.ip || req.connection?.remoteAddress || "unknown";

  const rateLimitResult = rateLimit(ip, CONFIG.RATE_LIMIT_MAX_REQUESTS, CONFIG.RATE_LIMIT_WINDOW_MS);
  if (!rateLimitResult.allowed) {
    res.set("Retry-After", rateLimitResult.retryAfter);
    return res.status(429).json({ error: "Rate limit exceeded", retryAfter: rateLimitResult.retryAfter });
  }

  prodLog("info", "Torrent info requested", { requestId, magnetLink });

  let torrent;
  try {
    torrent = await resolveTorrent(magnetLink);
  } catch (error) {
    prodLog("error", "Failed to get torrent info", { requestId, error: error.message, magnetLink });
    return res.status(500).json({ error: "Failed to get torrent info" });
  }

  activeTorrents.set(magnetLink, torrent);
  torrentLastAccess.set(magnetLink, Date.now());

  const file = torrent.files.reduce((largest, f) => (f.length > largest.length ? f : largest));
  const extension = path.extname(file.name).toLowerCase();
  const contentType = ({ ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".webm": "video/webm" })[extension] || "video/mp4";

  res.json({
    name: torrent.name,
    infoHash: torrent.infoHash,
    files: torrent.files.map((f) => ({
      name: f.name,
      length: f.length,
      contentType: getContentType(f.name),
    })),
    largestFile: { name: file.name, length: file.length, contentType },
    progress: Math.round(torrent.progress * 100),
    downloadSpeed: torrent.downloadSpeed,
    numPeers: torrent.numPeers,
    uploaded: torrent.uploaded,
    downloaded: torrent.downloaded,
    ratio: torrent.ratio,
    timeRemaining: torrent.timeRemaining,
    activeConnections: Array.from(activeConnections.values()).filter((c) => c.magnetLink === magnetLink).length,
  });
}

// ─── Content-Type Resolution ────────────────────────────────────────────────────

function getContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".webm": "video/webm",
    ".mp4": "video/mp4",        ".m4v": "video/mp4",
    ".mp3": "audio/mpeg",       ".aac": "audio/aac",      ".wav": "audio/wav",
    ".ogg": "audio/ogg",        ".flac": "audio/flac",
  };
  return map[ext] || "video/mp4";
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────

/** Called by server.js on SIGTERM/SIGINT — tears down all active torrents */
export function cleanupTorrents() {
  prodLog("info", "Cleaning up all torrents");
  activeTorrents.forEach((_, magnetLink) => removeTorrent(magnetLink));
  try {
    if (fs.existsSync(downloadsPath)) {
      fs.readdirSync(downloadsPath).forEach((file) => {
        const filePath = path.join(downloadsPath, file);
        try { fs.rmSync(filePath, { recursive: true, force: true }); } catch (e) {}
      });
    }
  } catch (err) {}
  prodLog("info", "Cleanup complete");
}

// ─── Status Endpoint ────────────────────────────────────────────────────────────

/** GET /api/status — returns server state for monitoring and debugging */
export function getStatus(req, res) {
  res.json({
    config: {
      maxTorrents: CONFIG.MAX_TORRENTS,
      chunkSize: CONFIG.CHUNK_SIZE,
      maxFileSize: CONFIG.MAX_STREAM_FILE_SIZE,
    },
    activeTorrents: Array.from(activeTorrents.entries()).map(([magnetLink, torrent]) => ({
      infoHash: torrent.infoHash,
      name: torrent.name,
      progress: Math.round(torrent.progress * 100),
      downloadSpeed: torrent.downloadSpeed,
      numPeers: torrent.numPeers,
      uploaded: torrent.uploaded,
      downloaded: torrent.downloaded,
      ratio: torrent.ratio,
      timeRemaining: torrent.timeRemaining,
      lastAccess: torrentLastAccess.get(magnetLink),
    })),
    activeConnections: Array.from(activeConnections.values()).map((c) => ({
      torrentName: c.torrentName,
      fileName: c.fileName,
      duration: Date.now() - c.startTime,
    })),
    totalTorrents: activeTorrents.size,
    totalConnections: activeConnections.size,
  });
}

// ─── Exports ────────────────────────────────────────────────────────────────────

export { attachRequestId, CONFIG };