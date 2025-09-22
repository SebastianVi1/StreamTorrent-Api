import express from "express";
import pingRoutes from "./routes/ping.js";
import videoStreamingRoutes from "./routes/videoStreaming.js";
import cors from "cors";
import path from "path";

const app = express();

app.use(cors());
app.use(express.json());

// Fix path to serve static files from src/public directory
app.use(express.static(path.join(path.resolve(), "src", "public")));

// use ping under /api endpoint
app.use("/api", pingRoutes);
// use video streaming under /api
app.use("/api", videoStreamingRoutes);

export default app;
