import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { getVideoFileInfo } from "../services/videoStreamingService.js";
import WebTorrent from "webtorrent";

const ENABLE_PROD_LOGS =
  process.env.NODE_ENV === "production" ||
  process.env.STREAM_ENABLE_PROD_LOGS === "true";

function prodLog(level, message, context = {}) {
  if (!ENABLE_PROD_LOGS) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  console.log(JSON.stringify(payload));
}

function devLog(...args) {
  if (process.env.NODE_ENV !== "production" && !ENABLE_PROD_LOGS) {
    console.log(new Date().toISOString(), ...args);
  }
}

const client = new WebTorrent();

client.on("error", (err) => {
  prodLog("error", "WebTorrent client error", { error: err.message });
});

client.on("torrent", (torrent) => {
  prodLog("info", "Torrent added", { name: torrent.name });
});

const activeTorrents = new Map();
const activeConnections = new Map();

const CONFIG = {
  MAX_TORRENTS: parseInt(process.env.MAX_TORRENTS || "20", 10),
  TORRENT_TIMEOUT: parseInt(process.env.TORRENT_TIMEOUT_MS || "600000", 10),
  CLEANUP_INTERVAL: parseInt(process.env.CLEANUP_INTERVAL_MS || "120000", 10),
  FILE_CLEANUP_DELAY: parseInt(process.env.FILE_CLEANUP_DELAY_MS || "30000", 10),
  CHUNK_SIZE: parseInt(process.env.STREAM_CHUNK_SIZE_BYTES || "4194304", 10),
  MAX_STREAM_FILE_SIZE: parseInt(process.env.STREAM_MAX_FILE_SIZE_BYTES || "5368709120", 10),
  TORRENT_START_TIMEOUT_MS: parseInt(process.env.TORRENT_START_TIMEOUT_MS || "30000", 10),
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "10", 10),
};

const downloadsPath = path.join(path.resolve(), "downloads");
const torrentLastAccess = new Map();

validateConfig();

function validateConfig() {
  const errors = [];
  const numericVars = [
    ["MAX_TORRENTS", CONFIG.MAX_TORRENTS],
    ["CHUNK_SIZE", CONFIG.CHUNK_SIZE],
    ["MAX_STREAM_FILE_SIZE", CONFIG.MAX_STREAM_FILE_SIZE],
    ["TORRENT_TIMEOUT_MS", CONFIG.TORRENT_TIMEOUT],
    ["CLEANUP_INTERVAL_MS", CONFIG.CLEANUP_INTERVAL],
    ["FILE_CLEANUP_DELAY_MS", CONFIG.FILE_CLEANUP_DELAY],
  ];
  for (const [name, val] of numericVars) {
    if (isNaN(val) || val <= 0) {
      errors.push(`${name} must be a positive integer (got: ${process.env[name.replace(/_/g, "_")] || "unset"})`);
    }
  }
  if (CONFIG.MAX_TORRENTS < 1) errors.push("MAX_TORRENTS must be at least 1");
  if (CONFIG.CHUNK_SIZE < 1024) errors.push("STREAM_CHUNK_SIZE_BYTES must be at least 1024");
  if (CONFIG.MAX_STREAM_FILE_SIZE < 1024) errors.push("STREAM_MAX_FILE_SIZE_BYTES must be at least 1024");
  if (errors.length > 0) {
    console.error("Config validation failed:");
    errors.forEach((e) => console.error(" -", e));
    process.exit(1);
  }
  devLog("[config] validated", CONFIG);
}

const rateLimitMap = new Map();

function rateLimit(ip, maxRequests, windowMs) {
  const now = Date.now();
  const key = ip;
  const record = rateLimitMap.get(key);
  if (!record || now - record.windowStart > windowMs) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: maxRequests - 1 };
  }
  if (record.count >= maxRequests) {
    const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }
  record.count++;
  return { allowed: true, remaining: maxRequests - record.count };
}

function generateRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

function attachRequestId(req, res, next) {
  req.requestId = generateRequestId();
  res.setHeader("X-Request-ID", req.requestId);
  next();
}

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

function removeTorrent(magnetLink) {
  const torrent = activeTorrents.get(magnetLink);
  if (!torrent) return;
  prodLog("info", "Removing inactive torrent", {
    torrent: torrent.name || "unnamed",
    magnetLink,
  });
  client.remove(torrent, { destroyStore: true }, (err) => {
    if (err) devLog("[torrent] error removing:", err.message);
  });
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
  activeConnections.forEach((connInfo, connId) => {
    if (connInfo.magnetLink === magnetLink) {
      activeConnections.delete(connId);
    }
  });
}

function cleanupOrphanedFiles() {
  try {
    if (!fs.existsSync(downloadsPath)) return;
    const activeTorrentNames = new Set();
    activeTorrents.forEach((t) => {
      if (t.name) activeTorrentNames.add(t.name);
    });
    const files = fs.readdirSync(downloadsPath);
    for (const file of files) {
      if (!activeTorrentNames.has(file)) {
        const filePath = path.join(downloadsPath, file);
        try {
          fs.rmSync(filePath, { recursive: true, force: true });
          prodLog("info", "Removed orphaned entry", { path: filePath });
        } catch (e) {
          devLog("[cleanup] error removing", filePath, e.message);
        }
      }
    }
  } catch (err) {
    devLog("[cleanup] error:", err.message);
  }
}

