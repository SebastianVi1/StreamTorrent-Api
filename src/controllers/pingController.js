import { getStatus } from "./videoStreamingController.js";

export function ping(req, res) {
  res.status(200).json({ message: "API is running" });
}

export { getStatus };
