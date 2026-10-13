// Visitor walkthrough engine for the editor's "Try it" tab. Pure logic, no DOM, no R1: it walks the editable workflow model the way a
// visitor would. The editor page includes this file (the server injects it), and the tests load it directly.
//
// state = { stack: [{ nodes, i }], trail: [node], history: [snapshot], ended: null | { reason, node? } }
// A split ends its path: its branch's steps carry on (a new frame is pushed). The end of every path ends the walkthrough.
//
// Logical split: a visitor's simulated device is { variableName: value }. A branch matches when all of its conditions hold
// (EQUALS compares case-insensitively); the first matching branch is taken. How R1 combines several conditions is not known,
// so "all" is an assumption, and the tab says so.

function simStart(wf) {
  return { stack: [{ nodes: wf.steps, i: 0 }], trail: [], history: [], ended: null };
}

function simSnapshot(s) { return { stack: s.stack.map((f) => ({ nodes: f.nodes, i: f.i })), trail: s.trail.slice(), ended: s.ended }; }

// The step the visitor is on, or null when the path has ended (state.ended is then set).
function simCurrent(s) {
  if (s.ended) return null;
  const f = s.stack[s.stack.length - 1];
  if (!f || f.i >= f.nodes.length) { s.ended = { reason: "end" }; return null; }
  return f.nodes[f.i];
}

function condMatches(c, device) {
  const have = String((device || {})[c.variable] == null ? "" : device[c.variable]).trim().toLowerCase();
  const want = String(c.value == null ? "" : c.value).trim().toLowerCase();
  switch (c.operation) {
    case "EQUALS": case "IS": return have === want;
    case "DOES_NOT_EQUAL": case "IS_NOT": return have !== want;
    case "CONTAINS": return have.includes(want);
    case "DOES_NOT_CONTAIN": return !have.includes(want);
    case "STARTS_WITH": return have.startsWith(want);
    case "ENDS_WITH": return have.endsWith(want);
    default: return false;
  }
}
// { index, because: [text] } for the first branch whose conditions all hold, else { index: -1 }.
function simMatchBranch(node, device) {
  const opts = node.options || [];
  for (let i = 0; i < opts.length; i++) {
    const conds = opts[i].conditions || [];
    if (conds.length && conds.every((c) => condMatches(c, device))) return { index: i, because: conds.map((c) => `${c.variable} ${String(c.operation).toLowerCase().replace(/_/g, " ")} ${c.value}`) };
  }
  return { index: -1, because: [] };
}

// Move on from the current step. choice: for a visitor-chooses split, the option index picked.
// Returns { branch } for a logical split (which branch was taken and why) so the screen can say so.
function simAdvance(s, choice, device) {
  const node = simCurrent(s);
  if (!node) return {};
  s.history.push(simSnapshot(s));
  s.trail.push(node);
  const f = s.stack[s.stack.length - 1];
  if (node.type === "USER_SELECTION_SPLIT") {
    const o = (node.options || [])[choice];
    if (!o) { s.history.pop(); s.trail.pop(); return {}; }
    f.i++; s.stack.push({ nodes: o.steps, i: 0 });
    return { branch: { name: o.name } };
  }
  if (node.type === "LOGICAL_SPLIT") {
    const m = simMatchBranch(node, device);
    f.i++;
    if (m.index < 0) { s.ended = { reason: "nomatch", node }; return { branch: null }; }
    const o = node.options[m.index];
    s.stack.push({ nodes: o.steps, i: 0 });
    return { branch: { name: o.name, because: m.because } };
  }
  if (node.type === "DISPLAY_MESSAGE" && node.params && node.params.killSession) { f.i++; s.ended = { reason: "session", node }; return {}; }
  f.i++;
  return {};
}

function simBack(s) {
  if (!s.history.length) return false;
  const h = s.history.pop();
  s.stack = h.stack; s.trail = h.trail; s.ended = h.ended;
  return true;
}

// Every variable name the workflow's logical splits look at (so the page can offer one input for each).
function simVariables(wf) {
  const out = new Set();
  (function walk(nodes) { for (const n of nodes || []) { for (const o of n.options || []) { for (const c of o.conditions || []) if (c.variable) out.add(c.variable); walk(o.steps); } } })(wf.steps);
  return [...out];
}

// A believable sample passphrase for a DPSK/passphrase screen (always the same for the same seed, so Back/forward doesn't change it).
function simSample(format, length, seed) {
  let x = 0; for (const ch of String(seed || "x")) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  const pick = (chars, n) => Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join("");
  const n = Math.max(8, Math.min(63, Number(length) || 12));
  if (format === "NUMBERS_ONLY") return pick("0123456789", n);
  if (format === "KEYBOARD_FRIENDLY") return pick("abcdefghjkmnpqrstuvwxyz23456789", n);
  if (format === "DICTIONARY_WORDS") return ["sunny", "river", "maple", "tiger", "cloud"].slice(0, 3).join("-") + "-" + pick("0123456789", 2);
  return pick("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789", n);
}

if (typeof module !== "undefined") module.exports = { simStart, simCurrent, simAdvance, simBack, simMatchBranch, simVariables, simSample, condMatches };
