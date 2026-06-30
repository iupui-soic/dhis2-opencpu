/*
 * app.js
 * User interface for the DHIS2 and OpenCPU analysis app.
 *
 * Flow:
 *   1. The browser fetches data from DHIS2 using the logged in user's session.
 *   2. Each loaded dataset becomes R code that rebuilds it (data is base64
 *      encoded so there are no quoting problems).
 *   3. That code, optional replay of earlier runs, and the editor code are sent
 *      to OpenCPU and run.
 *   4. Console text and plots are shown in the bottom panes.
 */
(function () {
  'use strict';

  var DEFAULT_OCPU = 'https://cloud.opencpu.org/ocpu';
  var LS_URL = 'dhis2-opencpu-url';
  var LS_THEME = 'dhis2-opencpu-theme';
  var LS_COL = 'dhis2-opencpu-col';
  var LS_ROW = 'dhis2-opencpu-row';
  var MAX_CONSOLE = 200000; // characters kept in the console

  // Loaded objects, keyed by R variable name.
  // Each entry is { kind: 'table'|'json', ... }.
  var datasets = {};
  // Code from earlier successful runs, used to rebuild the environment.
  var historyCode = [];
  // All commands ever run, for the History tab.
  var historyAll = [];
  // Installed packages on the server.
  var allPackages = [];
  // Selected organisation unit ids.
  var selectedOu = {};

  function $(id) { return document.getElementById(id); }
  var editor, gutter, consoleEl, plotsEl, ocpuUrlInput, ocpuStatus;

  // Theme

  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    $('theme-toggle').textContent = theme === 'dark' ? 'Light' : 'Dark';
    localStorage.setItem(LS_THEME, theme);
  }
  function toggleTheme() {
    applyTheme(document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  }

  // OpenCPU server

  function initOcpuUrl() {
    ocpuUrlInput.value = localStorage.getItem(LS_URL) || DEFAULT_OCPU;
    ocpuUrlInput.addEventListener('change', function () {
      localStorage.setItem(LS_URL, ocpuUrlInput.value.trim());
      setOcpuStatus('unknown', 'not tested');
    });
  }
  function setOcpuStatus(kind, label) {
    ocpuStatus.className = 'status status--' + kind;
    ocpuStatus.textContent = label;
  }
  async function testOcpu() {
    setOcpuStatus('unknown', 'testing...');
    try {
      await OpenCPU.test(ocpuUrlInput.value);
      setOcpuStatus('ok', 'connected');
    } catch (e) {
      setOcpuStatus('err', 'unreachable');
      toast('OpenCPU not reachable: ' + e.message, 'err');
    }
  }

  // Editor

  function syncGutter() {
    var lines = editor.value.split('\n').length || 1;
    var out = '';
    for (var i = 1; i <= lines; i++) out += i + '\n';
    gutter.textContent = out;
    gutter.scrollTop = editor.scrollTop;
  }
  function currentLine() {
    var v = editor.value, pos = editor.selectionStart;
    var start = v.lastIndexOf('\n', pos - 1) + 1;
    var end = v.indexOf('\n', pos);
    if (end === -1) end = v.length;
    return v.slice(start, end);
  }
  function selectedText() {
    return editor.value.slice(editor.selectionStart, editor.selectionEnd);
  }
  function replaceSelection(text, caretOffset) {
    var s = editor.selectionStart, e = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + text + editor.value.slice(e);
    var pos = s + (caretOffset == null ? text.length : caretOffset);
    editor.selectionStart = editor.selectionEnd = pos;
    syncGutter();
  }
  var PAIRS = { '(': ')', '[': ']', '{': '}' };
  function initEditor() {
    editor.addEventListener('input', syncGutter);
    editor.addEventListener('scroll', function () { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        replaceSelection('  ');
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) runCode(editor.value);
        else runCode(selectedText() || currentLine());
        return;
      }
      // Auto indent on Enter, keeping the current line's leading spaces.
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        var line = currentLine();
        var indent = (line.match(/^\s*/) || [''])[0];
        if (/\{\s*$/.test(line)) indent += '  ';
        if (indent) { e.preventDefault(); replaceSelection('\n' + indent); }
        return;
      }
      // Auto close brackets.
      if (PAIRS[e.key] && editor.selectionStart === editor.selectionEnd) {
        e.preventDefault();
        replaceSelection(e.key + PAIRS[e.key], 1);
      }
    });
    syncGutter();
  }

  // Console, plots, busy state

  function setBusy(on) {
    $('busy').classList.toggle('hidden', !on);
    $('run-selection').disabled = on;
    $('run-all').disabled = on;
  }
  function printConsole(text, kind) {
    var span = document.createElement('span');
    if (kind) span.className = 'console-' + kind;
    span.textContent = text;
    consoleEl.appendChild(span);
    // Keep the console from growing without bound.
    if (consoleEl.textContent.length > MAX_CONSOLE) {
      while (consoleEl.firstChild && consoleEl.textContent.length > MAX_CONSOLE) {
        consoleEl.removeChild(consoleEl.firstChild);
      }
    }
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  function renderPlots(urls) {
    if (!urls.length) return;
    var hint = plotsEl.querySelector('.hint');
    if (hint) hint.remove();
    urls.forEach(function (u) {
      var wrap = document.createElement('div');
      wrap.className = 'plot-wrap';
      var img = new Image();
      img.src = u;
      img.alt = 'R plot';
      img.className = 'plot-img';
      var link = document.createElement('a');
      link.href = u; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = 'Open full size'; link.className = 'plot-link';
      wrap.appendChild(img); wrap.appendChild(link);
      plotsEl.appendChild(wrap);
    });
    plotsEl.scrollTop = plotsEl.scrollHeight;
  }

  // Build R that recreates loaded objects.
  function buildPreamble() {
    var names = Object.keys(datasets);
    if (!names.length) return '';
    var lines = ['# DHIS2 data loaded by the app'];
    names.forEach(function (name) {
      var d = datasets[name];
      var json = d.kind === 'json' ? d.json : JSON.stringify(d.rows);
      var b64 = OpenCPU.toBase64(json);
      lines.push(name + ' <- jsonlite::fromJSON(rawToChar(jsonlite::base64_dec("' + b64 + '")))');
      if (d.kind === 'table') {
        lines.push('if ("value" %in% names(' + name + ')) ' + name +
          '$value <- suppressWarnings(as.numeric(' + name + '$value))');
      }
    });
    return lines.join('\n') + '\n';
  }

  // Build R that silently re runs earlier code, so objects persist between runs.
  function buildReplay() {
    if (!$('persist-env').checked || !historyCode.length) return '';
    var b64 = OpenCPU.toBase64(historyCode.join('\n'));
    return [
      '# replay earlier code to rebuild the environment',
      '.replay_src <- rawToChar(jsonlite::base64_dec("' + b64 + '"))',
      'local({',
      '  grDevices::pdf(NULL)',
      '  on.exit(grDevices::dev.off(), add = TRUE)',
      '  invisible(utils::capture.output(suppressWarnings(suppressMessages(',
      '    eval(parse(text = .replay_src), envir = globalenv())',
      '  ))))',
      '})',
      'rm(.replay_src)',
      ''
    ].join('\n');
  }

  function hintForError(msg) {
    var m = /there is no package called ['"]([^'"]+)['"]/i.exec(msg);
    if (m) {
      return '\nHint: package "' + m[1] + '" is not installed on this OpenCPU server. ' +
        'See the Packages tab, or install it on your own server.';
    }
    if (/could not find function/i.test(msg)) {
      return '\nHint: load the package first with library(), and make sure it is installed on the server.';
    }
    return '';
  }

  // Run

  var running = false;
  async function runCode(code) {
    if (running || !code || !code.trim()) return;
    running = true;
    setBusy(true);
    printConsole('\n> running...\n', 'cmd');
    var fullScript = buildPreamble() + buildReplay() + '\n' + code + '\n';
    try {
      var result = await OpenCPU.run(ocpuUrlInput.value, fullScript);
      setOcpuStatus('ok', 'connected');
      if (result.console) printConsole(result.console);
      if (result.error) printConsole(result.error + hintForError(result.error) + '\n', 'err');
      renderPlots(result.plots);
      if (!result.console && !result.error && !result.plots.length) printConsole('(no output)\n', 'muted');
      if (!result.error) {
        if ($('persist-env').checked) historyCode.push(code);
        addHistory(code);
      }
    } catch (e) {
      setOcpuStatus('err', 'unreachable');
      printConsole('Error: ' + e.message + '\n', 'err');
      toast('Run failed: ' + e.message, 'err');
    } finally {
      running = false;
      setBusy(false);
    }
  }

  // History tab

  function addHistory(code) {
    historyAll.unshift(code);
    if (historyAll.length > 100) historyAll.pop();
    renderHistory();
  }
  function renderHistory() {
    var box = $('hist-list');
    if (!historyAll.length) {
      box.innerHTML = '<small class="hint">Code you run appears here. Click an entry to put it back in the editor.</small>';
      return;
    }
    box.innerHTML = '';
    historyAll.forEach(function (code) {
      var div = document.createElement('div');
      div.className = 'hist-item';
      div.textContent = code.length > 120 ? code.slice(0, 120) + '...' : code;
      div.title = 'Click to load into the editor';
      div.addEventListener('click', function () {
        var sep = editor.value && !/\n$/.test(editor.value) ? '\n' : '';
        editor.value += sep + code + '\n';
        syncGutter(); editor.focus();
      });
      box.appendChild(div);
    });
  }

  // DHIS2 data browser

  async function initDhis() {
    try {
      var base = await DHIS2.resolveApiBase();
      $('dhis-status').textContent = 'DHIS2: ' + base;
      var me = await DHIS2.getMe().catch(function () { return null; });
      if (me) $('dhis-status').textContent += '  ' + (me.name || me.username || '');
      await searchDataItems();
      await loadOrgRoots();
    } catch (e) {
      $('dhis-status').textContent = 'DHIS2 connection failed: ' + e.message;
      toast('DHIS2 connection failed: ' + e.message, 'err');
    }
  }

  var searchTimer = null;
  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchDataItems, 300);
  }
  async function searchDataItems() {
    var type = $('dx-type').value;
    var q = $('dx-search').value;
    $('dx-hint').textContent = 'Searching...';
    try {
      var items = await DHIS2.searchDataItems(type, q);
      var sel = $('dx-select');
      sel.innerHTML = '';
      items.forEach(function (it) {
        var o = document.createElement('option');
        o.value = it.dxId;
        o.textContent = it.name;
        sel.appendChild(o);
      });
      $('dx-hint').textContent = items.length
        ? items.length + ' shown. Refine the search to find more. Ctrl/Cmd click for multiple.'
        : 'Nothing found. Try a different search.';
    } catch (e) {
      $('dx-hint').textContent = 'Search failed: ' + e.message;
    }
  }

  // Organisation unit tree

  async function loadOrgRoots() {
    var box = $('ou-tree');
    box.innerHTML = '';
    try {
      var roots = await DHIS2.getRootOrgUnits();
      roots.forEach(function (u) { box.appendChild(makeOuNode(u)); });
      if (!roots.length) box.textContent = 'No organisation units available.';
    } catch (e) {
      box.textContent = 'Could not load org units: ' + e.message;
    }
  }
  function makeOuNode(u) {
    var node = document.createElement('div');
    node.className = 'ou-node';
    var row = document.createElement('div');
    row.className = 'ou-row';

    var toggle = document.createElement('span');
    toggle.className = 'ou-toggle';
    toggle.textContent = u.children ? '+' : '';
    var children = document.createElement('div');
    children.className = 'ou-children hidden';
    var loaded = false;
    toggle.addEventListener('click', async function () {
      if (!u.children) return;
      if (!loaded) {
        toggle.textContent = '.';
        try {
          var kids = await DHIS2.getChildOrgUnits(u.id);
          kids.forEach(function (k) { children.appendChild(makeOuNode(k)); });
          loaded = true;
        } catch (e) { toast('Could not load sub units: ' + e.message, 'err'); }
      }
      var hidden = children.classList.toggle('hidden');
      toggle.textContent = hidden ? '+' : '-';
    });

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', function () {
      if (cb.checked) selectedOu[u.id] = u.displayName;
      else delete selectedOu[u.id];
      renderOuSelected();
    });

    var label = document.createElement('span');
    label.className = 'ou-label';
    label.textContent = u.displayName;
    label.addEventListener('click', function () { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });

    row.appendChild(toggle); row.appendChild(cb); row.appendChild(label);
    node.appendChild(row); node.appendChild(children);
    return node;
  }
  function renderOuSelected() {
    var names = Object.keys(selectedOu).map(function (id) { return selectedOu[id]; });
    $('ou-selected').textContent = names.length ? 'Selected: ' + names.join(', ') : 'None selected.';
  }

  function chosenPeriods() {
    var custom = $('pe-custom').value.trim();
    return custom || $('pe-select').value;
  }

  async function fetchData() {
    var dx = Array.prototype.slice.call($('dx-select').selectedOptions).map(function (o) { return o.value; });
    var ou = Object.keys(selectedOu);
    var pe = chosenPeriods();
    var disagg = $('dx-disagg').checked;
    var varName = cleanName($('var-name').value, 'df');

    if (!dx.length) { toast('Select at least one data item.', 'err'); return; }
    if (!ou.length) { toast('Select at least one organisation unit.', 'err'); return; }

    var preview = $('data-preview');
    preview.innerHTML = '<small class="hint">Fetching from DHIS2...</small>';
    $('fetch-data').disabled = true;
    try {
      var analytics = await DHIS2.getAnalytics(dx, pe, ou.join(';'), disagg);
      var rows = DHIS2.analyticsToRows(analytics);
      var skipped = (analytics._failed || []).length;
      if (!rows.length) {
        preview.innerHTML = '<small class="hint">No data for that selection.</small>';
        if (skipped) toast('All ' + skipped + ' item(s) returned no data.', 'err');
        return;
      }
      var cols = Object.keys(rows[0]);
      datasets[varName] = { kind: 'table', rows: rows, nrow: rows.length, ncol: cols.length, cols: cols };
      renderPreview(varName, rows, cols);
      renderEnv();
      var msg = 'Loaded "' + varName + '" (' + rows.length + ' rows).';
      if (skipped) msg += ' Skipped ' + skipped + ' item(s) with no data.';
      toast(msg, 'ok');
      printConsole(msg + '\n', 'muted');
    } catch (e) {
      preview.innerHTML = '<small class="hint">Fetch failed: ' + escapeHtml(e.message) + '</small>';
      toast('Fetch failed: ' + e.message, 'err');
    } finally {
      $('fetch-data').disabled = false;
    }
  }

  async function fetchRaw() {
    var path = $('raw-path').value.trim();
    var varName = cleanName($('raw-var').value, 'meta');
    if (!path) { toast('Enter an API path.', 'err'); return; }
    $('raw-fetch').disabled = true;
    try {
      var obj = await DHIS2.rawApi(path);
      datasets[varName] = { kind: 'json', json: JSON.stringify(obj), summary: 'JSON from ' + path };
      renderEnv();
      $('data-preview').innerHTML = '<div class="preview-head">' + escapeHtml(varName) +
        '</div><pre class="json-preview">' + escapeHtml(JSON.stringify(obj, null, 2).slice(0, 4000)) + '</pre>';
      toast('Loaded JSON into "' + varName + '".', 'ok');
    } catch (e) {
      toast('Load failed: ' + e.message, 'err');
    } finally {
      $('raw-fetch').disabled = false;
    }
  }

  function renderPreview(varName, rows, cols) {
    var max = 12;
    var html = '<div class="preview-head">' + escapeHtml(varName) + ', ' +
      rows.length + ' rows by ' + cols.length + ' cols</div>';
    html += tableHtml(rows.slice(0, max), cols);
    if (rows.length > max) html += '<small class="hint">First ' + max + ' rows. Use View in Environment for all.</small>';
    $('data-preview').innerHTML = html;
  }
  function tableHtml(rows, cols) {
    var html = '<table class="data-table"><thead><tr>';
    cols.forEach(function (c) { html += '<th>' + escapeHtml(c) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr>';
      cols.forEach(function (c) { html += '<td>' + escapeHtml(String(r[c] == null ? '' : r[c])) + '</td>'; });
      html += '</tr>';
    });
    return html + '</tbody></table>';
  }

  // Environment

  function renderEnv() {
    var tbody = $('env-tbody');
    var names = Object.keys(datasets);
    if (!names.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="3">No data loaded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    names.forEach(function (n) {
      var d = datasets[n];
      var details = d.kind === 'table' ? (d.nrow + ' obs. of ' + d.ncol + ' vars') : (d.summary || 'JSON object');
      var actions = '<button class="link-btn" data-view="' + escapeHtml(n) + '">View</button>';
      if (d.kind === 'table') actions += ' <button class="link-btn" data-csv="' + escapeHtml(n) + '">CSV</button>';
      actions += ' <button class="link-btn" data-del="' + escapeHtml(n) + '">Remove</button>';
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><code>' + escapeHtml(n) + '</code></td><td>' + details + '</td><td>' + actions + '</td>';
      tbody.appendChild(tr);
    });
    bindEnvActions();
  }
  function bindEnvActions() {
    var tbody = $('env-tbody');
    tbody.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { openViewer(b.getAttribute('data-view')); });
    });
    tbody.querySelectorAll('[data-csv]').forEach(function (b) {
      b.addEventListener('click', function () {
        var n = b.getAttribute('data-csv');
        downloadCsv(n + '.csv', datasets[n].rows, datasets[n].cols);
      });
    });
    tbody.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        delete datasets[b.getAttribute('data-del')];
        renderEnv();
      });
    });
  }
  function restart() {
    datasets = {};
    historyCode = [];
    renderEnv();
    $('data-preview').innerHTML = '<small class="hint">Environment cleared.</small>';
    printConsole('R environment restarted.\n', 'muted');
    toast('R environment restarted.', 'ok');
  }

  // Data viewer

  function openViewer(name) {
    var d = datasets[name];
    if (!d) return;
    if (d.kind === 'table') {
      $('viewer-title').textContent = name + ', ' + d.nrow + ' rows by ' + d.ncol + ' cols';
      $('viewer-body').innerHTML = tableHtml(d.rows, d.cols);
      $('viewer-csv').classList.remove('hidden');
      $('viewer-csv').onclick = function () { downloadCsv(name + '.csv', d.rows, d.cols); };
    } else {
      $('viewer-title').textContent = name + ' (JSON)';
      $('viewer-body').innerHTML = '<pre class="json-preview">' +
        escapeHtml(JSON.stringify(JSON.parse(d.json), null, 2)) + '</pre>';
      $('viewer-csv').classList.add('hidden');
    }
    $('viewer').classList.remove('hidden');
  }
  function closeViewer() { $('viewer').classList.add('hidden'); }

  // Packages

  async function loadPackages() {
    $('pkg-hint').textContent = 'Loading...';
    try {
      allPackages = await OpenCPU.listPackages(ocpuUrlInput.value);
      renderPackages();
    } catch (e) {
      $('pkg-hint').textContent = 'Could not load packages: ' + e.message;
      $('pkg-list').innerHTML = '';
    }
  }
  function renderPackages() {
    var f = $('pkg-filter').value.trim().toLowerCase();
    var list = allPackages.filter(function (p) { return !f || p.toLowerCase().indexOf(f) !== -1; });
    $('pkg-hint').textContent = allPackages.length + ' installed, ' + list.length + ' shown.';
    $('pkg-list').innerHTML = list.map(function (p) {
      return '<span class="pkg-item">' + escapeHtml(p) + '</span>';
    }).join('');
  }
  async function installPackage() {
    var name = $('pkg-install-name').value.trim();
    if (!name) { toast('Enter a package name.', 'err'); return; }
    $('pkg-install').disabled = true;
    printConsole('Installing "' + name + '"...\n', 'muted');
    try {
      await OpenCPU.installPackage(ocpuUrlInput.value, name);
      toast('Installed "' + name + '".', 'ok');
      await loadPackages();
    } catch (e) {
      printConsole('Install failed: ' + e.message + '\n', 'err');
      toast('Install failed. The server may be read only.', 'err');
    } finally {
      $('pkg-install').disabled = false;
    }
  }

  // Examples

  var EXAMPLES = {
    summary: 'summary(df)\nstr(df)',
    aggregate: 'aggregate(value ~ period, data = df, FUN = sum)',
    trend: 'agg <- aggregate(value ~ period, data = df, FUN = sum)\nplot(factor(agg$period), agg$value, type = "b", xlab = "period", ylab = "value", main = "Trend")',
    hist: 'hist(df$value, col = "steelblue", main = "Distribution of values", xlab = "value")',
    bar: 'agg <- aggregate(value ~ period, data = df, FUN = sum)\nbarplot(agg$value, names.arg = agg$period, las = 2, col = "steelblue", main = "Total by period")',
    lm: 'df$t <- as.numeric(factor(df$period))\nmodel <- lm(value ~ t, data = df)\nsummary(model)',
    forecast: '# needs the forecast package on the server\nlibrary(forecast)\nagg <- aggregate(value ~ period, data = df, FUN = sum)\nts_data <- ts(agg$value, frequency = 12)\nfit <- auto.arima(ts_data)\nf <- forecast(fit, h = 6)\nprint(f)\nplot(f)',
    outlier: 'v <- df$value\nb <- boxplot.stats(v)\ncat("Outliers:\\n")\nprint(b$out)\nboxplot(v, main = "Values with outliers", col = "steelblue")',
    cor: 'num <- df[sapply(df, is.numeric)]\nif (ncol(num) >= 2) print(cor(num, use = "complete.obs")) else cat("Need at least two numeric columns.\\n")'
  };
  function insertExample(key) {
    var s = EXAMPLES[key];
    if (!s) return;
    var sep = editor.value && !/\n$/.test(editor.value) ? '\n' : '';
    editor.value += sep + s + '\n';
    syncGutter(); editor.focus();
  }

  // Script save and open

  function saveScript() {
    downloadText('analysis.R', editor.value || '', 'text/plain');
  }
  function openScript(file) {
    var reader = new FileReader();
    reader.onload = function () {
      editor.value = String(reader.result || '');
      syncGutter();
      toast('Loaded ' + file.name, 'ok');
    };
    reader.readAsText(file);
  }

  // Helpers

  function cleanName(v, fallback) {
    var n = (v || '').trim().replace(/[^A-Za-z0-9_.]/g, '_');
    return n || fallback;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rowsToCsv(rows, cols) {
    function cell(v) {
      var s = v == null ? '' : String(v);
      if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    var out = cols.map(cell).join(',') + '\n';
    rows.forEach(function (r) { out += cols.map(function (c) { return cell(r[c]); }).join(',') + '\n'; });
    return out;
  }
  function downloadText(filename, text, type) {
    var blob = new Blob([text], { type: type || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function downloadCsv(filename, rows, cols) {
    downloadText(filename, rowsToCsv(rows, cols), 'text/csv');
  }
  function toast(message, kind) {
    var box = $('toasts');
    var t = document.createElement('div');
    t.className = 'toast toast--' + (kind || 'ok');
    t.textContent = message;
    box.appendChild(t);
    setTimeout(function () { t.classList.add('toast--out'); }, 4000);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4500);
  }

  // Tabs

  function initTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('tab--active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('tab-panel--active'); });
        tab.classList.add('tab--active');
        $('tab-' + tab.dataset.tab).classList.add('tab-panel--active');
        if (tab.dataset.tab === 'pkg' && !allPackages.length) loadPackages();
      });
    });
  }

  // Resizable splitters

  function initSplitters() {
    var grid = $('grid');
    var col = localStorage.getItem(LS_COL);
    var row = localStorage.getItem(LS_ROW);
    if (col) grid.style.setProperty('--c1', col);
    if (row) grid.style.setProperty('--r1', row);

    dragSplitter($('split-col'), function (e, rect) {
      var w = Math.min(Math.max(e.clientX - rect.left, 220), rect.width - 220);
      grid.style.setProperty('--c1', w + 'px');
      localStorage.setItem(LS_COL, w + 'px');
    });
    dragSplitter($('split-row'), function (e, rect) {
      var h = Math.min(Math.max(e.clientY - rect.top, 120), rect.height - 120);
      grid.style.setProperty('--r1', h + 'px');
      localStorage.setItem(LS_ROW, h + 'px');
    });
  }
  function dragSplitter(handle, onMove) {
    var grid = $('grid');
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      var rect = grid.getBoundingClientRect();
      function move(ev) { onMove(ev, rect); }
      function up(ev) {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  // Boot

  function init() {
    editor = $('editor');
    gutter = $('gutter');
    consoleEl = $('console');
    plotsEl = $('plots');
    ocpuUrlInput = $('ocpu-url');
    ocpuStatus = $('ocpu-status');

    applyTheme(localStorage.getItem(LS_THEME) || 'light');
    initOcpuUrl();
    initEditor();
    initTabs();
    initSplitters();

    $('theme-toggle').addEventListener('click', toggleTheme);
    $('ocpu-test').addEventListener('click', testOcpu);
    $('run-selection').addEventListener('click', function () { runCode(selectedText() || currentLine()); });
    $('run-all').addEventListener('click', function () { runCode(editor.value); });
    $('restart').addEventListener('click', restart);
    $('save-script').addEventListener('click', saveScript);
    $('open-script').addEventListener('click', function () { $('open-file').click(); });
    $('open-file').addEventListener('change', function () { if (this.files[0]) openScript(this.files[0]); this.value = ''; });
    $('examples').addEventListener('change', function () { insertExample(this.value); this.value = ''; });

    $('clear-console').addEventListener('click', function () { consoleEl.innerHTML = ''; });
    $('download-console').addEventListener('click', function () { downloadText('console.txt', consoleEl.textContent || ''); });
    $('clear-plots').addEventListener('click', function () {
      plotsEl.innerHTML = '<small class="hint">Plots from your R code appear here.</small>';
    });

    $('dx-type').addEventListener('change', searchDataItems);
    $('dx-search').addEventListener('input', scheduleSearch);
    $('fetch-data').addEventListener('click', fetchData);
    $('raw-fetch').addEventListener('click', fetchRaw);

    $('pkg-filter').addEventListener('input', renderPackages);
    $('pkg-install').addEventListener('click', installPackage);
    $('clear-hist').addEventListener('click', function () { historyAll = []; renderHistory(); });

    $('viewer-close').addEventListener('click', closeViewer);
    $('viewer').addEventListener('click', function (e) { if (e.target === $('viewer')) closeViewer(); });

    printConsole('Ready. Load DHIS2 data, write R, press Run.\n', 'muted');
    initDhis();
    testOcpu();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();