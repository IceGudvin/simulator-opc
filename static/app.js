const STORAGE_KEY = 'opcua_sim_params';
let defaultsLoaded = false;
let ws = null;
let wsReconnectTimer = null;
const groupExpanded = {};
// Храним предыдущие значения для flash: idx -> value
const prevValues = {};
let lastRows = [];
let searchQuery = '';

function byId(id) { return document.getElementById(id); }
function val(id) { return byId(id).value; }

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showMessage(text, type = 'ok') {
  const box = byId('ui-message');
  if (!box) return;
  box.textContent = text;
  box.classList.remove('hidden', 'ok', 'error');
  box.classList.add(type === 'error' ? 'error' : 'ok');
}
function clearMessage() {
  const box = byId('ui-message');
  if (!box) return;
  box.textContent = '';
  box.classList.add('hidden');
  box.classList.remove('ok', 'error');
}

async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function apiPost(url, body = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.detail || data.message || `HTTP ${r.status}`);
  return data;
}

// ── localStorage ───────────────────────────────────────────────────────
const FIELDS = ['server_url','low','high','interval','upper_shift_time','lower_shift_time','random_mode'];
function saveParams() {
  const obj = {};
  FIELDS.forEach(f => { const el = byId(f); if (el) obj[f] = el.value; });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch(_) {}
}
function loadParamsFromStorage() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch(_) { return null; }
}

// ── rows ───────────────────────────────────────────────────────────────
function rowClass(row) {
  const code = `${row?.state || ''} ${row?.manual_alarm || ''}`.toLowerCase();
  if (code.includes('crit')) return 'crit';
  if (code.includes('warn')) return 'warn';
  return '';
}

function groupRows(rows) {
  const map = {};
  rows.forEach(row => {
    const parts = (row.path || '').split('/');
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : (row.path || 'Прочее');
    if (!map[parent]) map[parent] = [];
    map[parent].push(row);
  });
  return map;
}

function filterRows(rows) {
  if (!searchQuery) return rows;
  const q = searchQuery.toLowerCase();
  return rows.filter(r =>
    (r.name || '').toLowerCase().includes(q) ||
    (r.path || '').toLowerCase().includes(q)
  );
}

function renderRows(rows) {
  const tbody = byId('rows');
  if (!tbody) return;

  const filtered = filterRows(rows);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">${searchQuery ? 'Ничего не найдено по запросу «' + escapeHtml(searchQuery) + '»' : 'Нет данных'}</td></tr>`;
    return;
  }

  const grouped = groupRows(filtered);
  const keys = Object.keys(grouped).sort();
  let html = '';

  keys.forEach(parent => {
    const items = grouped[parent];
    const isOpen = groupExpanded[parent] === true;
    const hasCrit = items.some(r => rowClass(r) === 'crit');
    const hasWarn = !hasCrit && items.some(r => rowClass(r) === 'warn');
    const groupCls = hasCrit ? 'crit' : hasWarn ? 'warn' : '';
    const activeCount = items.filter(r => r.manual_alarm && r.manual_alarm !== '-').length;
    const badge = activeCount > 0 ? `<span class="group-badge">${activeCount} alarm</span>` : '';
    const folderIcon = `<svg class="folder-icon" viewBox="0 0 16 16" fill="none"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.879a1.5 1.5 0 0 1 1.06.44L8.5 4.5H12.5A1.5 1.5 0 0 1 14 6v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V4.5z" fill="currentColor" opacity=".18"/><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.879a1.5 1.5 0 0 1 1.06.44L8.5 4.5H12.5A1.5 1.5 0 0 1 14 6v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V4.5z" stroke="currentColor" stroke-width="1.2"/></svg>`;

    html += `
      <tr class="group-header ${groupCls}" data-group="${escapeHtml(parent)}">
        <td colspan="6" class="group-cell">
          <span class="group-arrow">${isOpen ? '&#9660;' : '&#9658;'}</span>
          ${folderIcon}
          <span class="group-name">${escapeHtml(parent)}</span>
          <span class="group-count">${items.length}</span>
          ${badge}
        </td>
      </tr>`;

    if (isOpen) {
      items.forEach((row, i) => {
        const cls = rowClass(row);
        const changed = prevValues[row.idx] !== undefined && prevValues[row.idx] !== row.value;
        const flashAttr = changed ? ' data-flash="1"' : '';
        html += `
          <tr class="sensor-row ${cls}" data-idx="${row.idx}"${flashAttr}>
            <td class="num-cell">${i + 1}</td>
            <td class="name-cell"><span class="cell-title">${escapeHtml(row.name)}</span></td>
            <td class="val-cell" data-idx="${row.idx}">${row.value ?? '-'}</td>
            <td class="state-cell">${escapeHtml(row.state)}</td>
            <td class="alarm-cell">${row.manual_alarm !== '-' ? escapeHtml(row.manual_alarm) : '-'}</td>
            <td class="remain-cell">${row.remaining > 0 ? row.remaining + ' с' : '-'}</td>
          </tr>`;
        prevValues[row.idx] = row.value;
      });
    }
  });

  tbody.innerHTML = html;

  // Flash-эффект на изменившиеся ячейки
  tbody.querySelectorAll('[data-flash="1"] .val-cell').forEach(td => {
    td.classList.add('val-flash');
    setTimeout(() => td.classList.remove('val-flash'), 800);
  });

  tbody.querySelectorAll('.group-header').forEach(tr => {
    tr.addEventListener('click', () => {
      const key = tr.dataset.group;
      groupExpanded[key] = !groupExpanded[key];
      renderRows(lastRows);
    });
  });
}

