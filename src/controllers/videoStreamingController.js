import fs from "fs";
import path from "path";
import { getVideoFileInfo } from "../services/videoStreamingService.js";
import WebTorrent from "webtorrent";

// Initialize WebTorrent client
const client = new WebTorrent();

// Track active torrents to avoid duplicates and manage resources
const activeTorrents = new Map();

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
    };
    res.writeHead(206, headers);
    const videoStream = fs.createReadStream(videoPath, { start, end });
    videoStream.pipe(res);
  } catch (err) {
    console.error(`Video streaming error: ${err.message}`);
    res.status(404).json({ error: err.message });
  }
}

export async function streamTorrentController(req, res) {
  try {
    const magnetLink = decodeURIComponent(req.params.magnet || "");

    if (!magnetLink) {
      return res.status(400).json({ error: "Magnet link is required" });
    }

    // Check if we're already downloading this torrent
    let torrent = activeTorrents.get(magnetLink);

    if (!torrent) {
      console.log("Starting new torrent download...");

      // Create a new promise to handle the torrent adding process
      const torrentPromise = new Promise((resolve, reject) => {
        client.add(magnetLink, { announce: [] }, (torrent) => {
          console.log(`Torrent added: ${torrent.name}`);
          resolve(torrent);
        });

        // Timeout after 30 seconds if torrent doesn't start
        setTimeout(() => reject(new Error("Torrent download timeout")), 30000);
      });

      try {
        torrent = await torrentPromise;
        activeTorrents.set(magnetLink, torrent);
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
      });

      // Create stream for the specified range
      stream = file.createReadStream({ start, end });
    } else {
      // Send entire file if no range is specified
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
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
    });

    // Handle client disconnection
    req.on("close", () => {
      isClientDisconnected = true;
      console.log("Client disconnected, cleaning up stream");
      if (!stream.destroyed) {
        stream.destroy();
      }
    });

    // Handle response completion
    res.on("finish", () => {
      console.log("Stream completed successfully");
    });

    // Pipe the stream to response but catch any errors
    stream.pipe(res).on("error", (err) => {
      console.error(`Pipe error: ${err.message}`);
      // Stream will be destroyed in the 'error' handler above
    });
  } catch (err) {
    console.error(`Torrent streaming error: ${err.message}`);
    // Only send response if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}
