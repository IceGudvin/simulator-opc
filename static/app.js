let defaultsLoaded = false;
const expandedGroups = new Set();
let refreshTimer = null;
let refreshInFlight = false;
let lastRefreshError = '';

function byId(id) { return document.getElementById(id); }
function val(id) { return byId(id).value; }

function escapeHtml(value) {
  return String(value ?? '')
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
  return await r.json();
}

async function apiPost(url, body = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(data.detail || data.message || `HTTP ${r.status}`);
  return data;
}

function cls(row) {
  const code = `${row?.state || ''} ${row?.manual_alarm || ''}`.toLowerCase();
  if (code.includes('crit')) return 'crit';
  if (code.includes('warn')) return 'warn';
  return '';
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function formatMode(mode) {
  if (mode === 'y') return 'Случайный';
  if (mode === 'n') return 'Плавный';
  return formatValue(mode);
}

function toggleGroup(idx) {
  const key = String(idx);
  if (expandedGroups.has(key)) {
    expandedGroups.delete(key);
  } else {
    expandedGroups.add(key);
  }
  renderGroups(window.__lastGroups || []);
}

function renderGroups(groups) {
  const tbody = byId('rows');
  if (!tbody) return;
  const safeGroups = Array.isArray(groups) ? groups : [];
  if (!safeGroups.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Нет данных</td></tr>`;
    return;
  }
  const rows = [];
  safeGroups.forEach((row, i) => {
    const rowCls = cls(row);
    const isExpanded = expandedGroups.has(String(i));
    const hasEntities = Array.isArray(row.entities) && row.entities.length > 0;
    rows.push(`
      <tr class="group-row ${rowCls}">
        <td>${i + 1}</td>
        <td>
          <button
            class="expand-btn"
            type="button"
            onclick="toggleGroup(${i})"
            aria-expanded="${isExpanded}"
            aria-label="${isExpanded ? 'Свернуть' : 'Раскрыть'} группу ${escapeHtml(row.name)}"
            ${!hasEntities ? 'disabled' : ''}
          >${isExpanded ? '&#9650;' : '&#9660;'}</button>
          <span class="cell-title">${escapeHtml(row.name)}</span>
          <div class="cell-subtitle">${escapeHtml(row.path)}</div>
        </td>
        <td>${formatValue(row.value)}</td>
        <td>${escapeHtml(row.state)}</td>
        <td>${escapeHtml(row.manual_alarm)}</td>
        <td>${formatValue(row.remaining)}</td>
        <td>${escapeHtml(formatMode(row.mode))} / ${formatValue(row.entity_count)} тегов</td>
      </tr>
    `);
    if (isExpanded && hasEntities) {
      const entitiesHtml = row.entities.map((e, ei) => `
        <tr class="duplicate-row">
          <td>${ei + 1}</td>
          <td>${escapeHtml(e.tag_name)}</td>
          <td>${escapeHtml(e.suffix)}</td>
          <td>${formatValue(e.value)}</td>
          <td colspan="2">${escapeHtml(e.nodeid)}</td>
        </tr>
      `).join('');
      rows.push(`
        <tr class="group-details-row ${rowCls}">
          <td colspan="7">
            <div class="group-details-wrap">
              <div class="group-details-title">Теги группы: ${escapeHtml(row.name)}</div>
              <table class="nested-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Имя тега</th>
                    <th>Суффикс</th>
                    <th>Значение</th>
                    <th colspan="2">Node ID</th>
                  </tr>
                </thead>
                <tbody>${entitiesHtml}</tbody>
              </table>
            </div>
          </td>
        </tr>
      `);
    }
  });
  tbody.innerHTML = rows.join('');
}

function applyStatus(data) {
  const statusEl = byId('status');
  const summaryEl = byId('summary');
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
  if (summaryEl) {
    summaryEl.textContent =
      `Групп: ${data.total ?? 0} | Сущностей: ${data.total_entities ?? 0} | Активных сущностей: ${data.active_entities ?? 0}`;
  }
  const logsEl = byId('logs');
  if (logsEl && Array.isArray(data.logs)) {
    const logs = data.logs;
    const atBottom = logsEl.scrollHeight - logsEl.scrollTop <= logsEl.clientHeight + 40;
    logsEl.textContent = logs.join('\n');
    if (atBottom) logsEl.scrollTop = logsEl.scrollHeight;
  }
  if (!defaultsLoaded && data.params) {
    const p = data.params;
    const serverUrlEl = byId('server_url');
    if (serverUrlEl && !serverUrlEl.value) serverUrlEl.value = p.server_url ?? '';
    const lowEl = byId('low');
    if (lowEl && !lowEl.value) lowEl.value = p.low ?? '';
    const highEl = byId('high');
    if (highEl && !highEl.value) highEl.value = p.high ?? '';
    const intervalEl = byId('interval');
    if (intervalEl && !intervalEl.value) intervalEl.value = p.interval ?? '';
    const upperEl = byId('upper_shift_time');
    if (upperEl && !upperEl.value) upperEl.value = p.upper_shift_time ?? '';
    const lowerEl = byId('lower_shift_time');
    if (lowerEl && !lowerEl.value) lowerEl.value = p.lower_shift_time ?? '';
    const modeEl = byId('random_mode');
    if (modeEl) modeEl.value = p.random_mode ?? 'y';
    defaultsLoaded = true;
  }
  window.__lastGroups = data.groups || [];
  renderGroups(window.__lastGroups);
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const data = await apiGet('/api/status');
    lastRefreshError = '';
    applyStatus(data);
  } catch (e) {
    lastRefreshError = e.message;
  } finally {
    refreshInFlight = false;
  }
}

function startRefresh() {
  if (refreshTimer) return;
  refresh();
  refreshTimer = setInterval(refresh, 2000);
}

document.addEventListener('DOMContentLoaded', () => {
  startRefresh();

  byId('btn-connect')?.addEventListener('click', async () => {
    clearMessage();
    try {
      const body = {
        server_url: val('server_url'),
        low: parseFloat(val('low')),
        high: parseFloat(val('high')),
        interval: parseFloat(val('interval')),
        upper_shift_time: parseFloat(val('upper_shift_time')),
        lower_shift_time: parseFloat(val('lower_shift_time')),
        random_mode: val('random_mode'),
      };
      const data = await apiPost('/api/connect', body);
      showMessage(data.message || 'Запуск отправлен');
    } catch (e) {
      showMessage(e.message, 'error');
    }
  });

  byId('btn-disconnect')?.addEventListener('click', async () => {
    clearMessage();
    try {
      const data = await apiPost('/api/disconnect');
      showMessage(data.message || 'Остановка запрошена');
    } catch (e) {
      showMessage(e.message, 'error');
    }
  });

  byId('btn-apply-settings')?.addEventListener('click', async () => {
    clearMessage();
    try {
      const body = {
        interval: parseFloat(val('interval')),
        upper_shift_time: parseFloat(val('upper_shift_time')),
        lower_shift_time: parseFloat(val('lower_shift_time')),
        random_mode: val('random_mode'),
      };
      const data = await apiPost('/api/settings', body);
      showMessage(data.message || 'Параметры обновлены');
    } catch (e) {
      showMessage(e.message, 'error');
    }
  });

  byId('btn-warn')?.addEventListener('click', async () => {
    clearMessage();
    try {
      const data = await apiPost('/api/group', {
        count: parseInt(val('group_count'), 10),
        mode: 'warn',
        duration: parseFloat(val('group_duration')),
      });
      showMessage(data.message || 'Группа warn запущена');
    } catch (e) {
      showMessage(e.message, 'error');
    }
  });

  byId('btn-crit')?.addEventListener('click', async () => {
    clearMessage();
    try {
      const data = await apiPost('/api/group', {
        count: parseInt(val('group_count'), 10),
        mode: 'crit',
        duration: parseFloat(val('group_duration')),
      });
      showMessage(data.message || 'Группа crit запущена');
    } catch (e) {
      showMessage(e.message, 'error');
    }
  });

  byId('btn-mixed')?.addEventListener('click', async () => {
    clearMessage();
    try {
      const data = await apiPost('/api/group', {
        count: parseInt(val('group_count'), 10),
        mode: 'mixed',
        duration: parseFloat(val('group_duration')),
      });
      showMessage(data.message || 'Смешанная группа запущена');
    } catch (e) {
      showMessage(e.message, 'error');
    }
  });

  byId('btn-clear-alarms')?.addEventListener('click', async () => {
    clearMessage();
    try {
      const data = await apiPost('/api/alarms/clear');
      showMessage(data.message || 'Алармы сняты');
    } catch (e) {
      showMessage(e.message, 'error');
    }
  });
});
