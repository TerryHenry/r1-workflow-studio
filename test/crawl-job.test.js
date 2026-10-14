const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createUiServer } = require("../src/ui-server");
const { normalizeOrigin } = require("../src/cloudpath-client");
const fake = require("./fake-cloudpath");

async function editor() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2r-cj-"));
  fs.mkdirSync(path.join(root, "ui"), { recursive: true }); fs.mkdirSync(path.join(root, "crawl"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "ui", "index.html"), path.join(root, "ui", "index.html"));
  for (const f of ["crawl.browser.js", "core.js"]) fs.copyFileSync(path.join(__dirname, "..", "crawl", f), path.join(root, "crawl", f));
  const server = createUiServer({ client: null, crawl: null, root });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...headers } }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d, json: () => JSON.parse(d) })); });
    req.on("error", reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
  const post = (p, body) => call("POST", p, body, { "x-ui-token": server.token });
  const state = async () => (await call("GET", "/api/connections")).json().cloudpath;
  const finished = async (ms = 20000) => { const t0 = Date.now(); for (;;) { const c = await state(); if (c.job && !["starting", "running"].includes(c.job.state)) return c; if (Date.now() - t0 > ms) throw new Error("job did not finish: " + JSON.stringify(c.job)); await new Promise((r) => setTimeout(r, 25)); } };
  return { root, server, call, post, state, finished, close: () => new Promise((r) => server.close(r)) };
}
const allFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test("addresses: https only (http only for this computer), no embedded passwords, a page address is cut to its origin", () => {
  assert.equal(normalizeOrigin("cloudpath.example.com"), "https://cloudpath.example.com");
  assert.equal(normalizeOrigin("https://cloudpath.example.com/admin/dashboard/welcome?x=1"), "https://cloudpath.example.com");
  assert.equal(normalizeOrigin("http://127.0.0.1:8080/admin"), "http://127.0.0.1:8080");
  for (const bad of ["", "http://cloudpath.example.com", "ftp://x.example.com", "https://user:pw@cloudpath.example.com", "not a url ::"]) assert.throws(() => normalizeOrigin(bad), (e) => e.status === 400, bad);
});

test("the editor signs in to Cloudpath itself, reads every page of the list, signs out, and never keeps the password", async () => {
  const cp = await fake.create({ workflows: 230 }), ed = await editor();
  try {
    const wrong = await ed.post("/api/connections/cloudpath/crawl", { url: cp.origin, username: cp.USER, password: "nope-nope-nope" });
    assert.equal(wrong.status, 200);
    let c = await ed.finished(); assert.equal(c.job.state, "failed"); assert.match(c.job.message, /did not accept that email and password/);
    assert.ok(!JSON.stringify(c).includes("nope-nope-nope"), "a wrong password is not echoed");
    assert.equal(cp.log.failedLogins, 1);

    assert.equal((await ed.post("/api/connections/cloudpath/crawl", { url: "http://example.com", username: "a", password: "b" })).status, 400);
    assert.equal((await ed.post("/api/connections/cloudpath/crawl", { url: cp.origin, username: "", password: "b" })).status, 400);
    assert.equal((await ed.post("/api/connections/cloudpath/crawl", { url: cp.origin, username: "a", password: "" })).status, 400);

    await ed.post("/api/connections/cloudpath/crawl", { url: cp.origin, username: cp.USER, password: cp.PASS, filter: "alpha, beta", limit: "5" });
    c = await ed.finished(); assert.equal(c.job.state, "done", JSON.stringify(c.job));
    assert.equal(c.active.workflows, 2); assert.equal(c.active.listed, 230, "it counted all 230 listed, across the pages of 100");
    assert.equal(c.active.filter, "alpha, beta");
    assert.equal(cp.log.logins, 1); assert.equal(cp.log.logouts, 1, "it signs out when done");
    assert.ok(cp.log.gets.some((g) => /_p_=3/.test(g)), "it followed the list to its third page");
    const saved = JSON.parse(fs.readFileSync(path.join(ed.root, "data", "crawl.json"), "utf8"));
    assert.deepEqual(saved.workflows.map((w) => w.name), ["Alpha guest", "Beta staff"]);
    assert.equal(saved.source, cp.origin);
    assert.equal(saved.cloudpathVersion, "6.0.6052");
    const alpha = saved.workflows[0];
    assert.deepEqual(alpha.steps.map((s) => s.kind), ["aup", "selection"]);
    assert.equal(alpha.steps[0].fields.messageHtml, "Line one\nLine two", "textarea line breaks are normalised like a browser's");
    assert.equal(alpha.steps[1].options.length, 2); assert.equal(alpha.steps[1].options[0].steps[0].kind, "dpsk"); assert.equal(alpha.steps[1].options[1].steps[0].kind, "ss");
    assert.equal(alpha.look.welcomeTitle1, "Hello 1000");
    assert.deepEqual(saved.objects.dpskPools.map((p) => [p.name, p.deviceLimit, p.ssids]), [["Guest Pool", "3", ["Guest-WiFi"]]]);
    assert.deepEqual(saved.objects.deviceConfigs.map((n) => [n.name, n.wlans[0].ssid]), [["Guest-Net", "Guest-WiFi"]]);
    // secrets and the password go nowhere
    const ss = alpha.steps[1].options[1].steps[0];
    assert.equal(ss.fields.sharedSecret, "[removed]"); assert.match(ss.links[0].tooltip, /Shared secret: \[removed\]/); assert.equal(ss.fields.sharedSecretDescription, "The crawl".length ? "The crew passphrase" : "");
    for (const f of allFiles(ed.root)) { const txt = fs.readFileSync(f, "utf8"); assert.ok(!txt.includes(cp.PASS) && !txt.includes("hunter2"), "no password or secret in " + path.relative(ed.root, f)); }
    assert.ok(!JSON.stringify(await ed.state()).includes(cp.PASS));
  } finally { await ed.close(); await cp.close(); }
});

