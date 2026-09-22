/**
 * Whole-plugin behaviour: the snapshot the panel reads, the routes it calls, the
 * console-token store, and the promise that nothing is written to disk.
 */

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { looksLikeConsoleToken, resolveConfig } from '../lib/config.js';
import { apply } from '../lib/index.js';
import {
  collect,
  createFakeContext,
  createFakeCredentials,
  createFakeRequest,
  createFakeResponse,
  createFakeWebServer,
  createWaterfall,
  delay,
  jsonOf,
  routeOf,
  streamOf,
} from '../test-utils/harness.mjs';

const API_KEY = 'sk-live-secret-value-123456';
const CONSOLE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.console-session-token';

/** A fetch double serving the API and console endpoints the plugin uses. */
function createFetchDouble({ balanceFails = false, consoleFails = false, rows = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/user/balance')) {
      if (balanceFails) return json({ error: { message: 'Authentication Fails' } }, 401);
      return json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '43.36', granted_balance: '0.00', topped_up_balance: '43.36' }] });
    }
    if (url.endsWith('/models')) {
      return json({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' }, { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' }] });
    }
    if (url.includes('/users/get_user_summary')) {
      if (consoleFails) return json({ code: 40002, msg: 'Missing Token', data: null });
      return json({ code: 0, data: { total_usage: 1399621931, monthly_costs: [{ cost: 156.63, currency: 'CNY' }] } });
    }
    if (url.includes('/usage/amount')) {
      return json({ code: 0, data: { total: rows ? [
        { utc_date: '2026-09-18', model: 'deepseek-flash', type: 'request_count', amount: 12 },
        { utc_date: '2026-09-18', model: 'deepseek-flash', type: 'input_cache_hit_tokens', amount: 900000 },
        { utc_date: '2026-09-18', model: 'deepseek-flash', type: 'output_tokens', amount: 20000 },
      ] : [] } });
    }
    if (url.includes('/usage/cost')) {
      return json({ code: 0, data: { total: rows ? [{ utc_date: '2026-09-18', model: 'deepseek-flash', cost: 1.5, currency: 'CNY' }] : [] } });
    }
    return json({ detail: 'Not Found' }, 404);
  };
  return { fetchImpl, calls };
}

/** Boot the plugin against doubles. */
function boot({ services = {}, config = {}, credentials } = {}) {
  const webServer = createFakeWebServer();
  const creds = credentials ?? createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY, DEEPSEEK_PLATFORM_TOKEN: CONSOLE_TOKEN });
  const harness = createFakeContext({ services: { webServer, credentials: creds, ...services } });
  apply(harness.ctx, { api: { intervalMs: 3600000, minRefreshMs: 0 }, platform: { intervalMs: 3600000, minRefreshMs: 0 }, heartbeatMs: 60000, ...config });
  return { harness, webServer, creds, run: createWaterfall(harness, 'llm/stream') };
}

/** Read one snapshot through the registered route. */
async function snapshotOf(harness, webServer) {
  const handler = routeOf(harness, '/api/apicost/snapshot').handler;
  const res = createFakeResponse();
  await handler(createFakeRequest({ method: 'GET', url: '/api/apicost/snapshot' }), res);
  return jsonOf(res);
}

