/**
 * StreamTorrent API — Express Application
 *
 * Mounts the API routes and middleware. CORS is enabled so the API can be
 * called from browser-based frontends on any origin.
 */

import express from "express";
import cors from "cors";
import videoStreamingRoutes from "./routes/videoStreaming.js";
import pingRoutes from "./routes/ping.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", videoStreamingRoutes);
app.use("/api", pingRoutes);

export default app;