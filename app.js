import { BADGES, computeEvents, computeSnapshot, dataFileName, sliceRange, stopRuleText } from './indicators.js';

const STATUS_META = {
  safe: { label: 'Safe', cls: 'status-safe' },
  watch: { label: 'Watch', cls: 'status-watch' },
  near: { label: 'Near stop', cls: 'status-near' },
  breached: { label: 'Breached', cls: 'status-breached' },
  check: { label: 'Check data', cls: 'status-check' },
  unknown: { label: 'n/a', cls: 'status-unknown' },
};

const STATUS_ORDER = ['check', 'breached', 'near', 'watch', 'safe'];
const GROUP_LABELS = {
  check: 'Check data (stop >40% from price — possible unadjusted split)',
  breached: 'Breached (at or below stop)',
  near: 'Near stop',
  watch: 'Watch (≤10% above stop)',
  safe: 'Safe (>10% above stop)',
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
const LS_THEME = 'sla_theme';

const state = {
  mode: 'server',
  settings: null,
  scan: [],
  scanAll: [],
  entries: [],
  scanGeneratedAt: null,
  scanSource: null,
  alerts: [],
  log: [],
  sentiment: null,
  filters: new Set(),
  dashFilter: 'all',
  catFilter: 'all',
  regionFilter: 'all',
  detail: null,
  detailRange: '1y',
  notified: new Set(),
  demo: false,
  histCache: new Map(),
  indexCache: null,
  scanJsonCache: null,
  scanAllCache: null,
  baseSettingsCache: null,
  lastGen: null,
  snapSig: null,
  eventsCache: new Map(),
  historyLoaded: false,
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

async function scanAllJsonCache() {
  if (!state.scanAllCache) {
    try {
      state.scanAllCache = await fetchJson('data/scan-all.json');
    } catch {
      state.scanAllCache = await scanJsonCache();
    }
  }
  return state.scanAllCache;
}

function snapSigOf(baseSettings, overrides, universe) {
  return JSON.stringify({
    stopPct: baseSettings.stopPct,
    lookback: baseSettings.lookback,
    atrMult: baseSettings.atrMult,
    threshold: baseSettings.threshold,
    stops: overrides.stops || {},
    universe,
  });
}

function effectiveStopPct(sym) {
  const s = state.settings || {};
  const over = s.stops?.[String(sym).toUpperCase()];
  return Number.isFinite(Number(over)) ? Number(over) : s.stopPct ?? 15;
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

async function staticScan(scope = 'all') {
  const idx = await indexCache();
  const all = await scanAllJsonCache();
  const settings = mergedSettings();
  const overrides = loadLS(LS_SETTINGS, {});
  const universe = settings.universe || idx.symbols || [];
  const rows = (all.rows || []).map((r) => ({ ...r }));
  const sig = snapSigOf(all.settings || settings, overrides, universe);
  if (state.snapSig !== sig) {
    state.snapSig = sig;
    state.histCache.clear();
    state.eventsCache.clear();
    await Promise.all(
      rows.map(async (r) => {
        try {
          const hj = await historyOf(r.symbol);
          const snap = computeSnapshot(hj.rows, { ...settings, stopPct: effectiveStopPct(r.symbol), symbol: r.symbol });
          if (snap) {
            snap.spark = hj.rows.slice(-60).map((x) => x.c);
            r.snapshot = snap;
            r.meta = r.meta || hj.meta;
            delete r.error;
          }
          if (!r.quote) {
            const closes = hj.rows.map((x) => x.c);
            const last = closes[closes.length - 1];
            const prev = closes[closes.length - 2];
            r.quote = {
              symbol: r.symbol,
              price: last,
              prevClose: prev ?? last,
              changePct: prev ? ((last - prev) / prev) * 100 : 0,
              time: new Date(hj.rows[hj.rows.length - 1].t).toISOString(),
              asOf: new Date(hj.rows[hj.rows.length - 1].t).toISOString(),
              currency: hj.meta?.currency,
              name: hj.meta?.name,
              source: `${hj.meta?.source || 'history'}-close`,
              realTime: false,
            };
          }
        } catch {
          if (!r.snapshot && !r.error) r.error = 'no data';
        }
      })
    );
  }
  const byDist = (a, b) => {
    const da = a.snapshot?.dist;
    const db = b.snapshot?.dist;
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  };
  rows.sort(byDist);
  const tracked = rows.filter((r) => universe.includes(r.symbol));
  return { settings, generatedAt: idx.generatedAt, scope, entries: all.entries || null, rows: scope === 'tracked' ? tracked : rows, tracked };
}

function staticValidate(body) {
  const sym = String(body.symbol || '').trim().toUpperCase();
  if (!sym) throw new Error('symbol is required');
  if (!ALERT_TYPES.includes(body.type)) throw new Error('invalid type');
  let val = null;
  if (body.type !== 'stop_breach' && body.type !== 'recovery') {
    val = Number(body.value);
    if (!Number.isFinite(val)) throw new Error('value must be a number');
  }
  return { sym, type: body.type, val, sched: ALERT_SCHEDULES.includes(body.schedule) ? body.schedule : 'realtime' };
}

function staticAlertAdd(body) {
  const { sym, type, val, sched } = staticValidate(body);
  const alert = {
    id: crypto.randomUUID(),
    symbol: sym,
    type: body.type,
    value: val,
    note: String(body.note || ''),
    schedule: sched,
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
  const scanMatch = path.match(/^api\/scan(?:\?(.*))?$/);
  if (scanMatch && method === 'GET') {
    const scope = new URLSearchParams(scanMatch[1] || '').get('scope') === 'tracked' ? 'tracked' : 'all';
    return staticScan(scope);
  }
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
  const patch = path.match(/^api\/alerts\/([^/]+)$/);
  if (patch && method === 'PATCH') {
    const list = loadLS(LS_ALERTS, []);
    const a = list.find((x) => x.id === patch[1]);
    if (!a) throw new Error('alert not found');
    const { sym, type, val, sched } = staticValidate({ symbol: body.symbol ?? a.symbol, type: body.type ?? a.type, value: body.value !== undefined ? body.value : a.value, schedule: body.schedule ?? a.schedule });
    a.symbol = sym;
    a.type = type;
    a.value = val;
    a.schedule = sched;
    if (body.note !== undefined) a.note = String(body.note || '');
    if (body.active !== undefined) a.active = !!body.active;
    if (type !== a.type) {
      a.state = 'clear';
      a.triggeredAt = null;
    }
    saveLS(LS_ALERTS, list);
    return { alert: a };
  }
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

function freshnessLabel(q) {
  if (!q) return '';
  const live = q.realTime ? 'Live' : 'Delayed 15m';
  return `${live}${q.source ? ` · ${q.source}` : ''}`;
}

function curChip(cur) {
  return cur ? `<span class="cur">${esc(cur)}</span>` : '';
}

function currencyOf(r) {
  return r.quote?.currency || r.meta?.currency || 'USD';
}

function priceOf(r) {
  return r.quote?.price ?? r.snapshot?.close;
}

function changeOf(r) {
  return r.quote?.changePct ?? r.snapshot?.changePct;
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

function rowActionsHtml(r, tracked) {
  const trackBtn = tracked
    ? `<button class="icon-btn" data-act="remove" data-symbol="${esc(r.symbol)}" title="Remove from dashboard">remove</button>`
    : `<button class="icon-btn" data-act="track" data-symbol="${esc(r.symbol)}" title="Add to dashboard">track</button>`;
  return `<div class="row-actions">
    <button class="icon-btn" data-act="chart" data-symbol="${esc(r.symbol)}" title="Chart">chart</button>
    <button class="icon-btn" data-act="editstop" data-symbol="${esc(r.symbol)}" title="Edit this symbol's stop %">stop%</button>
    <button class="icon-btn" data-act="alert" data-symbol="${esc(r.symbol)}" title="Set alert">alert</button>
    ${trackBtn}
  </div>`;
}

function errorRowHtml(r, inCard, tracked = true) {
  const msg = r.error ? `No data for this symbol right now (${r.error}). The source may not cover it.` : 'No data for this symbol right now. The quote source may not cover it.';
  const actions = inCard
    ? `<div class="card-actions">
        <button class="btn small" data-act="retry" data-symbol="${esc(r.symbol)}">Retry</button>
        ${tracked ? `<button class="btn small danger" data-act="remove" data-symbol="${esc(r.symbol)}">Remove</button>` : `<button class="btn small primary" data-act="track" data-symbol="${esc(r.symbol)}">Track</button>`}
      </div>`
    : `<div class="row-actions">
        <button class="icon-btn" data-act="retry" data-symbol="${esc(r.symbol)}">retry</button>
        ${tracked ? `<button class="icon-btn" data-act="remove" data-symbol="${esc(r.symbol)}">remove</button>` : `<button class="icon-btn" data-act="track" data-symbol="${esc(r.symbol)}">track</button>`}
      </div>`;
  if (inCard) {
    return `<div class="stock-card" data-symbol="${esc(r.symbol)}" tabindex="0">
      <div class="card-top"><span class="card-symbol">${esc(r.symbol)}</span><span class="card-name">${esc(r.note || '')}</span></div>
      <div class="empty" style="text-align:left;padding:6px 0">${esc(msg)}</div>
      ${actions}
    </div>`;
  }
  return `<tr data-symbol="${esc(r.symbol)}" tabindex="0"><td class="sym">${esc(r.symbol)}</td><td colspan="9" class="muted">${esc(msg)}</td><td>${actions}</td></tr>`;
}

function cardHtml(r, opts = {}) {
  const s = r.snapshot;
  const tracked = opts.tracked ?? (state.settings?.universe || []).includes(r.symbol);
  if (!s) return errorRowHtml(r, true, tracked);
  const q = r.quote || {};
  const price = priceOf(r);
  const chg = changeOf(r);
  const cur = currencyOf(r);
  const st = STATUS_META[s.status] || STATUS_META.unknown;
  const asof = q.asOf || q.time;
  const customStop = state.settings?.stops?.[r.symbol];
  const stopLabel = customStop != null ? `Stop-loss (${customStop}% custom)` : `Stop-loss (${s.stopPctUsed ?? state.settings?.stopPct ?? 15}%)`;
  return `<div class="stock-card status-${s.status}" data-symbol="${esc(r.symbol)}" tabindex="0">
    <div class="card-top">
      <div><span class="card-symbol">${esc(r.symbol)}</span> <span class="card-name">${esc(r.meta?.name || r.note || '')}</span></div>
      <span class="status-chip ${st.cls}">${st.label}</span>
    </div>
    <div class="card-top">
      <div><span class="card-price">${fmtPrice(price, cur)}</span>${curChip(cur)}<div class="card-asof">${asof ? `${freshnessLabel(q)} · ${fmtTime(asof)}` : freshnessLabel(q)}</div></div>
      <span class="chg ${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</span>
    </div>
    <canvas class="spark" data-spark="${esc(r.symbol)}"></canvas>
    <div class="stop-row"><span>${stopLabel} <b>${fmtPrice(s.stop, cur)}</b>${curChip(cur)}</span>
      <span>High <b>${fmtPrice(s.high, cur)}</b></span>
      <button class="icon-btn" data-act="editstop" data-symbol="${esc(r.symbol)}" title="Edit this symbol's stop %">✎</button>
    </div>
    <div class="stop-row"><span>Distance to stop</span>${distCellHtml(s.dist)}</div>
    ${s.status === 'check' ? `<div class="check-note">Stop is more than 40% from price — usually an unadjusted stock split. Prices are split-adjusted automatically; verify the history source.</div>` : ''}
    ${s.splitsAdjusted ? `<div class="check-note dim">${s.splitsAdjusted} split(s) auto-adjusted in history</div>` : ''}
    <div class="badges">${badgeHtml(s.badges)}</div>
    <div class="card-actions">
      <button class="btn small" data-act="chart" data-symbol="${esc(r.symbol)}">Chart</button>
      <button class="btn small" data-act="alert" data-symbol="${esc(r.symbol)}">Alert</button>
      ${tracked
        ? `<button class="btn small danger" data-act="remove" data-symbol="${esc(r.symbol)}">Remove</button>`
        : `<button class="btn small primary" data-act="track" data-symbol="${esc(r.symbol)}">Track</button>`}
    </div>
  </div>`;
}

function tableRowHtml(r, point) {
  const s = r.snapshot;
  const tracked = (state.settings?.universe || []).includes(r.symbol);
  if (!s) return errorRowHtml(r, false, tracked);
  const q = r.quote || {};
  const price = priceOf(r);
  const chg = changeOf(r);
  const cur = currencyOf(r);
  const st = STATUS_META[s.status] || STATUS_META.unknown;
  const rowCls = [point ? 'row-point' : '', s.status === 'breached' ? 'row-breached' : s.status === 'near' ? 'row-near' : s.status === 'check' ? 'row-check' : ''].filter(Boolean).join(' ');
  const asof = q.asOf || q.time;
  const customStop = state.settings?.stops?.[r.symbol];
  return `<tr class="${rowCls}" data-symbol="${esc(r.symbol)}" tabindex="0">
    <td class="sym">${esc(r.symbol)}${r.category ? `<div class="cat">${esc(r.category)}${r.region ? ` · ${esc(r.region)}` : ''}</div>` : ''}</td>
    <td class="name">${esc(r.meta?.name || r.note || '')}</td>
    <td class="num">${fmtPrice(price, cur)}${curChip(cur)}<div class="sub">${asof ? `${freshnessLabel(q)} · ${fmtTime(asof)}` : freshnessLabel(q)}</div></td>
    <td class="num" style="color:${chg >= 0 ? 'var(--safe)' : 'var(--breach)'}">${fmtPct(chg)}</td>
    <td><canvas class="spark-sm" data-spark="${esc(r.symbol)}"></canvas></td>
    <td class="num">${fmtPrice(s.stop, cur)}${customStop != null ? `<div class="sub">${customStop}% custom</div>` : ''}<div class="sub">${curChip(cur)}</div></td>
    <td>${distCellHtml(s.dist)}</td>
    <td><span class="status-chip ${st.cls}">${st.label}</span></td>
    <td><div class="badges">${badgeHtml(s.badges)}</div></td>
    <td>${rowActionsHtml(r, tracked)}</td>
  </tr>`;
}

function paintSparklines(containerSel) {
  $$(containerSel + ' .spark, ' + containerSel + ' .spark-sm').forEach((c) => {
    const row = state.scan.find((r) => r.symbol === c.dataset.spark);
    if (row?.snapshot) drawSparkline(c, row.snapshot.spark, row.snapshot.stop);
  });
}

function statusCounts(rows) {
  const c = { check: 0, breached: 0, near: 0, watch: 0, safe: 0, nodata: 0 };
  for (const r of rows) {
    if (!r.snapshot) c.nodata++;
    else if (c[r.snapshot.status] != null) c[r.snapshot.status]++;
    else c.nodata++;
  }
  return c;
}

function renderStats() {
  const rows = state.scan;
  const c = statusCounts(rows);
  const t = state.settings?.threshold ?? 5;
  const recovered = rows.filter((r) => r.snapshot?.badges.includes('recovered')).length;
  $('#stats-row').innerHTML = `
    <div class="stat-card"><div class="label">Tracked symbols</div><div class="value">${rows.filter((r) => r.snapshot).length}</div></div>
    <div class="stat-card"><div class="label">Breached</div><div class="value" style="color:var(--breach)">${c.breached}</div></div>
    <div class="stat-card"><div class="label">Near stop, within ${t}%</div><div class="value" style="color:var(--near)">${c.near}</div></div>
    <div class="stat-card"><div class="label">Watch, ≤10%</div><div class="value" style="color:var(--muted)">${c.watch}</div></div>
    <div class="stat-card"><div class="label">Safe, over 10%</div><div class="value" style="color:var(--safe)">${c.safe}</div></div>
    <div class="stat-card"><div class="label">Check data</div><div class="value" style="color:var(--check)">${c.check}</div></div>
    <div class="stat-card"><div class="label">Recovered</div><div class="value" style="color:var(--accent-hi)">${recovered}</div></div>`;
}

function renderDashFilters() {
  const c = statusCounts(state.scan);
  const opts = [
    ['all', `All (${state.scan.length})`],
    ['breached', `Breached (${c.breached})`],
    ['near', `Near (${c.near})`],
    ['watch', `Watch (${c.watch})`],
    ['safe', `Safe (${c.safe})`],
    ['check', `Check data (${c.check})`],
  ];
  $('#dash-filters').innerHTML = opts
    .map(([k, label]) => `<button class="filter-chip ${state.dashFilter === k ? 'on' : ''}" data-dfilter="${k}">${esc(label)}</button>`)
    .join('');
}

function renderScanFilters() {
  const cats = [...new Set(state.scanAll.map((r) => r.category || 'stock'))].sort();
  const regions = [...new Set(state.scanAll.map((r) => r.region || 'US'))].sort();
  const catChips = ['all', ...cats].map((k) => `<button class="filter-chip ${state.catFilter === k ? 'on' : ''}" data-cat="${esc(k)}">${k === 'all' ? 'All categories' : esc(k)}</button>`).join('');
  const regChips = ['all', ...regions].map((k) => `<button class="filter-chip ${state.regionFilter === k ? 'on' : ''}" data-region="${esc(k)}">${k === 'all' ? 'All regions' : esc(k)}</button>`).join('');
  $('#scan-cat-filters').innerHTML = catChips;
  $('#scan-region-filters').innerHTML = regChips;
}

function renderDashboard() {
  const grid = $('#cards-grid');
  const rows = state.scan.filter((r) => state.dashFilter === 'all' || r.snapshot?.status === state.dashFilter);
  renderDashFilters();
  if (!state.scan.length) {
    grid.innerHTML = '<div class="empty">Loading the dashboard…</div>';
    return;
  }
  if (!rows.length) {
    grid.innerHTML = '<div class="empty">No positions in this group.</div>';
    return;
  }
  grid.innerHTML = rows.map((r) => cardHtml(r, { tracked: true })).join('');
  paintSparklines('#cards-grid');
}

function renderScanner() {
  const t = state.settings?.threshold ?? 5;
  const tbody = $('#scan-tbody');
  const all = state.scanAll.length ? state.scanAll : state.scan;
  const rows = all.filter((r) => {
    if (state.catFilter !== 'all' && (r.category || 'stock') !== state.catFilter) return false;
    if (state.regionFilter !== 'all' && (r.region || 'US') !== state.regionFilter) return false;
    if (state.filters.size) {
      if (!r.snapshot) return false;
      if (![...state.filters].every((f) => r.snapshot.badges.includes(f))) return false;
    }
    return true;
  });
  const c = statusCounts(all);
  const gen = state.scanGeneratedAt ? `, snapshot ${fmtTime(state.scanGeneratedAt)}` : '';
  $('#scan-summary').textContent =
    `${all.length} scanned — ${c.check} check data, ${c.breached} breached, ${c.near} near stop (≤${t}%), ${c.watch} watch, ${c.safe} safe, ${c.nodata} no data` +
    (rows.length !== all.length ? ` · showing ${rows.length}` : '') +
    ` — sorted closest to stop first${gen}. Same status rules as the Dashboard.`;
  renderScanFilters();
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10"><div class="empty">No matching positions.</div></td></tr>';
    $('#scan-cards').innerHTML = '<div class="empty">No matching positions.</div>';
    return;
  }
  const groups = [];
  for (const st of STATUS_ORDER) {
    const g = rows.filter((r) => r.snapshot?.status === st);
    if (g.length) groups.push({ label: `${GROUP_LABELS[st]} — ${g.length}`, rows: g });
  }
  const errRows = rows.filter((r) => !r.snapshot);
  if (errRows.length) groups.push({ label: `No data — ${errRows.length}`, rows: errRows });
  const firstIdx = rows.findIndex((r) => r.snapshot);
  const rowOf = new Map();
  rows.forEach((r, i) => rowOf.set(r, i));
  tbody.innerHTML = groups
    .map((g) => `<tr class="group-row"><td colspan="10">${esc(g.label)}</td></tr>` + g.rows.map((r) => tableRowHtml(r, rowOf.get(r) === firstIdx)).join(''))
    .join('');
  $('#scan-cards').innerHTML = rows.map((r) => cardHtml(r)).join('');
  paintSparklines('#scan-tbody');
  paintSparklines('#scan-cards');
}

function renderStopRule() {
  const { rule, tooltip } = stopRuleText(state.settings || {});
  for (const id of ['#stop-rule-dash', '#stop-rule-scan']) {
    const el = $(id);
    if (el) {
      el.textContent = rule;
      el.title = tooltip;
    }
  }
}

async function renderHistory() {
  const tbody = $('#hist-tbody');
  const summary = $('#hist-summary');
  const tracked = state.scan.filter((r) => r.snapshot);
  if (!tracked.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty">No tracked symbols yet.</div></td></tr>';
    return;
  }
  tbody.innerHTML = '<tr><td colspan="6"><div class="empty">Loading history…</div></td></tr>';
  const settings = state.settings || {};
  const events = [];
  await Promise.all(
    tracked.map(async (r) => {
      try {
        const cached = state.eventsCache.get(r.symbol);
        let h;
        if (cached && cached.sig === state.snapSig) h = cached.h;
        else {
          h = await api(`api/history/${encodeURIComponent(r.symbol)}?range=2y`);
          state.eventsCache.set(r.symbol, { sig: state.snapSig, h });
        }
        const evs = computeEvents(h.rows, { lookback: settings.lookback ?? 252, stopPct: effectiveStopPct(r.symbol), source: h.meta?.source });
        for (const e of evs) events.push({ ...e, symbol: r.symbol, currency: currencyOf(r) });
      } catch {
        /* skip symbols without history */
      }
    })
  );
  events.sort((a, b) => b.t - a.t);
  const recent = events.slice(0, 300);
  summary.textContent = `${events.length} events in the past year across ${tracked.length} tracked symbols — breaches (close ≤ stop), recoveries (close back above stop) and resets (stop stepped down when the old high aged out of the ${settings.lookback ?? 252}-session window). Source = history provider per symbol.`;
  if (!recent.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty">No breaches, recoveries or resets in the past year.</div></td></tr>';
    return;
  }
  const EVENT_LABEL = { breach: 'Breach', recovery: 'Recovery', reset: 'Reset' };
  const EVENT_TIP = {
    breach: 'Close was at or below the trailing stop on this date',
    recovery: 'Close moved back above the stop after a breach',
    reset: 'Stop stepped down: the old lookback high fell out of the window',
  };
  tbody.innerHTML = recent
    .map(
      (e) => `<tr>
    <td class="num">${esc(fmtTime(e.date))}</td>
    <td class="sym">${esc(e.symbol)}</td>
    <td><span class="event-chip event-${e.type}" title="${esc(EVENT_TIP[e.type] || '')}">${esc(EVENT_LABEL[e.type] || e.type)}</span></td>
    <td class="num">${fmtPrice(e.price, e.currency)}${curChip(e.currency)}</td>
    <td class="num">${fmtPrice(e.stop, e.currency)}</td>
    <td class="muted">${esc(e.source || '')}</td>
  </tr>`
    )
    .join('');
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
            <button class="btn small" data-edit="${esc(a.id)}">Edit</button>
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

function openAlertModal(symbol = '', alert = null) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');
  overlay.classList.remove('hidden');
  const allSyms = [...new Set([...(state.settings?.universe || []), ...state.scanAll.map((r) => r.symbol)])];
  const options = allSyms.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  const editing = !!alert;
  modal.innerHTML = `
    <button class="btn small ghost modal-close" id="modal-close">Close</button>
    <h3>${editing ? 'Edit alert' : 'New alert'}</h3>
    <div class="sub">${state.mode === 'static' ? 'Stored in this browser and checked locally every 30 s while the page is open.' : 'Checked server-side every 60 s; this page shows a toast and sends a browser notification while it is open.'} Rules and the triggered log persist across reloads.</div>
    <div class="form-grid">
      <label>Symbol
        <input id="f-symbol" list="universe-list" value="${esc(editing ? alert.symbol : symbol)}" placeholder="AAPL" />
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
    <div class="form-error hidden" id="f-error"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="f-cancel">Cancel</button>
      <button class="btn primary" id="f-save">${editing ? 'Save changes' : 'Create alert'}</button>
    </div>`;
  const typeSel = $('#f-type');
  const valueWrap = $('#f-value-wrap');
  const errBox = $('#f-error');
  if (editing) {
    typeSel.value = alert.type;
    $('#f-schedule').value = alert.schedule || 'realtime';
    if (alert.value != null) $('#f-value').value = alert.value;
    $('#f-note').value = alert.note || '';
  }
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
    errBox.classList.add('hidden');
    if (!symbol2) {
      errBox.textContent = 'Symbol is required.';
      errBox.classList.remove('hidden');
      return;
    }
    if (type !== 'stop_breach' && type !== 'recovery' && (!value || !Number.isFinite(Number(value)))) {
      errBox.textContent = 'Value must be a number for this alert type (e.g. 150, or 5 for a % distance).';
      errBox.classList.remove('hidden');
      return;
    }
    try {
      const body = JSON.stringify({ symbol: symbol2, type, value, note, schedule });
      if (editing) {
        await api(`api/alerts/${alert.id}`, { method: 'PATCH', body });
        toast(`Alert updated for ${symbol2}`);
      } else {
        await api('api/alerts', { method: 'POST', body });
        toast(`Alert created for ${symbol2}`);
      }
      closeModal();
      await loadAlerts();
    } catch (e) {
      errBox.textContent = `Could not save alert: ${e.message}`;
      errBox.classList.remove('hidden');
    }
  };
}

function openStopModal(symbol) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');
  overlay.classList.remove('hidden');
  const global = state.settings?.stopPct ?? 15;
  const current = state.settings?.stops?.[symbol];
  modal.innerHTML = `
    <button class="btn small ghost modal-close" id="modal-close">Close</button>
    <h3>Stop % for ${esc(symbol)}</h3>
    <div class="sub">Global stop is ${global}%. Set a per-symbol override here; leave empty to use the global value. Persisted with your settings (server: data/settings.json, static site: this browser).</div>
    <div class="form-grid">
      <label class="full">Stop % for ${esc(symbol)} <input id="s-value" type="number" min="1" max="50" step="0.5" value="${current ?? ''}" placeholder="global: ${global}" /></label>
    </div>
    <div class="form-error hidden" id="f-error"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="f-cancel">Cancel</button>
      <button class="btn primary" id="f-save">Save stop</button>
    </div>`;
  $('#modal-close').onclick = closeModal;
  $('#f-cancel').onclick = closeModal;
  $('#f-save').onclick = async () => {
    const errBox = $('#f-error');
    errBox.classList.add('hidden');
    const raw = $('#s-value').value.trim();
    const stops = { ...(state.settings?.stops || {}) };
    if (raw === '') delete stops[symbol];
    else {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 1 || v > 50) {
        errBox.textContent = 'Enter a number between 1 and 50, or leave empty to use the global stop.';
        errBox.classList.remove('hidden');
        return;
      }
      stops[symbol] = v;
    }
    await api('api/settings', { method: 'PUT', body: JSON.stringify({ stops }) });
    toast(raw === '' ? `${symbol} uses the global ${global}% stop` : `${symbol} stop set to ${raw}%`);
    closeModal();
    await loadScan();
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
        state.scanAllCache = null;
        state.histCache.clear();
        state.eventsCache.clear();
        state.snapSig = null;
      }
    } catch {
      /* keep cache */
    }
  }
  const data = await api('api/scan');
  state.settings = data.settings;
  state.entries = data.entries || state.entries;
  state.scanAll = data.rows || [];
  const universe = data.settings?.universe || [];
  state.scan = data.tracked || state.scanAll.filter((r) => universe.includes(r.symbol));
  state.scanGeneratedAt = data.generatedAt || null;
  const srcs = state.scanAll.map((r) => r.quote?.source).filter(Boolean);
  state.scanSource = srcs.length ? srcs.sort((a, b) => srcs.filter((v) => v === a).length - srcs.filter((v) => v === b).length)[0] : null;
  const health = await api('api/health').catch(() => ({}));
  state.demo = !!health.demo;
  $('#demo-badge').classList.toggle('hidden', !state.demo);
  renderStats();
  renderDashboard();
  renderScanner();
  renderStopRule();
  renderSettingsInputs();
  renderStamp();
  if ($('#view-history').classList.contains('active')) renderHistory();
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

function activateTab(view) {
  $$('#tabs .tab').forEach((x) => {
    const on = x.dataset.view === view;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  requestAnimationFrame(() => {
    paintSparklines('#cards-grid');
    paintSparklines('#scan-tbody');
    paintSparklines('#scan-cards');
  });
  if (view === 'history') renderHistory();
}

function initTheme() {
  const saved = loadLS(LS_THEME, null);
  const theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  const btn = $('#theme-toggle');
  if (btn) {
    btn.textContent = theme === 'light' ? 'Dark mode' : 'Light mode';
    btn.title = 'Toggle light/dark theme';
    btn.setAttribute('aria-label', 'Toggle light/dark theme');
  }
}

function init() {
  $$('#tabs .tab').forEach((t) => {
    t.onclick = () => activateTab(t.dataset.view);
  });

  $('#theme-toggle').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    saveLS(LS_THEME, next);
    const btn = $('#theme-toggle');
    btn.textContent = next === 'light' ? 'Dark mode' : 'Light mode';
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      return;
    }
    if (e.target.closest('input, select, textarea, button')) return;
    const tabBar = e.target.closest('#tabs');
    if (tabBar && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const tabs = $$('#tabs .tab');
      const i = tabs.findIndex((t) => t.classList.contains('active'));
      const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      activateTab(tabs[next].dataset.view);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-symbol], .stock-card[data-symbol]')) {
      e.preventDefault();
      openDetail(e.target.dataset.symbol);
    }
  });

  $('#dash-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-dfilter]');
    if (!chip) return;
    state.dashFilter = chip.dataset.dfilter;
    renderDashboard();
  });

  $('#scan-cat-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.catFilter = chip.dataset.cat;
    renderScanner();
  });

  $('#scan-region-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-region]');
    if (!chip) return;
    state.regionFilter = chip.dataset.region;
    renderScanner();
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

  $('#refresh-history').onclick = () => {
    state.eventsCache.clear();
    renderHistory();
  };

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
      if (kind === 'editstop') return openStopModal(symbol);
      if (kind === 'track') {
        const universe = [...(state.settings?.universe || []), symbol].filter((v, i, a) => a.indexOf(v) === i);
        await api('api/settings', { method: 'PUT', body: JSON.stringify({ universe }) });
        toast(`Now tracking ${symbol} on the Dashboard`);
        return loadScan();
      }
      if (kind === 'remove') {
        const universe = (state.settings?.universe || []).filter((s) => s !== symbol);
        await api('api/settings', { method: 'PUT', body: JSON.stringify({ universe }) });
        toast(`Removed ${symbol}`);
        return loadScan();
      }
      if (kind === 'retry') {
        state.histCache.delete(symbol);
        if (state.mode === 'static') {
          state.scanJsonCache = null;
          state.scanAllCache = null;
          state.snapSig = null;
        }
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
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const a = state.alerts.find((x) => x.id === edit.dataset.edit);
      if (a) return openAlertModal(a.symbol, a);
      return;
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
  initTheme();
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
