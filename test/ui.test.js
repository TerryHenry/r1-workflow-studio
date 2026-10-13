const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crawl = require("./fixtures/crawl.json");
const { createUiServer } = require("../src/ui-server");
const { Builder, makeApi } = require("../src/build");
const { fakeR1 } = require("./fake-r1");
const { validate, newNode, blankWorkflow, fromPlan, toBuildWorkflow, outline } = require("../src/model");
const { convertAll } = require("../src/convert");

const CA_WITH_KEY = { id: "ca-1", name: "Test CA", privateKeyBase64: "-----BEGIN " + "RSA PRIVATE" + " KEY-----SECRET", commonName: "x" };

async function start(opts = {}) {
  const fake = fakeR1({ existing: { cas: [CA_WITH_KEY], tpls: [{ id: "t1", name: "Guest Policy Template", identityGroupId: "g1" }], venues: [{ id: "v1", name: "Home" }], ...opts.existing } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2r-"));
  fs.mkdirSync(path.join(root, "ui"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "ui", "index.html"), path.join(root, "ui", "index.html"));
  const server = createUiServer({ client: opts.offline ? null : fake.client, crawl, root, pollMs: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d, json: () => JSON.parse(d) }));
    });
    req.on("error", reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
  const post = (p, body, token = server.token) => call("POST", p, body, { "x-ui-token": token });
  return { server, fake, root, port, call, post, close: () => new Promise((r) => server.close(r)) };
}

const goodWorkflow = () => {
  const aup = newNode("AUP"); const cert = newNode("CERT_TEMPLATE"); cert.params.certTemplateId = "t1";
  return { name: "Editor test", description: "", steps: [aup, cert] };
};

test("page is served with the token; other hosts and missing tokens are refused", async () => {
  const s = await start();
  try {
    const page = await s.call("GET", "/");
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(s.server.token));
    assert.ok(!page.text.includes("__TOKEN__"));
    const bad = await new Promise((resolve) => { const r = http.request({ host: "127.0.0.1", port: s.port, path: "/api/state", headers: { host: "evil.example.com" } }, (res) => resolve(res.statusCode)); r.end(); });
    assert.equal(bad, 403);
    assert.equal((await s.post("/api/preview", { workflow: goodWorkflow() }, "wrong")).status, 403);
    assert.equal((await s.post("/api/apply", { workflow: goodWorkflow() }, "")).status, 403);
  } finally { await s.close(); }
});

test("state has the schema, converted Cloudpath workflows and no secrets", async () => {
  const s = await start();
  try {
    const st = (await s.call("GET", "/api/state")).json();
    assert.ok(st.schema.DPSK && st.schema.CERT_TEMPLATE);
    assert.equal(st.cloudpath.length, crawl.workflows.length);
    assert.deepEqual(st.inventory.cas, [{ id: "ca-1", name: "Test CA" }]);
    assert.ok(!JSON.stringify(st).includes("SECRET"), "CA private key must never be sent to the browser");
    assert.equal(st.inventory.venues[0].name, "Home");
  } finally { await s.close(); }
});

test("apply is refused unless this exact workflow was previewed first", async () => {
  const s = await start();
  try {
    const wf = goodWorkflow();
    const noPreview = await s.post("/api/apply", { workflow: wf, options: {}, hash: "x" });
    assert.equal(noPreview.status, 409);
    assert.equal(s.fake.calls.filter((c) => c.method !== "GET" && !/query/.test(c.path)).length, 0);

    const pv = (await s.post("/api/preview", { workflow: wf, options: {} })).json();
    assert.deepEqual(pv.issues.filter((i) => i.level === "error"), []);
    assert.ok(pv.hash && pv.calls.length > 0);
    assert.equal(s.fake.calls.filter((c) => c.method !== "GET" && !/query/.test(c.path)).length, 0, "preview must not write");

    const changed = { ...wf, name: "Something else" };
    assert.equal((await s.post("/api/apply", { workflow: changed, options: {}, hash: pv.hash })).status, 409);

    const ok = await s.post("/api/apply", { workflow: wf, options: {}, hash: pv.hash });
    assert.equal(ok.status, 200);
    const r = ok.json();
    assert.deepEqual(r.built, ["Editor test"]);
    assert.ok(r.created.some((c) => c.kind === "workflow"));
    assert.ok(s.fake.calls.some((c) => c.method === "POST" && c.path === "/workflows"));
    assert.ok(fs.existsSync(path.join(s.root, "data", "created.json")), "created objects are recorded for undo");
    assert.equal((await s.post("/api/apply", { workflow: wf, options: {}, hash: pv.hash })).status, 409, "a preview can be used once");
  } finally { await s.close(); }
});

test("a workflow with problems previews as errors, with no calls, and cannot be applied", async () => {
  const s = await start();
  try {
    const wf = { name: "Bad", description: "", steps: [newNode("AUP")] };   // no onboarding step
    const pv = (await s.post("/api/preview", { workflow: wf, options: {} })).json();
    assert.ok(pv.issues.some((i) => i.level === "error" && /onboarding/.test(i.message)));
    assert.deepEqual(pv.calls, []);
    assert.equal((await s.post("/api/apply", { workflow: wf, options: {}, hash: pv.hash })).status, 409);
  } finally { await s.close(); }
});

test("offline: preview works, apply is refused", async () => {
  const s = await start({ offline: true });
  try {
    const wf = goodWorkflow();
    const pv = (await s.post("/api/preview", { workflow: wf, options: {} })).json();
    assert.ok(pv.hash);
    assert.equal((await s.post("/api/apply", { workflow: wf, options: {}, hash: pv.hash })).status, 409);
  } finally { await s.close(); }
});

test("drafts: save, list, load, delete, and bad names are rejected", async () => {
  const s = await start();
  try {
    const wf = goodWorkflow();
    assert.deepEqual((await s.call("PUT", "/api/drafts", { name: "mine", workflow: wf }, { "x-ui-token": s.server.token })).json().drafts, ["mine"]);
    assert.deepEqual((await s.post("/api/drafts/load", { name: "mine" })).json().workflow.steps.length, 2);
    assert.equal((await s.post("/api/drafts/load", { name: "../../etc/passwd" })).status, 400);
    assert.deepEqual((await s.post("/api/drafts/delete", { name: "mine" })).json().drafts, []);
  } finally { await s.close(); }
});

