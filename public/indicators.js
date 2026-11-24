export function sma(values, period) {
  if (!values || values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values || period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function trueRangeSeries(highs, lows, closes) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    const h = highs[i];
    const l = lows[i];
    if (i === 0) {
      out.push(h - l);
      continue;
    }
    out.push(Math.max(h - l, Math.abs(h - closes[i - 1]), Math.abs(l - closes[i - 1])));
  }
  return out;
}

export function atr(highs, lows, closes, period = 14) {
  const tr = trueRangeSeries(highs, lows, closes);
  if (tr.length < period) return null;
  let a = 0;
  for (let i = 0; i < period; i++) a += tr[i];
  a /= period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

export function annualizedVolatility(closes, period = 30) {
  if (!closes || closes.length < period + 1) return null;
  const rets = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0) rets.push(closes[i] / prev - 1);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export function highest(values, lookback) {
  if (!values || !values.length) return null;
  const w = values.slice(-Math.max(1, lookback));
  return Math.max(...w);
}

export function lowest(values, lookback) {
  if (!values || !values.length) return null;
  const w = values.slice(-Math.max(1, lookback));
  return Math.min(...w);
}

export function trailingStop(closes, lookback, pct) {
  const h = highest(closes, lookback);
  return h == null ? null : h * (1 - pct / 100);
}

export function atrStop(highs, lows, closes, lookback, mult, period = 14) {
  const h = highest(highs, lookback);
  const a = atr(highs, lows, closes, period);
  if (h == null || a == null) return null;
  return h - mult * a;
}

export function stopSeries(closes, lookback, pct) {
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const w = closes.slice(Math.max(0, i - lookback + 1), i + 1);
    out[i] = w.length ? Math.max(...w) * (1 - pct / 100) : null;
  }
  return out;
}

export function distanceToStopPct(close, stop) {
  if (stop == null || close == null || close === 0) return null;
  return ((close - stop) / close) * 100;
}

export function statusFor(dist, threshold = 5) {
  if (dist == null || Number.isNaN(dist)) return 'unknown';
  if (dist <= 0) return 'breached';
  if (dist <= threshold) return 'near';
  if (dist <= 10) return 'watch';
  return 'safe';
}

export const BADGES = [
  { key: 'trend20', label: '🚀 3M Uptrend >20%' },
  { key: 'trend10', label: '📈 3M Uptrend >10%' },
  { key: 'nearTop', label: '🎯 Within 10% of Top' },
  { key: 'aboveMA50', label: '📊 >MA50' },
  { key: 'aboveMA200', label: '📉 >MA200' },
  { key: 'goldenCross', label: '✨ Golden Cross' },
  { key: 'lowVol', label: '🍃 Low Vol <30%' },
  { key: 'safeBuffer', label: '🛡️ Safe Buffer >10%' },
  { key: 'recovered', label: '💪 Recovered' },
];

export function computeSnapshot(hist, opts = {}) {
  const rows = (hist || []).filter((r) => r && r.c != null && Number.isFinite(r.c));
  if (!rows.length) return null;
  const closes = rows.map((r) => r.c);
  const highs = rows.map((r) => (r.h != null && Number.isFinite(r.h) ? r.h : r.c));
  const lows = rows.map((r) => (r.l != null && Number.isFinite(r.l) ? r.l : r.c));

  const lookback = opts.lookback ?? 252;
  const stopPct = opts.stopPct ?? 15;
  const atrMult = opts.atrMult ?? 2;
  const threshold = opts.threshold ?? 5;

  const close = closes[closes.length - 1];
  const prevClose = closes.length > 1 ? closes[closes.length - 2] : close;
  const changePct = prevClose ? ((close - prevClose) / prevClose) * 100 : 0;

  const maPeriod200 = Math.min(200, closes.length);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, maPeriod200);
  const ma50series = smaSeries(closes, 50);
  const ma200series = smaSeries(closes, maPeriod200);

  const stop = trailingStop(closes, lookback, stopPct);
  const stopAtr = atrStop(highs, lows, closes, lookback, atrMult, 14);
  const dist = distanceToStopPct(close, stop);
  const distAtr = distanceToStopPct(close, stopAtr);

  const highW = highest(closes, lookback);
  const lowW = lowest(lows, lookback);
  const pctFromHigh = highW ? (close / highW - 1) * 100 : null;
  const ref3m = closes.length > 63 ? closes[closes.length - 64] : closes[0];
  const trend3m = ref3m ? (close / ref3m - 1) * 100 : null;
  const vol = annualizedVolatility(closes, 30);
  const atr14 = atr(highs, lows, closes, 14);
  const atrPct = atr14 != null && close ? (atr14 / close) * 100 : null;

  const stops = stopSeries(closes, lookback, stopPct);
  let breachedRecently = false;
  for (let i = Math.max(0, closes.length - 20); i < closes.length - 1; i++) {
    if (stops[i] != null && closes[i] <= stops[i]) {
      breachedRecently = true;
      break;
    }
  }
  const recovered = breachedRecently && dist != null && dist > 0;

  const badges = [];
  if (trend3m != null && trend3m >= 10) badges.push('trend10');
  if (trend3m != null && trend3m >= 20) badges.push('trend20');
  if (pctFromHigh != null && pctFromHigh >= -10) badges.push('nearTop');
  if (ma50 != null && close >= ma50) badges.push('aboveMA50');
  if (ma200 != null && close >= ma200) badges.push('aboveMA200');
  if (ma50 != null && ma200 != null && ma50 > ma200) badges.push('goldenCross');
  if (vol != null && vol * 100 < 30) badges.push('lowVol');
  if (dist != null && dist >= 10) badges.push('safeBuffer');
  if (recovered) badges.push('recovered');

  return {
    symbol: opts.symbol ?? null,
    asOf: rows[rows.length - 1].t,
    close,
    prevClose,
    changePct,
    ma50,
    ma200,
    ma50series,
    ma200series,
    high: highW,
    low: lowW,
    stop,
    stopAtr,
    dist,
    distAtr,
    pctFromHigh,
    trend3m,
    volPct: vol == null ? null : vol * 100,
    atr14,
    atrPct,
    status: statusFor(dist, threshold),
    threshold,
    badges,
  };
}

export const RANGE_DAYS = { '1mo': 31, '3mo': 93, '6mo': 183, '1y': 366, '2y': 732, '5y': 1830 };

export function sliceRange(rows, range) {
  const days = RANGE_DAYS[range];
  if (!days) return rows;
  const cutoff = Date.now() - days * 86400000;
  const sliced = rows.filter((r) => r.t >= cutoff);
  return sliced.length >= 30 ? sliced : rows.slice(-Math.min(rows.length, 120));
}

export function dataFileName(symbol) {
  return String(symbol).replace(/[^A-Za-z0-9]/g, '_');
}
