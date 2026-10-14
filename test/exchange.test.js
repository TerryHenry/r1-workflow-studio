const test = require("node:test");
const assert = require("node:assert");
const m = require("../src/model");
const sim = require("../src/sim");
const { exportFile, importFile, FORMAT } = require("../src/exchange");
const { samples } = require("../src/samples");
const { coverage, html, csv, CATALOG } = require("../src/coverage");
const crawl = require("./fixtures/crawl.json");

const inv = { dpskPools: [], macPools: [], certTemplates: [], cas: [], networks: [], workflows: [], identityGroups: [] };
const walkAll = (steps, fn) => { for (const n of steps) { fn(n); for (const o of n.options || []) walkAll(o.steps, fn); } };

test("export then import gives back the same workflow (new ids, same steps, conditions and look)", () => {
  for (const s of samples()) {
    const out = exportFile(s.workflow, new Date("2026-10-14T00:00:00Z"));
    assert.match(out.filename, /\.workflow\.json$/);
    const j = JSON.parse(out.text);
    assert.equal(j.format, FORMAT); assert.equal(j.kind, "workflow");
    const back = importFile(out.text, out.filename);
    assert.equal(back.kind, "workflow");
    assert.deepEqual(m.outline(back.model.steps), m.outline(s.workflow.steps), s.name);
    assert.equal(back.model.name, s.workflow.name);
    const ids = new Set(); let n = 0;
    walkAll(back.model.steps, (x) => { ids.add(x.id); n++; });
    assert.equal(ids.size, n, "ids are unique");
    walkAll(s.workflow.steps, (x) => assert.ok(!ids.has(x.id), "ids are fresh"));
    assert.deepEqual(m.validate(back.model, inv).map((i) => i.message), m.validate(s.workflow, inv).map((i) => i.message));
  }
  const school = samples().find((x) => x.id === "school").workflow;
  assert.deepEqual(importFile(exportFile(school).text).model.look, school.look);
  const dev = samples().find((x) => x.id === "by-device").workflow;
  const split = importFile(exportFile(dev).text).model.steps.find((x) => x.type === "LOGICAL_SPLIT");
  assert.deepEqual(split.options.map((o) => o.conditions[0].value), ["Desktop", "Mobile"]);
  const st = sim.simStart({ steps: [split] }); sim.simAdvance(st, undefined, { CP_DEVICE_TYPE: "Mobile" });
  assert.equal(st.stack[st.stack.length - 1].nodes[0].type, "DPSK");
});

test("certificate templates and guest networks round-trip too", () => {
  const t = { ...m.blankTemplate(), name: "Staff cert", caId: "ca1", commonNamePattern: "$(USERNAME)@x.com", validityValue: 2 };
  const bt = importFile(exportFile(t).text);
  assert.equal(bt.kind, "certTemplate"); assert.deepEqual(bt.model, t); assert.ok(bt.warnings.some((w) => /authority/.test(w)));
  const g = { ...m.blankGuestNetwork(), name: "Lobby", ssid: "Lobby-Guest", walledGardens: ["a.example.com"], maxDevices: 3, endOfDayReauthDelay: true };
  const bg = importFile(exportFile(g).text);
  assert.equal(bg.kind, "guestNetwork"); assert.deepEqual(bg.model, g);
});

test("a saved draft (a bare workflow) opens too", () => {
  const r = importFile(JSON.stringify(samples()[0].workflow));
  assert.equal(r.kind, "workflow"); assert.ok(r.warnings.some((w) => /draft/.test(w)));
});

