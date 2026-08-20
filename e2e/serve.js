const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
http
  .createServer((req, res) => {
    const name = req.url === "/" ? "test-page.html" : req.url.split("?")[0];
    const file = path.join(root, "e2e", name);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, {
        "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain",
      });
      res.end(data);
    });
  })
  .listen(8123, "127.0.0.1", () => {
    console.log("test server ready: http://127.0.0.1:8123/test-page.html");
  });
