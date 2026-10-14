// Browser version of the Cloudpath crawler: run it inside a signed-in Cloudpath admin tab (read-only: GET requests only).
// The crawling itself is crawl/core.js, inlined at the marker below by src/crawlscript.js (the editor's Connections dialog gives you
// the finished script; `node bin/crawl-script.js` prints it). It posts the result to the editor (or `node bin/receive.js`) and falls
// back to downloading crawl.json when the Cloudpath page's security policy blocks that.
//
// Options, set before running (all optional):
//   window.__CRAWL_FILTER   only workflows whose name contains one of these words (comma or new line separated), or a /regex/
//   window.__CRAWL_LIMIT    read at most this many workflows (in list order)
//   window.__CRAWL_PARALLEL read this many workflows at once (default 3, at most 6; tested: the same result as one at a time, about 40% faster)
//   window.__CRAWL_STOP = true   stop early: what is read so far is still saved
(async () => {
/*__CRAWL_CORE__*/
  const RECEIVER = window.__CRAWL_RECEIVER || "http://127.0.0.1:8765/crawl";
  const parse = (html) => new DOMParser().parseFromString(html, "text/html");
  const get = async (url) => {
    for (let attempt = 0; ; attempt++) {                              // a busy server (429, 5xx) or a dropped request is tried again, twice
      try {
        const r = await fetch(url, { credentials: "same-origin" });
        if (r.ok) return r.text();
        if (attempt >= 2 || (r.status < 500 && r.status !== 429)) throw new Error(url + " -> " + r.status);
      } catch (e) { if (attempt >= 2 || /-> \d+$/.test(String(e.message))) throw e; }
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    }
  };
  const result = await CrawlCore.run({ get, parse, origin: location.origin, version: async () => document.body.innerText, log: (s) => console.log(s),
    options: { filter: window.__CRAWL_FILTER, limit: window.__CRAWL_LIMIT, parallel: window.__CRAWL_PARALLEL }, stopped: () => !!window.__CRAWL_STOP });
  console.log("Set window.__CRAWL_STOP = true before running to stop early.");
  window.__crawl = result;
  const body = JSON.stringify(result);
  if (window.__NO_SEND) return "crawled " + body.length + " bytes (kept in window.__crawl)";
  try {
    const r = await fetch(RECEIVER, { method: "POST", headers: { "content-type": "application/json", ...(window.__CRAWL_CODE ? { "x-crawl-code": window.__CRAWL_CODE } : {}) }, body });
    return "sent " + body.length + " bytes to receiver: " + r.status;
  } catch (e) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: "application/json" })); a.download = "crawl.json"; a.click();
    return "Could not send the crawl to the editor (" + e + "). That is normal when the Cloudpath page blocks connections to other addresses. It was downloaded as crawl.json instead: drop that file on the editor page, or use Connections > Load a crawl file.";
  }
})();
