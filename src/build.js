// Builds the planned workflows in RUCKUS One (and, with createMissing, the DPSK pools, identity groups, MAC pools and
// SSIDs they need). Talks to R1 only through `api`:
//   api.read(method, path, body)   always real (GET / query POST), used to find things that already exist
//   api.write(method, path, body)  a real call with api.apply, otherwise logged and answered with a fake id (dry run)
// Nothing existing is changed: objects found by name are reused, never edited. Whatever this run creates is recorded in
// `ledger` so rollback() can delete exactly that.
//
// Endpoints: pools/groups/networks from the docs.ruckus.cloud specs (dpsk 0.0.3, persona 0.0.2, mac-registration 0.0.1,
// wifi 21.3.5.41.1); the step/option calls follow the Workflow Management API 0.0.4 overview. The shapes of step and
// action reads were checked against your tenant's existing workflows; the create calls are NOT yet confirmed live.

// R1 marks a workflow INVALID unless every branch has an onboarding action ("minimum.onboarding.count", seen live 2026-10-13).
const ONBOARD = new Set(["DPSK", "MAC_REG", "CERT_TEMPLATE", "CAPTIVE_PORTAL", "PASSPHRASE"]);
function everyBranchOnboards(items) {
  if (items.some((i) => i.body && ONBOARD.has(i.body.actionType))) return true;
  const split = items.find((i) => i.options);
  return !!split && split.options.every((o) => everyBranchOnboards(o.nodes));
}

const { multipart } = require("./r1");
const { lookParts, guestNetworkBody } = require("./model");

const FORMATS = { numbers: "NUMBERS_ONLY", keyboard: "KEYBOARD_FRIENDLY", secure: "MOST_SECURED", words: "DICTIONARY_WORDS" };
const rows = (j) => (Array.isArray(j) ? j : (j && (j.data || j.content || j.items || j.results)) || []);
const idOf = (r) => r && (r.id || (r.content && r.content.id) || (r.data && r.data.id) || null);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const lc = (s) => String(s || "").toLowerCase();

function makeApi({ client, apply, log = console.log }) {
  let n = 0;
  return {
    apply: !!apply,
    read: (m, p, b) => (client ? client.call(m, p, b) : Promise.reject(new Error("no R1 client"))),
    async write(m, p, b) {
      log((apply ? "" : "[dry] ") + m + " " + p + (b ? " " + JSON.stringify(b).slice(0, 200) : ""));
      if (!apply) return { id: "dry-" + ++n };
      return client.call(m, p, b);
    },
  };
}

class Builder {
  constructor({ api, crawl, mapping = {}, opts = {}, log = console.log }) {
    this.api = api; this.crawl = crawl; this.mapping = mapping; this.opts = opts; this.log = log;
    this.ledger = []; this.reused = []; this.notes = []; this.skipped = [];
    this.cache = {}; this.made = {}; this.willCreate = [];
  }

  announce(kind, name) { this.willCreate.push({ kind, name }); }

