import { Router } from "express";

const router = Router();
import { ping, getStatus } from "../controllers/pingController.js";

router.get("/ping", ping);
router.get("/status", getStatus);

export default router;
