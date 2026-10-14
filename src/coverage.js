// What is in Cloudpath versus RUCKUS One, and what this tool can convert. The catalog says what each Cloudpath element becomes; counts come
// from the crawl (data/crawl.json), so the chart is about YOUR Cloudpath, not Cloudpath in general. Output: a page (no scripts, light and
// dark) and a CSV. Nothing here talks to a network.
const { convertAll } = require("./convert");
const { ruleToConditions } = require("./model");

// status: converts (automatic) | mapping (converts once an R1 object is chosen or created) | partial (some of it converts) | none (no equivalent)
// evidence: live = confirmed against a real tenant, docs = from RUCKUS's API documents, assumed = our reading, not confirmed
const CATALOG = [
  // -- Workflow steps (read from the crawl) --
  { id: "aup", group: "Workflow steps", cloudpath: "Acceptable use policy", r1: "AUP step", status: "converts", evidence: "live",
    note: "Title, text, checkbox label and colour carry over. Cloudpath's ${variables} become plain words; an uploaded policy file isn't fetched." },
  { id: "selection-open", group: "Workflow steps", cloudpath: "Visitor chooses an option", r1: "Visitor chooses a path (user selection split)", status: "converts", evidence: "live",
    note: "Each option becomes a branch. Cloudpath can show every matching option; R1 shows the list and the visitor picks one." },
  { id: "selection-rules", group: "Workflow steps", cloudpath: "Option chosen by match rules", r1: "Logical split", status: "partial", evidence: "live",
    note: "R1 can only test device type, OS, browser, language, SSID, venue, AP group, MAC and IP, with eight comparisons, and takes the first matching branch. Rules on form answers or lists (e.g. 'is on this MAC list') are kept as notes, not conditions." },
  { id: "dpsk", group: "Workflow steps", cloudpath: "Give a DPSK passphrase", r1: "DPSK step", status: "mapping", evidence: "live",
    note: "Needs an R1 DPSK pool: pick one, or let the tool create it. 'Days of access' belongs to the pool in R1, not the step." },
  { id: "mac", group: "Workflow steps", cloudpath: "Register the device's MAC address", r1: "Register the device (MAC registration step)", status: "mapping", evidence: "docs",
    note: "Needs an R1 MAC registration list. Creating the list is built but not yet confirmed against a live tenant." },
  { id: "output-cert", group: "Workflow steps", cloudpath: "Assign a certificate", r1: "Certificate template step", status: "mapping", evidence: "live",
    note: "Needs an R1 certificate template (the tool can create it) and a certificate authority, which the tool never creates." },
  { id: "output-network", group: "Workflow steps", cloudpath: "Move the user to a device configuration (network)", r1: "Passphrase / captive portal step", status: "partial", evidence: "assumed",
    note: "A Cloudpath device configuration (SSID, security) is not a workflow step in R1. The tool offers the closest step; check which one should give the visitor access." },
  { id: "output-end", group: "Workflow steps", cloudpath: "Move the user on after a DPSK or MAC step / assign nothing", r1: "End of the path", status: "converts", evidence: "assumed",
    note: "R1's path simply ends after the DPSK or MAC step. Whether the visitor stays on the workflow network or joins the pool's SSID depends on your networks (unconfirmed)." },
  { id: "oob", group: "Workflow steps", cloudpath: "Voucher or verification code", r1: "Guest network (guest pass), not a step", status: "converts", evidence: "live",
    note: "Automatic: a voucher and guest pass are the same thing. A workflow that is only a voucher sign-in opens as a ready guest network; a voucher branch inside a choice moves out of the workflow into a companion guest network. Not copied: the voucher lists (pre-made codes), and any certificate Cloudpath assigned after the voucher." },
  { id: "otp", group: "Workflow steps", cloudpath: "Prompt for a voucher from a sponsor", r1: "Guest network (guest pass), not a step", status: "converts", evidence: "live",
    note: "Same as the voucher above: the visitor entering a voucher is a guest pass, converted automatically to a guest network. The voucher list isn't copied." },
  { id: "sponsor", group: "Workflow steps", cloudpath: "Request access from a sponsor", r1: "Guest network with host approval, not a step", status: "converts", evidence: "docs",
    note: "Converted automatically to a guest network of type host approval. R1 lists host email domains, not individual sponsors, so anyone at those domains can approve; Cloudpath's default and maximum access days become the hours a host can approve. The request form's settings and email template aren't copied. Host approval isn't tried live yet." },
  { id: "devicename", group: "Workflow steps", cloudpath: "Prompt the user to name their device (and limit devices)", r1: "Prompt for information", status: "partial", evidence: "docs",
    note: "Only the name prompt converts, as a form field. The device limit and removing old devices have no R1 step: set 'Devices per passphrase' on the DPSK pool." },
  { id: "notification", group: "Workflow steps", cloudpath: "Send a notification (email or SMS)", r1: "DPSK step's email / text switches", status: "partial", evidence: "docs",
    note: "A notification to the user after a DPSK step turns on R1's 'Email the passphrase' / 'Text the passphrase' and is dropped (R1 writes its own message). A notice to an administrator, or one not after a DPSK step, has no R1 equivalent." },
  { id: "message", group: "Workflow steps", cloudpath: "Display a message", r1: "Show a message", status: "converts", evidence: "live",
    note: "Title, text, button labels and whether to end the session carry over. Cloudpath variables in the text (e.g. $DPSK) are not filled in by R1; the DPSK or certificate step shows the credential itself." },
  { id: "dataprompt", group: "Workflow steps", cloudpath: "Prompt for information (form)", r1: "Prompt for information", status: "converts", evidence: "docs",
    note: "Username, email, phone, first and last name and up to six custom fields carry over. A password field can't: R1's form doesn't ask for one (use an LDAP sign-in step)." },
  { id: "redirect", group: "Workflow steps", cloudpath: "Redirect the user to an address", r1: "Captive portal redirect", status: "partial", evidence: "docs",
    note: "R1's redirect counts as the branch's one onboarding step, so it can't follow a DPSK, MAC or certificate step. Add it by hand when it is the only one; the address is in the step's notes." },
  { id: "oauth", group: "Workflow steps", cloudpath: "Social login (Google, Facebook, LinkedIn, custom OAuth)", r1: "(none)", status: "none", evidence: "docs",
    note: "R1's identity provider step uses SAML or OIDC set up in R1: not the same thing. Provider keys are never copied." },
  { id: "ss", group: "Workflow steps", cloudpath: "Prompt for a shared passphrase", r1: "Give the network's passphrase", status: "mapping", evidence: "docs",
    note: "R1's step hands the visitor a PSK network's passphrase, rather than asking for one. Choose the network and its identity group. R1 allows one access step per path, so where a DPSK, MAC registration or certificate step also gives access the prompt is dropped, with a note. The passphrase isn't copied." },
  { id: "credprompt-onboard", group: "Workflow steps", cloudpath: "Username and password prompt, checked against Cloudpath's internal (Onboard) user database", r1: "(none)", status: "none", evidence: "docs",
    note: "Cloudpath designed its internal database for testing only; it is not meant for production, and R1 has nothing like it. Move these users into a real directory (LDAP / Active Directory) and use an LDAP sign-in step." },
  { id: "credprompt", group: "Workflow steps", cloudpath: "Username and password prompt, checked against a directory (Active Directory, LDAP)", r1: "LDAP sign-in step", status: "partial", evidence: "docs",
    note: "R1 can check an external directory with an LDAP step, using a directory server profile you set up in R1. The converter leaves a placeholder that names the directory; you add the step and the profile id." },
  { id: "concurrent", group: "Workflow steps", cloudpath: "Remind the user to remove old certificates", r1: "(none)", status: "none", evidence: "docs",
    note: "No such step in R1. Use a message step to tell visitors, or drop it." },
  // -- Objects read from the crawl --
  { id: "obj-dpsk", group: "Objects", cloudpath: "DPSK pool", r1: "DPSK pool and identity group", status: "converts", evidence: "live", objects: "dpskPools",
    note: "Name, device limit, expiry and SSIDs carry over (the tool creates the pool and its networks). The pool's 'default access' policy has no equivalent." },
  { id: "obj-network", group: "Objects", cloudpath: "Device configuration (SSID)", r1: "Wi-Fi network", status: "partial", evidence: "live", objects: "deviceConfigs",
    note: "The tool creates DPSK (WPA2) networks only. Other security types and Cloudpath's client-side settings are not created." },
  { id: "obj-template", group: "Objects", cloudpath: "Certificate template", r1: "Certificate template (Certificate Management)", status: "converts", evidence: "live", objects: "certTemplates",
    note: "Name pattern, validity, organisation fields, algorithm and key length carry over. It still needs a certificate authority." },
  { id: "obj-ca", group: "Objects", cloudpath: "Certificate authority (and its keys)", r1: "Certificate authority", status: "none", evidence: "live",
    note: "The tool never creates or copies a CA: choose an existing R1 certificate authority." },
  { id: "obj-mac", group: "Objects", cloudpath: "MAC registration list", r1: "MAC registration pool", status: "mapping", evidence: "docs",
    note: "Create or choose an R1 list. Creation isn't confirmed live yet." },
  { id: "obj-look", group: "Objects", cloudpath: "Look and feel (portal page)", r1: "Look and feel", status: "partial", evidence: "live", looks: true,
    note: "Colours and titles carry over, and you can add images in the Look tab. A custom page style, HTML template, CSS file or page package can't; images aren't fetched automatically." },
  { id: "obj-url", group: "Objects", cloudpath: "Portal address (/enroll/…)", r1: "Workflow address", status: "none", evidence: "docs",
    note: "R1 gives the workflow its own address. Links, QR codes and bookmarks that point to the Cloudpath address have to be replaced. Workflows are built unpublished." },
  // -- Areas the crawler does not read --
  { id: "x-auth", group: "Not read by this tool", cloudpath: "Authentication servers and directories", r1: "(unknown)", status: "unread", evidence: "not crawled", note: "Not part of the crawl, so we can't say what converts. LDAP / SSO steps in R1 need a directory profile you set up there." },
  { id: "x-notify", group: "Not read by this tool", cloudpath: "Notification templates (email, SMS)", r1: "(unknown)", status: "unread", evidence: "not crawled", note: "Not read. R1 sends passphrases by email or text from the DPSK step; the wording is R1's own." },
  { id: "x-data", group: "Not read by this tool", cloudpath: "Users, issued certificates, devices, reports", r1: "(not converted)", status: "unread", evidence: "not crawled", note: "This is data, not configuration. The tool reads workflow definitions only." },
  { id: "x-integr", group: "Not read by this tool", cloudpath: "Integrations and admin settings (MDM, API keys, admin users, multiple accounts)", r1: "(unknown)", status: "unread", evidence: "not crawled", note: "Not read." },
];

