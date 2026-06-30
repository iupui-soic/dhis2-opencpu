/*
 * dhis2.js
 * Client for the DHIS2 Web API.
 *
 * The app is served by DHIS2 from <server>/api/apps/<app>/index.html, so all
 * requests are same origin and use the logged in user's session cookie. The
 * credentials never leave the browser.
 */
window.DHIS2 = (function () {
  let apiBase = null;

  // Request settings.
  const TIMEOUT_MS = 30000;
  const RETRIES = 1;
  // Data items per analytics call. Big requests are split into batches this
  // size, and a failing batch is split further so one bad item cannot break
  // the whole query.
  const BATCH_SIZE = 10;

  // Work out the DHIS2 API base URL.
  // 1. From the app's own location (.../api/apps/<app>/...).
  // 2. From the manifest's activities.dhis.href, rewritten by DHIS2 on install.
  // 3. A relative guess for local development.
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
    } catch (e) { /* ignore and fall through */ }

    apiBase = '../../../api';
    return apiBase;
  }

  // Fetch with a timeout and a small number of retries.
  async function fetchJson(url) {
    let lastError = null;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const text = await res.text().catch(function () { return ''; });
          throw new Error('DHIS2 ' + res.status + ': ' + text.slice(0, 160));
        }
        return res.json();
      } catch (e) {
        clearTimeout(timer);
        lastError = e.name === 'AbortError' ? new Error('Request timed out.') : e;
      }
    }
    throw lastError;
  }

  async function api(path) {
    const base = await resolveApiBase();
    return fetchJson(base + path);
  }

  async function getMe() {
    return api('/me.json?fields=id,username,name,authorities,organisationUnits[id,displayName,level]');
  }

  // Where each data item type lives in the API, and how to turn it into an
  // analytics dx token. Data sets are queried as reporting rates.
  const ITEM_TYPES = {
    indicators: {
      endpoint: 'indicators',
      dxId: function (it) { return it.id; },
    },
    dataElements: {
      endpoint: 'dataElements',
      extraFilter: 'domainType:eq:AGGREGATE',
      dxId: function (it) { return it.id; },
    },
    programIndicators: {
      endpoint: 'programIndicators',
      dxId: function (it) { return it.id; },
    },
    dataSets: {
      endpoint: 'dataSets',
      dxId: function (it) { return it.id + '.REPORTING_RATE'; },
      suffix: ' (reporting rate)',
    },
  };

  // Search data items of a type by name. Uses server side filtering so it
  // scales to a whole instance instead of downloading everything. An empty
  // query returns the first page.
  async function searchDataItems(type, query) {
    const cfg = ITEM_TYPES[type] || ITEM_TYPES.indicators;
    let path = '/' + cfg.endpoint + '.json?fields=id,displayName&order=displayName:asc&pageSize=75';
    if (cfg.extraFilter) path += '&filter=' + cfg.extraFilter;
    if (query && query.trim()) {
      path += '&filter=displayName:ilike:' + encodeURIComponent(query.trim());
    }
    const data = await api(path);
    const list = data[cfg.endpoint] || [];
    return list.map(function (it) {
      return {
        id: it.id,
        dxId: cfg.dxId(it),
        name: it.displayName + (cfg.suffix || ''),
      };
    });
  }

  // Organisation unit tree, loaded lazily.
  async function getRootOrgUnits() {
    const data = await api('/organisationUnits.json?fields=id,displayName,level,children::isNotEmpty&filter=level:eq:1&paging=false');
    return data.organisationUnits || [];
  }

  async function getChildOrgUnits(parentId) {
    const data = await api('/organisationUnits.json?fields=id,displayName,level,children::isNotEmpty&filter=parent.id:eq:' + parentId + '&order=displayName:asc&paging=false');
    return data.organisationUnits || [];
  }

  // One raw analytics call for a set of dx tokens.
  // dx is an array of dx tokens, pe is a period expression (relative keyword or
  // fixed periods separated by ;), ou is one or more org unit ids separated by ;.
  // If withDisagg is true the category option combo dimension is included.
  async function analyticsCall(dx, pe, ou, withDisagg) {
    const params = [
      'dimension=dx:' + dx.join(';'),
      'dimension=pe:' + pe,
      'dimension=ou:' + ou,
      'displayProperty=NAME',
      'skipMeta=false',
    ];
    if (withDisagg) params.push('dimension=co');
    return api('/analytics.json?' + params.join('&'));
  }

  // Run an analytics query, splitting data items into batches and isolating any
  // that fail so the good data still comes back. Returns a merged response with
  // a _failed list of dx tokens that could not be fetched.
  async function getAnalytics(dx, pe, ou, withDisagg) {
    const responses = [];
    const failed = [];
    let lastError = null;

    async function fetchGroup(ids) {
      if (!ids.length) return;
      try {
        responses.push(await analyticsCall(ids, pe, ou, withDisagg));
      } catch (e) {
        lastError = e;
        if (ids.length > 1) {
          const mid = Math.ceil(ids.length / 2);
          await fetchGroup(ids.slice(0, mid));
          await fetchGroup(ids.slice(mid));
        } else {
          failed.push(ids[0]);
        }
      }
    }

    for (let i = 0; i < dx.length; i += BATCH_SIZE) {
      await fetchGroup(dx.slice(i, i + BATCH_SIZE));
    }

    if (!responses.length) throw lastError || new Error('No data could be retrieved.');
    return mergeAnalytics(responses, failed);
  }

  function mergeAnalytics(responses, failed) {
    const merged = {
      headers: responses[0].headers || [],
      rows: [],
      metaData: { items: {} },
      _failed: failed || [],
    };
    responses.forEach(function (r) {
      if (r.rows) merged.rows = merged.rows.concat(r.rows);
      const items = r.metaData && r.metaData.items;
      if (items) Object.keys(items).forEach(function (k) { merged.metaData.items[k] = items[k]; });
    });
    return merged;
  }

  // Turn an analytics response into plain row objects with readable column
  // names and resolved item names. The value column stays a string here and is
  // converted to numeric on the R side.
  function analyticsToRows(analytics) {
    const headers = analytics.headers || [];
    const items = (analytics.metaData && analytics.metaData.items) || {};
    function resolve(id) {
      return (items[id] && items[id].name) ? items[id].name : id;
    }
    function labelFor(h) {
      switch (h.name) {
        case 'dx': return 'data';
        case 'pe': return 'period';
        case 'ou': return 'orgunit';
        case 'co': return 'category';
        case 'value': return 'value';
        default: return h.column || h.name;
      }
    }
    const resolvable = { dx: true, pe: true, ou: true, co: true };

    return (analytics.rows || []).map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) {
        obj[labelFor(h)] = resolvable[h.name] ? resolve(row[i]) : row[i];
      });
      return obj;
    });
  }

  // Fetch any DHIS2 API resource as raw JSON, for advanced users who want data
  // beyond analytics. path is appended to the API base, for example
  // "/dataElements.json?paging=false".
  async function rawApi(path) {
    if (!path) throw new Error('Enter an API path.');
    let p = path.trim();
    if (p.charAt(0) !== '/') p = '/' + p;
    return api(p);
  }

  return {
    resolveApiBase: resolveApiBase,
    getMe: getMe,
    searchDataItems: searchDataItems,
    getRootOrgUnits: getRootOrgUnits,
    getChildOrgUnits: getChildOrgUnits,
    getAnalytics: getAnalytics,
    analyticsToRows: analyticsToRows,
    rawApi: rawApi,
  };
})();