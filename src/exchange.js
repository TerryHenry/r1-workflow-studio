// Workflows, certificate templates and guest networks as files: export what is open in the editor, open one again later or on another
// computer. The file is plain JSON:
//   { format: "cloudpath-to-r1", version: 1, kind: "workflow" | "certTemplate" | "guestNetwork", name, exportedAt, data: <the editor's model> }
// Opening a file never trusts it: only known step types and fields are kept, ids are made fresh, sizes are capped, and the result goes
// through the same checks as anything else in the editor (Problems tab, preview, typed confirmation) before RUCKUS One is touched.
// References to R1 objects (DPSK pools, templates...) are by id and only mean something in the tenant they came from: they are listed as a
// warning, and the editor flags the ones that don't exist in the connected tenant.
const m = require("./model");

const FORMAT = "cloudpath-to-r1", VERSION = 1, MAX_NODES = 500, MAX_DEPTH = 12, MAX_TEXT = 200000;
const KINDS = new Set(["workflow", "certTemplate", "guestNetwork"]);
const bad = (message) => { const e = new Error(message); e.status = 400; return e; };

const clone = (x) => JSON.parse(JSON.stringify(x));
const str = (s, max = 1000) => String(s == null ? "" : s).slice(0, max);

// ---- export -------------------------------------------------------------------------------------------------------
function kindOf(model) { return model && model.kind === "certTemplate" ? "certTemplate" : model && model.kind === "guestNetwork" ? "guestNetwork" : "workflow"; }

function exportFile(model, now = new Date()) {
  if (!model || typeof model !== "object") throw bad("Nothing to export.");
  const data = clone(model);
  delete data._issues; delete data._notes;
  const kind = kindOf(model);
  const text = JSON.stringify({ format: FORMAT, version: VERSION, kind, name: str(model.name, 100), exportedAt: now.toISOString(), data }, null, 2);
  const safe = str(model.name || kind, 60).replace(/[^\w .()-]+/g, "_").trim() || kind;
  return { text, filename: `${safe}.${kind === "workflow" ? "workflow" : kind === "certTemplate" ? "certtemplate" : "guestnetwork"}.json`, kind };
}

// ---- import -------------------------------------------------------------------------------------------------------
function cleanSource(s) {
  if (!s || typeof s !== "object") return undefined;
  const out = {};
  if (s.cloudpathKind) out.cloudpathKind = str(s.cloudpathKind, 40);
  if (s.cloudpathName) out.cloudpathName = str(s.cloudpathName, 200);
  if (Array.isArray(s.notes)) out.notes = s.notes.slice(0, 20).map((x) => str(x, 1500));
  if (s.create && typeof s.create === "object") { const c = JSON.stringify(s.create); if (c.length <= 4000) out.create = JSON.parse(c); }
  return Object.keys(out).length ? out : undefined;
}

function cleanParams(type, params) {
  const spec = m.ACTIONS[type];
  const allowed = new Set([...Object.keys(spec.defaults || {}), ...(spec.fields || []).map((f) => f.key)]);
  const out = clone(spec.defaults || {});
  for (const [k, v] of Object.entries(params && typeof params === "object" ? params : {})) {
    if (!allowed.has(k)) continue;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[k] = typeof v === "string" ? str(v, MAX_TEXT) : v;
    else if (Array.isArray(v) || typeof v === "object") out[k] = JSON.parse(JSON.stringify(v));
  }
  return out;
}

function cleanCondition(c) {
  if (!c || typeof c !== "object") return null;
  return { ...m.newCondition(), variable: str(c.variable, 60), operation: str(c.operation, 30), value: str(c.value, 500) };
}

// Returns the cleaned step list; counts steps in `st` and adds what was changed to `st.warnings`.
function cleanSteps(list, st, depth = 0) {
  if (!Array.isArray(list)) return [];
  if (depth > MAX_DEPTH) throw bad("The file nests steps too deeply.");
  const out = [];
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    if (++st.count > MAX_NODES) throw bad(`The file has more than ${MAX_NODES} steps.`);
    let type = str(n.type, 40);
    const name = str(n.name, 100) || "Step";
    let node;
    if (type === m.PLACEHOLDER || !m.ACTIONS[type]) {
      if (type !== m.PLACEHOLDER) st.warnings.push(`"${name}" is a step type this version doesn't know (${type || "none"}): it was kept as a red placeholder.`);
      node = { id: m.uid(), type: m.PLACEHOLDER, name, params: {}, source: cleanSource(n.source) || { notes: [`Unknown step type in the file: ${type || "none"}.`] } };
    } else {
      node = { id: m.uid(), type, name, params: cleanParams(type, n.params) };
      const src = cleanSource(n.source); if (src) node.source = src;
    }
    if (Array.isArray(n.options) && node.type !== m.PLACEHOLDER) {
      node.options = n.options.slice(0, 50).map((o) => {
        o = o && typeof o === "object" ? o : {};
        const opt = { id: m.uid("o"), name: str(o.name, 100) || "Option", text: str(o.text, 300), steps: cleanSteps(o.steps, st, depth + 1) };
        if (o.criteria) opt.criteria = str(o.criteria, 2000);
        if (Array.isArray(o.conditions)) opt.conditions = o.conditions.slice(0, 20).map(cleanCondition).filter(Boolean);
        return opt;
      });
    }
    out.push(node);
  }
  return out;
}

