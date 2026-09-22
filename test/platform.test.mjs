/**
 * Platform-console client: envelope handling and the usage normalizer.
 *
 * The console's JSON shape differs between builds, so the normalizer is written
 * tolerantly. The primary fixtures below mirror the *verified live* shape
 * (captured 2026-09), which nests a business envelope inside a transport
 * envelope and carries per-type usage arrays rather than flat rows.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchSummary, fetchUsage, normalizeUsage, PlatformError } from '../lib/platform.js';

const BASE = 'https://platform.deepseek.com';

/** The live shape: `{ code, msg, data: { biz_code, biz_msg, biz_data } }`. */
function envelope(bizData) {
  return { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: bizData } };
}

/** One model's usage block in the live console shape. */
function usageBlock(model, { cacheHit = 0, cacheMiss = 0, output = 0, calls = 0, prompt = 0 }) {
  return {
    model,
    usage: [
      { type: 'PROMPT_TOKEN', amount: String(prompt) },
      { type: 'PROMPT_CACHE_HIT_TOKEN', amount: String(cacheHit) },
      { type: 'PROMPT_CACHE_MISS_TOKEN', amount: String(cacheMiss) },
      { type: 'RESPONSE_TOKEN', amount: String(output) },
      { type: 'REQUEST', amount: String(calls) },
    ],
  };
}

const AMOUNT_LIVE = envelope({
  // The lifetime per-model roll-up. Deliberately larger than the two-day window
  // below, so a normalizer that conflates the two series fails loudly.
  total: [
    usageBlock('deepseek-flash', { cacheHit: 1558998875, cacheMiss: 7989399, output: 4532077, calls: 5962 }),
    usageBlock('deepseek-v4-pro', { cacheHit: 1000000, cacheMiss: 100000, output: 50000, calls: 40 }),
  ],
  days: [
    { date: '2026-09-18', data: [usageBlock('deepseek-flash', { cacheHit: 900000, cacheMiss: 20000, output: 40000, calls: 120 })] },
    { date: '2026-09-19', data: [usageBlock('deepseek-v4-pro', { cacheHit: 1000, output: 500, calls: 8 })] },
  ],
});

const COST_LIVE = envelope([
  {
    currency: 'CNY',
    total: [
      {
        model: 'deepseek-flash',
        usage: [
          { type: 'PROMPT_TOKEN', amount: '0' },
          { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '1.50' },
          { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '0.25' },
          { type: 'RESPONSE_TOKEN', amount: '0' },
          { type: 'REQUEST', amount: '0' },
        ],
      },
    ],
    days: [
      { date: '2026-09-18', data: [{ model: 'deepseek-flash', usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: '1.50' }] }] },
      { date: '2026-09-19', data: [{ model: 'deepseek-v4-pro', usage: [{ type: 'PROMPT_CACHE_MISS_TOKEN', amount: '0.25' }] }] },
    ],
  },
]);

const SUMMARY_LIVE = envelope({
  normal_wallets: [{ currency: 'CNY', balance: '35.4791934000000000', token_estimation: '0' }],
  bonus_wallets: [{ currency: 'CNY', balance: '0', token_estimation: '0' }],
  total_costs: [{ currency: 'CNY', amount: '164.5208066000000000' }],
});

/** A legacy flat row payload, for backward tolerance. */
const AMOUNT_FLAT = {
  data: {
    total: [
      { utc_date: '2026-09-18', model: 'deepseek-flash', type: 'request_count', amount: 120 },
      { utc_date: '2026-09-18', model: 'deepseek-flash', type: 'input_cache_hit_tokens', amount: 900000 },
      { utc_date: '2026-09-18', model: 'deepseek-flash', type: 'output_tokens', amount: 40000 },
      { utc_date: '2026-09-19', model: 'deepseek-v4-pro', type: 'prompt_cache_hit_tokens', amount: 1000 },
      { utc_date: '2026-09-19', model: 'deepseek-v4-pro', type: 'completion_tokens', amount: 500 },
    ],
  },
};
const COST_FLAT = {
  data: {
    total: [
      { utc_date: '2026-09-18', model: 'deepseek-flash', cost: 1.5, currency: 'CNY' },
      { utc_date: '2026-09-19', model: 'deepseek-v4-pro', cost: 0.25, currency: 'CNY' },
    ],
  },
};

