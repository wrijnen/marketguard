import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlertStore, ALERT_TYPES } from '../server/alerts.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-test-'));
  return new AlertStore(path.join(dir, 'alerts.json'));
}

test('add validates input', () => {
  const store = tmpStore();
  assert.throws(() => store.add({ symbol: '', type: 'below', value: 1 }), /symbol/);
  assert.throws(() => store.add({ symbol: 'AAPL', type: 'nope', value: 1 }), /type/);
  assert.throws(() => store.add({ symbol: 'AAPL', type: 'below', value: 'abc' }), /number/);
  const a = store.add({ symbol: 'aapl', type: 'below', value: '100.5', note: 'x' });
  assert.equal(a.symbol, 'AAPL');
  assert.equal(a.value, 100.5);
  assert.equal(a.state, 'clear');
  assert.ok(ALERT_TYPES.includes(a.type));
});

test('below alert fires once per crossing and re-arms after recovery', async () => {
  const store = tmpStore();
  const a = store.add({ symbol: 'AAPL', type: 'below', value: 100 });
  let price = 110;
  const quoteOf = async () => ({ symbol: 'AAPL', price });
  const snapOf = async () => null;

  let fired = await store.evaluate(quoteOf, snapOf);
  assert.equal(fired.length, 0);

  price = 99;
  fired = await store.evaluate(quoteOf, snapOf);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].alert.state, 'triggered');
  assert.equal(store.state.log.length, 1);
  assert.match(store.state.log[0].message, /dropped below/);

  fired = await store.evaluate(quoteOf, snapOf);
  assert.equal(fired.length, 0, 'should not re-fire while still below');

  price = 105;
  fired = await store.evaluate(quoteOf, snapOf);
  assert.equal(fired.length, 0);
  assert.equal(store.state.alerts[0].state, 'clear');

  price = 98;
  fired = await store.evaluate(quoteOf, snapOf);
  assert.equal(fired.length, 1, 're-arms and fires again');
});

test('stop_breach and near_stop use snapshot stop levels', async () => {
  const store = tmpStore();
  store.add({ symbol: 'X', type: 'stop_breach' });
  store.add({ symbol: 'X', type: 'near_stop', value: 5 });
  const quoteOf = async () => ({ symbol: 'X', price: 90 });
  const snapOf = async () => ({ stop: 92, dist: 2.2 });

  const fired = await store.evaluate(quoteOf, snapOf);
  assert.equal(fired.length, 2);
  const types = fired.map((f) => f.alert.type).sort();
  assert.deepEqual(types, ['near_stop', 'stop_breach']);
  assert.match(fired.find((f) => f.alert.type === 'stop_breach').entry.message, /BREACHED/);
});

test('near_stop does not fire when far from stop', async () => {
  const store = tmpStore();
  store.add({ symbol: 'X', type: 'near_stop', value: 5 });
  const fired = await store.evaluate(
    async () => ({ symbol: 'X', price: 200 }),
    async () => ({ stop: 100, dist: 50 })
  );
  assert.equal(fired.length, 0);
});

test('ack and remove work and persist to disk', () => {
  const store = tmpStore();
  const a = store.add({ symbol: 'MSFT', type: 'above', value: 500 });
  store.ack(a.id);
  assert.equal(store.state.alerts[0].acknowledged, true);
  const reloaded = new AlertStore(store.file);
  assert.equal(reloaded.state.alerts.length, 1);
  assert.equal(reloaded.state.alerts[0].acknowledged, true);
  reloaded.remove(a.id);
  assert.equal(reloaded.state.alerts.length, 0);
  const reloaded2 = new AlertStore(store.file);
  assert.equal(reloaded2.state.alerts.length, 0);
});

test('inactive alerts are skipped', async () => {
  const store = tmpStore();
  const a = store.add({ symbol: 'X', type: 'below', value: 100 });
  a.active = false;
  const fired = await store.evaluate(
    async () => ({ symbol: 'X', price: 1 }),
    async () => null
  );
  assert.equal(fired.length, 0);
});
