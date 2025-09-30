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

  // Determine content type based on file extension
  const extension = path.extname(fileName).toLowerCase();
  let contentType = "video/mp4"; // default

  // Detect if this is an audio file
  if ([".mp3", ".aac", ".wav", ".ogg", ".flac"].includes(extension)) {
    contentType = {
      ".mp3": "audio/mpeg",
      ".aac": "audio/aac",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
    }[extension];
    console.log(`Detected audio file: ${fileName} (${contentType})`);
  } else if ([".mkv", ".avi", ".webm", ".mp4", ".m4v"].includes(extension)) {
    contentType =
      {
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".webm": "video/webm",
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
      }[extension] || "video/mp4";
  }

  return { videoPath, stat, contentType };
}
