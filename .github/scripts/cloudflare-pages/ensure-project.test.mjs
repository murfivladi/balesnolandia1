import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensurePagesProject } from './ensure-project.mjs';

const config = {
  accountId: 'account123',
  apiToken: 'token-should-not-be-logged',
  projectName: 'balesnolandia-test',
};
const project = { name: config.projectName, production_branch: 'main', source: null };
const jsonResponse = (status, body) => new globalThis.Response(JSON.stringify(body), { status });
const success = (status = 200, result = project) => jsonResponse(status, { success: true, result, errors: [] });
const failure = (status, ...codes) => jsonResponse(status, { success: false, result: null, errors: codes.map((code) => ({ code })) });

function mockRequests(...responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, 'Unexpected Cloudflare request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchImpl };
}

function assertNoSecrets(error) {
  assert.ok(!error.message.includes(config.apiToken));
  assert.ok(!error.message.includes(config.accountId));
  assert.ok(!error.message.includes(config.projectName));
  return true;
}

test('reuses an existing Direct Upload project without changing it, including on repeated runs', async () => {
  const mock = mockRequests(success(), success());
  assert.equal(await ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), 'existing');
  assert.equal(await ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), 'existing');
  assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET', 'GET']);
  assert.equal(mock.calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.projectName}`);
  assert.equal(mock.calls[0].options.headers.Authorization, `Bearer ${config.apiToken}`);
});

for (const status of [400, 404]) {
  test(`creates a Direct Upload project after a confirmed ${status}/8000007 absence`, async () => {
    const mock = mockRequests(failure(status, 8000007), success(201));
    assert.equal(await ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), 'created');
    assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET', 'POST']);
    assert.equal(mock.calls[1].url, `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects`);
    assert.deepEqual(JSON.parse(mock.calls[1].options.body), {
      name: config.projectName,
      production_branch: 'main',
    });
    assert.equal(mock.calls[1].options.headers['Content-Type'], 'application/json');
  });
}

test('rejects authentication errors without attempting to create a project or exposing secrets', async () => {
  const mock = mockRequests(failure(403, 10000));
  await assert.rejects(
    ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }),
    (error) => {
      assert.match(error.message, /HTTP 403, код 10000/);
      assert.match(error.message, /Cloudflare Pages: Edit/);
      return assertNoSecrets(error);
    },
  );
  assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET']);
});

test('does not mistake unrelated or ambiguous failures for a missing project', async () => {
  for (const [status, codes] of [[404, [7003]], [404, [10000]], [500, [8000007]], [400, [8000007, 10000]], [200, [8000007]]]) {
    const mock = mockRequests(failure(status, ...codes));
    await assert.rejects(ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), assertNoSecrets);
    assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET']);
  }
});

test('stops when project creation fails instead of ignoring the error', async () => {
  const mock = mockRequests(failure(404, 8000007), failure(403, 10000));
  await assert.rejects(
    ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }),
    (error) => {
      assert.match(error.message, /создание проекта Pages/);
      assert.match(error.message, /код 10000/);
      return assertNoSecrets(error);
    },
  );
  assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET', 'POST']);
});

test('handles a creation race only after rechecking the existing project', async () => {
  const mock = mockRequests(failure(404, 8000007), failure(400, 8000002), success());
  assert.equal(await ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), 'existing');
  assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET', 'POST', 'GET']);
});

test('does not hide a duplicate error if the project still cannot be found', async () => {
  const mock = mockRequests(failure(404, 8000007), failure(409, 8000077), failure(404, 8000007));
  await assert.rejects(
    ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }),
    (error) => {
      assert.match(error.message, /создание проекта Pages/);
      assert.match(error.message, /код 8000077/);
      return assertNoSecrets(error);
    },
  );
  assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET', 'POST', 'GET']);
});

test('does not change or publish to a Git-integrated project or a project with a different production branch', async () => {
  for (const [result, message] of [
    [{ ...project, source: { type: 'github' } }, /Git-интеграцию/],
    [{ ...project, production_branch: 'production' }, /не main/],
    [{ ...project, name: 'another-project' }, /неожиданный проект/],
  ]) {
    const mock = mockRequests(success(200, result));
    await assert.rejects(ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), message);
    assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET']);
  }
});

test('rejects an incompatible project returned after a concurrent creation', async () => {
  const mock = mockRequests(failure(404, 8000007), failure(409, 8000002), success(200, { ...project, source: { type: 'github' } }));
  await assert.rejects(ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), /Git-интеграцию/);
  assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET', 'POST', 'GET']);
});

test('rejects an unexpected configuration returned after project creation', async () => {
  const mock = mockRequests(failure(404, 8000007), success(201, { ...project, production_branch: 'production' }));
  await assert.rejects(ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), /не main/);
  assert.deepEqual(mock.calls.map((call) => call.options.method), ['GET', 'POST']);
});

test('does not expose network errors, malformed responses, or secrets', async () => {
  for (const result of [new Error(`network failure ${config.apiToken}`), new globalThis.Response('bad response', { status: 502 })]) {
    const mock = mockRequests(result);
    await assert.rejects(ensurePagesProject({ ...config, fetchImpl: mock.fetchImpl }), assertNoSecrets);
    assert.equal(mock.calls.length, 1);
  }
});

test('validates required inputs before contacting Cloudflare', async () => {
  for (const overrides of [
    { apiToken: '' },
    { accountId: '../not-an-id' },
    { projectName: 'https://example.invalid' },
  ]) {
    const mock = mockRequests();
    await assert.rejects(ensurePagesProject({ ...config, ...overrides, fetchImpl: mock.fetchImpl }));
    assert.equal(mock.calls.length, 0);
  }
});

test('workflow CLI reads the three environment secrets and creates the project without printing them', () => {
  // A preload replaces fetch completely, so this subprocess never contacts Cloudflare.
  const fakeApi = `
    globalThis.fetch = async (url, options) => {
      const account = process.env.CLOUDFLARE_ACCOUNT_ID;
      const token = process.env.CLOUDFLARE_API_TOKEN;
      const name = process.env.CLOUDFLARE_PAGES_PROJECT;
      const collection = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/pages/projects';
      if (options.headers.Authorization !== 'Bearer ' + token) throw new Error('Unexpected token');
      if (options.method === 'GET' && url === collection + '/' + name) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 8000007 }] }), { status: 404 });
      }
      if (options.method === 'POST' && url === collection) {
        const body = JSON.parse(options.body);
        if (body.name !== name || body.production_branch !== 'main') throw new Error('Unexpected body');
        return new Response(JSON.stringify({ success: true, result: { ...body, source: null } }), { status: 201 });
      }
      throw new Error('Unexpected request');
    };
  `;
  const script = fileURLToPath(new globalThis.URL('./ensure-project.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(fakeApi)}`, script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
      CLOUDFLARE_API_TOKEN: config.apiToken,
      CLOUDFLARE_PAGES_PROJECT: config.projectName,
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Создан проект Cloudflare Pages/);
  assertNoSecrets({ message: child.stdout + child.stderr });
});
