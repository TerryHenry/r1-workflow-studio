#!/usr/bin/env node
// node docs/make-screenshots.js   (needs `npm install`: it drives the real desktop app, in a window, through its debugging port)
// Takes the screenshots for docs/user-guide.md into docs/images/. Everything on screen comes from the demo studio (test/demo-studio.js): a pretend
// RUCKUS One, a pretend Cloudpath and the neutral test crawl, so no real tenant or Cloudpath data can end up in a picture.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
// No real credentials can be found by accident: the app and the demo studio are both told there is no config file, and no tenant environment variables.
for (const k of Object.keys(process.env)) if (/^R1_/.test(k)) delete process.env[k];
process.env.R1_CONFIG = path.join(os.tmpdir(), "no-such-config.json");
const { startDemo } = require("../test/demo-studio");

const root = path.join(__dirname, "..");
const outDir = path.join(__dirname, "images");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page"); if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("the app's window did not come up");
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "studio-shots-"));     // a brand-new install: nothing configured
  const demo = await startDemo({ port: 47900, cloudpathDelay: 90 });
  const app = spawn(require("electron"), [".", `--user-data-dir=${userData}`, "--remote-debugging-port=9340"], { cwd: root, stdio: "ignore", env: process.env });
  try {
    const ws = new WebSocket(await connect(9340)); await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map(); const events = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else events.push(m); };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(expression.slice(0, 80) + " -> " + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description).slice(0, 300)); return r.result.result.value; };
    const W = 1440, H = 900;
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const shot = async (name, opts = {}) => {
      await sleep(opts.wait || 500);
      const params = { format: "png" };
      if (opts.full) { const h = await ev("Math.max(document.documentElement.scrollHeight, 800)"); params.clip = { x: 0, y: 0, width: W, height: Math.min(h, opts.maxHeight || 2400), scale: 1 }; params.captureBeyondViewport = true; }
      const r = await send("Page.captureScreenshot", params);
      fs.writeFileSync(path.join(outDir, name + ".png"), Buffer.from(r.result.data, "base64")); console.log("  saved", name);
    };
    const clickText = (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.innerText.replace(/\\s+/g,' ').includes(${JSON.stringify(text)}));if(!b)return false;b.click();return true})()`);
    const clickExact = (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`);
    const must = async (ok, what) => { if (!ok) console.log("  !! could not find: " + what); };
    const go = async (url) => { await send("Page.navigate", { url }); await sleep(1800); };

    await sleep(2500);
    console.log("first start (a new install)");
    await shot("01-first-start", { wait: 1200 });

    console.log("demo studio");
    await go(demo.url);
    await ev("closeModal()");
    await shot("02-window");

    console.log("a sample, step editor, look, problems, try it");
    await must(await clickText("#left .list button", "School"), "School sample"); await sleep(900);
    await shot("03-sample-workflow");
    await ev("select(S.wf.steps[1].options[0].steps[1].id)"); await shot("04-step-editor");
    // the LDAP step: choose a profile from RUCKUS One ...
    const ldapId = "S.wf.steps[1].options[0].steps[0].id";
    await ev(`select(${ldapId})`); await ev(`(()=>{const n=S.wf.steps[1].options[0].steps[0]; n.params.directoryServerProfileId='d1'; changed(true)})()`); await shot("25-ldap-existing");
    // ... or create a new one (details only; the password stays empty in the picture)
    await ev(`(()=>{const n=S.wf.steps[1].options[0].steps[0]; Object.assign(n.params,{mode:'new',newName:'School directory',type:'AD',host:'ad.school.example',port:636,tlsEnabled:true,domainName:'school.example',adminDomainName:'CN=svc-wifi,OU=Service,DC=school,DC=example'}); changed(true)})()`); await shot("26-ldap-new");
    await ev(`(()=>{const n=S.wf.steps[1].options[0].steps[0]; n.params.mode='existing'; n.params.directoryServerProfileId=''; changed(true)})()`);   // back to the sample's open question for the Problems picture
    await ev("setTab('look')"); await shot("05-look");
    await ev("setTab('problems')"); await shot("06-problems");
    await ev("setTab('try')"); await sleep(600); await shot("07-try-it-start");
    console.log("   try it buttons:", JSON.stringify(await ev("[...document.querySelectorAll('#right button')].map(b=>b.innerText.trim()).filter(Boolean).slice(0,14)")));
    console.log("   screen 1 buttons:", JSON.stringify(await ev("[...document.querySelectorAll('#right button, #right input')].map(b=>(b.innerText||b.type||'').trim()).filter(Boolean).slice(0,14)")));
    await ev("(()=>{const c=document.querySelector('#right input[type=checkbox]'); if(c) c.click()})()"); await sleep(300);
    await clickExact("#right button", "Start"); await sleep(600);
    await shot("08-try-it-choice");

    console.log("a device split sample, then preview and apply");
    await ev("S.dirty=false"); await must(await clickText("#left .list button", "Computers vs phones"), "device sample"); await sleep(900);
    await ev("select(S.wf.steps[1].id)"); await shot("09-logical-split");
    await ev("(()=>{const c=S.wf.steps[1].options[0].steps[0]; c.params.caId='ca1'; changed(true); return validate()})()"); await sleep(700);
    await ev("doPreview()"); await sleep(1500); await shot("10-preview");
    await ev("doApply()"); await sleep(700); await shot("11-apply-confirm");
    await ev(`(()=>{const i=document.querySelector('.dialog input[type=text]'); i.value=fullName(); i.dispatchEvent(new Event('input')); [...document.querySelectorAll('.dialog button')].find(b=>/Create in RUCKUS One/.test(b.innerText)).click()})()`);
    await sleep(2500); await shot("12-created");
    await ev("openUndo()"); await sleep(800); await shot("13-undo");
    await ev("closeModal()");

    console.log("connections");
    await ev("openConnections()"); await sleep(800); await shot("14-connections");
    await clickText(".dialog button", "Add a RUCKUS One tenant"); await sleep(400); await ev("(()=>{const d=document.querySelector('.dialog'); const f=document.querySelector('.cform'); if(d&&f) d.scrollTo(0, f.offsetTop-120)})()"); await shot("15-add-tenant");
    await ev("closeModal()");

    console.log("the chart");
    await go(demo.url + "/coverage"); await shot("23-chart", { full: true, maxHeight: 1900 });
    await go(demo.url); await ev("closeModal()");
    console.log("converted workflows");
    await ev("S.dirty=false"); await must(await clickText("#left .list button", "Corporate"), "converted workflow"); await sleep(1000);
    await shot("20-converted-workflow");
    await ev("setTab('problems')"); await shot("21-converted-problems");
    await ev("S.dirty=false"); await must(await clickText("#left .list button", "Corporate guest network"), "converted guest network"); await sleep(1000);
    await shot("22-converted-guest-network");

    console.log("reading a Cloudpath instance");
    await ev("openConnections('cloudpath')"); await sleep(800);
    await ev(`(()=>{const set=(id,v)=>{const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input'))}; set('cp_url',${JSON.stringify(demo.cloudpath.origin)}); set('cp_user',${JSON.stringify(demo.cloudpath.user)}); set('cp_pass',${JSON.stringify(demo.cloudpath.pass)}); CV.cpFilter=''; CV.cpLimit=''})()`);
    await ev("document.querySelector('.dialog').scrollTo(0, 400)"); await shot("16-read-cloudpath");
    await clickText(".dialog button", "Read it now"); await sleep(4500);
    await ev("document.querySelector('.dialog').scrollTo(0, 360)"); await shot("17-reading-progress", { wait: 100 });
    for (let i = 0; i < 80; i++) { const st = await ev("JSON.stringify((C.cloudpath.job||{}).state)"); if (/done|failed|stopped/.test(st)) break; await sleep(500); }
    await sleep(1500); await ev("document.querySelector('.dialog').scrollTo(0, 0)"); await shot("18-read-done");
    await ev("closeModal()");
    await shot("24-cloudpath-list");

    ws.close();
  } finally {
    app.kill(); await demo.close();
  }
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