test("files are not trusted: bad shapes are refused, unknown steps become placeholders, extra fields are dropped", () => {
  for (const [text, re] of [["", /empty/], ["{nope", /JSON/], ["[]", /isn't a workflow/], ['{"x":1}', /isn't a file from this tool/],
    [JSON.stringify({ format: FORMAT, version: 99, kind: "workflow", data: {} }), /newer version/], [JSON.stringify({ format: FORMAT, version: 1, kind: "toaster", data: {} }), /doesn't say what it holds/],
    [JSON.stringify({ format: FORMAT, version: 1, kind: "workflow" }), /no content/]]) assert.throws(() => importFile(text), re);
  const evil = { format: FORMAT, version: 1, kind: "workflow", data: { name: "x".repeat(500), __proto__: { polluted: 1 }, evil: "<script>", steps: [
    { id: "same", type: "AUP", name: "A", params: { title: "Hi", secretExtra: "drop me", messageHtml: "m" }, hax: 1 },
    { id: "same", type: "TELEPORT", name: "Mystery", params: { a: 1 } },
    { type: "USER_SELECTION_SPLIT", name: "S", params: {}, options: [{ name: "One", steps: [{ type: "DPSK", name: "D", params: { mode: "new", newName: "P" } }] }] }] } };
  const r = importFile(JSON.stringify(evil));
  assert.equal(r.model.name.length, 100); assert.equal(r.model.evil, undefined); assert.equal({}.polluted, undefined);
  assert.equal(r.model.steps[0].params.secretExtra, undefined); assert.equal(r.model.steps[0].hax, undefined);
  assert.equal(r.model.steps[1].type, m.PLACEHOLDER); assert.ok(r.warnings.some((w) => /TELEPORT/.test(w)));
  assert.notEqual(r.model.steps[0].id, "same"); assert.notEqual(r.model.steps[0].id, r.model.steps[1].id);
  assert.equal(r.model.steps[2].options[0].steps[0].params.newName, "P");
  assert.ok(m.validate(r.model, inv).some((i) => /no R1 equivalent/.test(i.message)), "placeholders still block applying");
  // size and depth limits
  const deep = (n) => (n ? [{ type: "USER_SELECTION_SPLIT", name: "d", options: [{ name: "o", steps: deep(n - 1) }] }] : []);
  assert.throws(() => importFile(JSON.stringify({ format: FORMAT, version: 1, kind: "workflow", data: { name: "d", steps: deep(30) } })), /too deeply/);
  const many = Array.from({ length: 600 }, (_, i) => ({ type: "AUP", name: "a" + i, params: {} }));
  assert.throws(() => importFile(JSON.stringify({ format: FORMAT, version: 1, kind: "workflow", data: { name: "m", steps: many } })), /more than 500/);
});

test("objects in a file are listed as a warning, because their ids belong to another tenant", () => {
  const wf = { name: "Pool", steps: [Object.assign(m.newNode("DPSK", "D"), { params: { ...m.newNode("DPSK").params, mode: "existing", dpskPoolId: "abc123" } })] };
  const r = importFile(exportFile(wf).text);
  assert.ok(r.warnings.some((w) => /by id/.test(w)));
  assert.ok(m.validate(r.model, inv).some((i) => /pool/i.test(i.message)), "the editor flags the missing pool");
});

test("coverage chart: counts come from the crawl, the page has no scripts, and the CSV is safe to open", () => {
  const d = coverage(crawl, {});
  const steps = d.totals.converts + d.totals.mapping + d.totals.partial + d.totals.none;
  assert.ok(steps > 0 && d.workflows.length === crawl.workflows.length);
  assert.equal(d.workflows.reduce((a, w) => a + w.total, 0), steps);
  let counted = 0; for (const r of d.rows) if (r.group === "Workflow steps") counted += r.count;
  assert.equal(counted, steps, "every crawled step is in exactly one row");
  const page = html(d, { csvHref: "/coverage.csv" });
  assert.ok(!/<script/i.test(page)); assert.match(page, /Partly converts/); assert.match(page, /No equivalent/);
  assert.ok(CATALOG.every((r) => r.cloudpath && r.r1 && r.note && ["converts", "mapping", "partial", "none", "unread"].includes(r.status) && ["live", "docs", "assumed", "not crawled"].includes(r.evidence)));
  const c = csv({ ...d, rows: [{ ...d.rows[0], cloudpath: "=HYPERLINK(\"x\")" }, ...d.rows.slice(1)] });
  assert.ok(c.includes("'=HYPERLINK"));
  const none = coverage(null);
  assert.equal(none.hasCrawl, false); assert.ok(html(none).includes("No Cloudpath crawl is loaded"));
});

test("voucher sign-ins convert automatically: a voucher-only workflow is one guest network, a voucher branch moves out to a companion", async () => {
  const { voucherOnly, guestFromPlan, validateGuestNetwork } = require("../src/model");
  const voucherFlow = crawl.workflows.find((w) => w.name === "voucherFlow"), production = crawl.workflows.find((w) => w.name === "Corporate"), dpsk = crawl.workflows.find((w) => w.name === "personalPassphrase");
  assert.equal(voucherOnly(voucherFlow), true); assert.equal(voucherOnly(production), false, "a voucher inside a choice is not the whole workflow"); assert.equal(voucherOnly(dpsk), false);
  const g = guestFromPlan(voucherFlow);
  assert.equal(g.guest.name, "voucherFlow guest network"); assert.equal(g.guest.guestNetworkType, "GuestPass");
  assert.deepEqual(validateGuestNetwork(g.guest, inv, {}).filter((i) => !/Terms/i.test(i.message)), [], "only the terms text is left for the user");
  // through the server: the list shows the guest network (and no workflow) for voucherFlow, workflow + companion for Corporate
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
  const { createUiServer } = require("../src/ui-server");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2r-v-")); fs.mkdirSync(path.join(root, "ui"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "ui", "index.html"), path.join(root, "ui", "index.html"));
  const server = createUiServer({ client: null, crawl, root }); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const st = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/state" }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }));
    const names = st.cloudpath.map((x) => x.name + (x.kind === "guestNetwork" ? " [guest]" : ""));
    assert.ok(names.includes("voucherFlow guest network [guest]") && !names.includes("voucherFlow"));
    assert.ok(names.includes("Corporate") && names.includes("Corporate guest network [guest]"));
    const comp = st.cloudpath.find((x) => x.name === "Corporate guest network");
    assert.ok(comp._notes.some((n) => /voucher branch/.test(n)));
    assert.ok(st.cloudpath.find((x) => x.name === "Corporate")._notes.some((n) => /guest network/.test(n)));
    const only = st.cloudpath.find((x) => x.name === "voucherFlow guest network");
    assert.ok(only._notes.some((n) => /Converted automatically/.test(n)));
  } finally { await new Promise((r) => server.close(r)); }
  const cov = coverage(crawl, {});
  assert.equal(cov.rows.find((r) => r.id === "oob").status, "converts");
});

