// A studio running on made-up data only (a pretend RUCKUS One, a pretend Cloudpath, the neutral test crawl). Used to take the screenshots for the
// user guide (docs/make-screenshots.js), so nothing from a real tenant or Cloudpath instance can appear in them.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUiServer } = require("../src/ui-server");
const { fakeR1 } = require("./fake-r1");
const conns = require("../src/connections");
const fakeCloudpath = require("./fake-cloudpath");

async function startDemo({ port = 47900, cloudpathDelay = 120 } = {}) {
  const root = path.join(__dirname, "..");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "studio-demo-"));
  const crawl = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "crawl.json"), "utf8"));
  const names = { personalPassphrase: "Personal passphrase", capPortal: "Captive portal", timedAccess: "Timed access", voucherFlow: "Voucher only" };
  for (const w of crawl.workflows) if (names[w.name]) w.name = names[w.name];
  const r1 = fakeR1({ existing: {
    venues: [{ id: "v1", name: "Main office" }, { id: "v2", name: "Warehouse" }],
    dpsk: [{ id: "p1", name: "Staff passphrases", identityGroupId: "g1" }, { id: "p2", name: "Guest passphrases", identityGroupId: "g2" }],
    groups: [{ id: "g1", name: "Staff" }, { id: "g2", name: "Guests" }],
    nets: [{ id: "n1", name: "Staff-WiFi", ssid: "Staff-WiFi", nwSubType: "dpsk" }, { id: "n2", name: "Guest-WiFi", ssid: "Guest-WiFi", nwSubType: "guest" }],
    cas: [{ id: "ca1", name: "Example Intermediate CA" }], tpls: [{ id: "t1", name: "Staff certificate", identityGroupId: "g1" }],
    workflows: [{ id: "w1", name: "Staff onboarding", status: "VALID" }, { id: "w2", name: "Guest self-service", status: "VALID" }, { id: "w3", name: "Contractor access", status: "INVALID" }],
  } });
  conns.upsert(dataRoot, conns.cleanProfile(dataRoot, { name: "Demo tenant", region: "na", tenantId: "demo-tenant-0000-0000", clientId: "demo-client-0000-0000", clientSecret: "demo-secret-not-real" }));
  const cp = await fakeCloudpath.create({ workflows: 24, delayMs: cloudpathDelay });
  const server = createUiServer({ client: r1.client, connection: "Demo tenant", crawl, root, dataRoot, pollMs: 0 });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { url: "http://127.0.0.1:" + port, cloudpath: { origin: cp.origin, user: cp.USER, pass: cp.PASS }, close: async () => { await new Promise((r) => server.close(r)); await cp.close(); } };
}
module.exports = { startDemo };
if (require.main === module) startDemo().then((d) => console.log("demo studio: " + d.url + "\nfake Cloudpath: " + d.cloudpath.origin + " (" + d.cloudpath.user + ")"));