function resolveTorrent(magnetLink) {
  return new Promise((resolve, reject) => {
    const existing = activeTorrents.get(magnetLink);
    if (existing && existing.ready) {
      return resolve(existing);
    }
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
    timeoutId = setTimeout(() => {
      if (activeTorrents.has(magnetLink)) removeTorrent(magnetLink);
      settle(reject, new Error("Torrent download timeout"));
    }, CONFIG.TORRENT_START_TIMEOUT_MS);
  });
}

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

export async function streamTorrentController(req, res) {
  const { requestId } = req;
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const magnetLink = decodeURIComponent(req.params.magnet || "");
  if (!magnetLink) return res.status(400).json({ error: "Magnet link is required" });

  const rateLimitResult = rateLimit(ip, CONFIG.RATE_LIMIT_MAX_REQUESTS, CONFIG.RATE_LIMIT_WINDOW_MS);
  if (!rateLimitResult.allowed) {
    prodLog("warn", "Rate limit exceeded", { requestId, ip, retryAfter: rateLimitResult.retryAfter });
    res.set("Retry-After", rateLimitResult.retryAfter);
    return res.status(429).json({ error: "Rate limit exceeded", retryAfter: rateLimitResult.retryAfter });
  }

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

  let torrent;
  try {
    torrent = await resolveTorrent(magnetLink);
  } catch (error) {
    prodLog("error", "Failed to add torrent", { requestId, error: error.message, magnetLink });
    return res.status(500).json({ error: "Failed to add torrent" });
  }

  activeTorrents.set(magnetLink, torrent);
  torrentLastAccess.set(magnetLink, Date.now());

  const file = torrent.files.reduce((largest, f) => (f.length > largest.length ? f : largest));
  const fileSize = file.length;
  const extension = path.extname(file.name).toLowerCase();
  const contentType = { ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".webm": "video/webm" }[extension] || "video/mp4";

  prodLog("info", "Streaming torrent file", { requestId, fileName: file.name, size: fileSize, torrentName: torrent.name });

  activeConnections.set(connectionId, { magnetLink, torrentName: torrent.name, startTime: Date.now(), fileName: file.name });

  if (fileSize > CONFIG.MAX_STREAM_FILE_SIZE) {
    prodLog("warn", "Torrent skipped due to size", { requestId, torrentName: torrent.name, fileSize });
    return res.status(413).json({ error: "Torrent file exceeds streaming size limit" });
  }

  const rangeDetails = getByteRange(req.headers.range, fileSize, CONFIG.CHUNK_SIZE);
  if (!rangeDetails) {
    prodLog("warn", "Invalid range for torrent stream", { requestId, torrentName: torrent.name, range: req.headers.range });
    return respondWithUnsatisfiedRange(res, fileSize);
  }

  const { start, end } = rangeDetails;
  const chunkSize = end - start + 1;
  res.writeHead(206, buildStreamHeaders({ start, end, totalSize: fileSize, chunkSize, contentType }));

  const stream = file.createReadStream({ start, end, highWaterMark: CONFIG.CHUNK_SIZE });
  let isClientDisconnected = false;
  let connectionClosed = false;

  const finalizeConnection = (reason) => {
    if (connectionClosed) return;
    connectionClosed = true;
    activeConnections.delete(connectionId);
    if (reason !== "client-disconnect") torrentLastAccess.set(magnetLink, Date.now());
  };

  const destroyStream = () => { if (stream && !stream.destroyed) stream.destroy(); };

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
  const contentType = { ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".webm": "video/webm" }[extension] || "video/mp4";

  res.json({
    name: torrent.name,
    infoHash: torrent.infoHash,
    files: torrent.files.map((f) => ({
      name: f.name,
      length: f.length,
      contentType: getContentType(f.name),
    })),
    largestFile: {
      name: file.name,
      length: file.length,
      contentType,
    },
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

function getContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mp3": "audio/mpeg",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
  };
  return map[ext] || "video/mp4";
}

export function cleanupTorrents() {
  prodLog("info", "Cleaning up all torrents");
  activeTorrents.forEach((_, magnetLink) => removeTorrent(magnetLink));
  try {
    if (fs.existsSync(downloadsPath)) {
      fs.readdirSync(downloadsPath).forEach((file) => {
        const filePath = path.join(downloadsPath, file);
        try {
          fs.rmSync(filePath, { recursive: true, force: true });
        } catch (e) {
          devLog("[cleanup] error removing", filePath, e.message);
        }
      });
    }
  } catch (err) {
    devLog("[cleanup] error:", err.message);
  }
  prodLog("info", "Cleanup complete");
}

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
  const desiredLength = end - start + 1;
  if (desiredLength > safeChunk) end = start + safeChunk - 1;
  return { start, end };
}

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

function hasActiveConnections(magnetLink) {
  for (const info of activeConnections.values()) {
    if (info.magnetLink === magnetLink) return true;
  }
  return false;
}

export { attachRequestId, CONFIG };