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
  if (ctx.onboarded || prev === "dpsk" || prev === "registration") {
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

// "Prompt the user for credentials": checked against one of Cloudpath's user sources. Which one is in the authentication server link's tooltip
// ("Onboard Database", "Active Directory", ...). Cloudpath's own Onboard database is meant for testing only; a directory is what R1 can use.
function credprompt(step) {
  const tips = (step.links || []).map((l) => String(l.tooltip || ""));
  const type = tips.map((x) => x.split("\n")[0].trim()).find((x) => x && !/^credential prompt$/i.test(x)) || "";
  const host = (tips.join("\n").match(/Host:\s*(\S+)/) || [])[1] || "";
  const server = ((step.label || "").match(/credentials from (.+?)\.*$/i) || [])[1] || "";
  const internal = /onboard database/i.test(type);
  const who = server ? "“" + trunc(server, 60) + "”" : "the authentication server";
  const notes = internal
    ? ["This step checks usernames and passwords against Cloudpath's internal user database (the “Onboard Database”, here " + who + "). Cloudpath designed that database for testing only: it is not meant to be used in production, and R1 has nothing like it. " +
       "R1's sign-in steps use an external directory (LDAP) or single sign-on. Move these users into a real directory first, then add an LDAP sign-in step with that directory's profile id."]
    : ["This step checks usernames and passwords against " + (type ? type : "a directory") + " (" + who + (host ? ", " + host : "") + "). R1 can do that with an LDAP sign-in step (or SSO), using a directory server profile you set up in R1 first: add the step and enter that profile's id."];
  return { support: "manual", notes, action: null, ref: { userSource: internal ? "onboard" : "directory", server, serverType: type, host } };
}

// "Prompt the user for a voucher" (otp) and "Request access from a sponsor" (req, oobreq) are guest passes in R1: a guest network, not a step.
const GUEST_NOTE = "The editor converts this automatically to an R1 guest network (a workflow that is only this opens as one; a branch that has one moves out to one). ";
const otp = (step) => ({ support: "manual", action: null, ref: { voucherList: (String(step.label || "").match(/voucher from (.+?)\.*$/i) || [])[1] || "" },
  notes: [GUEST_NOTE + "Cloudpath asks the visitor for a voucher a sponsor gave them; in R1 terms that is a guest pass (a guest network of type guest pass, where passes are made by sponsors, the guest API or Visitor Desk). The voucher list itself is not copied."] });
function sponsor(step) {
  const f = step.fields || {};
  const who = val(f, "availableSponsors") || val(f, "defaultSponsorEmail") || val(f, "sponsorRegex");
  return { support: "manual", action: null, ref: { sponsors: who },
    notes: [GUEST_NOTE + "Cloudpath lets the visitor ask a sponsor" + (who ? " (" + trunc(who, 80) + ")" : "") + " for access. R1's guest network has a “host approval” type for that: a host whose email is on a listed domain approves the visitor for a number of hours. R1 lists domains, not individual sponsors, so anyone at those domains can approve."] };
}

// "Send a notification": email or SMS to the user or to an administrator.
function notification(step) {
  const f = step.fields || {}, method = val(f, "notificationMethod"), admin = /administrator/i.test(method);
  const email = /e-?mail/i.test(method), sms = /sms/i.test(method);
  return { support: "manual", action: null, ref: { notify: { admin, email, sms } },
    notes: admin
      ? ["Cloudpath emails an administrator" + (val(f, "notificationMethodData") ? " (" + val(f, "notificationMethodData") + ")" : "") + " when someone onboards. R1 has no step that notifies an administrator."]
      : ["Cloudpath sends the user " + [email && "an email", sms && "an SMS"].filter(Boolean).join(" and ") + " (the text is Cloudpath's, with variables such as $DPSK). R1's DPSK step has “Email the passphrase” and “Text the passphrase” switches: when this step follows a DPSK step the editor turns them on and drops this step (R1 sends its own message). Otherwise nothing carries over."] };
}

// "Prompt the user to name their device and remove old devices": a name field and a device limit.
function deviceName(step) {
  const f = step.fields || {}, max = ((step.links || []).map((l) => String(l.tooltip || "")).join("\n").match(/Maximum Devices:\s*(\d+)/) || [])[1];
  const text = val(f, "messageHtml") || val(f, "firstDeviceMessageHtml");
  return { support: "auto", ref: { maxDevices: max ? Number(max) : null },
    notes: ["Only the device name prompt converts: it becomes a form asking for a device name." + (max ? " Cloudpath also limits each user to " + max + " devices and lets them remove old ones: R1 has no such step. Set the limit as “Devices per passphrase” on the DPSK pool (or in the MAC registration)." : " Cloudpath's device limit and removing old devices have no R1 step: use the device limit on the DPSK pool.")],
    action: { actionType: "DATA_PROMPT", name: trunc(val(f, "name") || "Device name", 100), title: trunc(noVars(val(f, "title")) || "Name your device", 100), messageHtml: text ? trunc(text, 1000) : undefined,
      displayTitle: true, displayMessageHtml: !!text, variables: [{ label: "Device name", type: "INPUT_FIELD_1" }] } };
}

// Cloudpath fills ${VARIABLE} / $VARIABLE in message text (e.g. $DPSK); R1 messages are fixed text.
const VAR = /\$\{[^}]+\}|\$[A-Z][A-Z0-9_]+/g;

