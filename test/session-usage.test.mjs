/**
 * The session-scoped usage source: what it reads, how it adds the disjoint
 * buckets, and — most importantly — that it never merges with the console's
 * account-scoped figures.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import { billedInputTokens, cacheHitPercent, readSessionUsage } from '../lib/session-usage.js';
import {
  createFakeContext,
  createFakeCredentials,
  createFakeProjections,
  createFakeRequest,
  createFakeResponse,
  createFakeSessions,
  createFakeTokenMeter,
  createFakeWebServer,
  createWaterfall,
  delay,
  jsonOf,
  routeOf,
  streamOf,
} from '../test-utils/harness.mjs';

/** One session's provider-reported usage: four disjoint buckets. */
const TOTALS = { uncachedInputTokens: 1200, outputTokens: 340, cacheReadTokens: 45000, cacheWriteTokens: 800 };

/** A context carrying only the services a given case needs. */
function contextWith(services) {
  return createFakeContext({ services });
}

test('reads the tokenUsage projection and adds the three prompt-side buckets', () => {
  const session = { id: 'session-1', seq: 12 };
  const sessions = createFakeSessions([session]);
  const projections = createFakeProjections(new Map([[sessions.raw[0], TOTALS]]));
  const { ctx } = contextWith({ sessions, sessionProjections: projections });

  const result = readSessionUsage({ ctx });

  assert.equal(result.available, true);
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.sessions, 1);
  assert.equal(result.usage.uncachedInputTokens, 1200);
  assert.equal(result.usage.cacheReadTokens, 45000);
  assert.equal(result.usage.cacheWriteTokens, 800);
  assert.equal(result.usage.outputTokens, 340);
  // billed input = uncached + cache read + cache write (the official convention)
  assert.equal(result.usage.billedInputTokens, 1200 + 45000 + 800);
  // total = billed input + output; reasoning is already inside outputTokens
  assert.equal(result.usage.totalTokens, 1200 + 45000 + 800 + 340);
  assert.equal(projections.calls[0].key, 'tokenUsage', 'only the tokenUsage unit is read');
});