test("a new DPSK pool with a new SSID previews the objects it would create", async () => {
  const s = await start();
  try {
    const d = newNode("DPSK"); d.params.mode = "new"; d.params.newName = "pool-x"; d.params.ssids = [{ ssid: "wifi-x" }];
    const wf = { name: "Pool flow", description: "", steps: [newNode("AUP"), d] };
    const pv = (await s.post("/api/preview", { workflow: wf, options: { venueId: "v1" } })).json();
    assert.deepEqual(pv.willCreate.map((x) => x.kind + ":" + x.name), ["DPSK pool:pool-x", "Wi-Fi network:wifi-x", "workflow:Pool flow"]);
    assert.ok(pv.calls.some((c) => /PUT \/venues\/v1\/wifiNetworks/.test(c)));
  } finally { await s.close(); }
});

test("model: validation catches missing fields, long text, duplicates and unsupported steps", () => {
  const inv = { dpskPools: [{ id: "p", name: "Existing" }], certTemplates: [], macPools: [], workflows: [{ name: "Taken" }], cas: [], networks: [], identityGroups: [] };
  const d = newNode("DPSK");                      // existing mode, no pool chosen
  const issues = validate({ name: "Taken", steps: [d] }, inv);
  assert.ok(issues.some((i) => /already exists in R1/.test(i.message)));
  assert.ok(issues.some((i) => /Pool is required/.test(i.message)));
  const aup = newNode("AUP"); aup.params.title = "x".repeat(101);
  assert.ok(validate({ name: "N", steps: [aup, d] }, inv).some((i) => /over 100 characters/.test(i.message)));
  const dup = newNode("DPSK"); dup.params.mode = "new"; dup.params.newName = "existing";
  assert.ok(validate({ name: "N", steps: [dup] }, inv).some((i) => /already exists/.test(i.message)));
  const split = newNode("USER_SELECTION_SPLIT"); split.options[0].name = "Same"; split.options[1].name = "same";
  assert.ok(validate({ name: "N", steps: [split] }, inv).some((i) => /two options/.test(i.message)));
  const after = [newNode("USER_SELECTION_SPLIT"), newNode("AUP")];
  assert.ok(validate({ name: "N", steps: after }, inv).some((i) => /nothing can come after/.test(i.message)));
});

test("model: Cloudpath workflows convert to an editable model and back to builder nodes", () => {
  const inv = { dpskPools: [], macPools: [], certTemplates: [{ id: "t1", name: "Guest Policy Template", identityGroupId: "g1" }, { id: "t2", name: "BYOD Policy Template", identityGroupId: "g2" }], cas: [], networks: [], workflows: [] };
  const plan = convertAll(crawl, {});
  const prod = fromPlan(plan.workflows.find((w) => w.name === "Corporate"), inv, crawl.objects);
  assert.ok(outline(prod.steps).some((l) => /UNSUPPORTED: Guest SMS Prompt/.test(l)));
  // delete the placeholders (what the user does in the editor) and the workflow validates and converts
  const strip = (nodes) => nodes.filter((n) => n.type !== "UNSUPPORTED").map((n) => ({ ...n, options: n.options && n.options.map((o) => ({ ...o, steps: strip(o.steps) })) }));
  const cleaned = { ...prod, steps: strip(prod.steps) };
  assert.deepEqual(validate(cleaned, inv).filter((i) => i.level === "error"), []);
  const bw = toBuildWorkflow(cleaned, inv);
  assert.equal(bw.steps[1].options.length, 2);
  assert.equal(bw.steps[1].options[0].steps[0].r1.certTemplateId, "t1");
  const gen = fromPlan(plan.workflows.find((w) => w.name === "personalPassphrase"), { dpskPools: [], macPools: [], certTemplates: [], cas: [], networks: [], workflows: [] }, crawl.objects);
  assert.equal(gen.steps[0].params.mode, "new");
  assert.equal(gen.steps[0].params.newName, "example-ssid pool");
  assert.deepEqual(gen.steps[0].params.ssids, [{ ssid: "example-ssid" }]);
  void blankWorkflow;
});

test("create-if-missing: chooses an existing object by name, otherwise switches the step to create it", async () => {
  const { createMissing } = require("../src/model");
  const inv = { dpskPools: [{ id: "p1", name: "Existing Pool" }], macPools: [], certTemplates: [], cas: [{ id: "ca1", name: "Example Intermediate CA" }], networks: [], identityGroups: [], workflows: [] };
  const a = newNode("DPSK"); a.name = "Give a pass"; a.source = { create: { kind: "DPSK", name: "existing pool" } };            // exists (case-insensitive)
  const b = newNode("DPSK"); b.source = { create: { kind: "DPSK", name: "Brand New Pool", passphraseLength: 8, ssids: [{ ssid: "new-wifi" }] } };
  const c = newNode("MAC_REG"); c.source = { create: { kind: "MAC_REG", name: "Visitors", expirationType: "HOURS_AFTER_TIME", expirationOffset: 4 } };
  const d = newNode("CERT_TEMPLATE"); d.source = { create: { kind: "CERT_TEMPLATE", name: "Guest Cert", info: { issuingCa: "Example Intermediate CA", cnPattern: "${USERNAME}@x.com", validity: { type: "DAYS", value: 30 }, organization: "Org" } } };
  const wf = { name: "W", description: "", steps: [a, b, c, d] };
  const before = validate(wf, inv).filter((i) => i.fix === "createMissing");
  assert.equal(before.length, 4, "each missing object is flagged as fixable");
  const changes = createMissing(wf, inv);
  assert.equal(changes.length, 4);
  assert.deepEqual([a.params.mode, a.params.dpskPoolId], ["existing", "p1"]);
  assert.deepEqual([b.params.mode, b.params.newName, b.params.passphraseLength, b.params.ssids], ["new", "Brand New Pool", 8, [{ ssid: "new-wifi" }]]);
  assert.deepEqual([c.params.mode, c.params.expirationType, c.params.expirationOffset], ["new", "HOURS_AFTER_TIME", 4]);
  assert.deepEqual([d.params.mode, d.params.caId, d.params.commonNamePattern, d.params.validityType, d.params.validityValue], ["new", "ca1", "$(USERNAME)@x.com", "DAYS", 30]);
  assert.equal(validate(wf, inv).filter((i) => i.fix === "createMissing").length, 0);
  assert.deepEqual(createMissing(wf, inv), [], "a second run changes nothing");
  assert.deepEqual(createMissing({ steps: [a] }, inv, ["nope"]), []);
});

