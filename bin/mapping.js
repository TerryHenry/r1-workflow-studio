#!/usr/bin/env node
// node bin/mapping.js
// Needs data/plan.json (npm run report) and data/r1-inventory.json (node bin/inventory.js).
// Creates data/mapping.json with one empty slot per Cloudpath object the plan needs (existing choices are kept) and
// data/mapping-choices.md listing the R1 objects that can fill each slot. Only exact (case-insensitive) name matches
// are filled in for you; everything else is your call.
const fs = require("fs");
const path = require("path");

const data = path.join(__dirname, "..", "data");
const plan = JSON.parse(fs.readFileSync(path.join(data, "plan.json"), "utf8"));
const inv = JSON.parse(fs.readFileSync(path.join(data, "r1-inventory.json"), "utf8"));
const mapFile = path.join(data, "mapping.json");
const mapping = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};

const groupOfPool = (poolId) => (inv.identityGroups.find((g) => g.dpskPoolId === poolId) || {}).id || null;
const choices = {
  dpskPools: inv.dpskPools.map((p) => ({ name: p.name, value: { dpskPoolId: p.id, identityGroupId: groupOfPool(p.id) } })),
  macLists: inv.macRegistrationPools.map((p) => ({ name: p.name, value: { macRegListId: p.id, identityGroupId: p.identityGroupId || null } })),
  certTemplates: inv.certificateTemplates.map((t) => ({ name: t.name, value: { certTemplateId: t.id, identityGroupId: null } })),
  networks: inv.wifiNetworks.map((n) => ({ name: n.name + " (" + (n.nwSubType || n.type) + ")", value: { networkId: n.id, identityGroupId: null }, plain: n.name })),
};
const GROUP = { "DPSK pool / identity group": "dpskPools", "MAC registration list / identity group": "macLists", "certificate template": "certTemplates",
  "network": "networks", "network / device configuration": "networks" };

const wanted = {};
const add = (g, name) => { (wanted[g] = wanted[g] || new Set()).add(name); };
for (const w of plan.workflows) for (const n of w.needs) if (GROUP[n.type]) add(GROUP[n.type], n.name);

let filled = 0;
for (const g of Object.keys(GROUP).map((k) => GROUP[k]).filter((v, i, a) => a.indexOf(v) === i)) {
  mapping[g] = mapping[g] || {};
  for (const name of wanted[g] || []) {
    if (mapping[g][name]) continue;
    const hit = choices[g].find((c) => (c.plain || c.name).toLowerCase() === name.toLowerCase());
    mapping[g][name] = hit ? hit.value : null;
    if (hit) filled++;
  }
}
fs.writeFileSync(mapFile, JSON.stringify(mapping, null, 2) + "\n");

const md = ["# R1 objects you can map to", "", "Fill data/mapping.json: replace each `null` with one of the `value` objects below.", ""];
for (const g of Object.keys(choices)) {
  md.push("## " + g, "");
  for (const c of choices[g]) md.push("- " + c.name + ": `" + JSON.stringify(c.value) + "`");
  md.push("");
}
fs.writeFileSync(path.join(data, "mapping-choices.md"), md.join("\n"));

console.log("data/mapping.json: " + Object.values(mapping).reduce((a, g) => a + Object.keys(g).length, 0) + " slots, " + filled + " filled by exact name");
for (const [g, names] of Object.entries(mapping)) for (const [n, v] of Object.entries(names)) console.log("  " + g.padEnd(14) + n.padEnd(40) + (v ? "mapped" : "EMPTY"));
