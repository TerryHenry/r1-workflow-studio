// Minimal RUCKUS One client. Login is the same client-credentials call Visitor Desk uses.
// Credentials come from env (R1_REGION, R1_TENANT_ID, R1_CLIENT_ID, R1_CLIENT_SECRET, R1_DELEGATED_TENANT_ID) or from
// the "ruckus" block of a Visitor Desk config.json (default ../visitor-desk/config.json, or R1_CONFIG). They are never printed.
const fs = require("fs");
const path = require("path");

const HOSTS = {
  na: { auth: "https://ruckus.cloud", api: "https://api.ruckus.cloud" },
  eu: { auth: "https://eu.ruckus.cloud", api: "https://api.eu.ruckus.cloud" },
  asia: { auth: "https://asia.ruckus.cloud", api: "https://api.asia.ruckus.cloud" },
};

function credentials() {
  const e = process.env;
  if (e.R1_TENANT_ID && e.R1_CLIENT_ID && e.R1_CLIENT_SECRET) {
    return { region: e.R1_REGION || "na", tenantId: e.R1_TENANT_ID, clientId: e.R1_CLIENT_ID, clientSecret: e.R1_CLIENT_SECRET, delegatedTenantId: e.R1_DELEGATED_TENANT_ID || "" };
  }
  const file = e.R1_CONFIG || path.join(__dirname, "..", "..", "visitor-desk", "config.json");
  const r = (JSON.parse(fs.readFileSync(file, "utf8")).ruckus) || {};
  if (!r.tenantId || !r.clientId || !r.clientSecret) throw new Error("No RUCKUS One credentials in " + file);
  return { region: r.region || "na", tenantId: r.tenantId, clientId: r.clientId, clientSecret: r.clientSecret, delegatedTenantId: r.delegatedTenantId || "" };
}

function errorText(j) {
  if (!j) return "";
  if (typeof j.message === "string" && j.message) return j.message;
  const parts = [...(j.error ? [j.error] : []), ...(Array.isArray(j.errors) ? j.errors : [])]
    .map((x) => (typeof x === "string" ? x : x && [...new Set([x.message, x.reason].filter(Boolean))].join(": "))).filter(Boolean);
  return parts.join("; ") || "";
}

// A multipart/form-data body. parts: { name: { json: any } | { file: { filename, type, base64 } } }
function multipart(parts) {
  return { __multipart: true, parts, toJSON() { return { multipart: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.json !== undefined ? v.json : { file: v.file.filename, type: v.file.type, bytes: Math.round((v.file.base64 || "").length * 0.75) }])) }; } };
}
function toFormData(body) {
  const fd = new FormData();
  for (const [name, part] of Object.entries(body.parts)) {
    if (part.json !== undefined) fd.append(name, new Blob([JSON.stringify(part.json)], { type: "application/json" }));
    else fd.append(name, new Blob([Buffer.from(part.file.base64, "base64")], { type: part.file.type || "application/octet-stream" }), part.file.filename || name);
  }
  return fd;
}

function client(creds = credentials()) {
  const host = HOSTS[creds.region];
  if (!host) throw new Error('Unknown region "' + creds.region + '"');
  let token = null, expires = 0;
  async function login() {
    const res = await fetch(host.auth + "/oauth2/token/" + encodeURIComponent(creds.tenantId), {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret }),
    });
    if (!res.ok) throw new Error("RUCKUS One login failed (" + res.status + ")");
    const j = await res.json();
    token = j.access_token || j.token || j.jwt;
    expires = Date.now() + (j.expires_in || 3600) * 1000;
  }
  async function call(method, apiPath, body) {
    if (!token || Date.now() > expires - 60000) await login();
    const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
    if (creds.delegatedTenantId) headers["x-rks-tenantid"] = creds.delegatedTenantId;
    let payload;
    if (body && body.__multipart) payload = toFormData(body);               // the content type (with its boundary) is set by fetch
    else { headers["Content-Type"] = "application/json"; payload = body === undefined ? undefined : JSON.stringify(body); }
    const res = await fetch(host.api + apiPath, { method, headers, body: payload });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) { const detail = errorText(data) || JSON.stringify(data).slice(0, 400);   // unknown error shapes: show the body so the cause is visible
      const err = new Error(method + " " + apiPath.split("?")[0] + " -> " + res.status + (detail && detail !== "{}" ? ": " + detail : "")); err.status = res.status; err.body = data; throw err; }
    return data;
  }
  return { call, get: (p) => call("GET", p), query: (p, body = {}) => call("POST", p, body), region: creds.region };
}

module.exports = { client, credentials, multipart };