// What R1 offers that Cloudpath's workflows don't map onto (so a converted workflow could use them).
const R1_ONLY = [
  { r1: "Logical split on device type, OS, browser, language, SSID, venue, AP group, MAC or IP", note: "Confirmed values: Mac = Desktop / macOS, iPhone = Mobile / iOS, Safari = Safari. At most 10 branches." },
  { r1: "LDAP and SSO (identity provider) sign-in steps", note: "Need a directory or identity-provider profile created in R1 first." },
  { r1: "Workflow reference (run another workflow as a step)", note: "In the R1 action list; not built by this tool yet." },
  { r1: "Guest networks: guest pass, self sign-in, host approval, click-through", note: "Built by the tool as separate networks, not workflow steps." },
  { r1: "DPSK and MAC steps with their own expiry (hours, days, weeks, months after issue)", note: "Cloudpath keeps expiry on the pool or list." },
  { r1: "Show a message that ends the session", note: "Useful for a polite refusal on a branch." },
];

const STATUS = { converts: "Converts automatically", mapping: "Converts after you choose or create an R1 object", partial: "Partly converts", none: "No equivalent", unread: "Not read" };
const CLASS_OF = { converts: "converts", mapping: "mapping", partial: "partial", none: "none", unread: "unread" };

function rowId(n) {
  const k = n.cloudpath && n.cloudpath.kind, t = n.r1 && n.r1.actionType;
  if (k === "selection") return t === "FUNCTIONAL_SPLIT" ? "selection-rules" : "selection-open";
  if (k === "output") return !n.r1 ? "output-end" : t === "CERT_TEMPLATE" ? "output-cert" : "output-network";
  if (k === "credprompt") return n.ref && n.ref.userSource === "onboard" ? "credprompt-onboard" : "credprompt";
  return { aup: "aup", otp: "otp", req: "sponsor", oobreq: "sponsor", deviceName: "devicename", notification: "notification", dpsk: "dpsk", registration: "mac", oob: "oob", credprompt: "credprompt", concurrent: "concurrent", message: "message", dataPrompt: "dataprompt", redirect: "redirect", oauth: "oauth", ss: "ss" }[k] || ("unknown:" + k);
}

