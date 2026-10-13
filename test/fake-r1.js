// A fake RUCKUS One for tests: remembers what is created, answers reads, can be told to fail a call.
function fakeR1({ failOn, existing = {} } = {}) {
  const calls = []; let n = 0;
  const store = { options: {}, workflows: [], dpsk: existing.dpsk || [], groups: [], mac: existing.mac || [], nets: existing.nets || [] };
  const client = {
    async call(method, p, body) {
      calls.push({ method, path: p, body });
      if (failOn && failOn(method, p)) throw new Error("boom " + method + " " + p);
      if (method === "GET" && p === "/dpskServices") return store.dpsk;
      if (method === "GET" && p.startsWith("/identityGroups")) return { content: store.groups };
      if (method === "GET" && p.startsWith("/macRegistrationPools")) return { content: store.mac };
      if (method === "POST" && p === "/wifiNetworks/query") return { data: store.nets };
      if (method === "POST" && p.startsWith("/workflows/query")) return { data: store.workflows };
      if (method === "POST" && p.startsWith("/certificateAuthorities/query")) return { data: existing.cas || [] };
      if (method === "POST" && p.startsWith("/venues/query")) return { data: existing.venues || [] };
      if (method === "POST" && p.startsWith("/certificateTemplates/query")) return { data: existing.tpls || [] };
      if (method === "POST" && p.startsWith("/workflowActionDefinitions/query")) return { data: ["AUP", "DPSK", "MAC_REG", "USER_SELECTION_SPLIT", "CERT_TEMPLATE", "PASSPHRASE"].map((t) => ({ actionType: t, id: "def-" + t })) };
      if (method === "GET" && /^\/workflows\/[^/]+$/.test(p)) { if (calls.filter((c) => c.path === p && c.method === "GET").length < 3) { const e = new Error("404"); e.status = 404; throw e; } return { startStepId: "start-1" }; }
      if (method === "GET" && /^\/enrollmentActions\/[^/]+$/.test(p)) return { id: p.split("/").pop() };
      if (method === "GET" && /\/splitOptions$/.test(p)) return { content: (store.options[p.split("/")[4]] || []) };
      if (method === "POST" && /\/steps\/[^/]+\/(nextSteps|splitOptions\/[^/]+\/nextSteps)$/.test(p) && body.firstSplitOption) { const id = "id-" + ++n; store.options[id] = [{ id: "opt-first", optionName: body.firstSplitOption.optionName }]; return { id }; }
      if (method === "POST" && /\/splitOptions$/.test(p)) { const id = "opt-" + ++n; (store.options[p.split("/")[4]] = store.options[p.split("/")[4]] || []).push({ id, optionName: body.optionName }); return { id }; }
      if (method === "POST" && p === "/wifiNetworks") { store.nets.push({ id: "net-" + ++n, ssid: body.wlan.ssid, name: body.name }); return { requestId: "req-1" }; }
      if (method === "GET" && /^\/dpskServices\/[^/]+$/.test(p)) return { id: p.split("/").pop(), identityGroupId: "auto-grp-" + p.split("/").pop() };
      if (method === "POST") return { id: "id-" + ++n };
      return {};
    },
  };
  return { client, calls };
}


module.exports = { fakeR1 };
