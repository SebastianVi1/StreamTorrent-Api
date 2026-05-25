import { Router } from "express";
import { getStatus, attachRequestId } from "../controllers/videoStreamingController.js";
import { ping } from "../controllers/pingController.js";

const router = Router();

router.use(attachRequestId);

router.get("/ping", ping);
router.get("/status", getStatus);

export default router;