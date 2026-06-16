/*
 * dhis2.js — thin DHIS2 Web API client.
 *
 * The app is served by DHIS2 from <server>/api/apps/<app>/index.html, so all
 * requests are same-origin and authenticated with the logged-in user's session
 * cookie. Credentials never leave the browser — matching the security model in
 * the project abstract.
 */
window.DHIS2 = (function () {
  let apiBase = null; // e.g. https://play.dhis2.org/40/api

  /**
   * Resolve the DHIS2 API base URL.
   * 1. Derive from the app's own location (.../api/apps/<app>/...).
   * 2. Fall back to manifest.webapp's activities.dhis.href (rewritten by DHIS2
   *    at install time).
   * 3. Fall back to a relative "../../.." guess.
   */
  async function resolveApiBase() {
    if (apiBase) return apiBase;

    const href = window.location.href;
    const marker = '/api/apps/';
    const idx = href.indexOf(marker);
    if (idx !== -1) {
      apiBase = href.substring(0, idx) + '/api';
      return apiBase;
    }

    try {
      const res = await fetch('manifest.webapp', { credentials: 'include' });
      if (res.ok) {
        const manifest = await res.json();
        let h = manifest.activities && manifest.activities.dhis && manifest.activities.dhis.href;
        if (h && h !== '*') {
          h = h.replace(/\/+$/, '');
          apiBase = /\/api$/.test(h) ? h : h + '/api';
          return apiBase;
        }
      }
    } catch (e) { /* ignore, fall through */ }

    // Last resort for local development against a relative DHIS2 instance.
    apiBase = '../../../api';
    return apiBase;
  }

  async function api(path) {
    const base = await resolveApiBase();
    const url = base + path;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DHIS2 ${res.status} on ${path}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async function getMe() {
    return api('/me.json?fields=id,username,name,organisationUnits[id,displayName]');
  }

  async function getIndicators() {
    const data = await api('/indicators.json?fields=id,displayName&paging=false&order=displayName:asc');
    return data.indicators || [];
  }

  async function getRootOrgUnits() {
    const data = await api('/organisationUnits.json?fields=id,displayName&filter=level:eq:1&paging=false');
    return data.organisationUnits || [];
  }

  /**
   * Run an analytics query.
   * @param {string[]} dx  data item ids
   * @param {string}   pe  period (relative period keyword)
   * @param {string}   ou  organisation unit id
   * @returns {Promise<object>} raw analytics response (headers, rows, metaData)
   */
  async function getAnalytics(dx, pe, ou) {
    const params = [
      'dimension=dx:' + dx.join(';'),
      'dimension=pe:' + pe,
      'dimension=ou:' + ou,
      'displayProperty=NAME',
      'skipMeta=false',
    ].join('&');
    return api('/analytics.json?' + params);
  }

  /**
   * Flatten an analytics response into an array of plain row objects with
   * human-readable column names and resolved item names. Numeric value column
   * is left as a string here; it is coerced to numeric on the R side.
   */
  function analyticsToRows(analytics) {
    const headers = analytics.headers || [];
    const items = (analytics.metaData && analytics.metaData.items) || {};
    const resolve = (id) => (items[id] && items[id].name) ? items[id].name : id;

    // Friendly column labels keyed by dimension code.
    const labelFor = (h) => {
      switch (h.name) {
        case 'dx': return 'data';
        case 'pe': return 'period';
        case 'ou': return 'orgunit';
        case 'value': return 'value';
        default: return h.column || h.name;
      }
    };
    const resolvable = { dx: true, pe: true, ou: true };

    return (analytics.rows || []).map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        const key = labelFor(h);
        obj[key] = resolvable[h.name] ? resolve(row[i]) : row[i];
      });
      return obj;
    });
  }

  return {
    resolveApiBase,
    getMe,
    getIndicators,
    getRootOrgUnits,
    getAnalytics,
    analyticsToRows,
  };
})();