test("message and form steps convert; redirect, social login and shared passphrase are explained, not 'unknown'", () => {
  const { convertAll } = require("../src/convert");
  const step = (kind, fields, extra = {}) => ({ kind, number: "1", label: kind, links: [], fields, ...extra });
  const wf = { pk: 1, name: "New kinds", steps: [
    step("aup", { name: "A", title: "t" }),
    step("dataPrompt", { name: "Details", title: "Your details", prompt1Variable: "Username", prompt2Variable: "Email", prompt3Label: "Room", prompt3Variable: "Room", prompt4Variable: "Phone" }),
    step("dataPrompt", { name: "Login", prompt1Variable: "Username", prompt2Variable: "Password" }),
    step("message", { name: "Done", title: "DPSK has been Created", messageHtml: "Join CVG and use $DPSK", displayContinueButton: "0", displayBackButton: "1", killSession: "0", backButtonText: "", continueButtonText: "" }),
    step("redirect", { name: "Go", "workflowEmbeddableRedirect.redirectUrl": "https://example.com", "workflowEmbeddableRedirect.killSession": "1" }),
    step("oauth", { name: "Google" }), step("ss", { name: "Crew", sharedSecret: "[removed]" }), step("mystery", { name: "?" }),
  ] };
  const plan = convertAll({ workflows: [wf], objects: {} }, {}).workflows[0];
  const by = Object.fromEntries(plan.steps.map((s) => [s.cloudpath.kind + (s.cloudpath.name === "Login" ? "-login" : ""), s]));
  assert.equal(by.message.support, "auto"); assert.equal(by.message.r1.actionType, "DISPLAY_MESSAGE");
  assert.equal(by.message.r1.displayContinueButton, false); assert.equal(by.message.r1.backButtonText, "Back");
  assert.ok(by.message.notes.some((n) => /\$DPSK/.test(n)), "Cloudpath variables are flagged");
  const dp = by.dataPrompt; assert.equal(dp.support, "auto");
  assert.deepEqual(dp.r1.variables.map((v) => v.type), ["USER_NAME", "EMAIL", "INPUT_FIELD_1", "PHONE"]);
  assert.equal(by["dataPrompt-login"].support, "manual"); assert.ok(by["dataPrompt-login"].notes.some((n) => /password/.test(n)));
  for (const k of ["redirect", "oauth"]) { assert.equal(by[k].support, "manual"); assert.ok(!/not known/.test(by[k].notes.join(" ")), k + " has its own explanation"); }
  assert.equal(by.ss.r1.actionType, "PASSPHRASE", "a shared-passphrase prompt becomes R1's 'Give the network's passphrase'"); assert.equal(by.ss.support, "mapping");
  assert.match(by.redirect.notes[0], /https:\/\/example\.com/); assert.match(by.redirect.notes[0], /ends the session/);
  assert.match(by.mystery.notes[0], /not known/);
  const model = require("../src/model").fromPlan(plan, inv, {});
  const types = model.steps.map((n) => n.type);
  assert.deepEqual(types.slice(0, 3), ["AUP", "DATA_PROMPT", "DISPLAY_MESSAGE"].slice(0, 2).concat(["UNSUPPORTED"]));
  assert.equal(model.steps.find((n) => n.type === "DISPLAY_MESSAGE").params.title, "DPSK has been Created");
  assert.equal(model.steps.find((n) => n.type === "DATA_PROMPT").params.variables.length, 4);
  // the chart counts every step, including a type it has never seen
  const cov = coverage({ workflows: [wf], objects: {} }, {});
  assert.equal(cov.rows.filter((r) => r.group === "Workflow steps").reduce((a, r) => a + (r.count || 0), 0), cov.totals.converts + cov.totals.mapping + cov.totals.partial + cov.totals.none);
  assert.ok(cov.rows.some((r) => /mystery/.test(r.cloudpath)));
});

