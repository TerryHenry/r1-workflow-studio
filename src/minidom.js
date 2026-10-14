// A small HTML parser with just enough of the browser's DOM for the Cloudpath crawler (crawl/core.js): zero dependencies, so the editor
// can read Cloudpath pages itself. It is not a general HTML engine: tolerant of the usual server-rendered markup (unclosed <td>, <li>,
// <option>, <p>), entities, comments, <script>/<style>; selectors are tag, .class, #id, [attr], [attr=v|^=v|*=v|$=v], descendant and
// child combinators, and comma lists. innerText is the textContent (what the browser gives for a page it has not rendered).
// The crawler's results with this parser were compared with the browser's own DOMParser on a live instance (see README).

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
// opening one of these closes an open sibling of the same family (so a missing </td> or </li> doesn't swallow what follows)
const CLOSES = { li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], option: ["option"], optgroup: ["optgroup", "option"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], thead: ["tbody", "tfoot", "thead", "tr", "td", "th"], tbody: ["tbody", "tfoot", "thead", "tr", "td", "th"], tfoot: ["tbody", "tfoot", "thead", "tr", "td", "th"], p: ["p"] };
const BOUNDARY = { li: ["ul", "ol"], dt: ["dl"], dd: ["dl"], option: ["select", "datalist"], optgroup: ["select"], tr: ["table", "thead", "tbody", "tfoot"], td: ["tr", "table"], th: ["tr", "table"], thead: ["table"], tbody: ["table"], tfoot: ["table"], p: ["div", "td", "th", "li", "body", "form", "section", "table"] };

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", laquo: "«", raquo: "»", trade: "™", deg: "°", times: "×", rarr: "→", larr: "←" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; } catch { return m; } }
    return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : m;
  });
}

class Node_ { constructor(type) { this.nodeType = type; this.parentNode = null; } get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; } }
class Text extends Node_ { constructor(data) { super(3); this.data = data; } get textContent() { return this.data; } }

class Element extends Node_ {
  constructor(tag, attrs) { super(1); this.localName = tag; this.tagName = tag.toUpperCase(); this.attrs = attrs || {}; this.childNodes = []; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  getAttribute(n) { n = String(n).toLowerCase(); return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, String(n).toLowerCase()); }
  get id() { return this.attrs.id || ""; }
  get className() { return this.attrs.class || ""; }
  get classList() { const list = this.className.split(/\s+/).filter(Boolean); return { contains: (c) => list.includes(c), length: list.length, [Symbol.iterator]: () => list[Symbol.iterator]() }; }
  get name() { return this.attrs.name || ""; }
  get type() { const t = String(this.attrs.type || "").toLowerCase(); return this.localName === "input" ? t || "text" : this.localName === "select" ? "select-one" : this.localName === "textarea" ? "textarea" : t; }
  get checked() { return this.hasAttribute("checked"); }
  get selected() { return this.hasAttribute("selected"); }
  get textContent() { const parts = []; const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) parts.push(c.data); else walk(c); } }; walk(this); return parts.join(""); }
  get value() {
    if (this.localName === "textarea") { const t = this.textContent.replace(/\r\n?/g, "\n"); return t.startsWith("\n") ? t.slice(1) : t; }      // the browser normalises line breaks to \n
    if (this.localName === "option") return this.hasAttribute("value") ? this.attrs.value : this.textContent.replace(/\s+/g, " ").trim();
    if (this.localName === "select") { const o = this.selectedOptions[0]; return o ? o.value : ""; }
    if (this.attrs.value == null && this.localName === "input" && (this.type === "checkbox" || this.type === "radio")) return "on";
    return this.attrs.value == null ? "" : this.attrs.value;
  }
  get options() { return this.querySelectorAll("option"); }
  get selectedOptions() {
    if (this.localName !== "select") return [];
    const all = this.options, picked = all.filter((o) => o.selected);
    return picked.length ? (this.hasAttribute("multiple") ? picked : [picked[picked.length - 1]]) : (this.hasAttribute("multiple") || !all.length ? [] : [all[0]]);
  }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this); this.parentNode = null; }
  closest(sel) { const m = compile(sel); for (let e = this; e; e = e.parentElement) if (m(e)) return e; return null; }
  matches(sel) { return compile(sel)(this); }
  querySelectorAll(sel) { const m = compile(sel), out = []; const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (m(c)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  // The crawler reads pages parsed by DOMParser, which are never rendered, and for those the browser's innerText is the textContent.
  // Same here, so both runs see the same text. (Callers that need lines rely on the line breaks already in the page's source.)
  get innerText() { return this.textContent; }
}

// ---- parser ----
const TAG = /<([a-zA-Z][^\s\/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/y;
function parseAttrs(s) {
  const attrs = {}; const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let m;
  while ((m = re.exec(s))) { const k = m[1].toLowerCase(); if (!Object.prototype.hasOwnProperty.call(attrs, k)) attrs[k] = decode(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : ""); }
  return attrs;
}

function parse(html) {
  html = String(html == null ? "" : html);
  const doc = new Element("#document", {}); doc.tagName = "#DOCUMENT";
  const stack = [doc]; const top = () => stack[stack.length - 1];
  const add = (n) => { n.parentNode = top(); top().childNodes.push(n); };
  const text = (s) => { if (s) add(new Text(decode(s))); };
  let i = 0; const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { text(html.slice(i)); break; }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) { const e = html.indexOf("-->", i + 4); i = e < 0 ? n : e + 3; continue; }
    if (html[i + 1] === "!" || html[i + 1] === "?") { const e = html.indexOf(">", i); i = e < 0 ? n : e + 1; continue; }
    if (html[i + 1] === "/") {
      const e = html.indexOf(">", i); const name = html.slice(i + 2, e < 0 ? n : e).trim().split(/\s/)[0].toLowerCase(); i = e < 0 ? n : e + 1;
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].localName === name) { stack.length = k; break; }
      continue;
    }
    TAG.lastIndex = i; const m = TAG.exec(html);
    if (!m) { text("<"); i++; continue; }
    const tag = m[1].toLowerCase(), selfClose = /\/\s*$/.test(m[2]); i += m[0].length;
    if (CLOSES[tag]) {                                          // an open sibling of the same family ends here
      for (let k = stack.length - 1; k > 0; k--) {
        const nm = stack[k].localName;
        if (BOUNDARY[tag].includes(nm)) break;
        if (CLOSES[tag].includes(nm)) { stack.length = k; break; }
      }
    }
    const el = new Element(tag, parseAttrs(m[2].replace(/\/\s*$/, ""))); add(el);
    if (VOID.has(tag) || selfClose) continue;
    if (RAW.has(tag)) {
      const close = new RegExp("</" + tag + "\\s*>", "ig"); close.lastIndex = i; const cm = close.exec(html);
      const body = html.slice(i, cm ? cm.index : n); if (body) { const t = new Text(tag === "script" || tag === "style" ? body : decode(body)); t.parentNode = el; el.childNodes.push(t); }
      i = cm ? cm.index + cm[0].length : n; continue;
    }
    stack.push(el);
  }
  const find = (tag) => doc.querySelectorAll(tag)[0] || null;
  const htmlEl = find("html") || doc, body = find("body") || htmlEl;
  return { documentElement: htmlEl, body, head: find("head"), title: (find("title") || { textContent: "" }).textContent, querySelectorAll: (s) => doc.querySelectorAll(s), querySelector: (s) => doc.querySelector(s) };
}

