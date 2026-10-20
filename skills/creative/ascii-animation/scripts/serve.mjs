// Frame sink + static server for the capture pipeline.
//
//   OUT=/path/to/frames node serve.mjs 9411 /path/to/site-root
//
// The harness page POSTs each frame to /frame?i=N, which lands on disk as
// NNNNN.png. When the page POSTs /done the server drops a `done.flag` next to
// the frames and the capture script kills the browser.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] ?? 9411);
const ROOT = path.resolve(process.argv[3] ?? process.cwd());
const OUT = path.resolve(process.env.OUT ?? path.join(ROOT, "frames"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

let done = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (url.pathname === "/frame") {
        if (done) return res.end("late"); // a reloaded page must not overwrite frames
        const i = Number(url.searchParams.get("i") ?? 0);
        fs.writeFileSync(path.join(OUT, String(i).padStart(5, "0") + ".png"), body);
        return res.end("ok");
      }
      if (url.pathname === "/log") {
        console.log("[page]", body.toString());
        return res.end("ok");
      }
      if (url.pathname === "/done") {
        done = true;
        fs.writeFileSync(path.join(OUT, "..", "done.flag"), "1");
        console.log("DONE");
        return res.end("bye");
      }
      res.end("?");
    });
    return;
  }

  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end("no"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end("not found: " + rel); }
    res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`serving ${ROOT} on ${PORT}, frames -> ${OUT}`));
