/*
 * opencpu.js — client for executing R code on an OpenCPU server.
 *
 * OpenCPU interprets POST form parameters as R expressions. We exploit that to
 * run arbitrary user code: the code (plus any DHIS2 data preamble) is
 * base64-encoded in the browser and decoded + sourced on the server. Using
 * base64 avoids fragile R/URL string escaping. `source(echo=TRUE,
 * print.eval=TRUE)` makes the captured console output read like an RStudio
 * console (commands echoed, values printed).
 *
 * Docs: https://www.opencpu.org/api.html
 */
window.OpenCPU = (function () {
  // UTF-8 safe base64 encoding (btoa alone mishandles multibyte characters).
  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  function trimSlash(url) {
    return (url || '').trim().replace(/\/+$/, '');
  }

  function originOf(baseUrl) {
    try { return new URL(baseUrl).origin; }
    catch (e) { return ''; }
  }

  /** Quick connectivity check against the OpenCPU server. */
  async function test(baseUrl) {
    const base = trimSlash(baseUrl);
    if (!base) throw new Error('No OpenCPU URL set.');
    const res = await fetch(base + '/library/base/R/', { method: 'GET' });
    if (!res.ok) throw new Error(`Server responded ${res.status}.`);
    return true;
  }

  /**
   * Execute R code on OpenCPU.
   * @param {string} baseUrl  e.g. https://cloud.opencpu.org/ocpu
   * @param {string} code     full R script (preamble + user code)
   * @returns {Promise<{ok, console, error, plots:string[], session}>}
   */
  async function run(baseUrl, code) {
    const base = trimSlash(baseUrl);
    if (!base) throw new Error('No OpenCPU URL set. Enter one in the top bar.');
    const origin = originOf(base);

    const b64 = toBase64(code);
    // R expression evaluated by base::eval. Decodes the script and sources it
    // so commands are echoed and values auto-printed into the console capture.
    const expr =
      '{.src<-rawToChar(jsonlite::base64_dec("' + b64 + '"));' +
      'source(textConnection(.src),echo=TRUE,print.eval=TRUE,' +
      'max.deparse.length=1e5,spaced=FALSE);invisible(NULL)}';

    const body = 'expr=' + encodeURIComponent(expr);
    const res = await fetch(base + '/library/base/R/eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const text = await res.text();

    // Errors come back as 4xx with a plain-text R error message.
    if (!res.ok) {
      return { ok: false, console: '', error: text.trim() || ('HTTP ' + res.status), plots: [], session: null };
    }

    // Success: body lists output resource paths for the new tmp session.
    const sessionMatch = text.match(/\/ocpu\/tmp\/([^/\s]+)\//);
    const session = sessionMatch ? sessionMatch[1] : null;
    const sessionPath = session ? '/ocpu/tmp/' + session : null;

    // Console output (echoed commands + printed values).
    let consoleText = '';
    if (sessionPath) {
      try {
        const c = await fetch(origin + sessionPath + '/console', { method: 'GET' });
        if (c.ok) consoleText = await c.text();
      } catch (e) { /* console may be empty */ }
    }

    // Collect graphics: paths look like /ocpu/tmp/<key>/graphics/<n>
    const plots = [];
    if (sessionPath) {
      const graphicsNums = [];
      const re = /\/graphics\/(\d+)(?:\/|\b)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const n = m[1];
        if (graphicsNums.indexOf(n) === -1) graphicsNums.push(n);
      }
      graphicsNums.forEach((n) => {
        plots.push(origin + sessionPath + '/graphics/' + n + '/png?width=900&height=600');
      });
    }

    return { ok: true, console: consoleText, error: '', plots, session };
  }

  return { test, run, toBase64 };
})();