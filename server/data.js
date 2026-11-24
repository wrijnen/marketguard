import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSnapshot, RANGE_DAYS, sliceRange } from './indicators.js';
import { demoHistory, demoQuote, demoSentiment, ratingOf } from './demo.js';

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

export async function httpGet(url, timeoutMs = 12000, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...UA, ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const NASDAQ_HEADERS = { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };

const ADR_MAP = { SHELL: 'SHEL', HEIA: 'HEINY', INGA: 'ING', AD: 'ADYEY' };

export function nasdaqSymbol(symbol) {
  const s = String(symbol).toUpperCase();
  if (!s.includes('.')) return s;
  const base = s.split('.')[0];
  if (!base) return s;
  return ADR_MAP[base] || base;
}

// Crypto USD pairs resolve through CoinGecko (CoinGecko has no CNBC/Yahoo presence here).
export const CRYPTO_IDS = {
  'BTC-USD': 'bitcoin',
  'ETH-USD': 'ethereum',
  'SOL-USD': 'solana',
  'XRP-USD': 'ripple',
  'ADA-USD': 'cardano',
};
export function isCrypto(symbol) {
  return Object.prototype.hasOwnProperty.call(CRYPTO_IDS, String(symbol).toUpperCase());
}

// Indices quote real-time from CNBC (.SPX etc.). For daily history there is no Nasdaq
// index feed, so fall back to a proxy ETF whose series is rescaled to the index level
// (uniform scaling keeps every percentage and the stop correct in index points).
export const INDEX_YAHOO = { '.SPX': '^GSPC', '.DJI': '^DJI', '.IXIC': '^IXIC', '.VIX': '^VIX' };
export const INDEX_PROXY = { '.SPX': 'SPY', '.DJI': 'DIA', '.IXIC': 'QQQ', '.VIX': 'VIXY' };
export function isIndex(symbol) {
  return Object.prototype.hasOwnProperty.call(INDEX_YAHOO, String(symbol).toUpperCase());
}

export function scaleRowsToPrice(rows, price) {
  const last = rows[rows.length - 1];
  if (!last || !last.c || !price) return rows;
  const k = price / last.c;
  if (!Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-12) return rows;
  return rows.map((r) => ({ ...r, o: r.o != null ? r.o * k : r.o, h: r.h != null ? r.h * k : r.h, l: r.l != null ? r.l * k : r.l, c: r.c * k }));
}

function nasdaqNum(v) {
  return parseFloat(String(v ?? '').replace(/[$,\s]/g, ''));
}

function nasdaqDate(d) {
  const [m, day, y] = String(d).split('/');
  return Date.UTC(Number(y), Number(m) - 1, Number(day), 16);
}

async function fetchHistoryNasdaq(symbol, assetclass = 'stocks') {
  const sym = nasdaqSymbol(symbol);
  const to = new Date();
  const from = new Date(to.getTime() - 2 * 366 * 86400000);
  const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=${assetclass}&fromdate=${fmt(from)}&todate=${fmt(to)}&limit=10000`;
  const j = JSON.parse(await httpGet(url, 15000, NASDAQ_HEADERS));
  const raw = j?.data?.tradesTable?.rows;
  if (!Array.isArray(raw) || !raw.length) throw new Error('nasdaq: empty');
  const rows = raw
    .map((r) => ({ t: nasdaqDate(r.date), o: nasdaqNum(r.open), h: nasdaqNum(r.high), l: nasdaqNum(r.low), c: nasdaqNum(r.close), v: nasdaqNum(r.volume) }))
    .filter((r) => Number.isFinite(r.c) && r.c > 0)
    .sort((a, b) => a.t - b.t);
  if (!rows.length) throw new Error('nasdaq: no valid rows');
  let name = sym;
  try {
    const info = JSON.parse(await httpGet(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=${assetclass}`, 8000, NASDAQ_HEADERS));
    name = info?.data?.companyName || sym;
  } catch {
    /* best effort */
  }
  return { rows, meta: { name, currency: 'USD', exchange: 'Nasdaq', nasdaqSymbol: sym, forSymbol: symbol !== sym ? symbol : undefined, source: 'nasdaq' } };
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
  if (INDEX_YAHOO[s]) return INDEX_YAHOO[s].toLowerCase();
  for (const [y, st] of Object.entries(YAHOO_TO_STOOQ)) {
    if (s.endsWith(y)) return s.slice(0, -y.length) + st;
  }
  if (s.startsWith('^')) return s.toLowerCase();
  if (s.includes('.')) return s.toLowerCase();
  return s.toLowerCase() + '.us';
}

