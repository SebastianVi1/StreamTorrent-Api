// express app from ./app
import app from "./app.js";
import path from "path";
import fs from "fs";
import { cleanupTorrents } from "./controllers/videoStreamingController.js";

const port = process.env.PORT || 3000;

// Ensure downloads directory exists
const downloadsPath = path.join(path.resolve(), "downloads");
if (!fs.existsSync(downloadsPath)) {
  fs.mkdirSync(downloadsPath, { recursive: true });
}

const server = app.listen(port, () => {
  const videosPath = path.join(path.resolve(), "src", "public", "videos");
  const urls = app.locals.urls || {};
  console.log(`Server running on http://localhost:${port}`);
});

const MEMORY_LOG_INTERVAL = 60 * 1000;

setInterval(() => {
  const usage = process.memoryUsage();
  const heapUsedMb = Math.round(usage.heapUsed / 1024 / 1024);
  const rssMb = Math.round(usage.rss / 1024 / 1024);
  console.log(`Memory usage → heap: ${heapUsedMb}MB | rss: ${rssMb}MB`);

  if (heapUsedMb > 350 && global.gc) {
    console.warn("High heap usage detected, forcing garbage collection");
    global.gc();
  }
}, MEMORY_LOG_INTERVAL);

// Graceful shutdown
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

function gracefulShutdown() {
  console.log("Received shutdown signal, cleaning up resources...");

  // Clean up torrents first
  cleanupTorrents();

  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });

  // Force close after 10s if graceful shutdown fails
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}