function coverage(crawl, mapping = {}, now = new Date()) {
  const rows = CATALOG.map((r) => ({ ...r, count: crawl ? 0 : null }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const out = { listed: crawl && Number(crawl.listed) || null, generatedAt: now.toISOString(), source: crawl ? crawl.source || "" : "", crawledAt: crawl ? crawl.crawledAt || "" : "", hasCrawl: !!crawl, rows, r1Only: R1_ONLY, statusText: STATUS, workflows: [], totals: { converts: 0, mapping: 0, partial: 0, none: 0 }, ruleBranches: null };
  if (!crawl) return out;
  const plan = convertAll(crawl, mapping);
  let ruleTotal = 0, ruleDone = 0;
  const walkRaw = (steps) => { for (const s of steps || []) { if (s.kind === "selection") for (const o of s.options || []) { if (/only be available|matching/i.test(o.criteria || "") && !/available to all enrollments/i.test(o.criteria || "")) { ruleTotal++; const rc = ruleToConditions(o.fields); if (rc.conditions.length && !rc.notes.length) ruleDone++; } } for (const o of s.options || []) walkRaw(o.steps); } };
  for (const w of crawl.workflows || []) walkRaw(w.steps);
  out.ruleBranches = { total: ruleTotal, convertible: ruleDone };
  for (const w of plan.workflows) {
    const counts = { converts: 0, mapping: 0, partial: 0, none: 0 }, steps = [];
    (function walk(nodes) {
      for (const n of nodes) {
        const id = rowId(n);
        if (id && !byId[id]) {                                           // a step type this tool has never seen: counted, as "no equivalent"
          const row = { id, group: "Workflow steps", cloudpath: "Step type “" + id.slice(8) + "” (not known to this tool)", r1: "(unknown)", status: "none", evidence: "assumed", note: "This tool doesn't know this Cloudpath step type yet, so it can't convert it.", count: 0 };
          byId[id] = row; rows.splice(rows.findIndex((r) => r.id === "credprompt"), 0, row);
        }
        const row = id && byId[id];
        if (row) { row.count++; counts[CLASS_OF[row.status]]++; steps.push(id); }
        for (const o of n.options || []) walk(o.steps);
      }
    })(w.steps);
    const total = counts.converts + counts.mapping + counts.partial + counts.none;
    for (const k of Object.keys(counts)) out.totals[k] += counts[k];
    out.workflows.push({ name: w.name, counts, total });
  }
  const objs = crawl.objects || {};
  for (const r of rows) {
    if (r.objects) r.count = (objs[r.objects] || []).length;
    if (r.looks) r.count = (crawl.workflows || []).filter((w) => w.look && Object.keys(w.look).length).length;
    if (r.id === "obj-ca" || r.id === "obj-url" || r.group === "Not read by this tool") r.count = null;
    if (r.id === "obj-mac") r.count = new Set(plan.workflows.flatMap((w) => { const l = []; (function f(ns) { for (const n of ns) { if (n.ref && n.ref.list) l.push(n.ref.list); for (const o of n.options || []) f(o.steps); } })(w.steps); return l; })).size;
  }
  return out;
}

// ---- CSV --------------------------------------------------------------------------------------------------------
function csv(data) {
  const cell = (v) => { let s = v == null ? "" : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [["Group", "Cloudpath element", "RUCKUS One equivalent", "Result", "Found in your Cloudpath", "Evidence", "What carries over / what doesn't"].map(cell).join(",")];
  for (const r of data.rows) lines.push([r.group, r.cloudpath, r.r1, STATUS[r.status], r.count == null ? "" : r.count, r.evidence, r.note].map(cell).join(","));
  lines.push("");
  lines.push(["RUCKUS One only", "", "", "", "", "", ""].map(cell).join(","));
  for (const r of data.r1Only) lines.push(["R1 only", "", r.r1, "", "", "", r.note].map(cell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---- page -------------------------------------------------------------------------------------------------------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const GLYPH = { converts: "✓", mapping: "◐", partial: "◑", none: "✕", unread: "?" };

function bar(counts, total) {
  if (!total) return '<div class="bar empty" role="img" aria-label="No steps">no steps</div>';
  const label = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${STATUS[k].toLowerCase()}`).join(", ");
  return `<div class="bar" role="img" aria-label="${esc(label)}">` + ["converts", "mapping", "partial", "none"].filter((k) => counts[k]).map((k) => `<span class="seg ${k}" style="flex:${counts[k]}" title="${esc(STATUS[k])}: ${counts[k]}">${counts[k]}</span>`).join("") + "</div>";
}

function html(data, { csvHref = "" } = {}) {
  const T = data.totals, total = T.converts + T.mapping + T.partial + T.none;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const groups = [...new Set(data.rows.map((r) => r.group))];
  const legend = ["converts", "mapping", "partial", "none", "unread"].map((k) => `<li><span class="chip ${k}"><b aria-hidden="true">${GLYPH[k]}</b> ${esc(STATUS[k])}</span></li>`).join("");
  const table = groups.map((g) => `<h2>${esc(g)}</h2><div class="tw"><table><thead><tr><th>Cloudpath</th><th>RUCKUS One</th><th>Result</th>${data.hasCrawl ? "<th class=\"n\">In yours</th>" : ""}<th>What carries over and what doesn't</th></tr></thead><tbody>` +
    data.rows.filter((r) => r.group === g).map((r) => `<tr><td>${esc(r.cloudpath)}</td><td>${esc(r.r1)}</td><td><span class="chip ${r.status}"><b aria-hidden="true">${GLYPH[r.status]}</b> ${esc(STATUS[r.status])}</span><div class="ev">${esc(r.evidence)}</div></td>${data.hasCrawl ? `<td class="n">${r.count == null ? "" : r.count}</td>` : ""}<td>${esc(r.note)}</td></tr>`).join("") + "</tbody></table></div>").join("");
  const wfRow = (w) => `<div class="wf"><div class="wn">${esc(w.name)}</div>${bar(w.counts, w.total)}<div class="wt">${w.total} step${w.total === 1 ? "" : "s"}</div></div>`;
  const SHOW = 30;      // a Cloudpath instance can have hundreds of workflows: show the first ones, keep the rest one click away
  const per = data.workflows.slice(0, SHOW).map(wfRow).join("") + (data.workflows.length > SHOW ? `<details><summary>Show the other ${data.workflows.length - SHOW} workflows</summary><div class="wfs">${data.workflows.slice(SHOW).map(wfRow).join("")}</div></details>` : "");
  const summary = data.hasCrawl
    ? `<h2>Your Cloudpath: ${total} steps in ${data.workflows.length} workflows${data.listed && data.listed > data.workflows.length ? ` (Cloudpath lists ${data.listed}; the rest were not read)` : ""}</h2>${bar(T, total)}<p class="sub">${pct(T.converts)}% convert automatically, ${pct(T.mapping)}% once you choose or create an R1 object, ${pct(T.partial)}% only in part, ${pct(T.none)}% not at all.${data.ruleBranches && data.ruleBranches.total ? ` Of ${data.ruleBranches.total} rule-based branches, ${data.ruleBranches.convertible} convert completely to logical-split conditions.` : ""}</p><div class="wfs">${per}</div>`
    : `<p class="sub">No Cloudpath crawl is loaded, so there are no counts: this is the general chart of what converts.</p>`;
  const r1 = data.r1Only.map((r) => `<tr><td>${esc(r.r1)}</td><td>${esc(r.note)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloudpath vs RUCKUS One</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c2128;--mute:#5b6672;--line:#dde1e6;--converts:#1f8a4c;--mapping:#2f6fdb;--partial:#c47a00;--none:#c0392b;--unread:#6b7280;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--card:#1d2127;--ink:#e8ebef;--mute:#9aa5b1;--line:#323941;--converts:#3fb877;--mapping:#6b9cf5;--partial:#e0a030;--none:#e8685a;--unread:#8b94a0;--on:#101317}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px}.sub{color:var(--mute);margin:6px 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:12px 0}
.chip{display:inline-flex;gap:6px;align-items:center;border-radius:999px;padding:2px 10px;font-size:13px;border:1px solid currentColor;white-space:nowrap}
.chip.converts{color:var(--converts)}.chip.mapping{color:var(--mapping)}.chip.partial{color:var(--partial)}.chip.none{color:var(--none)}.chip.unread{color:var(--unread)}
.bar{display:flex;height:26px;border-radius:6px;overflow:hidden;background:var(--line)}.bar.empty{align-items:center;padding:0 8px;color:var(--mute);font-size:12px}
.seg{display:flex;align-items:center;justify-content:center;color:var(--on);font-weight:600;font-size:12px;min-width:22px}
.seg.converts{background:var(--converts)}.seg.mapping{background:var(--mapping)}.seg.partial{background:var(--partial)}.seg.none{background:var(--none)}
.wfs{display:grid;gap:8px;margin-top:14px}.wf{display:grid;grid-template-columns:minmax(120px,220px) 1fr 70px;gap:10px;align-items:center}.wn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wt{color:var(--mute);font-size:13px;text-align:right}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line);font-size:14px}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}tr:last-child td{border-bottom:0}.n{text-align:right;white-space:nowrap}
.ev{color:var(--mute);font-size:12px;margin-top:3px}a{color:var(--mapping)}.foot{color:var(--mute);font-size:13px;margin-top:28px}
@media (max-width:640px){.wf{grid-template-columns:1fr}.wt{text-align:left}}
@media print{body{background:#fff}.card,.tw{border-color:#bbb}}
</style></head><body><main>
<h1>Cloudpath versus RUCKUS One</h1>
<p class="sub">What is in a Cloudpath enrollment workflow, what it becomes in RUCKUS One, and what can't be converted.${data.crawledAt ? ` Cloudpath read ${esc(data.crawledAt.slice(0, 10))}${data.source ? " from " + esc(data.source) : ""}.` : ""}</p>
<ul class="legend" aria-label="Legend">${legend}</ul>
<div class="card">${summary}</div>
${table}
<h2>In RUCKUS One, not in Cloudpath's workflows</h2><div class="tw"><table><thead><tr><th>RUCKUS One</th><th>Notes</th></tr></thead><tbody>${r1}</tbody></table></div>
<p class="foot">Evidence: <b>live</b> = confirmed against a real RUCKUS One tenant; <b>docs</b> = from RUCKUS's API documents, not tried live; <b>assumed</b> = our reading, check it; <b>not crawled</b> = the tool doesn't read this part of Cloudpath. ${csvHref ? `<a href="${esc(csvHref)}" download="cloudpath-vs-r1.csv">Download as CSV</a>. ` : ""}Made ${esc(data.generatedAt.slice(0, 10))} by cloudpath-to-r1.</p>
</main></body></html>`;
}

module.exports = { coverage, html, csv, CATALOG, R1_ONLY, STATUS };
