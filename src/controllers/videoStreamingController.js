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

// Initialize WebTorrent client
const client = new WebTorrent();

// Track active torrents to avoid duplicates and manage resources
const activeTorrents = new Map();

// Track active streaming connections
const activeConnections = new Map();

// Configuration for resource management
const CONFIG = {
  MAX_TORRENTS: 4,                   // Maximum number of active torrents
  TORRENT_TIMEOUT: 10 * 60 * 1000,    // Remove torrents after 10 minutes of inactivity
  CLEANUP_INTERVAL: 2 * 60 * 1000,    // Run cleanup every 2 minutes (reduced from 5)
  FILE_CLEANUP_DELAY: 30 * 1000,      // Wait 30 seconds after stream ends before removing files
  CHUNK_SIZE: parseInt(process.env.STREAM_CHUNK_SIZE_BYTES || "", 10) || 4 * 1024 * 1024, // Default 4MB chunks
  MAX_STREAM_FILE_SIZE: parseInt(process.env.STREAM_MAX_FILE_SIZE_BYTES || "", 10) || 5 * 1024 * 1024 * 1024 // 5GB limit
};

// Get downloads directory path
const downloadsPath = path.join(path.resolve(), "downloads");

// Track last access time for each torrent
const torrentLastAccess = new Map();

// Setup periodic cleanup for inactive torrents and files
setInterval(() => {
  prodLog("info", "Running periodic resource cleanup", {
    activeTorrents: activeTorrents.size,
    activeConnections: activeConnections.size,
  });
  const now = Date.now();
  
  // Clean up inactive torrents
  torrentLastAccess.forEach((lastAccess, magnetLink) => {
    if (now - lastAccess > CONFIG.TORRENT_TIMEOUT) {
      removeTorrent(magnetLink);
    }
  });
  
  // Clean up orphaned files in downloads directory
  cleanupOrphanedFiles();
}, CONFIG.CLEANUP_INTERVAL);

// Helper function to remove a torrent and clean up resources
function removeTorrent(magnetLink) {
  const torrent = activeTorrents.get(magnetLink);
  if (torrent) {
    prodLog("info", "Removing inactive torrent", {
      torrent: torrent.name || "unnamed",
      reason: "inactive",
    });
    
    // Remove the torrent
    client.remove(torrent, { destroyStore: true }, (err) => {
      if (err) console.error("Error removing torrent:", err.message);
      
      // Manually remove torrent files to ensure cleanup
      if (torrent.path) {
        try {
          const torrentPath = path.join(downloadsPath, torrent.name);
          if (fs.existsSync(torrentPath)) {
            fs.rmSync(torrentPath, { recursive: true, force: true });
            prodLog("info", "Removed torrent directory", { path: torrentPath });
          }
        } catch (e) {
          console.error(`Error removing torrent files: ${e.message}`);
        }
      }
    });
    
    activeTorrents.delete(magnetLink);
    torrentLastAccess.delete(magnetLink);
    
    // Close any active connections for this torrent
    activeConnections.forEach((connectionInfo, connectionId) => {
      if (connectionInfo.magnetLink === magnetLink) {
        // The connection might already be closed, but we clean up the reference
        activeConnections.delete(connectionId);
      }
    });
  }
}

// Clean up orphaned files in the downloads directory
function cleanupOrphanedFiles() {
  try {
    if (!fs.existsSync(downloadsPath)) return;
    
    const activeTorrentNames = new Set();
    activeTorrents.forEach(torrent => {
      if (torrent.name) activeTorrentNames.add(torrent.name);
    });
    
    const files = fs.readdirSync(downloadsPath);
    
    files.forEach(file => {
      if (!activeTorrentNames.has(file)) {
        const filePath = path.join(downloadsPath, file);
        
        try {
          const stats = fs.statSync(filePath);
          // If it's a directory or file that's not being used
          if (stats.isDirectory() || stats.isFile()) {
            fs.rmSync(filePath, { recursive: true, force: true });
            prodLog("info", "Removed orphaned entry", { path: filePath });
          }
        } catch (e) {
          console.error(`Error checking file ${filePath}: ${e.message}`);
        }
      }
    });
  } catch (err) {
    console.error(`Error cleaning orphaned files: ${err.message}`);
  }
}

