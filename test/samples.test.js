const test = require("node:test");
const assert = require("node:assert");
const m = require("../src/model");
const sim = require("../src/sim");
const { samples } = require("../src/samples");

const inv = { dpskPools: [], macPools: [], certTemplates: [], cas: [], networks: [], workflows: [], identityGroups: [] };

test("samples: only the things the user must supply are flagged", () => {
  const allowed = /Directory server profile id|certificate authority/i;
  for (const s of samples()) {
    const errs = m.validate(s.workflow, inv).filter((i) => i.level === "error");
    assert.ok(errs.every((e) => allowed.test(e.message)), s.name + ": " + errs.map((e) => e.message).join("; "));
    assert.ok(m.toBuildNodes(s.workflow.steps, inv), s.name);
  }
});

test("samples: every path can be walked in Try it", () => {
  for (const s of samples()) {
    const wf = s.workflow;
    const walk = (device, choices) => {
      const st = sim.simStart(wf); let guard = 0, i = 0;
      while (sim.simCurrent(st) && guard++ < 50) { const n = sim.simCurrent(st); sim.simAdvance(st, n.type === "USER_SELECTION_SPLIT" ? choices[i++] : undefined, device); }
      return st;
    };
    if (s.id === "by-device") {
      assert.ok(walk({ CP_DEVICE_TYPE: "Desktop" }, []).trail.some((n) => n.type === "CERT_TEMPLATE"));
      assert.ok(walk({ CP_DEVICE_TYPE: "Mobile" }, []).trail.some((n) => n.type === "DPSK"));
    } else {
      for (let c = 0; c < 2 + (s.id === "school" ? 1 : 0); c++) assert.ok(walk({}, [c]).trail.some((n) => n.type === "DPSK"), s.id + " " + c);
    }
  }
});

test("a split with more than 10 branches is an error (R1 refuses the 11th)", () => {
  const wf = { name: "big", steps: [m.newNode("LOGICAL_SPLIT", "many")] };
  const sp = wf.steps[0];
  sp.options = Array.from({ length: 11 }, (_, i) => ({ ...m.newOption("b" + i), conditions: [{ variable: "CP_DEVICE_OS", operation: "CONTAINS", value: "x" + i }], steps: [] }));
  assert.ok(m.validate(wf, inv).some((i) => /at most 10/.test(i.message)));
  sp.options.length = 10;
  assert.ok(!m.validate(wf, inv).some((i) => /at most 10/.test(i.message)));
});

test("a name that already exists in R1 gets a Rename fix with a free suggestion", () => {
  const wf = { name: "Visitors", steps: [m.newNode("AUP")] };
  const taken = { ...inv, workflows: [{ name: "Visitors" }, { name: "visitors (2)" }] };
  const clash = m.validate(wf, taken).find((i) => /already exists/.test(i.message));
  assert.equal(clash.fix, "rename"); assert.equal(clash.suggest, "Visitors (3)");
  assert.equal(m.freeName("Visitors (2)", ["Visitors (2)", "Visitors (3)"]), "Visitors (4)");
  assert.equal(m.freeName("Lobby", ["P-Lobby (2)"], "P-"), "Lobby (3)");
  const t = m.validateTemplate({ ...m.blankTemplate(), name: "Staff", caId: "" }, { certTemplates: [{ name: "Staff" }] }).find((i) => /already exists/.test(i.message));
  assert.equal(t.fix, "rename"); assert.equal(t.suggest, "Staff (2)");
});
