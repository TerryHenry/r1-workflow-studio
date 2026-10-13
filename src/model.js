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
  LOGICAL_SPLIT: { label: "Logical split (by device)", category: "split", help: "Sends the visitor down a branch automatically, by a condition on their device (type, OS, language...). Each branch has one or more conditions.", defaults: {}, fields: [] },
  DPSK: { label: "Give a DPSK passphrase", category: "onboard", help: "Issues a personal Wi-Fi passphrase from a DPSK pool.", defaults: { mode: "existing", passphraseFormat: "MOST_SECURED", passphraseLength: 12, emailNotification: false, smsNotification: false, qrCodeDisplay: false, ssids: [] },
    fields: [f("mode", "DPSK pool", "mode", { choices: [["existing", "Use an existing pool"], ["new", "Create a new pool"]] }),
      f("dpskPoolId", "Pool", "ref", { ref: "dpskPools", showIf: { mode: "existing" }, required: true }),
      f("newName", "New pool name", "text", { max: 100, showIf: { mode: "new" }, required: true }),
      f("passphraseFormat", "Passphrase format", "select", { choices: FORMATS.map((x) => [x, x]), showIf: { mode: "new" } }),
      f("passphraseLength", "Passphrase length", "number", { min: 8, max: 63, showIf: { mode: "new" } }),
      f("deviceCountLimit", "Devices per passphrase (blank = unlimited)", "number", { min: 1, showIf: { mode: "new" } }),
      f("expirationType", "Passphrases expire", "select", { choices: [["", "never"], ["HOURS_AFTER_TIME", "hours after they are made"], ["DAYS_AFTER_TIME", "days after they are made"], ["WEEKS_AFTER_TIME", "weeks after they are made"], ["MONTHS_AFTER_TIME", "months after they are made"]], showIf: { mode: "new" } }),
      f("expirationOffset", "…after how many", "number", { min: 1, showIf: { mode: "new" } }),
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

// ---- look and feel of a workflow's portal (R1: PATCH-style POST /workflows/{id}/uiConfigurations) ----
const LOOK_COLORS = [["backgroundColor", "Page background"], ["lineColor", "Lines"], ["fontColor", "Text"], ["fontHeaderColor", "Header text"], ["headerBarBackgroundColor", "Header bar"],
  ["startOverFontColor", "Start over link"], ["buttonColor", "Buttons"], ["buttonFontColor", "Button text"]];
const DEFAULT_LOOK = { welcomeTitle: "", welcomeName: "", colors: { backgroundColor: "#ECECEC", lineColor: "#FFFFFF", fontColor: "#000000", fontHeaderColor: "#000000", headerBarBackgroundColor: "#E57200", startOverFontColor: "#FFFFFF", buttonColor: "#4A4A4A", buttonFontColor: "#FFFFFF" },
  logoSize: "MEDIUM", fontName: "Arial", headerFontSize: 16, disablePoweredBy: false, images: {} };
const HEX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
const IMG_MAX = 5 * 1024 * 1024;       // bytes per image
function validateLook(look) {
  const issues = [];
  if (!look) return issues;
  if (!String(look.welcomeTitle || "").trim()) issues.push({ level: "error", message: "Look and feel: the welcome title is required by R1 (clear the look and feel to keep R1's defaults)." });
  for (const [k, label] of LOOK_COLORS) if (look.colors && look.colors[k] && !HEX.test(look.colors[k])) issues.push({ level: "error", message: `Look and feel: ${label} is not a color like #E57200.` });
  if (look.headerFontSize != null && look.headerFontSize !== "" && !(Number(look.headerFontSize) >= 8 && Number(look.headerFontSize) <= 72)) issues.push({ level: "error", message: "Look and feel: the header font size must be 8 to 72." });
  for (const [kind, img] of Object.entries(look.images || {})) {
    if (!img) continue;
    if (!/^image\/(png|jpe?g|gif|svg\+xml)$/.test(img.type || "")) issues.push({ level: "error", message: `Look and feel: the ${kind} image must be a PNG, JPEG, GIF or SVG file.` });
    if ((img.bytes != null ? img.bytes : Math.round(String(img.base64 || "").length * 0.75)) > IMG_MAX) issues.push({ level: "error", message: `Look and feel: the ${kind} image is over 5 MB.` });
  }
  return issues;
}
// What R1's uiConfigurations call takes (multipart: the JSON plus any images).
function lookParts(look) {
  const cfg = { welcomeTitle: look.welcomeTitle, welcomeName: look.welcomeName || "", uiColorSchema: { ...look.colors },
    uiStyleSchema: { fontName: look.fontName || "Arial", logoSize: look.logoSize || "MEDIUM", disablePoweredBy: !!look.disablePoweredBy, headerFontSize: Number(look.headerFontSize) || 16 } };
  const parts = { uiConfiguration: { json: cfg } };
  const names = { logo: "logoImage", background: "backgroundImage", icon: "iconImage" };
  for (const [k, img] of Object.entries(look.images || {})) if (img && names[k]) parts[names[k]] = { file: { filename: img.filename || k, type: img.type, base64: img.base64 } };
  return parts;
}

// ---- Cloudpath split rules -> R1 logical-split conditions --------------------------------------------------------------
// A Cloudpath split option can carry filters ("workflowFilter.<name>Regex" with an "...Operator" of Matches / Does Not Match).
// R1 has no regular expressions: only equals / contains / starts with / ends with (and negations of equals / contains).
const RULE_FIELDS = {
  operatingSystem: { variable: "CP_DEVICE_OS", label: "operating system" },
  userAgent: { variable: "CP_BROWSER_NAME", label: "browser (user agent)", approx: "Cloudpath tests the whole user-agent text; R1's field is the browser name only." },
  language: { variable: "CP_LANGUAGE", label: "language" },
};
const RULE_LABELS = { groupName: "user group", username: "user name", userDn: "directory path", email: "email address", macRegistration: "MAC registration list", dhcpDeviceSummary: "DHCP device summary",
  location: "location", existingCommonName: "existing certificate name", existingIssuerCommonName: "existing certificate issuer", existingTemplateName: "existing certificate template", voucherList: "voucher list" };
const PLAIN = "[\\w .:@/-]*";
// One regex -> { operation, value } or null when R1's comparisons can't say the same thing.
function regexToComparison(regex, negate) {
  const r = String(regex || "").trim().replace(/^\^/, "").replace(/\$$/, "");
  const anchoredBoth = new RegExp("^" + PLAIN + "$"), contains = new RegExp("^\\.\\*(" + PLAIN + ")\\.\\*$"), starts = new RegExp("^(" + PLAIN + ")\\.\\*$"), ends = new RegExp("^\\.\\*(" + PLAIN + ")$");
  let m;
  if (!r) return null;
  if (anchoredBoth.test(r)) return { operation: negate ? "DOES_NOT_EQUAL" : "EQUALS", value: r };
  if ((m = r.match(contains))) return { operation: negate ? "DOES_NOT_CONTAIN" : "CONTAINS", value: m[1] };
  if (negate) return null;                                             // R1 has no "does not start / end with"
  if ((m = r.match(starts))) return { operation: "STARTS_WITH", value: m[1] };
  if ((m = r.match(ends))) return { operation: "ENDS_WITH", value: m[1] };
  return null;
}
// fields: a Cloudpath split option's form fields. Returns { conditions, notes }.
function ruleToConditions(fields) {
  const conditions = [], notes = [];
  for (const [k, v] of Object.entries(fields || {})) {
    const m = k.match(/^workflowFilter\.(\w+?)Regex$/); if (!m || v == null || typeof v === "object" || String(v) === "") continue;
    const name = m[1], regex = String(v), negate = /not/i.test(String((fields || {})[`workflowFilter.${name}RegexOperator`] || ""));
    const target = RULE_FIELDS[name];
    if (!target) { notes.push(`Cloudpath rule on the ${RULE_LABELS[name] || name} (${negate ? "does not match" : "matches"} "${regex}") has no field in R1's logical split, so it isn't carried over.`); continue; }
    const cmp = regexToComparison(regex, negate);
    if (!cmp) { notes.push(`Cloudpath rule on the ${target.label} uses the pattern "${regex}", which R1's comparisons (equals, contains, starts with, ends with) can't express. Set the branch by hand.`); continue; }
    conditions.push({ variable: target.variable, operation: cmp.operation, value: cmp.value });
    if (target.approx) notes.push(target.approx);
  }
  return { conditions, notes };
}

// Cloudpath "Look & Feel" form fields -> an R1 look, or null when it is all Cloudpath defaults with no titles (nothing to carry over).
// Returns { look, notes } | null. R1's portal look is narrower than Cloudpath's HTML templates: what can't be carried over is listed in notes.
function lookFromCloudpath(cp, workflowName) {
  if (!cp) return null;
  const hex = (c) => (c ? (String(c).startsWith("#") ? String(c) : "#" + String(c)).toUpperCase() : undefined);
  const MAP = { backgroundColor: "webBackgroundColor", lineColor: "webLineColor", headerBarBackgroundColor: "webHeaderTopbarColor", startOverFontColor: "webHeaderStartOverColor", buttonColor: "webButtonBackgroundColor", buttonFontColor: "webButtonFontColor" };
  const look = JSON.parse(JSON.stringify(DEFAULT_LOOK));
  for (const [r1k, cpk] of Object.entries(MAP)) if (hex(cp[cpk])) look.colors[r1k] = hex(cp[cpk]);
  look.welcomeTitle = cp.welcomeTitle1 || cp.webTitle || ""; look.welcomeName = cp.welcomeTitle2 || "";
  const custom = JSON.stringify(look.colors) !== JSON.stringify(DEFAULT_LOOK.colors);
  const notes = [];
  if (cp.templateStyle && !/^Modern \(Ruckus\)$/.test(cp.templateStyle)) notes.push(`Cloudpath uses the "${cp.templateStyle}" page style, which R1 doesn't have: R1's portal has one layout, so only the colors and titles are carried over.`);
  for (const [k, what] of [["htmlTemplateFile", "a custom HTML template"], ["cssOverrideFile", "a CSS override file"], ["customZipFile", "a custom page package"]]) if (cp[k]) notes.push(`Cloudpath uses ${what} (${cp[k]}); R1 can't take it, so it isn't carried over.`);
  const imgs = [["webBackgroundImageFile", "background image"], ["bannerImageFile", "banner image"], ["iconFile", "icon"], ["appLogoFile", "app logo"]].filter(([k]) => cp[k]);
  for (const [k, what] of imgs) notes.push(`Cloudpath has a ${what} (${cp[k]}). Download it from Cloudpath and add it in the Look tab: files can't be fetched automatically yet.`);
  const unmapped = ["webHeaderRibbonColor", "webAccordionSelectedBackgroundColor", "webAccordionButtonBackgroundColor", "iconTextColor"].filter((k) => cp[k] && !["000000", "75787B"].includes(String(cp[k]).toUpperCase()));
  if (unmapped.length) notes.push("Some Cloudpath colors have no R1 equivalent (ribbon, accordion, icon text) and were not carried over.");
  if (!look.welcomeTitle && !look.welcomeName && !custom && !imgs.length && !notes.length) return null;
  if (!look.welcomeTitle) look.welcomeTitle = workflowName || "Welcome";       // R1 requires a welcome title
  return { look, notes };
}

// ---- guest network (a captive-portal network where visitors sign in with a pass) ----
const GUEST_TYPES = [["GuestPass", "Guest pass (visitor enters a code)"], ["SelfSignIn", "Self sign-in (visitor registers)"], ["HostApproval", "Host approval"], ["ClickThrough", "Click through (accept terms only)"]];
const GUEST_FIELDS = [
  f("name", "Network name", "text", { max: 100, required: true }), f("ssid", "Wi-Fi name (SSID)", "text", { max: 32, required: true }), f("description", "Description", "text", { max: 256 }),
  f("guestNetworkType", "How visitors sign in", "select", { choices: GUEST_TYPES }),
  f("wlanSecurity", "Wi-Fi security", "select", { choices: [["None", "Open"], ["OWE", "Open with encryption (OWE)"]] }), f("vlanId", "VLAN", "number", { min: 1, max: 4094 }),
  f("title", "Portal page title", "text", { max: 100 }), f("tagLine", "Tag line", "text", { max: 140 }), f("welcomeMessage", "Welcome message", "text", { max: 100 }),
  f("termsAndConditions", "Terms and conditions (the acceptable use policy)", "textarea", { max: 100000 }),
  f("hostDomains", "Host email domains (one per line)", "lines", { showIf: { guestNetworkType: "HostApproval" } }), f("hostDurationChoices", "Hours a host can approve (one per line)", "lines", { showIf: { guestNetworkType: "HostApproval" } }),
  f("maxDevices", "Devices per visitor", "number", { min: 1, max: 20 }), f("userSessionTimeout", "Session timeout (minutes)", "number", { min: 1 }), f("userSessionGracePeriod", "Grace period (minutes)", "number", { min: 0 }),
  f("macCredentialsDuration", "Remember a device for (minutes)", "number", { min: 0 }), f("endOfDayReauthDelay", "Require sign-in again at the end of the day", "bool"),
  f("redirectUrl", "Send visitors to this address afterwards", "text"), f("walledGardens", "Addresses reachable before sign-in (one per line)", "lines"),
];
function blankGuestNetwork() { return { kind: "guestNetwork", name: "New guest network", ssid: "", description: "", guestNetworkType: "GuestPass", wlanSecurity: "None", vlanId: 1, title: "Welcome", tagLine: "", welcomeMessage: "",
  termsAndConditions: "", hostDomains: [], hostDurationChoices: [], maxDevices: 1, userSessionTimeout: 1440, userSessionGracePeriod: 60, macCredentialsDuration: 240, endOfDayReauthDelay: false, redirectUrl: "", walledGardens: [] }; }
function validateGuestNetwork(g, inv = {}, opts = {}) {
  const issues = [], add = (message) => issues.push({ level: "error", message });
  for (const fd of GUEST_FIELDS) {
    if (fd.showIf && !Object.entries(fd.showIf).every(([k, v]) => g[k] === v)) continue;
    const v = g[fd.key], empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (fd.required && empty) { add(`${fd.label} is required.`); continue; }
    if (empty) continue;
    if (fd.max && fd.type !== "number" && fd.type !== "lines" && String(v).length > fd.max) add(`${fd.label} is over ${fd.max} characters.`);
    if (fd.type === "number" && (Number.isNaN(Number(v)) || (fd.min != null && Number(v) < fd.min) || (fd.max != null && Number(v) > fd.max))) add(`${fd.label} must be a number${fd.min != null ? " from " + fd.min : ""}${fd.max != null ? " to " + fd.max : ""}.`);
  }
  if (g.guestNetworkType === "HostApproval") {
    if (!(g.hostDomains || []).length) add("Host approval needs at least one host email domain.");
    if (!(g.hostDurationChoices || []).length || (g.hostDurationChoices || []).some((x) => !(Number(x) > 0))) add("Host approval needs the hours a host can approve (whole numbers, one per line).");
  }
  const full = (opts.prefix || "") + (g.name || ""), ssid = String(g.ssid || "");
  if ((inv.networks || []).some((n) => lc(n.name) === lc(full))) add(`A Wi-Fi network named "${full}" already exists in R1. Rename this one.`);
  if (ssid && (inv.networks || []).some((n) => lc(n.ssid) === lc(ssid))) add(`A Wi-Fi network with the SSID "${ssid}" already exists in R1: choose a different one.`);
  return issues;
}
// The body R1's POST /wifiNetworks takes for a guest network.
function guestNetworkBody(g, prefix = "") {
  const list = (x) => (x || []).map((v) => String(v).trim()).filter(Boolean);
  const portal = { guestNetworkType: g.guestNetworkType || "GuestPass", maxDevices: Number(g.maxDevices) || 1, userSessionTimeout: Number(g.userSessionTimeout) || 1440,
    userSessionGracePeriod: g.userSessionGracePeriod === "" || g.userSessionGracePeriod == null ? 60 : Number(g.userSessionGracePeriod), macCredentialsDuration: g.macCredentialsDuration == null || g.macCredentialsDuration === "" ? 240 : Number(g.macCredentialsDuration),
    endOfDayReauthDelay: !!g.endOfDayReauthDelay, lockoutPeriodEnabled: false, enableSelfService: g.guestNetworkType === "SelfSignIn" || g.guestNetworkType === "GuestPass",
    guestPage: Object.fromEntries(Object.entries({ langCode: "en", title: g.title, tagLine: g.tagLine, welcomeMessage: g.welcomeMessage, termsAndConditions: g.termsAndConditions, wifi4Eu: false }).filter(([, v]) => v !== undefined && v !== "")) };
  if (g.redirectUrl) portal.redirectUrl = g.redirectUrl;
  if (list(g.walledGardens).length) portal.walledGardens = list(g.walledGardens);
  if (g.guestNetworkType === "HostApproval") portal.hostGuestConfig = { hostDomains: list(g.hostDomains), hostDurationChoices: list(g.hostDurationChoices).map(Number) };
  return { type: "guest", name: prefix + g.name, ...(g.description ? { description: g.description } : {}),
    wlan: { ssid: g.ssid, wlanSecurity: g.wlanSecurity || "None", vlanId: Number(g.vlanId) || 1, enabled: true }, guestPortal: portal };
}

// A Cloudpath workflow that verifies a voucher code (oob step) is, in R1, a guest network where visitors sign in with a pass.
// `cpWf` is the raw crawled Cloudpath workflow. Returns { guest, notes }, or null when it has no voucher step.
function guestFromPlan(cpWf) {
  const planWf = cpWf, found = {};
  (function walk(nodes) { for (const n of nodes || []) { if (n.kind === "aup" && !found.aup) found.aup = n; if (n.kind === "oob" && !found.oob) found.oob = n; for (const o of n.options || []) walk(o.steps); } })(cpWf.steps);
  if (!found.oob) return null;
  const val = (n, key) => { const v = n && n.fields && n.fields[key]; return v == null ? "" : typeof v === "object" ? (v.default || v.text || "") : String(v); };
  const slug = String(planWf.name).replace(/[^\w -]/g, "").trim().slice(0, 24) || "workflow";
  const g = blankGuestNetwork();
  Object.assign(g, { name: `${planWf.name} guest network`.slice(0, 100), ssid: `${slug}-guest`.slice(0, 32), description: `Converted from the Cloudpath workflow "${planWf.name}" (voucher sign-in)`, title: "Welcome", welcomeMessage: "Enter the code you were given" });
  const notes = [];
  const lists = [val(found.oob, "otpListPk"), val(found.oob, "alternateOtpListPks")].filter(Boolean);
  const sms = val(found.oob, "allowSms") === "1", mail = val(found.oob, "allowEmail") === "1";
  notes.push("Cloudpath checks a voucher code the visitor enters" + (lists.length ? " (voucher list: " + lists.join(", ") + ")" : "") + ". In R1 that is a guest-pass network: visitors enter their pass on the portal page.");
  if (sms || mail) notes.push("Cloudpath could send the code by " + [sms && "SMS", mail && "email"].filter(Boolean).join(" or ") + ". In R1 the delivery method is chosen when each pass is created (by a sponsor, the guest API or Visitor Desk).");
  if (found.aup) notes.push("The acceptable use policy step becomes the portal page's terms: paste your policy text into “Terms and conditions”.");
  notes.push("Cloudpath's voucher lists (the pre-made codes) are not copied; passes are created in R1.");
  notes.push("A new SSID is needed: R1 does not allow two networks with the same name. Cloudpath moved visitors to a second network afterwards; a guest network is the network visitors stay on.");
  return { guest: g, notes };
}

// Logical split conditions (R1 "Logical Split"; API action FUNCTIONAL_SPLIT). Read from a split made in the R1 GUI (workflow "a test workflow"):
// each branch is an option whose action holds evaluationConditions [{ sourceActionId, variableName, operation, evaluationRegex }].
// (R1 itself does not validate variable names, so any other name can still be typed in the editor.)
// Variable names and labels read from the R1 GUI's Logical Split dialog (workflow a test workflow, 2026-10-13). The dialog also offers the fields of
// an earlier form step ("Display a Form"); how those are stored isn't known here, so they are not offered.
const LOGIC_FIELDS = [["CP_DEVICE_TYPE", "Device type"], ["CP_DEVICE_OS", "Device OS"], ["CP_BROWSER_NAME", "Browser name"], ["CP_LANGUAGE", "Language"], ["CP_PORTAL_SSID", "Captive portal SSID"],
  ["CP_VENUE_NAME", "Venue name"], ["CP_AP_GROUP_NAME", "AP group"], ["CP_DEVICE_MAC", "Device MAC address"], ["CP_DEVICE_IP", "Device IP address"]];
// Comparisons R1 accepts (from R1's own error message for an unknown one, 2026-10-13). "IS" / "IS_NOT" sit beside EQUALS /
// DOES_NOT_EQUAL; how R1 tells them apart isn't documented, so both are offered.
const LOGIC_OPS = [["EQUALS", "equals"], ["DOES_NOT_EQUAL", "does not equal"], ["IS", "is"], ["IS_NOT", "is not"], ["CONTAINS", "contains"], ["DOES_NOT_CONTAIN", "does not contain"], ["STARTS_WITH", "starts with"], ["ENDS_WITH", "ends with"]];
const newCondition = () => ({ variable: LOGIC_FIELDS[0][0], operation: "EQUALS", value: "" });

let seq = 0;
const uid = (p = "n") => p + Date.now().toString(36) + (++seq).toString(36);

function newNode(type, name) {
  const spec = ACTIONS[type];
  if (!spec) throw new Error("Unknown step type " + type);
  const node = { id: uid(), type, name: name || spec.label, params: JSON.parse(JSON.stringify(spec.defaults)) };
  if (type === "USER_SELECTION_SPLIT") node.options = [newOption("Option 1"), newOption("Option 2")];
  if (type === "LOGICAL_SPLIT") node.options = [{ ...newOption("Branch 1"), conditions: [newCondition()] }, { ...newOption("Branch 2"), conditions: [newCondition()] }];
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
      } else if (t === "FUNCTIONAL_SPLIT") {
        node = newNode("LOGICAL_SPLIT", n.r1.name); node.options = [];
        src.notes = ["Cloudpath chose the branch by rules. R1's logical split does the same by device fields; rules R1 can't express are listed under each branch, which then needs conditions set by hand." +
          (/All/i.test(n.matchBehavior || "") ? " Cloudpath used every matching branch; R1 takes the first matching one." : "")];
      } else if (t === "USER_SELECTION_SPLIT") {
        node = newNode("USER_SELECTION_SPLIT", n.r1.name);
        node.params.title = "Choose one"; node.options = [];
      } else if (t === "PASSPHRASE") {
        node = newNode("PASSPHRASE", n.r1.name);
        const net = find(inv.networks, n.ref && n.ref.network);
        if (net) node.params.networkId = net.id;
      } else continue;
      node.source = src;
      if (n.options) {
        node.options = n.options.map((o) => {
          const base = { id: uid("o"), name: o.name.replace(/\.{3}$/, ""), text: (o.r1 && o.r1.messageHtml) || "", steps: convert(o.steps), criteria: o.criteria };
          if (t !== "FUNCTIONAL_SPLIT") return base;
          const rc = ruleToConditions(o.fields);
          return { ...base, conditions: rc.conditions, criteria: [o.criteria, ...rc.notes].filter(Boolean).join(" ") };
        });
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
      if (n.type === "DPSK" && n.params.mode === "new" && n.params.expirationType && !(Number(n.params.expirationOffset) >= 1)) add("error", `"${n.name}": say how many ${String(n.params.expirationType).split("_")[0].toLowerCase()} until the passphrases expire.`, n.id);
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
      if (n.type === "LOGICAL_SPLIT") {
        if (!n.options || !n.options.length) add("error", `"${n.name}": a logical split needs at least one branch.`, n.id);
        else if (n.options.length === 1) add("warn", `"${n.name}": with a single branch, visitors who don't match its conditions have no path. Add another branch.`, n.id);
        const seen = new Set();
        for (const o of n.options || []) {
          if (!String(o.name || "").trim()) add("error", `"${n.name}": a branch has no name.`, n.id);
          if (seen.has(lc(o.name))) add("error", `"${n.name}": two branches are called "${o.name}".`, n.id);
          seen.add(lc(o.name));
          if (!(o.conditions || []).length) add("error", `"${n.name}": branch "${o.name}" needs at least one condition.`, n.id);
          for (const c of o.conditions || []) {
            if (!String(c.variable || "").trim()) add("error", `"${n.name}": a condition in branch "${o.name}" has no field.`, n.id);
            if (!LOGIC_OPS.some((x) => x[0] === c.operation)) add("error", `"${n.name}": a condition in branch "${o.name}" has an unknown comparison.`, n.id);
            if (!String(c.value == null ? "" : c.value).length) add("error", `"${n.name}": a condition in branch "${o.name}" has no value to compare with.`, n.id);
          }
          if (!o.steps.length) add("warn", `"${n.name}": branch "${o.name}" has no steps.`, n.id);
          walk(o.steps);
        }
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
  issues.push(...validateLook(wf.look));
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
      case "LOGICAL_SPLIT": r1 = { actionType: "FUNCTIONAL_SPLIT", name }; break;
      case "USER_SELECTION_SPLIT": r1 = { actionType: "USER_SELECTION_SPLIT", name, title: p.title, messageHtml: p.messageHtml || undefined, displayTitle: !!p.displayTitle, displayMessageHtml: !!p.displayMessageHtml }; break;
      case "DPSK": {
        r1 = { actionType: "DPSK", name, emailNotification: !!p.emailNotification, smsNotification: !!p.smsNotification, qrCodeDisplay: !!p.qrCodeDisplay };
        if (p.mode === "existing") { const pool = (inv.dpskPools || []).find((x) => x.id === p.dpskPoolId); r1.dpskPoolId = p.dpskPoolId; r1.identityGroupId = pool && pool.identityGroupId; ref = { pool: pool ? pool.name : p.dpskPoolId }; }
        else ref = { pool: p.newName, spec: { passphraseFormat: p.passphraseFormat, passphraseLength: Number(p.passphraseLength) || 12, deviceCountLimit: p.deviceCountLimit ? Number(p.deviceCountLimit) : undefined, expirationType: p.expirationType || undefined, expirationOffset: p.expirationType ? Number(p.expirationOffset) : undefined, ssids: (p.ssids || []).filter((s) => s.ssid).map((s) => ({ ssid: s.ssid, vlan: s.vlan ? Number(s.vlan) : undefined })) } };
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
      node.options = n.options.map((o) => ({ name: String(o.name).slice(0, 100), criteria: "",
        r1: n.type === "LOGICAL_SPLIT"
          ? { actionType: "FUNCTIONAL_SPLIT_OPTION", name: String(o.name).slice(0, 100), evaluationConditions: (o.conditions || []).map((c) => ({ sourceActionId: null, variableName: c.variable, operation: c.operation, evaluationRegex: String(c.value) })) }
          : { actionType: "USER_SELECTION_SPLIT_OPTION", name: String(o.name).slice(0, 100), messageHtml: o.text || undefined },
        steps: toBuildNodes(o.steps, inv) }));
    }
    out.push(node);
  }
  return out;
}
function stripEmpty(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")); }

function toBuildWorkflow(wf, inv) {
  return { name: wf.name, description: wf.description || "Built with the workflow editor", steps: toBuildNodes(wf.steps, inv), look: wf.look && wf.look.welcomeTitle !== undefined ? wf.look : undefined };
}

// A readable outline for logs and tests.
function outline(steps, indent = "") {
  return steps.flatMap((n) => [`${indent}${n.type}: ${n.name}`, ...(n.options || []).flatMap((o) => [`${indent}  option "${o.name}"`, ...outline(o.steps, indent + "    ")])]);
}

// The image type from the file's own first bytes (R1 serves images as application/octet-stream).
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 4 && buf.slice(0, 4).toString("latin1") === "GIF8") return "image/gif";
  const head = buf.slice(0, 300).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}
module.exports = { ruleToConditions, regexToComparison, lookFromCloudpath, LOGIC_FIELDS, LOGIC_OPS, newCondition, guestFromPlan, sniffImage, LOOK_COLORS, DEFAULT_LOOK, validateLook, lookParts, GUEST_FIELDS, GUEST_TYPES, blankGuestNetwork, validateGuestNetwork, guestNetworkBody, TEMPLATE_FIELDS, blankTemplate, validateTemplate, templateRef, createMissing, ACTIONS, PLACEHOLDER, ONBOARD, newNode, newOption, blankWorkflow, fromPlan, validate, toBuildWorkflow, toBuildNodes, outline, everyBranchOnboards, visible, uid };
