// Undo: delete from RUCKUS One what this tool created, using the list it keeps (data/created.json). Shared by `node bin/undo.js` and the studio's own Undo button.
// Every entry remembers which connection created it, so an entry is only ever deleted through that same connection.
const fs = require("fs");
const path = require("path");

const file = (root) => path.join(root, "data", "created.json");
function read(root) { try { return JSON.parse(fs.readFileSync(file(root), "utf8")); } catch { return null; } }

// { at, items: [{ kind, name, tenant, canUndo }] } newest first; canUndo is false for entries made through another connection.
function list(root, tenant) {
  const j = read(root); if (!j || !Array.isArray(j.created) || !j.created.length) return { at: null, items: [] };
  return { at: j.at, items: [...j.created].reverse().map((x) => ({ kind: x.kind, name: x.name, tenant: x.tenant || "", canUndo: !x.tenant || x.tenant === tenant })) };
}

// Delete what the given connection created: workflows first (actions in use can't be deleted), and wait until R1 has really removed each one.
async function undo(root, client, tenant, { log = () => {}, waitMs = 1000 } = {}) {
  const j = read(root); if (!j || !j.created) return { deleted: [], left: [] };
  const mine = j.created.filter((x) => !x.tenant || x.tenant === tenant), others = j.created.filter((x) => x.tenant && x.tenant !== tenant);
  const deleted = [], left = [];
  for (const x of [...mine].reverse().sort((a, b) => (b.kind === "workflow") - (a.kind === "workflow"))) {
    try {
      await client.call("DELETE", x.del); log("deleted " + x.kind + " " + x.name); deleted.push({ kind: x.kind, name: x.name });
      for (let i = 0; i < 30; i++) {
        try { await client.get(x.del); } catch (e) { break; }                      // gone (404) or nothing more to wait for
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      }
    } catch (e) { log("could not delete " + x.kind + " " + x.name + ": " + e.message); left.push({ ...x, error: String(e.message).slice(0, 200) }); }
  }
  const keep = [...left.map(({ error, ...x }) => x), ...others];
  if (keep.length) fs.writeFileSync(file(root), JSON.stringify({ at: j.at, created: keep }, null, 2), { mode: 0o600 }); else fs.rmSync(file(root), { force: true });
  return { deleted, left: left.map((x) => ({ kind: x.kind, name: x.name, error: x.error })) };
}

module.exports = { list, undo };
