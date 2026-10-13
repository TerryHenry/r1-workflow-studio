// The editable workflow model behind the visual editor.
//
//   workflow = { name, description, steps: [node] }
//   node     = { id, type, name, params: {...}, options?: [{ id, name, text, steps: [node] }], source?: {...} }
//
// `type` is an R1 workflow action type (see ACTIONS). `params` holds what the user configures; fields that point at
// R1 objects (DPSK pool, certificate template, ...) either hold an existing object's id (mode "existing") or the
// description of one to create (mode "new"). Nothing here talks to R1: toBuildNodes() turns the model into the nodes
// Builder (src/build.js) consumes, and validate() lists what is wrong before anything is sent.

const FORMATS = ["MOST_SECURED", "KEYBOARD_FRIENDLY", "NUMBERS_ONLY", "DICTIONARY_WORDS"];
const SPANS = ["MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS", "QUARTERS", "YEARS"];
const MAC_SPANS = ["MINUTES_AFTER_TIME", "HOURS_AFTER_TIME", "DAYS_AFTER_TIME", "WEEKS_AFTER_TIME", "MONTHS_AFTER_TIME"];

const f = (key, label, type, extra = {}) => ({ key, label, type, ...extra });

// Field definitions drive the editor's forms and the validation. `ref` fields are filled from the tenant inventory.
const ACTIONS = {
  AUP: { label: "Acceptable use policy", category: "basic", help: "Shows terms the visitor must accept.", defaults: { title: "Welcome", messageHtml: "Please read and accept the acceptable use policy to connect.", checkboxText: "I agree to the terms and conditions", checkboxDefaultState: false, checkboxHighlightColor: "#FCFFB3", backButtonText: "Back", continueButtonText: "Start" },
    fields: [f("title", "Title", "text", { max: 100, required: true }), f("messageHtml", "Message", "textarea", { max: 1000, required: true }),
      f("checkboxText", "Checkbox text", "text", { max: 100, required: true }), f("checkboxDefaultState", "Checkbox starts ticked", "bool"),
      f("checkboxHighlightColor", "Highlight colour", "text", { pattern: "^#?(?:[0-9a-fA-F]{3}){1,2}$", required: true }),
      f("aupPlainText", "Policy text (shown to the visitor)", "textarea", { max: 50000 }),
      f("bottomLabel", "Bottom label", "text", { max: 1000 }), f("backButtonText", "Back button", "text", { max: 100, required: true }), f("continueButtonText", "Continue button", "text", { max: 100, required: true })] },
  DATA_PROMPT: { label: "Prompt for information", category: "basic", help: "Asks the visitor for details (name, email, phone, custom fields).", defaults: { title: "Tell us about you", messageHtml: "", displayTitle: true, displayMessageHtml: false, variables: [{ label: "Email", type: "EMAIL" }] },
    fields: [f("title", "Title", "text", { max: 100, required: true }), f("displayTitle", "Show title", "bool"), f("messageHtml", "Message", "textarea", { max: 1000 }), f("displayMessageHtml", "Show message", "bool"),
      f("variables", "Fields to ask for", "variables", { required: true })] },
  DISPLAY_MESSAGE: { label: "Show a message", category: "basic", help: "Shows text, optionally ending the session.", defaults: { title: "Notice", messageHtml: "", backButtonText: "Back", continueButtonText: "Continue", displayBackButton: true, displayContinueButton: true, killSession: false },
    fields: [f("title", "Title", "text", { max: 100, required: true }), f("messageHtml", "Message", "textarea", { max: 1000, required: true }), f("bottomLabel", "Bottom label", "text", { max: 1000 }),
      f("backButtonText", "Back button", "text", { required: true }), f("continueButtonText", "Continue button", "text", { required: true }),
      f("displayBackButton", "Show back button", "bool"), f("displayContinueButton", "Show continue button", "bool"), f("killSession", "End the session", "bool")] },
  USER_SELECTION_SPLIT: { label: "Visitor chooses a path", category: "split", help: "Shows buttons; each option is its own branch.", defaults: { title: "Choose one", displayTitle: true, messageHtml: "", displayMessageHtml: false },
    fields: [f("title", "Title", "text", { max: 100, required: true }), f("displayTitle", "Show title", "bool"), f("messageHtml", "Message", "textarea", { max: 1000 }), f("displayMessageHtml", "Show message", "bool")] },
  DPSK: { label: "Give a DPSK passphrase", category: "onboard", help: "Issues a personal Wi-Fi passphrase from a DPSK pool.", defaults: { mode: "existing", passphraseFormat: "MOST_SECURED", passphraseLength: 12, emailNotification: false, smsNotification: false, qrCodeDisplay: false, ssids: [] },
    fields: [f("mode", "DPSK pool", "mode", { choices: [["existing", "Use an existing pool"], ["new", "Create a new pool"]] }),
      f("dpskPoolId", "Pool", "ref", { ref: "dpskPools", showIf: { mode: "existing" }, required: true }),
      f("newName", "New pool name", "text", { max: 100, showIf: { mode: "new" }, required: true }),
      f("passphraseFormat", "Passphrase format", "select", { choices: FORMATS.map((x) => [x, x]), showIf: { mode: "new" } }),
      f("passphraseLength", "Passphrase length", "number", { min: 8, max: 63, showIf: { mode: "new" } }),
      f("deviceCountLimit", "Devices per passphrase (blank = unlimited)", "number", { min: 1, showIf: { mode: "new" } }),
      f("ssids", "Wi-Fi networks to create for this pool (DPSK, WPA2)", "ssids", { showIf: { mode: "new" } }),
      f("emailNotification", "Email the passphrase", "bool"), f("smsNotification", "Text the passphrase", "bool"), f("qrCodeDisplay", "Show a QR code", "bool")] },
  MAC_REG: { label: "Register the device (MAC)", category: "onboard", help: "Adds the visitor's device to a MAC registration list.", defaults: { mode: "existing", clientEnterMacAddress: false, expirationType: "HOURS_AFTER_TIME", expirationOffset: 24 },
    fields: [f("mode", "MAC registration list", "mode", { choices: [["existing", "Use an existing list"], ["new", "Create a new list"]] }),
      f("macRegListId", "List", "ref", { ref: "macPools", showIf: { mode: "existing" }, required: true }),
      f("newName", "New list name", "text", { max: 100, showIf: { mode: "new" }, required: true }),
      f("expirationType", "Registrations last", "select", { choices: MAC_SPANS.map((x) => [x, x.replace("_AFTER_TIME", "").toLowerCase()]), showIf: { mode: "new" } }),
      f("expirationOffset", "…for this many", "number", { min: 1, showIf: { mode: "new" } }),
      f("clientEnterMacAddress", "Visitor types the MAC address", "bool")] },
  CERT_TEMPLATE: { label: "Issue a certificate", category: "onboard", help: "Installs a client certificate from a certificate template.", defaults: { mode: "existing", commonNamePattern: "$(USERNAME)", validityType: "YEARS", validityValue: 1, startType: "DAYS", startValue: 0, algorithm: "SHA_256", keyLength: 2048 },
    fields: [f("mode", "Certificate template", "mode", { choices: [["existing", "Use an existing template"], ["new", "Create a new template"]] }),
      f("certTemplateId", "Template", "ref", { ref: "certTemplates", showIf: { mode: "existing" }, required: true }),
      f("newName", "New template name", "text", { max: 100, showIf: { mode: "new" }, required: true }),
      f("caId", "Issued by (certificate authority)", "ref", { ref: "cas", showIf: { mode: "new" }, required: true }),
      f("commonNamePattern", "Common name pattern", "text", { showIf: { mode: "new" }, required: true }),
      f("validityValue", "Valid for", "number", { min: 1, showIf: { mode: "new" } }), f("validityType", "…unit", "select", { choices: SPANS.map((x) => [x, x.toLowerCase()]), showIf: { mode: "new" } }),
      f("organization", "Organization", "text", { showIf: { mode: "new" } }), f("locality", "City", "text", { showIf: { mode: "new" } }), f("state", "State", "text", { showIf: { mode: "new" } }), f("country", "Country", "text", { showIf: { mode: "new" } })] },
  PASSPHRASE: { label: "Give the network's passphrase", category: "onboard", help: "Hands out a network's shared passphrase.", defaults: {},
    fields: [f("networkId", "Network", "ref", { ref: "networks", required: true }), f("identityGroupId", "Identity group", "ref", { ref: "identityGroups", required: true })] },
  CAPTIVE_PORTAL: { label: "Captive portal redirect", category: "onboard", help: "Sends the visitor on to a web address.", defaults: {},
    fields: [f("redirectUrl", "Redirect address", "text", { required: true })] },
  LDAP_AUTH_PROVIDER: { label: "Sign in with a directory (LDAP)", category: "auth", help: "Checks credentials against a directory server profile.", defaults: {},
    fields: [f("directoryServerProfileId", "Directory server profile id", "text", { required: true })] },
  IDP_AUTH_PROVIDER: { label: "Sign in with SSO (SAML)", category: "auth", help: "Checks credentials against an identity provider.", defaults: {},
    fields: [f("samlIdpProfileId", "Identity provider profile id", "text", { required: true })] },
};
// Cloudpath steps with no R1 equivalent stay in the model as a placeholder until the user replaces or deletes them.
const PLACEHOLDER = "UNSUPPORTED";
// Steps whose R1 object the editor can create (the others, like a passphrase's network, must be chosen).
const CREATABLE = { DPSK: { list: "dpskPools", key: "dpskPoolId" }, MAC_REG: { list: "macPools", key: "macRegListId" }, CERT_TEMPLATE: { list: "certTemplates", key: "certTemplateId" } };
const ONBOARD = new Set(["DPSK", "MAC_REG", "CERT_TEMPLATE", "PASSPHRASE", "CAPTIVE_PORTAL"]);

