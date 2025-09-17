export function ping(req, res) {
  res.status(200).json({ message: "ping" });

  res.status(400).json({ error: "Incorrect petition" });
}
