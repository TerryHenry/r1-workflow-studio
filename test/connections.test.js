const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crawl = require("./fixtures/crawl.json");
const { createUiServer } = require("../src/ui-server");
const conns = require("../src/connections");
const crawls = require("../src/crawls");
const { fakeR1 } = require("./fake-r1");

const SECRET = "s3cr3t-VALUE-do-not-leak-0123456789";
const profile = (o = {}) => ({ name: "Lab tenant", region: "eu", tenantId: "tenant-aaaa-1111-bbbb", clientId: "client-cccc-2222-dddd", clientSecret: SECRET, delegatedTenantId: "", ...o });

async function start(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2r-conn-"));
  fs.mkdirSync(path.join(root, "ui"), { recursive: true }); fs.mkdirSync(path.join(root, "crawl"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "ui", "index.html"), path.join(root, "ui", "index.html"));
  for (const f of ["crawl.browser.js", "core.js"]) fs.copyFileSync(path.join(__dirname, "..", "crawl", f), path.join(root, "crawl", f));
  const first = fakeR1({ existing: { venues: [{ id: "v1", name: "First" }] } }), made = [];
  const makeClient = (creds) => { made.push(creds); if (creds.clientSecret === "WRONG") return { call: async () => { throw new Error("RUCKUS One login failed (401)"); } }; return fakeR1({ existing: { venues: [{ id: "v2", name: "Second" }] } }).client; };
  const server = createUiServer({ client: first.client, crawl: opts.noCrawl ? null : crawl, root, pollMs: 0, makeClient });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: d, json: () => JSON.parse(d) }));
    });
    req.on("error", reject); if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body)); req.end();
  });
  const post = (p, body, token = server.token) => call("POST", p, body, { "x-ui-token": token });
  const put = (p, body) => call("PUT", p, body, { "x-ui-token": server.token });
  return { server, root, made, call, post, put, first, close: () => new Promise((r) => server.close(r)) };
}