test('serves balance and models from the open API, and usage from the console', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY, DEEPSEEK_PLATFORM_TOKEN: CONSOLE_TOKEN });
  const double = createFetchDouble();
  const { harness } = boot({ credentials: creds, services: { fetch: double.fetchImpl } });
  // The plugin reads the global fetch; inject the double for this test.
  const original = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    await delay(30);
    const body = await snapshotOf(harness, null);
    const snapshot = body.snapshot;

    assert.equal(snapshot.api.balance.isAvailable, true);
    assert.equal(snapshot.api.preferred.totalBalance, 43.36);
    assert.equal(snapshot.api.preferred.currency, 'CNY');
    assert.deepEqual(snapshot.api.models.map((row) => row.id), ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(snapshot.api.error, null);

    assert.equal(snapshot.console.usage.allTimeCost, 156.63);
    assert.equal(snapshot.console.usage.allTimeTokens, 1399621931);
    assert.equal(snapshot.console.usage.window.cost, 1.5);
    assert.equal(snapshot.console.usage.window.calls, 12);
    assert.equal(snapshot.console.usage.days.length, 1);

    assert.equal(snapshot.credentials.apiKey.configured, true);
    assert.equal(snapshot.credentials.consoleToken.configured, true);
    assert.equal(JSON.stringify(snapshot).includes(API_KEY), false, 'the API key never reaches the snapshot');
    assert.equal(JSON.stringify(snapshot).includes(CONSOLE_TOKEN), false, 'the console token never reaches the snapshot');
    assert.equal(double.calls.some((call) => call.url.includes('/user/balance')), true);
    assert.equal(double.calls.some((call) => call.url.includes('/api/v0/usage/cost')), true);
  } finally {
    globalThis.fetch = original;
    harness.disposeAll();
  }
});

test('without a console token the usage stays empty and says why', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const double = createFetchDouble();
  const original = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    const { harness } = boot({ credentials: creds });
    await delay(30);
    const { snapshot } = await snapshotOf(harness, null);
    assert.equal(snapshot.console.usage, null);
    assert.equal(snapshot.console.error.code, 'NO_CONSOLE_TOKEN');
    assert.equal(snapshot.credentials.consoleToken.configured, false);
    assert.equal(snapshot.api.preferred.totalBalance, 43.36, 'balance still works without the console');
    harness.disposeAll();
  } finally {
    globalThis.fetch = original;
  }
});

test('stores the console token in the credential service and never in a file', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const double = createFetchDouble();
  const original = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    const { harness } = boot({ credentials: creds });
    await delay(20);
    const handler = routeOf(harness, '/api/apicost/console-token').handler;

    const bad = createFakeResponse();
    await handler(createFakeRequest({ method: 'POST', url: '/api/apicost/console-token', body: { token: 'sk-not-a-console-token-value' } }), bad);
    assert.equal(bad.status, 400, 'an API key is rejected as a console token');
    assert.equal(creds.store.has('DEEPSEEK_PLATFORM_TOKEN'), false);

    const good = createFakeResponse();
    await handler(createFakeRequest({ method: 'POST', url: '/api/apicost/console-token', body: { token: CONSOLE_TOKEN } }), good);
    assert.equal(good.status, 200);
    assert.equal(creds.store.get('DEEPSEEK_PLATFORM_TOKEN'), CONSOLE_TOKEN, 'the token lands in the credential store');
    assert.deepEqual(creds.writes.map((entry) => entry.ref), ['DEEPSEEK_PLATFORM_TOKEN']);
    assert.equal(good.body.includes(CONSOLE_TOKEN), false, 'the response never echoes the token');
    const after = JSON.parse(good.body).snapshot;
    assert.equal(after.credentials.consoleToken.configured, true);
    assert.equal(after.console.usage.allTimeCost, 156.63, 'usage is read immediately after storing it');

    const cleared = createFakeResponse();
    await handler(createFakeRequest({ method: 'DELETE', url: '/api/apicost/console-token' }), cleared);
    assert.equal(cleared.status, 200);
    assert.equal(creds.store.has('DEEPSEEK_PLATFORM_TOKEN'), false, 'disconnecting removes it');

    const wrongMethod = createFakeResponse();
    await handler(createFakeRequest({ method: 'GET', url: '/api/apicost/console-token' }), wrongMethod);
    assert.equal(wrongMethod.status, 405);
    harness.disposeAll();
  } finally {
    globalThis.fetch = original;
  }
});