export function guessCurrency(symbol) {
  const s = String(symbol).toUpperCase();
  if (isCrypto(s)) return 'USD';
  if (isIndex(s)) return 'USD';
  if (['.AS', '.AD', '.HE', '.AMS', '.PA', '.FP', '.DE', '.XETRA', '.F', '.BE', '.MU', '.MI', '.MC', '.NL'].some((x) => s.endsWith(x))) return 'EUR';
  if (s.endsWith('.L') || s.endsWith('.LN')) return 'GBp';
  if (s.endsWith('.SW') || s.endsWith('.VX')) return 'CHF';
  if (s.endsWith('.TO') || s.endsWith('.CN')) return 'CAD';
  if (s.endsWith('.T')) return 'JPY';
  if (s.endsWith('.KS')) return 'KRW';
  if (s.endsWith('.NS') || s.endsWith('.BO')) return 'INR';
  if (s.endsWith('.HK')) return 'HKD';
  return 'USD';
}

const CNBC_HEADERS = { Accept: 'application/json', 'User-Agent': UA['User-Agent'] };

function cnbcSymbol(symbol) {
  const s = String(symbol).toUpperCase();
  if (s === '^VIX') return 'VIX';
  return s;
}

function parseCnbcTime(t) {
  if (!t) return null;
  const norm = String(t).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function fetchQuoteCnbc(symbol) {
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(cnbcSymbol(symbol))}`;
  const j = JSON.parse(await httpGet(url, 8000, CNBC_HEADERS));
  const q = j?.FormattedQuoteResult?.FormattedQuote?.[0];
  if (!q || q.code !== 0 || q.last == null || q.last === 'N/A') throw new Error('cnbc: no quote');
  const price = parseFloat(String(q.last).replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) throw new Error('cnbc: bad price');
  const changePct = q.change_pct != null ? parseFloat(String(q.change_pct).replace('%', '')) : null;
  return {
    symbol,
    price,
    prevClose: null,
    changePct,
    time: parseCnbcTime(q.last_time),
    asOf: parseCnbcTime(q.last_time),
    currency: guessCurrency(symbol),
    name: q.name || symbol,
    realTime: q.realTime === true || q.realTime === 'true',
    source: 'cnbc',
  };
}

async function fetchQuoteCoingecko(symbol) {
  const id = CRYPTO_IDS[String(symbol).toUpperCase()];
  const j = JSON.parse(await httpGet(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_last_updated_at=true`, 8000));
  const p = j?.[id]?.usd;
  if (!Number.isFinite(p) || p <= 0) throw new Error('coingecko: no price');
  const updated = j[id].last_updated_at ? new Date(j[id].last_updated_at * 1000).toISOString() : new Date().toISOString();
  return {
    symbol,
    price: p,
    prevClose: null,
    changePct: null,
    time: updated,
    asOf: updated,
    currency: 'USD',
    name: `${symbol} (crypto)`,
    realTime: true,
    source: 'coingecko',
  };
}

async function fetchHistoryCoingecko(symbol) {
  const id = CRYPTO_IDS[String(symbol).toUpperCase()];
  const j = JSON.parse(await httpGet(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=400`, 12000));
  const prices = j?.prices;
  if (!Array.isArray(prices) || !prices.length) throw new Error('coingecko: empty chart');
  const rows = prices
    .filter((p) => Array.isArray(p) && Number.isFinite(p[1]) && p[1] > 0)
    .map((p) => ({ t: p[0], o: p[1], h: p[1], l: p[1], c: p[1], v: 0 }));
  if (!rows.length) throw new Error('coingecko: no valid rows');
  return { rows, meta: { name: `${symbol} (crypto)`, currency: 'USD', exchange: 'CoinGecko', source: 'coingecko' } };
}

async function fetchQuoteYahooV7(symbol) {
  const j = JSON.parse(await httpGet(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`, 8000));
  const q = j?.quoteResponse?.result?.[0];
  const price = q?.regularMarketPrice;
  if (!q || !Number.isFinite(price) || price <= 0) throw new Error('yahoo: no quote');
  const t = q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : new Date().toISOString();
  return {
    symbol,
    price,
    prevClose: Number.isFinite(q.regularMarketPreviousClose) ? q.regularMarketPreviousClose : null,
    changePct: Number.isFinite(q.regularMarketChangePercent) ? q.regularMarketChangePercent : null,
    time: t,
    asOf: t,
    currency: q.currency || guessCurrency(symbol),
    name: q.shortName || q.longName || symbol,
    realTime: true,
    source: 'yahoo',
  };
}

