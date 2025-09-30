// express app from ./app
import app from "./app.js";
import path from "path";

const port = 3000;


app.listen(port, () => {
  const videosPath = path.join(path.resolve(), "src", "public", "videos");
  console.log(`Server running on http://localhost:${port}`);
});