test("saved connections: the page never sees a secret, the file is private, blank secret keeps the saved one", async () => {
  const s = await start();
  try {
    const r = await s.put("/api/connections/r1", { profile: profile() });
    assert.equal(r.status, 200);
    const all = (await s.call("GET", "/api/connections")).text;
    assert.ok(!all.includes(SECRET)); assert.ok(!all.includes("tenant-aaaa-1111-bbbb")); assert.ok(all.includes("…bbbb"));
    const file = path.join(s.root, "data", "connections.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal((await s.put("/api/connections/r1", { profile: { name: "Lab tenant", region: "na" } })).status, 200);
    const kept = conns.credsFor(s.root, "Lab tenant");
    assert.equal(kept.clientSecret, SECRET); assert.equal(kept.region, "na"); assert.equal(kept.tenantId, "tenant-aaaa-1111-bbbb");
    for (const bad of [{ name: "" }, { name: "default" }, { name: "x", tenantId: "short" }, profile({ clientSecret: "" , name: "no secret" }), profile({ name: "r", region: "mars" })]) assert.equal((await s.put("/api/connections/r1", { profile: bad })).status, 400, JSON.stringify(bad.name));
    assert.equal((await s.put("/api/connections/r1", { profile: profile() })).status, 200);
    assert.equal((await call403(s)).status, 403);
  } finally { await s.close(); }
});
const call403 = (s) => s.call("PUT", "/api/connections/r1", { profile: profile({ name: "x2" }) }, { "x-ui-token": "wrong" });

test("switching RUCKUS One tenant: tested first, clears previews, refused while a bad login, can't delete the one in use", async () => {
  const s = await start();
  try {
    await s.put("/api/connections/r1", { profile: profile() });
    await s.put("/api/connections/r1", { profile: profile({ name: "Broken", clientSecret: "WRONG" }) });
    const wf = { name: "Switch test", steps: [{ id: "a", type: "AUP", name: "A", params: { title: "t", messageHtml: "m", checkboxText: "c", backButtonText: "b", continueButtonText: "c" } }] };
    const pv = (await s.post("/api/preview", { workflow: wf, options: {} })).json();
    assert.ok(pv.hash);
    assert.equal(((await s.post("/api/state", {}).catch(() => ({}))).status || 404) >= 400, true);
    assert.equal((await s.call("GET", "/api/state")).json().inventory.venues[0].name, "First");

    const bad = await s.post("/api/connections/r1/use", { name: "Broken" });
    assert.equal(bad.status, 400); assert.match(bad.json().error, /Could not connect/); assert.ok(!bad.text.includes("WRONG"));
    assert.equal((await s.call("GET", "/api/connections")).json().r1.name, "default", "a failed switch changes nothing");
    assert.equal((await s.call("GET", "/api/state")).json().inventory.venues[0].name, "First");

    const t = await s.post("/api/connections/r1/test", { profile: { name: "Lab tenant", region: "eu" } });
    assert.equal(t.status, 200); assert.equal(t.json().ok, true);
    assert.equal((await s.post("/api/connections/r1/test", { profile: profile({ name: "Broken", clientSecret: "WRONG" }) })).status, 400);

    const use = await s.post("/api/connections/r1/use", { name: "Lab tenant" });
    assert.equal(use.status, 200); assert.equal(use.json().r1.name, "Lab tenant"); assert.equal(use.json().r1.live, true);
    const st = (await s.call("GET", "/api/state")).json();
    assert.equal(st.inventory.venues[0].name, "Second"); assert.equal(st.connection.name, "Lab tenant");
    assert.equal(s.made[s.made.length - 1].region, "eu");
    assert.equal((await s.post("/api/apply", { workflow: wf, options: {}, hash: pv.hash })).status, 409, "a preview from the other tenant can't be applied");
    assert.equal((await s.post("/api/connections/r1/delete", { name: "Lab tenant" })).status, 409);
    assert.equal(conns.load(s.root).active, "Lab tenant");

    const off = (await s.post("/api/connections/r1/use", { name: "offline" })).json();
    assert.equal(off.r1.live, false);
    assert.equal((await s.post("/api/connections/r1/delete", { name: "Lab tenant" })).status, 200);
    assert.equal((await s.post("/api/connections/r1/use", { name: "nope" })).status >= 400, true);
    assert.equal(conns.initial(s.root, () => ({})).client, null, "next start comes up offline, as last left");
  } finally { await s.close(); }
});

test("Cloudpath crawls: load a file, keep the old one, switch back, refuse bad files and odd names", async () => {
  const s = await start();
  try {
    const other = { ...JSON.parse(JSON.stringify(crawl)), source: "https://other.example.com", crawledAt: "2026-10-14T01:00:00.000Z" };
    other.workflows = other.workflows.slice(0, 1);
    const r = await s.post("/api/connections/cloudpath/load", { text: JSON.stringify(other) });
    assert.equal(r.status, 200);
    const c = r.json().cloudpath;
    assert.equal(c.active.source, "https://other.example.com"); assert.equal(c.active.workflows, 1);
    assert.equal((await s.call("GET", "/api/state")).json().cloudpath.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, "data", "crawl.json"), "utf8")).source, "https://other.example.com", "the command-line tools see the active crawl");
    assert.ok(c.saved.length >= 2, "the crawl that was active is kept");
    const first = c.saved.find((x) => x.source === crawl.source);
    assert.ok(first, "original instance saved");
    const back = await s.post("/api/connections/cloudpath/use", { file: first.file });
    assert.equal(back.json().cloudpath.active.source, crawl.source);
    assert.equal((await s.call("GET", "/api/state")).json().cloudpath.length, crawl.workflows.length + 1);
    assert.equal((await s.post("/api/connections/cloudpath/load", { text: "{nope" })).status, 400);
    assert.equal((await s.post("/api/connections/cloudpath/load", { text: JSON.stringify({ workflows: "x" }) })).status, 400);
    assert.equal((await s.post("/api/connections/cloudpath/use", { file: "../../etc/passwd" })).status, 400);
    assert.equal((await s.post("/api/connections/cloudpath/use", { file: "missing.json" })).status, 404);
    assert.equal((await s.post("/api/connections/cloudpath/delete", { file: "../x.json" })).status, 400);
    assert.equal((await s.post("/api/connections/cloudpath/delete", { file: first.file })).status, 200);
    assert.equal(crawls.validateCrawl(crawl), crawl);
  } finally { await s.close(); }
});

