#!/usr/bin/env node
// node docs/build-guide.js [outDir]   builds docs/user-guide.md into one self-contained HTML file (screenshots embedded) and a PDF of it.
// The PDF is made with Electron's print engine (already a development dependency), so nothing else is needed. Default outDir: dist-app/.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const outDir = path.resolve(process.argv[2] || path.join(root, "dist-app"));
const pkg = require("../package.json");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

function inline(s) {
  const codes = []; s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
    const file = path.join(__dirname, src); let data = src;
    if (fs.existsSync(file)) data = "data:image/png;base64," + fs.readFileSync(file).toString("base64");
    return `<img alt="${alt}" src="${data}">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, h) => `<a href="${h}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + esc(codes[Number(i)]) + "</code>");
}

function render(md) {
  const lines = md.replace(/\r/g, "").split("\n"), out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>"); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { const n = m[1].length, text = m[2]; out.push(`<h${n} id="${slug(text.replace(/\*\*|`/g, ""))}">${inline(text)}</h${n}>`); i++; continue; }
    if (/^---+\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push("<blockquote>" + inline(buf.join(" ")) + "</blockquote>"); continue; }
    if (/^\|.*\|\s*$/.test(l) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const cells = (r) => r.replace(/^\||\|\s*$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push("<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>"); continue;
    }
    if (/^(\s*)([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l), items = [];
      while (i < lines.length && /^(\s*)([-*]|\d+\.)\s+/.test(lines[i])) { let t = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""); while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) t += " " + lines[i++].trim(); items.push(t); }
      out.push((ordered ? "<ol>" : "<ul>") + items.map((t) => `<li>${inline(t)}</li>`).join("") + (ordered ? "</ol>" : "</ul>")); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|---|\|.*\||(\s*)([-*]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push("<p>" + inline(buf.join(" ")) + "</p>");
  }
  return out.join("\n");
}

const md = fs.readFileSync(path.join(__dirname, "user-guide.md"), "utf8");
const body = render(md.replace(/^# .*\n/, ""));
const icon = "data:image/png;base64," + fs.readFileSync(path.join(root, "build", "icon.png")).toString("base64");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>R1 Workflow Studio: User Guide</title><style>
@page { size: A4; margin: 16mm 15mm 18mm; }
body { font: 11pt/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1c2128; max-width: 920px; margin: 0 auto; padding: 24px; }
.cover { text-align: center; padding: 60px 0 40px; page-break-after: always; } .cover img { width: 150px; } .cover h1 { font-size: 34pt; margin: 18px 0 6px; } .cover p { color: #5b6672; font-size: 13pt; margin: 4px 0; }
h1, h2, h3, h4 { line-height: 1.25; } h2 { margin-top: 1.8em; border-bottom: 1px solid #dde1e6; padding-bottom: 4px; page-break-after: avoid; } h3 { margin-top: 1.4em; page-break-after: avoid; }
img { max-width: 100%; border: 1px solid #dde1e6; border-radius: 6px; margin: 8px 0; page-break-inside: avoid; display: block; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 10pt; page-break-inside: avoid; } th, td { border: 1px solid #dde1e6; padding: 5px 8px; text-align: left; vertical-align: top; } th { background: #f3f5f7; }
code { background: #f3f5f7; padding: 1px 5px; border-radius: 4px; font-size: 90%; } pre { background: #f3f5f7; padding: 10px; border-radius: 6px; overflow: auto; } pre code { background: none; padding: 0; }
blockquote { margin: 12px 0; padding: 8px 14px; border-left: 4px solid #f47920; background: #fff6ee; } a { color: #1d5fd1; text-decoration: none; } hr { border: 0; border-top: 1px solid #dde1e6; margin: 22px 0; }
li { margin: 3px 0; }
</style></head><body>
<div class="cover"><img src="${icon}" alt=""><h1>R1 Workflow Studio</h1><p>User Guide</p><p>Version ${pkg.version}</p></div>
${body}
</body></html>`;
fs.mkdirSync(outDir, { recursive: true });
const htmlFile = path.join(outDir, "R1-Workflow-Studio-User-Guide.html"), pdfFile = path.join(outDir, "R1-Workflow-Studio-User-Guide.pdf");
fs.writeFileSync(htmlFile, html); console.log("wrote " + htmlFile);
const r = spawnSync(require("electron"), [path.join(__dirname, "print-pdf.js"), htmlFile, pdfFile], { stdio: "inherit", env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" } });
if (r.status !== 0 || !fs.existsSync(pdfFile)) { console.error("the PDF could not be made"); process.exit(1); }
console.log("wrote " + pdfFile + " (" + Math.round(fs.statSync(pdfFile).size / 1024) + " KB)");
