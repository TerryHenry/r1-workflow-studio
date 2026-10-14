// Local server for the visual workflow editor (ui/index.html). Zero dependencies.
//
// Safety rules, because this can write to a live RUCKUS One tenant:
//  - listens on 127.0.0.1 only, rejects requests whose Host is not localhost, and every POST needs the page's secret token;
//  - /api/preview never writes to R1 (reads only) and returns a fingerprint of exactly what it showed;
//  - /api/apply refuses unless the request matches a preview shown earlier by this server (same workflow, same options),
//    so nothing is created that was not displayed first;
//  - the RUCKUS One credentials stay in this process; the browser only gets names and ids.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { convertAll } = require("./convert");
const { Builder, makeApi } = require("./build");
const { loadInventory } = require("./inventory");
const { ACTIONS, fromPlan, validate, toBuildWorkflow, blankWorkflow, createMissing, TEMPLATE_FIELDS, blankTemplate, validateTemplate, templateRef, GUEST_FIELDS, blankGuestNetwork, validateGuestNetwork, LOOK_COLORS, DEFAULT_LOOK, guestFromPlan, LOGIC_FIELDS, LOGIC_OPS, lookFromCloudpath } = require("./model");
const { importWorkflow, importCertTemplate, importGuestNetwork } = require("./r1import");
const { appendCreated } = require("./ledger");
const { samples } = require("./samples");
const { exportFile, importFile } = require("./exchange");
const coverageMod = require("./coverage");

const NAME = /^[\w .()-]{1,80}$/;