test('the billing convention matches the official helper', () => {
  // The reference consumer (`dsh-client-ui-chat`) spells it this way; the panel
  // must not invent a second arithmetic.
  assert.equal(billedInputTokens({ uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }), 6);
  assert.equal(cacheHitPercent({ uncachedInputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 50 }), 50);
  assert.equal(cacheHitPercent({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null, 'no billed input yields no percent');
  assert.equal(cacheHitPercent({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10 }), 0, 'a write is not a hit');
});

test('a cache hit rate is computed against billed input only', () => {
  const session = { id: 'session-1', seq: 4 };
  const sessions = createFakeSessions([session]);
  const projections = createFakeProjections(new Map([[sessions.raw[0], { uncachedInputTokens: 500, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 }]]));
  const { ctx } = contextWith({ sessions, sessionProjections: projections });

  const { usage } = readSessionUsage({ ctx });
  assert.equal(usage.cacheHitPercent, 50, '500 of 1000 billed input tokens were cache reads');
  assert.equal(usage.totalTokens, 1100, 'output is added, never a denominator');
});

test('without a projection or a session the block degrades to a named reason', () => {
  const noSessions = contextWith({});
  assert.equal(readSessionUsage({ ctx: noSessions.ctx }).reason, 'NO_SESSION');
  assert.equal(readSessionUsage({ ctx: noSessions.ctx }).available, false);

  const sessions = createFakeSessions([{ id: 'session-1', seq: 1 }]);
  const none = contextWith({ sessions });
  const unmeasured = readSessionUsage({ ctx: none.ctx });
  assert.equal(unmeasured.reason, 'NOT_MEASURED', 'a registry that is not mounted is not a zero');
  assert.equal(unmeasured.usage, null);
  assert.equal(unmeasured.sessionId, 'session-1', 'the session is still reported');

  const empty = createFakeProjections(new Map());
  const blank = contextWith({ sessions, sessionProjections: empty });
  assert.equal(readSessionUsage({ ctx: blank.ctx }).reason, 'NOT_MEASURED');

  const partial = createFakeProjections(new Map([[sessions.raw[0], { uncachedInputTokens: 1, outputTokens: 2 }]]));
  const broken = contextWith({ sessions, sessionProjections: partial });
  assert.equal(readSessionUsage({ ctx: broken.ctx }).reason, 'UNUSABLE', 'a partial value is refused whole, not totalled');
});

test('the only live session is used; several sessions report the newest and say so', () => {
  const sessions = createFakeSessions([
    { id: 'session-1', seq: 3 },
    { id: 'session-2', seq: 99 },
    { id: 'session-3', seq: 40 },
  ]);
  const projections = createFakeProjections(
    new Map([
      [sessions.raw[0], { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }],
      [sessions.raw[1], { uncachedInputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    ]),
  );
  const { ctx } = contextWith({ sessions, sessionProjections: projections });

  const picked = readSessionUsage({ ctx });
  assert.equal(picked.sessionId, 'session-2', 'the longest log is the one in flight');
  assert.equal(picked.sessions, 3, 'the ambiguity is reported, not hidden');
  assert.equal(picked.usage.totalTokens, 1000);

  // An explicit id overrules the heuristic.
  const pinned = readSessionUsage({ ctx, sessionId: 'session-1' });
  assert.equal(pinned.sessionId, 'session-1');
  assert.equal(pinned.usage.totalTokens, 2);

  // An id that is not live reports nothing rather than falling back.
  assert.equal(readSessionUsage({ ctx, sessionId: 'session-9' }).reason, 'NO_SESSION');
});

test('context occupancy comes from the meter and is labelled as approximate', () => {
  const session = { id: 'session-1', seq: 5 };
  const sessions = createFakeSessions([session]);
  const projections = createFakeProjections(new Map([[sessions.raw[0], TOTALS]]));
  const meter = createFakeTokenMeter({
    surfaceTokens: 1234,
    baseline: { kind: 'estimated', tokens: 1200 },
    nodes: [
      { seq: 1, tokens: 1200, heuristicTokens: 1100 },
      { seq: 3, tokens: 34, heuristicTokens: 30 },
    ],
  });
  const { ctx } = contextWith({ sessions, sessionProjections: projections, tokenMeter: meter });

  const { context } = readSessionUsage({ ctx });
  assert.equal(context.surfaceTokens, 1234);
  assert.equal(context.heuristicTokens, 1130, 'node prices are summed separately from the metered total');
  assert.equal(context.nodes, 2);
  assert.equal(context.approximated, true, 'an estimated baseline must be labelled');

  const reported = createFakeTokenMeter({ surfaceTokens: 900, baseline: { kind: 'usage', tokens: 880, usage: {} }, nodes: [] });
  const second = contextWith({ sessions, sessionProjections: projections, tokenMeter: reported });
  assert.equal(readSessionUsage({ ctx: second.ctx }).context.approximated, false, 'a provider-reported anchor is not approximate');
});

test('a throwing service is contained and never takes the snapshot down', () => {
  const sessions = createFakeSessions([{ id: 'session-1', seq: 1 }]);
  const hostile = {
    stateOf() {
      throw new Error('projection exploded');
    },
  };
  const { ctx } = contextWith({ sessions, sessionProjections: hostile });
  assert.equal(readSessionUsage({ ctx }).reason, 'NOT_MEASURED');

  const badList = {
    list() {
      throw new Error('store exploded');
    },
  };
  const second = contextWith({ sessions: badList });
  assert.equal(readSessionUsage({ ctx: second.ctx }).reason, 'NO_SESSION');
});

test('the snapshot carries the session block beside, never inside, the console block', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: 'sk-live-secret-value-123456' });
  const sessions = createFakeSessions([{ id: 'session-1', seq: 7 }]);
  const projections = createFakeProjections(new Map([[sessions.raw[0], TOTALS]]));
  const webServer = createFakeWebServer();
  const harness = createFakeContext({ services: { webServer, credentials: creds, sessions, sessionProjections: projections } });
  const original = globalThis.fetch;
  // No console token, so the account figures stay empty — the point of the block.
  globalThis.fetch = async () => new Response(JSON.stringify({ is_available: true, balance_infos: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    apply(harness.ctx, { api: { intervalMs: 3600000, minRefreshMs: 0 }, platform: { intervalMs: 3600000, minRefreshMs: 0 }, heartbeatMs: 60000 });
    await delay(30);
    const handler = routeOf(harness, '/api/usageledger/snapshot').handler;
    const res = createFakeResponse();
    await handler(createFakeRequest({ method: 'GET', url: '/api/usageledger/snapshot' }), res);
    const { snapshot } = jsonOf(res);

    assert.equal(snapshot.console.usage, null, 'the console is still empty without a token');
    assert.equal(snapshot.session.available, true, 'and the session source fills the gap');
    assert.equal(snapshot.session.usage.totalTokens, 47340);
    assert.equal(snapshot.session.sessionId, 'session-1');

    // The two口径 must never be cross-contaminated.
    assert.equal(Object.hasOwn(snapshot.console, 'sessionUsage'), false);
    assert.equal(Object.hasOwn(snapshot.session, 'usage') && Object.hasOwn(snapshot.session.usage, 'allTimeTokens'), false, 'the session block must not carry account totals');
    assert.equal(Object.hasOwn(snapshot.session, 'monthlyTokens'), false);
  } finally {
    globalThis.fetch = original;
    harness.disposeAll();
  }
});

test('a settled stream re-reads the session projection', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: 'sk-live-secret-value-123456' });
  const sessions = createFakeSessions([{ id: 'session-1', seq: 2 }]);
  const projections = createFakeProjections(new Map([[sessions.raw[0], TOTALS]]));
  const harness = createFakeContext({ services: { webServer: createFakeWebServer(), credentials: creds, sessions, sessionProjections: projections } });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    apply(harness.ctx, { api: { intervalMs: 3600000, minRefreshMs: 0, enabled: false }, platform: { intervalMs: 3600000, minRefreshMs: 0, enabled: false }, heartbeatMs: 60000 });
    await delay(20);
    const before = projections.calls.length;

    const run = createWaterfall(harness, 'llm/stream');
    const stream = await run({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, () => streamOf([{ type: 'text', text: 'hi' }]));
    assert.equal(projections.calls.length, before, 'the read happens on settle, not on open');
    for await (const _chunk of stream) void _chunk;
    assert.ok(projections.calls.length > before, 'the projection is re-read once the request settles');
  } finally {
    globalThis.fetch = original;
    harness.disposeAll();
  }
});

