#!/usr/bin/env node
// node bin/ui.js [--port 8787] [--offline] [--crawl FILE] [--mapping FILE]
// Opens R1 Workflow Studio (the visual workflow editor) at http://127.0.0.1:8787 : view a converted Cloudpath workflow or build an R1 workflow
// from scratch, configure every step, preview exactly what would change in RUCKUS One, then apply.
// (The desktop app for Mac and Windows is the same thing in a window: see README, "Desktop app".)
const path = require("path");
const { startStudio } = require("../src/studio");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };

startStudio({ root, port: Number(val("port") || 8787), offline: args.includes("--offline"), crawlFile: val("crawl"), mappingFile: val("mapping"), log: (l) => console.error(l), say: (l) => console.log(l) })
  .then((s) => {
    if (s.problem) console.error("No RUCKUS One connection: " + s.problem + "\nStarting offline: use Connections in the studio to add one.");
    console.log(`R1 Workflow Studio: ${s.url}`);
    console.log(s.client ? "Connected to RUCKUS One (reads now; writes only after you preview and apply)." : "Offline: no RUCKUS One connection.");
    console.log(s.crawlWorkflows ? `Cloudpath workflows loaded from the crawl (${s.crawlWorkflows}).` : "No Cloudpath crawl found: starting from a blank workflow.");
  })
  .catch((e) => { console.error(e.message); process.exit(1); });
