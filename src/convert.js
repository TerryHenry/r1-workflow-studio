// Cloudpath workflow (from crawl.json) -> RUCKUS One workflow plan.
// Nothing here talks to a network. The plan lists, for every Cloudpath step, the R1 action that would
// replace it, how sure the conversion is, and which R1 objects (DPSK pool, MAC list, ...) must be mapped.
//
// support: "auto"    converts without help
//          "mapping" converts once a Cloudpath object is mapped to its R1 counterpart (data/mapping.json)
//          "manual"  no safe equivalent in the R1 action list: rebuild by hand or drop
// Action payloads follow the R1 Workflow Actions API 0.0.2 (docs.ruckus.cloud, checked 2026-10-13); the
// action types are confirmed in that spec but nothing has been created in a live tenant yet.

const R1_ACTIONS = ["AUP", "DATA_PROMPT", "DPSK", "USER_SELECTION_SPLIT", "USER_SELECTION_SPLIT_OPTION", "FUNCTIONAL_SPLIT",
  "FUNCTIONAL_SPLIT_OPTION", "DISPLAY_MESSAGE", "MAC_REG", "CERT_TEMPLATE", "IDP_AUTH_PROVIDER", "LDAP_AUTH_PROVIDER", "PASSPHRASE", "CAPTIVE_PORTAL"];

// A form value: what the admin typed, else Cloudpath's built-in default text, else "".
function val(fields, key) {
  const v = fields && fields[key];
  if (v == null) return "";
  if (typeof v === "object") return v.default != null ? String(v.default) : v.text != null ? String(v.text) : "";
  return String(v);
}
const flag = (fields, key) => val(fields, key) === "1";
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const clean = (s) => s.replace(/\.{2,}$|…$/, "");

// Cloudpath uses ${ACCOUNT_NAME}-style variables in its default texts; R1 text is plain.
const noVars = (s) => s.replace(/\$\{ACCOUNT_NAME\}/g, "our").replace(/<[^>]+>/g, "").trim();

// Tooltip on the template link in a Result step, e.g.
// "Name: Guest Policy Template\nIssuing CA: Example Intermediate CA\nCN Pattern: ${USERNAME}@guest.x.com\nValid Until: +30 Days"
function parseTemplateTip(tip) {
  const g = (label) => ((tip || "").match(new RegExp(label + ":\\s*([^\\n]*)")) || [])[1];
  const name = g("Name"), valid = g("Valid Until") || "";
  if (!name) return null;
  const m = valid.match(/^\+?\s*(\d+)\s*(Minute|Hour|Day|Week|Month|Quarter|Year)s?/i);
  return { name: name.trim(), issuingCa: (g("Issuing CA") || "").trim(),
    cnPattern: (g("CN Pattern") || "").trim().replace(/\$\{(\w+)\}/g, "$($1)"),
    validity: m ? { type: m[2].toUpperCase() + "S", value: Number(m[1]) } : null, validUntilText: valid.trim() };
}

const UNIT = { minute: "MINUTES", hour: "HOURS", day: "DAYS", week: "WEEKS", month: "MONTHS", quarter: "QUARTERS", year: "YEARS" };
const span = (x) => (x && UNIT[String(x.unit || "").toLowerCase().replace(/s$/, "")] ? { type: UNIT[String(x.unit).toLowerCase().replace(/s$/, "")], value: Number(x.value) } : null);
// Details of a Cloudpath certificate template from the crawled template pages (fuller than the step tooltip).
function templateFromObjects(objects, name) {
  const list = (objects && objects.certTemplates) || [];
  const key = String(name || "").toLowerCase().replace(/\.+$/, "");
  const t = list.find((x) => x.name.toLowerCase() === key) || list.find((x) => x.name.toLowerCase().startsWith(key));
  if (!t) return null;
  return { name: t.name, issuingCa: t.issuingCa || "", cnPattern: String(t.cnPattern || "").replace(/\$\{(\w+)\}/g, "$($1)"),
    validity: span(t.notAfter), notBefore: span(t.notBefore), organization: t.organization, locality: t.locality, state: t.state, country: t.country,
    algorithm: String(t.algorithm || "").replace("-", "_") };
}

function need(type, name, note) { return { type, name, note }; }

function mapped(mapping, group, name) {
  const m = mapping && mapping[group] && mapping[group][name];
  return m || null;
}

function aup(step, ctx) {
  const f = step.fields || {};
  return {
    support: "auto",
    notes: ["Cloudpath uses its standard AUP text unless a file was uploaded; check the wording and set your own."],
    action: {
      actionType: "AUP", name: trunc(val(f, "name") || "AUP", 100),
      title: trunc(noVars(val(f, "title")) || "Welcome", 100),
      messageHtml: val(f, "messageHtml") || "Please read and accept the acceptable use policy to connect.",
      checkboxText: trunc(noVars(val(f, "checkboxText")) || "I agree to the terms and conditions", 100),
      checkboxDefaultState: flag(f, "checkboxDefaultState"), checkboxHighlightColor: "#" + (val(f, "checkboxHighlightColor") || "FCFFB3"),
      backButtonText: "Back", continueButtonText: "Start",
    },
  };
}

