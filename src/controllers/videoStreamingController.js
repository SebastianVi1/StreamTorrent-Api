import fs from "fs";
import path from "path";
import { getVideoFileInfo } from "../services/videoStreamingService.js";

export async function streamVideoController(req, res) {
  try {
    const fileName = req.params.filename;
    console.log(`Requested video: ${fileName}`);

    const { videoPath, stat } = getVideoFileInfo(fileName);
    console.log(`Video found at path: ${videoPath}`);

    const videoSize = stat.size;

    const range = req.headers.range;
    if (!range) {
      // Send full video if no range is specified
      const headers = {
        "Content-Length": videoSize,
        "Content-Type": "video/mp4",
      };
      res.writeHead(200, headers);
      fs.createReadStream(videoPath).pipe(res);
      return;
    }

    const CHUNK_SIZE = 10 ** 6; // 1MB
    const start = Number(range.replace(/\D/g, "")); // Fix regex
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
    console.error(`Video streaming error: ${err.message}`);
    res.status(404).json({ error: err.message });
  }
}
