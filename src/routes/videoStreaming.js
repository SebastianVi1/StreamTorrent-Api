import { Router } from "express";
import {
  streamVideoController,
  streamTorrentController,
  torrentInfoController,
  attachRequestId,
} from "../controllers/videoStreamingController.js";

const router = Router();

router.use(attachRequestId);

router.get("/stream/:filename", streamVideoController);
router.get("/torrent/:magnet", streamTorrentController);
router.get("/torrent/:magnet/info", torrentInfoController);

export default router;