test("the crawler can report straight to the editor: one-time code, 15 minutes, nothing else gets in", async () => {
  const s = await start({ noCrawl: true });
  try {
    const body = JSON.stringify({ ...crawl, source: "https://fresh.example.com", workflows: crawl.workflows.slice(0, 2) });
    assert.equal((await s.call("POST", "/api/crawl/receive", body)).status, 403, "not armed");
    assert.equal((await s.post("/api/connections/cloudpath/arm", {}, "wrong")).status, 403);
    const a = (await s.post("/api/connections/cloudpath/arm", {})).json();
    const code = (a.script.match(/__CRAWL_CODE="([0-9a-f]+)"/) || [])[1];
    assert.ok(code && a.script.includes("/api/crawl/receive"));
    assert.match(a.script, /x-crawl-code/);
    const pre = await s.call("OPTIONS", "/api/crawl/receive", undefined, { origin: "https://cloudpath-lab.example.com" });
    assert.equal(pre.status, 204); assert.match(pre.headers["access-control-allow-headers"], /x-crawl-code/);
    assert.equal((await s.call("POST", "/api/crawl/receive", body, { "x-crawl-code": "0".repeat(32) })).status, 403, "wrong code");
    assert.equal((await s.call("POST", "/api/crawl/receive", body, { "x-crawl-code": code, host: "evil.example.com" })).status, 403, "wrong host");
    assert.equal((await s.call("POST", "/api/crawl/receive", "{nope", { "x-crawl-code": code })).status, 400);
    const stamp0 = (await s.call("GET", "/api/connections")).json().cloudpath.stamp;
    const ok = await s.call("POST", "/api/crawl/receive", body, { "x-crawl-code": code });
    assert.equal(ok.status, 200); assert.equal(ok.json().workflows, 2);
    assert.equal(ok.headers["access-control-allow-origin"], "*");
    const after = (await s.call("GET", "/api/connections")).json().cloudpath;
    assert.equal(after.active.source, "https://fresh.example.com"); assert.ok(after.stamp > stamp0); assert.equal(after.armed, false);
    assert.equal((await s.call("POST", "/api/crawl/receive", body, { "x-crawl-code": code })).status, 403, "single use");
  } finally { await s.close(); }
});

test("reading options go into the crawler script, and every Cloudpath entry arrives with its problem count", async () => {
  const s = await start();
  try {
    const a = (await s.post("/api/connections/cloudpath/arm", { filter: 'guest, "quote"\n</script>', limit: "25" })).json();
    assert.match(a.script, /window\.__CRAWL_FILTER="guest, \\"quote\\"\\n<\/script>";window\.__CRAWL_LIMIT=25;/);
    assert.ok(!/__CRAWL_LIMIT=NaN|__CRAWL_FILTER=undefined/.test(a.script));
    const none = (await s.post("/api/connections/cloudpath/arm", {})).json();
    assert.ok(!/__CRAWL_FILTER|__CRAWL_LIMIT=/.test(none.script.split("\n")[0]), "no options, none set");
    assert.match((await s.post("/api/connections/cloudpath/arm", { limit: "999999" })).json().script, /__CRAWL_LIMIT=5000;/);
    const st = (await s.call("GET", "/api/state")).json();
    assert.ok(st.cloudpath.every((w) => Number.isInteger(w._issues)), "the server counts each entry's problems (no call per workflow from the page)");
    assert.ok(st.cloudpath.find((w) => w.name === "personalPassphrase")._issues >= 0);
  } finally { await s.close(); }
});

