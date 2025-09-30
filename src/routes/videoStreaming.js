import { Router } from "express";
import {
  streamVideoController,
  streamTorrentController,
} from "../controllers/videoStreamingController.js";

const router = Router();

// Endpoint: /api/stream/:filename
router.get("/stream/:filename", streamVideoController);

// New endpoint for torrent streaming that matches the frontend URL
router.get("/torrent/:magnet", streamTorrentController);

export default router;