function dpsk(step, ctx) {
  const f = step.fields || {};
  const pool = val(f, "accountDpskPoolPk");
  const m = mapped(ctx.mapping, "dpskPools", pool);
  const needs = [need("DPSK pool / identity group", pool, "map to an R1 DPSK pool and the identity group linked to it")];
  const notes = [];
  if (val(f, "daysOfAccess") && val(f, "daysOfAccess") !== "Unlimited") notes.push("Access period (" + val(f, "daysOfAccess") + ") is set on the R1 DPSK pool, not in the workflow.");
  return {
    support: m ? "auto" : "mapping", needs: m ? [] : needs, notes, ref: { pool },
    action: { actionType: "DPSK", name: trunc("DPSK " + pool, 100), dpskPoolId: m && m.dpskPoolId, identityGroupId: m && m.identityGroupId,
      emailNotification: flag(f, "allowEmail"), smsNotification: false, qrCodeDisplay: false },
  };
}

function selection(step, ctx) {
  const opts = step.options || [];
  const filtered = opts.some((o) => /only be available|matching/i.test(o.criteria || "") && !/available to all enrollments/i.test(o.criteria || ""));
  if (filtered) {
    return {
      support: "manual", split: "FUNCTIONAL",
      notes: ["Options are chosen by rules (" + (step.matchBehavior || "match rules") + "), not by the visitor: " +
        opts.map((o) => o.name + " [" + (o.criteria || "").replace(/^.*criteria:\s*/s, "").replace(/\s+/g, " ").trim() + "]").join("; ") +
        ". R1's FUNCTIONAL_SPLIT is the closest action, but its rule fields are not mapped by this tool yet."],
      action: { actionType: "FUNCTIONAL_SPLIT", name: trunc(val(step.fields, "name") || "Split", 100) },
    };
  }
  return {
    support: "auto", split: "USER_SELECTION",
    notes: step.matchBehavior && /All/i.test(step.matchBehavior) ? ["Cloudpath shows every matching option; R1 shows the visitor the list and they pick one."] : [],
    action: { actionType: "USER_SELECTION_SPLIT", name: trunc(val(step.fields, "name") || "Choose", 100), title: "Choose one", displayTitle: true },
  };
}

function registration(step, ctx) {
  const f = step.fields || {};
  const list = val(f, "name");
  const m = mapped(ctx.mapping, "macLists", list);
  const notes = [];
  if (val(f, "dateValue")) notes.push("Cloudpath registers the MAC for " + val(f, "dateValue") + " " + (val(f, "staticDerivedDateType") || "").replace(/ After/, "").toLowerCase() +
    ". In R1 the expiry belongs to the MAC registration list or identity: check it.");
  return {
    support: m ? "auto" : "mapping", needs: m ? [] : [need("MAC registration list / identity group", list, "map to an R1 MAC registration list")], notes,
    ref: { list, dateType: val(f, "staticDerivedDateType"), dateValue: val(f, "dateValue") },
    action: { actionType: "MAC_REG", name: trunc("MAC " + list, 100), macRegListId: m && m.macRegListId, identityGroupId: m && m.identityGroupId,
      clientEnterMacAddress: /Always redirect/i.test(val(f, "redirectBehavior")) },
  };
}

function output(step, ctx) {
  const f = step.fields || {};
  const source = val(f, "networkSourceSelection.source");
  const config = val(f, "networkSourceSelection.existingPk");
  const label = clean(step.label || "");
  if (source === "NONE" || !config) {
    return { support: "auto", end: true, notes: ["Cloudpath assigns nothing here; the R1 path simply ends."], action: null };
  }
  const tpl = (label.match(/assign certificate using (.+?)\.?$/i) || [])[1];
  if (tpl) {
    const tip = (step.links || []).map((l) => parseTemplateTip(l.tooltip)).find(Boolean);
    const info = templateFromObjects(ctx.objects, tip ? tip.name : clean(tpl)) || tip;
    const name = info ? info.name : clean(tpl);
    const m = mapped(ctx.mapping, "certTemplates", name);
    return {
      support: m ? "auto" : "mapping", needs: m ? [] : [need("certificate template", name, "map to an R1 certificate template, or create it (--create-missing --ca NAME)"),
        need("network / device configuration", config, "the SSID the device joins afterwards")],
      ref: { template: name, info },
      notes: ["Cloudpath also moves the user to the device configuration '" + config + "'; in R1 the certificate is delivered by the template, the SSID comes from the network settings."],
      action: { actionType: "CERT_TEMPLATE", name: trunc("Certificate " + name, 100), certTemplateId: m && m.certTemplateId, identityGroupId: m && m.identityGroupId },
    };
  }
  // "Move user to <device configuration>" after a DPSK / MAC step: the earlier R1 action already hands over the credential.
  const prev = ctx.prev && ctx.prev.kind;
  if (prev === "dpsk" || prev === "registration") {
    return { support: "auto", end: true, notes: ["Cloudpath moves the user to '" + config + "'. In R1 the path ends after the DPSK/MAC action; whether the visitor then stays on the workflow's own network or joins the pool's SSID depends on how the networks are set up (unconfirmed)."], action: null };
  }
  const net = mapped(ctx.mapping, "networks", config);
  return {
    support: net ? "auto" : "mapping", needs: net ? [] : [need("network", config, "R1 Wi-Fi network the user joins (PASSPHRASE needs a network id and identity group)")],
    notes: ["Device configuration '" + config + "' (SSID, security) has no direct R1 workflow equivalent: confirm which action delivers access."],
    action: { actionType: "PASSPHRASE", name: trunc("Access " + config, 100), networkId: net && net.networkId, identityGroupId: net && net.identityGroupId },
  };
}

