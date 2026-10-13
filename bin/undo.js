#!/usr/bin/env node
// node bin/undo.js [--yes]
// Deletes the objects listed in data/created.json (what the last `bin/build.js --apply` created), newest first.
// Without --yes it only lists them.
const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", "data", "created.json");
if (!fs.existsSync(file)) { console.log("Nothing to undo (no data/created.json)."); process.exit(0); }
const { created, at } = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(`Created ${at}:`);
for (const x of [...created].reverse()) console.log(`  ${x.kind}: ${x.name} (${x.id})`);
if (!process.argv.includes("--yes")) { console.log("\nRun with --yes to delete these from RUCKUS One."); process.exit(0); }
(async () => {
  const r1 = require("../src/r1").client();
  const left = [];
  for (const x of [...created].reverse().sort((a, b) => (b.kind === "workflow") - (a.kind === "workflow"))) {   // workflows first: actions in use can't be deleted
    try {
      await r1.call("DELETE", x.del); console.log("deleted " + x.kind + " " + x.name);
      for (let i = 0; i < 30; i++) {                                    // R1 deletes in the background: wait until it is really gone
        try { await r1.get(x.del); } catch (e) { if (e.status === 404) break; break; }   // (other errors: nothing more to wait for)
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    catch (e) { console.log("could not delete " + x.kind + " " + x.name + ": " + e.message); left.push(x); }
  }
  if (left.length) fs.writeFileSync(file, JSON.stringify({ at, created: left }, null, 2), { mode: 0o600 });
  else fs.unlinkSync(file);
})();
