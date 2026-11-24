import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sma,
  smaSeries,
  atr,
  annualizedVolatility,
  trailingStop,
  atrStop,
  stopSeries,
  distanceToStopPct,
  statusFor,
  computeSnapshot,
} from '../server/indicators.js';

test('sma computes simple moving average', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2, 3, 4, 5], 2), 4.5);
  assert.equal(sma([1, 2], 5), null);
});

test('smaSeries aligns to the end and pads with null', () => {
  const s = smaSeries([1, 2, 3, 4], 2);
  assert.deepEqual(s, [null, 1.5, 2.5, 3.5]);
});

test('atr of constant ranges equals the range', () => {
  const n = 30;
  const highs = Array.from({ length: n }, (_, i) => 11 + i * 0);
  const lows = Array.from({ length: n }, () => 10);
  const closes = Array.from({ length: n }, () => 10.5);
  assert.ok(Math.abs(atr(highs, lows, closes, 14) - 1) < 1e-9);
});

test('annualizedVolatility is null for short series and positive otherwise', () => {
  assert.equal(annualizedVolatility([1, 2, 3], 30), null);
  const closes = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.001, i));
  const v = annualizedVolatility(closes, 30);
  assert.ok(v > 0 && v < 1);
});

test('trailingStop uses the highest close in the lookback window', () => {
  const closes = [10, 20, 30, 25, 22];
  assert.equal(trailingStop(closes, 5, 10), 27);
  assert.equal(trailingStop(closes, 2, 10), 25 * 0.9);
});

test('atrStop sits below the lookback high by mult*ATR', () => {
  const n = 40;
  const highs = Array.from({ length: n }, () => 105);
  const lows = Array.from({ length: n }, () => 100);
  const closes = Array.from({ length: n }, () => 102);
  const stop = atrStop(highs, lows, closes, 252, 2, 14);
  assert.ok(Math.abs(stop - (105 - 2 * 5)) < 1e-9);
});

test('stopSeries trails the running max', () => {
  const closes = [10, 12, 11, 13, 9];
  const s = stopSeries(closes, 252, 10);
  assert.equal(s[0], 9);
  assert.equal(s[3], 13 * 0.9);
  assert.equal(s[4], 13 * 0.9);
});

test('distanceToStopPct and statusFor', () => {
  assert.equal(distanceToStopPct(100, 90), 10);
  assert.ok(Math.abs(distanceToStopPct(90, 100) - (-100 / 9)) < 1e-9);
  assert.equal(statusFor(-1, 5), 'breached');
  assert.equal(statusFor(3, 5), 'near');
  assert.equal(statusFor(7, 5), 'watch');
  assert.equal(statusFor(20, 5), 'safe');
  assert.equal(statusFor(null, 5), 'unknown');
});

function makeHist(closes) {
  return closes.map((c, i) => ({ t: (i + 1) * 86400000, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }));
}

test('computeSnapshot flags a breached stop after a drop from the high', () => {
  const closes = [
    ...Array.from({ length: 100 }, (_, i) => 100 + i * 0.2),
    120, 121, 122, 123, 124, 125,
    100, 90, 80, 70, 60,
  ];
  const snap = computeSnapshot(makeHist(closes), { stopPct: 15, lookback: 252, threshold: 5, symbol: 'TEST' });
  assert.equal(snap.close, 60);
  assert.equal(snap.high, 125);
  assert.equal(snap.stop, 125 * 0.85);
  assert.ok(snap.dist < 0);
  assert.equal(snap.status, 'breached');
  assert.ok(!snap.badges.includes('safeBuffer'));
  assert.ok(snap.badges.includes('recovered') === false);
});

test('computeSnapshot flags safe buffer and trend badges on a steady uptrend', () => {
  const closes = Array.from({ length: 300 }, (_, i) => 50 * Math.pow(1.002, i));
  const snap = computeSnapshot(makeHist(closes), { stopPct: 15, lookback: 252, threshold: 5, symbol: 'UP' });
  assert.ok(snap.dist > 10, `dist ${snap.dist}`);
  assert.ok(snap.badges.includes('safeBuffer'));
  assert.ok(snap.badges.includes('trend10'));
  assert.ok(snap.badges.includes('aboveMA50'));
  assert.ok(snap.badges.includes('aboveMA200'));
  assert.ok(snap.badges.includes('goldenCross'));
  assert.ok(snap.badges.includes('nearTop'));
  assert.equal(snap.status, 'safe');
});

test('computeSnapshot marks recovered after a dip below stop that rebounds', () => {
  const base = Array.from({ length: 180 }, (_, i) => 100 + i * 0.1);
  const dip = [110, 95];
  const rebound = Array.from({ length: 10 }, (_, i) => 96 + i * 1);
  const closes = [...base, ...dip, ...rebound];
  const snap = computeSnapshot(makeHist(closes), { stopPct: 15, lookback: 252, threshold: 5, symbol: 'REC' });
  assert.ok(snap.badges.includes('recovered'), `badges: ${snap.badges}`);
  assert.ok(snap.dist > 0, `dist ${snap.dist}`);
});

test('computeSnapshot returns null on empty history', () => {
  assert.equal(computeSnapshot([], {}), null);
  assert.equal(computeSnapshot([{ t: 1, c: null }], {}), null);
});
