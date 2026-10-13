const test = require("node:test");
const assert = require("node:assert");
const { convertWorkflow } = require("../src/convert");

const wf = (steps) => ({ pk: 1, name: "t", steps });
const step = (kind, fields, extra) => ({ kind, number: "Step 1:", label: "", fields, ...extra });

test("AUP converts as is with R1 required fields", () => {
  const r = convertWorkflow(wf([step("aup", { name: "AUP", checkboxDefaultState: "1" })]));
  const a = r.steps[0].r1;
  assert.equal(r.status, "ready");
  assert.equal(a.actionType, "AUP");
  for (const k of ["name", "title", "messageHtml", "checkboxText", "checkboxHighlightColor", "backButtonText", "continueButtonText"]) assert.ok(a[k], k);
  assert.match(a.checkboxHighlightColor, /^#[0-9a-f]{6}$/i);
});

test("DPSK needs a pool mapping until one is given", () => {
  const s = [step("dpsk", { accountDpskPoolPk: "pool1" })];
  assert.equal(convertWorkflow(wf(s)).steps[0].support, "mapping");
  const m = convertWorkflow(wf(s), { dpskPools: { pool1: { dpskPoolId: "p", identityGroupId: "g" } } });
  assert.equal(m.steps[0].support, "auto");
  assert.equal(m.steps[0].r1.dpskPoolId, "p");
});

test("rule-based split is manual, choose-one split is automatic", () => {
  const opt = (criteria) => ({ name: "o", criteria, fields: { name: "o" }, steps: [] });
  const filtered = convertWorkflow(wf([step("selection", { name: "s" }, { options: [opt("This option will only be available to enrollments matching all of the following criteria:\nEmail = a")] })]));
  assert.equal(filtered.steps[0].r1.actionType, "FUNCTIONAL_SPLIT");
  assert.equal(filtered.status, "needs-manual-work");
  const choose = convertWorkflow(wf([step("selection", { name: "s" }, { options: [opt("This option will be available to all enrollments.")] })]));
  assert.equal(choose.steps[0].r1.actionType, "USER_SELECTION_SPLIT");
  assert.equal(choose.steps[0].options[0].r1.actionType, "USER_SELECTION_SPLIT_OPTION");
});

test("verification code and unknown steps are manual", () => {
  const r = convertWorkflow(wf([step("oob", {}), step("mystery", {})]));
  assert.deepEqual(r.steps.map((s) => s.support), ["manual", "manual"]);
});
