import test from 'node:test';
import assert from 'node:assert/strict';
import { isIPv4, isIPv6, normalizeIP, parseCidr, inCidr, nthIp, longestMatch, reverseName, ipToBig, bigToIp } from './balnet-ip.js';

test('isIPv4 / isIPv6', () => {
  assert.ok(isIPv4('50.1.0.10'));
  assert.ok(!isIPv4('256.1.1.1'));
  assert.ok(!isIPv4('01.1.1.1'));
  assert.ok(!isIPv4('1.1.1'));
  assert.ok(isIPv6('ba1:1::10'));
  assert.ok(isIPv6('::1'));
  assert.ok(isIPv6('::'));
  assert.ok(isIPv6('::ffff:50.1.0.10'));
  assert.ok(isIPv6('2001:db8:0:0:0:0:0:1'));
  assert.ok(!isIPv6('1::2::3'));
  assert.ok(!isIPv6('12345::'));
  assert.ok(!isIPv6('1:2:3:4:5:6:7:8:9'));
  assert.ok(!isIPv6('bank.bln'));
});

test('normalizeIP', () => {
  assert.equal(normalizeIP('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(normalizeIP('ba1:0001:0:0::10'), 'ba1:1::10');
  assert.equal(normalizeIP('1:0:0:2:0:0:0:3'), '1:0:0:2::3');
  assert.equal(normalizeIP('1:0:2:3:4:5:6:7'), '1:0:2:3:4:5:6:7');
  assert.equal(normalizeIP('::'), '::');
  assert.equal(normalizeIP('x'), null);
});

test('CIDR', () => {
  const c = parseCidr('60.1.0.0/16');
  assert.equal(c.prefix, 16);
  assert.equal(c.size, 65536n);
  assert.equal(parseCidr('60.1.0.1/16'), null, 'адрес не начало сети');
  assert.equal(parseCidr('60.1.0.0/33'), null);
  assert.ok(inCidr('60.1.255.255', '60.1.0.0/16'));
  assert.ok(!inCidr('60.2.0.0', '60.1.0.0/16'));
  assert.ok(inCidr('ba1:1::10', 'ba1:1::/32'));
  assert.ok(!inCidr('ba1:1::10', '60.1.0.0/16'));
  assert.equal(nthIp('60.1.0.0/16', 256 + 5), '60.1.1.5');
  assert.equal(nthIp('60.1.0.0/30', 4), null);
  assert.equal(nthIp('ba1:1::/32', 16), 'ba1:1::10');
  const blocks = [{ cidr: '50.0.0.0/8', id: 1 }, { cidr: '50.1.0.0/16', id: 2 }];
  assert.equal(longestMatch('50.1.0.10', blocks).id, 2);
  assert.equal(longestMatch('50.9.0.10', blocks).id, 1);
  assert.equal(longestMatch('70.0.0.1', blocks), null);
  const b = ipToBig('50.1.0.10');
  assert.equal(bigToIp(b.value, b.bits), '50.1.0.10');
});

test('reverseName', () => {
  assert.equal(reverseName('50.1.0.10'), '10.0.1.50.in-addr.arpa.');
  assert.ok(reverseName('ba1::1').endsWith('.1.a.b.0.ip6.arpa.'));
});