test("every branch's own form is read, whichever option Cloudpath had selected for this session", async () => {
  const forms = {};
  for (const initial of [0, 1]) {
    const cp = await fake.create({ workflows: 3, initialSelected: initial }), ed = await editor();
    try {
      await ed.post("/api/connections/cloudpath/crawl", { url: cp.origin, username: cp.USER, password: cp.PASS, filter: "alpha" });
      await ed.finished();
      const w = JSON.parse(fs.readFileSync(path.join(ed.root, "data", "crawl.json"), "utf8")).workflows[0];
      forms[initial] = w.steps[1].options.map((o) => o.fields && o.fields.description);
    } finally { await ed.close(); await cp.close(); }
  }
  assert.deepEqual(forms[0], ["Visible to guests", "Visible to staff"]);
  assert.deepEqual(forms[1], forms[0], "the same result from either starting state");
});

test("a read can be stopped (what was read is kept) and only one runs at a time", async () => {
  const cp = await fake.create({ workflows: 30, delayMs: 15 }), ed = await editor();
  try {
    await ed.post("/api/connections/cloudpath/crawl", { url: cp.origin, username: cp.USER, password: cp.PASS });
    assert.equal((await ed.post("/api/connections/cloudpath/crawl", { url: cp.origin, username: cp.USER, password: cp.PASS })).status, 409);
    for (let i = 0; i < 200; i++) { const j = (await ed.state()).job; if (j.done >= 3) break; await new Promise((r) => setTimeout(r, 20)); }
    await ed.post("/api/connections/cloudpath/crawl/stop", {});
    const c = await ed.finished();
    assert.equal(c.job.state, "stopped"); assert.match(c.job.message, /^Stopped: kept the \d+ workflow/);
    assert.ok(c.active.workflows >= 3 && c.active.workflows < 30); assert.equal(c.active.stopped, true);
    assert.equal(cp.log.logouts, 1, "signed out even though it was stopped");
  } finally { await ed.close(); await cp.close(); }
});

test("a sign-in that sends us to another address is refused, and an unreachable address is explained", async () => {
  const ed = await editor();
  try {
    const bad = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>hello, not Cloudpath</body></html>"); });
    await new Promise((r) => bad.listen(0, "127.0.0.1", r));
    await ed.post("/api/connections/cloudpath/crawl", { url: "http://127.0.0.1:" + bad.address().port, username: "a", password: "b" });
    let c = await ed.finished(); assert.equal(c.job.state, "failed"); assert.match(c.job.message, /doesn't show a Cloudpath admin sign-in page/);
    await new Promise((r) => bad.close(r));
    await ed.post("/api/connections/cloudpath/crawl", { url: "http://127.0.0.1:1", username: "a", password: "b" });
    c = await ed.finished(); assert.equal(c.job.state, "failed"); assert.match(c.job.message, /Could not reach 127\.0\.0\.1:1/);
    const evil = http.createServer((req, res) => { res.writeHead(302, { location: "http://example.org/steal" }); res.end(); });
    await new Promise((r) => evil.listen(0, "127.0.0.1", r));
    await ed.post("/api/connections/cloudpath/crawl", { url: "http://127.0.0.1:" + evil.address().port, username: "a", password: "pw-should-not-leave" });
    c = await ed.finished(); assert.equal(c.job.state, "failed"); assert.match(c.job.message, /another address/);
    await new Promise((r) => evil.close(r));
  } finally { await ed.close(); }
});

test("a big instance (more than 300 workflows) is read and saved whole", async () => {
  const cp = await fake.create({ workflows: 350 }), ed = await editor();
  try {
    await ed.post("/api/connections/cloudpath/crawl", { url: cp.origin, username: cp.USER, password: cp.PASS });
    const c = await ed.finished(60000);
    assert.equal(c.job.state, "done", JSON.stringify(c.job));
    assert.equal(c.active.workflows, 350); assert.equal(c.active.listed, 350);
    const state = (await ed.call("GET", "/api/state")).json();
    assert.equal(state.cloudpath.filter((w) => w.kind !== "guestNetwork").length, 350, "every workflow reaches the editor's list");
    assert.ok(cp.log.gets.filter((g) => /_p_=\d/.test(g) && /viewAllWorkflows/.test(g)).length >= 4, "all four pages of the list were read");
    // a crawl that cannot be saved says so, instead of vanishing quietly
    const { validateCrawl } = require("../src/crawls");
    assert.throws(() => validateCrawl({ workflows: Array.from({ length: 5001 }, (_, i) => ({ name: "w" + i, steps: [] })) }), /more than 5000/);
  } finally { await ed.close(); await cp.close(); }
});
