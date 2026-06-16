/*
 * app.js — UI wiring for the DHIS2 × OpenCPU statistical analysis app.
 *
 * Flow:
 *   1. Browser fetches data from DHIS2 (analytics API) using the user's session.
 *   2. Loaded datasets are turned into an R "preamble" that reconstructs them as
 *      data frames (data is base64-encoded, so no R/JSON escaping issues).
 *   3. The preamble + the user's editor code is sent to OpenCPU and executed.
 *   4. Console text and any plots are rendered RStudio-style.
 */
(function () {
  'use strict';

  const DEFAULT_OCPU = 'https://cloud.opencpu.org/ocpu';
  const LS_KEY = 'dhis2-opencpu-url';

  // In-memory "environment": varName -> { rows, nrow, ncol, label }
  const datasets = {};

  // ---- element shortcuts -------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const gutter = $('gutter');
  const consoleEl = $('console');
  const plotsEl = $('plots');
  const ocpuUrlInput = $('ocpu-url');
  const ocpuStatus = $('ocpu-status');

  // =======================================================================
  // OpenCPU server URL handling
  // =======================================================================
  function initOcpuUrl() {
    ocpuUrlInput.value = localStorage.getItem(LS_KEY) || DEFAULT_OCPU;
    ocpuUrlInput.addEventListener('change', () => {
      localStorage.setItem(LS_KEY, ocpuUrlInput.value.trim());
      setOcpuStatus('unknown', 'not tested');
    });
  }

  function setOcpuStatus(kind, label) {
    ocpuStatus.className = 'status status--' + kind;
    ocpuStatus.textContent = '● ' + label;
  }

  async function testOcpu() {
    setOcpuStatus('unknown', 'testing…');
    try {
      await OpenCPU.test(ocpuUrlInput.value);
      setOcpuStatus('ok', 'connected');
    } catch (e) {
      setOcpuStatus('err', 'unreachable');
      printConsole('OpenCPU connection failed: ' + e.message + '\n', 'err');
    }
  }

  // =======================================================================
  // Editor: line-number gutter, tab handling, run shortcut
  // =======================================================================
  function syncGutter() {
    const lines = editor.value.split('\n').length || 1;
    let out = '';
    for (let i = 1; i <= lines; i++) out += i + '\n';
    gutter.textContent = out;
    gutter.scrollTop = editor.scrollTop;
  }

  function initEditor() {
    editor.addEventListener('input', syncGutter);
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('keydown', (e) => {
      // Insert two spaces on Tab instead of moving focus.
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = editor.selectionStart, en = editor.selectionEnd;
        editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en);
        editor.selectionStart = editor.selectionEnd = s + 2;
        syncGutter();
      }
      // Ctrl/Cmd+Enter runs the whole script.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runAll();
      }
    });
    syncGutter();
  }

  // =======================================================================
  // Console + plots rendering
  // =======================================================================
  function printConsole(text, kind) {
    const span = document.createElement('span');
    if (kind) span.className = 'console-' + kind;
    span.textContent = text;
    consoleEl.appendChild(span);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function renderPlots(urls) {
    if (!urls.length) return;
    const hint = plotsEl.querySelector('.hint');
    if (hint) hint.remove();
    urls.forEach((u) => {
      const img = new Image();
      img.src = u;
      img.alt = 'R plot';
      img.className = 'plot-img';
      plotsEl.appendChild(img);
    });
    plotsEl.scrollTop = plotsEl.scrollHeight;
  }

  // =======================================================================
  // R preamble from loaded datasets
  // =======================================================================
  function buildPreamble() {
    const names = Object.keys(datasets);
    if (!names.length) return '';
    let r = '## --- DHIS2 data loaded by the app ---\n';
    names.forEach((name) => {
      const json = JSON.stringify(datasets[name].rows);
      const b64 = OpenCPU.toBase64(json);
      r += name + ' <- jsonlite::fromJSON(rawToChar(jsonlite::base64_dec("' + b64 + '")))\n';
      r += 'if ("value" %in% names(' + name + ')) ' + name +
           '$value <- suppressWarnings(as.numeric(' + name + '$value))\n';
    });
    r += '## --- end DHIS2 data ---\n';
    return r;
  }

  // =======================================================================
  // Run
  // =======================================================================
  let running = false;
  async function runAll() {
    if (running) return;
    const code = editor.value;
    if (!code.trim()) return;
    running = true;
    $('run-all').disabled = true;

    printConsole('\n> Running…\n', 'cmd');
    const fullScript = buildPreamble() + '\n' + code + '\n';
    try {
      const result = await OpenCPU.run(ocpuUrlInput.value, fullScript);
      setOcpuStatus('ok', 'connected');
      if (result.console) printConsole(result.console);
      if (result.error) printConsole(result.error + '\n', 'err');
      renderPlots(result.plots);
      if (!result.console && !result.error && !result.plots.length) {
        printConsole('(no output)\n', 'muted');
      }
    } catch (e) {
      setOcpuStatus('err', 'unreachable');
      printConsole('Error: ' + e.message + '\n', 'err');
    } finally {
      running = false;
      $('run-all').disabled = false;
    }
  }

  // =======================================================================
  // DHIS2 data browser
  // =======================================================================
  async function initDhis() {
    try {
      const base = await DHIS2.resolveApiBase();
      $('dhis-status').textContent = 'DHIS2 API: ' + base;

      const [me, indicators, roots] = await Promise.all([
        DHIS2.getMe().catch(() => null),
        DHIS2.getIndicators().catch(() => []),
        DHIS2.getRootOrgUnits().catch(() => []),
      ]);

      if (me) $('dhis-status').textContent += '  •  ' + (me.name || me.username || '');

      const dx = $('dx-select');
      dx.innerHTML = '';
      indicators.forEach((it) => {
        const o = document.createElement('option');
        o.value = it.id;
        o.textContent = it.displayName;
        dx.appendChild(o);
      });
      $('dx-hint').textContent = indicators.length
        ? indicators.length + ' indicators available (Ctrl/Cmd-click to multi-select).'
        : 'No indicators returned. Check your DHIS2 connection/permissions.';

      const ou = $('ou-select');
      ou.innerHTML = '';
      // Prefer the user's own org units; fall back to root org units.
      const ouList = (me && me.organisationUnits && me.organisationUnits.length)
        ? me.organisationUnits : roots;
      ouList.forEach((u) => {
        const o = document.createElement('option');
        o.value = u.id;
        o.textContent = u.displayName;
        ou.appendChild(o);
      });
    } catch (e) {
      $('dhis-status').textContent = 'DHIS2 connection failed: ' + e.message;
    }
  }

  async function fetchData() {
    const dxSel = $('dx-select');
    const dx = Array.from(dxSel.selectedOptions).map((o) => o.value);
    const pe = $('pe-select').value;
    const ou = $('ou-select').value;
    const varName = ($('var-name').value || 'df').trim().replace(/[^A-Za-z0-9_.]/g, '_');

    if (!dx.length) { alert('Select at least one data item.'); return; }
    if (!ou) { alert('No organisation unit available.'); return; }

    const preview = $('data-preview');
    preview.innerHTML = '<small class="hint">Fetching from DHIS2…</small>';
    $('fetch-data').disabled = true;
    try {
      const analytics = await DHIS2.getAnalytics(dx, pe, ou);
      const rows = DHIS2.analyticsToRows(analytics);
      if (!rows.length) {
        preview.innerHTML = '<small class="hint">Query returned no data for that selection.</small>';
        return;
      }
      const cols = Object.keys(rows[0]);
      datasets[varName] = { rows, nrow: rows.length, ncol: cols.length, cols };
      renderPreview(varName, rows, cols);
      renderEnv();
      printConsole('Loaded "' + varName + '" (' + rows.length + ' rows) from DHIS2.\n', 'muted');
    } catch (e) {
      preview.innerHTML = '<small class="hint">Fetch failed: ' + escapeHtml(e.message) + '</small>';
    } finally {
      $('fetch-data').disabled = false;
    }
  }

  function renderPreview(varName, rows, cols) {
    const max = 10;
    let html = '<div class="preview-head">' + escapeHtml(varName) + ' &mdash; ' +
      rows.length + ' rows &times; ' + cols.length + ' cols</div>';
    html += '<table class="preview-table"><thead><tr>';
    cols.forEach((c) => { html += '<th>' + escapeHtml(c) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.slice(0, max).forEach((r) => {
      html += '<tr>';
      cols.forEach((c) => { html += '<td>' + escapeHtml(String(r[c] == null ? '' : r[c])) + '</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    if (rows.length > max) html += '<small class="hint">Showing first ' + max + ' rows.</small>';
    $('data-preview').innerHTML = html;
  }

  function renderEnv() {
    const tbody = $('env-tbody');
    const names = Object.keys(datasets);
    if (!names.length) {
      tbody.innerHTML = '<tr class="env-empty"><td colspan="3">No datasets loaded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    names.forEach((n) => {
      const d = datasets[n];
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><code>' + escapeHtml(n) + '</code></td>' +
        '<td>data.frame</td>' +
        '<td>' + d.nrow + ' obs. of ' + d.ncol + ' variables</td>';
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // =======================================================================
  // Tabs
  // =======================================================================
  function initTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('tab--active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('tab-panel--active'));
        tab.classList.add('tab--active');
        $('tab-' + tab.dataset.tab).classList.add('tab-panel--active');
      });
    });
  }

  // =======================================================================
  // Boot
  // =======================================================================
  function init() {
    initOcpuUrl();
    initEditor();
    initTabs();

    $('ocpu-test').addEventListener('click', testOcpu);
    $('run-all').addEventListener('click', runAll);
    $('clear-editor').addEventListener('click', () => { editor.value = ''; syncGutter(); });
    $('clear-console').addEventListener('click', () => { consoleEl.innerHTML = ''; });
    $('clear-plots').addEventListener('click', () => {
      plotsEl.innerHTML = '<small class="hint">Plots produced by your R code appear here.</small>';
    });
    $('fetch-data').addEventListener('click', fetchData);

    printConsole('OpenCPU R console ready. Load DHIS2 data, write R, press Run.\n', 'muted');
    initDhis();
    testOcpu();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();