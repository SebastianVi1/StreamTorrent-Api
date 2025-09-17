import express from "express";
import pingRoutes from "./routes/ping.js";

const app = express();

app.use(express.json());

// use ping under /api endpoint
app.use("/api", pingRoutes);

export default app;
