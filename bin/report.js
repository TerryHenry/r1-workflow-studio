#!/usr/bin/env node
// node bin/report.js [crawl.json] [mapping.json]
// Prints which Cloudpath steps convert to RUCKUS One and writes data/plan.json and data/report.md.
const fs = require("fs");
const path = require("path");
const { convertAll } = require("../src/convert");

const root = path.join(__dirname, "..");
const crawlFile = process.argv[2] || path.join(root, "data", "crawl.json");
const mapFile = process.argv[3] || path.join(root, "data", "mapping.json");
const crawl = JSON.parse(fs.readFileSync(crawlFile, "utf8"));
const mapping = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};
const plan = convertAll(crawl, mapping);

const MARK = { auto: "OK ", mapping: "MAP", manual: "MAN" };
const lines = [];
function show(nodes, indent) {
  for (const n of nodes) {
    const c = n.cloudpath;
    const r1 = n.r1 ? n.r1.actionType : n.end ? "(end)" : "-";
    lines.push(`${indent}[${MARK[n.support]}] ${c.number} ${c.kind}: ${c.name || c.label}  ->  ${r1}`);
    for (const x of n.needs) lines.push(`${indent}      needs ${x.type}: ${x.name}`);
    for (const t of n.notes) lines.push(`${indent}      - ${t}`);
    for (const o of n.options || []) {
      lines.push(`${indent}    option "${o.name}"${o.criteria ? " (" + o.criteria + ")" : ""}`);
      show(o.steps, indent + "        ");
    }
  }
}

lines.push(`# Cloudpath ${plan.cloudpathVersion} (${plan.source}) -> RUCKUS One`, "", "OK = converts as is, MAP = needs a Cloudpath-to-R1 object mapping, MAN = manual work", "");
const summary = [];
for (const w of plan.workflows) {
  lines.push(`## ${w.name}  [${w.status}]  ok ${w.counts.auto}, mapping ${w.counts.mapping}, manual ${w.counts.manual}`);
  show(w.steps, "  ");
  lines.push("");
  summary.push(w);
}
const all = new Map();
for (const w of plan.workflows) for (const x of w.needs) all.set(x.type + "|" + x.name, x);
lines.push("## R1 objects to map (data/mapping.json)", "");
for (const x of all.values()) lines.push(`- ${x.type}: ${x.name}`);

fs.writeFileSync(path.join(root, "data", "plan.json"), JSON.stringify(plan, null, 2));
fs.writeFileSync(path.join(root, "data", "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
