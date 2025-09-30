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
  console.log(`Server running on http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('Received shutdown signal, cleaning up resources...');
  
  // Clean up torrents first
  cleanupTorrents();
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  // Force close after 10s if graceful shutdown fails
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}