test('folds the live nested console rows into days, models and window totals', () => {
  const usage = normalizeUsage({ summary: SUMMARY_LIVE, amount: AMOUNT_LIVE, cost: COST_LIVE, month: '2026-09' });

  assert.equal(usage.days.length, 2);
  const [first, second] = usage.days;
  assert.deepEqual(
    { day: first.day, calls: first.calls, tokens: first.tokens, cost: first.cost },
    { day: '2026-09-18', calls: 120, tokens: 960000, cost: 1.5 },
  );
  assert.deepEqual({ day: second.day, tokens: second.tokens, cost: second.cost }, { day: '2026-09-19', tokens: 1500, cost: 0.25 });

  assert.equal(usage.window.calls, 128);
  assert.equal(usage.window.tokens, 961500);
  assert.equal(usage.window.cost, 1.75);
  assert.equal(usage.window.cacheHitTokens, 901000);

  assert.equal(usage.allTimeCost, 164.520807, 'total_costs is read from the summary');
  assert.equal(usage.currency, 'CNY');
  assert.equal(usage.wallets.normal, 35.4791934);
  assert.equal(usage.wallets.bonus, 0);
  assert.equal(usage.models[0].model, 'deepseek-flash', 'heaviest model first');
  assert.equal(usage.complete.allTimeCost, true);
  assert.equal(usage.complete.dailyCost, true);
  assert.ok(usage.rows.amount > 0, 'entries were read from the nested usage arrays');
});

test('keeps reading the legacy flat row shape', () => {
  const usage = normalizeUsage({ summary: {}, amount: AMOUNT_FLAT, cost: COST_FLAT, month: '2026-09' });

  assert.equal(usage.days.length, 2);
  assert.equal(usage.window.calls, 120, 'only request_count rows count as calls');
  assert.equal(usage.window.tokens, 941500, 'cache-hit + output tokens across both days');
  // The legacy cost rows carry one cost per row, so the day buckets sum them.
  assert.equal(usage.days[0].cost, 1.5);
  assert.equal(usage.days[1].cost, 0.25);
  assert.equal(usage.window.cost, 1.75, 'the window cost folds the legacy per-row costs');
  // A legacy flat array under `total` is a daily row list, not a lifetime
  // roll-up, so it must not be promoted to an all-time token figure.
  assert.equal(usage.allTimeTokens, null, 'a flat `total` array is not a lifetime roll-up');
  assert.deepEqual(usage.complete, { allTimeTokens: false, allTimeCost: false, dailyCost: true, dailyTokens: true, calls: true });
});

test('reads the summary wallets and all-time spend', () => {
  const usage = normalizeUsage({ summary: SUMMARY_LIVE, amount: AMOUNT_LIVE, cost: COST_LIVE, month: '2026-09' });

  assert.equal(usage.allTimeCost, 164.520807);
  assert.equal(usage.currency, 'CNY');
  assert.equal(usage.wallets.normal, 35.4791934);
  assert.equal(usage.complete.allTimeCost, true);
});

test('the lifetime roll-up and the monthly window stay separate figures', () => {
  // The live payload ships a per-model `total` roll-up *and* a per-day window.
  // Summing both, or reusing the window as the lifetime figure, would report one
  // of the two numbers as the other.
  const amount = AMOUNT_LIVE;
  const usage = normalizeUsage({ summary: SUMMARY_LIVE, amount, cost: COST_LIVE, month: '2026-09' });

  // `total` covers lifetime; the fixture's roll-up is larger than the 2-day window.
  //
  // Expected value, worked out from the fixture's two models:
  //   flash 1558998875 hit + 7989399 miss + 4532077 out
  //   v4    1000000     hit +  100000 miss +   50000 out
  // The fixture's `PROMPT_TOKEN` aggregate is 0 and its `REQUEST` count is
  // omitted from the roll-up, so nothing is double-counted here.
  assert.equal(usage.allTimeTokens, 1558998875 + 7989399 + 4532077 + 1000000 + 100000 + 50000, '累计 TOKEN comes from the per-model total roll-up');
  assert.equal(usage.window.tokens, 961500, 'the window only sums the days series');
  assert.equal(usage.monthlyTokens, 961500, '本月 TOKEN is the window, never the lifetime figure');
  assert.notEqual(usage.allTimeTokens, usage.monthlyTokens, 'the two figures are never conflated');
});

