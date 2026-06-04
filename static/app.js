let defaultsLoaded = false;
let refreshTimer = null;
let refreshInFlight = false;

function byId(id) { return document.getElementById(id); }
function val(id) { return byId(id).value; }

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.detail || data.message || `HTTP ${r.status}`);
  return data;
}

function rowClass(row) {
  const code = `${row?.state || ''} ${row?.manual_alarm || ''}`.toLowerCase();
  if (code.includes('crit')) return 'crit';
  if (code.includes('warn')) return 'warn';
  return '';
}

function formatMode(mode) {
  if (mode === 'y') return 'Случайный';
  if (mode === 'n') return 'Плавный';
  return String(mode ?? '-');
}

function renderRows(rows) {
  const tbody = byId('rows');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Нет данных</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((row, i) => `
    <tr class="${rowClass(row)}">
      <td>${i + 1}</td>
      <td>
        <span class="cell-title">${escapeHtml(row.name)}</span>
        <div class="cell-subtitle">${escapeHtml(row.path)}</div>
      </td>
      <td class="val">${row.value ?? '-'}</td>
      <td>${escapeHtml(row.state)}</td>
      <td>${row.manual_alarm !== '-' ? escapeHtml(row.manual_alarm) : '-'}</td>
      <td>${row.remaining > 0 ? row.remaining + ' с' : '-'}</td>
    </tr>
  `).join('');
}

function applyStatus(data) {
  const statusEl = byId('status');
  if (statusEl) {
    if (data.connecting) {
      statusEl.textContent = 'Подключение...';
      statusEl.style.background = '#fff4db';
    } else if (data.connected) {
      statusEl.textContent = 'Подключено';
      statusEl.style.background = 'var(--ok)';
    } else {
      statusEl.textContent = 'Отключено';
      statusEl.style.background = '#eef3f8';
    }
  }

  const summaryEl = byId('summary');
  if (summaryEl) {
    summaryEl.textContent =
      `Датчиков: ${data.total ?? 0} | Активных алармов: ${data.active ?? 0}`;
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
    fill('server_url', p.server_url);
    fill('low', p.low);
    fill('high', p.high);
    fill('interval', p.interval);
    fill('upper_shift_time', p.upper_shift_time);
    fill('lower_shift_time', p.lower_shift_time);
    const modeEl = byId('random_mode');
    if (modeEl) modeEl.value = p.random_mode ?? 'y';
    defaultsLoaded = true;
  }

  renderRows(Array.isArray(data.rows) ? data.rows : []);
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const data = await apiGet('/api/status');
    applyStatus(data);
  } catch (_) {
  } finally {
    refreshInFlight = false;
  }
}

function startRefresh() {
  if (refreshTimer) return;
  refresh();
  refreshTimer = setInterval(refresh, 2000);
}

function on(id, fn) {
  byId(id)?.addEventListener('click', async () => {
    clearMessage();
    try { const d = await fn(); showMessage(d.message || 'OK'); }
    catch (e) { showMessage(e.message, 'error'); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  startRefresh();

  on('btn-connect', () => apiPost('/api/connect', {
    server_url:       val('server_url'),
    low:              parseFloat(val('low')),
    high:             parseFloat(val('high')),
    interval:         parseFloat(val('interval')),
    upper_shift_time: parseFloat(val('upper_shift_time')),
    lower_shift_time: parseFloat(val('lower_shift_time')),
    random_mode:      val('random_mode'),
  }));

  on('btn-disconnect', () => apiPost('/api/disconnect'));

  on('btn-apply-settings', () => apiPost('/api/settings', {
    interval:         parseFloat(val('interval')),
    upper_shift_time: parseFloat(val('upper_shift_time')),
    lower_shift_time: parseFloat(val('lower_shift_time')),
    random_mode:      val('random_mode'),
  }));

  on('btn-warn',  () => apiPost('/api/group', { count: parseInt(val('group_count'), 10), mode: 'warn',  duration: parseFloat(val('group_duration')) }));
  on('btn-crit',  () => apiPost('/api/group', { count: parseInt(val('group_count'), 10), mode: 'crit',  duration: parseFloat(val('group_duration')) }));
  on('btn-mixed', () => apiPost('/api/group', { count: parseInt(val('group_count'), 10), mode: 'mixed', duration: parseFloat(val('group_duration')) }));

  on('btn-clear-alarms', () => apiPost('/api/alarms/clear'));
});
