// Reads every workflow from a Cloudpath admin UI (read-only: GET requests only).
// Run it inside a signed-in Cloudpath admin tab. It posts the result to the local receiver
// (node bin/receive.js) and falls back to downloading crawl.json.
// Layout notes: Cloudpath 6.0.6056. Pages are server-rendered HTML; this will need care on other versions.
(async () => {
  const RECEIVER = window.__CRAWL_RECEIVER || "http://127.0.0.1:8765/crawl";
  const parse = (html) => new DOMParser().parseFromString(html, "text/html");
  const get = async (url) => {
    for (let attempt = 0; ; attempt++) {                              // a busy server (429, 5xx) or a dropped request is tried again, twice
      try {
        const r = await fetch(url, { credentials: "same-origin" });
        if (r.ok) return r.text();
        if (attempt >= 2 || (r.status < 500 && r.status !== 429)) throw new Error(url + " -> " + r.status);
      } catch (e) { if (attempt >= 2 || /-> \d+$/.test(String(e.message))) throw e; }
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    }
  };
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Secrets are never kept: shared passphrases, API keys, OAuth secrets, default passwords. Descriptions, labels and endpoints are fine.
  const SECRET = /secret|password|passphrase|api.?key|consumer.?key|private.?key|access.?key|token/i, NOT_SECRET = /(description|label|caption|regex|variable|required|endpoint|url|file|name|supported|rotationschedule|length)$/i;
  const tip = (s) => (s || "").replace(/((?:secret|password|passphrase|api ?key|token)[^:\n]{0,24}:[ \t]*)[^\n]+/gi, "$1[removed]");   // tooltips such as "Shared secret: …"
  const redact = (name, value) => (SECRET.test(name) && !NOT_SECRET.test(name) && value ? "[removed]" : value);
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
      fields[n] = redact(n, e.value);
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
        text: clean(a.textContent), href: a.getAttribute("href"), tooltip: tip(a.getAttribute("data-tooltip-message")) })) : [];
      const opts = el.querySelectorAll(".cp-list-item-buttonBar-buttons .cp-list-item-buttonBar-button");
      const options = [...opts].map((b, i) => {
        const sel = [...b.querySelectorAll("a")].find((a) => /workflowPluginPk=/.test(a.getAttribute("onclick") || ""));
        const ed = b.querySelector('a[href*="/item/"]');
        const q = sel && sel.getAttribute("onclick").match(/workflowPluginPk=(\d+)&index=(\d+)/);
        return { index: i, name: sel ? clean(sel.textContent) : "", tooltip: sel ? tip(sel.getAttribute("data-tooltip-message")) : "",
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

  // ---- what to read ----
  // Cloudpath lists are paged tables: 15 rows by default, 100 at most. Options (set before running, all optional):
  //   window.__CRAWL_FILTER   only workflows whose name contains one of these words (comma or new line separated), or a /regex/
  //   window.__CRAWL_LIMIT    read at most this many workflows (in list order)
  //   window.__CRAWL_PARALLEL read this many workflows at once (default 3, at most 6; tested: the same result as one at a time, about 40% faster)
  //   window.__CRAWL_STOP = true   stop early: what is read so far is still saved
  const FILTER = String(window.__CRAWL_FILTER || "").trim(), LIMIT = Number(window.__CRAWL_LIMIT) || Infinity, PARALLEL = Math.max(1, Math.min(6, Number(window.__CRAWL_PARALLEL) || 3));
  const wanted = (name) => {
    if (!FILTER) return true;
    const rx = FILTER.match(/^\/(.*)\/([a-z]*)$/);
    if (rx) return new RegExp(rx[1], rx[2] || "i").test(name);
    return FILTER.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean).some((s) => name.toLowerCase().includes(s));
  };
  async function listAll(url, tableId, linkTest) {
    const rows = [], seen = new Set(); let total = null;
    for (let page = 1; page <= 200; page++) {
      const html = await get(url + (url.includes("?") ? "&" : "?") + tableId + "_mr_=100&" + tableId + "_p_=" + page), doc = parse(html);
      if (total == null) { const m = html.match(new RegExp("setTotalRowsToLimit\\('" + tableId + "',\\s*'(\\d+)'")); total = m ? Number(m[1]) : null; }
      let added = 0;
      for (const a of doc.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href");
        if (!linkTest(href) || seen.has(href)) continue;
        seen.add(href); added++;
        const tr = a.closest("tr");
        rows.push({ href, cells: tr ? [...tr.querySelectorAll("td")].map((td) => clean(td.textContent)) : [] });
      }
      if (!added || (total != null && rows.length >= total)) break;
    }
    return { rows, total };
  }

  const started = Date.now();
  const all = await listAll("/admin/workflow/viewAllWorkflows", "workflowAndActiveSnapshotTableData", (h) => /^\/admin\/workflow\/\d+\/$/.test(h));
  const rows = all.rows.map((r, i) => ({ ...r, name: r.cells[1] || "", index: i })).filter((r) => wanted(r.name)).slice(0, LIMIT);
  const version = (document.body.innerText.match(/Version\s+([\d.]+)/) || [])[1] || "";
  const result = { source: location.origin, cloudpathVersion: version, crawledAt: new Date().toISOString(), crawlerVersion: 2, listed: all.total == null ? all.rows.length : all.total,
    filter: FILTER || undefined, limit: Number.isFinite(LIMIT) ? LIMIT : undefined, workflows: [] };
  console.log(`Cloudpath lists ${result.listed} workflows; reading ${rows.length}${FILTER ? " matching “" + FILTER + "”" : ""}. Set window.__CRAWL_STOP = true to stop early.`);

  async function crawlOne(row) {
    const href = row.href, pk = Number(href.match(/(\d+)/)[1]), base = new URL(href, location.origin).href;
    let wf = { pk, name: row.name };
    try {
      const doc = parse(await get(href)), text = clean(doc.body.innerText);
      wf = { pk, name: (text.match(/Workflow - "([^"]*)"/) || [])[1] || row.name, portalUrl: (text.match(/\/enroll\/[^\s]+\//) || [])[0] || "",
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
    } catch (e) { wf.error = String(e); }
    return wf;
  }
  const queue = rows.slice(), results = []; let done = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (queue.length && !window.__CRAWL_STOP) {
      const row = queue.shift(), wf = await crawlOne(row);
      results[row.index] = wf; done++;
      const left = rows.length - done, per = (Date.now() - started) / done / 1000;
      console.log(`[${done}/${rows.length}] ${wf.name}: ${wf.steps ? wf.steps.length + " steps" : wf.error}` + (left ? `  (about ${Math.ceil((left * per) / 60)} min left)` : ""));
    }
  }));
  result.workflows = results.filter(Boolean);
  if (window.__CRAWL_STOP) result.stopped = true;

  // Objects the workflows point at: only the DPSK pools and device configurations that the workflows read use them (there can be hundreds).
  // Pages show "Label:" then the value.
  const lines = (doc) => {
    doc.querySelectorAll("script,style").forEach((e) => e.remove());
    const x = doc.body.innerText.split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    return x.slice(x.lastIndexOf("Diagnostics") + 1);
  };
  const kv = (L) => { const o = {}; for (let i = 0; i < L.length - 1; i++) if (/:$/.test(L[i]) && !/:$/.test(L[i + 1])) o[L[i].slice(0, -1)] = L[i + 1]; return o; };
  const none = (v) => (!v || /^\[None\]$/.test(v) ? null : v);
  const txt = (v) => clean(v && typeof v === "object" ? v.text || v.value || "" : v || "");
  const used = { pools: new Set(), nets: new Set() };
  (function walk(steps) {
    for (const s of steps || []) {
      if (s.kind === "dpsk" && s.fields) used.pools.add(txt(s.fields.accountDpskPoolPk));
      if (s.kind === "output" && s.fields) used.nets.add(txt(s.fields["networkSourceSelection.existingPk"]));
      for (const o of s.options || []) walk(o.steps);
    }
  })(result.workflows.flatMap((w) => w.steps || []));
  used.pools.delete(""); used.nets.delete("");
  result.objects = { dpskPools: [], deviceConfigs: [], missing: { dpskPools: [], deviceConfigs: [] } };
  try {
    if (used.pools.size) {
      const pools = await listAll("/admin/dpsk/", "accountDpskPoolTableData", (h) => /viewPoolInfo/.test(h));
      for (const name of used.pools) {
        const row = pools.rows.find((r) => r.cells.includes(name));
        if (!row) { result.objects.missing.dpskPools.push(name); continue; }
        const k = kv(lines(parse(await get(row.href))));
        result.objects.dpskPools.push({ name: k["Name"] || name, deviceLimit: none(k["Device Limit"]), ssids: (k["SSID(s)"] || "").split(/[;,]\s*/).filter(Boolean),
          defaultExpiration: none(k["Default Expiration Date"]), defaultAccess: k["Default Access(No Policy Match)"] });
      }
    }
    if (used.nets.size) {
      const nets = await listAll("/admin/advanced/networks/", "accountDeviceConfigTableData", (h) => /\/networks\/\d+\/summary/.test(h));
      for (const name of used.nets) {
        const row = nets.rows.find((r) => r.cells.includes(name));
        if (!row) { result.objects.missing.deviceConfigs.push(name); continue; }
        const s = kv(lines(parse(await get(row.href))));
        const L = lines(parse(await get(row.href.replace("/summary", "/ssids"))));
        const wlans = [];
        for (let i = 0; i < L.length; i++) { const m = L[i].match(/^WLAN '([^']*)'$/); if (m) wlans.push({ ssid: m[1], protocol: L[i + 1] }); }
        result.objects.deviceConfigs.push({ name: (s["Name"] || name).replace(/ mode_edit$/, ""), wlans });
      }
    }
  } catch (e) { result.objects.error = String(e); }
  result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
  console.log(`Read ${result.workflows.length} workflows in ${result.elapsedSeconds} s.`);
  window.__crawl = result;
  const body = JSON.stringify(result);
  if (window.__NO_SEND) return "crawled " + body.length + " bytes (kept in window.__crawl)";
  try {
    const r = await fetch(RECEIVER, { method: "POST", headers: { "content-type": "application/json", ...(window.__CRAWL_CODE ? { "x-crawl-code": window.__CRAWL_CODE } : {}) }, body });
    return "sent " + body.length + " bytes to receiver: " + r.status;
  } catch (e) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: "application/json" })); a.download = "crawl.json"; a.click();
    return "Could not send the crawl to the editor (" + e + "). That is normal when the Cloudpath page blocks connections to other addresses. It was downloaded as crawl.json instead: drop that file on the editor page, or use Connections > Load a crawl file.";
  }
})();
