/**
 * StreamTorrent API — Server Entry Point
 *
 * Starts the Express app, creates the downloads/ directory, and wires up
 * graceful shutdown (SIGTERM/SIGINT) so all active torrents are cleaned up
 * before the process exits.
 */

import app from "./app.js";
import path from "path";
import fs from "fs";
import { cleanupTorrents } from "./controllers/videoStreamingController.js";

const port = process.env.PORT || 3000;

// Ensure the downloads/ directory exists before the WebTorrent client writes to it
const downloadsPath = path.join(path.resolve(), "downloads");
if (!fs.existsSync(downloadsPath)) {
  fs.mkdirSync(downloadsPath, { recursive: true });
}

const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────

/**
 * On SIGTERM or SIGINT:
 *  1. Log the signal
 *  2. Call cleanupTorrents() — removes all active torrents and their on-disk files
 *  3. Close the HTTP server
 *  4. Force exit after 10s if the server hasn't closed cleanly
 */
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

function gracefulShutdown() {
  console.log("Received shutdown signal, cleaning up resources...");
  cleanupTorrents();
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}