function message(step) {
  const f = step.fields || {};
  const title = trunc(noVars(val(f, "title")) || val(f, "name") || "Notice", 100);
  let text = val(f, "messageHtml").trim() || title;
  const notes = [];
  const vars = [...new Set(text.match(VAR) || [])];
  if (vars.length) notes.push("The text uses Cloudpath variables (" + vars.join(", ") + "), which R1 does not fill in: they show as typed. A DPSK or certificate step in R1 shows the credential itself, so reword this message.");
  if (text.length > 1000) { text = trunc(text, 1000); notes.push("The message was over R1's 1000 character limit and was cut."); }
  if (flag(f, "killSession")) notes.push("Cloudpath ends the session after this message.");
  return { support: "auto", notes, action: { actionType: "DISPLAY_MESSAGE", name: trunc(val(f, "name") || title, 100), title, messageHtml: text, bottomLabel: val(f, "bottomLabel") || undefined,
    backButtonText: val(f, "backButtonText") || "Back", continueButtonText: val(f, "continueButtonText") || "Continue", displayBackButton: val(f, "displayBackButton") !== "0", displayContinueButton: val(f, "displayContinueButton") !== "0", killSession: flag(f, "killSession") } };
}

// "Prompt the user for information": up to seven fields, each a Cloudpath variable name, label and optional pattern.
const R1_VARS = [[/^(user ?name|login|account)$/i, "USER_NAME"], [/^e-?mail/i, "EMAIL"], [/^(phone|mobile|cell|sms)/i, "PHONE"], [/^first/i, "FIRST_NAME"], [/^(last|sur)/i, "LAST_NAME"]];
function dataPrompt(step) {
  const f = step.fields || {};
  const vars = [], notes = []; let free = 0, password = false;
  for (let i = 1; i <= 7; i++) {
    const name = val(f, "prompt" + i + "Variable").trim(), label = val(f, "prompt" + i + "Label").trim();
    if (!name && !label) continue;
    if (/pass(word|phrase)|^pin$/i.test(name + " " + label)) { password = true; continue; }
    const hit = R1_VARS.find(([re]) => re.test(name)), type = hit ? hit[1] : (++free <= 6 ? "INPUT_FIELD_" + free : null);
    if (!type) { notes.push("R1 asks for at most six custom fields: “" + (label || name) + "” was left out."); continue; }
    vars.push({ label: trunc(label || name, 100), type, regex: val(f, "prompt" + i + "Regex") || undefined });
  }
  if (password) notes.push("Cloudpath also asks for a password. R1's form cannot ask for one: checking credentials is the job of a directory (LDAP) sign-in step.");
  if (!vars.length) return { support: "manual", notes: ["This prompt has no fields R1 can ask for." + (password ? " " + notes[0] : "")], action: null };
  return { support: password ? "manual" : "auto", notes: password ? ["Cloudpath asks for a username and password here (a login), which R1's form step can't do: use an LDAP sign-in step, and a form for the other details.", ...notes] : notes,
    action: { actionType: "DATA_PROMPT", name: trunc(val(f, "name") || "Prompt", 100), title: trunc(noVars(val(f, "title")) || val(f, "name") || "Tell us about you", 100), messageHtml: val(f, "messageHtml") || undefined, displayTitle: true, displayMessageHtml: !!val(f, "messageHtml"), variables: vars } };
}