test('accepts a JSON-wrapped userToken copied straight from Local Storage', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const double = createFetchDouble();
  const original = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    const { harness } = boot({ credentials: creds });
    await delay(20);
    const handler = routeOf(harness, '/api/apicost/console-token').handler;

    // The Local Storage value is a JSON envelope, not the bare JWT.
    const envelope = JSON.stringify({ value: CONSOLE_TOKEN, expiresAt: 9999999999 });
    const res = createFakeResponse();
    await handler(createFakeRequest({ method: 'POST', url: '/api/apicost/console-token', body: { token: envelope } }), res);
    assert.equal(res.status, 200, 'the envelope is accepted after extracting its inner value');
    assert.equal(creds.store.get('DEEPSEEK_PLATFORM_TOKEN'), CONSOLE_TOKEN, 'only the bare JWT is stored');
    const after = JSON.parse(res.body).snapshot;
    assert.equal(after.console.usage.allTimeCost, 156.63, 'usage is read from the extracted token');
    harness.disposeAll();
  } finally {
    globalThis.fetch = original;
  }
});

test('the hook returns the stream synchronously, as cordis requires', async () => {
  // cordis' waterfall returns `next()` without awaiting it, and the caller of
  // `llm.stream()` iterates the value directly. The hook therefore has to hand
  // back an async iterable *now* — not a Promise of one. An `async` hook once
  // shipped here and broke every conversation with "stream is not async
  // iterable", so this asserts the synchronous contract explicitly.
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const { harness, run } = boot({ credentials: creds });

  const returned = run({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, () => streamOf([{ type: 'text', text: 'hi' }]));

  assert.equal(typeof returned?.then, 'undefined', 'the hook must not return a thenable');
  assert.equal(
    typeof returned?.[Symbol.asyncIterator],
    'function',
    'the hook hands the caller an async iterable, not a promise',
  );

  const chunks = await collect(returned);
  assert.equal(chunks.length, 1, 'the forwarded stream still yields every chunk');
  harness.disposeAll();
});

test('a hook that returns a promise is rejected rather than silencing the stream', () => {
  // The guard lives in the test double so this regression cannot come back
  // unnoticed: writing `async` on the hook (or `await next()`) is caught here
  // instead of in a live conversation.
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const { harness, run } = boot({ credentials: creds });

  assert.throws(
    () => run({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, async () => streamOf([{ type: 'text', text: 'hi' }])),
    /returned a Promise/,
    'a Promise-returning llm/stream hook is a hard error',
  );
  harness.disposeAll();
});

test('an unreachable API is reported, not hidden', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const double = createFetchDouble({ balanceFails: true, consoleFails: true });
  const original = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    const { harness } = boot({ credentials: creds });
    await delay(30);
    const { snapshot } = await snapshotOf(harness, null);
    assert.equal(snapshot.api.error.code, 'UNAUTHORIZED');
    assert.equal(snapshot.api.preferred, null, 'no balance is claimed when the call failed');
    assert.equal(snapshot.console.error.code, 'NO_CONSOLE_TOKEN');
    harness.disposeAll();
  } finally {
    globalThis.fetch = original;
  }
});

test('a missing API key credential is named in the snapshot', async () => {
  const creds = createFakeCredentials({});
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const { harness } = boot({ credentials: creds });
    await delay(20);
    const { snapshot } = await snapshotOf(harness, null);
    assert.equal(snapshot.api.error.code, 'NO_API_KEY');
    assert.equal(snapshot.api.preferred, null);
    assert.equal(snapshot.credentials.apiKey.configured, false);
    harness.disposeAll();
  } finally {
    globalThis.fetch = original;
  }
});

test('follows the in-flight model for the seat without counting anything', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const { harness, run } = boot({ credentials: creds });
  const listener = harness.events.get('llm/stream')[0];
  assert.equal(listener.options.global, true, 'the waterfall hook must be global');

  const chunks = await collect(await run({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, () => streamOf([{ type: 'text', text: 'hi' }, { type: 'usage', usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } }])));
  assert.equal(chunks.length, 2, 'the stream is forwarded untouched');
  assert.equal(chunks[1].usage.totalTokens, 11, 'the usage chunk is not consumed');

  const streamed = await snapshotOf(harness, null);
  assert.equal(streamed.snapshot.live.model, 'deepseek-v4-pro');
  assert.equal(streamed.snapshot.currentModel.model, 'deepseek-v4-pro');

  // An unrelated provider is ignored.
  await collect(await run({ provider: 'someone-else', model: 'other' }, () => streamOf([{ type: 'text', text: 'x' }])));
  const after = await snapshotOf(harness, null);
  assert.equal(after.snapshot.live.model, 'deepseek-v4-pro');
  harness.disposeAll();
});