const manual = (why) => () => ({ support: "manual", notes: [why], action: null });

const RULES = {
  aup, dpsk, selection, registration, output,
  oob: manual("Cloudpath sends a voucher code by email or SMS and the visitor enters it: in R1 terms that is a guest pass. The R1 workflow action list has no guest-pass action (DATA_PROMPT only collects email/phone), so this part moves to an R1 guest network of type GuestPass (passes made by sponsors, the guest API, or bulk import) rather than a workflow step. The AUP becomes the network's terms text, the SMS/email choice becomes the pass delivery methods. See README 'Guest networks'."),
  credprompt: manual("Cloudpath asks for a username and password checked against its own user database or a directory. R1 offers LDAP_AUTH_PROVIDER / IDP_AUTH_PROVIDER (external directory, SSO); an internal Cloudpath user database has no equivalent."),
  concurrent: manual("Cloudpath reminds the user to remove old certificates. R1 has no such step; use DISPLAY_MESSAGE to tell them, or drop it."),
};

function convertSteps(steps, ctx) {
  const out = [];
  let prev = ctx.prev;
  for (const s of steps) {
    const rule = RULES[s.kind] || manual("Step type '" + s.kind + "' is not known to this tool.");
    const r = rule(s, { ...ctx, prev });
    const node = { cloudpath: { kind: s.kind, number: s.number, name: val(s.fields, "name"), label: clean(s.label || "") }, support: r.support,
      needs: r.needs || [], notes: r.notes || [], r1: r.action, ref: r.ref };
    if (r.end) node.end = true;
    if (s.options) {
      node.options = s.options.map((o) => ({
        name: o.name, criteria: (o.criteria || "").replace(/^.*criteria:\s*/s, "").replace(/\s+/g, " ").trim(),
        r1: { actionType: r.split === "FUNCTIONAL" ? "FUNCTIONAL_SPLIT_OPTION" : "USER_SELECTION_SPLIT_OPTION", name: trunc(val(o.fields, "name") || o.name, 100),
          messageHtml: optionText(o) },
        steps: convertSteps(o.steps || [], { ...ctx, prev: s }),
      }));
    }
    out.push(node);
    prev = s;
  }
  return out;
}

// R1 option text is limited to 100 characters: use the description when it fits, else the short title, else a cut-down description.
function optionText(o) {
  const d = val(o.fields, "description"), t = val(o.fields, "title");
  if (d && d.length <= 100) return d;
  if (t && t.length <= 100) return t;
  return d ? trunc(d, 100) : undefined;
}

function walk(nodes, fn) { for (const n of nodes) { fn(n); for (const o of n.options || []) walk(o.steps, fn); } }

function convertWorkflow(wf, mapping, objects) {
  const steps = convertSteps(wf.steps || [], { mapping: mapping || {}, objects });
  const counts = { auto: 0, mapping: 0, manual: 0 };
  const needs = new Map();
  walk(steps, (n) => { counts[n.support]++; for (const x of n.needs) needs.set(x.type + "|" + x.name, x); });
  const status = counts.manual ? "needs-manual-work" : counts.mapping ? "needs-mapping" : "ready";
  return { name: wf.name, cloudpathPk: wf.pk, portalUrl: wf.portalUrl, publishedInCloudpath: !!wf.published, status, counts, needs: [...needs.values()], steps };
}

function convertAll(crawl, mapping) {
  return { source: crawl.source, cloudpathVersion: crawl.cloudpathVersion, crawledAt: crawl.crawledAt, workflows: crawl.workflows.map((w) => convertWorkflow(w, mapping, crawl.objects)) };
}

module.exports = { convertAll, convertWorkflow, val, R1_ACTIONS, parseTemplateTip };
