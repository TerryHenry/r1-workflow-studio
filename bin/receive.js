#!/usr/bin/env node
// Local receiver for crawl/crawl.browser.js: saves the posted JSON to data/crawl.json and serves the script.
// Listens on 127.0.0.1 only.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const { redact } = require("../src/crawls");
const PORT = Number(process.env.PORT || 8765);
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
};

http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "GET" && req.url === "/crawl.js") {
    res.writeHead(200, { ...cors, "content-type": "text/javascript" });
    return res.end(require("../src/crawlscript").buildBrowserScript(root));
  }
  if (req.method === "POST" && req.url === "/crawl") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const j = redact(JSON.parse(body)).crawl;
        fs.mkdirSync(path.join(root, "data"), { recursive: true });
        fs.writeFileSync(path.join(root, "data", "crawl.json"), JSON.stringify(j, null, 2), { mode: 0o600 });
        console.log("saved data/crawl.json:", j.workflows.length, "workflows from", j.source);
        res.writeHead(200, cors); res.end("ok");
      } catch (e) { res.writeHead(400, cors); res.end(String(e)); }
    });
    return;
  }
  res.writeHead(404, cors); res.end();
}).listen(PORT, "127.0.0.1", () => console.log("waiting on http://127.0.0.1:" + PORT));
