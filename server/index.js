import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR,
  DEMO,
  fetchHistory,
  fetchQuote,
  getSnapshot,
  httpGet,
  scanUniverse,
  sliceRange,
} from './data.js';
import { AlertStore } from './alerts.js';
import { DEFAULT_UNIVERSE } from './universe.js';
import { demoSentiment, ratingOf } from './demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const settingsFile = path.join(DATA_DIR, 'settings.json');
const defaultSettings = { stopPct: 15, lookback: 252, atrMult: 2, threshold: 5, universe: DEFAULT_UNIVERSE };

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return { ...defaultSettings, ...parsed, universe: Array.isArray(parsed.universe) && parsed.universe.length ? parsed.universe : defaultSettings.universe };
  } catch {
    return { ...defaultSettings };
  }
}
function saveSettings(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
}
let settings = loadSettings();

const alerts = new AlertStore(path.join(DATA_DIR, 'alerts.json'));

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function runEvaluate() {
  const fired = await alerts.evaluate(
    async (sym) => {
      try {
        return await fetchQuote(sym);
      } catch {
        return null;
      }
    },
    async (sym) => {
      try {
        return await getSnapshot(sym, settings);
      } catch {
        return null;
      }
    }
  );
  return fired.map((f) => ({ alert: f.alert, entry: f.entry }));
}

async function getSentiment() {
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

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (p.startsWith('/api/')) {
      if (p === '/api/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, demo: DEMO, time: new Date().toISOString() });
      }
      if (p === '/api/settings' && req.method === 'GET') return send(res, 200, settings);
      if (p === '/api/settings' && req.method === 'PUT') {
        const body = await readBody(req);
        const next = { ...settings };
        for (const k of ['stopPct', 'lookback', 'atrMult', 'threshold']) {
          if (body[k] != null && Number.isFinite(Number(body[k]))) next[k] = Number(body[k]);
        }
        if (Array.isArray(body.universe)) {
          const cleaned = [...new Set(body.universe.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
          if (cleaned.length) next.universe = cleaned;
        }
        settings = next;
        saveSettings(settings);
        return send(res, 200, settings);
      }
      if (p === '/api/scan' && req.method === 'GET') {
        const rows = await scanUniverse(settings.universe, settings);
        return send(res, 200, { settings, generatedAt: new Date().toISOString(), rows });
      }
      if (p === '/api/quote' && req.method === 'GET') {
        const syms = (u.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const quotes = [];
        for (const s of syms) {
          try {
            quotes.push(await fetchQuote(s));
          } catch (e) {
            quotes.push({ symbol: s, error: e.message });
          }
        }
        return send(res, 200, { quotes });
      }
      if (p.startsWith('/api/history/') && req.method === 'GET') {
        const sym = decodeURIComponent(p.slice('/api/history/'.length));
        const range = u.searchParams.get('range') || '1y';
        const h = await fetchHistory(sym, '2y');
        return send(res, 200, { symbol: sym, meta: h.meta, range, rows: sliceRange(h.rows, range) });
      }
      if (p === '/api/sentiment' && req.method === 'GET') return send(res, 200, await getSentiment());
      if (p === '/api/alerts' && req.method === 'GET') {
        return send(res, 200, { alerts: alerts.state.alerts, log: alerts.state.log });
      }
      if (p === '/api/alerts' && req.method === 'POST') {
        const body = await readBody(req);
        const a = alerts.add(body);
        return send(res, 201, a);
      }
      if (p === '/api/evaluate' && req.method === 'POST') {
        return send(res, 200, { fired: await runEvaluate() });
      }
      const mAck = p.match(/^\/api\/alerts\/([^/]+)\/ack$/);
      if (mAck && req.method === 'POST') return send(res, 200, { alert: alerts.ack(mAck[1]) });
      const mDel = p.match(/^\/api\/alerts\/([^/]+)$/);
      if (mDel && req.method === 'DELETE') {
        alerts.remove(mDel[1]);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end('method not allowed');
    }
    return serveStatic(req, res, p);
  } catch (e) {
    return send(res, e.statusCode || 500, { error: e.message });
  }
});

setInterval(() => {
  if (alerts.state.alerts.some((a) => a.active)) {
    runEvaluate().catch(() => {});
  }
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`StopLoss Alert dashboard listening on http://${HOST}:${PORT}${DEMO ? ' (DEMO mode: synthetic data)' : ''}`);
});

export { server };