test("create-if-missing endpoint returns the fixed workflow and what it did", async () => {
  const s = await start();
  try {
    const d = newNode("DPSK"); d.source = { create: { kind: "DPSK", name: "Pool Z", passphraseLength: 10 } };
    const wf = { name: "W", description: "", steps: [d] };
    const r = (await s.post("/api/fix", { workflow: wf })).json();
    assert.equal(r.changes.length, 1);
    assert.equal(r.workflow.steps[0].params.mode, "new");
    assert.equal(r.workflow.steps[0].params.newName, "Pool Z");
    assert.equal(wf.steps[0].params.mode, "existing", "the request's workflow is not modified server-side state");
    assert.equal(s.fake.calls.filter((c) => c.method !== "GET" && !/query/.test(c.path)).length, 0, "fixing writes nothing to R1");
  } finally { await s.close(); }
});

// ---- importing existing R1 objects (read-only) ----
function fakeWorkflowApi() {
  const actions = {
    a1: { id: "a1", actionType: "AUP", title: "Hello", messageHtml: "Read this", checkboxText: "ok", checkboxDefaultState: true, checkboxHighlightColor: "FCFFB3", backButtonText: "Back", continueButtonText: "Go", aupPlainText: "be nice", useAupFile: false },
    a2: { id: "a2", actionType: "USER_SELECTION_SPLIT", title: "Who?", displayTitle: true },
    o1: { id: "o1", actionType: "USER_SELECTION_SPLIT_OPTION", messageHtml: "Guests" }, o2: { id: "o2", actionType: "USER_SELECTION_SPLIT_OPTION", messageHtml: "" },
    a3: { id: "a3", actionType: "DPSK", dpskPoolId: "pool1", identityGroupId: "g1", qrCodeDisplay: true },
    a4: { id: "a4", actionType: "CERT_TEMPLATE", certTemplateId: "t1", identityGroupId: "g2" },
    a5: { id: "a5", actionType: "WORKFLOW_REFERENCE" },
  };
  const steps = [
    { id: "s0", type: "startStepDto", nextStepId: "s1" },
    { id: "s1", type: "stepDto", actionType: "AUP", enrollmentActionId: "a1", label: "Terms", nextStepId: "s2" },
    { id: "s2", type: "splitStepDto", actionType: "USER_SELECTION_SPLIT", enrollmentActionId: "a2", label: "Who" },
    { id: "s3", type: "stepDto", actionType: "DPSK", enrollmentActionId: "a3", nextStepId: "e1" },
    { id: "s4", type: "stepDto", actionType: "CERT_TEMPLATE", enrollmentActionId: "a4", nextStepId: "e2" },
    { id: "e1", type: "endStepDto" }, { id: "e2", type: "endStepDto" },
  ];
  const options = [{ optionName: "Guests", enrollmentActionId: "o1", nextStepId: "s3" }, { optionName: "Staff", enrollmentActionId: "o2", nextStepId: "s4" }];
  const writes = [];
  return { writes, client: { async call(method, p) {
    p = p.split("?")[0];
    if (method !== "GET" && !/query/.test(p)) writes.push(method + " " + p);
    if (p === "/workflows/w1") return { id: "w1", name: "Orig", status: "VALID", startStepId: "s0", description: "" };
    if (p === "/workflows/w1/steps") return { content: steps };
    if (p === "/workflows/w1/steps/s2/splitOptions") return { content: options };
    const m = p.match(/^\/enrollmentActions\/(\w+)$/); if (m) return actions[m[1]];
    if (p.startsWith("/certificateTemplates/query")) return { data: [{ id: "t1", name: "Tpl", caType: "ONBOARD", algorithm: "SHA_384", keyLength: 3072, onboard: { certificateAuthorityId: "ca1", commonNamePattern: "$(USERNAME)@x.com", notAfterType: "SPECIFIED_DATE", notAfterDate: "2030-01-01", notBeforeType: "MONTHS", notBeforeValue: 1, organizationPattern: "Org" } }] };
    throw Object.assign(new Error("404 " + p), { status: 404 });
  } } };
}

test("import: an R1 workflow with a split becomes an editable copy, read-only", async () => {
  const { importWorkflow } = require("../src/r1import");
  const f = fakeWorkflowApi();
  const { workflow, warnings } = await importWorkflow(f.client, "w1");
  assert.equal(workflow.name, "Orig (copy)");
  assert.deepEqual(outline(workflow.steps), ["AUP: Terms", "USER_SELECTION_SPLIT: Who", '  option "Guests"', "    DPSK: Give a DPSK passphrase", '  option "Staff"', "    CERT_TEMPLATE: Issue a certificate"]);
  const aup = workflow.steps[0].params;
  assert.equal(aup.aupPlainText, "be nice"); assert.equal(aup.checkboxHighlightColor, "#FCFFB3"); assert.equal(aup.checkboxDefaultState, true);
  assert.equal(workflow.steps[1].options[0].text, "Guests");
  assert.equal(workflow.steps[1].options[0].steps[0].params.dpskPoolId, "pool1");
  assert.equal(workflow.steps[1].options[0].steps[0].params.qrCodeDisplay, true);
  assert.deepEqual(f.writes, [], "importing must not write to R1");
  assert.deepEqual(warnings, []);
  assert.equal(workflow.source.r1, "w1");
  // it validates as a workflow and converts back for building (as a new workflow: the copy has its own name)
  const inv = { dpskPools: [{ id: "pool1", name: "P", identityGroupId: "g1" }], certTemplates: [{ id: "t1", name: "Tpl", identityGroupId: "g2" }], macPools: [], cas: [], networks: [], identityGroups: [], workflows: [{ name: "Orig" }] };
  assert.deepEqual(validate(workflow, inv).filter((i) => i.level === "error"), []);
  const bw = toBuildWorkflow(workflow, inv);
  assert.equal(bw.steps[0].r1.aupPlainText, "be nice");
  assert.equal(bw.steps[0].r1.useAupFile, false);
  assert.equal(bw.steps[1].options[1].steps[0].r1.certTemplateId, "t1");
});