function createUiServer({ client = null, crawl = null, mapping = {}, root = path.join(__dirname, ".."), log = () => {}, pollMs } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const previews = new Map();                                 // hash -> time
  let inv = null;
  const draftsDir = path.join(root, "data", "drafts");
  const getInv = async (force) => (inv && !force ? inv : (inv = await loadInventory(client)));
  const hashOf = (body) => crypto.createHash("sha256").update(JSON.stringify({ w: body.workflow, o: body.options || {} })).digest("hex");
  const opts = (o = {}) => ({ prefix: String(o.prefix || "").slice(0, 20), venueId: o.venueId ? String(o.venueId) : undefined });

  async function cloudpathModels() {
    if (!crawl) return [];
    const i = await getInv();
    const plan = convertAll(crawl, mapping);
    return plan.workflows.map((w) => {
      const model = fromPlan(w, i, crawl.objects);
      const raw = crawl.workflows.find((x) => x.name === w.name), lf = raw && lookFromCloudpath(raw.look, w.name);
      if (lf) { model.look = lf.look; model.source = { ...model.source, lookNotes: lf.notes }; }
      return model;
    });
  }

  // Runs the builder against the model. apply=false: reads from R1, writes nothing.
  async function run(workflow, options, apply) {
    const i = await getInv(apply);
    const o = opts(options);
    const issues = validate(workflow, i, o);
    const res = { issues, calls: [], willCreate: [], reused: [], notes: [], skipped: [], built: [], created: [] };
    if (issues.some((x) => x.level === "error")) return res;
    const lines = [];
    const api = makeApi({ client: client || { call: async () => ({}) }, apply, log: (l) => lines.push(l) });
    const b = new Builder({ api, crawl: { objects: {} }, mapping: {}, opts: { createMissing: true, prefix: o.prefix, venueId: o.venueId, rollback: true, pollMs }, log: (l) => lines.push(l) });
    const bw = toBuildWorkflow(workflow, i);
    try {
      const r = await b.buildAll({ workflows: [bw] }, []);
      Object.assign(res, { built: r.built, skipped: r.skipped, notes: r.notes, created: r.created, reused: r.reused });
    } catch (e) {
      res.error = e.message;
    }
    res.calls = lines; res.willCreate = b.willCreate;
    return res;
  }

  // Same as run(), for a certificate template edited on its own.
  async function runTemplate(template, options, apply) {
    const i = await getInv(apply);
    const o = opts(options);
    const issues = validateTemplate(template, i, o);
    const res = { issues, calls: [], willCreate: [], reused: [], notes: [], skipped: [], built: [], created: [] };
    if (issues.length) return res;
    const lines = [];
    const api = makeApi({ client: client || { call: async () => ({}) }, apply, log: (l) => lines.push(l) });
    const b = new Builder({ api, crawl: { objects: {} }, mapping: {}, opts: { createMissing: true, rollback: true, pollMs }, log: (l) => lines.push(l) });
    try {
      const r = await b.buildTemplate(templateRef(template, o.prefix));
      Object.assign(res, { built: r.built, skipped: r.skipped, notes: r.notes, created: r.created, reused: r.reused });
    } catch (e) { res.error = e.message; }
    res.calls = lines; res.willCreate = b.willCreate;
    return res;
  }
  async function runGuest(guest, options, apply) {
    const i = await getInv(apply);
    const o = opts(options);
    const issues = validateGuestNetwork(guest, i, o);
    const res = { issues, calls: [], willCreate: [], reused: [], notes: [], skipped: [], built: [], created: [] };
    if (issues.length) return res;
    const lines = [];
    const api = makeApi({ client: client || { call: async () => ({}) }, apply, log: (l) => lines.push(l) });
    const b = new Builder({ api, crawl: { objects: {} }, mapping: {}, opts: { createMissing: true, rollback: true, prefix: o.prefix, venueId: o.venueId, pollMs }, log: (l) => lines.push(l) });
    try {
      const r = await b.buildGuestNetwork(guest);
      Object.assign(res, { built: r.built, skipped: r.skipped, notes: r.notes, created: r.created, reused: r.reused });
    } catch (e) { res.error = e.message; }
    res.calls = lines; res.willCreate = b.willCreate;
    return res;
  }
  const needClient = () => { if (!client) throw httpError(409, "Not connected to RUCKUS One (started with --offline)."); };

  const routes = {
    "GET /api/state": async () => ({
      schema: ACTIONS, templateFields: TEMPLATE_FIELDS, blankTemplate: blankTemplate(), guestFields: GUEST_FIELDS, blankGuest: blankGuestNetwork(), lookColors: LOOK_COLORS, defaultLook: DEFAULT_LOOK, logicFields: LOGIC_FIELDS, logicOps: LOGIC_OPS, inventory: await getInv(), live: !!client, hasCloudpath: !!crawl,
      cloudpath: await cloudpathModels(), drafts: listDrafts(), blank: blankWorkflow(), samples: samples(),
    }),
    "POST /api/file/export": async (b) => exportFile(b.model),
    "POST /api/file/import": async (b) => importFile(b.text, String(b.fileName || "").slice(0, 200)),
    "POST /api/refresh": async () => ({ inventory: await getInv(true) }),
    "POST /api/validate": async (b) => ({ issues: validate(b.workflow, await getInv(), opts(b.options)) }),
    "POST /api/import/workflow": async (b) => {
      needClient();
      if (!/^[\w-]{1,64}$/.test(String(b.id || ""))) throw httpError(400, "Bad workflow id.");
      return importWorkflow(client, b.id);
    },
    "POST /api/import/template": async (b) => {
      needClient();
      if (!/^[\w-]{1,64}$/.test(String(b.id || ""))) throw httpError(400, "Bad template id.");
      return importCertTemplate(client, b.id);
    },
    "POST /api/import/guest": async (b) => {
      needClient();
      if (!/^[\w-]{1,64}$/.test(String(b.id || ""))) throw httpError(400, "Bad network id.");
      return importGuestNetwork(client, b.id);
    },
    "POST /api/guest/prefill": async (b) => {
      const w = crawl && (crawl.workflows || []).find((x) => x.name === b.name);
      if (!w) throw httpError(404, "That Cloudpath workflow isn't in the crawl.");
      const r = guestFromPlan(w);
      if (!r) throw httpError(409, "That Cloudpath workflow has no voucher step.");
      return r;
    },
    "POST /api/guest/validate": async (b) => ({ issues: validateGuestNetwork(b.guest, await getInv(), opts(b.options)) }),
    "POST /api/guest/preview": async (b) => {
      const r = await runGuest(b.guest, b.options, false);
      r.hash = hashOf({ workflow: b.guest, options: b.options });
      if (!r.issues.length && !r.error && !r.skipped.length) { previews.set(r.hash, Date.now()); if (previews.size > 50) previews.delete(previews.keys().next().value); }
      return r;
    },
    "POST /api/guest/apply": async (b) => {
      needClient();
      const h = hashOf({ workflow: b.guest, options: b.options });
      if (b.hash !== h || !previews.has(h)) throw httpError(409, "Preview this exact guest network first. It has changed since the last preview, or was never previewed.");
      const r = await runGuest(b.guest, b.options, true);
      previews.delete(h);
      if (r.created && r.created.length) appendCreated(root, r.created);
      await getInv(true);
      return r;
    },
    "POST /api/template/validate": async (b) => ({ issues: validateTemplate(b.template, await getInv(), opts(b.options)) }),
    "POST /api/template/preview": async (b) => {
      const r = await runTemplate(b.template, b.options, false);
      r.hash = hashOf({ workflow: b.template, options: b.options });
      if (!r.issues.length && !r.error && !r.skipped.length) { previews.set(r.hash, Date.now()); if (previews.size > 50) previews.delete(previews.keys().next().value); }
      return r;
    },
    "POST /api/template/apply": async (b) => {
      needClient();
      const h = hashOf({ workflow: b.template, options: b.options });
      if (b.hash !== h || !previews.has(h)) throw httpError(409, "Preview this exact template first. It has changed since the last preview, or was never previewed.");
      const r = await runTemplate(b.template, b.options, true);
      previews.delete(h);
      if (r.created && r.created.length) appendCreated(root, r.created);
      await getInv(true);
      return r;
    },
    "POST /api/fix": async (b) => {
      const wf = JSON.parse(JSON.stringify(b.workflow));
      const changes = createMissing(wf, await getInv(true), Array.isArray(b.nodeIds) ? b.nodeIds : undefined);
      return { workflow: wf, changes };
    },
    "POST /api/preview": async (b) => {
      const r = await run(b.workflow, b.options, false);
      r.hash = hashOf(b);
      if (!r.issues.some((x) => x.level === "error") && !r.error) { previews.set(r.hash, Date.now()); if (previews.size > 50) previews.delete(previews.keys().next().value); }
      return r;
    },
    "POST /api/apply": async (b) => {
      if (!client) throw httpError(409, "Not connected to RUCKUS One (started with --offline).");
      const h = hashOf(b);
      if (b.hash !== h || !previews.has(h)) throw httpError(409, "Preview this exact workflow first. It has changed since the last preview, or was never previewed.");
      const r = await run(b.workflow, b.options, true);
      previews.delete(h);
      if (r.created && r.created.length) appendCreated(root, r.created);
      await getInv(true);
      return r;
    },
    "PUT /api/drafts": async (b) => {
      if (!NAME.test(b.name || "")) throw httpError(400, "Draft names may use letters, numbers, spaces and . ( ) - _ (up to 80).");
      fs.mkdirSync(draftsDir, { recursive: true });
      fs.writeFileSync(path.join(draftsDir, b.name + ".json"), JSON.stringify(b.workflow, null, 2), { mode: 0o600 });
      return { drafts: listDrafts() };
    },
    "POST /api/drafts/load": async (b) => {
      if (!NAME.test(b.name || "")) throw httpError(400, "Bad draft name.");
      return { workflow: JSON.parse(fs.readFileSync(path.join(draftsDir, b.name + ".json"), "utf8")) };
    },
    "POST /api/drafts/delete": async (b) => {
      if (!NAME.test(b.name || "")) throw httpError(400, "Bad draft name.");
      fs.rmSync(path.join(draftsDir, b.name + ".json"), { force: true });
      return { drafts: listDrafts() };
    },
  };
  function listDrafts() { try { return fs.readdirSync(draftsDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { return []; } }
  function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = "application/json") => { res.writeHead(status, { "content-type": type + "; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(type === "application/json" ? JSON.stringify(body) : body); };
    try {
      const host = String(req.headers.host || "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "Local use only." });
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        const sim = fs.readFileSync(path.join(__dirname, "sim.js"), "utf8");
        const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8").replace("__TOKEN__", token).replace("/*__SIM_ENGINE__*/", () => sim);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        return res.end(html);
      }
      if (req.method === "GET" && (url.pathname === "/coverage" || url.pathname === "/coverage.csv")) {
        const data = coverageMod.coverage(crawl, mapping);
        if (url.pathname === "/coverage.csv") { res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="cloudpath-vs-r1.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" }); return res.end(coverageMod.csv(data)); }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        return res.end(coverageMod.html(data, { csvHref: "/coverage.csv" }));
      }
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) return send(404, { error: "Not found" });
      if (req.method !== "GET" && req.headers["x-ui-token"] !== token) return send(403, { error: "Bad token. Reload the page." });
      let body = {};
      if (req.method !== "GET") {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 12e6) throw httpError(413, "Too large"); chunks.push(c); }
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw httpError(400, "Bad JSON"); }
      }
      send(200, await handler(body));
    } catch (e) {
      log("ui error: " + e.message);
      send(e.status || 500, { error: e.message });
    }
  });
  server.token = token;
  return server;
}

module.exports = { createUiServer };