function redirect(step) {
  const f = step.fields || {}, url = val(f, "workflowEmbeddableRedirect.redirectUrl");
  return { support: "manual", notes: ["Cloudpath sends the visitor on to " + (url || "a web address") + (flag(f, "workflowEmbeddableRedirect.killSession") ? " and ends the session" : "") + (flag(f, "workflowEmbeddableRedirect.usePost") ? ", using a POST" : "") +
    ". R1 has a redirect step (captive portal), but it counts as the branch's one onboarding step, so it cannot follow a DPSK, MAC or certificate step. If this is the branch's only onboarding step, add a “Captive portal redirect” step with this address; otherwise drop it."], action: null };
}

const RULES = {
  aup, dpsk, selection, registration, output,
  message, dataPrompt, redirect, otp, req: sponsor, oobreq: sponsor, notification, deviceName,
  oauth: manual("Cloudpath signs the visitor in with a social account (Google, Facebook, LinkedIn or a custom OAuth provider). R1's identity provider step uses a SAML or OIDC provider set up in R1, which is not the same thing: there is no direct equivalent, and the provider keys were not copied."),
  ss: manual("Cloudpath asks the visitor for a shared passphrase. R1 has no step that checks one. A shared passphrase on a Wi-Fi network is a PSK network (or a DPSK pool for personal ones). The passphrase itself was not copied."),
  oob: manual("The editor converts this automatically to an R1 guest network (a workflow that is only a voucher sign-in opens as one; a voucher branch inside a choice moves out to one). Cloudpath sends a voucher code by email or SMS and the visitor enters it: in R1 terms that is a guest pass. The R1 workflow action list has no guest-pass action (DATA_PROMPT only collects email/phone), so this part moves to an R1 guest network of type GuestPass (passes made by sponsors, the guest API, or bulk import) rather than a workflow step. The AUP becomes the network's terms text, the SMS/email choice becomes the pass delivery methods. See README 'Guest networks'."),
  credprompt,
  concurrent: manual("Cloudpath reminds the user to remove old certificates. R1 has no such step; use DISPLAY_MESSAGE to tell them, or drop it."),
};

function convertSteps(steps, ctx) {
  const out = [];
  let prev = ctx.prev, onboarded = !!ctx.onboarded;               // onboarded: an earlier step on this path already gives the visitor access (R1 allows one)
  for (const s of steps) {
    const rule = RULES[s.kind] || manual("Step type '" + s.kind + "' is not known to this tool.");
    const r = rule(s, { ...ctx, prev, onboarded });
    if (r.action && ["DPSK", "MAC_REG", "CERT_TEMPLATE", "PASSPHRASE", "CAPTIVE_PORTAL"].includes(r.action.actionType)) onboarded = true;
    const node = { cloudpath: { kind: s.kind, number: s.number, name: val(s.fields, "name"), label: clean(s.label || "") }, support: r.support,
      needs: r.needs || [], notes: r.notes || [], r1: r.action, ref: r.ref };
    if (r.end) node.end = true;
    if (s.options) {
      node.options = s.options.map((o) => ({ fields: o.fields,
        name: o.name, criteria: (o.criteria || "").replace(/^.*criteria:\s*/s, "").replace(/\s+/g, " ").trim(),
        r1: { actionType: r.split === "FUNCTIONAL" ? "FUNCTIONAL_SPLIT_OPTION" : "USER_SELECTION_SPLIT_OPTION", name: trunc(val(o.fields, "name") || o.name, 100),
          messageHtml: optionText(o) },
        steps: convertSteps(o.steps || [], { ...ctx, prev: s, onboarded }),
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
