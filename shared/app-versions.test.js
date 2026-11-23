import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IOS_APP, isNewer } from './app-versions.js';

const ios = new URL('../ios/VlodBrowser.swiftpm/', import.meta.url);

test('версия iOS-приложения одна и та же на сервере, в Package.swift и Config.swift', () => {
  assert.match(IOS_APP.version, /^\d+\.\d+\.\d+$/);
  const pkg = fs.readFileSync(new URL('Package.swift', ios), 'utf8');
  const cfg = fs.readFileSync(new URL('Core/Config.swift', ios), 'utf8');
  assert.equal(/displayVersion: "([^"]+)"/.exec(pkg)?.[1], IOS_APP.version);
  assert.equal(/bundleVersion: "([^"]+)"/.exec(pkg)?.[1], String(IOS_APP.build));
  assert.equal(/static let version = "([^"]+)"/.exec(cfg)?.[1], IOS_APP.version);
  assert.equal(Number(/static let build = (\d+)/.exec(cfg)?.[1]), IOS_APP.build);
});

test('isNewer сравнивает версии по числам', () => {
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('1.0', '1.0.0'), false);
  assert.equal(isNewer('0.1.0', '0.1.1'), false);
});
