// Run with Electron: electron docs/print-pdf.js in.html out.pdf   (used by docs/build-guide.js)
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const [, , input, output] = process.argv.slice(1).length >= 3 ? [null, null, ...process.argv.slice(2)] : process.argv;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 1400 });
  await win.loadFile(input);
  await new Promise((r) => setTimeout(r, 800));
  const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4", preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#777">R1 Workflow Studio: User Guide &nbsp;·&nbsp; <span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  fs.writeFileSync(output, pdf); app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
