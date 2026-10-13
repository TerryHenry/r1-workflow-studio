// Reads an existing RUCKUS One workflow or certificate template into the editor's model, as something to edit and save as a
// NEW copy. Read-only: nothing here writes to R1, and the original is never touched.
const { ACTIONS, PLACEHOLDER, uid } = require("./model");

const rows = (j) => (Array.isArray(j) ? j : (j && (j.data || j.content || j.items || j.results)) || []);
const hex = (c) => (c ? (String(c).startsWith("#") ? c : "#" + c) : c);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

// R1 action -> editor params for each supported action type.
const FROM_ACTION = {
  AUP: (a) => ({ ...pick(a, ["title", "messageHtml", "checkboxText", "checkboxDefaultState", "backButtonText", "continueButtonText", "bottomLabel", "aupPlainText"]), checkboxHighlightColor: hex(a.checkboxHighlightColor) || "#FCFFB3" }),
  DATA_PROMPT: (a) => ({ ...pick(a, ["title", "messageHtml", "displayTitle", "displayMessageHtml"]), messageHtml: a.messageHtml || "", variables: (a.variables || []).map((v) => ({ label: v.label, type: v.type, ...(v.regex ? { regex: v.regex } : {}) })) }),
  DISPLAY_MESSAGE: (a) => pick(a, ["title", "messageHtml", "bottomLabel", "backButtonText", "continueButtonText", "displayBackButton", "displayContinueButton", "killSession"]),
  USER_SELECTION_SPLIT: (a) => ({ ...pick(a, ["title", "displayTitle", "displayMessageHtml"]), messageHtml: a.messageHtml || "" }),
  DPSK: (a) => ({ mode: "existing", dpskPoolId: a.dpskPoolId, ...pick(a, ["emailNotification", "smsNotification", "qrCodeDisplay"]) }),
  MAC_REG: (a) => ({ mode: "existing", macRegListId: a.macRegListId, clientEnterMacAddress: !!a.clientEnterMacAddress }),
  CERT_TEMPLATE: (a) => ({ mode: "existing", certTemplateId: a.certTemplateId }),
  PASSPHRASE: (a) => ({ networkId: a.networkId, identityGroupId: a.identityGroupId }),
  CAPTIVE_PORTAL: (a) => ({ redirectUrl: a.redirectUrl }),
  LDAP_AUTH_PROVIDER: (a) => ({ directoryServerProfileId: a.directoryServerProfileId }),
  IDP_AUTH_PROVIDER: (a) => ({ samlIdpProfileId: a.samlIdpProfileId }),
};

async function importWorkflow(client, id) {
  const call = (m, p) => client.call(m, p);
  const wf = await call("GET", `/workflows/${id}`);
  const steps = rows(await call("GET", `/workflows/${id}/steps`));
  const by = Object.fromEntries(steps.map((s) => [s.id, s]));
  const warnings = [];
  const actionCache = {};
  const action = async (aid) => (actionCache[aid] = actionCache[aid] || (await call("GET", `/enrollmentActions/${aid}`)));
  const seen = new Set();

  async function node(step) {
    const a = await action(step.enrollmentActionId);
    const type = step.actionType || a.actionType;
    const spec = ACTIONS[type], conv = FROM_ACTION[type];
    const label = (step.label || "").trim();
    const name = label || (spec && spec.label) || type;
    if (!spec || !conv) {
      warnings.push(`Step “${name}” is a ${type} step, which the editor can't edit yet. It is kept as a placeholder: replace or delete it.`);
      return { id: uid(), type: PLACEHOLDER, name, params: {}, source: { notes: [`R1 step type ${type} isn't supported by the editor yet.`] } };
    }
    const n = { id: uid(), type, name, params: { ...JSON.parse(JSON.stringify(spec.defaults)), ...conv(a) } };
    if (type === "USER_SELECTION_SPLIT") {
      const opts = rows(await call("GET", `/workflows/${id}/steps/${step.id}/splitOptions`));
      n.options = [];
      for (const o of opts) {
        const oa = o.enrollmentActionId ? await action(o.enrollmentActionId) : {};
        n.options.push({ id: uid(), name: o.optionName, text: oa.messageHtml || "", steps: await chain(by[o.nextStepId]) });
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
  if (wf.status === "INVALID") warnings.push("R1 reports the original workflow as INVALID" + ((wf.statusReasons || []).length ? ": " + wf.statusReasons.map((r) => r.statusReason).join("; ") : "") + ". The copy may need the same fixes.");
  return {
    workflow: { name: `${wf.name} (copy)`, description: wf.description || `Copy of the RUCKUS One workflow “${wf.name}”`, steps: body, source: { r1: id, r1Name: wf.name } },
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
  if (startType === "SPECIFIED_DATE") { warnings.push(`This template starts on a fixed date (${o.notBeforeDate}). The copy starts now.`); startType = "DAYS"; startValue = 0; }
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

module.exports = { importWorkflow, importCertTemplate, FROM_ACTION };
