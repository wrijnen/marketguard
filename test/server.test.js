import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let tmpDataDir;

async function waitUp(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start in time');
}

test.before(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-data-'));
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DEMO: '1', DATA_DIR: tmpDataDir },
    stdio: 'ignore',
  });
  await waitUp();
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  if (tmpDataDir) fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

test('health endpoint reports demo mode', async () => {
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.demo, true);
});

test('scan returns sorted snapshots with stop levels and badges', async () => {
  const res = await fetch(`${BASE}/api/scan`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.rows.length >= 5);
  const withSnap = body.rows.filter((r) => r.snapshot);
  assert.ok(withSnap.length >= 5);
  for (const r of withSnap) {
    assert.ok(r.snapshot.stop > 0, `${r.symbol} stop`);
    assert.ok(r.snapshot.dist != null, `${r.symbol} dist`);
    assert.ok(Array.isArray(r.snapshot.badges));
    assert.ok(Array.isArray(r.snapshot.spark));
    assert.ok(r.quote?.price > 0, `${r.symbol} quote`);
  }
  const dists = withSnap.map((r) => r.snapshot.dist);
  const sorted = [...dists].sort((a, b) => a - b);
  assert.deepEqual(dists, sorted, 'sorted closest-to-stop first');
});

test('history endpoint serves chart rows', async () => {
  const res = await fetch(`${BASE}/api/history/AAPL?range=3mo`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.rows.length > 20);
  assert.ok(body.meta);
});

test('sentiment endpoint works in demo mode', async () => {
  const res = await fetch(`${BASE}/api/sentiment`);
  const body = await res.json();
  assert.ok(body.fearGreed.score >= 0 && body.fearGreed.score <= 100);
  assert.ok(Array.isArray(body.fearGreed.history));
});

test('settings can be updated and persist', async () => {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stopPct: 20, threshold: 7, universe: ['AAPL', 'MSFT'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stopPct, 20);
  assert.equal(body.threshold, 7);
  assert.deepEqual(body.universe, ['AAPL', 'MSFT']);
  const scan = await (await fetch(`${BASE}/api/scan`)).json();
  assert.equal(scan.rows.length, 2);
});

test('alert CRUD + evaluation flow', async () => {
  const created = await (
    await fetch(`${BASE}/api/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', type: 'above', value: 1e12 }),
    })
  ).json();
  assert.ok(created.id);

  const list = await (await fetch(`${BASE}/api/alerts`)).json();
  assert.ok(list.alerts.some((a) => a.id === created.id));

  const evalRes = await fetch(`${BASE}/api/evaluate`, { method: 'POST', body: '{}' });
  const evalBody = await evalRes.json();
  assert.equal(evalBody.fired.length, 0, 'price will never exceed 1e12');

  const bad = await fetch(`${BASE}/api/alerts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'AAPL', type: 'below' }),
  });
  assert.equal(bad.status, 400);

  await fetch(`${BASE}/api/alerts/${created.id}/ack`, { method: 'POST', body: '{}' });
  const list2 = await (await fetch(`${BASE}/api/alerts`)).json();
  assert.equal(list2.alerts.find((a) => a.id === created.id).acknowledged, true);

  const del = await fetch(`${BASE}/api/alerts/${created.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const list3 = await (await fetch(`${BASE}/api/alerts`)).json();
  assert.ok(!list3.alerts.some((a) => a.id === created.id));
});

test('static index is served', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Stoploss Alert/i);
});

test('unknown api route returns 404 json', async () => {
  const res = await fetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
});