  // R1 accepts many creates with 202 and finishes them in the background: wait until the object can be read.
  async waitFor(path, tries = 30) {
    if (!this.api.apply) return {};
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await this.api.read("GET", path); }
      catch (e) { last = e; if (e.status !== 404) throw e; await new Promise((r) => setTimeout(r, this.opts.pollMs === undefined ? 1000 : this.opts.pollMs)); }
    }
    throw last;
  }

  async pollFor(fn, what, tries = 30) {
    for (let i = 0; i < tries; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, this.opts.pollMs === undefined ? 1000 : this.opts.pollMs));
    }
    throw new Error("R1 did not finish creating " + what);
  }

  async waitGone(path, tries = 30) {
    for (let i = 0; i < tries; i++) {
      try { await this.api.read("GET", path); } catch (e) { if (e.status === 404) return; throw e; }
      await new Promise((r) => setTimeout(r, this.opts.pollMs === undefined ? 1000 : this.opts.pollMs));
    }
  }

  async list(key, fn) { return (this.cache[key] = this.cache[key] || (await fn().catch(() => []))); }
  existing(name, list) { return list.find((x) => lc(x.name) === lc(name)); }
  record(kind, id, name, del) { this.ledger.push({ kind, id, name, del }); }

  // ---- objects -------------------------------------------------------------------------------------------------
  async dpskPool(name, hint = {}) {
    const m = this.mapping.dpskPools && this.mapping.dpskPools[name];
    if (m && m.dpskPoolId) return m;
    if (this.made["dpsk:" + lc(name)]) return this.made["dpsk:" + lc(name)];
    const pools = await this.list("dpsk", async () => rows(await this.api.read("GET", "/dpskServices")));
    const have = this.existing(name, pools);
    if (have) {
      const groups = await this.list("groups", async () => rows(await this.api.read("GET", "/identityGroups?page=0&size=500")));
      this.reused.push("DPSK pool " + name);
      return { dpskPoolId: have.id, identityGroupId: have.identityGroupId || (groups.find((g) => g.dpskPoolId === have.id) || {}).id || null };
    }
    if (!this.opts.createMissing) return null;
    const src = { ...(((this.crawl.objects || {}).dpskPools || []).find((p) => lc(p.name) === lc(name)) || {}), ...(hint.deviceCountLimit != null ? { deviceLimit: hint.deviceCountLimit } : {}),
      ...(hint.ssids ? { ssids: hint.ssids } : {}) };
    this.announce("DPSK pool", name);
    // R1 creates an identity group for every new pool ("<name>_auto-generated-from-dpsk_..."); use that one.
    const body = clean({ name, passphraseFormat: FORMATS[this.opts.format] || hint.passphraseFormat || "MOST_SECURED",
      passphraseLength: hint.passphraseLength || src.passphraseLength || 12, policyDefaultAccess: src.defaultAccess ? /accept/i.test(src.defaultAccess) : true,
      deviceCountLimit: src.deviceLimit ? Number(src.deviceLimit) : null, expirationType: hint.expirationType || null, expirationOffset: hint.expirationType ? hint.expirationOffset : null });
    const pool = await this.api.write("POST", "/dpskServices", body);
    let poolId = idOf(pool), groupId = "dry-group";
    if (this.api.apply) {
      if (!poolId) poolId = (await this.pollFor(async () => this.existing(name, rows(await this.api.read("GET", "/dpskServices"))), "DPSK pool " + name)).id;
      const made = await this.pollFor(async () => { const d = await this.api.read("GET", `/dpskServices/${poolId}`); return d.identityGroupId ? d : null; }, "identity group of pool " + name);
      groupId = made.identityGroupId;
      this.record("identity group", groupId, name + " (auto-generated)", `/identityGroups/${groupId}`);   // before the pool: deleted after it
      this.record("DPSK pool", poolId, name, `/dpskServices/${poolId}`);
    }
    this.made["dpsk:" + lc(name)] = { dpskPoolId: poolId, identityGroupId: groupId };
    for (const n of src.ssids || []) await this.network(typeof n === "string" ? n : n.ssid, poolId, typeof n === "string" ? undefined : n.vlan);
    return this.made["dpsk:" + lc(name)];
  }

  async network(ssid, poolId, vlan) {
    const nets = await this.list("networks", async () => rows(await this.api.read("POST", "/wifiNetworks/query", { page: 1, pageSize: 100 })));
    const have = nets.find((n) => lc(n.ssid || n.name) === lc(ssid));
    if (have) { this.reused.push("Wi-Fi network " + ssid); return have.id; }
    if (this.made["net:" + lc(ssid)]) return this.made["net:" + lc(ssid)];
    this.announce("Wi-Fi network", ssid);
    const net = await this.api.write("POST", "/wifiNetworks", { type: "dpsk", name: ssid, description: "Created by R1 Workflow Studio", useDpskService: true,
      wlan: clean({ ssid, wlanSecurity: "WPA2Personal", vlanId: vlan || this.opts.vlan }) });
    let id = idOf(net);
    if (this.api.apply && !id) {                                   // R1 answers with a request id only: find the network by SSID
      id = (await this.pollFor(async () => rows(await this.api.read("POST", "/wifiNetworks/query", { page: 1, pageSize: 100 })).find((n) => lc(n.ssid || n.name) === lc(ssid)), "Wi-Fi network " + ssid)).id;
    }
    this.made["net:" + lc(ssid)] = id;
    if (this.api.apply) this.record("Wi-Fi network", id, ssid, `/wifiNetworks/${id}`);
    if (poolId) await this.api.write("PUT", `/wifiNetworks/${id}/dpskServices/${poolId}`);
    if (this.opts.venueId) await this.api.write("PUT", `/venues/${this.opts.venueId}/wifiNetworks/${id}`, { isAllApGroups: true, allApGroupsRadio: "Both" });
    else this.notes.push(`Network ${ssid} is not on any venue yet: choose a venue in the box at the top (or with --venue on the command line), or activate it in R1.`);
    return id;
  }

  async macPool(name, node) {
    const m = this.mapping.macLists && this.mapping.macLists[name];
    if (m && m.macRegListId) return m;
    if (this.made["mac:" + lc(name)]) return this.made["mac:" + lc(name)];
    const pools = await this.list("mac", async () => rows(await this.api.read("GET", "/macRegistrationPools?page=0&size=500")));
    const have = this.existing(name, pools);
    if (have) { this.reused.push("MAC registration pool " + name); return { macRegListId: have.id, identityGroupId: have.identityGroupId || null }; }
    if (!this.opts.createMissing) return null;
    this.announce("MAC registration pool", name); this.announce("identity group", name);
    const group = await this.api.write("POST", "/identityGroups", { name, description: "Created for MAC registration list " + name });
    const groupId = idOf(group);
    if (this.api.apply) this.record("identity group", groupId, name, `/identityGroups/${groupId}`);
    const unit = node.expirationType || { "Minutes After": "MINUTES_AFTER_TIME", "Hours After": "HOURS_AFTER_TIME", "Days After": "DAYS_AFTER_TIME" }[node.dateType];
    const pool = await this.api.write("POST", `/identityGroups/${groupId}/macRegistrationPools`, clean({ name, defaultAccess: "ACCEPT",
      expirationEnabled: unit ? true : null, expirationType: unit || null, expirationOffset: unit ? Number(node.expirationOffset != null ? node.expirationOffset : node.dateValue) : null }));
    const poolId = idOf(pool);
    if (this.api.apply) this.record("MAC registration pool", poolId, name, `/macRegistrationPools/${poolId}`);
    return (this.made["mac:" + lc(name)] = { macRegListId: poolId, identityGroupId: groupId });
  }

  async certTemplate(ref) {
    const name = ref.template;
    const m = this.mapping.certTemplates && this.mapping.certTemplates[name];
    if (m && m.certTemplateId) return m;
    if (this.made["tpl:" + lc(name)]) return this.made["tpl:" + lc(name)];
    const tpls = await this.list("tpls", async () => rows(await this.api.read("POST", "/certificateTemplates/query?page=0&size=200", {})));
    const have = this.existing(name, tpls);
    if (have) { this.reused.push("certificate template " + name); return { certTemplateId: have.id, identityGroupId: have.identityGroupId || null }; }
    if (!this.opts.createMissing) return null;
    const info = ref.info;
    if (!info) { this.notes.push(`Certificate template ${name}: Cloudpath details (CA, CN pattern, validity) are not in the crawl: re-crawl, or map it.`); return null; }
    const cas = await this.list("cas", async () => rows(await this.api.read("POST", "/certificateAuthorities/query?page=0&size=100", {})));
    this.announce("certificate template", name); this.announce("identity group", name);
    const mapped = info.caId ? { id: info.caId } : this.mapping.certAuthorities && this.mapping.certAuthorities[info.issuingCa];
    const wanted = this.opts.ca || (mapped && mapped.name) || info.issuingCa;
    const ca = (mapped && mapped.id && { id: mapped.id }) || this.existing(wanted, cas);
    if (!ca) { this.notes.push(`Certificate template ${name}: no R1 certificate authority named "${wanted}". Pass --ca NAME (one of: ${cas.map((c) => c.name).join(", ") || "none yet"}), or create the CA in R1 first.`); return null; }
    const groups = await this.list("groups", async () => rows(await this.api.read("GET", "/identityGroups?page=0&size=500")));
    let group = this.existing(name, groups);
    let groupId = group && group.id;
    if (!groupId) {
      groupId = idOf(await this.api.write("POST", "/identityGroups", { name, description: "Created for certificate template " + name }));
      if (this.api.apply) this.record("identity group", groupId, name, `/identityGroups/${groupId}`);
    }
    const v = info.validity || { type: "YEARS", value: 1 };
    const nb = info.notBefore && Number(info.notBefore.value) > 0 ? info.notBefore : { type: "DAYS", value: 1 };      // RUCKUS One: onboard.notBeforeValue must be greater than 0
    const body = clean({ name, description: info.description || (info.issuingCa ? "Created from Cloudpath certificate template " + name : "Created with R1 Workflow Studio"), caType: "ONBOARD", identityGroupId: groupId, keyLength: info.keyLength || 2048,
      algorithm: ["SHA_1", "SHA_256", "SHA_384", "SHA_512"].includes(info.algorithm) ? info.algorithm : "SHA_256",
      onboard: clean({ commonNamePattern: info.cnPattern || "$(USERNAME)", certificateType: "CLIENT", notAfterType: v.type, notAfterValue: v.value, notBeforeType: nb.type, notBeforeValue: nb.value,
        emailPattern: info.emailPattern || undefined, organizationPattern: info.organization, organizationUnitPattern: info.organizationUnit, localityPattern: info.locality, statePattern: info.state, countryPattern: info.country }) });
    const tpl = await this.api.write("POST", `/certificateAuthorities/${ca.id}/templates`, body);
    let id = idOf(tpl);
    if (this.api.apply) {
      if (!id) id = (await this.pollFor(async () => this.existing(name, rows(await this.api.read("POST", "/certificateTemplates/query?page=0&size=200", {}))), "certificate template " + name)).id;
      this.record("certificate template", id, name, `/certificateTemplates/${id}`);
    }
    return (this.made["tpl:" + lc(name)] = { certTemplateId: id, identityGroupId: groupId });
  }

  // ---- actions -------------------------------------------------------------------------------------------------
  async definitions() {
    const defs = await this.list("defs", async () => rows(await this.api.read("POST", "/workflowActionDefinitions/query?page=0&size=100", {})));
    const by = {}; for (const d of defs) by[d.actionType] = d.id; return by;
  }

  // The R1 action body for a plan node, or a reason it can't be built.
  async resolve(node) {
    const a = node.r1;
    if (!a) return { skip: node.end ? null : "no R1 action" };
    if (node.support === "manual") return { skip: "needs manual work" };
    const body = { ...a };
    if (a.actionType === "DPSK") {
      const p = a.dpskPoolId && a.identityGroupId ? a : await this.dpskPool(node.ref.pool, node.ref.spec || {});
      if (!p) return { skip: "DPSK pool not mapped or found (use --create-missing)" };
      Object.assign(body, { dpskPoolId: p.dpskPoolId, identityGroupId: p.identityGroupId });
    } else if (a.actionType === "MAC_REG") {
      const p = a.macRegListId && a.identityGroupId ? a : await this.macPool(node.ref.list, node.ref);
      if (!p) return { skip: "MAC registration pool not mapped or found (use --create-missing)" };
      Object.assign(body, { macRegListId: p.macRegListId, identityGroupId: p.identityGroupId });
    } else if (a.actionType === "CERT_TEMPLATE") {
      const t = a.certTemplateId && a.identityGroupId ? a : await this.certTemplate(node.ref || { template: a.name.replace(/^Certificate /, "") });
      if (!t) return { skip: "certificate template not mapped or found (use --create-missing --ca NAME)" };
      Object.assign(body, { certTemplateId: t.certTemplateId, identityGroupId: t.identityGroupId });
    } else if (a.actionType === "PASSPHRASE") {
      if (!body.networkId) return { skip: "network must be mapped (it is not created here)" };
    }
    return { body: clean(body) };
  }

  // R1 refuses a second enrollment action with the same name anywhere in the tenant, so each action gets a short unique suffix
  // (the visible step label is separate and unchanged).
  uniqueName(base) {
    const suffix = "-" + require("crypto").randomBytes(3).toString("hex");
    return String(base || "action").slice(0, 100 - suffix.length) + suffix;
  }

  async createAction(body, parentId) {
    const res = await this.api.write("POST", "/enrollmentActions", clean({ ...body, name: this.uniqueName(body.name), parentActionId: parentId }));
    const id = idOf(res);
    if (this.api.apply) { this.record("action", id, body.name, `/enrollmentActions/${id}`); await this.waitFor(`/enrollmentActions/${id}`); }
    return id;
  }

  // ---- workflows -----------------------------------------------------------------------------------------------
  blockers(nodes, out = []) {
    for (const n of nodes) {
      if (n.support === "manual") out.push(n);
      for (const o of n.options || []) this.blockers(o.steps, out);
    }
    return out;
  }

  async buildWorkflow(w) {
    const hard = this.blockers(w.steps).filter((n) => n.r1 && /SPLIT/.test(n.r1.actionType));
    const soft = this.blockers(w.steps).filter((n) => !(n.r1 && /SPLIT/.test(n.r1.actionType)));
    if (hard.length) return this.skip(w, "has a rule-based split that is not converted yet (" + hard.map((n) => n.cloudpath.name).join(", ") + ")");
    if (soft.length && !this.opts.allowPartial) return this.skip(w, "has steps with no R1 equivalent: " + soft.map((n) => `${n.cloudpath.kind} "${n.cloudpath.name || n.cloudpath.label}"`).join(", ") + " (use --allow-partial to build without them)");
    const wfs = await this.list("workflows", async () => rows(await this.api.read("POST", "/workflows/query?page=0&size=200", {})));
    if (this.existing((this.opts.prefix || '') + w.name, wfs)) return this.skip(w, "a workflow with this name already exists in R1");

    // Resolve everything first so a missing mapping stops the workflow before anything is created for it.
    const plan = await this.resolveTree(w.steps);
    if (plan.problem) return this.skip(w, plan.problem);
    if (this.opts.objectsOnly) { this.log(`  workflow ${w.name}: objects ready, workflow not built (--objects-only)`); return true; }
    if (!everyBranchOnboards(plan.nodes) && !this.opts.allowInvalid) {
      return this.skip(w, "R1 needs an onboarding action (DPSK, MAC registration, certificate, passphrase or captive portal) in every branch, and this workflow would not have one (use --allow-invalid to build it anyway)");
    }

    const defs = await this.definitions();
    this.announce("workflow", (this.opts.prefix || "") + w.name);
    const wf = await this.api.write("POST", "/workflows", { name: (this.opts.prefix || '') + w.name, description: w.description || `Converted from Cloudpath workflow "${w.name}" (${w.portalUrl || ""})`.trim() });
    const wfId = idOf(wf);
    if (this.api.apply) this.record("workflow", wfId, w.name, `/workflows/${wfId}`);
    let startId = null;
    if (this.api.apply) {
      const detail = await this.waitFor(`/workflows/${wfId}`);
      startId = detail.startStepId;
      if (!startId) throw new Error("R1 created the workflow but returned no start step");
    } else startId = "dry-start";
    await this.emit(wfId, defs, plan.nodes, { prior: startId });
    let state = "";
    if (this.api.apply) {
      await new Promise((r) => setTimeout(r, this.opts.pollMs === undefined ? 2000 : this.opts.pollMs));
      const d = await this.api.read("GET", `/workflows/${wfId}`).catch(() => ({}));
      if (d.status) state = `, R1 says ${d.status}` + ((d.statusReasons || []).length ? ": " + d.statusReasons.map((x) => x.statusReason).join("; ") : "");
      if (d.status === "INVALID") this.notes.push(`Workflow ${w.name} was built but R1 reports it INVALID${state.slice(state.indexOf(":"))}`);
    }
    if (w.look) {
      this.announce("look and feel", (this.opts.prefix || "") + w.name);
      await this.api.write("POST", `/workflows/${wfId}/uiConfigurations`, multipart(lookParts(w.look)));
      if (this.api.apply) await this.pollFor(async () => { const u = await this.api.read("GET", `/workflows/${wfId}/uiConfigurations`); return u && u.welcomeTitle === w.look.welcomeTitle ? u : null; }, "the look and feel", 120);
    }
    this.log(`  workflow ${w.name}: built (left unpublished${state})`);
    return true;
  }

  skip(w, why) { this.skipped.push({ workflow: w.name, why }); this.log(`  skipped ${w.name}: ${why}`); return false; }

  async resolveTree(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.support === "manual") continue;                        // allowed only with --allow-partial
      const r = await this.resolve(n);
      if (r.skip && n.r1) return { problem: `step "${n.cloudpath.name || n.cloudpath.label}": ${r.skip}` };
      const item = { node: n, body: r.body };
      if (n.options) {
        item.options = [];
        for (const o of n.options) {
          const sub = await this.resolveTree(o.steps);
          if (sub.problem) return sub;
          item.options.push({ opt: o, nodes: sub.nodes });
        }
      }
      out.push(item);
    }
    return { nodes: out };
  }

  // Creates steps one after another: each new step goes after the previous one. The first step of a split option
  // is attached to the option; everything else is a child of the step before it. A split step must be created with its
  // first option inside it (R1: "the first option must always be provided"); the other options are added afterwards.
  async emit(wfId, defs, items, ctx) {
    let prior = ctx.prior, first = true;
    for (const it of items) {
      if (!it.body) continue;                                      // an "end" output: R1 ends the path on its own
      const type = it.body.actionType;
      const actionId = await this.createAction(it.body, ctx.parentActionId);
      const optActions = [];
      for (const o of it.options || []) optActions.push(await this.createAction({ ...o.opt.r1 }, actionId));
      const optName = (o) => o.opt.name.replace(/\.{3}$/, "");
      const stepBody = clean({ type: it.options ? "splitStepDto" : "stepDto", actionDefinitionId: defs[type], enrollmentActionId: actionId, label: String(it.body.name).slice(0, 32),   // R1: label is at most 32 characters
       
        firstSplitOption: it.options ? { optionName: optName(it.options[0]), enrollmentActionId: optActions[0] } : undefined });
      const path = first && ctx.optionId ? `/workflows/${wfId}/steps/${ctx.splitStepId}/splitOptions/${ctx.optionId}/nextSteps` : `/workflows/${wfId}/steps/${prior}/nextSteps`;
      const stepId = idOf(await this.api.write("POST", path, stepBody));
      if (this.api.apply) await this.waitFor(`/workflows/${wfId}/steps/${stepId}`);   // deleting the workflow removes its steps
      first = false;
      if (it.options) {
        const optionIds = [];
        for (let k = 0; k < it.options.length; k++) {
          const body = { optionName: optName(it.options[k]), enrollmentActionId: optActions[k] };
          if (k > 0) {
            const made = await this.api.write("POST", `/workflows/${wfId}/steps/${stepId}/splitOptions`, body);
            if (idOf(made)) {
              if (this.api.apply) await this.waitFor(`/workflows/${wfId}/steps/${stepId}/splitOptions/${idOf(made)}`);   // don't touch the split while R1 is still adding options
              optionIds.push(idOf(made)); continue;
            }
          }
          // the first option came with the step; look the ids up (R1 finishes creates in the background)
          optionIds.push(this.api.apply
            ? (await this.pollFor(async () => rows(await this.api.read("GET", `/workflows/${wfId}/steps/${stepId}/splitOptions`)).find((x) => x.optionName === body.optionName), "split option " + body.optionName)).id
            : "dry-option-" + k);
        }
        for (let k = 0; k < it.options.length; k++) {
          await this.emit(wfId, defs, it.options[k].nodes, { prior: null, optionId: optionIds[k], splitStepId: stepId });
        }
        return;                                                    // a split ends this path; its branches carry on
      }
      prior = stepId;
    }
  }

  // Creates a guest network (portal SSID for visitors with a pass) from a guest-network model; optionally puts it on a venue.
  async buildGuestNetwork(g) {
    const body = guestNetworkBody(g, this.opts.prefix || "");
    try {
      this.announce("Wi-Fi network (guest)", body.name);
      await this.api.write("POST", "/wifiNetworks", body);
      let id = "dry-net";
      if (this.api.apply) {
        const net = await this.pollFor(async () => rows(await this.api.read("POST", "/wifiNetworks/query", { page: 1, pageSize: 200 })).find((n) => lc(n.name) === lc(body.name)), "the guest network " + body.name);
        id = net.id; this.record("Wi-Fi network", id, body.name, `/wifiNetworks/${id}`);
      }
      if (this.opts.venueId) await this.api.write("PUT", `/venues/${this.opts.venueId}/wifiNetworks/${id}`, { isAllApGroups: true, allApGroupsRadio: "Both" });
      else this.notes.push(`Guest network ${body.name} is not on any venue yet: choose a venue or activate it in R1.`);
      this.log(`  guest network ${body.name}: built`);
    } catch (e) {
      this.log("FAILED: " + e.message);
      if (this.api.apply && this.opts.rollback !== false) await this.rollback();
      throw e;
    }
    return { built: [body.name], skipped: this.skipped, reused: this.reused, created: this.ledger, notes: this.notes };
  }

  // Creates one certificate template (and its identity group) described by ref = templateRef(...). Reports like buildAll.
  async buildTemplate(ref) {
    try {
      const made = await this.certTemplate(ref);
      if (!made) this.skipped.push({ workflow: ref.template, why: "the certificate authority could not be found" });
      else this.log(`  certificate template ${ref.template}: built`);
    } catch (e) {
      this.log("FAILED: " + e.message);
      if (this.api.apply && this.opts.rollback !== false) await this.rollback();
      throw e;
    }
    return { built: this.skipped.length ? [] : [ref.template], skipped: this.skipped, reused: this.reused, created: this.ledger, notes: this.notes };
  }

  async buildAll(plan, only) {
    const ws = plan.workflows.filter((w) => !only.length || only.some((n) => lc(n) === lc(w.name)));
    const built = [];
    try {
      for (const w of ws) if (await this.buildWorkflow(w)) built.push(w.name);
    } catch (e) {
      this.log("FAILED: " + e.message);
      if (this.api.apply && this.opts.rollback !== false) await this.rollback();
      throw e;
    }
    return { built, skipped: this.skipped, reused: this.reused, created: this.ledger, notes: this.notes };
  }

  async rollback() {
    this.log(`Rolling back ${this.ledger.length} object(s) created in this run ...`);
    for (const x of [...this.ledger].reverse().sort((a, b) => (b.kind === "workflow") - (a.kind === "workflow"))) {   // workflows first: actions in use can't be deleted
      try {
        await this.waitFor(x.del, 15).catch(() => {});             // an unfinished background create would outlive the delete
        await this.api.write("DELETE", x.del); this.log(`  deleted ${x.kind} ${x.name}`);
        await this.waitGone(x.del);                                   // R1 deletes in the background; what depends on this (actions, groups) can only go after
      }
      catch (e) { this.log(`  could not delete ${x.kind} ${x.name} (${x.id}): ${e.message}`); }
    }
    this.ledger = [];
  }
}

module.exports = { Builder, makeApi, idOf };
