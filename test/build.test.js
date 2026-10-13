const test = require("node:test");
const assert = require("node:assert");
const crawl = require("./fixtures/crawl.json");
const { convertAll } = require("../src/convert");
const { Builder, makeApi } = require("../src/build");

const { fakeR1 } = require("./fake-r1");

const plan = (mapping = {}) => convertAll(crawl, mapping);
const run = async (fake, opts, only = [], apply = true) => {
  const logs = [];
  const b = new Builder({ api: makeApi({ client: fake.client, apply, log: (l) => logs.push(l) }), crawl, mapping: {}, opts: { pollMs: 0, ...opts }, log: (l) => logs.push(l) });
  const r = await b.buildAll(plan(), only);
  return { r, logs, b };
};
const writes = (fake) => fake.calls.filter((c) => c.method !== "GET" && !/query/.test(c.path));

test("a workflow with no onboarding action is skipped unless allowed", async () => {
  const f = fakeR1();
  const { r } = await run(f, {}, ["Policy only"]);
  assert.equal(r.built.length, 0);
  assert.match(r.skipped[0].why, /onboarding action/);
  assert.equal(writes(f).length, 0);
});

test("Policy only (allowed): creates the action, the workflow and one step, and leaves it unpublished", async () => {
  const f = fakeR1();
  const { r } = await run(f, { allowInvalid: true }, ["Policy only"]);
  assert.deepEqual(r.built, ["Policy only"]);
  const w = writes(f);
  assert.deepEqual(w.map((c) => c.method + " " + c.path), ["POST /workflows", "POST /enrollmentActions", "POST /workflows/id-1/steps/start-1/nextSteps"]);
  assert.equal(w[1].body.actionType, "AUP");
  assert.equal(w[2].body.actionDefinitionId, "def-AUP");
  assert.equal(w[2].body.enrollmentActionId, "id-2");
  assert.ok(!f.calls.some((c) => c.method === "PATCH"), "must not publish");
});

test("dry run makes no writes", async () => {
  const f = fakeR1();
  const { r } = await run(f, { createMissing: true }, ["personalPassphrase"], false);
  assert.equal(writes(f).length, 0);
  assert.deepEqual(r.built, ["personalPassphrase"]);
});

test("personalPassphrase with createMissing makes group, pool, link and the SSID", async () => {
  const f = fakeR1();
  const { r } = await run(f, { createMissing: true, venueId: "venue-1" }, ["personalPassphrase"]);
  assert.deepEqual(r.built, ["personalPassphrase"]);
  const seq = writes(f).map((c) => c.method + " " + c.path.replace(/(id|net)-\d+/g, (m, k) => (k === "net" ? "net-ID" : "ID")));
  assert.deepEqual(seq.slice(0, 3), ["POST /dpskServices", "POST /wifiNetworks", "PUT /wifiNetworks/net-ID/dpskServices/ID"]);
  assert.ok(!seq.includes("POST /identityGroups"), "R1 makes the pool's own identity group");
  assert.ok(seq.includes("PUT /venues/venue-1/wifiNetworks/net-ID"));
  const pool = writes(f).find((c) => c.path === "/dpskServices").body;
  assert.equal(pool.name, "example-ssid pool");
  assert.equal(pool.passphraseLength, 8);
  assert.equal(writes(f).find((c) => c.path === "/wifiNetworks").body.wlan.ssid, "example-ssid");
});

test("without createMissing a workflow that needs an unmapped pool is skipped and nothing is created", async () => {
  const f = fakeR1();
  const { r } = await run(f, {}, ["personalPassphrase"]);
  assert.equal(r.built.length, 0);
  assert.match(r.skipped[0].why, /DPSK pool/);
  assert.equal(writes(f).length, 0);
});

test("existing pool and network are reused, not recreated", async () => {
  const f = fakeR1({ existing: { dpsk: [{ id: "pool-9", name: "Example-SSID Pool", identityGroupId: "grp-9" }], nets: [{ id: "net-9", ssid: "example-ssid", name: "example-ssid" }] } });
  const { r } = await run(f, { createMissing: true }, ["personalPassphrase"]);
  assert.deepEqual(r.built, ["personalPassphrase"]);
  assert.ok(!writes(f).some((c) => c.path === "/dpskServices" || c.path === "/identityGroups"));
  const action = writes(f).find((c) => c.path === "/enrollmentActions").body;
  assert.equal(action.dpskPoolId, "pool-9");
  assert.equal(action.identityGroupId, "grp-9");
});

test("workflows with rule-based splits or steps with no equivalent are skipped, partial builds drop only the latter", async () => {
  const f = fakeR1();
  const { r } = await run(f, { createMissing: true }, ["capPortal", "voucherFlow", "Corporate"]);
  assert.match(r.skipped.find((s) => s.workflow === "capPortal").why, /rule-based split/);
  assert.match(r.skipped.find((s) => s.workflow === "voucherFlow").why, /no R1 equivalent/);
  const f2 = fakeR1();
  const p = await run(f2, { allowPartial: true }, ["voucherFlow"]);
  assert.ok(p.r.skipped.length === 0 || !/no R1 equivalent/.test(p.r.skipped[0].why));
});

