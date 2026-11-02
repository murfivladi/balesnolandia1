import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { guardNetworkInterfaces } from '../src/lib/network.js';

test('при errno 97 os.networkInterfaces() отдаёт loopback вместо падения', () => {
  const original = os.networkInterfaces;
  const originalWarn = console.warn;
  const boom = () => {
    const err = new Error('uv_interface_addresses returned Unknown system error 97');
    err.code = 'ERR_SYSTEM_ERROR';
    err.errno = 97;
    throw err;
  };
  os.networkInterfaces = boom;
  console.warn = () => {};
  try {
    guardNetworkInterfaces();
    const guarded = os.networkInterfaces;
    assert.notEqual(guarded, boom);
    assert.equal(guarded.__blnGuarded, true);
    assert.equal(guarded().lo[0].address, '127.0.0.1');
    assert.equal(guarded().lo[0].family, 'IPv4');
    guardNetworkInterfaces();
    assert.equal(os.networkInterfaces, guarded, 'повторный вызов не оборачивает функцию ещё раз');
  } finally {
    os.networkInterfaces = original;
    console.warn = originalWarn;
  }
});

test('на обычном хостинге остаются реальные сетевые интерфейсы', () => {
  const original = os.networkInterfaces;
  const fake = () => ({ eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }] });
  os.networkInterfaces = fake;
  try {
    guardNetworkInterfaces();
    assert.equal(os.networkInterfaces().eth0[0].address, '10.0.0.5');
  } finally {
    os.networkInterfaces = original;
  }
});
