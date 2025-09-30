import fs from "fs";
import path from "path";
import { getVideoFileInfo } from "../services/videoStreamingService.js";
import WebTorrent from "webtorrent";
import { fileURLToPath } from "url";

// Initialize WebTorrent client
const client = new WebTorrent();

// Track active torrents to avoid duplicates and manage resources
const activeTorrents = new Map();

// Track active streaming connections
const activeConnections = new Map();

// Configuration for resource management
const CONFIG = {
  MAX_TORRENTS: 20,                   // Maximum number of active torrents
  TORRENT_TIMEOUT: 10 * 60 * 1000,    // Remove torrents after 10 minutes of inactivity (reduced from 30)
  CLEANUP_INTERVAL: 2 * 60 * 1000,    // Run cleanup every 2 minutes (reduced from 5)
  FILE_CLEANUP_DELAY: 30 * 1000,      // Wait 30 seconds after stream ends before removing files
};

// Get downloads directory path
const downloadsPath = path.join(path.resolve(), "downloads");

// Track last access time for each torrent
const torrentLastAccess = new Map();

// Setup periodic cleanup for inactive torrents and files
setInterval(() => {
  console.log("Running resource cleanup...");
  const now = Date.now();
  
  // Clean up inactive torrents
  torrentLastAccess.forEach((lastAccess, magnetLink) => {
    if (now - lastAccess > CONFIG.TORRENT_TIMEOUT) {
      removeTorrent(magnetLink);
    }
  });
  
  // Clean up orphaned files in downloads directory
  cleanupOrphanedFiles();
  
  console.log(`Active torrents: ${activeTorrents.size}/${CONFIG.MAX_TORRENTS}`);
  console.log(`Active connections: ${activeConnections.size}`);
}, CONFIG.CLEANUP_INTERVAL);

