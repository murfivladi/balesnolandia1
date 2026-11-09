import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, buildQr, parseImport, QR_MAX } from './browser-export.js';

test('экспорт ВлодБраузера: файл и QR разбираются обратно', () => {
  const bookmarks = Array.from({ length: 200 }, (_, i) => ({ url: `https://site${i}.bln/путь`, title: `Сайт ${i}` }));
  const file = buildExport({ bookmarks, history: [{ url: 'https://bank.bln/', title: 'ВлодБанк', ts: 5 }], settings: { home: 'https://bank.bln/', neverSave: ['https://x.bln'] } });
  const back = parseImport(JSON.stringify(file));
  assert.equal(back.bookmarks.length, 200);
  assert.equal(back.history[0].ts, 5);
  assert.deepEqual(back.settings.neverSave, ['https://x.bln']);

  const qr = buildQr(bookmarks);
  assert.ok(qr.count > 5 && qr.count < 200, 'в QR — только то, что влезает');
  assert.ok(new TextEncoder().encode(qr.text).length <= QR_MAX);
  const fromQr = parseImport(qr.text);
  assert.equal(fromQr.bookmarks.length, qr.count);
  assert.equal(fromQr.bookmarks[0].title, 'Сайт 0');

  assert.equal(parseImport('{"format":"other"}'), null);
  assert.equal(parseImport('мусор'), null);
  assert.equal(parseImport('VBX1:{"b":[["javascript:alert(1)","x"]]}').bookmarks.length, 0, 'только http(s)');
});