async function fetchHistoryYahoo(symbol, range = '2y') {
  const yahooSym = INDEX_YAHOO[String(symbol).toUpperCase()] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=1d`;
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
      source: 'yahoo',
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
  return { rows, meta: { name: symbol, currency: guessCurrency(symbol), exchange: '', source: 'stooq' } };
}

export async function fetchHistory(symbol, range = '2y', opts = {}) {
  if (DEMO) {
    return { rows: demoHistory(symbol), meta: { name: symbol, currency: guessCurrency(symbol), demo: true, source: 'demo' } };
  }
  const key = `hist:${symbol}:${opts.category || ''}`;
  const hit = cacheGet(key, 5 * 60_000);
  if (hit) return hit;
  const s = String(symbol).toUpperCase();
  const tries = [];
  if (isCrypto(s)) {
    tries.push(['coingecko', () => fetchHistoryCoingecko(s)]);
    tries.push(['yahoo', () => fetchHistoryYahoo(s, range)]);
    tries.push(['stooq', () => fetchHistoryStooq(s)]);
  } else if (isIndex(s)) {
    tries.push(['yahoo', () => fetchHistoryYahoo(s, range)]);
    tries.push(['stooq', () => fetchHistoryStooq(s)]);
    const proxy = INDEX_PROXY[s];
    if (proxy) tries.push([`nasdaq(${proxy})`, () => fetchHistoryNasdaq(proxy, 'etf').then((h) => ({ rows: h.rows, meta: { ...h.meta, name: `${s} (history via ${proxy}, scaled)`, proxy, proxyFor: s, source: 'nasdaq-proxy' } }))]);
  } else {
    tries.push(['yahoo', () => fetchHistoryYahoo(s, range)]);
    tries.push(['nasdaq', () => fetchHistoryNasdaq(s, opts.category === 'etf' ? 'etf' : 'stocks')]);
    tries.push(['stooq', () => fetchHistoryStooq(s)]);
  }
  let lastErr;
  for (const [name, fn] of tries) {
    try {
      const out = await fn();
      cacheSet(key, out);
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error(`history unavailable for ${symbol} (${lastErr?.message || 'all sources failed'})`);
  err.code = 'UPSTREAM';
  throw err;
}

export async function fetchQuote(symbol, opts = {}) {
  if (DEMO) {
    const h = await fetchHistory(symbol, '5d');
    return { ...demoQuote(symbol, h.rows, h.meta.currency), source: 'demo', asOf: new Date().toISOString() };
  }
  const key = `q:${symbol}`;
  const hit = cacheGet(key, 20_000);
  if (hit) return hit;
  const s = String(symbol).toUpperCase();
  const tries = [];
  if (isCrypto(s)) {
    tries.push(['coingecko', () => fetchQuoteCoingecko(s)]);
    tries.push(['yahoo', () => fetchQuoteYahooV7(s)]);
  } else {
    tries.push(['cnbc', () => fetchQuoteCnbc(s)]);
    tries.push(['yahoo', () => fetchQuoteYahooV7(s)]);
    tries.push(['stooq', async () => {
      const txt = await httpGet(`https://stooq.com/q/l/?s=${yahooToStooq(s)}&f=sd2t2ohlcv&h&e=csv`, 8000);
      const lines = txt.trim().split('\n');
      const parts = lines[lines.length - 1].split(',');
      const close = parseFloat(parts[6]);
      if (!Number.isFinite(close) || close <= 0) throw new Error('stooq: no price');
      return {
        symbol,
        price: close,
        prevClose: close,
        changePct: 0,
        time: `${parts[1] || ''} ${parts[2] || ''}`.trim(),
        asOf: new Date().toISOString(),
        currency: guessCurrency(s),
        source: 'stooq',
        realTime: true,
      };
    }]);
  }
  let q = null;
  for (const [, fn] of tries) {
    try {
      q = await fn();
      break;
    } catch {
      q = null;
    }
  }
  if (!q) {
    const h = await fetchHistory(s, '5d', opts);
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
      asOf: new Date(last.t).toISOString(),
      currency: h.meta.currency,
      name: h.meta.name,
      source: `${h.meta.source || 'history'}-close`,
      realTime: false,
    };
  }
  cacheSet(key, q);
  return q;
}