// ── WebSocket ────────────────────────────────────────────────────────
const wsStatusEl = () => byId('ws-status');

function setWsStatus(state) {
  const el = wsStatusEl();
  if (!el) return;
  const map = {
    connecting: ['• WS: подключение...', 'ws-connecting'],
    open:       ['• WS: поток', 'ws-open'],
    closed:     ['• WS: отключен', 'ws-closed'],
  };
  const [text, cls] = map[state] || map.closed;
  el.textContent = text;
  el.className = 'ws-badge ' + cls;
}

function applyData(data) {
  // Статус подключения
  const statusEl = byId('status');
  if (statusEl) {
    if (data.connecting) {
      statusEl.textContent = 'Подключение...';
      statusEl.className = 'badge badge-connecting';
    } else if (data.connected) {
      statusEl.textContent = 'Подключено';
      statusEl.className = 'badge badge-ok';
    } else {
      statusEl.textContent = 'Отключено';
      statusEl.className = 'badge badge-off';
    }
  }

  const summaryEl = byId('summary');
  if (summaryEl) {
    const alarmCls = (data.active || 0) > 0 ? 'summary-alarm' : '';
    summaryEl.innerHTML = `Датчиков: <strong>${data.total ?? 0}</strong> &nbsp;|  Алармов: <strong class="${alarmCls}">${data.active ?? 0}</strong>`;
  }

  const logsEl = byId('logs');
  if (logsEl && Array.isArray(data.logs)) {
    const atBottom = logsEl.scrollHeight - logsEl.scrollTop <= logsEl.clientHeight + 40;
    logsEl.textContent = data.logs.join('\n');
    if (atBottom) logsEl.scrollTop = logsEl.scrollHeight;
  }

  if (!defaultsLoaded && data.params) {
    const p = data.params;
    const fill = (id, v) => { const el = byId(id); if (el && !el.value) el.value = v ?? ''; };
    fill('server_url', p.server_url); fill('low', p.low); fill('high', p.high);
    fill('interval', p.interval); fill('upper_shift_time', p.upper_shift_time);
    fill('lower_shift_time', p.lower_shift_time);
    const modeEl = byId('random_mode');
    if (modeEl) modeEl.value = p.random_mode ?? 'y';
    defaultsLoaded = true;
    saveParams();
  }

  lastRows = Array.isArray(data.rows) ? data.rows : [];
  renderRows(lastRows);
}

function connectWs() {
  if (ws && ws.readyState <= 1) return;
  setWsStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    setWsStatus('open');
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  };

  ws.onmessage = (e) => {
    try { applyData(JSON.parse(e.data)); } catch(_) {}
  };

  ws.onclose = () => {
    setWsStatus('closed');
    wsReconnectTimer = setTimeout(connectWs, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function on(id, fn) {
  byId(id)?.addEventListener('click', async () => {
    clearMessage();
    try { const d = await fn(); showMessage(d.message || 'OK'); }
    catch (e) { showMessage(e.message, 'error'); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const saved = loadParamsFromStorage();
  if (saved) {
    FIELDS.forEach(f => { const el = byId(f); if (el && saved[f] != null) el.value = saved[f]; });
    defaultsLoaded = true;
  }
  FIELDS.forEach(f => { const el = byId(f); if (el) el.addEventListener('change', saveParams); });

  // Поиск
  const searchEl = byId('sensor-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      searchQuery = searchEl.value.trim();
      renderRows(lastRows);
    });
    byId('search-clear')?.addEventListener('click', () => {
      searchEl.value = '';
      searchQuery = '';
      searchEl.focus();
      renderRows(lastRows);
    });
  }

  connectWs();

  on('btn-connect', () => { saveParams(); return apiPost('/api/connect', {
    server_url: val('server_url'), low: parseFloat(val('low')), high: parseFloat(val('high')),
    interval: parseFloat(val('interval')), upper_shift_time: parseFloat(val('upper_shift_time')),
    lower_shift_time: parseFloat(val('lower_shift_time')), random_mode: val('random_mode'),
  }); });
  on('btn-disconnect', () => apiPost('/api/disconnect'));
  on('btn-apply-settings', () => { saveParams(); return apiPost('/api/settings', {
    interval: parseFloat(val('interval')), upper_shift_time: parseFloat(val('upper_shift_time')),
    lower_shift_time: parseFloat(val('lower_shift_time')), random_mode: val('random_mode'),
  }); });
  on('btn-warn',  () => apiPost('/api/group', { count: parseInt(val('group_count'), 10), mode: 'warn',  duration: parseFloat(val('group_duration')) }));
  on('btn-crit',  () => apiPost('/api/group', { count: parseInt(val('group_count'), 10), mode: 'crit',  duration: parseFloat(val('group_duration')) }));
  on('btn-mixed', () => apiPost('/api/group', { count: parseInt(val('group_count'), 10), mode: 'mixed', duration: parseFloat(val('group_duration')) }));
  on('btn-clear-alarms', () => apiPost('/api/alarms/clear'));
});