// A certificate template edited on its own (not as a step in a workflow).
const TEMPLATE_FIELDS = [
  f("name", "Template name", "text", { max: 100, required: true }), f("description", "Description", "text", { max: 1000 }),
  f("caId", "Issued by (certificate authority)", "ref", { ref: "cas", required: true }),
  f("commonNamePattern", "Common name pattern", "text", { required: true, help: "e.g. $(USERNAME)@example.com" }), f("emailPattern", "Email pattern", "text"),
  f("validityValue", "Valid for", "number", { min: 1, required: true }), f("validityType", "…unit", "select", { choices: SPANS.map((x) => [x, x.toLowerCase()]) }),
  f("startValue", "Starts this long before issue", "number", { min: 0 }), f("startType", "…unit", "select", { choices: SPANS.map((x) => [x, x.toLowerCase()]) }),
  f("organization", "Organization", "text"), f("organizationUnit", "Organization unit", "text"), f("locality", "City", "text"), f("state", "State", "text"), f("country", "Country", "text"),
  f("algorithm", "Signature algorithm", "select", { choices: ["SHA_1", "SHA_256", "SHA_384", "SHA_512"].map((x) => [x, x]) }), f("keyLength", "Key length", "select", { choices: [["2048", "2048"], ["3072", "3072"], ["4096", "4096"]] }),
];
function blankTemplate() { return { kind: "certTemplate", name: "New certificate template", description: "", caId: "", commonNamePattern: "$(USERNAME)", emailPattern: "", validityType: "YEARS", validityValue: 1, startType: "DAYS", startValue: 0, organization: "", organizationUnit: "", locality: "", state: "", country: "", algorithm: "SHA_256", keyLength: 2048 }; }
function validateTemplate(t, inv = {}, opts = {}) {
  const issues = [], add = (message) => issues.push({ level: "error", message });
  for (const fd of TEMPLATE_FIELDS) {
    const v = t[fd.key], empty = v === undefined || v === null || v === "";
    if (fd.required && empty) { add(`${fd.label} is required.`); continue; }
    if (empty) continue;
    if (fd.max && String(v).length > fd.max) add(`${fd.label} is over ${fd.max} characters.`);
    if (fd.type === "number" && (Number.isNaN(Number(v)) || Number(v) < (fd.min == null ? 0 : fd.min))) add(`${fd.label} must be a number from ${fd.min == null ? 0 : fd.min}.`);
  }
  if (t.caId && (inv.cas || []).length && !inv.cas.some((c) => c.id === t.caId)) add("The chosen certificate authority no longer exists in R1.");
  const full = (opts.prefix || "") + (t.name || "");
  if ((inv.certTemplates || []).some((x) => lc(x.name) === lc(full))) add(`A certificate template named "${full}" already exists in R1. Rename this one.`);
  return issues;
}
// The builder's description of a template to create.
function templateRef(t, prefix = "") {
  const span = (type, value) => ({ type, value: Number(value) });
  return { template: prefix + t.name, info: { name: prefix + t.name, description: t.description, caId: t.caId, cnPattern: t.commonNamePattern, emailPattern: t.emailPattern,
    validity: span(t.validityType, t.validityValue || 1), notBefore: span(t.startType || "DAYS", t.startValue || 0), organization: t.organization, organizationUnit: t.organizationUnit,
    locality: t.locality, state: t.state, country: t.country, algorithm: t.algorithm, keyLength: Number(t.keyLength) || 2048 } };
}

