// Saved RUCKUS One connections (data/connections.json, mode 600). A connection is a tenant plus the API client (id and secret) that
// signs in to it. Secrets stay on this computer: the page only ever gets the last four characters of the ids and a "has secret" flag.
const fs = require("fs");
const path = require("path");
const r1 = require("./r1");

const REGIONS = ["na", "eu", "asia"];
const NAME = /^[\w .()-]{1,60}$/;
const DEFAULT = "default";
const bad = (message) => { const e = new Error(message); e.status = 400; return e; };
const file = (root) => path.join(root, "data", "connections.json");

// Secrets at rest: the desktop app gives this module the operating system's own store (macOS Keychain, Windows DPAPI via Electron's safeStorage), so
// client secrets are written encrypted. Without one (the command line) they are written as before, in a file only the owner can read (mode 600).
let vault = null;                     // { seal(text) -> string, open(string) -> text }
function setVault(v) { vault = v || null; }

function openSecret(p) {
  const s = p.clientSecret;
  if (s && typeof s === "object" && typeof s.sealed === "string") {
    try { return { ...p, clientSecret: vault ? vault.open(s.sealed) : "", secretUnreadable: !vault }; } catch { return { ...p, clientSecret: "", secretUnreadable: true }; }
  }
  return p;
}
const sealSecret = (p) => { const { secretUnreadable, ...rest } = p; return vault && rest.clientSecret ? { ...rest, clientSecret: { sealed: vault.seal(rest.clientSecret) } } : rest; };

function load(root) {
  try { const j = JSON.parse(fs.readFileSync(file(root), "utf8")); return { active: j.active || null, profiles: (Array.isArray(j.profiles) ? j.profiles : []).map(openSecret) }; }
  catch { return { active: null, profiles: [] }; }
}
function save(root, store) { fs.mkdirSync(path.dirname(file(root)), { recursive: true }); fs.writeFileSync(file(root), JSON.stringify({ ...store, profiles: store.profiles.map(sealSecret) }, null, 2), { mode: 0o600 }); }

const end = (s) => (s ? "…" + String(s).slice(-4) : "");
const publicView = (p) => ({ name: p.name, region: p.region, tenantEnd: end(p.tenantId), clientEnd: end(p.clientId), delegatedEnd: end(p.delegatedTenantId), hasSecret: !!p.clientSecret, secretUnreadable: !!p.secretUnreadable });

// What the page may know: names and the ends of ids. Never a secret.
function summary(root) {
  const s = load(root);
  let hasDefault = false; try { r1.credentials(); hasDefault = true; } catch {}
  return { active: s.active, profiles: s.profiles.map(publicView), hasDefault, regions: REGIONS };
}

// Validate a profile typed into the form. Blank secret / ids keep the saved ones when editing the profile of the same name.
function cleanProfile(root, p) {
  p = p || {};
  const name = String(p.name || "").trim();
  if (!NAME.test(name) || name.toLowerCase() === DEFAULT || name.toLowerCase() === "offline") throw bad("Give the connection a name (letters, numbers, spaces, . ( ) -), other than “default” or “offline”.");
  const old = load(root).profiles.find((x) => x.name === name) || {};
  const region = String(p.region || old.region || "na");
  if (!REGIONS.includes(region)) throw bad("Region must be one of: " + REGIONS.join(", ") + ".");
  const pick = (k) => String(p[k] || "").trim() || old[k] || "";
  const out = { name, region, tenantId: pick("tenantId"), clientId: pick("clientId"), clientSecret: pick("clientSecret"), delegatedTenantId: p.delegatedTenantId === undefined ? old.delegatedTenantId || "" : String(p.delegatedTenantId).trim() };
  for (const k of ["tenantId", "clientId"]) if (!/^[\w-]{8,80}$/.test(out[k])) throw bad(`${k === "tenantId" ? "Tenant ID" : "Client ID"} is required (letters, numbers and dashes).`);
  if (!out.clientSecret || out.clientSecret.length > 200) throw bad("The client secret is required.");
  if (out.delegatedTenantId && !/^[\w-]{8,80}$/.test(out.delegatedTenantId)) throw bad("The delegated (MSP) tenant ID has odd characters.");
  return out;
}

function upsert(root, profile) {
  const s = load(root);
  const i = s.profiles.findIndex((x) => x.name === profile.name);
  if (i >= 0) s.profiles[i] = profile; else s.profiles.push(profile);
  if (s.profiles.length > 30) throw bad("That's a lot of connections (30 is the limit). Delete some first.");
  save(root, s);
}
function remove(root, name) {
  const s = load(root);
  s.profiles = s.profiles.filter((x) => x.name !== name);
  if (s.active === name) s.active = null;
  save(root, s);
}
function setActive(root, name) { const s = load(root); s.active = name; save(root, s); }

// Credentials for a name: a saved profile, or "default" (the environment / Visitor Desk config, as before).
function credsFor(root, name) {
  if (name === DEFAULT) return r1.credentials();
  const p = load(root).profiles.find((x) => x.name === name);
  if (!p) { const e = new Error("There's no saved connection called “" + name + "”."); e.status = 404; throw e; }
  if (!p.clientSecret) { const e = new Error("The saved secret for “" + name + "” can't be read on this computer (it was saved by another user or computer). Edit the connection and enter the client secret again."); e.status = 409; throw e; }
  return { region: p.region, tenantId: p.tenantId, clientId: p.clientId, clientSecret: p.clientSecret, delegatedTenantId: p.delegatedTenantId || "" };
}

// Sign in and read one thing, to prove the credentials work. Returns { ok, venues } or throws an error with no secrets in it.
async function test(makeClient, creds) {
  const c = makeClient(creds);
  const j = await c.call("POST", "/venues/query", { page: 1, pageSize: 5 });
  const rows = Array.isArray(j) ? j : j.data || j.content || [];
  return { ok: true, venues: rows.length };
}

// The client to start with: the saved active connection, else the default. Returns { client, label } or throws.
function initial(root, makeClient = r1.client) {
  const s = load(root);
  if (s.active === "offline") return { client: null, label: "offline" };
  if (s.active && s.active !== DEFAULT) return { client: makeClient(credsFor(root, s.active)), label: s.active };
  return { client: makeClient(r1.credentials()), label: "default" };
}

module.exports = { setVault, summary, cleanProfile, upsert, remove, setActive, credsFor, test, initial, DEFAULT, REGIONS, load };
