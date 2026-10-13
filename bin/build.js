#!/usr/bin/env node
// node bin/build.js [options]
//   (no options)        dry run: prints every RUCKUS One call it would make; reads your tenant, writes nothing
//   --apply             really create things (asks nothing: read the dry run first)
//   --create-missing    also create DPSK pools, identity groups, MAC registration pools and SSIDs that are not mapped/found
//   --workflow NAME     only this Cloudpath workflow (repeatable); default all
//   --allow-partial     build workflows without their steps that have no R1 equivalent
//   --allow-invalid     build workflows that R1 will mark INVALID (no onboarding action in a branch)
//   --objects-only      create/reuse the pools, templates, SSIDs a workflow needs, but do not build the workflow
//   --prefix TEXT       put TEXT in front of created workflow names (e.g. "CP-")
//   --ca NAME           R1 certificate authority that issues the created certificate templates
//   --venue ID          activate created SSIDs on this venue (all AP groups)
//   --format F          DPSK passphrase format when Cloudpath does not say: numbers | keyboard | secure | words
//   --vlan N            VLAN for created SSIDs
//   --offline           do not contact R1 at all (dry run only)
//   --no-rollback       with --apply, keep what was created if a step fails
//   --crawl FILE --mapping FILE
// Workflows are left unpublished. Existing R1 objects are reused by name and never edited.
const fs = require("fs");
const path = require("path");
const { convertAll } = require("../src/convert");
const { Builder, makeApi } = require("../src/build");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes("--" + n);
const val = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
const all = (n) => args.flatMap((a, i) => (a === "--" + n ? [args[i + 1]] : []));

const crawl = JSON.parse(fs.readFileSync(val("crawl") || path.join(root, "data", "crawl.json"), "utf8"));
const mapFile = val("mapping") || path.join(root, "data", "mapping.json");
const mapping = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};
for (const g of Object.keys(mapping)) for (const k of Object.keys(mapping[g])) if (!mapping[g][k]) delete mapping[g][k];   // empty slots = unmapped
const plan = convertAll(crawl, mapping);

(async () => {
  const apply = flag("apply");
  let client = null;
  if (!flag("offline")) client = require("../src/r1").client();
  const api = makeApi({ client: flag("offline") ? { call: async () => ({}) } : client, apply });
  console.log(apply ? "APPLY: creating objects in RUCKUS One" : "DRY RUN: nothing will be created (add --apply to create)");
  const b = new Builder({ api, crawl, mapping, opts: {
    createMissing: flag("create-missing"), allowPartial: flag("allow-partial"), allowInvalid: flag("allow-invalid"), objectsOnly: flag("objects-only"), prefix: val("prefix") || "", venueId: val("venue"),
    format: val("format"), ca: val("ca"), vlan: val("vlan") ? Number(val("vlan")) : undefined, rollback: !flag("no-rollback") } });
  const r = await b.buildAll(plan, all("workflow"));
  console.log(`\nBuilt ${r.built.length}: ${r.built.join(", ") || "-"}`);
  for (const s of r.skipped) console.log(`Skipped ${s.workflow}: ${s.why}`);
  if (r.reused.length) console.log("Reused existing: " + [...new Set(r.reused)].join(", "));
  for (const n of [...new Set(r.notes)]) console.log("Note: " + n);
  if (apply) {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    require("../src/ledger").appendCreated(root, r.created);
    console.log(`Created ${r.created.length} object(s); listed in data/created.json (node bin/undo.js deletes them).`);
  }
})().catch((e) => { console.error("Error: " + e.message); process.exit(1); });
