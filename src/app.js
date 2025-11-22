import express from "express";
import cors from "cors";
import path from "path";
import videoStreamingRoutes from "./routes/videoStreaming.js";
import pingRoutes from "./routes/ping.js";

const app = express();

app.use(cors());
app.use(express.json());

// Expose configured service URLs (read from environment variables)
// These can be set by docker-compose (.env.dev/.env.prod) so the app
// can use different endpoints in dev vs prod.
app.locals.urls = {
  FRONTEND_URL: process.env.FRONTEND_URL || "http://localhost:5173",
  STREAMING_URL: process.env.STREAMING_URL || "http://localhost:3000",
  BACKEND_URL: process.env.BACKEND_URL || "http://localhost:8080",
  TORRENT_API_URL: process.env.TORRENT_API_URL || "http://localhost:8009",
};

// (Optional) make small helper available to request handlers
app.use((req, res, next) => {
  req.urls = app.locals.urls;
  next();
});

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