test("import: unsupported R1 steps become placeholders; a certificate template becomes a form with warnings", async () => {
  const { importWorkflow, importCertTemplate } = require("../src/r1import");
  const f = fakeWorkflowApi();
  // make the AUP step a functional split
  const wrap = { async call(m, p) { p = p.split("?")[0]; if (p === "/workflows/w1/steps") { const s = (await f.client.call(m, p)).content.map((x) => (x.id === "s1" ? { ...x, actionType: "WORKFLOW_REFERENCE", enrollmentActionId: "a5" } : x)); return { content: s }; } return f.client.call(m, p); } };
  const r = await importWorkflow(wrap, "w1");
  assert.equal(r.workflow.steps[0].type, "UNSUPPORTED");
  assert.match(r.warnings[0], /can't edit/);
  const t = await importCertTemplate(f.client, "t1");
  assert.equal(t.template.name, "Tpl (copy)");
  assert.deepEqual([t.template.caId, t.template.commonNamePattern, t.template.algorithm, t.template.keyLength, t.template.organization], ["ca1", "$(USERNAME)@x.com", "SHA_384", 3072, "Org"]);
  assert.deepEqual([t.template.validityType, t.template.validityValue], ["YEARS", 1]);
  assert.match(t.warnings[0], /fixed date/);
  await assert.rejects(importCertTemplate(f.client, "nope"), /not found/);
});

test("model: only one onboarding step is allowed per path", () => {
  const a = newNode("DPSK"), b = newNode("MAC_REG");
  a.params.dpskPoolId = "p"; b.params.macRegListId = "m";
  const inv = { dpskPools: [{ id: "p", name: "P" }], macPools: [{ id: "m", name: "M" }], workflows: [], cas: [], certTemplates: [], networks: [], identityGroups: [] };
  assert.ok(validate({ name: "N", steps: [a, b] }, inv).some((i) => /only one onboarding step/.test(i.message)));
  const split = newNode("USER_SELECTION_SPLIT"); split.options[0].steps = [a]; split.options[1].steps = [b];
  assert.ok(!validate({ name: "N", steps: [split] }, inv).some((i) => /only one onboarding step/.test(i.message)), "one per branch is fine");
});

test("server: import routes are read-only and template apply is gated by a preview", async () => {
  const s = await start();
  try {
    const f = fakeWorkflowApi();
    s.fake.client.call = (orig => async (m, p, b) => { if (/^\/workflows\/w1|^\/enrollmentActions\/\w+$|\/certificateTemplates\/query/.test(p) && m === "GET") return f.client.call(m, p); return orig(m, p, b); })(s.fake.client.call);
    const w = await s.post("/api/import/workflow", { id: "w1" });
    assert.equal(w.status, 200); assert.equal(w.json().workflow.name, "Orig (copy)");
    assert.equal((await s.post("/api/import/workflow", { id: "../etc" })).status, 400);
    const tpl = { kind: "certTemplate", name: "Brand new tpl", description: "", caId: "ca-1", commonNamePattern: "$(USERNAME)", emailPattern: "", validityType: "YEARS", validityValue: 1, startType: "DAYS", startValue: 0, organization: "", organizationUnit: "", locality: "", state: "", country: "", algorithm: "SHA_256", keyLength: 2048 };
    assert.equal((await s.post("/api/template/apply", { template: tpl, options: {}, hash: "x" })).status, 409);
    const pv = (await s.post("/api/template/preview", { template: tpl, options: {} })).json();
    assert.deepEqual(pv.issues, []);
    assert.deepEqual(pv.willCreate.map((x) => x.kind), ["certificate template", "identity group"]);
    assert.equal(s.fake.calls.filter((c) => c.method !== "GET" && !/query/.test(c.path)).length, 0, "preview writes nothing");
    const ok = (await s.post("/api/template/apply", { template: tpl, options: {}, hash: pv.hash })).json();
    assert.deepEqual(ok.built, ["Brand new tpl"]);
    assert.ok(s.fake.calls.some((c) => c.method === "POST" && c.path === "/certificateAuthorities/ca-1/templates" && c.body.name === "Brand new tpl"));
    const bad = (await s.post("/api/template/preview", { template: { ...tpl, name: "Guest Policy Template" }, options: {} })).json();
    assert.ok(bad.issues.some((i) => /already exists/.test(i.message)));
  } finally { await s.close(); }
});

// ---- look and feel, guest networks ----
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64");

test("look and feel: validation, multipart parts, and the builder posts it after the steps", async () => {
  const { validateLook, lookParts, DEFAULT_LOOK, sniffImage } = require("../src/model");
  const L = JSON.parse(JSON.stringify(DEFAULT_LOOK)); L.welcomeTitle = "Hi"; L.colors.buttonColor = "#112233"; L.images = { logo: { filename: "l.png", type: "image/png", base64: PNG_B64 } };
  assert.deepEqual(validateLook(L), []);
  assert.ok(validateLook({ ...L, welcomeTitle: "" }).some((i) => /welcome title/.test(i.message)));
  assert.ok(validateLook({ ...L, colors: { ...L.colors, fontColor: "red" } }).some((i) => /not a color/.test(i.message)));
  assert.ok(validateLook({ ...L, images: { logo: { type: "application/pdf", base64: "AA" } } }).some((i) => /PNG, JPEG/.test(i.message)));
  assert.ok(validateLook({ ...L, images: { logo: { type: "image/png", bytes: 6 * 1024 * 1024 } } }).some((i) => /over 5 MB/.test(i.message)), "size can be sent instead of the data");
  const parts = lookParts(L);
  assert.equal(parts.uiConfiguration.json.uiColorSchema.buttonColor, "#112233");
  assert.equal(parts.logoImage.file.type, "image/png");
  assert.equal(sniffImage(Buffer.from(PNG_B64, "base64")), "image/png");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='x'/>")), "image/svg+xml");
  assert.equal(sniffImage(Buffer.from("nope")), null);

  const fake = fakeR1();
  const calls = fake.calls;
  const orig = fake.client.call;
  fake.client.call = async (m, p, b) => { if (m === "GET" && /uiConfigurations$/.test(p)) { const c = calls.find((x) => /uiConfigurations$/.test(x.path) && x.method === "POST"); return c ? { welcomeTitle: "Hi" } : {}; } return orig(m, p, b); };
  const wf = { name: "Looky", description: "", steps: [newNode("AUP"), Object.assign(newNode("CERT_TEMPLATE"), { params: { mode: "existing", certTemplateId: "t1" } })], look: L };
  const b = new Builder({ api: makeApi({ client: fake.client, apply: true, log: () => {} }), crawl: { objects: {} }, mapping: {}, opts: { pollMs: 0 }, log: () => {} });
  const r = await b.buildAll({ workflows: [toBuildWorkflow(wf, { certTemplates: [{ id: "t1", name: "T", identityGroupId: "g" }] })] }, []);
  assert.deepEqual(r.built, ["Looky"]);
  const ui = calls.find((x) => x.method === "POST" && /uiConfigurations$/.test(x.path));
  assert.ok(ui && ui.body.__multipart, "look and feel is sent as multipart");
  assert.equal(ui.body.parts.uiConfiguration.json.welcomeTitle, "Hi");
  assert.ok(ui.body.parts.logoImage);
  assert.ok(calls.findIndex((x) => x === ui) > calls.findIndex((x) => /nextSteps$/.test(x.path)), "look is applied after the steps");
});

test("guest network: validation, request body, and building (venue optional)", async () => {
  const { blankGuestNetwork, validateGuestNetwork, guestNetworkBody } = require("../src/model");
  const g = { ...blankGuestNetwork(), name: "Visitors", ssid: "visitors-wifi", title: "Welcome", termsAndConditions: "Be nice.", userSessionTimeout: 600 };
  const inv = { networks: [{ name: "Old", ssid: "old-wifi" }] };
  assert.deepEqual(validateGuestNetwork(g, inv), []);
  assert.ok(validateGuestNetwork({ ...g, ssid: "OLD-WIFI" }, inv).some((i) => /SSID .* already exists/.test(i.message)));
  assert.ok(validateGuestNetwork({ ...g, name: "old" }, inv).some((i) => /already exists/.test(i.message)));
  assert.ok(validateGuestNetwork({ ...g, ssid: "x".repeat(33) }, inv).some((i) => /over 32/.test(i.message)));
  assert.ok(validateGuestNetwork({ ...g, welcomeMessage: "x".repeat(101) }, inv).some((i) => /over 100/.test(i.message)));
  assert.ok(validateGuestNetwork({ ...g, guestNetworkType: "HostApproval" }, inv).some((i) => /host email domain/.test(i.message)));
  const body = guestNetworkBody({ ...g, walledGardens: ["a.com", " "], redirectUrl: "https://x.example" }, "CP-");
  assert.equal(body.name, "CP-Visitors"); assert.equal(body.type, "guest");
  assert.deepEqual(body.wlan, { ssid: "visitors-wifi", wlanSecurity: "None", vlanId: 1, enabled: true });
  assert.equal(body.guestPortal.guestNetworkType, "GuestPass");
  assert.equal(body.guestPortal.userSessionTimeout, 600);
  assert.deepEqual(body.guestPortal.walledGardens, ["a.com"]);
  assert.equal(body.guestPortal.guestPage.termsAndConditions, "Be nice.");
  assert.equal(body.guestPortal.redirectUrl, "https://x.example");
  const host = guestNetworkBody({ ...g, guestNetworkType: "HostApproval", hostDomains: ["x.com"], hostDurationChoices: ["4", "24"] });
  assert.deepEqual(host.guestPortal.hostGuestConfig, { hostDomains: ["x.com"], hostDurationChoices: [4, 24] });

  const s = await start();
  try {
    const orig = s.fake.client.call;
    s.fake.client.call = async (m, p, b) => { if (m === "POST" && p === "/wifiNetworks") { await orig(m, p, b); return { requestId: "r" }; } return orig(m, p, b); };
    const pv = (await s.post("/api/guest/preview", { guest: g, options: { venueId: "v1" } })).json();
    assert.deepEqual(pv.issues, []);
    assert.deepEqual(pv.willCreate.map((x) => x.kind), ["Wi-Fi network (guest)"]);
    assert.ok(pv.calls.some((c) => /PUT \/venues\/v1\/wifiNetworks/.test(c)));
    assert.equal((await s.post("/api/guest/apply", { guest: g, options: { venueId: "v1" }, hash: "x" })).status, 409);
    const ok = (await s.post("/api/guest/apply", { guest: g, options: { venueId: "v1" }, hash: pv.hash })).json();
    assert.deepEqual(ok.built, ["Visitors"]);
    const post = s.fake.calls.find((c) => c.method === "POST" && c.path === "/wifiNetworks");
    assert.equal(post.body.guestPortal.guestPage.title, "Welcome");
    assert.ok(s.fake.calls.some((c) => c.method === "PUT" && /\/venues\/v1\/wifiNetworks\/net-/.test(c.path)));
  } finally { await s.close(); }
});

test("import: a workflow's look and feel (with its logo) and a guest network are copied", async () => {
  const { importWorkflow, importGuestNetwork } = require("../src/r1import");
  const f = fakeWorkflowApi();
  const wrap = { async call(m, p) {
    p = p.split("?")[0];
    if (p === "/workflows/w1/uiConfigurations") return { welcomeTitle: "Hello", welcomeName: "Guest", uiColorSchema: { headerBarBackgroundColor: "#112233" }, uiStyleSchema: { logoImageFileName: "abc", logoSize: "LARGE", fontName: "Verdana", headerFontSize: 20 } };
    if (p === "/workflows/w1/uiConfigurations/logo") return { fileUrl: "https://files.example/logo" };
    if (m === "GET" && p === "/wifiNetworks/g1") return { id: "g1", name: "Lobby", type: "guest", wlan: { ssid: "lobby", wlanSecurity: "OWE", vlanId: 20 }, guestPortal: { guestNetworkType: "GuestPass", maxDevices: 2, userSessionTimeout: 300, guestPage: { title: "Hi", termsAndConditions: "T&C" }, walledGardens: ["a.com"] } };
    if (m === "GET" && p === "/wifiNetworks/g2") return { id: "g2", name: "Wf", type: "guest", wlan: { ssid: "wf", wlanSecurity: "None" }, guestPortal: { guestNetworkType: "Workflow" } };
    return f.client.call(m, p);
  } };
  const fetchImpl = async () => ({ ok: true, headers: { get: () => "application/octet-stream" }, arrayBuffer: async () => Buffer.from(PNG_B64, "base64") });
  const r = await importWorkflow(wrap, "w1", fetchImpl);
  assert.equal(r.workflow.look.welcomeTitle, "Hello");
  assert.equal(r.workflow.look.colors.headerBarBackgroundColor, "#112233");
  assert.equal(r.workflow.look.colors.buttonColor, "#4A4A4A", "unset colors fall back to R1's defaults");
  assert.deepEqual([r.workflow.look.logoSize, r.workflow.look.fontName, r.workflow.look.headerFontSize], ["LARGE", "Verdana", 20]);
  assert.equal(r.workflow.look.images.logo.type, "image/png", "type comes from the file, not R1's generic header");
  const plain = await importWorkflow(f.client, "w1");
  assert.equal(plain.workflow.look, undefined, "a workflow still on R1's default look carries no look");
  const g = await importGuestNetwork(wrap, "g1");
  assert.deepEqual([g.guest.name, g.guest.ssid, g.guest.wlanSecurity, g.guest.vlanId, g.guest.maxDevices, g.guest.title, g.guest.termsAndConditions, g.guest.walledGardens], ["Lobby (copy)", "", "OWE", 20, 2, "Hi", "T&C", ["a.com"]]);
  assert.match(g.warnings[0], /SSID/);
  const w = await importGuestNetwork(wrap, "g2");
  assert.ok(w.warnings.some((x) => /Workflow network/.test(x)));
  await assert.rejects(importGuestNetwork({ call: async () => ({ type: "psk" }) }, "x"), /not a guest network/);
});

test("guest network is suggested from a Cloudpath voucher workflow, and only from one", async () => {
  const s = await start();
  try {
    const ok = await s.post("/api/guest/prefill", { name: "voucherFlow" });
    assert.equal(ok.status, 200);
    const r = ok.json();
    assert.equal(r.guest.kind, "guestNetwork");
    assert.equal(r.guest.ssid, "voucherFlow-guest");
    assert.equal(r.guest.guestNetworkType, "GuestPass");
    assert.ok(r.notes.some((n) => /voucher list: voucher email & SMS/.test(n)));
    assert.ok(r.notes.some((n) => /SMS or email/.test(n)));
    assert.equal((await s.post("/api/guest/prefill", { name: "Policy only" })).status, 409, "no voucher step, no guest network");
    assert.equal((await s.post("/api/guest/prefill", { name: "nope" })).status, 404);
  } finally { await s.close(); }
});

// ---- logical split (R1 FUNCTIONAL_SPLIT), format read from a split made in the R1 GUI ----
test("logical split: validation, build nodes, and the builder sends the conditions on each branch", async () => {
  const { LOGIC_FIELDS, newCondition } = require("../src/model");
  assert.equal(LOGIC_FIELDS[0][0], "CP_DEVICE_TYPE");
  const inv = { networks: [{ id: "n1", name: "N" }], identityGroups: [{ id: "g1", name: "G" }], workflows: [], dpskPools: [], macPools: [], certTemplates: [], cas: [] };
  const split = newNode("LOGICAL_SPLIT");
  split.options[0].conditions = [{ variable: "CP_DEVICE_TYPE", operation: "EQUALS", value: "phone" }];
  split.options[1].conditions = [{ variable: "CP_DEVICE_OS", operation: "EQUALS", value: "iOS" }];     // a name typed by the user
  const pass = (id) => Object.assign(newNode("PASSPHRASE"), { params: { networkId: "n1", identityGroupId: "g1" }, id });
  split.options[0].steps = [pass("p1")]; split.options[1].steps = [pass("p2")];
  const wf = { name: "Logic", description: "", steps: [split] };
  assert.deepEqual(validate(wf, inv).filter((i) => i.level === "error"), []);
  // problems
  const bad = JSON.parse(JSON.stringify(wf));
  bad.steps[0].options[0].conditions = [];
  bad.steps[0].options[1].conditions = [{ variable: "", operation: "NOPE", value: "" }];
  const msgs = validate(bad, inv).map((i) => i.message).join(" | ");
  assert.match(msgs, /needs at least one condition/); assert.match(msgs, /has no field/); assert.match(msgs, /unknown comparison/); assert.match(msgs, /no value/);
  assert.ok(validate({ ...wf, steps: [{ ...split, options: [split.options[0]] }] }, inv).some((i) => i.level === "warn" && /single branch/.test(i.message)));

  const bw = toBuildWorkflow(wf, inv);
  assert.equal(bw.steps[0].r1.actionType, "FUNCTIONAL_SPLIT");
  assert.deepEqual(bw.steps[0].options[0].r1.evaluationConditions, [{ sourceActionId: null, variableName: "CP_DEVICE_TYPE", operation: "EQUALS", evaluationRegex: "phone" }]);
  assert.equal(bw.steps[0].options[0].r1.actionType, "FUNCTIONAL_SPLIT_OPTION");

  const fake = fakeR1({}); const calls = fake.calls;
  const b = new Builder({ api: makeApi({ client: fake.client, apply: true, log: () => {} }), crawl: { objects: {} }, mapping: {}, opts: { pollMs: 0 }, log: () => {} });
  const r = await b.buildAll({ workflows: [bw] }, []);
  assert.deepEqual(r.built, ["Logic"]);
  const optActions = calls.filter((c) => c.method === "POST" && c.path === "/enrollmentActions" && c.body.actionType === "FUNCTIONAL_SPLIT_OPTION");
  assert.equal(optActions.length, 2);
  assert.equal(optActions[1].body.evaluationConditions[0].variableName, "CP_DEVICE_OS");
  assert.ok(optActions[0].body.parentActionId, "each branch's action points at the split's action");
  const step = calls.find((c) => c.body && c.body.firstSplitOption);
  assert.equal(step.body.actionDefinitionId, "def-FUNCTIONAL_SPLIT");
  assert.equal(step.body.type, "splitStepDto");
  void newCondition;
});

test("logical split: a split made in the R1 GUI is imported with its conditions", async () => {
  const { importWorkflow } = require("../src/r1import");
  const steps = [{ id: "s0", type: "startStepDto", nextStepId: "s1" }, { id: "s1", type: "splitStepDto", actionType: "FUNCTIONAL_SPLIT", enrollmentActionId: "a1", label: "Logical Split 1" },
    { id: "s2", type: "stepDto", actionType: "CAPTIVE_PORTAL", enrollmentActionId: "a3", nextStepId: "e1" }, { id: "e1", type: "endStepDto" }];
  const actions = { a1: { id: "a1", actionType: "FUNCTIONAL_SPLIT" }, a2: { id: "a2", actionType: "FUNCTIONAL_SPLIT_OPTION", evaluationConditions: [{ sourceActionId: null, variableName: "CP_DEVICE_TYPE", operation: "EQUALS", evaluationRegex: "phone" }] }, a3: { id: "a3", actionType: "CAPTIVE_PORTAL", redirectUrl: "https://x.example" } };
  const client = { async call(m, p) {
    p = p.split("?")[0];
    if (p === "/workflows/w") return { id: "w", name: "a test workflow", startStepId: "s0", status: "VALID" };
    if (p === "/workflows/w/steps") return { content: steps };
    if (p === "/workflows/w/steps/s1/splitOptions") return { content: [{ optionName: "Branch 1", enrollmentActionId: "a2", nextStepId: "s2" }] };
    const a = p.match(/^\/enrollmentActions\/(\w+)$/); if (a) return actions[a[1]];
    throw Object.assign(new Error("404"), { status: 404 });
  } };
  const { workflow, warnings } = await importWorkflow(client, "w");
  assert.deepEqual(outline(workflow.steps), ["LOGICAL_SPLIT: Logical Split 1", '  option "Branch 1"', "    CAPTIVE_PORTAL: Captive portal redirect"]);
  assert.deepEqual(workflow.steps[0].options[0].conditions, [{ variable: "CP_DEVICE_TYPE", operation: "EQUALS", value: "phone" }]);
  assert.deepEqual(warnings, []);
  actions.a2.evaluationConditions[0].sourceActionId = "form-1";
  const again = await importWorkflow(client, "w");
  assert.match(again.warnings[0], /earlier form step/);
});

test("Cloudpath look and feel: defaults carry nothing; titles and customized colors map to R1's look", () => {
  const { lookFromCloudpath } = require("../src/model");
  const base = { templateStyle: "Modern (Ruckus)", webBackgroundColor: "ECECEC", webLineColor: "FFFFFF", webButtonBackgroundColor: "4A4A4A", webButtonFontColor: "FFFFFF", webHeaderTopbarColor: "E57200", webHeaderStartOverColor: "FFFFFF", iconTextColor: "75787B", webHeaderRibbonColor: "000000" };
  assert.equal(lookFromCloudpath(base, "W"), null, "all defaults: nothing to carry over");
  assert.equal(lookFromCloudpath(null, "W"), null);
  const t = lookFromCloudpath({ ...base, welcomeTitle1: "Welcome To", welcomeTitle2: "Sample Corporation" }, "W");
  assert.deepEqual([t.look.welcomeTitle, t.look.welcomeName, t.notes], ["Welcome To", "Sample Corporation", []]);
  const c = lookFromCloudpath({ ...base, webHeaderTopbarColor: "00a651", webButtonBackgroundColor: "112233" }, "My workflow");
  assert.equal(c.look.colors.headerBarBackgroundColor, "#00A651");
  assert.equal(c.look.colors.buttonColor, "#112233");
  assert.equal(c.look.welcomeTitle, "My workflow", "R1 needs a title: the workflow name is used");
  const n = lookFromCloudpath({ ...base, templateStyle: "Classic", htmlTemplateFile: "my.html", bannerImageFile: "logo.png", webAccordionButtonBackgroundColor: "FF0000" }, "W").notes.join(" | ");
  assert.match(n, /"Classic" page style/); assert.match(n, /custom HTML template/); assert.match(n, /banner image \(logo.png\)/); assert.match(n, /no R1 equivalent/);
});

test("every enrollment action gets a unique name (R1 rejects a duplicate action name in the tenant)", async () => {
  const mk = (name) => ({ name, description: "", steps: [newNode("AUP"), Object.assign(newNode("CERT_TEMPLATE"), { params: { mode: "existing", certTemplateId: "t1" } })] });
  const fake = fakeR1();
  const inv = { certTemplates: [{ id: "t1", name: "T", identityGroupId: "g" }] };
  for (const n of ["One", "Two"]) {
    const b = new Builder({ api: makeApi({ client: fake.client, apply: true, log: () => {} }), crawl: { objects: {} }, mapping: {}, opts: { pollMs: 0 }, log: () => {} });
    await b.buildAll({ workflows: [toBuildWorkflow(mk(n), inv)] }, []);
  }
  const names = fake.calls.filter((c) => c.method === "POST" && c.path === "/enrollmentActions").map((c) => c.body.name);
  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4, names.join(", "));
  assert.ok(names.every((x) => x.length <= 100));
  assert.match(names[0], /^Acceptable use policy-[0-9a-f]{6}$/);
});

