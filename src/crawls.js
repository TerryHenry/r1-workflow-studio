// Saved Cloudpath crawls (data/crawls/*.json) and the active one (data/crawl.json, which the command-line tools also read).
// A crawl is whatever crawl/crawl.browser.js read from the Cloudpath instance and user you were signed in as; it holds no passwords.
const fs = require("fs");
const path = require("path");

const FILE = /^[\w.-]{1,90}\.json$/;
const bad = (message) => { const e = new Error(message); e.status = 400; return e; };

function validateCrawl(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) throw bad("That isn't a Cloudpath crawl (not a JSON object).");
  if (!Array.isArray(j.workflows)) throw bad("That isn't a Cloudpath crawl: it has no list of workflows.");
  if (j.workflows.length > 300) throw bad("That crawl has more than 300 workflows.");
  for (const w of j.workflows) if (!w || typeof w.name !== "string" || !Array.isArray(w.steps || [])) throw bad("That crawl has a workflow without a name or steps.");
  return j;
}

const dirOf = (root) => path.join(root, "data", "crawls");
const activeFile = (root) => path.join(root, "data", "crawl.json");
const same = (a, b) => a && b && (a.source || "") === (b.source || "") && (a.crawledAt || "") === (b.crawledAt || "") && a.workflows.length === b.workflows.length;
const brief = (j, file) => ({ file: file || null, source: String(j.source || ""), crawledAt: String(j.crawledAt || ""), cloudpathVersion: String(j.cloudpathVersion || ""), workflows: j.workflows.length });

function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function write(file, j) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(j, null, 2), { mode: 0o600 }); }

function listSaved(root) {
  let names = []; try { names = fs.readdirSync(dirOf(root)).filter((f) => FILE.test(f)); } catch {}
  return names.map((f) => { const j = read(path.join(dirOf(root), f)); return j && Array.isArray(j.workflows) ? brief(j, f) : null; }).filter(Boolean)
    .sort((a, b) => String(b.crawledAt).localeCompare(String(a.crawledAt)));
}

// Save a crawl under a readable name ("cloudpath-lab.example.com_2026-10-13.json"); the same crawl is not saved twice. Returns the file name.
function saveCrawl(root, j) {
  validateCrawl(j);
  for (const s of listSaved(root)) { const o = read(path.join(dirOf(root), s.file)); if (same(o, j)) return s.file; }
  let host = "cloudpath"; try { host = new URL(j.source).hostname || host; } catch {}
  const day = (String(j.crawledAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10)).replace(/[^\d-]/g, "");
  const base = (host.replace(/[^\w.-]/g, "_").slice(0, 60) + "_" + day);
  let name = base + ".json", n = 2;
  while (fs.existsSync(path.join(dirOf(root), name))) name = base + "_" + n++ + ".json";
  write(path.join(dirOf(root), name), j);
  return name;
}

// Make a crawl the active one. What was active is kept in the saved list first, so nothing is lost.
function activate(root, j) {
  validateCrawl(j);
  const cur = read(activeFile(root));
  if (cur && Array.isArray(cur.workflows)) saveCrawl(root, cur);
  const file = saveCrawl(root, j);
  write(activeFile(root), j);
  return file;
}

function loadSaved(root, file) {
  if (!FILE.test(String(file || ""))) throw bad("Bad file name.");
  const j = read(path.join(dirOf(root), file));
  if (!j) { const e = new Error("That saved crawl isn't there any more."); e.status = 404; throw e; }
  return validateCrawl(j);
}
function deleteSaved(root, file) {
  if (!FILE.test(String(file || ""))) throw bad("Bad file name.");
  fs.rmSync(path.join(dirOf(root), file), { force: true });
}
// Which saved file (if any) is the active crawl.
function activeInfo(root, j) { if (!j) return null; const s = listSaved(root).find((x) => { const o = read(path.join(dirOf(root), x.file)); return same(o, j); }); return brief(j, s ? s.file : null); }

module.exports = { validateCrawl, listSaved, saveCrawl, activate, loadSaved, deleteSaved, activeInfo };
