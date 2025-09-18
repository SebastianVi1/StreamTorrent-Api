import fs from "fs";
import { getVideoFileInfo } from "../services/videoStreamingService.js";

export async function streamVideoController(req, res) {
  try {
    const range = req.headers.range;
    if (!range) {
      res.status(400).send("Requires Range header");
      return;
    }
    const fileName = req.params.filename;
    const { videoPath, stat } = getVideoFileInfo(fileName);
    const videoSize = stat.size;
    const CHUNK_SIZE = 10 ** 6; // 1MB
    const start = Number(range.replace(/bytes=/, "").split("-")[0]);
    const end = Math.min(start + CHUNK_SIZE, videoSize - 1);
    const contentLength = end - start + 1;
    const headers = {
      "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
      "Content-Type": "video/mp4",
    };
    res.writeHead(206, headers);
    const videoStream = fs.createReadStream(videoPath, { start, end });
    videoStream.pipe(res);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}
