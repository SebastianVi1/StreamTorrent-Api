import fs from "fs";
import path from "path";

export function getVideoFileInfo(fileName) {
  // Ajusta la ruta según tu estructura real
  const videoPath = path.resolve("videos", fileName);
  if (!fs.existsSync(videoPath)) {
    throw new Error("Video not found");
  }
  const stat = fs.statSync(videoPath);
  return { videoPath, stat };
}
