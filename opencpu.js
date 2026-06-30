/*
 * opencpu.js
 * Client for an OpenCPU server: running R code, listing installed packages, and
 * trying to install new ones.
 *
 * Running code: OpenCPU reads POST form parameters as R expressions. The whole
 * script is base64 encoded in the browser and decoded on the server, which
 * avoids quoting problems. It is sourced with echo and print.eval on so the
 * captured console reads like a normal R console.
 *
 * API reference: https://www.opencpu.org/api.html
 */
window.OpenCPU = (function () {
  const TIMEOUT_MS = 120000;

  // UTF-8 safe base64. Plain btoa does not handle multibyte characters.
  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  function trimSlash(url) { return (url || '').trim().replace(/\/+$/, ''); }

  function originOf(baseUrl) {
    try { return new URL(baseUrl).origin; }
    catch (e) { return ''; }
  }

  async function withTimeout(doFetch) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    try {
      return await doFetch(controller.signal);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('OpenCPU request timed out.');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Check the server is reachable.
  async function test(baseUrl) {
    const base = trimSlash(baseUrl);
    if (!base) throw new Error('No OpenCPU URL set.');
    const res = await withTimeout(function (signal) {
      return fetch(base + '/library/base/R/', { method: 'GET', signal: signal });
    });
    if (!res.ok) throw new Error('Server responded ' + res.status + '.');
    return true;
  }

  // List packages installed on the server. GET /library/ returns one per line.
  async function listPackages(baseUrl) {
    const base = trimSlash(baseUrl);
    if (!base) throw new Error('No OpenCPU URL set.');
    const res = await withTimeout(function (signal) {
      return fetch(base + '/library/', { method: 'GET', signal: signal });
    });
    if (!res.ok) throw new Error('Could not list packages (' + res.status + ').');
    const text = await res.text();
    return text.split('\n')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; })
      .sort();
  }

  // Try to install a package. Works only on servers that allow it (your own
  // self hosted OpenCPU with internet). The public cloud server is read only.
  async function installPackage(baseUrl, name) {
    const base = trimSlash(baseUrl);
    if (!base) throw new Error('No OpenCPU URL set.');
    const pkg = (name || '').trim();
    if (!pkg) throw new Error('Enter a package name.');
    const body = 'pkgs=' + encodeURIComponent('"' + pkg + '"') +
      '&repos=' + encodeURIComponent('"https://cloud.r-project.org"');
    const res = await withTimeout(function (signal) {
      return fetch(base + '/library/utils/R/install.packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body,
        signal: signal,
      });
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text.trim() || ('HTTP ' + res.status));
    return text;
  }

  // R expression that decodes and sources a base64 encoded script.
  function buildExpr(code) {
    const b64 = toBase64(code);
    return '{.src<-rawToChar(jsonlite::base64_dec("' + b64 + '"));' +
      'source(textConnection(.src),echo=TRUE,print.eval=TRUE,' +
      'max.deparse.length=1e5,spaced=FALSE);invisible(NULL)}';
  }

  // Run an R script. Returns console text and any plot image URLs.
  async function run(baseUrl, code) {
    const base = trimSlash(baseUrl);
    if (!base) throw new Error('No OpenCPU URL set. Enter one in the top bar.');
    const origin = originOf(base);

    const body = 'expr=' + encodeURIComponent(buildExpr(code));
    const res = await withTimeout(function (signal) {
      return fetch(base + '/library/base/R/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body,
        signal: signal,
      });
    });

    const text = await res.text();

    if (!res.ok) {
      return { ok: false, console: '', error: text.trim() || ('HTTP ' + res.status), plots: [], session: null };
    }

    const sessionMatch = text.match(/\/ocpu\/tmp\/([^/\s]+)\//);
    const session = sessionMatch ? sessionMatch[1] : null;
    const sessionPath = session ? '/ocpu/tmp/' + session : null;

    let consoleText = '';
    if (sessionPath) {
      try {
        const c = await fetch(origin + sessionPath + '/console', { method: 'GET' });
        if (c.ok) consoleText = await c.text();
      } catch (e) { /* console may be empty */ }
    }

    const plots = [];
    if (sessionPath) {
      const seen = [];
      const re = /\/graphics\/(\d+)(?:\/|\b)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (seen.indexOf(m[1]) === -1) seen.push(m[1]);
      }
      seen.forEach(function (n) {
        plots.push(origin + sessionPath + '/graphics/' + n + '/png?width=1000&height=700');
      });
    }

    return { ok: true, console: consoleText, error: '', plots: plots, session: session };
  }

  return {
    test: test,
    run: run,
    listPackages: listPackages,
    installPackage: installPackage,
    toBase64: toBase64,
  };
})();