export async function streamVideoController(req, res) {
  try {
    const fileName = req.params.filename;
    prodLog("info", "Local video requested", { fileName });

    const { videoPath, stat, contentType } = getVideoFileInfo(fileName);
    console.log(`Video found at path: ${videoPath}`);

    const videoSize = stat.size;

    if (videoSize > CONFIG.MAX_STREAM_FILE_SIZE) {
      prodLog("warn", "Local video rejected due to size", {
        fileName,
        videoSize,
      });
      return res.status(413).json({ error: "Requested file exceeds streaming size limit" });
    }

    const rangeDetails = getByteRange(req.headers.range, videoSize, CONFIG.CHUNK_SIZE);

    if (!rangeDetails) {
      prodLog("warn", "Invalid range for local video", { fileName, range: req.headers.range });
      return respondWithUnsatisfiedRange(res, videoSize);
    }

    const { start, end } = rangeDetails;
    const contentLength = end - start + 1;

    res.writeHead(206, buildStreamHeaders({
      start,
      end,
      totalSize: videoSize,
      chunkSize: contentLength,
      contentType,
    }));

    const videoStream = fs.createReadStream(videoPath, {
      start,
      end,
      highWaterMark: CONFIG.CHUNK_SIZE,
    });

    let isClientDisconnected = false;

    req.on("close", () => {
      isClientDisconnected = true;
      if (!videoStream.destroyed) {
        videoStream.destroy();
      }
    });

    pipeline(videoStream, res, (err) => {
      if (err && !isClientDisconnected) {
        prodLog("error", "Video stream pipeline error", {
          fileName,
          error: err.message,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "Streaming error occurred" });
        }
      }
    });
  } catch (err) {
    prodLog("error", "Video streaming error", { error: err.message });
    res.status(404).json({ error: err.message });
  }
}

