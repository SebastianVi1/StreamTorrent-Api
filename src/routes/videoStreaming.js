import { Router } from "express";
import { streamVideoController } from "../controllers/videoStreamingController.js";

const router = Router();

// Endpoint: /api/stream/:filename
router.get("/stream/:filename", streamVideoController);

export default router;
