#!/usr/bin/env node
// node bin/undo.js [--yes]
// Deletes the objects listed in data/created.json (everything the tool has created in RUCKUS One), newest first. Without --yes it only lists them.
// (The studio has the same thing as its Undo button.)
const path = require("path");
const undo = require("../src/undo");
const root = path.join(__dirname, "..");
const { at, items } = undo.list(root, "");
if (!items.length) { console.log("Nothing to undo (no data/created.json)."); process.exit(0); }
console.log(`Created (latest ${at}):`);
for (const x of items) console.log(`  ${x.kind}: ${x.name}${x.tenant ? "  [connection: " + x.tenant + "]" : ""}`);
if (!process.argv.includes("--yes")) { console.log("\nRun with --yes to delete these from RUCKUS One."); process.exit(0); }
undo.undo(root, require("../src/r1").client(), "", { log: (l) => console.log(l) }).then((r) => { if (r.left.length) process.exitCode = 1; });