test("import: a workflow with more than one page of steps is read completely", async () => {
  const { importWorkflow } = require("../src/r1import");
  // 13 steps in a chain: R1 returns 10 per page unless asked for more
  const N = 12, steps = [{ id: "s0", type: "startStepDto", nextStepId: "s1" }];
  for (let i = 1; i <= N; i++) steps.push({ id: "s" + i, type: "stepDto", actionType: "DISPLAY_MESSAGE", enrollmentActionId: "a", nextStepId: i < N ? "s" + (i + 1) : "e" });
  steps.push({ id: "e", type: "endStepDto" });
  const seen = [];
  const client = { async call(m, p) {
    seen.push(p);
    if (p === "/workflows/w") return { id: "w", name: "Long", startStepId: "s0", status: "VALID" };
    const q = p.match(/^\/workflows\/w\/steps\?page=(\d+)&size=(\d+)$/);
    if (p === "/workflows/w/steps" || q) { const page = q ? Number(q[1]) : 0, size = q ? Number(q[2]) : 10; const content = steps.slice(page * size, page * size + size); return { content, paging: { totalCount: steps.length, page, pageSize: size, pageCount: Math.ceil(steps.length / size) } }; }
    if (p === "/enrollmentActions/a") return { id: "a", actionType: "DISPLAY_MESSAGE", title: "t", messageHtml: "m" };
    throw Object.assign(new Error("404"), { status: 404 });
  } };
  const { workflow } = await importWorkflow(client, "w");
  assert.equal(workflow.steps.length, N, "all 12 steps copied, not just the first page of 10");
  assert.ok(seen.some((p) => /size=100/.test(p)), "it asks for a big page");
  // and if a server insisted on small pages, it still reads them all
  const small = { async call(m, p) { const q = p.match(/^(\/workflows\/w\/steps)\?page=(\d+)&size=\d+$/); if (q) { const page = Number(q[2]), size = 5; return { content: steps.slice(page * size, page * size + size), paging: { totalCount: steps.length, page, pageSize: size, pageCount: Math.ceil(steps.length / size) } }; } return client.call(m, p); } };
  assert.equal((await importWorkflow(small, "w")).workflow.steps.length, N);
});

