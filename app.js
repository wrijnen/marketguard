import { BADGES, computeSnapshot, dataFileName, sliceRange } from './indicators.js';

const STATUS_META = {
  safe: { label: 'Safe', cls: 'status-safe' },
  watch: { label: 'Watch', cls: 'status-watch' },
  near: { label: 'Near stop', cls: 'status-near' },
  breached: { label: 'Breached', cls: 'status-breached' },
  unknown: { label: 'n/a', cls: 'status-unknown' },
};

const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', GBp: 'p', CHF: 'CHF ', CAD: 'C$', SEK: 'kr', DKK: 'kr' };

const ALERT_TYPES = ['below', 'above', 'near_stop', 'stop_breach', 'recovery'];
const ALERT_TYPE_LABELS = {
  below: 'price drops below',
  above: 'price rises above',
  near_stop: 'within % of stop-loss',
  stop_breach: 'stop-loss breached',
  recovery: 'recovers above stop-loss',
};
const ALERT_SCHEDULES = ['realtime', 'daily', 'weekly'];
const ALERT_SCHEDULE_LABELS = { realtime: 'real-time', daily: 'daily 17:45', weekly: 'weekly Fri 16:30' };

const STALE_MS = 15 * 60 * 1000;

const LS_SETTINGS = 'sla_settings_overrides';
const LS_ALERTS = 'sla_alerts';
const LS_LOG = 'sla_alerts_log';

