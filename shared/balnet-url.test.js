import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInput, normalizeUrl, splitUrl, resolveTarget, govAppPath, govUrlFromApp, displayUrl, searchUrl, NEW_TAB, searchQuery, appPath,
} from './balnet-url.js';

test('parseInput: домены, схемы, поиск', () => {
  assert.equal(parseInput(''), null);
  assert.equal(parseInput('   '), null);
  assert.equal(parseInput('bank.bln'), 'https://bank.bln/');
  assert.equal(parseInput('Bank.BLN/cards'), 'https://bank.bln/cards');
  assert.equal(parseInput('http://kassa.bln'), 'http://kassa.bln/');
  assert.equal(parseInput('https://gosuslugi.gov.bln/passport?x=1#a'), 'https://gosuslugi.gov.bln/passport?x=1#a');
  assert.equal(parseInput('balnet://history'), 'balnet://history/');
  assert.equal(parseInput('BALNET://Settings/'), 'balnet://settings/');
  assert.equal(parseInput('10.0.0.1/x'), 'https://10.0.0.1/x');
  assert.equal(parseInput('купить хлеб'), searchUrl('купить хлеб'));
  assert.equal(parseInput('влодбанк'), searchUrl('влодбанк'));
  assert.equal(parseInput('bank'), searchUrl('bank'));
  assert.equal(parseInput('ftp://x.bln'), searchUrl('ftp://x.bln'));
});

test('normalizeUrl и splitUrl', () => {
  assert.equal(normalizeUrl('https://BANK.bln'), 'https://bank.bln/');
  assert.equal(normalizeUrl('https://'), null);
  assert.equal(normalizeUrl('mailto:x'), null);
  assert.deepEqual(splitUrl('https://bank.bln/cards?a=1'), { scheme: 'https', host: 'bank.bln', path: '/cards?a=1' });
  assert.deepEqual(splitUrl('balnet://newtab/'), { scheme: 'balnet', host: 'newtab', path: '/' });
  assert.deepEqual(splitUrl('https://x.bln'), { scheme: 'https', host: 'x.bln', path: '/' });
});

test('resolveTarget', () => {
  assert.deepEqual(resolveTarget('balnet://history/'), { kind: 'internal', page: 'history', path: '/' });
  assert.equal(resolveTarget('balnet://nope/').code, 'ERR_INVALID_URL');
  assert.equal(resolveTarget(NEW_TAB).page, 'newtab');
  assert.equal(resolveTarget('balnet://terminal/').page, 'terminal');
  assert.deepEqual(resolveTarget('https://bank.bln/cards'), { kind: 'web', scheme: 'https', host: 'bank.bln', path: '/cards' });
  assert.deepEqual(resolveTarget('http://bank.bln/x'), { kind: 'upgrade', url: 'https://bank.bln/x' });
  assert.equal(resolveTarget('http://poisk.bln/?q=1').kind, 'upgrade');
  assert.deepEqual(resolveTarget('http://vasya.bln/'), { kind: 'web', scheme: 'http', host: 'vasya.bln', path: '/' });
  assert.equal(searchQuery('/?q=a%20b'), 'a b');
  assert.equal(searchQuery(new URL(searchUrl('купить хлеб')).pathname + new URL(searchUrl('купить хлеб')).search), 'купить хлеб');
  assert.equal(appPath('bank', '/cards?id=1#x'), 'bank/#/cards?id=1');
});

test('госсайты ↔ пути приложений', () => {
  assert.equal(govAppPath('bank.bln', '/'), 'bank/#/');
  assert.equal(govAppPath('bank.bln', '/cards?id=2'), 'bank/#/cards?id=2');
  assert.equal(govAppPath('kassa.bln', '/x#frag'), 'pos/#/x');
  assert.equal(govAppPath('vasya.bln', '/'), null);
  assert.equal(govUrlFromApp('bank', '#/cards'), 'https://bank.bln/cards');
  assert.equal(govUrlFromApp('services', ''), 'https://gosuslugi.gov.bln/');
  assert.equal(govUrlFromApp('pos', 'shop/1'), 'https://kassa.bln/shop/1');
  assert.equal(govUrlFromApp('admin', '#/'), null);
  for (const [host, path] of [['bank.bln', '/a/b?c=1'], ['kassa.bln', '/'], ['gosuslugi.gov.bln', '/passport']]) {
    const [app, hash] = govAppPath(host, path).split('/#');
    assert.equal(govUrlFromApp(app, `#${hash}`), `https://${host}${path}`);
  }
});

test('displayUrl', () => {
  assert.equal(displayUrl(NEW_TAB), '');
  assert.equal(displayUrl('https://bank.bln/'), 'bank.bln');
  assert.equal(displayUrl('https://bank.bln/cards'), 'bank.bln/cards');
  assert.equal(displayUrl('http://x.bln/'), 'http://x.bln');
  assert.equal(displayUrl('balnet://history/'), 'balnet://history');
});
