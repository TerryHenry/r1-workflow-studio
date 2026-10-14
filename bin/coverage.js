#!/usr/bin/env node
// node bin/coverage.js [--crawl FILE] [--out DIR]
// Writes cloudpath-vs-r1.html and cloudpath-vs-r1.csv: what is in Cloudpath versus RUCKUS One and what can't be converted.
// With a crawl (data/crawl.json) the chart has counts for your Cloudpath; without one it is the general chart.
const fs = require("fs");
const path = require("path");
const { coverage, html, csv } = require("../src/coverage");
const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
const root = path.join(__dirname, "..");
const crawlFile = val("crawl") || path.join(root, "data", "crawl.json");
const crawl = fs.existsSync(crawlFile) ? JSON.parse(fs.readFileSync(crawlFile, "utf8")) : null;
const mappingFile = path.join(root, "data", "mapping.json");
const mapping = fs.existsSync(mappingFile) ? JSON.parse(fs.readFileSync(mappingFile, "utf8")) : {};
const out = val("out") || path.join(root, "data");
fs.mkdirSync(out, { recursive: true });
const data = coverage(crawl, mapping);
const csvText = csv(data);
fs.writeFileSync(path.join(out, "cloudpath-vs-r1.html"), html(data, { csvHref: "data:text/csv;charset=utf-8," + encodeURIComponent(csvText) }));
fs.writeFileSync(path.join(out, "cloudpath-vs-r1.csv"), csvText);
const T = data.totals;
console.log(crawl ? `${T.converts + T.mapping + T.partial + T.none} steps in ${data.workflows.length} workflows: ${T.converts} convert, ${T.mapping} after mapping, ${T.partial} in part, ${T.none} not at all.` : "No crawl found: wrote the general chart.");
console.log("Wrote " + path.join(out, "cloudpath-vs-r1.html") + " and .csv");
