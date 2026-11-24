import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO, fetchHistory, fetchQuote, fetchSentiment, scanUniverse } from './data.js';
import { DEFAULT_UNIVERSE } from './universe.js';
import { dataFileName } from '../public/indicators.js';

export const DEFAULT_EXPORT_SETTINGS = { stopPct: 15, lookback: 252, atrMult: 2, threshold: 5, universe: DEFAULT_UNIVERSE };

export async function runExport(outDir, settings = DEFAULT_EXPORT_SETTINGS) {
  const out = path.resolve(outDir);
  fs.mkdirSync(path.join(out, 'history'), { recursive: true });
  const generatedAt = new Date().toISOString();

  const rows = [];
  for (const sym of settings.universe) {
    try {
      const h = await fetchHistory(sym, '2y');
      fs.writeFileSync(
        path.join(out, 'history', `${dataFileName(sym)}.json`),
        JSON.stringify({ symbol: sym, meta: h.meta, rows: h.rows })
      );
      const quote = await fetchQuote(sym).catch(() => null);
      rows.push({ symbol: sym, quote, meta: h.meta });
    } catch (e) {
      rows.push({ symbol: sym, error: e.message });
    }
  }

  const scan = await scanUniverse(settings.universe, settings);
  const bySymbol = new Map(scan.map((r) => [r.symbol, r]));
  const merged = rows.map((r) => ({ ...r, snapshot: bySymbol.get(r.symbol)?.snapshot, error: r.error || bySymbol.get(r.symbol)?.error }));

  fs.writeFileSync(
    path.join(out, 'index.json'),
    JSON.stringify(
      {
        generatedAt,
        demo: DEMO,
        symbols: settings.universe,
        pipeline: {
          quotes: 'stooq live -> cnbc real-time -> latest session close (per-row quote.source)',
          history: 'yahoo -> nasdaq -> stooq (first success wins, per-file meta.source)',
          refreshedBy: 'GitHub Actions "Update Pages market data", every 5 min on weekdays 13-22 UTC, every 30 min otherwise, and on pushes',
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(out, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(out, 'scan.json'), JSON.stringify({ settings, generatedAt, rows: merged }, null, 2));
  try {
    fs.writeFileSync(path.join(out, 'sentiment.json'), JSON.stringify(await fetchSentiment(), null, 2));
  } catch {
    fs.writeFileSync(path.join(out, 'sentiment.json'), JSON.stringify({ fearGreed: null, vix: null }, null, 2));
  }
  return { out, generatedAt, symbols: settings.universe.length };
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
    .then((r) => console.log(`exported ${r.symbols} symbols to ${r.out} (${r.generatedAt})${DEMO ? ' [DEMO]' : ''}`))
    .catch((e) => {
      console.error('export failed:', e.message);
      process.exit(1);
    });
}