let seq = 0;
const uid = (p = "n") => p + Date.now().toString(36) + (++seq).toString(36);

function newNode(type, name) {
  const spec = ACTIONS[type];
  if (!spec) throw new Error("Unknown step type " + type);
  const node = { id: uid(), type, name: name || spec.label, params: JSON.parse(JSON.stringify(spec.defaults)) };
  if (type === "USER_SELECTION_SPLIT") node.options = [newOption("Option 1"), newOption("Option 2")];
  return node;
}
function newOption(name) { return { id: uid("o"), name, text: "", steps: [] }; }
function blankWorkflow(name = "New workflow") { return { name, description: "", steps: [] }; }

const lc = (s) => String(s || "").toLowerCase();
const find = (list, name) => (list || []).find((x) => lc(x.name) === lc(name));

// ---- Cloudpath plan -> model --------------------------------------------------------------------------------------
// planWf: a workflow from convertAll(); inv: tenant inventory (see ui-server); objects: crawl.objects.
function fromPlan(planWf, inv, objects) {
  const convert = (nodes) => {
    const out = [];
    for (const n of nodes || []) {
      const cp = n.cloudpath || {};
      const src = { cloudpathKind: cp.kind, cloudpathName: cp.name || cp.label, notes: n.notes || [] };
      if (!n.r1 && n.end) continue;                               // "(end)" results: the path ends by itself
      const t = n.r1 && n.r1.actionType;
      let node;
      if (!n.r1 || (n.support === "manual" && t !== "FUNCTIONAL_SPLIT")) {
        node = { id: uid(), type: PLACEHOLDER, name: cp.name || cp.label || cp.kind, params: {}, source: src };
      } else if (t === "AUP") {
        node = newNode("AUP", n.r1.name); Object.assign(node.params, pick(n.r1, ["title", "messageHtml", "checkboxText", "checkboxDefaultState", "checkboxHighlightColor", "backButtonText", "continueButtonText"]));
      } else if (t === "DPSK") {
        node = newNode("DPSK", n.r1.name);
        const have = find(inv.dpskPools, n.ref.pool), o = find((objects || {}).dpskPools, n.ref.pool) || {};
        src.create = { kind: "DPSK", name: n.ref.pool, passphraseLength: o.passphraseLength || 12, deviceCountLimit: o.deviceLimit ? Number(o.deviceLimit) : undefined, ssids: (o.ssids || []).map((ssid) => ({ ssid })) };
        if (have) Object.assign(node.params, { mode: "existing", dpskPoolId: have.id });
        else Object.assign(node.params, { mode: "new", newName: n.ref.pool, passphraseLength: o.passphraseLength || 12, deviceCountLimit: o.deviceLimit ? Number(o.deviceLimit) : undefined,
          ssids: (o.ssids || []).map((ssid) => ({ ssid })) });
      } else if (t === "MAC_REG") {
        node = newNode("MAC_REG", n.r1.name);
        const have = find(inv.macPools, n.ref.list);
        const span = { "Minutes After": "MINUTES_AFTER_TIME", "Hours After": "HOURS_AFTER_TIME", "Days After": "DAYS_AFTER_TIME" }[n.ref.dateType];
        src.create = { kind: "MAC_REG", name: n.ref.list, ...(span ? { expirationType: span, expirationOffset: Number(n.ref.dateValue) } : {}) };
        if (have) Object.assign(node.params, { mode: "existing", macRegListId: have.id });
        else Object.assign(node.params, { mode: "new", newName: n.ref.list, ...(span ? { expirationType: span, expirationOffset: Number(n.ref.dateValue) } : {}) });
        node.params.clientEnterMacAddress = !!n.r1.clientEnterMacAddress;
      } else if (t === "CERT_TEMPLATE") {
        node = newNode("CERT_TEMPLATE", n.r1.name);
        const have = find(inv.certTemplates, n.ref.template), i = n.ref.info || {};
        src.create = { kind: "CERT_TEMPLATE", name: n.ref.template, info: i };
        if (have) Object.assign(node.params, { mode: "existing", certTemplateId: have.id });
        else {
          const ca = find(inv.cas, i.issuingCa);
          Object.assign(node.params, { mode: "new", newName: n.ref.template, caId: ca ? ca.id : "", commonNamePattern: i.cnPattern || "$(USERNAME)",
            validityType: (i.validity || {}).type || "YEARS", validityValue: (i.validity || {}).value || 1, organization: i.organization, locality: i.locality, state: i.state, country: i.country });
        }
      } else if (t === "USER_SELECTION_SPLIT" || t === "FUNCTIONAL_SPLIT") {
        node = newNode("USER_SELECTION_SPLIT", n.r1.name);
        node.params.title = "Choose one"; node.options = [];
        if (t === "FUNCTIONAL_SPLIT") src.notes = ["Cloudpath chose the branch by rules; here the visitor chooses. Rules were: " + (n.notes || []).join(" ")];
      } else if (t === "PASSPHRASE") {
        node = newNode("PASSPHRASE", n.r1.name);
        const net = find(inv.networks, n.ref && n.ref.network);
        if (net) node.params.networkId = net.id;
      } else continue;
      node.source = src;
      if (n.options) {
        node.options = n.options.map((o) => ({ id: uid("o"), name: o.name.replace(/\.{3}$/, ""), text: (o.r1 && o.r1.messageHtml) || "", steps: convert(o.steps), criteria: o.criteria }));
      }
      out.push(node);
    }
    return out;
  };
  return { name: planWf.name, description: `Converted from Cloudpath workflow "${planWf.name}" (${planWf.portalUrl || ""})`.trim(), steps: convert(planWf.steps), source: { cloudpath: planWf.name, status: planWf.status } };
}
function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }

