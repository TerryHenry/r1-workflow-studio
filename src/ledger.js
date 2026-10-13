// data/created.json: everything this tool has created in RUCKUS One, for bin/undo.js. New runs append.
const fs = require("fs");
const path = require("path");

function appendCreated(root, created) {
  const file = path.join(root, "data", "created.json");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).created : [];
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), created: before.concat(created) }, null, 2), { mode: 0o600 });
}

module.exports = { appendCreated };
