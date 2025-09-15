// express app from ./app
import app from "./app.js";

const port = 3000;

app.listen(port, (err) => {
  console.log("server running on localhost:3000");
});
