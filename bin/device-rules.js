#!/usr/bin/env node
// node bin/device-rules.js [crawl.json] [--out FILE]
// Finds the rules in a Cloudpath crawl that look at the visitor's device (operating system, user agent, DHCP device summary, anything else with
// device, OS, agent, vendor or model in its name), groups identical rules, shows which workflows use them, and says what R1's logical split
// could do with each (using what was confirmed on real devices: macOS, iOS, Desktop, Mobile, Safari).
const fs = require("fs");
const path = require("path");
const { regexToComparison } = require("../src/model");

const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out") || path.join(__dirname, "..", "data", "crawl.json");
const crawl = JSON.parse(fs.readFileSync(file, "utf8"));

const R1 = { operatingSystem: "CP_DEVICE_OS", userAgent: "CP_BROWSER_NAME (or CP_DEVICE_TYPE)", language: "CP_LANGUAGE" };
const DEVICE = /device|os$|operatingsystem|agent|vendor|model|browser|dhcp/i;
const opText = (v) => (v && typeof v === "object" ? v.text || v.value : v) || "";

const rules = [];     // { name, operator, regex, workflow, where }
function scan(fields, workflow, where) {
  for (const [k, v] of Object.entries(fields || {})) {
    const m = k.match(/^workflowFilter\.(\w+?)Regex$/);
    if (!m || v == null || typeof v === "object" || String(v).trim() === "") continue;
    rules.push({ name: m[1], operator: String(opText((fields || {})[`workflowFilter.${m[1]}RegexOperator`]) || "Matches"), regex: String(v), workflow, where });
  }
}
const tips = [];      // the option tooltips that describe a restriction, in Cloudpath's own words (a second source, in case a rule isn't in a form field)
function walk(steps, workflow, trail) {
  for (const s of steps || []) {
    const where = [...trail, s.kind + (s.fields && s.fields.name ? " “" + String(s.fields.name).slice(0, 40) + "”" : "")].join(" › ");
    scan(s.fields, workflow, where);
    for (const o of s.options || []) { const tip = String(o.criteria || "").replace(/\s+/g, " ").trim(); if (tip && !/available to all enrollments/i.test(tip)) tips.push({ text: tip, workflow, where: where + " › option “" + o.name + "”" });
      scan(o.fields, workflow, where + " › option “" + o.name + "”"); walk(o.steps, workflow, [...trail, "option “" + o.name + "”"]); }
  }
}
for (const w of crawl.workflows) walk(w.steps, w.name, []);

const byName = new Map();
for (const r of rules) byName.set(r.name, (byName.get(r.name) || 0) + 1);
const lines = [];
const say = (s = "") => lines.push(s);
say(`# Device rules in ${crawl.source || file}`);
say(`${crawl.workflows.length} workflows read${crawl.listed && crawl.listed > crawl.workflows.length ? " of " + crawl.listed + " listed" : ""}; ${rules.length} rules with a pattern, on ${new Set(rules.map((r) => r.workflow)).size} workflows.`);
say(); say("## Every kind of rule found (how many times)");
for (const [n, c] of [...byName].sort((a, b) => b[1] - a[1])) say(`- ${n}: ${c}${DEVICE.test(n) ? "   ← about the device" : ""}`);

const dev = rules.filter((r) => DEVICE.test(r.name));
say(); say(`## Rules about the device (${dev.length})`);
if (!dev.length) say("None.");
const groups = new Map();
for (const r of dev) { const k = [r.name, r.operator, r.regex].join("\u0001"); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
for (const [k, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  const [name, operator, regex] = k.split("\u0001"), negate = /not/i.test(operator), cmp = regexToComparison(regex, negate);
  const wfs = [...new Set(list.map((r) => r.workflow))];
  say(); say(`### ${name} ${operator.toLowerCase()} \`${regex}\`  ×${list.length}`);
  say(`- R1: ${R1[name] ? R1[name] : "no matching field"}${cmp ? ` → ${cmp.operation} "${cmp.value}"` : ""}${!cmp ? " (the pattern is more than equals / contains / starts with / ends with)" : ""}`);
  say(`- Workflows (${wfs.length}): ${wfs.slice(0, 6).join(", ")}${wfs.length > 6 ? ", …" : ""}`);
  say(`- First place: ${list[0].workflow} › ${list[0].where}`);
}

const devTips = tips.filter((x) => /operating system|user agent|device|dhcp|browser|\bos\b/i.test(x.text));
say(); say(`## Option descriptions that mention the device (${devTips.length} of ${tips.length} restricted options)`);
const tg = new Map(); for (const x of devTips) (tg.get(x.text) || tg.set(x.text, []).get(tg.get(x.text) ? x.text : x.text)).push(x);
for (const [text, list] of [...tg].sort((a, b) => b[1].length - a[1].length).slice(0, 40)) say(`- ×${list.length} “${text.slice(0, 220)}” (${[...new Set(list.map((x) => x.workflow))].slice(0, 4).join(", ")})`);
if (!devTips.length) say("None.");

// the device names people actually wrote, to know what values to test in R1
const words = new Map();
for (const r of dev) for (const w of r.regex.match(/[A-Za-z][A-Za-z0-9 ._-]{1,30}/g) || []) { const t = w.trim(); if (t.length > 1) words.set(t, (words.get(t) || 0) + 1); }
say(); say("## Words used in those patterns");
say([...words].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w, c]) => `${w} (${c})`).join(", ") || "none");
const text = lines.join("\n") + "\n";
if (out) { fs.writeFileSync(out, text); console.log("Wrote " + out); } else process.stdout.write(text);