// Helper function to remove a torrent and clean up resources
function removeTorrent(magnetLink) {
  const torrent = activeTorrents.get(magnetLink);
  if (torrent) {
    console.log(`Removing inactive torrent: ${torrent.name || 'unnamed'}`);
    
    // Remove the torrent
    client.remove(torrent, { destroyStore: true }, (err) => {
      if (err) console.error("Error removing torrent:", err.message);
      
      // Manually remove torrent files to ensure cleanup
      if (torrent.path) {
        try {
          const torrentPath = path.join(downloadsPath, torrent.name);
          if (fs.existsSync(torrentPath)) {
            fs.rmSync(torrentPath, { recursive: true, force: true });
            console.log(`Removed torrent directory: ${torrentPath}`);
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
            console.log(`Removed orphaned file/directory: ${filePath}`);
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
    console.log(`Requested video: ${fileName}`);

    const { videoPath, stat } = getVideoFileInfo(fileName);
    console.log(`Video found at path: ${videoPath}`);

    const videoSize = stat.size;

    const range = req.headers.range;
    if (!range) {
      // Send full video if no range is specified
      const headers = {
        "Content-Length": videoSize,
        "Content-Type": "video/mp4",
        // Prevent caching to ensure fresh content on refresh
        "Cache-Control": "no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      };
      res.writeHead(200, headers);
      fs.createReadStream(videoPath).pipe(res);
      return;
    }

    const CHUNK_SIZE = 10 ** 6; // 1MB
    const start = Number(range.replace(/\D/g, "")); 
    const end = Math.min(start + CHUNK_SIZE, videoSize - 1);
    const contentLength = end - start + 1;

    const headers = {
      "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
      "Content-Type": "video/mp4",
      // Prevent browser from caching chunks for too long
      "Cache-Control": "no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    };
    res.writeHead(206, headers);
    const videoStream = fs.createReadStream(videoPath, { start, end });
    
    // Track stream errors
    videoStream.on("error", (err) => {
      console.error(`Video stream error: ${err.message}`);
      if (!res.writableEnded) {
        res.end();
      }
    });
    
    videoStream.pipe(res);
  } catch (err) {
    console.error(`Video streaming error: ${err.message}`);
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
        removeTorrent(oldestMagnet);
      }
    }

    // Update last access time for this torrent
    torrentLastAccess.set(magnetLink, Date.now());

    // Check if we're already downloading this torrent
    let torrent = activeTorrents.get(magnetLink);

    if (!torrent) {
      console.log("Starting new torrent download...");

      // Create a new promise to handle the torrent adding process
      const torrentPromise = new Promise((resolve, reject) => {
        const addOptions = { 
          announce: [],
          path: downloadsPath // Store downloads in separate directory
        };
        
        client.add(magnetLink, addOptions, (torrent) => {
          console.log(`Torrent added: ${torrent.name}`);
          resolve(torrent);
        });

        // Timeout after 30 seconds if torrent doesn't start
        setTimeout(() => reject(new Error("Torrent download timeout")), 30000);
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
        console.error("Error adding torrent:", error);
        return res.status(500).json({ error: "Failed to add torrent" });
      }
    } else {
      console.log("Using existing torrent download");
    }

    // Find the largest file (likely the video)
    const file = torrent.files.reduce((largest, file) => {
      return file.length > largest.length ? file : largest;
    });

    console.log(`Streaming file: ${file.name} (${file.length} bytes)`);

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

    // Handle range requests for better streaming
    const range = req.headers.range;
    const fileSize = file.length;

    let stream;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
        // Prevent browser from caching chunks
        "Cache-Control": "no-store, must-revalidate", 
        "Pragma": "no-cache",
        "Expires": "0"
      });

      // Create stream for the specified range
      stream = file.createReadStream({ start, end });
    } else {
      // Send entire file if no range is specified
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        // Prevent browser from caching chunks
        "Cache-Control": "no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      });

      stream = file.createReadStream();
    }

    // Handle client disconnect and errors properly
    let isClientDisconnected = false;

    // Handle stream errors
    stream.on("error", (err) => {
      console.error(`Stream error: ${err.message}`);
      // Only attempt to send headers if they haven't been sent and client is still connected
      if (!res.headersSent && !isClientDisconnected) {
        res.status(500).json({ error: "Streaming error occurred" });
      }
      // Destroy the stream to clean up resources
      if (!stream.destroyed) {
        stream.destroy();
      }
      
      // Clean up connection tracking
      activeConnections.delete(connectionId);
    });

    // Handle client disconnection
    req.on("close", () => {
      isClientDisconnected = true;
      console.log("Client disconnected, cleaning up stream");
      
      // Remove from active connections
      activeConnections.delete(connectionId);
      
      // Destroy the stream if it's still active
      if (!stream.destroyed) {
        stream.destroy();
      }
      
      // Check if this was the last connection for this torrent
      let hasOtherConnections = false;
      activeConnections.forEach(info => {
        if (info.magnetLink === magnetLink) {
          hasOtherConnections = true;
        }
      });
      
      // If this was the last connection, schedule torrent for removal after a delay
      if (!hasOtherConnections) {
        console.log(`No more active connections for ${torrent.name}, scheduling removal`);
        setTimeout(() => {
          // Double-check there are still no connections before removing
          let stillHasConnections = false;
          activeConnections.forEach(info => {
            if (info.magnetLink === magnetLink) {
              stillHasConnections = true;
            }
          });
          
          if (!stillHasConnections) {
            console.log(`Removing unused torrent: ${torrent.name}`);
            removeTorrent(magnetLink);
          }
        }, CONFIG.FILE_CLEANUP_DELAY);
      }
    });

    // Handle response completion
    res.on("finish", () => {
      console.log("Stream completed successfully");
      
      // Clean up connection tracking
      activeConnections.delete(connectionId);
      
      // Update last access time
      torrentLastAccess.set(magnetLink, Date.now());
    });

    // Pipe the stream to response but catch any errors
    stream.pipe(res).on("error", (err) => {
      console.error(`Pipe error: ${err.message}`);
      // Clean up connection tracking
      activeConnections.delete(connectionId);
    });
  } catch (err) {
    console.error(`Torrent streaming error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}

// Export function for testing or external cleanup
export function cleanupTorrents() {
  console.log("Cleaning up all torrents and downloads...");
  
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
            console.log(`Removed file during cleanup: ${filePath}`);
          } catch (e) {
            console.error(`Error removing file ${filePath}: ${e.message}`);
          }
        });
      });
    }
  } catch (err) {
    console.error(`Error during downloads cleanup: ${err.message}`);
  }
  
  console.log("All torrents and downloads cleaned up");
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
