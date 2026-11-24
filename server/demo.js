function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function demoHistory(symbol, days = 420) {
  const rnd = mulberry32(seedOf(symbol));
  const start = 20 + rnd() * 220;
  const drift = (rnd() - 0.45) * 0.0012;
  const vol = 0.008 + rnd() * 0.022;
  let price = start;
  const out = [];
  const now = Date.now();
  for (let i = days; i >= 1; i--) {
    const t = now - i * 86400000;
    const r = (rnd() + rnd() + rnd() - 1.5) * vol + drift;
    const open = price;
    price = Math.max(0.5, price * (1 + r));
    const high = Math.max(open, price) * (1 + rnd() * vol * 0.5);
    const low = Math.min(open, price) * (1 - rnd() * vol * 0.5);
    out.push({ t, o: open, h: high, l: low, c: price, v: Math.floor(1e5 + rnd() * 1e7) });
  }
  return out;
}

export function demoQuote(symbol, hist, currency) {
  const last = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  const rnd = mulberry32((seedOf(symbol) ^ (Date.now() % 100003)) >>> 0);
  const price = last.c * (1 + (rnd() - 0.5) * 0.004);
  return {
    symbol,
    price,
    prevClose: prev ? prev.c : last.c,
    changePct: prev ? ((price - prev.c) / prev.c) * 100 : 0,
    time: new Date().toISOString(),
    currency,
    name: symbol,
    demo: true,
  };
}

export function demoSentiment() {
  const rnd = mulberry32((seedOf('fg') ^ (Date.now() % 100003)) >>> 0);
  let score = 35 + rnd() * 30;
  const history = [];
  const now = Date.now();
  for (let i = 29; i >= 0; i--) {
    score = Math.max(2, Math.min(98, score + (rnd() - 0.5) * 8));
    history.push({ t: now - i * 86400000, score, rating: ratingOf(score) });
  }
  const last = history[history.length - 1];
  return {
    fearGreed: {
      score: last.score,
      rating: last.rating,
      timestamp: new Date().toISOString(),
      previousClose: history[history.length - 2]?.score ?? last.score,
      weekAgo: history[Math.max(0, history.length - 8)]?.score ?? last.score,
      monthAgo: history[0]?.score ?? last.score,
      yearAgo: last.score,
      history,
    },
    vix: { symbol: '^VIX', price: 14 + rnd() * 22, prevClose: 18, changePct: (rnd() - 0.5) * 6, demo: true },
    demo: true,
  };
}

export function ratingOf(score) {
  if (score <= 25) return 'extreme fear';
  if (score <= 45) return 'fear';
  if (score <= 55) return 'neutral';
  if (score <= 75) return 'greed';
  return 'extreme greed';
}
