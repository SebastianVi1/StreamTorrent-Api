import express from "express";
import cors from "cors";
import path from "path";
import videoStreamingRoutes from "./routes/videoStreaming.js";

const app = express();

app.use(cors());
app.use(express.json());

// Fix path to serve static files from src/public directory
app.use(express.static(path.join(path.resolve(), "src", "public")));

// Mount API routes
app.use("/api", videoStreamingRoutes);

export default app;