// ---- validation ---------------------------------------------------------------------------------------------------
function everyBranchOnboards(nodes) {
  if (nodes.some((n) => ONBOARD.has(n.type))) return true;
  const split = nodes.find((n) => n.options);
  return !!split && split.options.length > 0 && split.options.every((o) => everyBranchOnboards(o.steps));
}

function visible(field, params) {
  if (!field.showIf) return true;
  return Object.entries(field.showIf).every(([k, v]) => params[k] === v);
}

// Returns [{ level: "error"|"warn", nodeId?, message }]. Errors block applying.
function validate(wf, inv = {}, opts = {}) {
  const issues = [];
  const add = (level, message, nodeId, fix) => issues.push(fix ? { level, message, nodeId, fix } : { level, message, nodeId });
  if (!String(wf.name || "").trim()) add("error", "The workflow needs a name.");
  else if (String(wf.name).length > 100) add("error", "The workflow name is over 100 characters.");
  if ((inv.workflows || []).some((w) => lc(w.name) === lc((opts.prefix || "") + wf.name))) add("error", `A workflow named "${(opts.prefix || "") + wf.name}" already exists in R1. Rename this one.`);
  if (!wf.steps.length) add("error", "Add at least one step.");
  const newPools = new Set(), newTpls = new Set(), newLists = new Set();
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === PLACEHOLDER) { add("error", `"${n.name}" has no R1 equivalent: replace it with another step, or delete it.`, n.id); continue; }
      const spec = ACTIONS[n.type];
      if (!spec) { add("error", `Unknown step type ${n.type}.`, n.id); continue; }
      if (!String(n.name || "").trim()) add("error", "A step has no name.", n.id);
      if (String(n.name || "").length > 100) add("error", `"${n.name}": the name is over 100 characters.`, n.id);
      for (const fd of spec.fields) {
        if (!visible(fd, n.params)) continue;
        const v = n.params[fd.key];
        const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
        const fixable = fd.type === "ref" && CREATABLE[n.type] && n.params.mode === "existing";
        if (fd.required && empty) { add("error", `"${n.name}": ${fd.label} is required.`, n.id, fixable ? "createMissing" : undefined); continue; }
        if (empty) continue;
        if (fd.max && fd.type !== "number" && String(v).length > fd.max) add("error", `"${n.name}": ${fd.label} is over ${fd.max} characters.`, n.id);
        if (fd.type === "number" && (Number.isNaN(Number(v)) || (fd.min != null && Number(v) < fd.min) || (fd.max != null && Number(v) > fd.max))) add("error", `"${n.name}": ${fd.label} must be a number${fd.min != null ? " from " + fd.min : ""}${fd.max != null ? " to " + fd.max : ""}.`, n.id);
        if (fd.pattern && !new RegExp(fd.pattern).test(String(v))) add("error", `"${n.name}": ${fd.label} is not valid.`, n.id);
        if (fd.type === "ref" && inv[fd.ref] && !inv[fd.ref].some((x) => x.id === v)) add("error", `"${n.name}": the chosen ${fd.label.toLowerCase()} no longer exists in R1.`, n.id, fixable ? "createMissing" : undefined);
      }
      if (n.type === "DPSK" && n.params.mode === "new" && n.params.newName) {
        if (find(inv.dpskPools, n.params.newName)) add("error", `"${n.name}": a DPSK pool named "${n.params.newName}" already exists: choose it instead of creating it.`, n.id);
        if (newPools.has(lc(n.params.newName))) add("warn", `"${n.name}": the pool "${n.params.newName}" is created by an earlier step and reused here.`, n.id);
        newPools.add(lc(n.params.newName));
      }
      if (n.type === "CERT_TEMPLATE" && n.params.mode === "new" && n.params.newName) {
        if (find(inv.certTemplates, n.params.newName)) add("error", `"${n.name}": a certificate template named "${n.params.newName}" already exists: choose it instead.`, n.id);
        newTpls.add(lc(n.params.newName));
      }
      if (n.type === "MAC_REG" && n.params.mode === "new" && n.params.newName) {
        if (find(inv.macPools, n.params.newName)) add("error", `"${n.name}": a MAC list named "${n.params.newName}" already exists: choose it instead.`, n.id);
        newLists.add(lc(n.params.newName));
      }
      if (n.type === "USER_SELECTION_SPLIT") {
        if (!n.options || n.options.length < 2) add("error", `"${n.name}": a choice needs at least two options.`, n.id);
        const seen = new Set();
        for (const o of n.options || []) {
          if (!String(o.name || "").trim()) add("error", `"${n.name}": an option has no name.`, n.id);
          if (seen.has(lc(o.name))) add("error", `"${n.name}": two options are called "${o.name}".`, n.id);
          seen.add(lc(o.name));
          if (String(o.text || "").length > 100) add("error", `"${n.name}": the text of option "${o.name}" is over 100 characters.`, n.id);
          if (!o.steps.length) add("warn", `"${n.name}": option "${o.name}" has no steps.`, n.id);
          walk(o.steps);
        }
      }
    }
  };
  walk(wf.steps);
  const maxOnboard = (nodes) => { let c = 0; for (const x of nodes) { if (ONBOARD.has(x.type)) c++; if (x.options) return c + Math.max(0, ...x.options.map((o) => maxOnboard(o.steps))); } return c; };
  if (maxOnboard(wf.steps) > 1) add("error", "R1 allows only one onboarding step (DPSK, MAC registration, certificate, passphrase or captive portal) in each path through the workflow, and at least one path has more.");
  if (wf.steps.length && !everyBranchOnboards(wf.steps)) add("error", "R1 needs an onboarding step (DPSK, MAC registration, certificate, passphrase or captive portal) in every path through the workflow; at least one path has none.");
  const splitAt = (nodes, i) => nodes.findIndex((n, j) => j < i && n.options);
  (function checkOrder(nodes) { nodes.forEach((n, i) => { if (n.options && i < nodes.length - 1) add("error", `"${n.name}" is a choice, so nothing can come after it on the same path: move the later steps into its options.`, n.id); (n.options || []).forEach((o) => checkOrder(o.steps)); }); })(wf.steps);
  void splitAt;
  return issues;
}

