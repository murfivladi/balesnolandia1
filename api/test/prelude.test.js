// Окружение server.js (prelude) в настоящем QuickJS, без базы: URL и URLSearchParams ведут себя как в браузере.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { PRELUDE } from '../src/lib/vhost/prelude.js';

async function evalInSite(code) {
  const vm = (await newQuickJSWASMModuleFromVariant(variant)).newContext();
  try {
    for (const n of ['__log', '__db', '__kv', '__fetch', '__now']) {
      const f = vm.newFunction(n, () => vm.undefined);
      vm.setProp(vm.global, n, f);
      f.dispose();
    }
    vm.unwrapResult(vm.evalCode(PRELUDE)).dispose();
    const h = vm.unwrapResult(vm.evalCode(code));
    const v = vm.dump(h);
    h.dispose();
    return v;
  } finally {
    vm.dispose();
  }
}

test('URL: изменения searchParams попадают в href и toString (адрес входа OAuth)', async () => {
  const r = await evalInSite(`
    var u = new URL('https://gosuslugi.gov.bln/oauth/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', 'cl_AbC');
    u.searchParams.set('redirect_uri', 'https://vlodmarket.shop/auth/callback');
    u.searchParams.set('scope', 'openid profile age');
    var v = new URL('https://a.bln/x?a=1&b=2#h'); v.searchParams.set('a', '9'); v.searchParams.delete('b');
    var w = new URL('https://a.bln/p/q?x=1'); w.search = 'y=2';
    [u.toString(), v.href, w.href, w.searchParams.get('y'), new URL('?n=1', 'https://a.bln/p/q').href, new URL('r', 'https://a.bln/p/q').href,
     String(new URLSearchParams({ a: '1 2' })), JSON.stringify({ u: new URL('https://a.bln') })]`);
  assert.deepEqual(r, [
    'https://gosuslugi.gov.bln/oauth/authorize?response_type=code&client_id=cl_AbC&redirect_uri=https%3A%2F%2Fvlodmarket.shop%2Fauth%2Fcallback&scope=openid+profile+age',
    'https://a.bln/x?a=9#h',
    'https://a.bln/p/q?y=2',
    '2',
    'https://a.bln/p/q?n=1',
    'https://a.bln/p/r',
    'a=1+2',
    '{"u":"https://a.bln/"}',
  ]);
});