function cleanLook(look) {
  if (!look || typeof look !== "object") return undefined;
  const out = clone(m.DEFAULT_LOOK);
  for (const [k, v] of Object.entries(look)) {
    if (k === "colors" && v && typeof v === "object") { for (const [ck, cv] of Object.entries(v)) if (ck in out.colors) out.colors[ck] = str(cv, 20); }
    else if (k === "images" && v && typeof v === "object") {
      out.images = {};
      for (const [ik, iv] of Object.entries(v)) if (iv && typeof iv === "object" && typeof iv.base64 === "string") out.images[ik] = { name: str(iv.name, 100), type: str(iv.type, 40), bytes: Number(iv.bytes) || undefined, base64: iv.base64 };
    } else if (k in out && k !== "images" && k !== "colors" && (v === null || ["string", "number", "boolean"].includes(typeof v))) out[k] = typeof v === "string" ? str(v, 300) : v;
  }
  return out;
}

// Only fields the editor knows, with the type of the blank form's value.
function cleanFlat(blank, data) {
  const out = clone(blank);
  for (const [k, def] of Object.entries(blank)) {
    const v = data[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(def)) { if (Array.isArray(v)) out[k] = v.slice(0, 200).map((x) => str(x, 500)); }
    else if (typeof def === "number") { if (Number.isFinite(Number(v))) out[k] = Number(v); }
    else if (typeof def === "boolean") out[k] = v === true || v === "true";
    else out[k] = str(v, k === "termsAndConditions" ? 100000 : 2000);
  }
  out.kind = blank.kind;
  return out;
}

// text: the file's contents. Returns { kind, model, warnings }. Throws an Error (status 400) with a message fit for the page.
function importFile(text, fileName = "") {
  if (typeof text !== "string" || !text.trim()) throw bad("That file is empty.");
  if (text.length > 11e6) throw bad("That file is too big.");
  let j;
  try { j = JSON.parse(text); } catch { throw bad("That isn't a workflow file: it isn't valid JSON."); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw bad("That isn't a workflow file.");
  const warnings = [];
  let kind, data;
  if (j.format === FORMAT) {
    if (!(Number(j.version) >= 1)) throw bad("That file has no version number.");
    if (Number(j.version) > VERSION) throw bad(`That file is from a newer version of this tool (file format ${j.version}, this one reads up to ${VERSION}). Update the tool and try again.`);
    kind = j.kind; data = j.data;
    if (!KINDS.has(kind)) throw bad("That file doesn't say what it holds (workflow, certificate template or guest network).");
  } else if (Array.isArray(j.steps)) { kind = "workflow"; data = j; warnings.push("This looks like a saved draft rather than an exported file; it was read as a workflow."); }
  else if (j.kind === "certTemplate" || j.kind === "guestNetwork") { kind = j.kind; data = j; warnings.push("This looks like a saved draft rather than an exported file."); }
  else throw bad("That isn't a file from this tool: no \"format\" and no steps.");
  if (!data || typeof data !== "object") throw bad("The file has no content.");

  let model;
  if (kind === "workflow") {
    const st = { count: 0, warnings };
    model = { name: str(data.name, 100) || str(fileName.replace(/\.(workflow\.)?json$/i, ""), 100) || "Imported workflow", description: str(data.description, 1000), steps: cleanSteps(data.steps, st) };
    const look = cleanLook(data.look); if (look) model.look = look;
    if (!model.steps.length) warnings.push("The workflow in this file has no steps.");
    const refs = [];
    (function walk(nodes) {
      for (const n of nodes) {
        const p = n.params || {};
        for (const k of ["dpskPoolId", "macRegListId", "certTemplateId", "directoryServerProfileId", "caId", "networkId", "identityGroupId"]) if (p[k]) refs.push(n.name);
        for (const o of n.options || []) walk(o.steps);
      }
    })(model.steps);
    if (refs.length) warnings.push(`${new Set(refs).size} step(s) point at RUCKUS One objects by id (${[...new Set(refs)].slice(0, 4).join(", ")}${new Set(refs).size > 4 ? "…" : ""}). Those ids only exist in the tenant the file came from: check the Problems tab, or choose the objects again.`);
  } else if (kind === "certTemplate") {
    model = cleanFlat(m.blankTemplate(), data);
    if (model.caId) warnings.push("The certificate authority is chosen by id; check it exists in this tenant.");
  } else model = cleanFlat(m.blankGuestNetwork(), data);
  return { kind, model, warnings, exportedAt: j.exportedAt ? str(j.exportedAt, 30) : undefined };
}

module.exports = { exportFile, importFile, FORMAT, VERSION };