// ---- visitor walkthrough engine ("Try it") ----
test("walkthrough: steps run in order, back works, choices and logical splits pick branches, paths end", () => {
  const sim = require("../src/sim");
  const aup = newNode("AUP"), msg = newNode("DISPLAY_MESSAGE"), dpsk = newNode("DPSK"), pass = newNode("PASSPHRASE");
  const choice = newNode("USER_SELECTION_SPLIT"); choice.options[0].steps = [dpsk]; choice.options[1].steps = [pass];
  const logical = newNode("LOGICAL_SPLIT");
  logical.options[0].conditions = [{ variable: "CP_DEVICE_TYPE", operation: "EQUALS", value: "phone" }]; logical.options[0].steps = [choice];
  logical.options[1].conditions = [{ variable: "CP_DEVICE_TYPE", operation: "EQUALS", value: "tablet" }, { variable: "CP_DEVICE_OS", operation: "EQUALS", value: "iOS" }]; logical.options[1].steps = [msg];
  const wf = { name: "W", steps: [aup, logical] };
  assert.deepEqual(sim.simVariables(wf).sort(), ["CP_DEVICE_OS", "CP_DEVICE_TYPE"]);

  let s = sim.simStart(wf);
  assert.equal(sim.simCurrent(s), aup);
  sim.simAdvance(s, undefined, {});
  assert.equal(sim.simCurrent(s), logical);
  // phone -> branch 1 -> the choice
  let r = sim.simAdvance(s, undefined, { CP_DEVICE_TYPE: "Phone" });
  assert.equal(r.branch.name, "Branch 1"); assert.match(r.branch.because[0], /CP_DEVICE_TYPE equals phone/);
  assert.equal(sim.simCurrent(s), choice);
  sim.simAdvance(s, 1, {});                        // picks option 2
  assert.equal(sim.simCurrent(s), pass);
  sim.simAdvance(s, undefined, {});
  assert.equal(sim.simCurrent(s), null); assert.equal(s.ended.reason, "end");
  assert.deepEqual(s.trail.map((n) => n.type), ["AUP", "LOGICAL_SPLIT", "USER_SELECTION_SPLIT", "PASSPHRASE"]);
  // back steps through history, including past the end
  assert.ok(sim.simBack(s)); assert.equal(sim.simCurrent(s), pass);
  assert.ok(sim.simBack(s)); assert.equal(sim.simCurrent(s), choice);
  assert.ok(sim.simBack(s)); assert.equal(sim.simCurrent(s), logical);
  // tablet needs BOTH conditions (an assumption the tab states); tablet without iOS matches nothing
  r = sim.simAdvance(s, undefined, { CP_DEVICE_TYPE: "tablet", CP_DEVICE_OS: "Android" });
  assert.equal(r.branch, null); assert.equal(s.ended.reason, "nomatch");
  assert.ok(sim.simBack(s));
  r = sim.simAdvance(s, undefined, { CP_DEVICE_TYPE: "tablet", CP_DEVICE_OS: "ios" });
  assert.equal(r.branch.name, "Branch 2"); assert.equal(sim.simCurrent(s), msg);
  // a message that ends the session
  msg.params.killSession = true;
  sim.simAdvance(s, undefined, {});
  assert.equal(s.ended.reason, "session");
  assert.equal(sim.simBack(new (class { constructor() { Object.assign(this, sim.simStart(wf)); } })()), false, "nothing to go back to at the start");
  // sample passphrases are stable per seed and follow the format
  assert.equal(sim.simSample("NUMBERS_ONLY", 8, "a"), sim.simSample("NUMBERS_ONLY", 8, "a"));
  assert.match(sim.simSample("NUMBERS_ONLY", 8, "a"), /^\d{8}$/);
  assert.equal(sim.simSample("MOST_SECURED", 12, "b").length, 12);
  assert.notEqual(sim.simSample("MOST_SECURED", 12, "b"), sim.simSample("MOST_SECURED", 12, "c"));
});

