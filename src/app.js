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