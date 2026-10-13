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
