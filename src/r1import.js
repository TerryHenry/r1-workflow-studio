// Reads an existing RUCKUS One workflow or certificate template into the editor's model, as something to edit and save as a
// NEW copy. Read-only: nothing here writes to R1, and the original is never touched.
const { ACTIONS, PLACEHOLDER, uid, DEFAULT_LOOK, blankGuestNetwork, sniffImage } = require("./model");

const rows = (j) => (Array.isArray(j) ? j : (j && (j.data || j.content || j.items || j.results)) || []);
const hex = (c) => (c ? (String(c).startsWith("#") ? c : "#" + c) : c);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

// R1 action -> editor params for each supported action type.
const FROM_ACTION = {
  AUP: (a) => ({ ...pick(a, ["title", "messageHtml", "checkboxText", "checkboxDefaultState", "backButtonText", "continueButtonText", "bottomLabel", "aupPlainText"]), checkboxHighlightColor: hex(a.checkboxHighlightColor) || "#FCFFB3" }),
  DATA_PROMPT: (a) => ({ ...pick(a, ["title", "messageHtml", "displayTitle", "displayMessageHtml"]), messageHtml: a.messageHtml || "", variables: (a.variables || []).map((v) => ({ label: v.label, type: v.type, ...(v.regex ? { regex: v.regex } : {}) })) }),
  DISPLAY_MESSAGE: (a) => pick(a, ["title", "messageHtml", "bottomLabel", "backButtonText", "continueButtonText", "displayBackButton", "displayContinueButton", "killSession"]),
  FUNCTIONAL_SPLIT: () => ({}),
  USER_SELECTION_SPLIT: (a) => ({ ...pick(a, ["title", "displayTitle", "displayMessageHtml"]), messageHtml: a.messageHtml || "" }),
  DPSK: (a) => ({ mode: "existing", dpskPoolId: a.dpskPoolId, ...pick(a, ["emailNotification", "smsNotification", "qrCodeDisplay"]) }),
  MAC_REG: (a) => ({ mode: "existing", macRegListId: a.macRegListId, clientEnterMacAddress: !!a.clientEnterMacAddress }),
  CERT_TEMPLATE: (a) => ({ mode: "existing", certTemplateId: a.certTemplateId }),
  PASSPHRASE: (a) => ({ networkId: a.networkId, identityGroupId: a.identityGroupId }),
  CAPTIVE_PORTAL: (a) => ({ redirectUrl: a.redirectUrl }),
  LDAP_AUTH_PROVIDER: (a) => ({ directoryServerProfileId: a.directoryServerProfileId }),
  IDP_AUTH_PROVIDER: (a) => ({ samlIdpProfileId: a.samlIdpProfileId }),
};

const IMAGE_KINDS = { logo: "logoImageFileName", background: "backgroundImageName", icon: "iconImageName" };

// The workflow's portal look and feel, or undefined when it is still R1's default (nothing to carry over).
async function importLook(client, id, warnings, fetchImpl = fetch) {
  let u;
  try { u = await client.call("GET", `/workflows/${id}/uiConfigurations`); } catch { return undefined; }
  const colors = { ...DEFAULT_LOOK.colors, ...(u.uiColorSchema || {}) };
  const st = u.uiStyleSchema || {};
  const look = { welcomeTitle: u.welcomeTitle || "", welcomeName: u.welcomeName || "", colors, logoSize: st.logoSize || "MEDIUM", fontName: st.fontName || "Arial", headerFontSize: st.headerFontSize || 16, disablePoweredBy: !!st.disablePoweredBy, images: {} };
  for (const [kind, field] of Object.entries(IMAGE_KINDS)) {
    if (!st[field]) continue;
    try {
      const r = await client.call("GET", `/workflows/${id}/uiConfigurations/${kind}`);
      const res = await fetchImpl(r.fileUrl);
      if (!res.ok) throw new Error("download failed (" + res.status + ")");
      const buf = Buffer.from(await res.arrayBuffer());
      const type = sniffImage(buf);
      if (!type) { warnings.push(`The ${kind} image is in a format the editor doesn't recognise, so it was not copied.`); continue; }
      if (buf.length > 5 * 1024 * 1024) { warnings.push(`The ${kind} image is over 5 MB, so it was not copied. Add it again after resizing.`); continue; }
      look.images[kind] = { filename: `${kind}.${(type.split("/")[1] || "png").replace("svg+xml", "svg").replace("jpeg", "jpg")}`, type, base64: buf.toString("base64") };
    } catch (e) { warnings.push(`The ${kind} image could not be copied (${e.message}). Add it again in the look and feel.`); }
  }
  const isDefault = !look.welcomeTitle && !look.welcomeName && JSON.stringify(colors) === JSON.stringify(DEFAULT_LOOK.colors) && look.logoSize === "MEDIUM" && look.fontName === "Arial" && look.headerFontSize === 16 && !look.disablePoweredBy && !Object.keys(look.images).length;
  return isDefault ? undefined : look;
}