const state = {
  mode: 'server',
  settings: null,
  scan: [],
  scanGeneratedAt: null,
  scanSource: null,
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
  scanJsonCache: null,
  baseSettingsCache: null,
  lastGen: null,
  digest: { daily: [], weekly: [], lastDaily: 0, lastWeekly: 0 },
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
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function indexCache() {
  if (!state.indexCache) state.indexCache = await fetchJson('data/index.json');
  return state.indexCache;
}

async function scanJsonCache() {
  if (!state.scanJsonCache) state.scanJsonCache = await fetchJson('data/scan.json');
  return state.scanJsonCache;
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
  let scanJson = null;
  try {
    scanJson = await scanJsonCache();
  } catch {
    scanJson = null;
  }
  const qBySym = new Map((scanJson?.rows || []).filter((r) => r.quote).map((r) => [r.symbol, r.quote]));
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
        const fallbackQuote = {
          symbol: sym,
          price: last,
          prevClose: prev ?? last,
          changePct: prev ? ((last - prev) / prev) * 100 : 0,
          time: new Date(hj.rows[hj.rows.length - 1].t).toISOString(),
          asOf: new Date(hj.rows[hj.rows.length - 1].t).toISOString(),
          currency: hj.meta?.currency,
          name: hj.meta?.name,
          source: `${hj.meta?.source || 'history'}-close`,
        };
        rows.push({
          symbol: sym,
          meta: hj.meta,
          quote: qBySym.get(sym) || fallbackQuote,
          snapshot: { ...snap, spark: closes.slice(-60) },
        });
      } catch (e) {
        rows.push({ symbol: sym, error: 'no data' });
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
  if (!ALERT_TYPES.includes(body.type)) throw new Error('invalid type');
  let val = null;
  if (body.type !== 'stop_breach' && body.type !== 'recovery') {
    val = Number(body.value);
    if (!Number.isFinite(val)) throw new Error('value must be a number');
  }
  const alert = {
    id: crypto.randomUUID(),
    symbol: sym,
    type: body.type,
    value: val,
    note: String(body.note || ''),
    schedule: ALERT_SCHEDULES.includes(body.schedule) ? body.schedule : 'realtime',
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
    } else if (a.type === 'recovery') {
      cond = s.badges?.includes('recovered') && (s.dist ?? 0) > 0;
      msg = `${a.symbol} recovered above its stop-loss, distance ${s.dist?.toFixed(2)}%, price ${price}`;
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
  if (dist == null) return 'var(--muted)';
  if (dist <= 0) return 'var(--breach)';
  if (dist <= (state.settings?.threshold ?? 5)) return 'var(--near)';
  if (dist <= 10) return 'var(--muted)';
  return 'var(--safe)';
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || 30;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawSparkline(canvas, values, stop) {
  if (!values || values.length < 2) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const all = stop != null ? [...values, stop] : values;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const px = (i) => (i / (values.length - 1)) * (w - 6) + 3;
  const py = (v) => h - 4 - ((v - min) / span) * (h - 8);
  const up = values[values.length - 1] >= values[0];
  const color = up ? 'var(--safe)' : 'var(--breach)';

  if (stop != null) {
    const y = py(stop);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.strokeStyle = 'var(--breach)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineTo(px(values.length - 1), h);
  ctx.lineTo(px(0), h);
  ctx.closePath();
  ctx.fillStyle = up ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)';
  ctx.fill();
}

function drawDetailChart(canvas, rows, snapshot) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (!rows || rows.length < 2) return;
  const padL = 56, padR = 12, padT = 12, padB = 22;
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

  ctx.strokeStyle = 'rgba(139,150,173,0.14)';
  ctx.fillStyle = 'var(--muted)';
  ctx.font = '10px "Space Grotesk", ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = min + (span * g) / 4;
    const y = py(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(fmtPrice(v), 4, y + 3);
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

  line(ma200, 'rgba(245,158,11,0.65)', 1.2);
  line(ma50, 'rgba(34,211,238,0.65)', 1.2);

  if (snapshot?.stop != null) {
    ctx.beginPath();
    ctx.moveTo(padL, py(snapshot.stop));
    ctx.lineTo(w - padR, py(snapshot.stop));
    ctx.strokeStyle = 'var(--breach)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'var(--breach)';
    ctx.fillText(`stop ${fmtPrice(snapshot.stop)}`, padL + 6, py(snapshot.stop) - 5);
  }

  const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
  grad.addColorStop(0, 'rgba(99,102,241,0.28)');
  grad.addColorStop(1, 'rgba(99,102,241,0)');
  ctx.beginPath();
  ctx.moveTo(px(0), py(closes[0]));
  closes.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(rows.length - 1), padT + ih);
  ctx.lineTo(px(0), padT + ih);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  line(closes, 'var(--accent-hi)', 2);

  ctx.beginPath();
  ctx.arc(px(rows.length - 1), py(closes[closes.length - 1]), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = 'var(--accent-hi)';
  ctx.fill();
}

function badgeHtml(badges, cap = 3) {
  if (!badges?.length) return '';
  const shown = badges.slice(0, cap);
  const more = badges.length - shown.length;
  return (
    shown
      .map((k) => {
        const b = BADGES.find((x) => x.key === k);
        return b ? `<span class="badge">${esc(b.label)}</span>` : '';
      })
      .join('') + (more > 0 ? `<span class="badge more">+${more}</span>` : '')
  );
}

function distCellHtml(dist) {
  if (dist == null) return '<span class="muted">n/a</span>';
  const t = state.settings?.threshold ?? 5;
  const pct = Math.max(0, Math.min(100, (Math.min(dist, 30) / 30) * 100));
  const tick = Math.max(0, Math.min(100, (Math.min(t, 30) / 30) * 100));
  return `<div class="dist-cell" title="Bar scale 0–30%; tick marks the ${t}% alert threshold">
    <div class="dist-bar"><div class="fill" style="width:${pct}%;background:${statusColor(dist)}"></div><div class="tick" style="left:${tick}%"></div></div>
    <span class="num" style="color:${statusColor(dist)}">${fmtPct(dist)}</span></div>`;
}

function rowActionsHtml(r) {
  return `<div class="row-actions">
    <button class="icon-btn" data-act="chart" data-symbol="${esc(r.symbol)}">chart</button>
    <button class="icon-btn" data-act="alert" data-symbol="${esc(r.symbol)}">alert</button>
    <button class="icon-btn" data-act="remove" data-symbol="${esc(r.symbol)}">remove</button>
  </div>`;
}

function errorRowHtml(r, inCard) {
  const actions = inCard
    ? `<div class="card-actions">
        <button class="btn small" data-act="retry" data-symbol="${esc(r.symbol)}">Retry</button>
        <button class="btn small danger" data-act="remove" data-symbol="${esc(r.symbol)}">Remove</button>
      </div>`
    : `<div class="row-actions">
        <button class="icon-btn" data-act="retry" data-symbol="${esc(r.symbol)}">retry</button>
        <button class="icon-btn" data-act="remove" data-symbol="${esc(r.symbol)}">remove</button>
      </div>`;
  if (inCard) {
    return `<div class="stock-card" data-symbol="${esc(r.symbol)}">
      <div class="card-top"><span class="card-symbol">${esc(r.symbol)}</span></div>
      <div class="empty" style="text-align:left;padding:6px 0">No data for this symbol right now. The quote source may not cover it.</div>
      ${actions}
    </div>`;
  }
  return `<tr data-symbol="${esc(r.symbol)}"><td class="sym">${esc(r.symbol)}</td><td colspan="8" class="muted">No data for this symbol right now.</td><td>${actions}</td></tr>`;
}

function cardHtml(r) {
  const s = r.snapshot;
  if (!s) return errorRowHtml(r, true);
  const q = r.quote || {};
  const price = q.price ?? s.close;
  const chg = q.changePct ?? s.changePct;
  const cur = q.currency || r.meta?.currency;
  const st = STATUS_META[s.status] || STATUS_META.unknown;
  const asof = q.asOf || q.time;
  return `<div class="stock-card status-${s.status}" data-symbol="${esc(r.symbol)}">
    <div class="card-top">
      <div><span class="card-symbol">${esc(r.symbol)}</span> <span class="card-name">${esc(r.meta?.name || '')}</span></div>
      <span class="status-chip ${st.cls}">${st.label}</span>
    </div>
    <div class="card-top">
      <div><span class="card-price">${fmtPrice(price, cur)}</span><div class="card-asof">${asof ? `as of ${fmtTime(asof)}${q.source ? ` · ${esc(q.source)}` : ''}` : ''}</div></div>
      <span class="chg ${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</span>
    </div>
    <canvas class="spark" data-spark="${esc(r.symbol)}"></canvas>
    <div class="stop-row"><span>Stop-loss <b>${fmtPrice(s.stop, cur)}</b></span><span>High <b>${fmtPrice(s.high, cur)}</b></span></div>
    <div class="stop-row"><span>Distance to stop</span>${distCellHtml(s.dist)}</div>
    <div class="badges">${badgeHtml(s.badges)}</div>
    <div class="card-actions">
      <button class="btn small" data-act="chart" data-symbol="${esc(r.symbol)}">Chart</button>
      <button class="btn small" data-act="alert" data-symbol="${esc(r.symbol)}">Alert</button>
      <button class="btn small danger" data-act="remove" data-symbol="${esc(r.symbol)}">Remove</button>
    </div>
  </div>`;
}

function tableRowHtml(r, point) {
  const s = r.snapshot;
  if (!s) return errorRowHtml(r, false);
  const q = r.quote || {};
  const price = q.price ?? s.close;
  const chg = q.changePct ?? s.changePct;
  const cur = q.currency || r.meta?.currency;
  const st = STATUS_META[s.status] || STATUS_META.unknown;
  const rowCls = [point ? 'row-point' : '', s.status === 'breached' ? 'row-breached' : s.status === 'near' ? 'row-near' : ''].filter(Boolean).join(' ');
  const asof = q.asOf || q.time;
  return `<tr class="${rowCls}" data-symbol="${esc(r.symbol)}">
    <td class="sym">${esc(r.symbol)}</td>
    <td class="name">${esc(r.meta?.name || '')}</td>
    <td class="num">${fmtPrice(price, cur)}<div style="font-size:10px;color:var(--muted);font-weight:400">${asof ? fmtTime(asof) : ''}</div></td>
    <td class="num" style="color:${chg >= 0 ? 'var(--safe)' : 'var(--breach)'}">${fmtPct(chg)}</td>
    <td><canvas class="spark-sm" data-spark="${esc(r.symbol)}"></canvas></td>
    <td class="num">${fmtPrice(s.stop, cur)}</td>
    <td>${distCellHtml(s.dist)}</td>
    <td><span class="status-chip ${st.cls}">${st.label}</span></td>
    <td><div class="badges">${badgeHtml(s.badges)}</div></td>
    <td>${rowActionsHtml(r)}</td>
  </tr>`;
}

function paintSparklines(containerSel) {
  $$(containerSel + ' .spark, ' + containerSel + ' .spark-sm').forEach((c) => {
    const row = state.scan.find((r) => r.symbol === c.dataset.spark);
    if (row?.snapshot) drawSparkline(c, row.snapshot.spark, row.snapshot.stop);
  });
}

function renderStats() {
  const rows = state.scan.filter((r) => r.snapshot);
  const near = rows.filter((r) => r.snapshot.status === 'near').length;
  const breached = rows.filter((r) => r.snapshot.status === 'breached').length;
  const safe = rows.filter((r) => r.snapshot.badges.includes('safeBuffer')).length;
  const recovered = rows.filter((r) => r.snapshot.badges.includes('recovered')).length;
  const t = state.settings?.threshold ?? 5;
  $('#stats-row').innerHTML = `
    <div class="stat-card"><div class="label">Near stop, within ${t}%</div><div class="value" style="color:var(--near)">${near}</div></div>
    <div class="stat-card"><div class="label">Stop breached</div><div class="value" style="color:var(--breach)">${breached}</div></div>
    <div class="stat-card"><div class="label">Safe buffer, over 10%</div><div class="value" style="color:var(--safe)">${safe}</div></div>
    <div class="stat-card"><div class="label">Recovered</div><div class="value" style="color:var(--accent-hi)">${recovered}</div></div>
    <div class="stat-card"><div class="label">Tracked symbols</div><div class="value">${rows.length}</div></div>`;
}

function renderDashboard() {
  const grid = $('#cards-grid');
  const rows = [...state.scan].sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
  if (!rows.length) {
    grid.innerHTML = '<div class="empty">Loading the dashboard…</div>';
    return;
  }
  grid.innerHTML = rows.map((r) => cardHtml(r)).join('');
  paintSparklines('#cards-grid');
}

function renderScanner() {
  const t = state.settings?.threshold ?? 5;
  const tbody = $('#scan-tbody');
  const rows = state.scan.filter((r) => {
    if (!r.snapshot) return true;
    if (state.filters.size && ![...state.filters].every((f) => r.snapshot.badges.includes(f))) return false;
    return true;
  });
  const withData = state.scan.filter((r) => r.snapshot);
  const within = withData.filter((r) => r.snapshot.dist != null && r.snapshot.dist <= t).length;
  const gen = state.scanGeneratedAt ? `, snapshot ${fmtTime(state.scanGeneratedAt)}` : '';
  $('#scan-summary').textContent = `${within} of ${withData.length} positions within ${t}% of their stop, sorted closest first${gen}.`;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty">No matching positions.</div></td></tr>';
    return;
  }
  const firstWithData = rows.findIndex((r) => r.snapshot);
  tbody.innerHTML = rows.map((r, i) => tableRowHtml(r, i === firstWithData)).join('');
  paintSparklines('#scan-tbody');
}

function renderStamp() {
  const el = $('#stamp');
  const gen = state.scanGeneratedAt;
  if (!gen) {
    el.textContent = 'no data yet';
    return;
  }
  const ageMs = Date.now() - new Date(gen).getTime();
  const mins = Math.max(0, Math.round(ageMs / 60000));
  const src = state.scanSource || 'snapshot';
  el.innerHTML = `updated <b>${esc(fmtTime(gen))}</b>, ${mins} min ago · <b>${esc(src)}</b>`;
  el.title = 'Snapshot timestamp and quote source. Refreshed by GitHub Actions every 5 min on weekdays 13–22 UTC, every 30 min otherwise, and on code pushes.';
  const stale = ageMs > STALE_MS;
  const sb = $('#stale-badge');
  sb.classList.toggle('hidden', !stale);
  if (stale) sb.textContent = `stale data: ${mins} min old`;
}

function renderBadgeFilters() {
  $('#badge-filters').innerHTML = BADGES.map(
    (b) => `<button class="filter-chip ${state.filters.has(b.key) ? 'on' : ''}" data-filter="${esc(b.key)}">${esc(b.label)}</button>`
  ).join('');
}

function renderAlerts() {
  const list = $('#alerts-list');
  if (!state.alerts.length) {
    list.innerHTML = `<div class="alerts-hint">
      No alerts yet. Choose <b>New alert</b> above, or the <b>alert</b> action on any row.<br><br>
      Example: <code>NVDA, stop-loss breached, real-time</code> notifies the moment the price is at or below its trailing stop.<br><br>
      Types: price below/above a level, within a % of the stop, stop-loss breach, and recovery above the stop.<br>
      Schedules: <b>real-time</b> notifies immediately; <b>daily 17:45</b> and <b>weekly Friday 16:30</b> collect triggers into a single digest. Digests are delivered in-app while this page is open; email delivery is not configured.
    </div>`;
  } else {
    list.innerHTML = state.alerts
      .map((a) => {
        const label = { below: `below ${a.value}`, above: `above ${a.value}`, near_stop: `within ${a.value}% of stop`, stop_breach: 'stop-loss breach', recovery: 'recovery above stop' }[a.type];
        return `<div class="alert-item ${a.state === 'triggered' && !a.acknowledged ? 'triggered' : ''}">
          <div class="top">
            <span class="title">${esc(a.symbol)}, ${esc(label)}</span>
            <span class="status-chip ${a.state === 'triggered' ? 'status-breached' : 'status-safe'}">${a.state === 'triggered' ? 'triggered' : 'active'}</span>
          </div>
          <div class="meta">${esc(ALERT_SCHEDULE_LABELS[a.schedule] || 'real-time')}, created ${esc(fmtTime(a.createdAt))}${a.triggeredAt ? `, fired ${esc(fmtTime(a.triggeredAt))}` : ''}${state.mode === 'static' ? ', stored in this browser' : ''}</div>
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
  const color = score <= 25 ? 'var(--breach)' : score <= 45 ? 'var(--near)' : score <= 55 ? 'var(--muted)' : score <= 75 ? 'var(--safe)' : 'var(--accent-hi)';
  const vix = state.sentiment?.vix;
  pill.innerHTML = `<span class="fg-dot" style="background:${color}"></span> Fear &amp; Greed <b>${score}</b> ${esc(fg.rating || '')}${vix?.price ? `, VIX ${vix.price.toFixed(1)}` : ''}`;
  pill.title = `CNN Fear & Greed ${score} (${fg.rating})\n1 week ago ${fg.weekAgo?.toFixed?.(0) ?? 'n/a'}, 1 month ago ${fg.monthAgo?.toFixed?.(0) ?? 'n/a'}, 1 year ago ${fg.yearAgo?.toFixed?.(0) ?? 'n/a'}`;
}

function renderSettingsInputs() {
  if (!state.settings) return;
  $('#set-stopPct').value = state.settings.stopPct;
  $('#set-lookback').value = String(state.settings.lookback);
  $('#set-atrMult').value = state.settings.atrMult;
  $('#set-threshold').value = state.settings.threshold;
}

function renderPermStatus() {
  const el = $('#perm-status');
  if (!('Notification' in window)) {
    el.textContent = 'notifications: unsupported';
    el.className = 'perm-pill no';
    return;
  }
  const p = Notification.permission;
  el.textContent = `notifications: ${p === 'granted' ? 'on' : p === 'denied' ? 'blocked' : 'not asked'}`;
  el.className = 'perm-pill ' + (p === 'granted' ? 'ok' : 'no');
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
    modal.innerHTML = `<div class="empty">No chart data for ${esc(symbol)}.</div><div class="modal-actions"><button class="btn" id="modal-close2">Close</button></div>`;
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
    <div class="sub">${esc(h.meta?.name || '')}${h.meta?.exchange ? `, ${esc(h.meta.exchange)}` : ''}${h.meta?.source ? `, history via ${esc(h.meta.source)}` : ''}</div>
    <div class="sub">${fmtPrice(q?.price ?? s?.close, cur)} ${s ? `<span class="chg ${((q?.changePct ?? s.changePct) ?? 0) >= 0 ? 'up' : 'down'}">${fmtPct(q?.changePct ?? s.changePct)}</span>` : ''}${q?.asOf ? ` as of ${esc(fmtTime(q.asOf))}${q.source ? ` (${esc(q.source)})` : ''}` : ''}, stop-loss ${s ? fmtPrice(s.stop, cur) : 'n/a'}, distance ${s ? fmtPct(s.dist) : 'n/a'}</div>
    <div class="range-btns">${ranges.map((r) => `<button class="btn small ${r === state.detailRange ? 'active' : ''}" data-range="${r}">${r.toUpperCase()}</button>`).join('')}</div>
    <canvas class="chart-canvas" id="detail-chart"></canvas>
    <div class="detail-stats">
      ${s ? `
      <div class="detail-stat"><div class="k">Stop-loss, ${state.settings?.stopPct}%</div><div class="v" style="color:var(--breach)">${fmtPrice(s.stop, cur)}</div></div>
      <div class="detail-stat"><div class="k">ATR stop, ${state.settings?.atrMult}×ATR</div><div class="v" style="color:var(--near)">${fmtPrice(s.stopAtr, cur)}</div></div>
      <div class="detail-stat"><div class="k">MA50</div><div class="v">${fmtPrice(s.ma50, cur)}</div></div>
      <div class="detail-stat"><div class="k">MA200</div><div class="v">${fmtPrice(s.ma200, cur)}</div></div>
      <div class="detail-stat"><div class="k">Volatility, 30d</div><div class="v">${s.volPct == null ? 'n/a' : s.volPct.toFixed(1) + '%'}</div></div>
      <div class="detail-stat"><div class="k">3M trend</div><div class="v">${fmtPct(s.trend3m)}</div></div>
      <div class="detail-stat"><div class="k">From top</div><div class="v">${fmtPct(s.pctFromHigh)}</div></div>
      <div class="detail-stat"><div class="k">ATR 14</div><div class="v">${s.atrPct == null ? 'n/a' : s.atrPct.toFixed(2) + '%'}</div></div>` : ''}
    </div>
    <div class="badges" style="margin-bottom:10px">${s ? badgeHtml(s.badges, 99) : ''}</div>
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
    <div class="sub">${state.mode === 'static' ? 'Stored in this browser and checked locally every 30 s while the page is open.' : 'Checked server-side every 60 s; this page shows a toast and sends a browser notification while it is open.'}</div>
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
          <option value="recovery">Recovers above stop-loss</option>
        </select>
      </label>
      <label>Delivery
        <select id="f-schedule">
          <option value="realtime">Real-time</option>
          <option value="daily">Daily digest, 17:45</option>
          <option value="weekly">Weekly digest, Friday 16:30</option>
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
    valueWrap.style.display = typeSel.value === 'stop_breach' || typeSel.value === 'recovery' ? 'none' : '';
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
    const schedule = $('#f-schedule').value;
    try {
      await api('api/alerts', { method: 'POST', body: JSON.stringify({ symbol: symbol2, type, value, note, schedule }) });
      toast(`Alert created for ${symbol2}`);
      closeModal();
      await loadAlerts();
    } catch (e) {
      toast(`Could not create alert: ${e.message}`);
    }
  };
}

function nextDailyDigest() {
  const d = new Date();
  d.setHours(17, 45, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}
function nextWeeklyDigest() {
  const d = new Date();
  d.setHours(16, 30, 0, 0);
  let add = (5 - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= Date.now()) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

function flushDigests() {
  const now = Date.now();
  if (state.digest.daily.length && now >= nextDailyDigest().getTime() - 60_000 && now - state.digest.lastDaily > 60_000) {
    const items = state.digest.daily.splice(0);
    state.digest.lastDaily = now;
    const body = items.slice(0, 3).map((e) => e.message).join(' | ') + (items.length > 3 ? ` | +${items.length - 3} more` : '');
    toast(`Daily digest: ${items.length} alert${items.length > 1 ? 's' : ''} triggered`);
    notifyBrowser(`Daily alert digest (${items.length})`, body);
  }
  if (state.digest.weekly.length && now >= nextWeeklyDigest().getTime() - 60_000 && now - state.digest.lastWeekly > 60_000) {
    const items = state.digest.weekly.splice(0);
    state.digest.lastWeekly = now;
    const body = items.slice(0, 3).map((e) => e.message).join(' | ') + (items.length > 3 ? ` | +${items.length - 3} more` : '');
    toast(`Weekly digest: ${items.length} alert${items.length > 1 ? 's' : ''} triggered`);
    notifyBrowser(`Weekly alert digest (${items.length})`, body);
  }
}

async function evaluateAlerts() {
  try {
    const { fired } = await api('api/evaluate', { method: 'POST', body: '{}' });
    for (const f of fired || []) {
      if (state.notified.has(f.entry.id)) continue;
      state.notified.add(f.entry.id);
      const alert = (state.alerts || []).find((a) => a.id === f.alert?.id || a.id === f.entry.alertId);
      const schedule = f.alert?.schedule || alert?.schedule || 'realtime';
      if (schedule === 'realtime') {
        toast(`Alert: ${f.entry.message}`);
        notifyBrowser('Stoploss Alert', f.entry.message);
      } else {
        state.digest[schedule].push(f.entry);
        toast(`${f.entry.message} (queued for ${ALERT_SCHEDULE_LABELS[schedule]} digest)`);
      }
    }
    if (fired?.length) await loadAlerts();
    flushDigests();
  } catch {
    /* server may be restarting */
  }
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
        state.scanJsonCache = null;
        state.histCache.clear();
      }
    } catch {
      /* keep cache */
    }
  }
  const data = await api('api/scan');
  state.settings = data.settings;
  state.scan = data.rows;
  state.scanGeneratedAt = data.generatedAt || null;
  const srcs = data.rows.map((r) => r.quote?.source).filter(Boolean);
  state.scanSource = srcs.length ? srcs.sort((a, b) => srcs.filter((v) => v === a).length - srcs.filter((v) => v === b).length)[0] : null;
  const health = await api('api/health').catch(() => ({}));
  state.demo = !!health.demo;
  $('#demo-badge').classList.toggle('hidden', !state.demo);
  renderStats();
  renderDashboard();
  renderScanner();
  renderSettingsInputs();
  renderStamp();
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

  $('#notify-btn').onclick = async () => {
    if (!('Notification' in window)) return toast('Notifications not supported in this browser');
    const perm = await Notification.requestPermission();
    renderPermStatus();
    toast(perm === 'granted' ? 'Browser notifications enabled' : `Notification permission: ${perm}`);
  };

  $('#test-notify').onclick = async () => {
    if (!('Notification' in window)) return toast('Notifications not supported in this browser');
    if (Notification.permission !== 'granted') {
      await Notification.requestPermission();
      renderPermStatus();
    }
    if (Notification.permission === 'granted') {
      notifyBrowser('Stoploss Alert test', 'This is a test notification. Alerts fire while this page is open.');
      toast('Test notification sent');
    } else {
      toast('Notification permission not granted, nothing sent');
    }
  };

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
      if (kind === 'retry') {
        state.histCache.delete(symbol);
        if (state.mode === 'static') state.scanJsonCache = null;
        toast(`Retrying ${symbol}…`);
        return loadScan();
      }
    }
    const row = e.target.closest('#scan-tbody tr[data-symbol]');
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

  setInterval(() => {
    $('#clock').textContent = new Date().toLocaleTimeString();
    renderStamp();
  }, 1000);
}

async function main() {
  state.mode = await detectMode();
  if (state.mode === 'static') {
    try {
      await indexCache();
      await baseSettings();
    } catch (e) {
      toast(`Static data not found, run: node server/export.js --out public/data`);
    }
  }
  init();
  renderBadgeFilters();
  renderPermStatus();
  await Promise.all([loadSettings(), loadAlerts(), loadSentiment()]);
  await loadScan();
  setInterval(loadScan, 60_000);
  setInterval(loadSentiment, 5 * 60_000);
  setInterval(evaluateAlerts, 30_000);
  setInterval(flushDigests, 30_000);
}

main().catch((e) => toast(`Startup error: ${e.message}`));
