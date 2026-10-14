// The paste-able browser crawler: crawl/crawl.browser.js with the shared crawler (crawl/core.js) inlined, plus optional lines before it.
const fs = require("fs");
const path = require("path");

function buildBrowserScript(root, prefix = "") {
  const tpl = fs.readFileSync(path.join(root, "crawl", "crawl.browser.js"), "utf8");
  const core = fs.readFileSync(path.join(root, "crawl", "core.js"), "utf8");
  if (!tpl.includes("/*__CRAWL_CORE__*/")) throw new Error("crawl.browser.js has lost its core marker");
  return prefix + tpl.replace("/*__CRAWL_CORE__*/", () => core);
}
module.exports = { buildBrowserScript };