test('the plugin writes no file of its own', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const { harness } = boot({ credentials: creds });
  await delay(20);
  const entries = await readdir(new URL('../', import.meta.url), { withFileTypes: true });
  assert.equal(entries.some((entry) => entry.name.endsWith('-state.json')), false, 'no state document in the package');
  const lib = await readdir(new URL('../lib/', import.meta.url));
  assert.deepEqual(lib.filter((name) => /state|pricing|balance/iu.test(name)), [], 'the accumulating modules are gone');
  harness.disposeAll();
});

test('routes are registered on the web server and reject other methods', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
  const { harness } = boot({ credentials: creds });
  const paths = createFakeWebServer().routes;
  void paths;
  for (const path of ['/api/apicost/snapshot', '/api/apicost/events', '/api/apicost/refresh', '/api/apicost/console-token']) {
    assert.ok(routeOf(harness, path) !== undefined, `missing route ${path}`);
  }
  const snapshotHandler = routeOf(harness, '/api/apicost/snapshot').handler;
  const res = createFakeResponse();
  await snapshotHandler(createFakeRequest({ method: 'POST', url: '/api/apicost/snapshot' }), res);
  assert.equal(res.status, 405);
  harness.disposeAll();
});

test('a credential service that arrives after apply is still used', async () => {
  // Regression: the plugin declares no service dependencies, so it is applied
  // before the credentials provider exists. Capturing the service at apply time
  // left every read falling back to the process environment, and the panel said
  // "未找到 API Key 凭据" even though the credential was configured.
  const services = { webServer: createFakeWebServer() };
  const harness = createFakeContext({ services });
  const double = createFetchDouble();
  const original = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    apply(harness.ctx, { api: { intervalMs: 3600000, minRefreshMs: 0 }, platform: { intervalMs: 3600000, minRefreshMs: 0 }, heartbeatMs: 60000 });
    await delay(30);
    const before = await snapshotOf(harness, null);
    assert.equal(before.snapshot.api.error.code, 'NO_API_KEY', 'without the service the read falls back to the environment');
    assert.equal(before.snapshot.credentials.apiKey.configured, false);

    // The credentials provider registers later, exactly like the harness does.
    services.credentials = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY, DEEPSEEK_PLATFORM_TOKEN: CONSOLE_TOKEN });
    const refresh = routeOf(harness, '/api/apicost/refresh').handler;
    const res = createFakeResponse();
    await refresh(createFakeRequest({ method: 'POST', url: '/api/apicost/refresh' }), res);

    const after = JSON.parse(res.body).snapshot;
    assert.equal(after.api.error, null, 'the late service is picked up on the next read');
    assert.equal(after.api.preferred.totalBalance, 43.36);
    assert.equal(after.credentials.apiKey.configured, true);
    assert.equal(after.console.usage.allTimeCost, 156.63);
    harness.disposeAll();
  } finally {
    globalThis.fetch = original;
  }
});

test('the console token shape check keeps API keys out of the store', () => {
  assert.equal(looksLikeConsoleToken(CONSOLE_TOKEN), true);
  assert.equal(looksLikeConsoleToken('sk-live-secret-value-123456'), false, 'an API key is not a console token');
  assert.equal(looksLikeConsoleToken('short'), false);
  assert.equal(looksLikeConsoleToken('has spaces in it 1234567890'), false);
  assert.equal(looksLikeConsoleToken(null), false);
  assert.equal(resolveConfig({}).consoleTokenEnv, 'DEEPSEEK_PLATFORM_TOKEN');
});
