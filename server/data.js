import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSnapshot } from './indicators.js';
import { demoHistory, demoQuote } from './demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
export const DEMO = !!process.env.DEMO;

const UA = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const memCache = new Map();
function cacheGet(key, ttlMs) {
  const e = memCache.get(key);
  if (e && Date.now() - e.ts < ttlMs) return e.value;
  return null;
}
function cacheSet(key, value) {
  memCache.set(key, { ts: Date.now(), value });
}

export async function httpGet(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const YAHOO_TO_STOOQ = {
  '.AS': '.nl', '.AD': '.nl', '.HE': '.nl', '.AMS': '.nl',
  '.PA': '.pa', '.FP': '.pa',
  '.DE': '.de', '.XETRA': '.de', '.F': '.de', '.BE': '.de', '.MU': '.de', '.HM': '.de',
  '.L': '.l', '.LN': '.l',
  '.SW': '.sw', '.VX': '.sw',
  '.TO': '.to', '.CN': '.to',
  '.AX': '.ax', '.HK': '.hk', '.SS': '.ss', '.SZ': '.sz', '.KS': '.ks',
  '.T': '.t', '.NS': '.ns', '.BO': '.bo',
};

export function yahooToStooq(symbol) {
  const s = String(symbol).toUpperCase();
  for (const [y, st] of Object.entries(YAHOO_TO_STOOQ)) {
    if (s.endsWith(y)) return s.slice(0, -y.length) + st;
  }
  if (s.startsWith('^')) return s.toLowerCase();
  if (s.includes('.')) return s.toLowerCase();
  return s.toLowerCase() + '.us';
}

export function guessCurrency(symbol) {
  const s = String(symbol).toUpperCase();
  if (['.AS', '.AD', '.HE', '.AMS', '.PA', '.FP', '.DE', '.XETRA', '.F', '.BE', '.MU', '.MI', '.MC'].some((x) => s.endsWith(x))) return 'EUR';
  if (s.endsWith('.L') || s.endsWith('.LN')) return 'GBp';
  if (s.endsWith('.SW') || s.endsWith('.VX')) return 'CHF';
  if (s.endsWith('.TO') || s.endsWith('.CN')) return 'CAD';
  return 'USD';
}

async function fetchHistoryYahoo(symbol, range = '2y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const json = JSON.parse(await httpGet(url));
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error('yahoo: no result');
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const adj = r.indicators?.adjclose?.[0]?.adjclose || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const c = adj[i] ?? q.close?.[i];
    if (c == null || !Number.isFinite(c)) continue;
    rows.push({
      t: ts[i] * 1000,
      o: q.open?.[i] ?? c,
      h: q.high?.[i] ?? c,
      l: q.low?.[i] ?? c,
      c,
      v: q.volume?.[i] ?? 0,
    });
  }
  if (!rows.length) throw new Error('yahoo: empty');
  const meta = r.meta || {};
  return {
    rows,
    meta: {
      name: meta.longName || meta.shortName || symbol,
      currency: meta.currency || guessCurrency(symbol),
      exchange: meta.exchangeName || '',
    },
  };
}

async function fetchHistoryStooq(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${yahooToStooq(symbol)}&i=d`;
  const txt = await httpGet(url);
  const lines = txt.trim().split('\n');
  if (lines.length < 2 || !lines[0].startsWith('Date')) throw new Error('stooq: no data');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [d, o, h, l, c, v] = lines[i].split(',');
    const close = parseFloat(c);
    if (!Number.isFinite(close)) continue;
    rows.push({
      t: Date.parse(`${d}T16:00:00Z`),
      o: parseFloat(o) || close,
      h: parseFloat(h) || close,
      l: parseFloat(l) || close,
      c: close,
      v: parseFloat(v) || 0,
    });
  }
  if (!rows.length) throw new Error('stooq: empty');
  return { rows, meta: { name: symbol, currency: guessCurrency(symbol), exchange: '' } };
}

export async function fetchHistory(symbol, range = '2y') {
  if (DEMO) {
    return { rows: demoHistory(symbol), meta: { name: symbol, currency: guessCurrency(symbol), demo: true } };
  }
  const key = `hist:${symbol}`;
  const hit = cacheGet(key, 5 * 60_000);
  if (hit) return hit;
  let out;
  try {
    out = await fetchHistoryYahoo(symbol, range === '5y' ? '5y' : '2y');
  } catch {
    try {
      out = await fetchHistoryStooq(symbol);
    } catch (e2) {
      const err = new Error(`history unavailable for ${symbol} (${e2.message})`);
      err.code = 'UPSTREAM';
      throw err;
    }
  }
  cacheSet(key, out);
  return out;
}

export async function fetchQuote(symbol) {
  if (DEMO) {
    const h = await fetchHistory(symbol, '5d');
    return demoQuote(symbol, h.rows, h.meta.currency);
  }
  const key = `q:${symbol}`;
  const hit = cacheGet(key, 20_000);
  if (hit) return hit;
  let q = null;
  try {
    const txt = await httpGet(`https://stooq.com/q/l/?s=${yahooToStooq(symbol)}&f=sd2t2ohlcv&h&e=csv`, 8000);
    const lines = txt.trim().split('\n');
    const parts = lines[lines.length - 1].split(',');
    const close = parseFloat(parts[6]);
    if (Number.isFinite(close) && close > 0) {
      q = {
        symbol,
        price: close,
        prevClose: close,
        changePct: 0,
        time: `${parts[1] || ''} ${parts[2] || ''}`.trim(),
        currency: guessCurrency(symbol),
      };
    }
  } catch {
    q = null;
  }
  if (!q) {
    const h = await fetchHistory(symbol, '5d');
    const rows = h.rows;
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    if (!last) throw new Error(`quote unavailable for ${symbol}`);
    q = {
      symbol,
      price: last.c,
      prevClose: prev ? prev.c : last.c,
      changePct: prev ? ((last.c - prev.c) / prev.c) * 100 : 0,
      time: new Date(last.t).toISOString(),
      currency: h.meta.currency,
      name: h.meta.name,
    };
  }
  cacheSet(key, q);
  return q;
}

export async function getSnapshot(symbol, settings) {
  const h = await fetchHistory(symbol, '2y');
  const snap = computeSnapshot(h.rows, { ...settings, symbol });
  return { ...snap, meta: h.meta, rows: h.rows };
}

export async function scanUniverse(symbols, settings) {
  const rows = [];
  let idx = 0;
  const concurrency = 4;
  async function worker() {
    while (idx < symbols.length) {
      const sym = symbols[idx++];
      try {
        const snap = await getSnapshot(sym, settings);
        const quote = await fetchQuote(sym).catch(() => null);
        const { rows: histRows, ...snapOut } = snap;
        rows.push({ symbol: sym, quote, snapshot: { ...snapOut, spark: histRows.slice(-60).map((r) => r.c) }, meta: snap.meta });
      } catch (e) {
        rows.push({ symbol: sym, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker()));
  rows.sort((a, b) => {
    const da = a.snapshot?.dist;
    const db = b.snapshot?.dist;
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  });
  return rows;
}

export const RANGE_DAYS = { '1mo': 31, '3mo': 93, '6mo': 183, '1y': 366, '2y': 732, '5y': 1830 };

export function sliceRange(rows, range) {
  const days = RANGE_DAYS[range];
  if (!days) return rows;
  const cutoff = Date.now() - days * 86400000;
  const sliced = rows.filter((r) => r.t >= cutoff);
  return sliced.length >= 30 ? sliced : rows.slice(-Math.min(rows.length, 120));
}
