// R1 Workflow Studio, desktop app (macOS and Windows). It is the same studio as `node bin/ui.js`, in a window: the local server runs inside the
// app on 127.0.0.1 and the window shows it. Everything you create is kept in the app's own data folder (Help > Open data folder); API client
// secrets are encrypted with the operating system's store (macOS Keychain, Windows data protection).
const { app, BrowserWindow, Menu, shell, dialog, safeStorage, session } = require("electron");
const path = require("path");
const { startStudio } = require("../src/studio");
const connections = require("../src/connections");

app.setName("R1 Workflow Studio");
const PORT = 47871;        // a fixed port keeps the window's settings (theme, last Cloudpath address) from one launch to the next
let studio = null, win = null;

const sameOrigin = (u) => { try { return new URL(u).origin === studio.url; } catch { return false; } };
const openOutside = (u) => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); };

function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 920, minWidth: 900, minHeight: 600, title: "R1 Workflow Studio", backgroundColor: "#14171b", show: false,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, webSecurity: true } });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: "allow", overrideBrowserWindowOptions: { width: 1180, height: 900, title: "R1 Workflow Studio", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    openOutside(url); return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!sameOrigin(url)) { e.preventDefault(); openOutside(url); } });
  win.on("closed", () => { win = null; });
  win.loadURL(studio.url);
}

function buildMenu(dataRoot) {
  const mac = process.platform === "darwin";
  const template = [
    ...(mac ? [{ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    { label: "File", submenu: [{ label: "Open data folder", click: () => shell.openPath(dataRoot) }, ...(mac ? [] : [{ type: "separator" }, { role: "quit" }])] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, { role: "toggleDevTools" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(mac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  // client secrets are written encrypted with the operating system's own store when it is available
  if (safeStorage.isEncryptionAvailable()) {
    connections.setVault({ seal: (s) => safeStorage.encryptString(s).toString("base64"), open: (b) => safeStorage.decryptString(Buffer.from(b, "base64")) });
  }
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));          // the studio needs no camera, location, notifications...
  const dataRoot = app.getPath("userData");
  studio = await startStudio({ root: path.join(__dirname, ".."), dataRoot, port: PORT, log: (l) => console.error(l), say: (l) => console.log(l) });
  buildMenu(dataRoot);
  createWindow();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on("web-contents-created", (e, contents) => contents.on("will-attach-webview", (ev) => ev.preventDefault()));
  app.on("activate", () => { if (studio && !win) createWindow(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { if (studio) { studio.close(); studio = null; } });
  app.whenReady().then(boot).catch((e) => { dialog.showErrorBox("R1 Workflow Studio could not start", String((e && e.message) || e)); app.quit(); });
}