test("a failure part way rolls back only what this run created, newest first", async () => {
  const f = fakeR1({ failOn: (m, p) => m === "POST" && /\/steps\//.test(p) });
  await assert.rejects(run(f, { createMissing: true }, ["personalPassphrase"]), /boom/);
  const dels = f.calls.filter((c) => c.method === "DELETE").map((c) => c.path.replace(/id-\d+/g, "ID"));
  assert.ok(dels.length >= 4, dels.join());
  assert.equal(dels[0].startsWith("/workflows/") || dels[0].startsWith("/enrollmentActions/"), true);
  assert.ok(dels.some((d) => d.startsWith("/dpskServices/")));
  assert.ok(dels.some((d) => d.startsWith("/identityGroups/")));
});

const certCrawl = () => ({ source: "x", cloudpathVersion: "6", workflows: [{ pk: 1, name: "cert", portalUrl: "/enroll/x/", published: true, steps: [
  { kind: "aup", number: "Step 1:", label: "AUP", fields: { name: "AUP" } },
  { kind: "output", number: "Result:", label: "Move user to Example-Net and assign certificate using Guest Policy Templat....",
    fields: { "networkSourceSelection.source": "EXISTING", "networkSourceSelection.existingPk": "Example-Net" },
    links: [{ text: "Guest Policy Templat...", href: "/admin/template/1196/edit",
      tooltip: "Name: Guest Policy Template\nIssuing CA: Example Intermediate CA\nCN Pattern: ${USERNAME}@guest.example.com\nValid Until: +30 Days\n" }] }] }] });

async function runCert(existing, opts) {
  const fake = fakeR1({ existing }); const logs = [];
  const c = certCrawl();
  const b = new Builder({ api: makeApi({ client: fake.client, apply: true, log: (l) => logs.push(l) }), crawl: c, mapping: {}, opts: { pollMs: 0, ...opts }, log: (l) => logs.push(l) });
  const r = await b.buildAll(convertAll(c, {}), []);
  return { fake, r, b };
}

test("certificate template is created from the Cloudpath tooltip under the named CA", async () => {
  const { fake, r } = await runCert({ cas: [{ id: "ca-1", name: "RUCKUS Intermediate CA" }] }, { createMissing: true, ca: "RUCKUS Intermediate CA" });
  assert.deepEqual(r.built, ["cert"]);
  const t = fake.calls.find((c) => c.method === "POST" && c.path === "/certificateAuthorities/ca-1/templates");
  assert.ok(t, "template create call");
  assert.equal(t.body.name, "Guest Policy Template");
  assert.equal(t.body.caType, "ONBOARD");
  assert.equal(t.body.onboard.commonNamePattern, "$(USERNAME)@guest.example.com");
  assert.equal(t.body.onboard.notAfterType, "DAYS");
  assert.equal(t.body.onboard.notAfterValue, 30);
  assert.ok(t.body.identityGroupId);
  const act = fake.calls.find((c) => c.path === "/enrollmentActions" && c.body.actionType === "CERT_TEMPLATE");
  assert.ok(act.body.certTemplateId && act.body.identityGroupId);
});

test("without a matching CA the workflow is skipped with a hint, and nothing is created", async () => {
  const { fake, r } = await runCert({ cas: [{ id: "ca-1", name: "Other CA" }] }, { createMissing: true });
  assert.equal(r.built.length, 0);
  assert.match(r.notes.join(" "), /--ca NAME/);
  assert.ok(!fake.calls.some((c) => c.method === "POST" && /templates$/.test(c.path)));
});

test("a user-selection split: first option goes inside the step, the others are added, each branch gets its step", async () => {
  const c = { source: "x", cloudpathVersion: "6", workflows: [{ pk: 1, name: "splitty", portalUrl: "", published: true, steps: [
    { kind: "selection", number: "Step 1:", label: "x", fields: { name: "Who" }, options: [
      { name: "Visitors", criteria: "This option will be available to all enrollments.", fields: { name: "Visitors" }, steps: [{ kind: "registration", number: "Step 2:", label: "r", fields: { name: "List A", dateValue: "30", staticDerivedDateType: "Minutes After" } }] },
      { name: "Staff", criteria: "This option will be available to all enrollments.", fields: { name: "Staff" }, steps: [{ kind: "registration", number: "Step 2:", label: "r", fields: { name: "List B" } }] }] }] }] };
  const fake = fakeR1({ existing: { mac: [{ id: "m1", name: "List A", identityGroupId: "g1" }, { id: "m2", name: "List B", identityGroupId: "g2" }] } });
  const b = new Builder({ api: makeApi({ client: fake.client, apply: true, log: () => {} }), crawl: c, mapping: {}, opts: { pollMs: 0 }, log: () => {} });
  const r = await b.buildAll(convertAll(c, {}), []);
  assert.deepEqual(r.built, ["splitty"]);
  const step = fake.calls.find((x) => x.body && x.body.firstSplitOption);
  assert.equal(step.body.type, "splitStepDto");
  assert.equal(step.body.firstSplitOption.optionName, "Visitors");
  const extra = fake.calls.filter((x) => x.method === "POST" && /\/splitOptions$/.test(x.path));
  assert.equal(extra.length, 1);
  assert.equal(extra[0].body.optionName, "Staff");
  const branches = fake.calls.filter((x) => /splitOptions\/[^/]+\/nextSteps$/.test(x.path)).map((x) => x.path.split("/")[6]);
  assert.deepEqual(branches.length, 2);
  assert.ok(branches.includes("opt-first"));
});

test("step labels are cut to R1's 32-character limit", async () => {
  const c = certCrawl();
  const fake = fakeR1({ existing: { tpls: [{ id: "t1", name: "Guest Policy Template", identityGroupId: "g1" }] } });
  const b = new Builder({ api: makeApi({ client: fake.client, apply: true, log: () => {} }), crawl: c, mapping: {}, opts: { pollMs: 0 }, log: () => {} });
  await b.buildAll(convertAll(c, {}), []);
  const labels = fake.calls.filter((x) => x.method === "POST" && /nextSteps$/.test(x.path)).map((x) => x.body.label);
  assert.ok(labels.length >= 2 && labels.every((l) => l.length <= 32), labels.join("|"));
});