test('an unchanged projection does not bump the revision', async () => {
  const creds = createFakeCredentials({ DEEPSEEK_API_KEY: 'sk-live-secret-value-123456' });
  const sessions = createFakeSessions([{ id: 'session-1', seq: 2 }]);
  const projections = createFakeProjections(new Map([[sessions.raw[0], TOTALS]]));
  const webServer = createFakeWebServer();
  const harness = createFakeContext({ services: { webServer, credentials: creds, sessions, sessionProjections: projections } });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    apply(harness.ctx, { api: { intervalMs: 3600000, minRefreshMs: 0, enabled: false }, platform: { intervalMs: 3600000, minRefreshMs: 0, enabled: false }, heartbeatMs: 60000 });
    await delay(20);
    const handler = routeOf(harness, '/api/usageledger/snapshot').handler;
    const first = createFakeResponse();
    await handler(createFakeRequest({ method: 'GET', url: '/api/usageledger/snapshot' }), first);
    const revision = jsonOf(first).snapshot.revision;

    // The interval timer re-reads the same value several times over this window.
    await delay(60);
    const second = createFakeResponse();
    await handler(createFakeRequest({ method: 'GET', url: '/api/usageledger/snapshot' }), second);
    const after = jsonOf(second).snapshot;
    assert.equal(after.revision, revision, 'an identical reading must not publish');
    assert.equal(after.session.usage.totalTokens, 47340);
  } finally {
    globalThis.fetch = original;
    harness.disposeAll();
  }
});
