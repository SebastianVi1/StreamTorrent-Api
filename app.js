import express from "express";

const app = express();

app.get("/ping", (req, res) => {
  res.send("Ping succesful");
});

export default app;
