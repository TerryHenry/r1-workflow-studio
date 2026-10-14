// The Cloudpath crawler: reads every enrollment workflow (and the DPSK pools and device configurations they use) from a Cloudpath admin UI.
// Read-only: GET requests only. It runs in two places, with the same code:
//   - inside a signed-in Cloudpath browser tab (crawl/crawl.browser.js wraps it; the browser supplies get and parse),
//   - inside the editor's server (src/crawl-job.js signs in with the address, email and password typed in the editor; src/minidom.js parses).
// Layout notes: Cloudpath 6.0.6052/6056. Pages are server-rendered HTML; other versions may need care.
//
// env: { get(url) -> html text, parse(html) -> document, origin, version() -> text of a page showing "Version x.y", log(text), progress({done,total,name}),
//        options: { filter, limit, parallel }, stopped() -> bool, sleep(ms) }
const CrawlCore = (function () {
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

  async function run(env) {
    const { get, parse } = env, o = env.options || {}, log = env.log || (() => {});
    const FILTER = String(o.filter || "").trim(), LIMIT = Number(o.limit) || Infinity, PARALLEL = Math.max(1, Math.min(6, Number(o.parallel) || 3));
    const stopped = () => !!(env.stopped && env.stopped());

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
          for (const op of it.options) {
            const opt = { name: op.name, criteria: op.tooltip };
            // Selecting an option (a GET, kept per session by Cloudpath) shows its edit link; only the selected option has one. So the option's
            // own form is read from this page, not from the first one, where only whichever option was selected at the time had a link.
            const url = base + "?workflowPluginPk=" + op.selectKey + "&index=" + op.index;
            const doc2 = parse(await get(url));
            const flat2 = items(doc2);
            const at = flat2.findIndex((x) => x.pluginId === it.pluginId && x.kind === "selection");
            const edit = op.itemEdit || (at >= 0 && flat2[at].options[op.index] && flat2[at].options[op.index].itemEdit);
            if (edit) { const d = parse(await get(new URL(edit, base).href)); Object.assign(opt, formFields(d)); }
            opt.steps = await readRegion(base, wfPk, flat2, at + 1, level + 1, path.concat([op.index]));
            step.options.push(opt);
          }
        }
        out.push(step);
      }
      return out;
    }

    const wanted = (name) => {
      if (!FILTER) return true;
      const rx = FILTER.match(/^\/(.*)\/([a-z]*)$/);
      if (rx) return new RegExp(rx[1], rx[2] || "i").test(name);
      return FILTER.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean).some((s) => name.toLowerCase().includes(s));
    };
    // Cloudpath lists are paged tables: 15 rows by default, 100 at most.
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
    let version = ""; try { version = (String(await env.version()).match(/Version\s+([\d.]+)/) || [])[1] || ""; } catch {}
    const result = { source: env.origin, cloudpathVersion: version, crawledAt: new Date().toISOString(), crawlerVersion: 2, listed: all.total == null ? all.rows.length : all.total,
      filter: FILTER || undefined, limit: Number.isFinite(LIMIT) ? LIMIT : undefined, workflows: [] };
    log(`Cloudpath lists ${result.listed} workflows; reading ${rows.length}${FILTER ? " matching “" + FILTER + "”" : ""}.`);
    if (env.progress) env.progress({ done: 0, total: rows.length, name: "", listed: result.listed });

    async function crawlOne(row) {
      const href = row.href, pk = Number(href.match(/(\d+)/)[1]), base = new URL(href, env.origin).href;
      let wf = { pk, name: row.name };
      try {
        const doc = parse(await get(href)), text = clean(doc.body.innerText);
        wf = { pk, name: (text.match(/Workflow - "([^"]*)"/) || [])[1] || row.name, portalUrl: (text.match(/\/enroll\/[^\s]+\//) || [])[0] || "",
          published: /Published/.test(text.slice(text.indexOf("Workflow - "), text.indexOf("Workflow - ") + 300)) && !/Unpublished/.test(text.slice(text.indexOf("Workflow - "), text.indexOf("Workflow - ") + 300)) };
        try { wf.steps = await readRegion(base, pk, items(doc), 0, 0, []); } catch (e) { wf.error = String(e && e.message || e); }
        try {                                   // Look & Feel tab: the form's non-empty fields
          const lf = parse(await get(href + "template")), look = {};
          for (const e of lf.querySelectorAll("form input, form select, form textarea")) {
            if (!e.name || /csrf|password|^cpnFormAction$|^tab$|-default$|-checkbox$/i.test(e.name)) continue;
            if ((e.type === "radio" || e.type === "checkbox") && !e.checked) continue;
            const v = e.tagName === "SELECT" ? clean((e.selectedOptions[0] || {}).textContent) : e.value;
            if (v !== "") look[e.name] = String(v).slice(0, 200);
          }
          wf.look = look;
        } catch (e) { wf.lookError = String(e && e.message || e); }
      } catch (e) { wf.error = String(e && e.message || e); }
      return wf;
    }
    const queue = rows.slice(), results = []; let done = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (queue.length && !stopped()) {
        const row = queue.shift(), wf = await crawlOne(row);
        results[row.index] = wf; done++;
        const left = rows.length - done, per = (Date.now() - started) / done / 1000;
        log(`[${done}/${rows.length}] ${wf.name}: ${wf.steps ? wf.steps.length + " steps" : wf.error}` + (left ? `  (about ${Math.ceil((left * per) / 60)} min left)` : ""));
        if (env.progress) env.progress({ done, total: rows.length, name: wf.name, listed: result.listed, secondsLeft: Math.round(left * per) });
      }
    }));
    result.workflows = results.filter(Boolean);
    if (stopped()) result.stopped = true;

    // Objects the workflows point at: only the DPSK pools and device configurations that the workflows use (there can be hundreds).
    // Pages show "Label:" then the value.
    const lines = (doc) => {
      doc.querySelectorAll("script,style").forEach((e) => e.remove());
      const x = doc.body.innerText.split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
      return x.slice(x.lastIndexOf("Diagnostics") + 1);
    };
    const kv = (L) => { const out = {}; for (let i = 0; i < L.length - 1; i++) if (/:$/.test(L[i]) && !/:$/.test(L[i + 1])) out[L[i].slice(0, -1)] = L[i + 1]; return out; };
    const none = (v) => (!v || /^\[None\]$/.test(v) ? null : v);
    const txt = (v) => clean(v && typeof v === "object" ? v.text || v.value || "" : v || "");
    const used = { pools: new Set(), nets: new Set() };
    (function walk(steps) {
      for (const s of steps || []) {
        if (s.kind === "dpsk" && s.fields) used.pools.add(txt(s.fields.accountDpskPoolPk));
        if (s.kind === "output" && s.fields) used.nets.add(txt(s.fields["networkSourceSelection.existingPk"]));
        for (const op of s.options || []) walk(op.steps);
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
    } catch (e) { result.objects.error = String(e && e.message || e); }
    result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    log(`Read ${result.workflows.length} workflows in ${result.elapsedSeconds} s.`);
    return result;
  }

  return { run, formFields, items, clean };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CrawlCore;
