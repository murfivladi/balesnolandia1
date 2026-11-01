import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, parseMoney, changeBreakdown, vatIncluded, DENOMINATIONS } from './money.js';
import { mmYY, parseMmYY } from './time.js';
import { isValidCardNumber, luhnDigit, normalizePassport } from './format.js';

test('formatMoney', () => {
  assert.equal(formatMoney(1250), '12,50 В');
  assert.equal(formatMoney(125000), '1 250,00 В');
  assert.equal(formatMoney(-5), '−0,05 В');
  assert.equal(formatMoney(100000000), '1 000 000,00 В');
});

test('parseMoney', () => {
  assert.equal(parseMoney('12,50'), 1250);
  assert.equal(parseMoney('1 250,5'), 125050);
  assert.equal(parseMoney('7'), 700);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('1,234'), null);
});

test('changeBreakdown greedy is optimal for BF denominations', () => {
  // проверяем оптимальность против ДП на диапазоне
  const N = 3000;
  const best = new Array(N + 1).fill(Infinity); best[0] = 0;
  for (let a = 1; a <= N; a++) for (const d of DENOMINATIONS) if (d <= a) best[a] = Math.min(best[a], best[a - d] + 1);
  for (let a = 0; a <= N; a++) {
    const g = changeBreakdown(a);
    assert.equal(g.reduce((s, x) => s + x.value * x.count, 0), a);
    assert.equal(g.reduce((s, x) => s + x.count, 0), best[a], `amount ${a}`);
  }
});

test('vat', () => {
  assert.equal(vatIncluded(1200, 2000), 200);
  assert.equal(vatIncluded(1000, 0), 0);
});

test('game time and card', () => {
  assert.equal(mmYY(0), '01/01');
  assert.equal(mmYY(13), '02/02');
  assert.equal(parseMmYY('02/02'), 13);
  const base = '77001234567';
  assert.ok(isValidCardNumber(base + luhnDigit(base)));
  assert.equal(normalizePassport('bln 1234 5678'), 'BLN-1234-5678');
});