// ---- create what is missing ---------------------------------------------------------------------------------------
// For steps that point at an R1 object that is not chosen or no longer exists: if R1 already has an object with the
// wanted name, choose it; otherwise switch the step to create one (filled in from Cloudpath where known).
// Mutates `wf`. onlyIds limits it to some steps. Returns [{ nodeId, message }].
function createMissing(wf, inv, onlyIds) {
  const changes = [];
  const clean = (n) => String(n || "").replace(/^(Certificate|DPSK|MAC|Access)\s+/i, "").trim();
  (function walk(nodes) {
    for (const n of nodes) {
      const spec = CREATABLE[n.type];
      if (spec && n.params.mode === "existing" && (!onlyIds || onlyIds.includes(n.id))) {
        const id = n.params[spec.key];
        if (!id || !(inv[spec.list] || []).some((x) => x.id === id)) {
          const want = (n.source && n.source.create && n.source.create.name) || n.params.newName || clean(n.name) || n.name;
          const have = find(inv[spec.list], want), what = { DPSK: "DPSK pool", MAC_REG: "MAC list", CERT_TEMPLATE: "certificate template" }[n.type];
          if (have) { n.params[spec.key] = have.id; changes.push({ nodeId: n.id, message: `"${n.name}": ${what} “${have.name}” already exists in R1, so it was chosen.` }); }
          else {
            const c = (n.source && n.source.create) || {};
            n.params.mode = "new"; n.params.newName = want;
            if (n.type === "DPSK") { if (c.passphraseLength) n.params.passphraseLength = c.passphraseLength; if (c.deviceCountLimit) n.params.deviceCountLimit = c.deviceCountLimit; if (c.ssids && c.ssids.length) n.params.ssids = c.ssids.map((x) => ({ ...x })); }
            if (n.type === "MAC_REG" && c.expirationType) { n.params.expirationType = c.expirationType; n.params.expirationOffset = c.expirationOffset; }
            if (n.type === "CERT_TEMPLATE") {
              const i = c.info || {}, cas = inv.cas || [], ca = find(cas, i.issuingCa) || (cas.length === 1 ? cas[0] : null);
              if (ca) n.params.caId = ca.id;
              if (i.cnPattern) n.params.commonNamePattern = String(i.cnPattern).replace(/\$\{(\w+)\}/g, "$($1)");
              if (i.validity) { n.params.validityType = i.validity.type; n.params.validityValue = i.validity.value; }
              for (const [k, f2] of [["organization", "organization"], ["locality", "locality"], ["state", "state"], ["country", "country"]]) if (i[f2]) n.params[k] = i[f2];
            }
            changes.push({ nodeId: n.id, message: `"${n.name}": ${what} “${want}” doesn't exist in R1, so this step will create it.` + (n.type === "CERT_TEMPLATE" && !n.params.caId ? " Choose the certificate authority that should issue it." : "") });
          }
        }
      }
      for (const o of n.options || []) walk(o.steps);
    }
  })(wf.steps);
  return changes;
}

