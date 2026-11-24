import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO, fetchHistory, fetchQuote, fetchSentiment, scanUniverse, isCrypto, isIndex } from './data.js';
import { DEFAULT_UNIVERSE, SCAN_UNIVERSE } from './universe.js';
import { dataFileName } from '../public/indicators.js';

export const DEFAULT_EXPORT_SETTINGS = { stopPct: 15, lookback: 252, atrMult: 2, threshold: 5, universe: DEFAULT_UNIVERSE, stops: {} };

function categoryOf(symbol) {
  const s = String(symbol).toUpperCase();
  return isCrypto(s) ? 'crypto' : isIndex(s) ? 'index' : SCAN_UNIVERSE.find((e) => e.symbol === s)?.category || 'stock';
}

function bump(obj, key) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + 1;
}

// Fetch history for every symbol; if a source fails but a previous export file exists,
// reuse it (marked cached) so one broken upstream does not blank the site.
async function exportHistories(out, symbols) {
  const historyBySource = {};
  const errors = [];
  let idx = 0;
  const concurrency = 4;
  async function worker() {
    while (idx < symbols.length) {
      const sym = symbols[idx++];
      const file = path.join(out, 'history', `${dataFileName(sym)}.json`);
      const category = categoryOf(sym);
      try {
        const h = await fetchHistory(sym, '2y', { category });
        fs.writeFileSync(file, JSON.stringify({ symbol: sym, meta: h.meta, rows: h.rows }));
        bump(historyBySource, h.meta.source);
      } catch (e) {
        if (fs.existsSync(file)) {
          try {
            const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
            prev.meta = { ...prev.meta, cached: true, cacheReason: e.message };
            fs.writeFileSync(file, JSON.stringify(prev));
            bump(historyBySource, `${prev.meta.source || 'history'}(cached)`);
            errors.push({ symbol: sym, error: `history fetch failed, reused cached file: ${e.message}` });
            continue;
          } catch {
            /* fall through to error */
          }
        }
        bump(historyBySource, 'error');
        errors.push({ symbol: sym, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker()));
  return { historyBySource, errors };
}

export async function runExport(outDir, settings = DEFAULT_EXPORT_SETTINGS) {
  const out = path.resolve(outDir);
  fs.mkdirSync(path.join(out, 'history'), { recursive: true });
  const generatedAt = new Date().toISOString();

  const scanEntries = [...SCAN_UNIVERSE];
  for (const s of settings.universe || []) {
    if (!scanEntries.some((e) => e.symbol === s)) scanEntries.push({ symbol: s, category: categoryOf(s), region: 'US' });
  }
  const allSymbols = [...new Set(scanEntries.map((e) => e.symbol))];

  const { historyBySource, errors: historyErrors } = await exportHistories(out, allSymbols);

  const scanRows = await scanUniverse(scanEntries, settings);
  const quotesBySource = {};
  const scanErrors = [];
  for (const r of scanRows) {
    if (r.quote?.source) bump(quotesBySource, r.quote.source);
    else bump(quotesBySource, r.quoteError ? 'error' : 'none');
    if (r.error) scanErrors.push({ symbol: r.symbol, error: r.error });
    else if (r.quoteError) scanErrors.push({ symbol: r.symbol, error: `quote: ${r.quoteError}` });
  }

  const trackedSet = new Set(settings.universe || []);
  const trackedRows = scanRows.filter((r) => trackedSet.has(r.symbol));
  const marketRows = scanRows.filter((r) => SCAN_UNIVERSE.some((e) => e.symbol === r.symbol));

  const okSymbols = scanRows.filter((r) => r.snapshot).length;
  const health = {
    generatedAt,
    demo: DEMO,
    totalSymbols: scanRows.length,
    okSymbols,
    status: okSymbols === 0 ? 'failed' : historyErrors.length + scanErrors.length ? 'degraded' : 'ok',
    historyBySource,
    quotesBySource,
    errors: [...historyErrors, ...scanErrors],
  };
  fs.writeFileSync(path.join(out, 'health.json'), JSON.stringify(health, null, 2));

  fs.writeFileSync(
    path.join(out, 'index.json'),
    JSON.stringify(
      {
        generatedAt,
        demo: DEMO,
        symbols: settings.universe,
        scanSymbols: scanEntries.map((e) => e.symbol),
        health: health.status,
        pipeline: {
          quotes: 'CNBC real-time -> Yahoo v7 -> Stooq -> latest session close; crypto via CoinGecko (per-row quote.source, quote.realTime)',
          history: 'Yahoo adjusted close -> Nasdaq API (stocks/etf) -> Stooq; crypto via CoinGecko; indices via proxy ETF scaled to the index level (per-file meta.source)',
          refreshedBy: 'GitHub Actions "Update Pages market data": every 5 min on weekdays 13-22 UTC, every 30 min otherwise, and on pushes to the code branch. Fails loudly (exit 1) when no symbol could be fetched.',
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(out, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(out, 'scan.json'), JSON.stringify({ settings, generatedAt, scope: 'tracked', rows: trackedRows }, null, 2));
  fs.writeFileSync(
    path.join(out, 'scan-all.json'),
    JSON.stringify({ settings, generatedAt, scope: 'all', entries: SCAN_UNIVERSE, rows: marketRows }, null, 2)
  );
  try {
    fs.writeFileSync(path.join(out, 'sentiment.json'), JSON.stringify(await fetchSentiment(), null, 2));
  } catch {
    fs.writeFileSync(path.join(out, 'sentiment.json'), JSON.stringify({ fearGreed: null, vix: null }, null, 2));
  }
  return { out, generatedAt, symbols: (settings.universe || []).length, scanned: scanRows.length, okSymbols, health };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const argVal = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const out = argVal('out', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data'));
  runExport(out)
    .then((r) => {
      console.log(`exported ${r.symbols} tracked + ${r.scanned} scanned (${r.okSymbols} ok, health=${r.health.status}) to ${r.out} (${r.generatedAt})${DEMO ? ' [DEMO]' : ''}`);
      if (r.health.status === 'failed') {
        console.error('export failed loudly: no symbol could be fetched from any source');
        process.exit(1);
      }
    })
    .catch((e) => {
      console.error('export failed:', e.message);
      process.exit(1);
    });
}
