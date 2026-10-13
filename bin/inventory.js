#!/usr/bin/env node
// node bin/inventory.js
// Reads (GET / query POSTs only) what already exists in the RUCKUS One tenant and writes data/r1-inventory.json.
// Each list is fetched on its own; a failure in one is reported and does not stop the others.
const fs = require("fs");
const path = require("path");
const { client } = require("../src/r1");

const rows = (j) => (Array.isArray(j) ? j : j.data || j.content || j.items || j.results || []);

async function all(fn, pageSize = 100, max = 20) {
  const out = [];
  for (let page = 0; page < max; page++) {
    const r = await fn(page, pageSize);
    const list = rows(r);
    out.push(...list);
    if (list.length < pageSize) break;
  }
  return out;
}

(async () => {
  const r1 = client();
  const inv = { fetchedAt: new Date().toISOString(), region: r1.region, errors: {} };
  const tries = {
    // endpoints below are the ones confirmed live in CLAUDE.md / DwellLink, or taken from the docs.ruckus.cloud specs
    dpskPools: () => all((p, s) => r1.get(`/dpskServices?page=${p}&size=${s}`)),
    identityGroups: () => all((p, s) => r1.get(`/identityGroups?page=${p}&size=${s}`)),
    macRegistrationPools: () => all((p, s) => r1.get(`/macRegistrationPools?page=${p}&size=${s}`)),
    certificateTemplates: () => all((p, s) => r1.query(`/certificateTemplates/query?page=${p}&size=${s}`, {})),
    wifiNetworks: () => all((p, s) => r1.query(`/wifiNetworks/query`, { page: p + 1, pageSize: s })),
    workflows: () => all((p, s) => r1.query(`/workflows/query?page=${p}&size=${s}`, {})),
    workflowActionDefinitions: () => all((p, s) => r1.query(`/workflowActionDefinitions/query?page=${p}&size=${s}`, {})),
    enrollmentActions: () => all((p, s) => r1.query(`/enrollmentActions/query?page=${p}&size=${s}`, {})),
  };
  for (const [name, fn] of Object.entries(tries)) {
    try { inv[name] = await fn(); console.log(name.padEnd(26), inv[name].length); }
    catch (e) { inv.errors[name] = e.message; inv[name] = []; console.log(name.padEnd(26), "ERROR", e.message); }
  }
  fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "data", "r1-inventory.json"), JSON.stringify(inv, null, 2), { mode: 0o600 });
  console.log("saved data/r1-inventory.json");
})().catch((e) => { console.error(e.message); process.exit(1); });
