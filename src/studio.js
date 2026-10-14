// Starts R1 Workflow Studio: the local server, the Cloudpath crawl and RUCKUS One connection it begins with. Used by `node bin/ui.js` and by the
// desktop app (electron/main.js), so both behave the same.
//   root      where the program's own files are (ui/, crawl/, src/)
//   dataRoot  where it keeps what you create (a data/ folder: crawls, saved connections, drafts, the undo log). The desktop app uses its own app-data folder.
const fs = require("fs");
const path = require("path");
const net = require("net");
const { createUiServer } = require("./ui-server");
const connections = require("./connections");
const crawlsMod = require("./crawls");

const readJson = (f) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; } catch { return null; } };

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function listen(server, port) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server.address().port); }); });
}

async function startStudio({ root, dataRoot = root, port = 8787, offline = false, crawlFile, mappingFile, log = () => {}, say = () => {}, makeClient, cloudpathFetch } = {}) {
  const n = crawlsMod.redactSaved(dataRoot); if (n) say(`Removed secrets (shared passphrases, API keys, default passwords) from ${n} saved crawl file(s).`);
  const crawl = (() => { const j = readJson(crawlFile || path.join(dataRoot, "data", "crawl.json")); return j ? crawlsMod.redact(j).crawl : null; })();
  const mapping = readJson(mappingFile || path.join(dataRoot, "data", "mapping.json")) || {};
  for (const g of Object.keys(mapping)) for (const k of Object.keys(mapping[g])) if (!mapping[g][k]) delete mapping[g][k];
  // The connection to start with: offline, else the one last used in the Connections dialog, else the default (environment or Visitor Desk config).
  let client = null, connection = "offline", problem = "";
  if (!offline) {
    try { const c = connections.initial(dataRoot, makeClient); client = c.client; connection = c.label; }
    catch (e) { problem = e.message; }
  }
  const server = createUiServer({ client, connection, crawl, mapping, root, dataRoot, log, ...(makeClient ? { makeClient } : {}), ...(cloudpathFetch ? { cloudpathFetch } : {}) });
  let actual;
  try { actual = await listen(server, port); }
  catch (e) { if (e && e.code === "EADDRINUSE" && port !== 0) actual = await listen(server, await freePort()); else throw e; }     // the preferred port is busy: any free one
  return { server, port: actual, url: `http://127.0.0.1:${actual}`, client: !!client, connection, problem, crawlWorkflows: crawl ? crawl.workflows.length : 0,
    close: () => new Promise((r) => server.close(() => r())) };
}

module.exports = { startStudio };