export function effectiveStopPct(symbol, settings) {
  const over = settings?.stops?.[String(symbol).toUpperCase()];
  return Number.isFinite(Number(over)) ? Number(over) : (settings?.stopPct ?? 15);
}

export async function getSnapshot(symbol, settings, opts = {}) {
  const s = String(symbol).toUpperCase();
  const category = opts.category || (isCrypto(s) ? 'crypto' : isIndex(s) ? 'index' : 'stock');
  let h = await fetchHistory(s, '2y', { category });
  let quote = null;
  try {
    quote = await fetchQuote(s, { category });
  } catch {
    quote = null;
  }
  if (h.meta.proxy && quote?.price) {
    h = { rows: scaleRowsToPrice(h.rows, quote.price), meta: h.meta };
  }
  const snap = computeSnapshot(h.rows, { ...settings, stopPct: effectiveStopPct(s, settings), symbol: s });
  return { ...snap, meta: h.meta, rows: h.rows, quote };
}

function sortByDist(rows) {
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

// entries: strings or { symbol, category, region, note }. Quote and history are fetched
// independently so a symbol with a live quote but no history still shows its price.
export async function scanUniverse(entries, settings) {
  const list = (entries || []).map((e) => (typeof e === 'string' ? { symbol: e } : e));
  const rows = [];
  let idx = 0;
  const concurrency = 4;
  async function worker() {
    while (idx < list.length) {
      const entry = list[idx++];
      const sym = String(entry.symbol).toUpperCase();
      const category = entry.category || (isCrypto(sym) ? 'crypto' : isIndex(sym) ? 'index' : 'stock');
      const quote = await fetchQuote(sym, { category }).catch((e) => ({ symbol: sym, error: e.message }));
      let snapshot = null;
      let meta = null;
      let error = null;
      try {
        const snap = await getSnapshot(sym, settings, { category });
        meta = snap.meta;
        snapshot = { ...snap, spark: snap.rows.slice(-60).map((r) => r.c) };
        delete snapshot.rows;
        delete snapshot.quote;
      } catch (e) {
        error = e.message;
      }
      rows.push({ symbol: sym, category, region: entry.region || 'US', note: entry.note || null, quote: quote?.error ? null : quote, quoteError: quote?.error || null, snapshot, meta, error });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()));
  return sortByDist(rows);
}

export { RANGE_DAYS, sliceRange };

export async function fetchSentiment() {
  if (DEMO) return demoSentiment();
  let fg = null;
  try {
    const j = JSON.parse(await httpGet('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', 10000));
    const f = j.fear_and_greed || {};
    const hist = (j.fear_and_greed_historical?.data || [])
      .slice(-60)
      .map((p) => ({ t: p.x, score: p.y, rating: p.rating || ratingOf(p.y) }));
    fg = {
      score: f.score ?? null,
      rating: f.rating || (f.score != null ? ratingOf(f.score) : null),
      timestamp: f.timestamp || null,
      previousClose: f.previous_close ?? null,
      weekAgo: f.previous_1_week ?? null,
      monthAgo: f.previous_1_month ?? null,
      yearAgo: f.previous_1_year ?? null,
      history: hist,
    };
  } catch {
    fg = null;
  }
  let vix = null;
  try {
    vix = await fetchQuote('^VIX');
  } catch {
    vix = null;
  }
  return { fearGreed: fg, vix, demo: false };
}
