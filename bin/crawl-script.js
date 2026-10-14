#!/usr/bin/env node
// node bin/crawl-script.js   prints the browser crawler (paste it into the console of a signed-in Cloudpath admin tab).
// The editor's Connections dialog can also read a Cloudpath instance by itself, without any of this.
const path = require("path");
process.stdout.write(require("../src/crawlscript").buildBrowserScript(path.join(__dirname, "..")));