test('tolerates camelCase rows, a bare array, and amount+price fallbacks', () => {
  const usage = normalizeUsage({
    summary: { totalUsage: 500, monthlyCosts: [{ amount: 3.5, currency: 'CNY' }] },
    amount: [{ utcDate: '2026-09-02T10:00:00Z', modelName: 'deepseek-flash', usageType: 'request_count', value: 4 }],
    cost: [],
    month: '2026-09',
  });
  assert.equal(usage.days[0].day, '2026-09-02', 'an ISO timestamp still keys a local day');
  assert.equal(usage.days[0].calls, 4);
  assert.equal(usage.allTimeCost, 3.5);
  assert.equal(usage.complete.dailyCost, false, 'no cost rows means the cost series is not claimed');
});

test('reports missing figures instead of zeroing them', () => {
  const usage = normalizeUsage({ summary: null, amount: null, cost: null, month: '2026-09' });
  assert.equal(usage.allTimeTokens, null);
  assert.equal(usage.allTimeCost, null);
  assert.equal(usage.window.cost, null);
  assert.equal(usage.window.calls, 0);
  assert.deepEqual(usage.days, []);
  assert.deepEqual(usage.complete, { allTimeTokens: false, allTimeCost: false, dailyCost: false, dailyTokens: false, calls: false });
});

test('unreadable rows are skipped rather than counted as zero', () => {
  const usage = normalizeUsage({
    summary: {},
    amount: {
      days: [
        {
          date: '2026-09-01',
          data: [
            { model: 'deepseek-flash', usage: [{ type: 'REQUEST', amount: '5' }, { type: 'mystery_metric', amount: '5' }] },
            null,
            'not-an-object',
          ],
        },
        // A day entry with no usable date drops out of the day list entirely.
        { date: null, data: [{ model: 'deepseek-flash', usage: [{ type: 'REQUEST', amount: '9' }] }] },
      ],
    },
    cost: { days: [{ date: '2026-09-01', data: [{ model: 'deepseek-flash', usage: [{ type: 'PROMPT_TOKEN', amount: 'not-a-number' }] }] }] },
    month: '2026-09',
  });
  assert.equal(usage.days.length, 1, 'only the dated day is keyed');
  assert.equal(usage.days[0].calls, 5);
  assert.equal(usage.models[0].calls, 14, 'the undated row still reaches the model roll-up');
  assert.equal(usage.rows.amount, 3, 'readable type/amount pairs are counted; unreadable ones are skipped');
  assert.equal(usage.rows.cost, 0, 'a non-numeric amount yields no entry at all');
  assert.equal(usage.window.cost, null, 'no readable cost row means the cost series stays unknown');
});

test('requests both console endpoints with the token and unwraps the envelope', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = url.includes('/usage/amount') ? AMOUNT_LIVE : url.includes('/usage/cost') ? COST_LIVE : SUMMARY_LIVE;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const summary = await fetchSummary({ baseURL: BASE, token: 'console-token', timeoutMs: 1000, fetchImpl });
  assert.equal(summary.total_costs[0].amount, '164.5208066000000000', 'both envelopes are peeled to the business payload');
  assert.equal(calls[0].init.headers.authorization, 'Bearer console-token');

  const usage = await fetchUsage({ baseURL: BASE, token: 'console-token', year: 2026, month: 9, timeoutMs: 1000, fetchImpl });
  assert.ok(Array.isArray(usage.amount.days), 'the amount payload is unwrapped to the day list');
  assert.equal(calls[1].url, `${BASE}/api/v0/usage/amount?year=2026&month=9`);
  assert.equal(calls[2].url, `${BASE}/api/v0/usage/cost?year=2026&month=9`);
});

