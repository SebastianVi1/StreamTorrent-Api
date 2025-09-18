import express from "express";
import pingRoutes from "./routes/ping.js";
import videoStreamingRoutes from "./routes/videoStreaming.js";
import cors from "cors";


const app = express();

app.use(cors());
app.use(express.json());

// use ping under /api endpoint
app.use("/api", pingRoutes);
// use video streaming under /api
app.use("/api", videoStreamingRoutes);

export default app;
