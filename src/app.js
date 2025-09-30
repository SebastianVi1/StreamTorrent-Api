import express from "express";
import cors from "cors";
import path from "path";
import videoStreamingRoutes from "./routes/videoStreaming.js";
import pingRoutes from "./routes/ping.js";

const app = express();

app.use(cors());
app.use(express.json());

// Serve static files with caching headers
app.use(
  express.static(path.join(path.resolve(), "src", "public"), {
    maxAge: "1d", // Cache static files for 1 day
    etag: true, // Use ETags for cache validation
  })
);

// Mount API routes
app.use("/api", videoStreamingRoutes);
app.use("/api", pingRoutes);

export default app;