test('peels a string-encoded biz_data payload (double-encoded JSON)', async () => {
  const fetchImpl = async (url) => {
    const inner = url.includes('/usage/amount') ? AMOUNT_LIVE.data.biz_data : url.includes('/usage/cost') ? COST_LIVE.data.biz_data : SUMMARY_LIVE.data.biz_data;
    return new Response(JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: JSON.stringify(inner) } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const summary = await fetchSummary({ baseURL: BASE, token: 't', timeoutMs: 1000, fetchImpl });
  assert.equal(summary.total_costs[0].amount, '164.5208066000000000', 'the JSON-string biz_data is parsed before unwrapping');
  const usage = await fetchUsage({ baseURL: BASE, token: 't', year: 2026, month: 9, timeoutMs: 1000, fetchImpl });
  const folded = normalizeUsage({ summary, amount: usage.amount, cost: usage.cost, month: '2026-09' });
  assert.equal(folded.allTimeCost, 164.520807);
  assert.equal(folded.window.tokens, 961500, 'the string-encoded nested arrays also fold correctly');
});

test('a single failing series endpoint still yields the other half', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/usage/cost')) {
      return new Response(JSON.stringify({ code: 50001, msg: 'boom', data: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(AMOUNT_LIVE), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const usage = await fetchUsage({ baseURL: BASE, token: 't', year: 2026, month: 9, timeoutMs: 1000, fetchImpl });
  assert.equal(usage.partial, 'cost', 'the failed endpoint is named');
  assert.match(usage.partialMessage, /boom/u);
  assert.equal(usage.cost, null);
  assert.ok(usage.amount !== null, 'the reading endpoint still delivers');

  const folded = normalizeUsage({ summary: null, amount: usage.amount, cost: usage.cost, month: '2026-09' });
  assert.equal(folded.window.tokens, 961500, 'the token series survives a cost failure');
  assert.equal(folded.window.cost, null, 'and the cost series stays honestly unknown');
});

test('a double console failure raises instead of reporting empty data', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 50001, msg: 'boom', data: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => fetchUsage({ baseURL: BASE, token: 't', year: 2026, month: 9, timeoutMs: 1000, fetchImpl }),
    (error) => error.code === 'CODE_50001',
  );
});

test('a console business code becomes a translatable error', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 40002, msg: 'Missing Token', data: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => fetchSummary({ baseURL: BASE, token: 'expired', timeoutMs: 1000, fetchImpl }),
    (error) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.code, 'NO_TOKEN');
      assert.match(error.message, /Missing Token/u);
      return true;
    },
  );
});

test('a biz_code business error is surfaced too', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 0, msg: '', data: { biz_code: 40002, biz_msg: 'Missing Token', biz_data: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => fetchSummary({ baseURL: BASE, token: 'expired', timeoutMs: 1000, fetchImpl }),
    (error) => error.code === 'NO_TOKEN',
  );
});

test('an HTTP 401 from the console maps onto EXPIRED', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ detail: 'not authenticated' }), { status: 401, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => fetchUsage({ baseURL: BASE, token: 'stale', year: 2026, month: 9, timeoutMs: 1000, fetchImpl }),
    (error) => error.code === 'EXPIRED' && error.status === 401,
  );
});

/* ---------------------------------------------------------------------- *
 * 口径 regressions.
 *
 * Each test below encodes a mistake that shipped: the assertions are written so
 * that the pre-fix code fails them, not merely so that the current code passes.
 * ---------------------------------------------------------------------- */

/** One model's usage block, with every type the live console emits. */
function fullBlock(model, { prompt = 0, cacheHit = 0, cacheMiss = 0, output = 0, calls = 0 }) {
  return {
    model,
    usage: [
      { type: 'PROMPT_TOKEN', amount: String(prompt) },
      { type: 'PROMPT_CACHE_HIT_TOKEN', amount: String(cacheHit) },
      { type: 'PROMPT_CACHE_MISS_TOKEN', amount: String(cacheMiss) },
      { type: 'RESPONSE_TOKEN', amount: String(output) },
      { type: 'REQUEST', amount: String(calls) },
    ],
  };
}

test('a flat row parked under `total` feeds the daily series and never the lifetime roll-up', () => {
  // A legacy console parents flat daily rows under `total`. They are a *daily*
  // series, so they must reach `days`/`window` — and must not also be folded as
  // the untimed per-model roll-up, which is a different 口径.
  const amount = { total: [{ utc_date: '2026-09-18', model: 'deepseek-flash', type: 'RESPONSE_TOKEN', amount: 100 }] };
  const usage = normalizeUsage({ summary: {}, amount, cost: null, month: '2026-09' });

  assert.equal(usage.window.tokens, 100, 'the flat row is read as a daily row');
  assert.deepEqual(
    usage.days.map((entry) => [entry.day, entry.outputTokens]),
    [['2026-09-18', 100]],
    'the flat row keeps its date',
  );
  assert.equal(usage.allTimeTokens, null, 'the flat row must not become a lifetime roll-up');
});

