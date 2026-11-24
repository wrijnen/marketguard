import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEMO = '1';
const { runExport, DEFAULT_EXPORT_SETTINGS } = await import('../server/export.js');
const { dataFileName } = await import('../public/indicators.js');

test('runExport writes static site data (demo mode)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-export-'));
  const settings = { ...DEFAULT_EXPORT_SETTINGS, universe: ['AAPL', 'ASML.AS'] };
  const res = await runExport(out, settings);
  assert.equal(res.symbols, 2);

  const index = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.symbols, ['AAPL', 'ASML.AS']);
  assert.equal(index.demo, true);

  const settingsOut = JSON.parse(fs.readFileSync(path.join(out, 'settings.json'), 'utf8'));
  assert.equal(settingsOut.stopPct, 15);

  const scan = JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8'));
  assert.equal(scan.rows.length, 2);
  const withSnap = scan.rows.filter((r) => r.snapshot);
  assert.equal(withSnap.length, 2);
  for (const r of withSnap) {
    assert.ok(r.snapshot.stop > 0);
    assert.ok(r.snapshot.dist != null);
    assert.ok(Array.isArray(r.snapshot.spark));
  }

  const hist = JSON.parse(fs.readFileSync(path.join(out, 'history', `${dataFileName('ASML.AS')}.json`), 'utf8'));
  assert.equal(hist.symbol, 'ASML.AS');
  assert.ok(hist.rows.length > 300);
  assert.equal(hist.meta.currency, 'EUR');

  const sentiment = JSON.parse(fs.readFileSync(path.join(out, 'sentiment.json'), 'utf8'));
  assert.ok(sentiment.fearGreed.score >= 0 && sentiment.fearGreed.score <= 100);

  fs.rmSync(out, { recursive: true, force: true });
});
