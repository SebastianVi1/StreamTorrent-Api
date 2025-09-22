import fs from "fs";
import path from "path";

// Update path to look in src/public/videos
const projectRoot = path.resolve();

// Fix the path to look in src/public/videos
const videosDir = path.join(projectRoot, "src", "public", "videos");

export function getVideoFileInfo(fileName) {
  console.log(`Looking for video file: ${fileName}`);
  const videoPath = path.join(videosDir, fileName);

  if (!fs.existsSync(videoPath)) {
    console.error(`Error: Video not found at ${videoPath}`);
    throw new Error(`Video not found: ${fileName}`);
  }

  const stat = fs.statSync(videoPath);
  return { videoPath, stat };
}