// ---- selectors ----
const cache = new Map();
function compile(sel) {
  if (cache.has(sel)) return cache.get(sel);
  const groups = splitTop(String(sel), ",").map((g) => g.trim()).filter(Boolean).map(parseChain);
  const fn = (el) => groups.some((chain) => matchChain(chain, el));
  cache.set(sel, fn); return fn;
}
function splitTop(s, ch) { const out = []; let d = 0, q = null, cur = ""; for (const c of s) { if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === "[" || c === "(") d++; else if (c === "]" || c === ")") d--; if (c === ch && !d && !q) { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out; }
function parseChain(s) {
  const parts = []; let i = 0, comb = " ";
  while (i < s.length) {
    while (s[i] === " ") i++;
    if (s[i] === ">") { comb = ">"; i++; continue; }
    let j = i, d = 0, q = null;
    while (j < s.length) { const c = s[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === "[") d++; else if (c === "]") d--; else if ((c === " " || c === ">") && !d) break; j++; }
    if (j > i) { parts.push({ comb, simple: parseSimple(s.slice(i, j)) }); comb = " "; }
    i = j;
  }
  return parts;
}
function parseSimple(s) {
  const out = { tag: null, id: null, classes: [], attrs: [] }; let i = 0;
  const ident = () => { const m = /^[\w-]+|^\*/.exec(s.slice(i)); if (!m) return ""; i += m[0].length; return m[0]; };
  if (/^[\w*]/.test(s)) { const t = ident(); out.tag = t === "*" ? null : t.toLowerCase(); }
  while (i < s.length) {
    const c = s[i++];
    if (c === ".") out.classes.push(ident()); else if (c === "#") out.id = ident();
    else if (c === "[") {
      const e = s.indexOf("]", i), body = s.slice(i, e); i = e + 1;
      const m = /^\s*([\w:-]+)\s*(?:([\^*$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?)))?\s*$/.exec(body);
      if (m) out.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, val: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : "" });
    } else throw new Error("Unsupported selector: " + s);
  }
  return out;
}
function matchSimple(sp, el) {
  if (sp.tag && el.localName !== sp.tag) return false;
  if (sp.id && el.id !== sp.id) return false;
  if (sp.classes.length) { const c = el.className.split(/\s+/); if (!sp.classes.every((x) => c.includes(x))) return false; }
  for (const a of sp.attrs) {
    const v = el.getAttribute(a.name); if (v == null) return false;
    if (a.op === "=" && v !== a.val) return false; if (a.op === "^=" && !v.startsWith(a.val)) return false; if (a.op === "*=" && !v.includes(a.val)) return false;
    if (a.op === "$=" && !v.endsWith(a.val)) return false; if (a.op === "~=" && !v.split(/\s+/).includes(a.val)) return false;
  }
  return true;
}
function matchChain(chain, el) {
  const rec = (k, e) => {
    if (!matchSimple(chain[k].simple, e)) return false;
    if (k === 0) return true;
    if (chain[k].comb === ">") return !!e.parentElement && rec(k - 1, e.parentElement);
    for (let p = e.parentElement; p; p = p.parentElement) if (rec(k - 1, p)) return true;
    return false;
  };
  return rec(chain.length - 1, el);
}

module.exports = { parse, decode, Element, Text };