// R1 lists come back a page at a time (10 by default): read every page.
async function allRows(call, path) {
  const out = [];
  for (let page = 0; page < 100; page++) {
    const res = await call("GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}&size=100`);
    out.push(...rows(res));
    if (!res || !res.paging || page + 1 >= (res.paging.pageCount || 1)) break;
  }
  return out;
}

async function importWorkflow(client, id, fetchImpl) {
  const call = (m, p) => client.call(m, p);
  const wf = await call("GET", `/workflows/${id}`);
  const steps = await allRows(call, `/workflows/${id}/steps`);
  const by = Object.fromEntries(steps.map((s) => [s.id, s]));
  const warnings = [];
  const actionCache = {};
  const action = async (aid) => (actionCache[aid] = actionCache[aid] || (await call("GET", `/enrollmentActions/${aid}`)));
  const seen = new Set();

  async function node(step) {
    const a = await action(step.enrollmentActionId);
    const type = step.actionType || a.actionType;
    const editorType = type === "FUNCTIONAL_SPLIT" ? "LOGICAL_SPLIT" : type;
    const spec = ACTIONS[editorType], conv = FROM_ACTION[type];
    const label = (step.label || "").trim();
    const name = label || (spec && spec.label) || type;
    if (!spec || !conv) {
      warnings.push(`Step “${name}” is a ${type} step, which the editor can't edit yet. It is kept as a placeholder: replace or delete it.`);
      return { id: uid(), type: PLACEHOLDER, name, params: {}, source: { notes: [`R1 step type ${type} isn't supported by the editor yet.`] } };
    }
    const n = { id: uid(), type: editorType, name, params: { ...JSON.parse(JSON.stringify(spec.defaults)), ...conv(a) } };
    if (type === "USER_SELECTION_SPLIT" || type === "FUNCTIONAL_SPLIT") {
      const opts = await allRows(call, `/workflows/${id}/steps/${step.id}/splitOptions`);
      n.options = [];
      for (const o of opts) {
        const oa = o.enrollmentActionId ? await action(o.enrollmentActionId) : {};
        const opt = { id: uid(), name: o.optionName, text: oa.messageHtml || "", steps: await chain(by[o.nextStepId]) };
        if (type === "FUNCTIONAL_SPLIT") {
          opt.conditions = (oa.evaluationConditions || []).map((c) => ({ variable: c.variableName, operation: c.operation, value: c.evaluationRegex == null ? "" : String(c.evaluationRegex) }));
          if ((oa.evaluationConditions || []).some((c) => c.sourceActionId)) warnings.push(`A condition in branch “${o.optionName}” compares a field from an earlier form step; the copy keeps the field name but not the link to that step. Check it.`);
        }
        n.options.push(opt);
      }
    }
    return n;
  }
  // Follow nextStepId from a step until the path ends.
  async function chain(step) {
    const out = [];
    while (step && step.type !== "endStepDto") {
      if (seen.has(step.id)) { warnings.push("The workflow loops back on itself; the copy stops at the loop."); break; }
      seen.add(step.id);
      if (step.type !== "startStepDto") {
        const n = await node(step);
        out.push(n);
        if (n.options) break;                                    // a choice ends this path; its options carry on
      }
      step = by[step.nextStepId];
    }
    return out;
  }
  const start = by[wf.startStepId];
  const body = start ? await chain(start) : [];
  const look = await importLook(client, id, warnings, fetchImpl);
  if (wf.status === "INVALID") warnings.push("R1 reports the original workflow as INVALID" + ((wf.statusReasons || []).length ? ": " + wf.statusReasons.map((r) => r.statusReason).join("; ") : "") + ". The copy may need the same fixes.");
  return {
    workflow: { name: `${wf.name} (copy)`, description: wf.description || `Copy of the RUCKUS One workflow “${wf.name}”`, steps: body, ...(look ? { look } : {}), source: { r1: id, r1Name: wf.name } },
    warnings,
  };
}

// A certificate template as an editable form object (kind: "certTemplate").
async function importCertTemplate(client, id) {
  const list = rows(await client.call("POST", "/certificateTemplates/query?page=0&size=200", {}));
  const t = list.find((x) => x.id === id);
  if (!t) throw Object.assign(new Error("That certificate template was not found in R1."), { status: 404 });
  const o = t.onboard || {};
  const warnings = [];
  let validityType = o.notAfterType, validityValue = o.notAfterValue;
  if (validityType === "SPECIFIED_DATE") { warnings.push(`This template ends on a fixed date (${o.notAfterDate}). The editor sets a duration instead: 1 year is filled in, change it if needed.`); validityType = "YEARS"; validityValue = 1; }
  let startType = o.notBeforeType, startValue = o.notBeforeValue;
  if (startType === "SPECIFIED_DATE") { warnings.push(`This template starts on a fixed date (${o.notBeforeDate}). The copy starts 1 day before it is issued (RUCKUS One needs more than 0).`); startType = "DAYS"; startValue = 1; }
  if (t.caType && t.caType !== "ONBOARD") warnings.push(`This template uses the ${t.caType} certificate source, which the editor can't copy. Only onboard templates are supported.`);
  return {
    template: {
      kind: "certTemplate", name: `${t.name} (copy)`, description: t.description || "", caId: o.certificateAuthorityId || "", commonNamePattern: o.commonNamePattern || "", emailPattern: o.emailPattern || "",
      validityType, validityValue, startType, startValue, organization: o.organizationPattern || "", organizationUnit: o.organizationUnitPattern || "", locality: o.localityPattern || "",
      state: o.statePattern || "", country: o.countryPattern || "", algorithm: t.algorithm || "SHA_256", keyLength: t.keyLength || 2048, source: { r1: id, r1Name: t.name },
    },
    warnings,
  };
}

// An existing guest network as an editable form object (kind: "guestNetwork").
async function importGuestNetwork(client, id) {
  const n = await client.call("GET", `/wifiNetworks/${id}`);
  if (n.type !== "guest") throw Object.assign(new Error("That Wi-Fi network is not a guest network."), { status: 400 });
  const p = n.guestPortal || {}, pg = p.guestPage || {}, w = n.wlan || {}, warnings = [];
  const g = { ...blankGuestNetwork(), name: `${n.name} (copy)`, ssid: "", description: n.description || "", guestNetworkType: p.guestNetworkType || "GuestPass", wlanSecurity: ["None", "OWE"].includes(w.wlanSecurity) ? w.wlanSecurity : "None", vlanId: w.vlanId || 1,
    title: pg.title || "", tagLine: pg.tagLine || "", welcomeMessage: pg.welcomeMessage || "", termsAndConditions: pg.termsAndConditions || "",
    hostDomains: (p.hostGuestConfig || {}).hostDomains || [], hostDurationChoices: ((p.hostGuestConfig || {}).hostDurationChoices || []).map(String),
    maxDevices: p.maxDevices || 1, userSessionTimeout: p.userSessionTimeout || 1440, userSessionGracePeriod: p.userSessionGracePeriod == null ? 60 : p.userSessionGracePeriod, macCredentialsDuration: p.macCredentialsDuration == null ? 240 : p.macCredentialsDuration,
    endOfDayReauthDelay: !!p.endOfDayReauthDelay, redirectUrl: p.redirectUrl || "", walledGardens: p.walledGardens || [], source: { r1: id, r1Name: n.name } };
  warnings.push(`The Wi-Fi name (SSID) is left blank: R1 won't allow two networks with the same SSID ("${w.ssid}"), so choose a new one.`);
  if (!["None", "OWE"].includes(w.wlanSecurity)) warnings.push(`The original uses ${w.wlanSecurity} security, which the editor can't copy yet; the copy is open.`);
  if (["Workflow", "Cloudpath", "WISPr", "Directory", "SAML"].includes(p.guestNetworkType)) { warnings.push(`The original is a ${p.guestNetworkType} network, which the editor can't copy; the copy is a guest-pass network instead.`); g.guestNetworkType = "GuestPass"; }
  return { guest: g, warnings };
}

module.exports = { importWorkflow, importCertTemplate, importGuestNetwork, importLook, FROM_ACTION };