test('a flat row under `total` cannot inflate the roll-up even when its type is a lifetime one', () => {
  // The pre-fix code pushed flat rows into `entries`, and `section === 'total'`
  // read the same array — so a flat row with a token type appeared in both
  // series at once. `cacheMissTokens` is in the lifetime whitelist, so this is
  // the shape that used to leak.
  const amount = { total: [{ utc_date: '2026-09-18', model: 'deepseek-flash', type: 'PROMPT_CACHE_MISS_TOKEN', amount: 4242 }] };
  const usage = normalizeUsage({ summary: {}, amount, cost: null, month: '2026-09' });

  assert.equal(usage.window.tokens, 4242, 'the row is a daily row');
  assert.equal(usage.allTimeTokens, null, 'and nothing about it is a lifetime figure');
});

test('the PROMPT_TOKEN aggregate is excluded from the lifetime token sum', () => {
  // `PROMPT_TOKEN` is the whole prompt; hit + miss split that same prompt. The
  // console ships all three, so summing every recognised bucket counts one
  // prompt twice.
  const amount = { total: [fullBlock('deepseek-flash', { prompt: 1000, cacheHit: 900, cacheMiss: 100, output: 50, calls: 3 })] };
  const usage = normalizeUsage({ summary: {}, amount, cost: null, month: '2026-09' });

  assert.equal(usage.allTimeTokens, 1050, 'hit + miss + output only; the 1000 aggregate is a duplicate view');
});

test('the REQUEST call count is excluded from the lifetime token sum', () => {
  // `REQUEST` maps onto the `calls` bucket, which is a count of calls and not a
  // quantity of tokens. A sum over "every bucket we recognise" adds it anyway.
  const amount = { total: [fullBlock('deepseek-flash', { cacheHit: 900, cacheMiss: 100, output: 50, calls: 7000 })] };
  const usage = normalizeUsage({ summary: {}, amount, cost: null, month: '2026-09' });

  assert.equal(usage.allTimeTokens, 1050, 'the 7000 calls are not tokens');
});

test('the lifetime token sum still reads a genuine nested roll-up', () => {
  // The exclusions must not be so broad that a real roll-up stops being summed.
  const amount = {
    total: [fullBlock('deepseek-flash', { cacheHit: 1558998875, cacheMiss: 7989399, output: 4532077, calls: 5962 })],
  };
  const usage = normalizeUsage({ summary: {}, amount, cost: null, month: '2026-09' });

  assert.equal(usage.allTimeTokens, 1558998875 + 7989399 + 4532077, 'hit + miss + output, calls excluded');
  assert.equal(usage.window.tokens, 0, 'a roll-up with no dates belongs to no day');
});

test('shape diagnostics go to the injected logger, never to the console', () => {
  // This module is a library. Writing to the host's stdout bypasses the host's
  // logging configuration, so the diagnostic is routed and, with no logger, is
  // dropped rather than printed.
  const seen = [];
  const usage = normalizeUsage({
    summary: { some_unknown_key: 1 },
    amount: { nothing_recognisable: true },
    cost: null,
    month: '2026-09',
    logger: { warn: (message) => seen.push(String(message)) },
  });

  assert.ok(seen.length > 0, 'the diagnostic reaches the injected logger');
  assert.ok(seen.some((line) => line.includes('usage/amount')), 'the amount shape is reported');
  assert.ok(seen.some((line) => line.includes('get_user_summary')), 'the summary shape is reported');
  assert.equal(usage.allTimeCost, null, 'and the reading still degrades to null rather than throwing');
});

