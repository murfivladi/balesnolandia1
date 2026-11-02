// Хостинг без доступа к списку сетевых интерфейсов: Fastify при listen({ host: '0.0.0.0' })
// читает os.networkInterfaces() ради лога адресов. Ошибка из этого вызова вылетает из
// обработчика 'listening' уже после bind и убивает процесс (ERR_SYSTEM_ERROR, errno 97).
// Проверяем, что с обёрткой сервер поднимается и продолжает работать.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import Fastify from 'fastify';
import { patchNetworkInterfaces } from '../src/lib/netinfo.js';

function breakNetworkInterfaces(t) {
  const original = os.networkInterfaces;
  t.after(() => {
    os.networkInterfaces = original;
  });
  os.networkInterfaces = () => {
    const err = new Error('uv_interface_addresses returned Unknown system error 97');
    err.code = 'ERR_SYSTEM_ERROR';
    err.errno = 97;
    throw err;
  };
}

test('os.networkInterfaces() при сбое отдаёт пустой список и жалуется один раз', (t) => {
  breakNetworkInterfaces(t);

  const errors = [];
  assert.equal(patchNetworkInterfaces((err) => errors.push(err)), true);

  assert.deepEqual(os.networkInterfaces(), {}, 'вместо исключения — пустой список интерфейсов');
  assert.equal(errors.length, 1, 'о сбое сообщили один раз');
  assert.equal(errors[0].errno, 97, 'в предупреждение попадает исходная ошибка');

  os.networkInterfaces();
  assert.equal(errors.length, 1, 'повторные вызовы не засоряют журнал');

  assert.equal(patchNetworkInterfaces(() => assert.fail('повторно подменять не нужно')), true, 'подмена идемпотентна');
  assert.deepEqual(os.networkInterfaces(), {});
});

test('listen на 0.0.0.0 не падает, когда os.networkInterfaces() недоступен', async (t) => {
  breakNetworkInterfaces(t);
  patchNetworkInterfaces(() => {});

  const app = Fastify({ logger: false });
  t.after(() => app.close());
  app.get('/', async () => ({ ok: true }));

  // Адрес в логе неизвестен, но сервер слушает.
  assert.equal(await app.listen({ port: 0, host: '0.0.0.0' }), undefined);
  assert.equal(app.server.listening, true);
  assert.equal((await app.inject({ method: 'GET', url: '/' })).json().ok, true);
});
