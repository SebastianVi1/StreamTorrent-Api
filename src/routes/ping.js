import { Router } from "express";

const router = Router();
import { ping } from "../controllers/pingController.js";

router.get("/ping", ping);

export default router;
