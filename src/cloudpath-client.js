// A Cloudpath admin session for the editor's own crawl: sign in with the address, email and password typed in the editor, read pages with GET,
// sign out. The password is used for the one sign-in call and not kept: not in the session, not in logs, not in error messages, not on disk.
// Redirects are followed by hand and only within the same address, so the session cookie never goes anywhere else.
const { parse } = require("./minidom");

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; return e; };

// "cloudpath.example.com", "https://cloudpath.example.com/admin/..." -> "https://cloudpath.example.com". Only https (http for this computer, for tests).
function normalizeOrigin(input) {
  const raw = String(input || "").trim();
  if (!raw) throw fail("Enter the address of the Cloudpath admin, for example https://cloudpath.example.com");
  let u; try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : "https://" + raw); } catch { throw fail("That doesn't look like an address. Example: https://cloudpath.example.com"); }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw fail("Use the https:// address of the Cloudpath admin: a password must not be sent unencrypted.");
  if (u.username || u.password) throw fail("Don't put a user name or password in the address: use the fields below it.");
  return u.origin;
}

function cookieJar() {
  const jar = new Map();
  return {
    store(res) {
      const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ? res.headers.get("set-cookie").split(/,(?=\s*[\w-]+=)/) : []);
      for (const line of list) {
        const [pair, ...attrs] = line.split(";"), eq = pair.indexOf("="); if (eq < 1) continue;
        const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
        const gone = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || attrs.some((a) => { const m = /^\s*expires\s*=(.*)$/i.exec(a); return m && Date.parse(m[1]) < Date.now(); });
        if (gone || value === "") jar.delete(name); else jar.set(name, value);
      }
    },
    header() { return [...jar].map(([k, v]) => k + "=" + v).join("; "); },
    clear() { jar.clear(); },
  };
}

function createSession(origin, { fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  const cookies = cookieJar(); let logoutHref = null;

  async function request(urlOrPath, { method = "GET", body, headers = {} } = {}) {
    let url = new URL(urlOrPath, origin).href;
    for (let hop = 0; hop < 8; hop++) {
      if (new URL(url).origin !== origin) throw fail("Cloudpath sent us to another address (" + new URL(url).host + "). Stopped: nothing was sent there.");
      let res;
      try {
        res = await fetchImpl(url, { method, redirect: "manual", body: hop === 0 ? body : undefined, signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: "text/html,*/*", "User-Agent": "R1-Workflow-Studio", ...headers, ...(cookies.header() ? { Cookie: cookies.header() } : {}) } });
      } catch (e) {
        const code = (e && e.cause && e.cause.code) || (e && e.name === "TimeoutError" ? "timed out" : "");
        throw fail("Could not reach " + new URL(origin).host + (code ? " (" + code + ")" : "") + ". Check the address and your network.", 502);
      }
      cookies.store(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location"), url).href; method = "GET"; continue;             // a redirect after a POST is read with GET
      }
      return { status: res.status, url, text: await res.text() };
    }
    throw fail("Cloudpath redirected too many times.", 502);
  }

  const looksLikeLogin = (r) => /j_password|Cloudpath - Login/i.test(r.text) || /\/login(\?|$|\/)/.test(new URL(r.url).pathname + new URL(r.url).search);

  return {
    origin,
    async login(username, password) {
      const page = await request("/admin/login");
      const doc = parse(page.text), form = doc.querySelectorAll("form").find((f) => f.querySelector('input[name="j_username"]'));
      if (!form) throw fail("That address doesn't show a Cloudpath admin sign-in page. Check it (it usually ends in .cloudpath.net).");
      const data = new URLSearchParams();
      for (const i of form.querySelectorAll("input")) if (i.type === "hidden" && i.name) data.set(i.name, i.value);
      data.set("j_username", String(username)); data.set("j_password", String(password));
      const action = new URL(form.getAttribute("action") || "/admin/processLogin", page.url).href;
      const res = await request(action, { method: "POST", body: data.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: origin + "/admin/login", Origin: origin } });
      data.delete("j_password");
      if (looksLikeLogin(res)) throw fail("Cloudpath did not accept that email and password. Check them, and that the account is a Cloudpath admin.", 401);
      const home = /admin\/workflow\/viewAllWorkflows/.test(res.text) ? res : await request("/admin/dashboard/welcome");
      if (looksLikeLogin(home)) throw fail("Cloudpath did not accept that email and password.", 401);
      if (!/admin\/workflow\/viewAllWorkflows/.test(home.text)) throw fail("Signed in, but Cloudpath showed something other than the admin home (for example a password change or a verification code). Finish that in a browser first, or use the browser console method.", 409);
      const out = parse(home.text).querySelectorAll("a[href]").map((a) => a.getAttribute("href")).find((h) => /logout|signout/i.test(h));
      logoutHref = out || null;
      return { homeText: parse(home.text).body.textContent };
    },
    // GET one page; a page that turns out to be the sign-in page means the session ended.
    async get(urlOrPath) {
      const r = await request(urlOrPath);
      if (r.status >= 400) throw fail(new URL(r.url).pathname + " -> " + r.status, r.status);
      if (looksLikeLogin(r)) throw fail("Cloudpath ended the session (it signs you out after a while, or someone else signed in as this user).", 401);
      return r.text;
    },
    async logout() { try { if (logoutHref) await request(logoutHref); } catch { /* best effort */ } cookies.clear(); },
  };
}

module.exports = { normalizeOrigin, createSession };
