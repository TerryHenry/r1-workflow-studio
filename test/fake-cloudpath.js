// A pretend Cloudpath admin for tests: the same page shapes the crawler reads (login form with CSRF, paged JMesa tables, workflow pages with
// step cards and per-session "selected option" state, edit forms, DPSK pool and device configuration pages), served over http on 127.0.0.1.
// What it records: logins, logouts, every page asked for, and the passwords it was given (so tests can check they never leak).
const http = require("node:http");

const USER = "admin@example.com", PASS = "correct-horse-battery";
const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

function create({ workflows = 40, delayMs = 0, initialSelected = 0, mixedPages = false } = {}) {
  const sessions = new Map();                     // sid -> { auth, selected: { "pk:pluginPk": index } }
  const log = { logins: 0, failedLogins: 0, logouts: 0, gets: [], passwords: [] };
  const names = Array.from({ length: workflows }, (_, i) => (i === 0 ? "Alpha guest" : i === 1 ? "Beta staff" : "Workflow " + String(i).padStart(3, "0")));
  const pks = names.map((_, i) => 1000 + i);
  const sidOf = (req) => (/(?:^|;\s*)JSESSIONID=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const page = (title, body) => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
  const home = () => page("Cloudpath ES", `<a href="/admin/workflow/viewAllWorkflows">Workflows</a> <a href="/admin/logout">Sign out</a><div>Version 6.0.6052</div>`);

  // step plugin pages -----------------------------------------------------------------------------------------------------------
  const card = (pk, kind, n, label, extra = "", tips = "") => `<div class="cp-list-item${kind === "output" ? " cp-list-item-result" : ""}"><div class="cp-list-item-left-step">${n}</div>
    <ul class="cp-list-item-menu"><li><a href="../${kind === "output" ? "result" : kind}/WorkflowPlugin-${uuid(n * 10 + pk % 10)}?workflowPk=${pk}">edit</a><li><a href="../${kind}/WorkflowPlugin-${uuid(n * 10 + pk % 10)}/preview">preview</a></ul>
    <span class="cp-list-item-title">${esc(label)} ${tips}</span>${extra}</div>`;
  const workflowPage = (pk, session) => {
    const name = names[pks.indexOf(pk)];
    const sel = (session.selected["" + pk] == null ? initialSelected : session.selected["" + pk]);
    const bar = [0, 1].map((i) => `<div class="cp-list-item-buttonBar-button cp-list-item-buttonBar-button-${i} cp-list-item-buttonBar-button-${i === sel ? "selected" : "unselected"}">` +
      (i === sel ? `<a class="cp-iconButton" href="../selection/WorkflowPlugin-${uuid(21)}/item/${500 + i}/edit?sourceUrl=x"><i>mode_edit</i></a>&nbsp;` : "") +
      `<a data-tooltip data-tooltip-message="Only available to ${i ? "staff" : "guests"}" onclick='location.href="?workflowPluginPk=7199&index=${i}"; event.cancelBubble=true;'>${i ? "Staff" : "Guests"}</a></div>`).join("");
    const selection = card(pk, "selection", 2, "User type", `<div class="cp-list-item-buttonBar"><div class="cp-list-item-buttonBar-title">All matches in:</div><div class="cp-list-item-buttonBar-buttons">${bar}</div></div>`);
    const branch = sel === 0 ? card(pk, "dpsk", 3, "Give a DPSK", "", `<a href="/pool" data-tooltip-message="Pool">pool</a>`) + card(pk, "output", 4, "Move user to Guest-Net") : card(pk, "ss", 3, "Prompt for a shared passphrase", "", `<a href="/x" data-tooltip-message="Shared secret: hunter2">Prompt</a>`) + card(pk, "output", 4, "Assign a device configuration and/or certificate.");
    return page("Workflow", `<h1>Workflow - "${esc(name)}"</h1><div>Published</div><div>/enroll/Acme/${esc(name.replace(/\s/g, ""))}/</div>
      <div class="cp-list-group-0">${card(pk, "aup", 1, "Require the user to accept the AUP")}${selection}</div><div class="cp-list-group-1">${branch}</div>`);
  };
  const editForm = (kind, pk) => {
    if (kind === "aup") return `<form><input type="hidden" name="_csrf" value="x"><input name="name" value="AUP for ${pk}"><input name="title" value="Welcome"><textarea name="messageHtml">Line one\r\nLine two</textarea><input type="checkbox" name="checkboxDefaultState" value="1"></form>`;
    if (kind === "dpsk") return `<form><input name="name" value="Give DPSK"><select name="accountDpskPoolPk"><option value="1">Other pool<option value="2" selected>Guest Pool</select><input name="allowEmail" type="checkbox" value="1" checked></form>`;
    if (kind === "result") return `<form><input name="name" value=""><input type="radio" name="networkSourceSelection.source" value="EXISTING" checked><select name="networkSourceSelection.existingPk"><option value="9" selected>Guest-Net</select></form>`;
    if (kind === "ss") return `<form><input name="name" value="Crew"><input name="sharedSecret" value="hunter2"><input name="sharedSecretDescription" value="The crew passphrase"></form>`;
    return `<form><input name="name" value="${kind}"></form>`;
  };

  const server = http.createServer((req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(body); };
    const go = () => {
      const url = new URL(req.url, "http://x"), sid = sidOf(req);
      if (req.method === "GET" && url.pathname === "/admin/login") {
        const id = "S" + Math.random().toString(16).slice(2); sessions.set(id, { auth: false, csrf: "csrf-" + id, selected: {} });
        return send(200, `<html><head><title>Cloudpath - Login</title></head><body><form id="command" name="login" action="/admin/processLogin" method="post">
          <input id="accountUrlName" name="accountUrlName" type="hidden" value=""><input type="hidden" name="_csrf" value="csrf-${id}"><input id="j_username" name="j_username" type="text" value="">
          <input id="j_password" name="j_password" type="password" value=""><button type="submit">Sign In</button></form></body></html>`, { "set-cookie": [`JSESSIONID=${id}; path=/admin; HttpOnly`, "XSRF-TOKEN=abc; path=/"] });
      }
      if (req.method === "POST" && url.pathname === "/admin/processLogin") {
        let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
          const f = new URLSearchParams(body), s = sessions.get(sid);
          log.passwords.push(f.get("j_password"));
          if (!s || f.get("_csrf") !== s.csrf) return send(403, "bad csrf");
          if (f.get("j_username") === USER && f.get("j_password") === PASS) { s.auth = true; log.logins++; return send(302, "", { location: "/admin/dashboard/welcome" }); }
          log.failedLogins++; return send(302, "", { location: "/admin/login?error" });
        });
        return;
      }
      const s = sessions.get(sid);
      if (!s || !s.auth) return send(302, "", { location: "/admin/login" });
      log.gets.push(url.pathname + url.search);
      if (url.pathname === "/admin/logout") { log.logouts++; sessions.delete(sid); return send(302, "", { location: "/admin/login", "set-cookie": "JSESSIONID=; path=/admin; Max-Age=0" }); }
      if (url.pathname === "/admin/dashboard/welcome") return send(200, home());
      if (url.pathname === "/admin/workflow/viewAllWorkflows") {
        const mr = Math.min(100, Number(url.searchParams.get("workflowAndActiveSnapshotTableData_mr_")) || 15), p = Number(url.searchParams.get("workflowAndActiveSnapshotTableData_p_")) || 1;
        const rows = names.slice((p - 1) * mr, p * mr).map((n, i) => `<tr><td><a href="/admin/workflow/${pks[(p - 1) * mr + i]}/">build</a></td><td>${esc(n)}</td><td>lensPublished</td><td>2026-06-20</td></tr>`).join("");
        return send(200, page("Workflows", `<table>${rows}</table><script>jQuery.jmesa.setTotalRowsToLimit('workflowAndActiveSnapshotTableData','${names.length}'); jQuery.jmesa.setMaxRowsToLimit('workflowAndActiveSnapshotTableData','${mr}');</script>`));
      }
      let m;
      if ((m = /^\/admin\/workflow\/(\d+)\/$/.exec(url.pathname))) {
        const pk = Number(m[1]); if (!pks.includes(pk)) return send(404, "no");
        if (url.searchParams.get("workflowPluginPk")) s.selected["" + pk] = Number(url.searchParams.get("index"));
        return send(200, workflowPage(pk, s));
      }
      if ((m = /^\/admin\/workflow\/(\d+)\/template$/.exec(url.pathname))) return send(200, `<form><input name="tab" value="x"><input name="welcomeTitle1" value="Hello ${m[1]}"><input name="webBackgroundColor" value="123456"></form>`);
      if ((m = /^\/admin\/workflow\/(aup|dpsk|result|ss|selection)\/WorkflowPlugin-[\w-]+(\/item\/\d+\/edit)?$/.exec(url.pathname))) {
        if (m[2]) return send(200, `<form><input name="name" value="Option ${url.pathname.match(/item\/(\d+)/)[1]}"><textarea name="description">Visible to ${url.pathname.endsWith("500/edit") ? "guests" : "staff"}</textarea></form>`);
        return send(200, editForm(m[1], 1));
      }
      if (url.pathname === "/admin/dpsk/") return send(200, page("DPSK", `<table><tr><td><a href="/admin/dpsk/206/viewPoolInfo">build</a></td><td>1</td><td>Guest Pool</td></tr></table><script>jQuery.jmesa.setTotalRowsToLimit('accountDpskPoolTableData','1');</script>`));
      if (url.pathname === "/admin/dpsk/206/viewPoolInfo") return send(200, page("Pool", `<div>Diagnostics</div>\n<div>Name:</div>\n<div>Guest Pool</div>\n<div>Device Limit:</div>\n<div>3</div>\n<div>SSID(s):</div>\n<div>Guest-WiFi</div>\n`));
      if (url.pathname === "/admin/advanced/networks/") return send(200, page("Networks", `<table><tr><td><a href="/admin/advanced/networks/77/summary">build</a></td><td>Guest-Net</td></tr></table><script>jQuery.jmesa.setTotalRowsToLimit('accountDeviceConfigTableData','1');</script>`));
      if (url.pathname === "/admin/advanced/networks/77/summary") return send(200, page("Net", `<div>Diagnostics</div>\n<div>Name:</div>\n<div>Guest-Net mode_edit</div>\n`));
      if (url.pathname === "/admin/advanced/networks/77/ssids") return send(200, page("SSIDs", `<div>Diagnostics</div>\n<div>WLAN 'Guest-WiFi'</div>\n<div>WPA2</div>\n`));
      return send(404, "not found");
    };
    if (delayMs) setTimeout(go, delayMs); else go();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, origin: "http://127.0.0.1:" + server.address().port, USER, PASS, log, names, close: () => new Promise((r) => server.close(r)) })));
}

module.exports = { create, USER, PASS };
