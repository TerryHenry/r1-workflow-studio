// Local server for R1 Workflow Studio, the visual workflow editor (ui/index.html). Zero dependencies.
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
const { ACTIONS, fromPlan, validate, toBuildWorkflow, blankWorkflow, createMissing, TEMPLATE_FIELDS, blankTemplate, validateTemplate, templateRef, GUEST_FIELDS, blankGuestNetwork, validateGuestNetwork, voucherOnly, LOOK_COLORS, DEFAULT_LOOK, guestFromPlan, LOGIC_FIELDS, LOGIC_OPS, lookFromCloudpath } = require("./model");
const { importWorkflow, importCertTemplate, importGuestNetwork } = require("./r1import");
const { appendCreated } = require("./ledger");
const { samples } = require("./samples");
const { exportFile, importFile } = require("./exchange");
const coverageMod = require("./coverage");
const conns = require("./connections");
const crawls = require("./crawls");
const { buildBrowserScript } = require("./crawlscript");
const { startCrawlJob, publicJob } = require("./crawl-job");
const undoMod = require("./undo");

const NAME = /^[\w .()-]{1,80}$/;

function createUiServer({ client: startClient = null, crawl: startCrawl = null, mapping: startMapping = {}, root = path.join(__dirname, ".."), dataRoot = root, log = () => {}, pollMs, makeClient = require("./r1").client, connection = "", cloudpathFetch = fetch } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  // What the editor is connected to can change while it runs (Connections dialog): the RUCKUS One tenant and the Cloudpath crawl.
  let client = startClient, crawl = startCrawl, mapping = startMapping;
  let connName = connection || (startClient ? "default" : "offline");    // "offline", "default", or a saved connection's name
  let applying = 0, arm = null, crawlStamp = 0, job = null;
  const previews = new Map();                                 // hash -> time
  let inv = null;
  const draftsDir = path.join(dataRoot, "data", "drafts");
  const getInv = async (force) => (inv && !force ? inv : (inv = await loadInventory(client)));
  const hashOf = (body) => crypto.createHash("sha256").update(JSON.stringify({ w: body.workflow, o: body.options || {} })).digest("hex");
  const opts = (o = {}) => ({ prefix: String(o.prefix || "").slice(0, 20), venueId: o.venueId ? String(o.venueId) : undefined });

  async function cloudpathModels() {
    if (!crawl) return [];
    const i = await getInv();
    const plan = convertAll(crawl, mapping);
    const count = (m) => (m.kind === "guestNetwork" ? validateGuestNetwork(m, i, {}) : validate(m, i, {})).filter((x) => x.level === "error").length;
    const withIssues = (list) => list.map((m) => ({ ...m, _issues: count(m) }));
    return withIssues(plan.workflows.flatMap((w) => {
      const raw = crawl.workflows.find((x) => x.name === w.name), lf = raw && lookFromCloudpath(raw.look, w.name);
      const guest = raw && guestFromPlan(raw);
      // A voucher sign-in is a guest pass, which in R1 is a guest network. A workflow that is only that opens as the guest network.
      const asGuest = (extra) => ({ ...guest.guest, _notes: [...extra, ...guest.notes, ...(lf ? ["This Cloudpath workflow had its own look and feel (colours, titles). This tool can't apply a look to a guest network: set the portal title and tag line here."] : [])] });
      if (guest && voucherOnly(raw)) return [asGuest(["Converted automatically: in R1 a voucher sign-in is a guest network, not a workflow. Check the Wi-Fi name, add the terms, then preview and apply."])];
      const model = fromPlan(w, i, crawl.objects);
      if (lf) { model.look = lf.look; model.source = { ...model.source, lookNotes: lf.notes }; }
      model._notes = (model.source && model.source.notes) || [];
      return guest ? [model, asGuest(["Made from the voucher branch of the Cloudpath workflow “" + w.name + "”, which can't be part of an R1 workflow."])] : [model];
    }));
  }

  // Runs the builder against the model. apply=false: reads from R1, writes nothing.
  async function run(workflow, options, apply) {
    if (apply) applying++;
    try { return await run2(workflow, options, apply); } finally { if (apply) applying--; }
  }
  async function run2(workflow, options, apply) {
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

  function setCrawl(j) { crawls.validateCrawl(j); j = crawls.redact(j).crawl; if (crawl) crawls.saveCrawl(dataRoot, crawl); crawls.activate(dataRoot, j); crawl = j; crawlStamp++; }   // what was loaded is kept before it is replaced
  function connectionsState() {
    const s = conns.summary(dataRoot);
    return {
      r1: { name: connName, live: !!client, hasDefault: s.hasDefault, profiles: s.profiles, regions: s.regions },
      cloudpath: { active: crawls.activeInfo(dataRoot, crawl), saved: crawls.listSaved(dataRoot), armed: !!(arm && arm.until > Date.now()), stamp: crawlStamp, job: publicJob(job) },
    };
  }

  const routes = {
    "GET /api/state": async () => ({
      schema: ACTIONS, templateFields: TEMPLATE_FIELDS, blankTemplate: blankTemplate(), guestFields: GUEST_FIELDS, blankGuest: blankGuestNetwork(), lookColors: LOOK_COLORS, defaultLook: DEFAULT_LOOK, logicFields: LOGIC_FIELDS, logicOps: LOGIC_OPS, inventory: await getInv(), live: !!client, hasCloudpath: !!crawl,
      cloudpath: await cloudpathModels(), connection: { live: !!client, name: connName }, cloudpathInfo: crawls.activeInfo(dataRoot, crawl), drafts: listDrafts(), blank: blankWorkflow(), samples: samples(),
    }),
    "GET /api/connections": async () => connectionsState(),
    "PUT /api/connections/r1": async (b) => { conns.upsert(dataRoot, conns.cleanProfile(dataRoot, b.profile)); return connectionsState(); },
    "POST /api/connections/r1/delete": async (b) => {
      const name = String(b.name || "");
      if (name === connName) throw httpError(409, "That's the connection in use. Switch to another one first.");
      conns.remove(dataRoot, name); return connectionsState();
    },
    "POST /api/connections/r1/test": async (b) => {
      const creds = b.profile ? (({ name, ...p }) => p)(conns.cleanProfile(dataRoot, { ...b.profile, name: String(b.profile.name || "test connection") })) : conns.credsFor(dataRoot, String(b.name || ""));
      try { return await conns.test(makeClient, creds); } catch (e) { throw httpError(400, "Could not sign in: " + e.message); }
    },
    "POST /api/connections/r1/use": async (b) => {
      const name = String(b.name || "");
      if (applying) throw httpError(409, "An apply is running. Wait for it to finish.");
      if (name === "offline") { client = null; connName = "offline"; conns.setActive(dataRoot, "offline"); }
      else {
        let c;
        try { const creds = conns.credsFor(dataRoot, name); c = makeClient(creds); await conns.test(() => c, creds); }
        catch (e) { throw httpError(e.status || 400, "Could not connect: " + e.message); }
        client = c; connName = name;
        conns.setActive(dataRoot, name);
      }
      inv = null; previews.clear(); mapping = {};                     // nothing previewed against another tenant can be applied here
      log("connected to: " + connName);
      return connectionsState();
    },
    "POST /api/connections/cloudpath/use": async (b) => { setCrawl(crawls.loadSaved(dataRoot, String(b.file || ""))); return connectionsState(); },
    "POST /api/connections/cloudpath/load": async (b) => {
      let j; try { j = JSON.parse(String(b.text || "")); } catch { throw httpError(400, "That isn't a crawl file: it isn't valid JSON."); }
      setCrawl(j); return connectionsState();
    },
    "POST /api/connections/cloudpath/delete": async (b) => { crawls.deleteSaved(dataRoot, String(b.file || "")); return connectionsState(); },
    // The editor signs in to Cloudpath itself (address, email, password typed in the editor), reads, and signs out. The password is never stored.
    "POST /api/connections/cloudpath/crawl": async (b) => {
      if (job && (job.state === "starting" || job.state === "running")) throw httpError(409, "A Cloudpath read is already running.");
      const limit = Math.max(0, Math.min(5000, parseInt(b.limit, 10) || 0));
      job = startCrawlJob({ url: b.url, username: b.username, password: b.password, filter: String(b.filter || "").trim().slice(0, 300), limit: limit || undefined, fetchImpl: cloudpathFetch,
        onDone: async (result) => { setCrawl(result); } });
      return connectionsState();
    },
    "POST /api/connections/cloudpath/crawl/stop": async () => { if (job && (job.state === "starting" || job.state === "running")) job.stop(); return connectionsState(); },
    "POST /api/connections/cloudpath/arm": async (b, req) => {
      const host = String(req.headers.host || "127.0.0.1:8787");
      arm = { code: crypto.randomBytes(16).toString("hex"), until: Date.now() + 15 * 60e3 };
      const filter = String(b.filter || "").trim().slice(0, 300), limit = Math.max(0, Math.min(5000, parseInt(b.limit, 10) || 0));
      const opts = (filter ? `window.__CRAWL_FILTER=${JSON.stringify(filter)};` : "") + (limit ? `window.__CRAWL_LIMIT=${limit};` : "");
      return { until: arm.until, script: buildBrowserScript(root, `window.__CRAWL_RECEIVER=${JSON.stringify("http://" + host + "/api/crawl/receive")};window.__CRAWL_CODE=${JSON.stringify(arm.code)};${opts}\n`) };
    },
    "POST /api/connections/cloudpath/disarm": async () => { arm = null; return connectionsState(); },
    // Undo: remove from RUCKUS One what the studio created, through the connection that created it.
    "GET /api/undo": async () => ({ ...undoMod.list(dataRoot, connName), connection: connName, live: !!client }),
    "POST /api/undo": async (b) => {
      needClient();
      if (b.confirm !== true) throw httpError(400, "Confirm first.");
      if (applying) throw httpError(409, "An apply is running. Wait for it to finish.");
      applying++;
      try { const r = await undoMod.undo(dataRoot, client, connName, { log, waitMs: pollMs === undefined ? 1000 : pollMs }); inv = null; previews.clear(); return { ...r, ...undoMod.list(dataRoot, connName), connection: connName, live: !!client }; }
      finally { applying--; }
    },
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
      if (r.created && r.created.length) appendCreated(dataRoot, r.created, connName);
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
      if (r.created && r.created.length) appendCreated(dataRoot, r.created, connName);
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
      if (r.created && r.created.length) appendCreated(dataRoot, r.created, connName);
      await getInv(true);
      return r;
    },
    "PUT /api/drafts": async (b) => {
      if (!NAME.test(b.name || "")) throw httpError(400, "Draft names may use letters, numbers, spaces and . ( ) - _ (up to 80).");
      fs.mkdirSync(draftsDir, { recursive: true });
      fs.writeFileSync(path.join(draftsDir, b.name + ".json"), JSON.stringify(require("./model").stripSecrets(JSON.parse(JSON.stringify(b.workflow))), null, 2), { mode: 0o600 });
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
      if (url.pathname === "/api/crawl/receive") {                         // the crawler script posts here from the Cloudpath tab
        const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, x-crawl-code", "access-control-allow-private-network": "true", "cache-control": "no-store" };
        if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
        const fail = (status, message) => { res.writeHead(status, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify({ error: message })); };
        if (req.method !== "POST") return fail(405, "POST only");
        const given = String(req.headers["x-crawl-code"] || "");
        const ok = arm && arm.until > Date.now() && given.length === arm.code.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(arm.code));
        if (!ok) return fail(403, "Not waiting for a crawl. In the editor choose Connections, then Read a Cloudpath instance.");
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 80e6) return fail(413, "Too large"); chunks.push(c); }
        let j; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); crawls.validateCrawl(j); } catch (e) { return fail(400, e.message); }
        arm = null; setCrawl(j);
        res.writeHead(200, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, workflows: j.workflows.length }));
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
        const cap = /^\/api\/connections\/cloudpath\/load$/.test(url.pathname) ? 80e6 : 12e6;          // a crawl of hundreds of workflows is tens of MB
        for await (const c of req) { size += c.length; if (size > cap) throw httpError(413, "Too large"); chunks.push(c); }
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw httpError(400, "Bad JSON"); }
      }
      send(200, await handler(body, req));
    } catch (e) {
      log("ui error: " + e.message);
      send(e.status || 500, { error: e.message });
    }
  });
  server.token = token;
  return server;
}

module.exports = { createUiServer };
