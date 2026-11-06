import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fqdn, inZone, parentName, ancestry, relativeName, absoluteName, normalizeRdata, soaMinimum, rdataTarget, DnsInputError, humanTtl,
} from './balnet-dns.js';

test('fqdn и иерархия имён', () => {
  assert.equal(fqdn('Bank.BLN'), 'bank.bln.');
  assert.equal(fqdn('bank.bln.'), 'bank.bln.');
  assert.equal(fqdn('.'), '.');
  assert.equal(fqdn('_sip._tcp.bank.bln'), '_sip._tcp.bank.bln.');
  assert.equal(fqdn('-bad.bln'), null);
  assert.equal(fqdn('a..bln'), null);
  assert.equal(fqdn('*.bank.bln'), null);
  assert.equal(fqdn('*.bank.bln', { wildcard: true }), '*.bank.bln.');
  assert.equal(fqdn('банк.bln'), null);
  assert.ok(inZone('www.bank.bln.', 'bank.bln.'));
  assert.ok(inZone('bank.bln.', 'bank.bln.'));
  assert.ok(!inZone('xbank.bln.', 'bank.bln.'));
  assert.ok(inZone('anything.', '.'));
  assert.equal(parentName('a.bln.'), 'bln.');
  assert.equal(parentName('bln.'), '.');
  assert.equal(parentName('.'), null);
  assert.deepEqual(ancestry('a.gov.bln.'), ['a.gov.bln.', 'gov.bln.', 'bln.', '.']);
  assert.equal(relativeName('www.bank.bln.', 'bank.bln.'), 'www');
  assert.equal(relativeName('bank.bln.', 'bank.bln.'), '@');
  assert.equal(absoluteName('www', 'bank.bln.'), 'www.bank.bln.');
  assert.equal(absoluteName('@', 'bank.bln.'), 'bank.bln.');
  assert.equal(absoluteName('mail.bank.bln.', 'bank.bln.'), 'mail.bank.bln.');
  assert.equal(absoluteName('mail.kassa.bln.', 'bank.bln.'), null);
  assert.equal(absoluteName('bln', '.'), 'bln.');
});

test('normalizeRdata', () => {
  assert.equal(normalizeRdata('A', '50.1.0.10'), '50.1.0.10');
  assert.throws(() => normalizeRdata('A', 'ba1::1'), DnsInputError);
  assert.equal(normalizeRdata('AAAA', 'BA1:0001::10'), 'ba1:1::10');
  assert.equal(normalizeRdata('CNAME', 'Bank.bln'), 'bank.bln.');
  assert.equal(normalizeRdata('MX', '10  mx.bank.bln'), '10 mx.bank.bln.');
  assert.throws(() => normalizeRdata('MX', 'mx.bank.bln'), /MX/);
  assert.equal(normalizeRdata('SRV', '10 5 443 web.bank.bln'), '10 5 443 web.bank.bln.');
  assert.equal(normalizeRdata('CAA', '0 ISSUE "ca.gov.bln"'), '0 issue "ca.gov.bln"');
  assert.throws(() => normalizeRdata('CAA', '0 foo "x"'), /CAA/);
  assert.equal(normalizeRdata('TXT', 'v=spf1 -all'), '"v=spf1 -all"');
  assert.equal(normalizeRdata('TXT', '"a b" "c"'), '"a b" "c"');
  assert.equal(normalizeRdata('TXT', 'x'.repeat(300)).split('" "').length, 2);
  assert.throws(() => normalizeRdata('TXT', '"open'), /TXT/);
  const soa = normalizeRdata('SOA', 'a.nic.bln hostmaster.nic.bln 2026110601 7200 3600 1209600 300');
  assert.equal(soa, 'a.nic.bln. hostmaster.nic.bln. 2026110601 7200 3600 1209600 300');
  assert.equal(soaMinimum(soa), 300);
  assert.throws(() => normalizeRdata('HINFO', 'x'), /Неизвестный/);
  assert.equal(rdataTarget({ type: 'MX', data: '10 mx.bank.bln.' }), 'mx.bank.bln.');
  assert.equal(humanTtl(3660), '1 ч 1 мин');
  assert.equal(humanTtl(30), '30 с');
});