// ---- model -> Builder nodes ---------------------------------------------------------------------------------------
function toBuildNodes(steps, inv = {}) {
  const out = [];
  for (const n of steps) {
    const p = n.params || {};
    const name = String(n.name).slice(0, 100);
    let r1, ref;
    switch (n.type) {
      case "AUP": r1 = { actionType: "AUP", name, ...pick(p, ["title", "messageHtml", "checkboxText", "checkboxHighlightColor", "backButtonText", "continueButtonText", "bottomLabel", "aupPlainText"]), checkboxDefaultState: !!p.checkboxDefaultState, ...(p.aupPlainText ? { useAupFile: false } : {}) }; break;
      case "DATA_PROMPT": r1 = { actionType: "DATA_PROMPT", name, title: p.title, messageHtml: p.messageHtml || undefined, displayTitle: !!p.displayTitle, displayMessageHtml: !!p.displayMessageHtml,
        variables: (p.variables || []).map((v, i) => ({ label: v.label, type: v.type, regex: v.regex || undefined, position: i + 1 })) }; break;
      case "DISPLAY_MESSAGE": r1 = { actionType: "DISPLAY_MESSAGE", name, ...pick(p, ["title", "messageHtml", "bottomLabel", "backButtonText", "continueButtonText"]), displayBackButton: !!p.displayBackButton, displayContinueButton: !!p.displayContinueButton, killSession: !!p.killSession }; break;
      case "USER_SELECTION_SPLIT": r1 = { actionType: "USER_SELECTION_SPLIT", name, title: p.title, messageHtml: p.messageHtml || undefined, displayTitle: !!p.displayTitle, displayMessageHtml: !!p.displayMessageHtml }; break;
      case "DPSK": {
        r1 = { actionType: "DPSK", name, emailNotification: !!p.emailNotification, smsNotification: !!p.smsNotification, qrCodeDisplay: !!p.qrCodeDisplay };
        if (p.mode === "existing") { const pool = (inv.dpskPools || []).find((x) => x.id === p.dpskPoolId); r1.dpskPoolId = p.dpskPoolId; r1.identityGroupId = pool && pool.identityGroupId; ref = { pool: pool ? pool.name : p.dpskPoolId }; }
        else ref = { pool: p.newName, spec: { passphraseFormat: p.passphraseFormat, passphraseLength: Number(p.passphraseLength) || 12, deviceCountLimit: p.deviceCountLimit ? Number(p.deviceCountLimit) : undefined, ssids: (p.ssids || []).filter((s) => s.ssid).map((s) => ({ ssid: s.ssid, vlan: s.vlan ? Number(s.vlan) : undefined })) } };
        break;
      }
      case "MAC_REG": {
        r1 = { actionType: "MAC_REG", name, clientEnterMacAddress: !!p.clientEnterMacAddress };
        if (p.mode === "existing") { const l = (inv.macPools || []).find((x) => x.id === p.macRegListId); r1.macRegListId = p.macRegListId; r1.identityGroupId = l && l.identityGroupId; ref = { list: l ? l.name : p.macRegListId }; }
        else ref = { list: p.newName, expirationType: p.expirationType, expirationOffset: Number(p.expirationOffset) };
        break;
      }
      case "CERT_TEMPLATE": {
        r1 = { actionType: "CERT_TEMPLATE", name };
        if (p.mode === "existing") { const t = (inv.certTemplates || []).find((x) => x.id === p.certTemplateId); r1.certTemplateId = p.certTemplateId; r1.identityGroupId = t && t.identityGroupId; ref = { template: t ? t.name : p.certTemplateId }; }
        else ref = { template: p.newName, info: { name: p.newName, caId: p.caId, cnPattern: p.commonNamePattern, validity: { type: p.validityType, value: Number(p.validityValue) || 1 },
          notBefore: { type: p.startType || "DAYS", value: Number(p.startValue) || 0 }, organization: p.organization, locality: p.locality, state: p.state, country: p.country, algorithm: p.algorithm } };
        break;
      }
      case "PASSPHRASE": r1 = { actionType: "PASSPHRASE", name, networkId: p.networkId, identityGroupId: p.identityGroupId }; break;
      case "CAPTIVE_PORTAL": r1 = { actionType: "CAPTIVE_PORTAL", name, redirectUrl: p.redirectUrl }; break;
      case "LDAP_AUTH_PROVIDER": r1 = { actionType: "LDAP_AUTH_PROVIDER", name, directoryServerProfileId: p.directoryServerProfileId }; break;
      case "IDP_AUTH_PROVIDER": r1 = { actionType: "IDP_AUTH_PROVIDER", name, samlIdpProfileId: p.samlIdpProfileId }; break;
      default: throw new Error("Cannot build a step of type " + n.type);
    }
    const node = { support: "auto", cloudpath: { name: n.name, label: n.name, kind: "editor" }, needs: [], notes: [], r1: stripEmpty(r1), ref };
    if (n.options) {
      node.options = n.options.map((o) => ({ name: String(o.name).slice(0, 100), criteria: "", r1: { actionType: "USER_SELECTION_SPLIT_OPTION", name: String(o.name).slice(0, 100), messageHtml: o.text || undefined },
        steps: toBuildNodes(o.steps, inv) }));
    }
    out.push(node);
  }
  return out;
}
function stripEmpty(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")); }

function toBuildWorkflow(wf, inv) {
  return { name: wf.name, description: wf.description || "Built with the workflow editor", steps: toBuildNodes(wf.steps, inv) };
}

// A readable outline for logs and tests.
function outline(steps, indent = "") {
  return steps.flatMap((n) => [`${indent}${n.type}: ${n.name}`, ...(n.options || []).flatMap((o) => [`${indent}  option "${o.name}"`, ...outline(o.steps, indent + "    ")])]);
}

module.exports = { TEMPLATE_FIELDS, blankTemplate, validateTemplate, templateRef, createMissing, ACTIONS, PLACEHOLDER, ONBOARD, newNode, newOption, blankWorkflow, fromPlan, validate, toBuildWorkflow, toBuildNodes, outline, everyBranchOnboards, visible, uid };