test("a path with a DPSK step then a message then a hand-over ends there (one onboarding step per path)", () => {
  const { convertAll } = require("../src/convert");
  const wf = { pk: 2, name: "Onboard once", steps: [
    { kind: "dpsk", number: "1", label: "d", links: [], fields: { accountDpskPoolPk: "P", name: "d" } },
    { kind: "message", number: "2", label: "m", links: [], fields: { name: "m", title: "Done", messageHtml: "ok" } },
    { kind: "output", number: "3", label: "Move user to Net", links: [], fields: { "networkSourceSelection.source": "EXISTING", "networkSourceSelection.existingPk": "Net" } }] };
  const plan = convertAll({ workflows: [wf], objects: {} }, {}).workflows[0];
  const model = require("../src/model").fromPlan(plan, inv, {});
  assert.deepEqual(model.steps.map((n) => n.type), ["DPSK", "DISPLAY_MESSAGE"]);
});

test("secrets are never kept in a crawl: removed on the way in, from saved files, and by the crawler script", () => {
  const { redact } = require("../src/crawls");
  const raw = { source: "x", workflows: [{ name: "w", steps: [{ kind: "ss", fields: { sharedSecret: "example-secret", sharedSecretDescription: "Shared", rotationSchedule: { value: "NONE" } } },
    { kind: "oauth", fields: { googleSecret: "abc", googleApiKey: "def", custom1AccessTokenEndpoint: "https://x/token", defaultPassword: "test", passwordDescription: "Password", prompt2Variable: "Password" } }] }] };
  const r = redact(raw);
  const f = r.crawl.workflows[0].steps.map((s) => s.fields);
  assert.equal(r.removed, 4);
  assert.deepEqual([f[0].sharedSecret, f[1].googleSecret, f[1].googleApiKey, f[1].defaultPassword], ["[removed]", "[removed]", "[removed]", "[removed]"]);
  assert.equal(f[0].sharedSecretDescription, "Shared"); assert.equal(f[1].custom1AccessTokenEndpoint, "https://x/token"); assert.equal(f[1].prompt2Variable, "Password"); assert.equal(f[1].passwordDescription, "Password");
  const tipped = redact({ workflows: [{ name: "w", steps: [{ kind: "ss", links: [{ text: "Prompt", tooltip: "Shared secret: example-secret\nMore: fine" }] }] }] });
  assert.equal(tipped.crawl.workflows[0].steps[0].links[0].tooltip, "Shared secret: [removed]\nMore: fine"); assert.equal(tipped.removed, 1);
  const again = redact(tipped.crawl); assert.equal(again.removed, 0, "an already-redacted tooltip is left alone"); assert.equal(again.crawl.workflows[0].steps[0].links[0].tooltip, "Shared secret: [removed]\nMore: fine");
  assert.equal(raw.workflows[0].steps[0].fields.sharedSecret, "example-secret", "works on a copy");
  assert.equal(redact(r.crawl).removed, 0, "idempotent");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2r-r-")); fs.mkdirSync(path.join(root, "data", "crawls"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "crawl.json"), JSON.stringify(raw)); fs.writeFileSync(path.join(root, "data", "crawls", "a.json"), JSON.stringify(raw));
  assert.equal(require("../src/crawls").redactSaved(root), 2);
  assert.ok(!fs.readFileSync(path.join(root, "data", "crawl.json"), "utf8").includes("example-secret"));
  assert.ok(!fs.readFileSync(path.join(root, "data", "crawls", "a.json"), "utf8").includes("example-secret"));
  const script = require("../src/crawlscript").buildBrowserScript(path.join(__dirname, ".."));
  assert.match(script, /fields\[n\] = redact\(n, e\.value\)/); assert.match(script, /tooltip: tip\(/);
});

test("a big Cloudpath instance: the chart says how many were read of how many exist and folds the long list", () => {
  const many = { ...crawl, listed: 350, workflows: Array.from({ length: 45 }, (_, i) => ({ ...crawl.workflows[0], name: "W" + i })) };
  const d = coverage(many, {});
  assert.equal(d.listed, 350);
  const page = html(d, {});
  assert.match(page, /Cloudpath lists 350; the rest were not read/); assert.match(page, /<details><summary>Show the other 15 workflows/);
  assert.ok(!/<details>/.test(html(coverage(crawl, {}), {})), "a small instance shows everything");
});

test("a credentials step says which user source it uses: Cloudpath's internal database is testing-only, a directory maps to LDAP", () => {
  const { convertAll } = require("../src/convert");
  const { fromPlan, validate } = require("../src/model");
  const mk = (type, label, tip) => ({ kind: "credprompt", number: "1", label, fields: {}, links: [{ text: "x", href: "x", tooltip: "Credential Prompt\nLogin" }, { text: "y", href: "y", tooltip: tip }] });
  const wf = { pk: 3, name: "Creds", steps: [mk("db", "Prompt the user for credentials from Lab-DB", "Onboard Database \nUsers: 12"), mk("ad", "Prompt the user for credentials from Ruckus Demo AD", "Active Directory\nDefault Domain:  d.example.com\nHost:  ldap://10.1.1.1\nDN:  dc=d")] };
  const plan = convertAll({ workflows: [wf], objects: {} }, {}).workflows[0];
  const [db, ad] = plan.steps;
  assert.equal(db.ref.userSource, "onboard"); assert.equal(ad.ref.userSource, "directory");
  assert.match(db.notes[0], /Lab-DB/); assert.match(db.notes[0], /testing only/); assert.match(db.notes[0], /not meant to be used in production/);
  assert.match(ad.notes[0], /Active Directory/); assert.match(ad.notes[0], /ldap:\/\/10\.1\.1\.1/); assert.ok(!/testing only/.test(ad.notes[0]));
  const model = fromPlan(plan, inv, {});
  const probs = validate({ ...model, steps: [model.steps[0]] }, inv).map((i) => i.message).join(" ");
  assert.match(probs, /internal \(Onboard\) user database/); assert.match(probs, /testing only/); assert.match(probs, /should not be used in production/);
  assert.match(validate({ ...model, steps: [model.steps[1]] }, inv).map((i) => i.message).join(" "), /checks users against a directory/);
  // survives export and import
  assert.equal(importFile(exportFile(model).text).model.steps[0].source.userSource, "onboard");
  const cov = coverage({ workflows: [wf], objects: {} }, {});
  assert.equal(cov.rows.find((r) => r.id === "credprompt-onboard").count, 1); assert.equal(cov.rows.find((r) => r.id === "credprompt").count, 1);
});

test("sponsor requests, voucher entry, device name and notifications are converted, not 'unknown'", () => {
  const { convertAll } = require("../src/convert");
  const { fromPlan, guestFromPlan, voucherOnly, validateGuestNetwork, validate } = require("../src/model");
  const step = (kind, fields, label = kind, links = []) => ({ kind, number: "1", label, links, fields });
  // sponsor request -> host approval guest network
  const req = { pk: 1, name: "Sponsor", steps: [step("aup", { name: "A" }), step("req", { name: "Ask", sponsorType: "Dropdown List", availableSponsors: "a@example.org; b@Example.com; c@example.org", defaultAccessDays: "1", maxAccessDays: "7" }, "Request access from sponsor using Ask."), step("output", {}, "Move user to Net.")] };
  assert.equal(voucherOnly(req), true);
  const g = guestFromPlan(req);
  assert.equal(g.guest.guestNetworkType, "HostApproval");
  assert.deepEqual(g.guest.hostDomains, ["example.org", "example.com"]); assert.deepEqual(g.guest.hostDurationChoices, ["24", "168"]);
  assert.deepEqual(validateGuestNetwork(g.guest, inv, {}).filter((i) => !/Terms/i.test(i.message)), []);
  assert.ok(g.notes.some((n) => /anyone at example\.org, example\.com can approve/.test(n)));
  const regex = guestFromPlan({ pk: 2, name: "R", steps: [step("oobreq", { sponsorType: "Text Entry", defaultSponsorEmail: "@example.org", sponsorRegex: ".*@example.org", defaultAccessDays: "1" })] });
  assert.deepEqual(regex.guest.hostDomains, ["example.org"]);
  // voucher entry (otp) is a guest pass, like oob
  const otp = { pk: 3, name: "Voucher", steps: [step("aup", {}), step("otp", { promptText: "Enter the voucher from the club house" }, "Prompt the user for a voucher from Club House List."), step("output", {}, "Move user to Net.")] };
  assert.equal(voucherOnly(otp), true); const go = guestFromPlan(otp);
  assert.equal(go.guest.guestNetworkType, "GuestPass"); assert.match(go.guest.welcomeMessage, /club house/); assert.ok(go.notes[0].includes("Club House List"));
  assert.equal(voucherOnly({ steps: [step("aup", {}), step("dpsk", {}), step("otp", {})] }), false, "a voucher next to a DPSK step is not the whole workflow");
  // a sponsor branch inside a choice moves out, like a voucher branch
  const mixed = { pk: 4, name: "Mixed", steps: [step("selection", { name: "Who" }, "Who", []), ] };
  mixed.steps[0].options = [{ name: "Guests", steps: [step("oobreq", { sponsorType: "Static", defaultSponsorEmail: "x@y.com" }), step("output", {}, "Move user to N.")] }, { name: "Staff", steps: [step("dpsk", { accountDpskPoolPk: "P", name: "d" })] }, { name: "Other", steps: [step("dpsk", { accountDpskPoolPk: "P", name: "d2" })] }];
  const mm = fromPlan(convertAll({ workflows: [mixed], objects: {} }, {}).workflows[0], inv, {});
  assert.equal(mm.steps[0].options.length, 2); assert.ok(mm.source.notes.some((n) => /voucher or sponsor sign-in/.test(n)));
  // device name prompt
  const dn = convertAll({ workflows: [{ pk: 5, name: "D", steps: [step("deviceName", { name: "Name it", title: "What are you using" }, "Prompt the user to name their device and remove old devices.", [{ text: "x", href: "x", tooltip: "Device Name Prompt\nName it\nMaximum Devices: 3\n" }])] }], objects: {} }, {}).workflows[0].steps[0];
  assert.equal(dn.support, "auto"); assert.equal(dn.r1.actionType, "DATA_PROMPT"); assert.equal(dn.r1.variables[0].label, "Device name"); assert.match(dn.notes[0], /3 devices/); assert.match(dn.notes[0], /Devices per passphrase/);
  // notifications: to the user after a DPSK step -> the DPSK step's switches; to an administrator, or with no DPSK step -> explained placeholder
  const note = (m, data) => step("notification", { name: "N", notificationMethod: m, notificationMethodData: data || "" }, "Send a notification using N.");
  const dpsk = step("dpsk", { accountDpskPoolPk: "Pool", name: "Give" });
  const n1 = fromPlan(convertAll({ workflows: [{ pk: 6, name: "N1", steps: [dpsk, step("output", {}, "Move user to Net."), note("Send user an email and SMS.")] }], objects: {} }, {}).workflows[0], inv, {});
  assert.deepEqual(n1.steps.map((s) => s.type), ["DPSK"]); assert.equal(n1.steps[0].params.emailNotification, true); assert.equal(n1.steps[0].params.smsNotification, true);
  assert.ok(n1.source.notes.some((n) => /became the “Email the passphrase” and “Text the passphrase” switch/.test(n)));
  const n2 = fromPlan(convertAll({ workflows: [{ pk: 7, name: "N2", steps: [dpsk, note("Send administrator an email.", "boss@example.com")] }], objects: {} }, {}).workflows[0], inv, {});
  assert.deepEqual(n2.steps.map((s) => s.type), ["DPSK", "UNSUPPORTED"]); assert.match(n2.steps[1].source.notes[0], /boss@example\.com/); assert.match(n2.steps[1].source.notes[0], /no step that notifies an administrator/);
  const n3 = fromPlan(convertAll({ workflows: [{ pk: 8, name: "N3", steps: [note("Send user an SMS.")] }], objects: {} }, {}).workflows[0], inv, {});
  assert.equal(n3.steps[0].type, "UNSUPPORTED"); assert.ok(validate(n3, inv).some((i) => /no R1 equivalent/.test(i.message)));
});

test("every step type the converter knows has a row in the chart (none falls back to 'unknown')", () => {
  const { convertAll } = require("../src/convert");
  const kinds = ["aup", "dpsk", "selection", "registration", "output", "oob", "otp", "req", "oobreq", "credprompt", "concurrent", "message", "dataPrompt", "redirect", "oauth", "ss", "notification", "deviceName"];
  const wf = { pk: 1, name: "All", steps: kinds.map((k) => ({ kind: k, number: "1", label: k === "output" ? "Assign a device configuration and/or certificate." : k, links: [], fields: k === "output" ? {} : { name: k }, ...(k === "selection" ? { options: [] } : {}) })) };
  const cov = coverage({ workflows: [wf], objects: {} }, {});
  assert.deepEqual(cov.rows.filter((r) => /^unknown:/.test(r.id)).map((r) => r.id), []);
  const counted = cov.rows.filter((r) => r.group === "Workflow steps").reduce((a, r) => a + (r.count || 0), 0);
  assert.equal(counted, kinds.length);
  const sum = cov.totals.converts + cov.totals.mapping + cov.totals.partial + cov.totals.none; assert.equal(sum, kinds.length);
  assert.equal(convertAll({ workflows: [wf], objects: {} }, {}).workflows[0].steps.filter((s) => /not known/.test((s.notes || []).join(" "))).length, 0);
});

test("a shared-passphrase prompt becomes 'Give the network's passphrase' where it can stand alone, and is dropped (with a note) where the path already gets access", () => {
  const { convertAll } = require("../src/convert");
  const { fromPlan, validate } = require("../src/model");
  const step = (kind, fields, label = kind) => ({ kind, number: "1", label, links: [], fields });
  const ss = step("ss", { name: "Crew", sharedSecret: "[removed]" }, "Prompt the user for a shared passphrase.");
  const netInv = { ...inv, networks: [{ id: "net-9", name: "Crew-WiFi" }], identityGroups: [{ id: "g1", name: "Crew" }] };
  const out = (cfg) => step("output", { "networkSourceSelection.source": "EXISTING", "networkSourceSelection.existingPk": cfg }, "Move user to " + cfg + ".");
  const conv = (steps, i = inv) => fromPlan(convertAll({ workflows: [{ pk: 1, name: "SS", steps }], objects: {} }, {}).workflows[0], i, {});
  // 1. a plain hand-over follows: the prompt is the access step, the hand-over just ends the path, and a same-named R1 network is chosen
  const a = conv([ss, out("Crew-WiFi")], netInv);
  assert.deepEqual(a.steps.map((s) => s.type), ["PASSPHRASE"]); assert.equal(a.steps[0].params.networkId, "net-9");
  assert.ok(validate(a, netInv).every((i) => !/more than one|only one onboarding/.test(i.message)));
  assert.match(a.steps[0].source.notes[0], /Give the network's passphrase/); assert.match(a.steps[0].source.notes[0], /shared secret was not copied/);
  assert.deepEqual(validate(a, netInv).filter((i) => i.level === "error").map((i) => i.message.replace(/^.*: /, "")), ["Identity group is required."], "only the identity group is left to choose");
  // 2. a DPSK, MAC registration or certificate step also gives access: R1 allows one, so the prompt is dropped and the note says so
  for (const later of [step("dpsk", { accountDpskPoolPk: "P", name: "d" }), step("registration", { name: "L" }), step("output", {}, "Move user to Net and assign certificate using Template.")]) {
    const b = conv([ss, later]);
    assert.ok(!b.steps.some((s) => s.type === "PASSPHRASE"), "no second access step after " + later.kind);
    assert.ok(b.source.notes.some((n) => /R1 allows one access step per path and a later step already gives access/.test(n)));
    assert.deepEqual(validate(b, inv).filter((i) => /only one onboarding/.test(i.message)), []);
  }
  // 3. a redirect follows (not an access step in Cloudpath's sense): the passphrase step stays, the redirect is explained
  const c = conv([ss, step("redirect", { "workflowEmbeddableRedirect.redirectUrl": "https://example.com" }, "Redirect the user based on X.")]);
  assert.deepEqual(c.steps.map((s) => s.type), ["PASSPHRASE", "UNSUPPORTED"]);
});
