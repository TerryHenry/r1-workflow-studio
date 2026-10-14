// Reads every workflow from a Cloudpath admin UI (read-only: GET requests only).
// Run it inside a signed-in Cloudpath admin tab. It posts the result to the local receiver
// (node bin/receive.js) and falls back to downloading crawl.json.
// Layout notes: Cloudpath 6.0.6056. Pages are server-rendered HTML; this will need care on other versions.
(async () => {
  const RECEIVER = window.__CRAWL_RECEIVER || "http://127.0.0.1:8765/crawl";
  const parse = (html) => new DOMParser().parseFromString(html, "text/html");
  const get = async (url) => {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(url + " -> " + r.status);
    return r.text();
  };
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const PLUGIN = /\/?([A-Za-z]+)\/WorkflowPlugin-([0-9a-f-]+)/;

  // Form fields of an edit page: effective value, plus the built-in default text for blanks.
  function formFields(doc) {
    const fields = {}, defaults = {};
    for (const e of doc.querySelectorAll("form input, form select, form textarea")) {
      const n = e.name;
      if (!n || /csrf|^cpnFormAction$|-checkbox$/i.test(n)) continue;
      if (/-default$/.test(n)) { defaults[n.slice(0, -8)] = e.value; continue; }
      if (e.type === "radio") { if (e.checked) fields[n] = e.value; continue; }
      if (e.type === "checkbox") { fields[n] = e.checked ? e.value : ""; continue; }
      if (e.tagName === "SELECT") { const o = e.selectedOptions[0]; fields[n] = o ? { value: o.value, text: clean(o.textContent) } : ""; continue; }
      if (e.type === "password") continue;
      fields[n] = e.value;
    }
    return { fields, defaults };
  }

  // One display state of a workflow page -> flat list of list items with their nesting depth.
  function items(doc) {
    return [...doc.querySelectorAll(".cp-list-item")].map((el) => {
      // branch depth = highest cp-list-group-N around the item (the group markers are siblings, not nested)
      let depth = 0;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const g = p.className && typeof p.className === "string" && p.className.match(/cp-list-group-(\d+)/);
        if (g) depth = Math.max(depth, Number(g[1]));
      }
      const edit = [...el.querySelectorAll(".cp-list-item-menu a[href]")].find((a) => PLUGIN.test(a.getAttribute("href")) && !/\/items|\/preview/.test(a.getAttribute("href")));
      const m = edit && edit.getAttribute("href").match(PLUGIN);
      const title = el.querySelector(".cp-list-item-title");
      const isResult = el.classList.contains("cp-list-item-result");
      const links = title ? [...title.querySelectorAll("a[href]")].filter((a) => !a.closest(".cp-list-item-buttonBar")).map((a) => ({
        text: clean(a.textContent), href: a.getAttribute("href"), tooltip: a.getAttribute("data-tooltip-message") || "" })) : [];
      const opts = el.querySelectorAll(".cp-list-item-buttonBar-buttons .cp-list-item-buttonBar-button");
      const options = [...opts].map((b, i) => {
        const sel = [...b.querySelectorAll("a")].find((a) => /workflowPluginPk=/.test(a.getAttribute("onclick") || ""));
        const ed = b.querySelector('a[href*="/item/"]');
        const q = sel && sel.getAttribute("onclick").match(/workflowPluginPk=(\d+)&index=(\d+)/);
        return { index: i, name: sel ? clean(sel.textContent) : "", tooltip: sel ? sel.getAttribute("data-tooltip-message") || "" : "",
          selectKey: q ? q[1] : null, itemEdit: ed ? ed.getAttribute("href") : null,
          selected: /selected-/.test(b.className) && !/unselected/.test(b.className) };
      }).filter((o) => o.name || o.itemEdit);
      return { depth, kind: isResult ? "output" : m ? m[1] : null, pluginId: m ? m[2] : null, editHref: edit ? edit.getAttribute("href") : null,
        label: title ? clean(title.textContent).replace(/^(.*?)(First match in:|All matches in:)/, "$2") : "", links, options,
        number: clean((el.querySelector(".cp-list-item-left-step") || {}).textContent) };
    }).filter((i) => i.kind);
  }

  async function detail(base, step) {
    if (!step.editHref) return {};
    const url = new URL(step.editHref, base).href;
    const doc = parse(await get(url));
    return { editUrl: new URL(url).pathname + new URL(url).search, ...formFields(doc) };
  }

  // Steps at `level` in the region after `from` (a selection's branch is the deeper items that follow it).
  async function readRegion(base, wfPk, flat, from, level, path) {
    const out = [];
    for (let j = from; j < flat.length; j++) {
      const it = flat[j];
      if (it.depth < level) break;
      if (it.depth > level) continue;
      const step = { kind: it.kind, pluginId: it.pluginId, number: it.number, label: it.label, links: it.links, ...(await detail(base, it)) };
      if (it.kind === "selection") {
        step.matchBehavior = (step.fields && step.fields.matchBehavior && step.fields.matchBehavior.text) || "";
        step.options = [];
        for (const o of it.options) {
          const opt = { name: o.name, criteria: o.tooltip };
          if (o.itemEdit) { const d = parse(await get(new URL(o.itemEdit, base).href)); Object.assign(opt, formFields(d)); }
          const url = base + "?workflowPluginPk=" + o.selectKey + "&index=" + o.index;
          const doc2 = parse(await get(url));
          const flat2 = items(doc2);
          const at = flat2.findIndex((x) => x.pluginId === it.pluginId && x.kind === "selection");
          opt.steps = await readRegion(base, wfPk, flat2, at + 1, level + 1, path.concat([o.index]));
          step.options.push(opt);
        }
      }
      out.push(step);
    }
    return out;
  }

  const listDoc = parse(await get("/admin/workflow/viewAllWorkflows"));
  const rows = [...new Set([...listDoc.querySelectorAll('a[href^="/admin/workflow/"]')].map((a) => a.getAttribute("href")).filter((h) => /^\/admin\/workflow\/\d+\/$/.test(h)))];
  const version = (document.body.innerText.match(/Version\s+([\d.]+)/) || [])[1] || "";
  const result = { source: location.origin, cloudpathVersion: version, crawledAt: new Date().toISOString(), workflows: [] };
  for (const href of rows) {
    const pk = Number(href.match(/(\d+)/)[1]);
    const base = new URL(href, location.origin).href;
    const doc = parse(await get(href));
    const text = clean(doc.body.innerText);
    const wf = { pk, name: (text.match(/Workflow - "([^"]*)"/) || [])[1] || "", portalUrl: (text.match(/\/enroll\/[^\s]+\//) || [])[0] || "",
      published: /Published/.test(text.slice(text.indexOf("Workflow - "), text.indexOf("Workflow - ") + 300)) && !/Unpublished/.test(text.slice(text.indexOf("Workflow - "), text.indexOf("Workflow - ") + 300)) };
    try { wf.steps = await readRegion(base, pk, items(doc), 0, 0, []); } catch (e) { wf.error = String(e); }
    try {                                   // Look & Feel tab: the form's non-empty fields
      const lf = parse(await get(href + "template")), look = {};
      for (const e of lf.querySelectorAll("form input, form select, form textarea")) {
        if (!e.name || /csrf|password|^cpnFormAction$|^tab$|-default$|-checkbox$/i.test(e.name)) continue;
        if ((e.type === "radio" || e.type === "checkbox") && !e.checked) continue;
        const v = e.tagName === "SELECT" ? clean((e.selectedOptions[0] || {}).textContent) : e.value;
        if (v !== "") look[e.name] = String(v).slice(0, 200);
      }
      wf.look = look;
    } catch (e) { wf.lookError = String(e); }
    result.workflows.push(wf);
    console.log("crawled", wf.name, wf.steps ? wf.steps.length + " steps" : wf.error);
  }
  // Objects the workflows point at: DPSK pools and device configurations (SSIDs). Pages show "Label:" then the value.
  const lines = (doc) => {
    doc.querySelectorAll("script,style").forEach((e) => e.remove());
    const x = doc.body.innerText.split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    return x.slice(x.lastIndexOf("Diagnostics") + 1);
  };
  const kv = (L) => { const o = {}; for (let i = 0; i < L.length - 1; i++) if (/:$/.test(L[i]) && !/:$/.test(L[i + 1])) o[L[i].slice(0, -1)] = L[i + 1]; return o; };
  const none = (v) => (!v || /^\[None\]$/.test(v) ? null : v);
  result.objects = { dpskPools: [], deviceConfigs: [] };
  try {
    const pools = parse(await get("/admin/dpsk/"));
    for (const h of new Set([...pools.querySelectorAll('a[href*="viewPoolInfo"]')].map((a) => a.getAttribute("href")))) {
      const k = kv(lines(parse(await get(h))));
      result.objects.dpskPools.push({ name: k["Name"], deviceLimit: none(k["Device Limit"]), ssids: (k["SSID(s)"] || "").split(/[;,]\s*/).filter(Boolean),
        defaultExpiration: none(k["Default Expiration Date"]), defaultAccess: k["Default Access(No Policy Match)"] });
    }
    const nets = parse(await get("/admin/advanced/networks/"));
    for (const h of new Set([...nets.querySelectorAll('a[href*="/networks/"][href*="summary"]')].map((a) => a.getAttribute("href")))) {
      const s = kv(lines(parse(await get(h))));
      const L = lines(parse(await get(h.replace("/summary", "/ssids"))));
      const wlans = [];
      for (let i = 0; i < L.length; i++) { const m = L[i].match(/^WLAN '([^']*)'$/); if (m) wlans.push({ ssid: m[1], protocol: L[i + 1] }); }
      result.objects.deviceConfigs.push({ name: (s["Name"] || "").replace(/ mode_edit$/, ""), wlans });
    }
  } catch (e) { result.objects.error = String(e); }
  window.__crawl = result;
  const body = JSON.stringify(result);
  if (window.__NO_SEND) return "crawled " + body.length + " bytes (kept in window.__crawl)";
  try {
    const r = await fetch(RECEIVER, { method: "POST", headers: { "content-type": "application/json", ...(window.__CRAWL_CODE ? { "x-crawl-code": window.__CRAWL_CODE } : {}) }, body });
    return "sent " + body.length + " bytes to receiver: " + r.status;
  } catch (e) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: "application/json" })); a.download = "crawl.json"; a.click();
    return "receiver not reachable (" + e + "); downloaded crawl.json instead";
  }
})();
