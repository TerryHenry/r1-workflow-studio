#!/usr/bin/env node
// node bin/ui.js [--port 8787] [--offline]
// Opens R1 Workflow Studio (the visual workflow editor) at http://127.0.0.1:8787 : view a converted Cloudpath workflow or build an R1 workflow
// from scratch, configure every step, preview exactly what would change in RUCKUS One, then apply.
const fs = require("fs");
const path = require("path");
const { createUiServer } = require("../src/ui-server");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(val("port") || 8787);
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

const crawlsMod = require("../src/crawls");
{ const n = crawlsMod.redactSaved(root); if (n) console.log(`Removed secrets (shared passphrases, API keys, default passwords) from ${n} saved crawl file(s).`); }
const crawl = (() => { const j = read(val("crawl") || path.join(root, "data", "crawl.json")); return j ? crawlsMod.redact(j).crawl : null; })();
const mapping = read(val("mapping") || path.join(root, "data", "mapping.json")) || {};
for (const g of Object.keys(mapping)) for (const k of Object.keys(mapping[g])) if (!mapping[g][k]) delete mapping[g][k];
// The connection to start with: --offline, else the one last used in the Connections dialog, else the default (environment or Visitor Desk config).
let client = null, connection = "offline";
if (!args.includes("--offline")) {
  try { const c = require("../src/connections").initial(root); client = c.client; connection = c.label; }
  catch (e) { console.error("No RUCKUS One connection: " + e.message + "\nStarting offline: use Connections in the editor to add one."); }
}

const server = createUiServer({ client, connection, crawl, mapping, root, log: (l) => console.error(l) });
server.listen(port, "127.0.0.1", () => {
  console.log(`R1 Workflow Studio: http://127.0.0.1:${port}`);
  console.log(client ? "Connected to RUCKUS One (reads now; writes only after you preview and apply)." : "Offline: no RUCKUS One connection.");
  console.log(crawl ? `Cloudpath workflows loaded from the crawl (${crawl.workflows.length}).` : "No Cloudpath crawl found: starting from a blank workflow.");
});
