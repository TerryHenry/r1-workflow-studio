// What the editor needs to know about the RUCKUS One tenant, as plain {id, name, ...} lists for dropdowns and checks.
// Only the fields listed here are kept: certificate authorities in particular come back with private keys, which must
// never reach the browser, the disk or a log.
const rows = (j) => (Array.isArray(j) ? j : (j && (j.data || j.content || j.items || j.results)) || []);

async function loadInventory(client) {
  const out = { venues: [], dpskPools: [], identityGroups: [], macPools: [], certTemplates: [], cas: [], networks: [], workflows: [], directoryServers: [], samlProviders: [], errors: {} };
  if (!client) return out;
  const tries = {
    venues: async () => rows(await client.call("POST", "/venues/query", { page: 1, pageSize: 100 })).map((v) => ({ id: v.id, name: v.name })),
    dpskPools: async () => rows(await client.call("GET", "/dpskServices")).map((p) => ({ id: p.id, name: p.name, identityGroupId: p.identityGroupId || null })),
    identityGroups: async () => rows(await client.call("GET", "/identityGroups?page=0&size=500")).map((g) => ({ id: g.id, name: g.name })),
    macPools: async () => rows(await client.call("GET", "/macRegistrationPools?page=0&size=500")).map((p) => ({ id: p.id, name: p.name, identityGroupId: p.identityGroupId || null })),
    certTemplates: async () => rows(await client.call("POST", "/certificateTemplates/query?page=0&size=200", {})).map((t) => ({ id: t.id, name: t.name, identityGroupId: t.identityGroupId || null })),
    cas: async () => rows(await client.call("POST", "/certificateAuthorities/query?page=0&size=100", {})).map((c) => ({ id: c.id, name: c.name })),
    networks: async () => rows(await client.call("POST", "/wifiNetworks/query", { page: 1, pageSize: 200 })).map((n) => ({ id: n.id, name: n.name, ssid: n.ssid, type: n.nwSubType || n.type })),
    directoryServers: async () => rows(await client.call("POST", "/directoryServerProfiles/query", {})).map((d) => ({ id: d.id, name: d.name, host: d.host, port: d.port, type: d.type })),
    samlProviders: async () => rows(await client.call("POST", "/samlIdpProfiles/query", {})).map((s) => ({ id: s.id, name: s.name })),
    workflows: async () => rows(await client.call("POST", "/workflows/query?page=0&size=200", {})).map((w) => ({ id: w.id, name: w.name, status: w.status, published: (w.publishedDetails || {}).status })),
  };
  await Promise.all(Object.entries(tries).map(async ([k, fn]) => { try { out[k] = await fn(); } catch (e) { out.errors[k] = e.message; } }));
  return out;
}

module.exports = { loadInventory };
