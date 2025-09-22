import { json } from "express";

export async function streamVideo(req, res) {
  const range = req.headers.range;
  if (!range) {
    res.status(400).send("REquires Range header");
    return;
  }
}
