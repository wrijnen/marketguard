import { BADGES, computeSnapshot, dataFileName, sliceRange } from './indicators.js';

const STATUS_META = {
  safe: { label: 'Safe', cls: 'status-safe' },
  watch: { label: 'Watch', cls: 'status-watch' },
  near: { label: 'Near stop', cls: 'status-near' },
  breached: { label: 'Breached', cls: 'status-breached' },
  unknown: { label: 'n/a', cls: 'status-unknown' },
};

const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', GBp: 'p', CHF: 'CHF ', CAD: 'C$', SEK: 'kr', DKK: 'kr' };

const LS_SETTINGS = 'sla_settings_overrides';
const LS_ALERTS = 'sla_alerts';
const LS_LOG = 'sla_alerts_log';

const state = {
  mode: 'server',
  settings: null,
  scan: [],
  alerts: [],
  log: [],
  sentiment: null,
  filters: new Set(),
  detail: null,
  detailRange: '1y',
  notified: new Set(),
  demo: false,
  histCache: new Map(),
  indexCache: null,
  baseSettingsCache: null,
  lastGen: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadLS(key, dflt) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? dflt;
  } catch {
    return dflt;
  }
}
function saveLS(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

async function detectMode() {
  try {
    const r = await fetch('api/health', { signal: AbortSignal.timeout(2500) });
    if (r.ok) return 'server';
  } catch {
    /* fall through to static */
  }
  return 'static';
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function indexCache() {
  if (!state.indexCache) state.indexCache = await fetchJson('data/index.json');
  return state.indexCache;
}

async function baseSettings() {
  if (!state.baseSettingsCache) state.baseSettingsCache = await fetchJson('data/settings.json');
  return state.baseSettingsCache;
}

function mergedSettings() {
  return { ...(state.baseSettingsCache || {}), ...loadLS(LS_SETTINGS, {}) };
}

async function historyOf(sym) {
  if (!state.histCache.has(sym)) {
    state.histCache.set(sym, await fetchJson(`data/history/${dataFileName(sym)}.json`));
  }
  return state.histCache.get(sym);
}

async function staticScan() {
  const idx = await indexCache();
  const settings = mergedSettings();
  const rows = [];
  await Promise.all(
    idx.symbols.map(async (sym) => {
      try {
        const hj = await historyOf(sym);
        const snap = computeSnapshot(hj.rows, { ...settings, symbol: sym });
        if (!snap) throw new Error('empty history');
        const closes = hj.rows.map((r) => r.c);
        const last = closes[closes.length - 1];
        const prev = closes[closes.length - 2];
        rows.push({
          symbol: sym,
          meta: hj.meta,
          quote: {
            symbol: sym,
            price: last,
            prevClose: prev ?? last,
            changePct: prev ? ((last - prev) / prev) * 100 : 0,
            time: new Date(hj.rows[hj.rows.length - 1].t).toISOString(),
            currency: hj.meta?.currency,
            name: hj.meta?.name,
          },
          snapshot: { ...snap, spark: closes.slice(-60) },
        });
      } catch (e) {
        rows.push({ symbol: sym, error: e.message });
      }
    })
  );
  rows.sort((a, b) => {
    const da = a.snapshot?.dist;
    const db = b.snapshot?.dist;
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  });
  return { settings, generatedAt: idx.generatedAt, rows };
}

function staticAlertAdd(body) {
  const sym = String(body.symbol || '').trim().toUpperCase();
  if (!sym) throw new Error('symbol is required');
  if (!['below', 'above', 'near_stop', 'stop_breach'].includes(body.type)) throw new Error('invalid type');
  let val = null;
  if (body.type !== 'stop_breach') {
    val = Number(body.value);
    if (!Number.isFinite(val)) throw new Error('value must be a number');
  }
  const alert = {
    id: crypto.randomUUID(),
    symbol: sym,
    type: body.type,
    value: val,
    note: String(body.note || ''),
    active: true,
    state: 'clear',
    acknowledged: false,
    createdAt: new Date().toISOString(),
    triggeredAt: null,
  };
  const list = loadLS(LS_ALERTS, []);
  list.unshift(alert);
  saveLS(LS_ALERTS, list);
  return alert;
}

async function staticEvaluate() {
  const scan = await staticScan();
  const bySym = new Map(scan.rows.filter((r) => r.snapshot).map((r) => [r.symbol, r]));
  const alerts = loadLS(LS_ALERTS, []);
  const log = loadLS(LS_LOG, []);
  const fired = [];
  let changed = false;
  for (const a of alerts) {
    if (!a.active) continue;
    const row = bySym.get(a.symbol);
    const price = row?.quote?.price;
    if (price == null) continue;
    const s = row.snapshot;
    let cond = false;
    let msg = '';
    if (a.type === 'below') {
      cond = price <= a.value;
      msg = `${a.symbol} at ${price} dropped below ${a.value}`;
    } else if (a.type === 'above') {
      cond = price >= a.value;
      msg = `${a.symbol} at ${price} rose above ${a.value}`;
    } else if (a.type === 'stop_breach') {
      cond = s.stop != null && price <= s.stop;
      msg = `${a.symbol} stop-loss breached, ${price} at or below stop ${s.stop}`;
    } else if (a.type === 'near_stop') {
      cond = s.dist != null && s.dist <= a.value;
      msg = `${a.symbol} within ${a.value}% of stop-loss, distance ${s.dist?.toFixed(2)}% against stop ${s.stop}`;
    }
    if (cond && a.state !== 'triggered') {
      a.state = 'triggered';
      a.triggeredAt = new Date().toISOString();
      a.acknowledged = false;
      changed = true;
      const entry = { id: crypto.randomUUID(), alertId: a.id, symbol: a.symbol, type: a.type, message: msg, price, ts: new Date().toISOString() };
      log.unshift(entry);
      if (log.length > 200) log.length = 200;
      fired.push({ alert: a, entry });
    } else if (!cond && a.state === 'triggered') {
      a.state = 'clear';
      a.triggeredAt = null;
      changed = true;
    }
  }
  if (changed || fired.length) {
    saveLS(LS_ALERTS, alerts);
    saveLS(LS_LOG, log);
  }
  return fired;
}

async function staticApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (path === 'api/health') return { ok: true, demo: (await indexCache()).demo, static: true, time: new Date().toISOString() };
  if (path === 'api/settings' && method === 'GET') return mergedSettings();
  if (path === 'api/settings' && method === 'PUT') {
    saveLS(LS_SETTINGS, { ...loadLS(LS_SETTINGS, {}), ...body });
    return mergedSettings();
  }
  if (path === 'api/scan' && method === 'GET') return staticScan();
  const h = path.match(/^api\/history\/([^?]+)/);
  if (h && method === 'GET') {
    const sym = decodeURIComponent(h[1]);
    const range = new URLSearchParams(path.split('?')[1] || '').get('range') || '1y';
    const hj = await historyOf(sym);
    return { symbol: sym, meta: hj.meta, range, rows: sliceRange(hj.rows, range) };
  }
  if (path === 'api/sentiment' && method === 'GET') return fetchJson('data/sentiment.json');
  const q = path.match(/^api\/quote\?symbols=(.*)$/);
  if (q && method === 'GET') {
    const scan = await staticScan();
    const wanted = decodeURIComponent(q[1]).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    return { quotes: wanted.map((s) => scan.rows.find((r) => r.symbol === s)?.quote || { symbol: s, error: 'not in universe' }) };
  }
  if (path === 'api/alerts' && method === 'GET') return { alerts: loadLS(LS_ALERTS, []), log: loadLS(LS_LOG, []) };
  if (path === 'api/alerts' && method === 'POST') return staticAlertAdd(body);
  if (path === 'api/evaluate' && method === 'POST') return { fired: await staticEvaluate() };
  const ack = path.match(/^api\/alerts\/([^/]+)\/ack$/);
  if (ack && method === 'POST') {
    const list = loadLS(LS_ALERTS, []);
    const a = list.find((x) => x.id === ack[1]);
    if (a) {
      a.acknowledged = true;
      saveLS(LS_ALERTS, list);
    }
    return { alert: a || null };
  }
  const del = path.match(/^api\/alerts\/([^/]+)$/);
  if (del && method === 'DELETE') {
    saveLS(LS_ALERTS, loadLS(LS_ALERTS, []).filter((x) => x.id !== del[1]));
    return { ok: true };
  }
  throw new Error(`not found: ${path}`);
}

async function api(path, opts = {}) {
  if (state.mode === 'static') return staticApi(path, opts);
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function fmtPrice(n, currency) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  const sym = CURRENCY_SYMBOL[currency] || '';
  return `${sym}${Number(n).toFixed(2)}`;
}

function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toast(message) {
  const stack = $('#toast-stack');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${esc(message)}<div class="t">${esc(new Date().toLocaleTimeString())}</div>`;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

function notifyBrowser(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

function statusColor(dist) {
  if (dist == null) return 'var(--color-muted)';
  if (dist <= 0) return 'var(--color-accent)';
  if (dist <= (state.settings?.threshold ?? 5)) return 'var(--color-accent-2)';
  if (dist <= 10) return 'var(--color-muted)';
  return 'var(--color-ink)';
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || 26;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawSparkline(canvas, values) {
  if (!values || values.length < 2) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const px = (i) => (i / (values.length - 1)) * (w - 2) + 1;
  const py = (v) => h - 2 - ((v - min) / span) * (h - 4);
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = 'var(--color-ink)';
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawDetailChart(canvas, rows, snapshot) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (!rows || rows.length < 2) return;
  const padL = 52, padR = 12, padT = 12, padB = 22;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const closes = rows.map((r) => r.c);
  const off = rows.length - (snapshot?.ma50series?.length || rows.length);
  const ma50 = rows.map((r, i) => snapshot?.ma50series?.[i + off] ?? null);
  const ma200 = rows.map((r, i) => snapshot?.ma200series?.[i + off] ?? null);
  const allVals = [...closes];
  if (snapshot?.stop != null) allVals.push(snapshot.stop);
  const min = Math.min(...allVals, ...rows.map((r) => r.l));
  const max = Math.max(...allVals, ...rows.map((r) => r.h));
  const span = max - min || 1;
  const px = (i) => padL + (i / (rows.length - 1)) * iw;
  const py = (v) => padT + ih - ((v - min) / span) * ih;

  ctx.strokeStyle = 'var(--color-rule)';
  ctx.fillStyle = 'var(--color-muted)';
  ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = min + (span * g) / 4;
    const y = py(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(fmtPrice(v), 2, y + 3);
  }
  ctx.fillText(fmtTime(rows[0].t), padL, h - 6);
  const lastLabel = fmtTime(rows[rows.length - 1].t);
  ctx.fillText(lastLabel, w - padR - ctx.measureText(lastLabel).width, h - 6);

  const line = (series, color, width, dash) => {
    ctx.beginPath();
    let started = false;
    series.forEach((v, i) => {
      if (v == null) return;
      if (!started) {
        ctx.moveTo(px(i), py(v));
        started = true;
      } else ctx.lineTo(px(i), py(v));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  line(ma200, 'var(--color-muted)', 1, [3, 3]);
  line(ma50, 'var(--color-ink-2)', 1, [3, 3]);

  if (snapshot?.stop != null) {
    ctx.beginPath();
    ctx.moveTo(padL, py(snapshot.stop));
    ctx.lineTo(w - padR, py(snapshot.stop));
    ctx.strokeStyle = 'var(--color-rule-2)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'var(--color-accent-2)';
    ctx.fillText(`stop ${fmtPrice(snapshot.stop)}`, padL + 6, py(snapshot.stop) - 5);
  }

  line(closes, 'var(--color-accent)', 2);

  ctx.beginPath();
  ctx.arc(px(rows.length - 1), py(closes[closes.length - 1]), 3, 0, Math.PI * 2);
  ctx.fillStyle = 'var(--color-accent)';
  ctx.fill();
}

function badgeHtml(badges) {
  if (!badges?.length) return '<span class="muted">n/a</span>';
  return badges
    .map((k) => {
      const b = BADGES.find((x) => x.key === k);
      return b ? `<span class="badge">${esc(b.label)}</span>` : '';
    })
    .join('');
}

function distCellHtml(dist) {
  if (dist == null) return '<span class="muted">n/a</span>';
  const pct = Math.max(0, Math.min(100, (Math.min(dist, 30) / 30) * 100));
  return `<div class="dist-cell"><div class="dist-bar"><div style="width:${pct}%"></div></div>
    <span class="num" style="color:${statusColor(dist)}">${fmtPct(dist)}</span></div>`;
}

function rowHtml(r, point) {
  const s = r.snapshot;
  if (!s) {
    return `<tr><td class="sym">${esc(r.symbol)}</td><td colspan="9" class="muted">${esc(r.error || 'no data')}</td></tr>`;
  }
  const q = r.quote || {};
  const price = q.price ?? s.close;
  const chg = q.changePct ?? s.changePct;
  const cur = q.currency || r.meta?.currency;
  const st = STATUS_META[s.status] || STATUS_META.unknown;
  const rowCls = [point ? 'row-point' : '', s.status === 'breached' ? 'row-breached' : s.status === 'near' ? 'row-near' : ''].filter(Boolean).join(' ');
  return `<tr class="${rowCls}" data-symbol="${esc(r.symbol)}">
    <td class="sym">${esc(r.symbol)}</td>
    <td class="name">${esc(r.meta?.name || '')}</td>
    <td class="num">${fmtPrice(price, cur)}</td>
    <td class="num" style="color:${chg >= 0 ? 'var(--color-ink)' : 'var(--color-accent-2)'}">${fmtPct(chg)}</td>
    <td><canvas class="spark" data-spark="${esc(r.symbol)}"></canvas></td>
    <td class="num">${fmtPrice(s.stop, cur)}</td>
    <td>${distCellHtml(s.dist)}</td>
    <td><span class="status-chip ${st.cls}">${st.label}</span></td>
    <td><div class="badges">${badgeHtml(s.badges)}</div></td>
    <td><div class="row-actions">
      <button class="icon-btn" data-act="chart" data-symbol="${esc(r.symbol)}">chart</button>
      <button class="icon-btn" data-act="alert" data-symbol="${esc(r.symbol)}">alert</button>
      <button class="icon-btn" data-act="remove" data-symbol="${esc(r.symbol)}">remove</button>
    </div></td>
  </tr>`;
}

function paintSparklines(tbody) {
  $$(`${tbody} .spark`).forEach((c) => {
    const row = state.scan.find((r) => r.symbol === c.dataset.spark);
    if (row?.snapshot?.spark) drawSparkline(c, row.snapshot.spark);
  });
}

function renderStats() {
  const rows = state.scan.filter((r) => r.snapshot);
  const near = rows.filter((r) => r.snapshot.status === 'near').length;
  const breached = rows.filter((r) => r.snapshot.status === 'breached').length;
  const safe = rows.filter((r) => r.snapshot.badges.includes('safeBuffer')).length;
  const recovered = rows.filter((r) => r.snapshot.badges.includes('recovered')).length;
  const t = state.settings?.threshold ?? 5;
  $('#stats-row').innerHTML = `<div class="tally">
    <div class="tally-item"><span class="k">Near stop, within ${t}%</span><span class="v">${near}</span></div>
    <div class="tally-item"><span class="k">Stop breached</span><span class="v" style="color:var(--color-accent)">${breached}</span></div>
    <div class="tally-item"><span class="k">Buffer over 10%</span><span class="v">${safe}</span></div>
    <div class="tally-item"><span class="k">Recovered</span><span class="v">${recovered}</span></div>
    <div class="tally-item"><span class="k">Tracked symbols</span><span class="v">${rows.length}</span></div>
  </div>`;
}

function renderDashboard() {
  const tbody = $('#dash-tbody');
  const rows = [...state.scan].sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty">Loading the register…</div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => rowHtml(r, false)).join('');
  paintSparklines('#dash-tbody');
}

function renderScanner() {
  const t = state.settings?.threshold ?? 5;
  const tbody = $('#scan-tbody');
  const rows = state.scan.filter((r) => {
    if (!r.snapshot) return false;
    if (state.filters.size && ![...state.filters].every((f) => r.snapshot.badges.includes(f))) return false;
    return true;
  });
  const withData = state.scan.filter((r) => r.snapshot);
  const within = withData.filter((r) => r.snapshot.dist != null && r.snapshot.dist <= t).length;
  const gen = state.scan.generatedAt ? `, data as of ${fmtTime(state.scan.generatedAt)}` : '';
  $('#scan-summary').textContent = `${within} of ${withData.length} positions within ${t}% of their stop, sorted closest first${gen}.${state.mode === 'static' ? ' Static snapshot.' : ''}`;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty">No matching positions.</div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r, i) => rowHtml(r, i === 0)).join('');
  paintSparklines('#scan-tbody');
}

function renderBadgeFilters() {
  $('#badge-filters').innerHTML = BADGES.map(
    (b) => `<button class="filter-chip ${state.filters.has(b.key) ? 'on' : ''}" data-filter="${esc(b.key)}">${esc(b.label)}</button>`
  ).join('');
}

function renderAlerts() {
  const list = $('#alerts-list');
  if (!state.alerts.length) {
    list.innerHTML = '<div class="empty">No alerts yet. Choose “New alert” or the alert action on any row.</div>';
  } else {
    list.innerHTML = state.alerts
      .map((a) => {
        const label = { below: `below ${a.value}`, above: `above ${a.value}`, near_stop: `within ${a.value}% of stop`, stop_breach: 'stop-loss breach' }[a.type];
        return `<div class="alert-item ${a.state === 'triggered' && !a.acknowledged ? 'triggered' : ''}">
          <div class="top">
            <span class="title">${esc(a.symbol)}, ${esc(label)}</span>
            <span class="status-chip ${a.state === 'triggered' ? 'status-breached' : 'status-safe'}">${a.state === 'triggered' ? 'triggered' : 'active'}</span>
          </div>
          <div class="meta">created ${esc(fmtTime(a.createdAt))}${a.triggeredAt ? `, fired ${esc(fmtTime(a.triggeredAt))}` : ''}${state.mode === 'static' ? ', stored in this browser' : ''}</div>
          ${a.note ? `<div class="note">${esc(a.note)}</div>` : ''}
          <div class="actions">
            ${a.state === 'triggered' && !a.acknowledged ? `<button class="btn small" data-ack="${esc(a.id)}">Acknowledge</button>` : ''}
            <button class="btn small danger" data-del="${esc(a.id)}">Delete</button>
          </div>
        </div>`;
      })
      .join('');
  }
  const log = $('#alerts-log');
  if (!state.log.length) {
    log.innerHTML = '<div class="empty">Nothing triggered yet.</div>';
  } else {
    log.innerHTML = state.log
      .map((e) => `<div class="log-item">${esc(e.message)}<div class="t">${esc(fmtTime(e.ts))}, price ${esc(e.price)}</div></div>`)
      .join('');
  }
  const unacked = state.alerts.filter((a) => a.state === 'triggered' && !a.acknowledged).length;
  const pill = $('#alert-count');
  pill.textContent = String(unacked);
  pill.classList.toggle('hidden', unacked === 0);
}

function renderSentiment() {
  const pill = $('#fg-pill');
  const fg = state.sentiment?.fearGreed;
  if (!fg || fg.score == null) {
    pill.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden');
  const score = Math.round(fg.score);
  const vix = state.sentiment?.vix;
  pill.innerHTML = `Fear &amp; Greed <b>${score}</b>, ${esc(fg.rating || '—')}${vix?.price ? `, VIX ${vix.price.toFixed(1)}` : ''}`;
  pill.title = `CNN Fear & Greed ${score} (${fg.rating})\n1 week ago ${fg.weekAgo?.toFixed?.(0) ?? '—'}, 1 month ago ${fg.monthAgo?.toFixed?.(0) ?? '—'}, 1 year ago ${fg.yearAgo?.toFixed?.(0) ?? '—'}`;
}

function renderSettingsInputs() {
  if (!state.settings) return;
  $('#set-stopPct').value = state.settings.stopPct;
  $('#set-lookback').value = String(state.settings.lookback);
  $('#set-atrMult').value = state.settings.atrMult;
  $('#set-threshold').value = state.settings.threshold;
}

async function openDetail(symbol) {
  state.detail = symbol;
  state.detailRange = '1y';
  const overlay = $('#modal-overlay');
  const modal = $('#modal');
  overlay.classList.remove('hidden');
  modal.innerHTML = '<div class="empty">Loading chart…</div>';
  try {
    const h = await api(`api/history/${encodeURIComponent(symbol)}?range=${state.detailRange}`);
    const scan = await api('api/scan');
    const row = scan.rows.find((r) => r.symbol === symbol);
    renderDetailModal(symbol, h, row?.snapshot);
  } catch (e) {
    modal.innerHTML = `<div class="empty">${esc(e.message)}</div><div class="modal-actions"><button class="btn" id="modal-close2">Close</button></div>`;
    $('#modal-close2').onclick = closeModal;
  }
}

function renderDetailModal(symbol, h, snapshot) {
  const modal = $('#modal');
  const s = snapshot;
  const q = state.scan.find((r) => r.symbol === symbol)?.quote;
  const cur = h.meta?.currency || q?.currency;
  const ranges = ['1mo', '3mo', '6mo', '1y', '2y'];
  modal.innerHTML = `
    <button class="btn small ghost modal-close" id="modal-close">Close</button>
    <h3>${esc(symbol)}</h3>
    <div class="sub">${esc(h.meta?.name || '')}${h.meta?.exchange ? `, ${esc(h.meta.exchange)}` : ''}</div>
    <div class="sub">${fmtPrice(q?.price ?? s?.close, cur)} ${s ? `<span style="color:${(q?.changePct ?? s.changePct) >= 0 ? 'var(--color-ink)' : 'var(--color-accent-2)'}">${fmtPct(q?.changePct ?? s.changePct)}</span>` : ''}, stop-loss ${s ? fmtPrice(s.stop, cur) : '—'}, distance ${s ? fmtPct(s.dist) : '—'}</div>
    <div class="range-btns">${ranges.map((r) => `<button class="btn small ${r === state.detailRange ? 'active' : ''}" data-range="${r}">${r.toUpperCase()}</button>`).join('')}</div>
    <canvas class="chart-canvas" id="detail-chart"></canvas>
    <div class="detail-stats">
      ${s ? `
      <div class="detail-stat"><div class="k">Stop-loss, ${state.settings?.stopPct}%</div><div class="v">${fmtPrice(s.stop, cur)}</div></div>
      <div class="detail-stat"><div class="k">ATR stop, ${state.settings?.atrMult}×ATR</div><div class="v">${fmtPrice(s.stopAtr, cur)}</div></div>
      <div class="detail-stat"><div class="k">MA50</div><div class="v">${fmtPrice(s.ma50, cur)}</div></div>
      <div class="detail-stat"><div class="k">MA200</div><div class="v">${fmtPrice(s.ma200, cur)}</div></div>
      <div class="detail-stat"><div class="k">Volatility, 30d</div><div class="v">${s.volPct == null ? '—' : s.volPct.toFixed(1) + '%'}</div></div>
      <div class="detail-stat"><div class="k">3M trend</div><div class="v">${fmtPct(s.trend3m)}</div></div>
      <div class="detail-stat"><div class="k">From top</div><div class="v">${fmtPct(s.pctFromHigh)}</div></div>
      <div class="detail-stat"><div class="k">ATR 14</div><div class="v">${s.atrPct == null ? '—' : s.atrPct.toFixed(2) + '%'}</div></div>` : ''}
    </div>
    <div class="badges" style="margin-bottom:10px">${s ? badgeHtml(s.badges) : ''}</div>
    <div class="modal-actions">
      <button class="btn primary" id="detail-alert">Set alert</button>
      <button class="btn ghost" id="detail-close">Close</button>
    </div>`;
  $('#modal-close').onclick = closeModal;
  $('#detail-close').onclick = closeModal;
  $('#detail-alert').onclick = () => openAlertModal(symbol);
  $$('#modal .range-btns .btn').forEach((b) => {
    b.onclick = async () => {
      state.detailRange = b.dataset.range;
      const h2 = await api(`api/history/${encodeURIComponent(symbol)}?range=${state.detailRange}`);
      renderDetailModal(symbol, h2, s);
    };
  });
  drawDetailChart($('#detail-chart'), h.rows, s);
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  state.detail = null;
}

function openAlertModal(symbol = '') {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');
  overlay.classList.remove('hidden');
  const options = (state.settings?.universe || state.scan.map((r) => r.symbol))
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join('');
  modal.innerHTML = `
    <button class="btn small ghost modal-close" id="modal-close">Close</button>
    <h3>New alert</h3>
    <div class="sub">${state.mode === 'static' ? 'Stored in this browser and checked locally against the latest snapshot.' : 'Checked server-side every 60 seconds; toast and browser notification on trigger.'}</div>
    <div class="form-grid">
      <label>Symbol
        <input id="f-symbol" list="universe-list" value="${esc(symbol)}" placeholder="AAPL" />
        <datalist id="universe-list">${options}</datalist>
      </label>
      <label>Alert type
        <select id="f-type">
          <option value="below">Price drops below</option>
          <option value="above">Price rises above</option>
          <option value="near_stop">Within % of stop-loss</option>
          <option value="stop_breach">Stop-loss breached</option>
        </select>
      </label>
      <label class="full" id="f-value-wrap">Value <input id="f-value" type="number" step="any" placeholder="e.g. 150 or 5" /></label>
      <label class="full">Note, optional <input id="f-note" placeholder="e.g. re-evaluate position" /></label>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" id="f-cancel">Cancel</button>
      <button class="btn primary" id="f-save">Create alert</button>
    </div>`;
  const typeSel = $('#f-type');
  const valueWrap = $('#f-value-wrap');
  const syncValue = () => {
    valueWrap.style.display = typeSel.value === 'stop_breach' ? 'none' : '';
  };
  typeSel.onchange = syncValue;
  syncValue();
  $('#modal-close').onclick = closeModal;
  $('#f-cancel').onclick = closeModal;
  $('#f-save').onclick = async () => {
    const symbol2 = $('#f-symbol').value.trim().toUpperCase();
    const type = typeSel.value;
    const value = $('#f-value').value;
    const note = $('#f-note').value;
    try {
      await api('api/alerts', { method: 'POST', body: JSON.stringify({ symbol: symbol2, type, value, note }) });
      toast(`Alert created for ${symbol2}`);
      closeModal();
      await loadAlerts();
    } catch (e) {
      toast(`Error: ${e.message}`);
    }
  };
}

async function loadSettings() {
  state.settings = await api('api/settings');
  renderSettingsInputs();
}

async function loadScan() {
  if (state.mode === 'static') {
    try {
      const idx = await fetchJson('data/index.json');
      if (idx.generatedAt !== state.lastGen) {
        state.lastGen = idx.generatedAt;
        state.indexCache = idx;
        state.histCache.clear();
      }
    } catch {
      /* keep cache */
    }
  }
  const data = await api('api/scan');
  state.settings = data.settings;
  state.scan = data.rows;
  state.scan.generatedAt = data.generatedAt;
  const health = await api('api/health').catch(() => ({}));
  state.demo = !!health.demo;
  $('#demo-badge').classList.toggle('hidden', !state.demo);
  renderStats();
  renderDashboard();
  renderScanner();
  renderSettingsInputs();
}

async function loadAlerts() {
  const data = await api('api/alerts');
  state.alerts = data.alerts;
  state.log = data.log;
  renderAlerts();
}

async function loadSentiment() {
  try {
    state.sentiment = await api('api/sentiment');
    renderSentiment();
  } catch {
    /* optional */
  }
}

async function evaluateAlerts() {
  try {
    const { fired } = await api('api/evaluate', { method: 'POST', body: '{}' });
    for (const f of fired || []) {
      if (state.notified.has(f.entry.id)) continue;
      state.notified.add(f.entry.id);
      toast(`Alert: ${f.entry.message}`);
      notifyBrowser('Stoploss Alert', f.entry.message);
    }
    if (fired?.length) await loadAlerts();
  } catch {
    /* server may be restarting */
  }
}

function init() {
  $$('#tabs .tab').forEach((t) => {
    t.onclick = () => {
      $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${t.dataset.view}`));
    };
  });

  $('#add-symbol-form').onsubmit = async (e) => {
    e.preventDefault();
    const sym = $('#add-symbol-input').value.trim().toUpperCase();
    if (!sym) return;
    const universe = [...(state.settings?.universe || []), sym].filter((v, i, a) => a.indexOf(v) === i);
    await api('api/settings', { method: 'PUT', body: JSON.stringify({ universe }) });
    $('#add-symbol-input').value = '';
    toast(`Added ${sym}`);
    await loadScan();
  };

  $('#apply-settings').onclick = async () => {
    const body = {
      stopPct: Number($('#set-stopPct').value),
      lookback: Number($('#set-lookback').value),
      atrMult: Number($('#set-atrMult').value),
      threshold: Number($('#set-threshold').value),
    };
    await api('api/settings', { method: 'PUT', body: JSON.stringify(body) });
    toast('Settings applied');
    await loadScan();
  };

  $('#refresh-scan').onclick = () => loadScan();

  $('#badge-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    const k = chip.dataset.filter;
    if (state.filters.has(k)) state.filters.delete(k);
    else state.filters.add(k);
    renderBadgeFilters();
    renderScanner();
  });

  $('#new-alert-btn').onclick = () => openAlertModal('');

  document.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const { act: kind, symbol } = act.dataset;
      if (kind === 'chart') return openDetail(symbol);
      if (kind === 'alert') return openAlertModal(symbol);
      if (kind === 'remove') {
        const universe = (state.settings?.universe || []).filter((s) => s !== symbol);
        await api('api/settings', { method: 'PUT', body: JSON.stringify({ universe }) });
        toast(`Removed ${symbol}`);
        return loadScan();
      }
    }
    const row = e.target.closest('#scan-tbody tr[data-symbol], #dash-tbody tr[data-symbol]');
    if (row && !e.target.closest('[data-act]')) openDetail(row.dataset.symbol);
    const ack = e.target.closest('[data-ack]');
    if (ack) {
      await api(`api/alerts/${ack.dataset.ack}/ack`, { method: 'POST', body: '{}' });
      return loadAlerts();
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      await api(`api/alerts/${del.dataset.del}`, { method: 'DELETE' });
      toast('Alert deleted');
      return loadAlerts();
    }
  });

  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) closeModal();
  });

  $('#notify-btn').onclick = async () => {
    if (!('Notification' in window)) return toast('Notifications not supported in this browser');
    const perm = await Notification.requestPermission();
    toast(perm === 'granted' ? 'Browser notifications enabled' : `Notification permission: ${perm}`);
  };

  setInterval(() => {
    $('#clock').textContent = new Date().toLocaleTimeString();
  }, 1000);
}

async function main() {
  state.mode = await detectMode();
  if (state.mode === 'static') {
    try {
      await indexCache();
      await baseSettings();
    } catch (e) {
      toast(`Static data not found (${e.message}), run: node server/export.js --out public/data`);
    }
  }
  init();
  renderBadgeFilters();
  await Promise.all([loadSettings(), loadAlerts(), loadSentiment()]);
  await loadScan();
  setInterval(loadScan, 60_000);
  setInterval(loadSentiment, 5 * 60_000);
  setInterval(evaluateAlerts, 30_000);
}

main().catch((e) => toast(`Startup error: ${e.message}`));
