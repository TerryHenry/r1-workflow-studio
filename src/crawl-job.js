// The editor's own crawl of a Cloudpath instance: sign in, run the shared crawler (crawl/core.js) with the server's HTML parser, sign out.
// One job at a time. The password only exists as an argument to the sign-in call.
const CrawlCore = require("../crawl/core");
const { parse } = require("./minidom");
const { createSession, normalizeOrigin } = require("./cloudpath-client");

function startCrawlJob({ url, username, password, filter, limit, parallel, fetchImpl, onDone }) {
  const origin = normalizeOrigin(url);
  const user = String(username || "").trim();
  if (!user) { const e = new Error("Enter the email (user name) of a Cloudpath admin."); e.status = 400; throw e; }
  if (!password) { const e = new Error("Enter the password."); e.status = 400; throw e; }
  const job = { state: "starting", message: "Signing in…", origin, done: 0, total: 0, listed: null, name: "", secondsLeft: null, startedAt: Date.now(), finishedAt: null, stopRequested: false, log: [] };
  const say = (s) => { job.log.push(String(s)); if (job.log.length > 60) job.log.shift(); };
  const session = createSession(origin, { fetchImpl });
  let pass = password;                                    // dropped as soon as the sign-in call has it
  job.stop = () => { job.stopRequested = true; job.message = "Stopping…"; };
  job.done_ = (async () => {
    try {
      const { homeText } = await session.login(user, pass); pass = null;
      job.state = "running"; job.message = "Reading…";
      const result = await CrawlCore.run({
        get: (u) => session.get(u), parse, origin, version: async () => homeText, log: say,
        options: { filter, limit, parallel }, stopped: () => job.stopRequested,
        progress: (p) => { Object.assign(job, { done: p.done, total: p.total, name: p.name || "", listed: p.listed == null ? job.listed : p.listed, secondsLeft: p.secondsLeft == null ? null : p.secondsLeft }); },
      });
      job.state = result.stopped ? "stopped" : "done"; job.message = (result.stopped ? "Stopped: kept the " : "Read ") + result.workflows.length + " workflow" + (result.workflows.length === 1 ? "" : "s") + ".";
      job.finishedAt = Date.now();
      await onDone(result);
    } catch (e) {
      pass = null; job.state = "failed"; job.message = String((e && e.message) || e).slice(0, 400); job.finishedAt = Date.now();
    } finally { pass = null; await session.logout(); }
  })();
  return job;
}

// What the page may see of a job: no log lines that could hold anything but progress text.
const publicJob = (j) => (j ? { state: j.state, message: j.message, origin: j.origin, done: j.done, total: j.total, listed: j.listed, name: j.name, secondsLeft: j.secondsLeft, startedAt: j.startedAt, finishedAt: j.finishedAt } : null);

module.exports = { startCrawlJob, publicJob };