test("secrets at rest: with the operating system's store they are written encrypted, without it as before", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2r-vault-"));
  const file = path.join(root, "data", "connections.json");
  try {
    conns.upsert(root, conns.cleanProfile(root, profile({ name: "Plain" })));
    assert.ok(fs.readFileSync(file, "utf8").includes(SECRET), "without a vault the secret is in the owner-only file");
    // the desktop app gives a vault (stand-in: reversible, and it records what it sealed)
    const sealed = [];
    conns.setVault({ seal: (s) => { sealed.push(s); return Buffer.from("vault:" + s.split("").reverse().join("")).toString("base64"); }, open: (b) => Buffer.from(b, "base64").toString().replace(/^vault:/, "").split("").reverse().join("") });
    assert.equal(conns.credsFor(root, "Plain").clientSecret, SECRET, "an older plain secret still works");
    conns.upsert(root, conns.cleanProfile(root, profile({ name: "Sealed", clientSecret: "another-secret-value-99" })));
    conns.upsert(root, conns.cleanProfile(root, { name: "Plain", delegatedTenantId: "" }));        // saving again seals the old one too
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes(SECRET) && !raw.includes("another-secret-value-99"), "no secret in the file");
    assert.equal(conns.credsFor(root, "Sealed").clientSecret, "another-secret-value-99"); assert.equal(conns.credsFor(root, "Plain").clientSecret, SECRET);
    assert.ok(!JSON.stringify(conns.summary(root)).includes("another-secret"), "the page never sees one");
    assert.equal(conns.summary(root).profiles.find((p) => p.name === "Sealed").hasSecret, true);
    // another computer or user cannot open them: clear message, nothing crashes
    conns.setVault({ seal: (s) => s, open: () => { throw new Error("wrong key"); } });
    const sum = conns.summary(root); assert.equal(sum.profiles.find((p) => p.name === "Sealed").secretUnreadable, true); assert.equal(sum.profiles.find((p) => p.name === "Sealed").hasSecret, false);
    assert.throws(() => conns.credsFor(root, "Sealed"), (e) => e.status === 409 && /enter the client secret again/.test(e.message));
    conns.setVault(null);
    assert.throws(() => conns.credsFor(root, "Sealed"), (e) => e.status === 409);
  } finally { conns.setVault(null); }
});

test("data lives in its own folder, apart from the program's files (the desktop app keeps it in the app-data folder)", async () => {
  const { startStudio } = require("../src/studio");
  const program = fs.mkdtempSync(path.join(os.tmpdir(), "c2r-prog-")), data = fs.mkdtempSync(path.join(os.tmpdir(), "c2r-data-"));
  fs.cpSync(path.join(__dirname, "..", "ui"), path.join(program, "ui"), { recursive: true });
  for (const d of ["crawl"]) fs.cpSync(path.join(__dirname, "..", d), path.join(program, d), { recursive: true });
  const s = await startStudio({ root: program, dataRoot: data, port: 0, offline: true });
  try {
    assert.ok(s.port > 0 && !s.client && s.connection === "offline");
    const get = (p) => new Promise((resolve) => http.get({ host: "127.0.0.1", port: s.port, path: p }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d })); }));
    assert.equal((await get("/")).status, 200, "the page is served from the program folder");
    const token = /const TOKEN = "([0-9a-f]+)"/.exec((await get("/")).text)[1];
    const post = (p, body) => new Promise((resolve) => { const r = http.request({ host: "127.0.0.1", port: s.port, path: p, method: "POST", headers: { "content-type": "application/json", "x-ui-token": token } }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(res.statusCode)); }); r.end(JSON.stringify(body)); });
    assert.equal(await post("/api/connections/cloudpath/load", { text: JSON.stringify({ source: "https://x.example.com", workflows: [{ name: "w", steps: [] }] }) }), 200);
    assert.ok(fs.existsSync(path.join(data, "data", "crawl.json")), "the crawl is saved in the data folder");
    assert.ok(!fs.existsSync(path.join(program, "data")), "and nothing is written next to the program");
  } finally { await s.close(); }
  // a busy preferred port falls back to a free one
  const blocker = http.createServer(); await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const s2 = await startStudio({ root: program, dataRoot: data, port: blocker.address().port, offline: true });
  try { assert.notEqual(s2.port, blocker.address().port); assert.ok(s2.port > 0); } finally { await s2.close(); await new Promise((r) => blocker.close(r)); }
});