test("logical split comparisons: all eight R1 operators are offered and evaluated", () => {
  const { LOGIC_OPS } = require("../src/model");
  const sim = require("../src/sim");
  assert.deepEqual(LOGIC_OPS.map((o) => o[0]).sort(), ["CONTAINS", "DOES_NOT_CONTAIN", "DOES_NOT_EQUAL", "ENDS_WITH", "EQUALS", "IS", "IS_NOT", "STARTS_WITH"]);
  const dev = { OS: "iOS 17.2" };
  const t = (op, v) => sim.condMatches({ variable: "OS", operation: op, value: v }, dev);
  assert.deepEqual([t("EQUALS", "ios 17.2"), t("IS", "iOS 17.2"), t("EQUALS", "iOS")], [true, true, false]);
  assert.deepEqual([t("DOES_NOT_EQUAL", "android"), t("IS_NOT", "iOS 17.2")], [true, false]);
  assert.deepEqual([t("CONTAINS", "17"), t("DOES_NOT_CONTAIN", "17"), t("STARTS_WITH", "ios"), t("ENDS_WITH", "17.2"), t("ENDS_WITH", "iOS")], [true, false, true, true, false]);
  assert.equal(t("NOPE", "x"), false);
  // an unknown comparison is rejected by validation
  const n = newNode("LOGICAL_SPLIT"); n.options[0].conditions = [{ variable: "V", operation: "MATCHES", value: "x" }];
  assert.ok(validate({ name: "N", steps: [n] }, {}).some((i) => /unknown comparison/.test(i.message)));
});
