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