export async function streamTorrentController(req, res) {
  try {
    const magnetLink = decodeURIComponent(req.params.magnet || "");
    const connectionId = `${req.ip}-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

    if (!magnetLink) {
      return res.status(400).json({ error: "Magnet link is required" });
    }

    prodLog("info", "Torrent stream requested", { magnetLink, connectionId });

    // Check if we've reached the maximum number of active torrents
    if (activeTorrents.size >= CONFIG.MAX_TORRENTS && !activeTorrents.has(magnetLink)) {
      // Find the least recently used torrent to remove
      let oldestAccess = Date.now();
      let oldestMagnet = null;
      
      torrentLastAccess.forEach((time, magnet) => {
        if (time < oldestAccess) {
          oldestAccess = time;
          oldestMagnet = magnet;
        }
      });
      
      if (oldestMagnet) {
        prodLog("warn", "Max torrent limit reached, evicting", { oldestMagnet });
        removeTorrent(oldestMagnet);
      }
    }

    // Update last access time for this torrent
    torrentLastAccess.set(magnetLink, Date.now());

    // Check if we're already downloading this torrent
    let torrent = activeTorrents.get(magnetLink);

    if (!torrent) {
      prodLog("info", "Starting new torrent download", { magnetLink });

      // Create a new promise to handle the torrent adding process
      const torrentPromise = new Promise((resolve, reject) => {
        let timeoutId;
        let settled = false;

        const settle = (handler, value) => {
          if (settled) return;
          settled = true;
          handler(value);
        };

        const addOptions = { 
          path: downloadsPath // Store downloads in separate directory
        };
        
        client.add(magnetLink, addOptions, (torrent) => {
          prodLog("info", "Torrent added", {
            torrentName: torrent.name,
            magnetLink,
          });
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          settle(resolve, torrent);
        });

        // Timeout after 30 seconds if torrent doesn't start
        timeoutId = setTimeout(() => {
          settle(reject, new Error("Torrent download timeout"));
        }, 30000);
      });

      try {
        torrent = await torrentPromise;
        activeTorrents.set(magnetLink, torrent);
        torrentLastAccess.set(magnetLink, Date.now());
        
        // Set up event listeners for better resource management
        torrent.on('error', (err) => {
          console.error(`Torrent error for ${torrent.name}: ${err.message}`);
          removeTorrent(magnetLink);
        });
        
        torrent.on('done', () => {
          console.log(`Torrent completed: ${torrent.name}`);
        });
        
      } catch (error) {
        prodLog("error", "Failed to add torrent", {
          error: error.message,
          magnetLink,
        });
        return res.status(500).json({ error: "Failed to add torrent" });
      }
    } else {
      prodLog("info", "Reusing existing torrent", { magnetLink });
    }

    // Find the largest file (likely the video)
    const file = torrent.files.reduce((largest, file) => {
      return file.length > largest.length ? file : largest;
    });

    prodLog("info", "Streaming torrent file", {
      fileName: file.name,
      size: file.length,
      torrentName: torrent.name,
    });

    // Set appropriate content type based on file extension
    const extension = path.extname(file.name).toLowerCase();
    let contentType = "video/mp4";

    if ([".mkv", ".avi", ".webm"].includes(extension)) {
      contentType = {
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".webm": "video/webm",
      }[extension] || "video/mp4";
    }

    // Store connection info
    activeConnections.set(connectionId, {
      magnetLink,
      torrentName: torrent.name,
      startTime: Date.now(),
      fileName: file.name
    });

    const fileSize = file.length;

    if (fileSize > CONFIG.MAX_STREAM_FILE_SIZE) {
      prodLog("warn", "Torrent skipped due to size", {
        torrentName: torrent.name,
        fileSize,
      });
      return res.status(413).json({ error: "Torrent file exceeds streaming size limit" });
    }

    const rangeDetails = getByteRange(req.headers.range, fileSize, CONFIG.CHUNK_SIZE);

    if (!rangeDetails) {
      prodLog("warn", "Invalid range for torrent stream", {
        torrentName: torrent.name,
        range: req.headers.range,
      });
      return respondWithUnsatisfiedRange(res, fileSize);
    }

    const { start, end } = rangeDetails;
    const chunkSize = end - start + 1;

    res.writeHead(206, buildStreamHeaders({
      start,
      end,
      totalSize: fileSize,
      chunkSize,
      contentType,
    }));

    const stream = file.createReadStream({
      start,
      end,
      highWaterMark: CONFIG.CHUNK_SIZE,
    });

    let isClientDisconnected = false;
    let connectionClosed = false;

    const finalizeConnection = (reason) => {
      if (connectionClosed) return;
      connectionClosed = true;
      activeConnections.delete(connectionId);
      if (reason !== "client-disconnect") {
        torrentLastAccess.set(magnetLink, Date.now());
      }
    };

    const destroyStream = () => {
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
    };

    const scheduleCleanupIfIdle = () => {
      if (hasActiveConnections(magnetLink)) {
        return;
      }
      console.log(`No active connections for ${torrent.name}, scheduling cleanup`);
      setTimeout(() => {
        if (!hasActiveConnections(magnetLink)) {
          console.log(`Removing unused torrent: ${torrent.name}`);
          removeTorrent(magnetLink);
        }
      }, CONFIG.FILE_CLEANUP_DELAY);
    };

    req.on("close", () => {
      if (connectionClosed) {
        return;
      }
      isClientDisconnected = true;
      prodLog("info", "Client disconnected from torrent stream", {
        magnetLink,
        torrentName: torrent.name,
      });
      destroyStream();
      finalizeConnection("client-disconnect");
      scheduleCleanupIfIdle();
    });

    pipeline(stream, res, (err) => {
      if (err && !isClientDisconnected) {
        prodLog("error", "Torrent stream pipeline error", {
          torrentName: torrent.name,
          error: err.message,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "Streaming error occurred" });
        }
      }
      finalizeConnection(isClientDisconnected ? "client-disconnect" : err ? "error" : "completed");
      scheduleCleanupIfIdle();
    });
  } catch (err) {
    prodLog("error", "Torrent streaming error", { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}

// Export function for testing or external cleanup
export function cleanupTorrents() {
  prodLog("info", "Cleaning up all torrents and downloads");
  
  // Remove all active torrents
  activeTorrents.forEach((torrent, magnetLink) => {
    removeTorrent(magnetLink);
  });
  
  // Clean up any remaining files in the downloads directory
  try {
    if (fs.existsSync(downloadsPath)) {
      fs.readdir(downloadsPath, (err, files) => {
        if (err) {
          console.error(`Error reading downloads directory: ${err.message}`);
          return;
        }
        
        files.forEach(file => {
          const filePath = path.join(downloadsPath, file);
          try {
            fs.rmSync(filePath, { recursive: true, force: true });
            prodLog("info", "Removed file during cleanup", { path: filePath });
          } catch (e) {
            console.error(`Error removing file ${filePath}: ${e.message}`);
          }
        });
      });
    }
  } catch (err) {
    console.error(`Error during downloads cleanup: ${err.message}`);
  }
  
  prodLog("info", "Cleanup complete");
}

// Create a ping controller to check active connections and torrents
export function getStatus(req, res) {
  const status = {
    activeTorrents: Array.from(activeTorrents.keys()).map(magnetLink => {
      const torrent = activeTorrents.get(magnetLink);
      return {
        name: torrent.name,
        progress: Math.round(torrent.progress * 100),
        downloadSpeed: torrent.downloadSpeed,
        uploaded: torrent.uploaded,
        downloaded: torrent.downloaded,
        ratio: torrent.ratio,
        timeRemaining: torrent.timeRemaining
      };
    }),
    activeConnections: Array.from(activeConnections.values()).map(conn => {
      return {
        torrentName: conn.torrentName,
        fileName: conn.fileName,
        duration: Date.now() - conn.startTime
      };
    }),
    totalTorrents: activeTorrents.size,
    totalConnections: activeConnections.size
  };
  
  res.json(status);
}

function getByteRange(rangeHeader, fileSize, maxChunkSize) {
  const safeChunk = Math.min(maxChunkSize, fileSize);

  if (fileSize === 0) {
    return { start: 0, end: 0 };
  }

  if (!rangeHeader) {
    return {
      start: 0,
      end: safeChunk - 1,
    };
  }

  const matches = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!matches) {
    return null;
  }

  let start = matches[1] ? parseInt(matches[1], 10) : 0;
  let end = matches[2] ? parseInt(matches[2], 10) : start + safeChunk - 1;

  if (Number.isNaN(start) || start >= fileSize) {
    return null;
  }

  if (Number.isNaN(end) || end >= fileSize) {
    end = Math.min(start + safeChunk - 1, fileSize - 1);
  }

  if (end < start) {
    end = Math.min(start + safeChunk - 1, fileSize - 1);
  }

  const desiredLength = end - start + 1;
  if (desiredLength > safeChunk) {
    end = start + safeChunk - 1;
  }

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
  let result = false;
  activeConnections.forEach(info => {
    if (info.magnetLink === magnetLink) {
      result = true;
    }
  });
  return result;
}