test('a missing logger is not a reason to write to the console', () => {
  const original = console.warn;
  const captured = [];
  console.warn = (...args) => captured.push(args.join(' '));
  try {
    normalizeUsage({ summary: { unknown: 1 }, amount: { unknown: 2 }, cost: null, month: '2026-09' });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(captured, [], 'no logger means no output at all');
});

test('a mixed `total` keeps its flat daily rows alongside a nested roll-up', () => {
  // The previous fix gated the flat-row pass on `entries.length === 0`. That
  // made one *unrelated* nested entry — even a trivial call count — silently
  // discard every flat daily row in the same list. The gate is gone: a flat row
  // is a daily row regardless of what sits next to it.
  const amount = {
    total: [
      { model: 'deepseek-flash', usage: [{ type: 'REQUEST', amount: 3 }] },
      { utc_date: '2026-09-18', model: 'deepseek-flash', type: 'RESPONSE_TOKEN', amount: 100 },
      { utc_date: '2026-09-19', model: 'deepseek-flash', type: 'RESPONSE_TOKEN', amount: 200 },
    ],
  };
  const usage = normalizeUsage({ summary: {}, amount, cost: null, month: '2026-09' });

  assert.deepEqual(
    usage.days.map((entry) => [entry.day, entry.outputTokens]),
    [['2026-09-18', 100], ['2026-09-19', 200]],
    'the flat rows survive a neighbouring nested block',
  );
  assert.equal(usage.window.tokens, 300, 'and the window sums them');
  assert.equal(usage.allTimeTokens, null, 'while the flat rows still stay out of the roll-up');
});

test('a nested roll-up beside flat rows contributes only to the lifetime figure', () => {
  const amount = {
    total: [
      { model: 'deepseek-flash', usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: 900 }, { type: 'RESPONSE_TOKEN', amount: 100 }] },
      { utc_date: '2026-09-18', model: 'deepseek-flash', type: 'RESPONSE_TOKEN', amount: 7 },
    ],
  };
  const usage = normalizeUsage({ summary: {}, amount, cost: null, month: '2026-09' });

  assert.equal(usage.allTimeTokens, 1000, 'the nested block is the lifetime roll-up');
  assert.deepEqual(usage.days.map((entry) => [entry.day, entry.outputTokens]), [['2026-09-18', 7]], 'the flat row is the daily one');
  assert.equal(usage.window.tokens, 7, 'the two never bleed into each other');
});
test('a call-count cost row does not fabricate a zero-token model', () => {
  // The cost loop materialized a model entry *before* checking whether the row
  // was a call counter, so a model named only in a cost-side `REQUEST` row was
  // published as a ghost: 0 tokens, 0 cost, no amount payload behind it.
  const amount = {
    days: [{ date: '2026-09-18', data: [{ model: 'deepseek-v4-pro', usage: [{ type: 'RESPONSE_TOKEN', amount: 100 }] }] }],
  };
  const cost = {
    days: [
      {
        date: '2026-09-18',
        data: [
          { model: 'deepseek-v4-pro', usage: [{ type: 'COST', amount: 1.5 }] },
          { model: 'ghost-model', usage: [{ type: 'REQUEST', amount: 2 }] },
        ],
      },
    ],
  };
  const usage = normalizeUsage({ summary: {}, amount, cost, month: '2026-09' });

  assert.deepEqual(usage.models.map((entry) => entry.model), ['deepseek-v4-pro'], 'a call-only model is not a model row');
  assert.equal(usage.models[0].cost, 1.5, 'and the real model keeps its cost');
  assert.equal(usage.window.cost, 1.5, 'the ghost contributes nothing to the window either');
});

test('a cost-only model still appears, because it really did spend', () => {
  // The mirror of the previous test: skipping the call rows must not skip a
  // model that genuinely has cost but no token rows of its own.
  const amount = { days: [{ date: '2026-09-18', data: [{ model: 'deepseek-v4-pro', usage: [{ type: 'RESPONSE_TOKEN', amount: 100 }] }] }] };
  const cost = {
    days: [
      {
        date: '2026-09-18',
        data: [
          { model: 'deepseek-v4-pro', usage: [{ type: 'COST', amount: 1.25 }] },
          { model: 'deepseek-v4-lite', usage: [{ type: 'COST', amount: 0.5 }] },
        ],
      },
    ],
  };
  const usage = normalizeUsage({ summary: {}, amount, cost, month: '2026-09' });

  // Sorted by token count descending, so the model with real tokens leads and
  // the cost-only one follows with its own cost intact.
  assert.deepEqual(usage.models.map((entry) => [entry.model, entry.cost]), [['deepseek-v4-pro', 1.25], ['deepseek-v4-lite', 0.5]]);
  assert.equal(usage.window.cost, 1.75, 'the day cost is the sum of both');
});
