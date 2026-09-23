/**
 * Multi-platform discovery and merge: the billing-card list follows what the
 * harness actually reaches, never a fixed card set.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	baseURLMatches,
	mergePlatforms,
	normalizeProviderOverrides,
	platformForBaseURL,
	platformForRoute,
	routesFromLlm
} from '../lib/provider.js';
import { fetchBalance, fetchModels } from '../lib/moonshot.js';
import { fetchOpenAICompatibleModels } from '../lib/restricted-platforms.js';

test('built-in route ids map onto their platforms', () => {
	assert.equal(platformForRoute('deepseek-official'), 'deepseek-official');
	assert.equal(platformForRoute('moonshotai'), 'moonshot');
	assert.equal(platformForRoute('zai'), 'zhipu');
	assert.equal(platformForRoute('my-moonshot-gateway'), 'moonshot');
	assert.equal(platformForRoute('glm-router'), 'zhipu');
	assert.equal(platformForRoute('dashscope-beijing'), 'dashscope');
	assert.equal(platformForRoute('totally-unknown'), null);
	assert.equal(platformForRoute(''), null);
	assert.equal(platformForRoute(undefined), null);
});

test('baseURL host matching is hostname-based and label-exact', () => {
	assert.equal(baseURLMatches('moonshot', 'https://api.moonshot.cn/v1'), true);
	assert.equal(
		baseURLMatches('moonshot', 'https://api.moonshot.cn.evil.example/v1'),
		false,
		'a suffix host does not impersonate a platform'
	);
	assert.equal(baseURLMatches('zhipu', 'https://open.bigmodel.cn/api/paas/v4'), true);
	assert.equal(baseURLMatches('dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), true);
	assert.equal(baseURLMatches('deepseek-official', 'https://api.deepseek.com'), true);
	assert.equal(baseURLMatches('moonshot', 'https://api.deepseek.com'), false);
	assert.equal(baseURLMatches('moonshot', 'not a url'), false);
	assert.equal(baseURLMatches(null, 'https://api.moonshot.cn'), false);
	assert.equal(platformForBaseURL('https://api.moonshot.cn/v1', [{ id: 'moonshot' }, { id: 'zhipu' }]), 'moonshot');
	assert.equal(platformForBaseURL('https://gateway.example/v1', [{ id: 'moonshot' }]), null);
});

test('routesFromLlm reads every surface defensively', () => {
	assert.deepEqual(routesFromLlm(null), []);
	assert.deepEqual(routesFromLlm({}), []);
	// A throwing getter only removes its own contribution.
	const routes = routesFromLlm({
		routes() {
			throw new Error('boom');
		},
		providers: () => [{ id: 'moonshotai', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' }]
	});
	assert.deepEqual(routes, [
		{ routeId: 'moonshotai', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' }
	]);
});

test('routesFromLlm reads pi-ai style records and Maps, exactly once', () => {
	// `dsh-llm-pi-ai` declares routes as a record of id → profile; reading the
	// same surface twice would double every row, so the result must be exact.
	const record = routesFromLlm({
		providers: {
			moonshotai: { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
			zai: {}
		}
	});
	assert.deepEqual(record, [
		{ routeId: 'moonshotai', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
		{ routeId: 'zai', baseURL: null, apiKeyEnv: null }
	]);
	const map = routesFromLlm({ providerProfiles: new Map([['zai', { baseURL: 'https://open.bigmodel.cn/v4' }]]) });
	assert.deepEqual(map, [{ routeId: 'zai', baseURL: 'https://open.bigmodel.cn/v4', apiKeyEnv: null }]);
});

test('the card list follows discovery, not a fixed set', () => {
	const merged = mergePlatforms({
		routes: [
			{ routeId: 'deepseek-official', baseURL: null, apiKeyEnv: null },
			// A NON-default host: the assertion is that the route's own endpoint
			// wins, which a URL equal to the platform default could not prove.
			{ routeId: 'moonshotai', baseURL: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY' }
		],
		observed: [],
		overrides: []
	});
	assert.deepEqual(
		merged.map(row => row.id),
		['deepseek-official', 'moonshot']
	);
	const moonshot = merged.find(row => row.id === 'moonshot');
	assert.equal(moonshot.baseURL, 'https://api.moonshot.ai/v1', 'the route baseURL wins over the default');
	assert.equal(moonshot.apiKeyEnv, 'MOONSHOT_API_KEY', 'the route credential reference wins');
	assert.equal(moonshot.capabilities.balance, true, 'Kimi cards carry a balance area');
});

test('a route credential is bound to the route host, never the vendor default', () => {
	// Regression for the cross-host credential leak: a `zai` route declaring a
	// private gateway used to keep the platform's default baseURL, and the
	// refresh path would send ZAI_KEY to bigmodel.cn. The route host must win,
	// and the pair must be marked bound.
	const merged = mergePlatforms({
		routes: [{ routeId: 'zai', baseURL: 'https://my-private-gw.example/v4', apiKeyEnv: 'ZAI_KEY' }],
		observed: [],
		overrides: []
	});
	const zhipu = merged.find(row => row.id === 'zhipu');
	assert.ok(zhipu, 'the route still earns its card');
	assert.equal(zhipu.baseURL, 'https://my-private-gw.example/v4', 'the route endpoint is kept, not the vendor default');
	assert.equal(zhipu.baseUrlBound, true, 'credential and host form a bound pair');
});

test('a platform default baseURL stays null without any route declaring one', () => {
	// The default must never be pre-filled: only a route or override may name
	// the host the credential is sent to.
	const merged = mergePlatforms({
		routes: [{ routeId: 'moonshotai', baseURL: null, apiKeyEnv: null }],
		observed: [],
		overrides: []
	});
	assert.equal(merged.find(row => row.id === 'moonshot').baseURL, null);
});

test('an unknown gateway route earns a metering-only card; a platform never called stays off', () => {
	const merged = mergePlatforms({
		routes: [{ routeId: 'my-gateway', baseURL: 'https://gw.example/v1', apiKeyEnv: 'GW_KEY' }],
		observed: ['my-gateway', 'moonshotai'],
		overrides: []
	});
	const gateway = merged.find(row => row.id === 'my-gateway');
	assert.ok(gateway, 'an observed unknown route keeps its card');
	assert.equal(gateway.capabilities.balance, false, 'the generic group has no balance API');
	assert.equal(gateway.observed, true);
	assert.equal(merged.find(row => row.id === 'moonshot').observed, true);
	// A known platform with no route and no record must not appear at all.
	assert.equal(
		merged.some(row => row.id === 'zhipu'),
		false
	);
});

test('overrides rename, disable, and re-point discovered platforms', () => {
	const overrides = normalizeProviderOverrides([
		{ id: 'moonshot', label: 'Kimi 中国', baseURL: 'https://api.moonshot.ai/v1' },
		{ id: 'zhipu', enabled: false },
		{ not: 'an entry' }
	]);
	assert.equal(overrides.length, 2, 'malformed rows are dropped');

	const merged = mergePlatforms({
		routes: [{ routeId: 'moonshotai', baseURL: null, apiKeyEnv: null }],
		observed: [],
		overrides
	});
	assert.equal(
		merged.some(row => row.id === 'zhipu'),
		false,
		'a disabled platform has no card'
	);
	const moonshot = merged.find(row => row.id === 'moonshot');
	assert.equal(moonshot.label, 'Kimi 中国');
	assert.equal(moonshot.baseURL, 'https://api.moonshot.ai/v1');
});

test('Kimi balance reads the official endpoint into the DeepSeek-compatible shape', async () => {
	let calledUrl = '';
	const fetchImpl = async url => {
		calledUrl = String(url);
		return new Response(
			JSON.stringify({ available_balance: '43.36', voucher_balance: '10.00', charge_balance: '33.36' }),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	};
	const balance = await fetchBalance({
		baseURL: 'https://api.moonshot.cn/v1',
		apiKey: 'k',
		timeoutMs: 1000,
		fetchImpl
	});
	assert.match(calledUrl, /\/users\/me\/balance$/, 'the documented balance endpoint is called');
	assert.equal(balance.isAvailable, true);
	assert.deepEqual(balance.infos, [
		{ currency: 'CNY', totalBalance: 43.36, grantedBalance: 10, toppedUpBalance: 33.36 }
	]);
});

test('Kimi model list maps onto the shared shape', async () => {
	const fetchImpl = async () =>
		new Response(JSON.stringify({ data: [{ id: 'kimi-k3', object: 'model' }] }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	const models = await fetchModels({
		baseURL: 'https://api.moonshot.cn/v1',
		apiKey: 'k',
		timeoutMs: 1000,
		fetchImpl
	});
	assert.deepEqual(models, [{ id: 'kimi-k3', ownedBy: null }]);
});

test('GLM/Qwen model lists read the OpenAI-compatible /models', async () => {
	for (const base of ['https://open.bigmodel.cn/api/paas/v4', 'https://dashscope.aliyuncs.com/compatible-mode/v1']) {
		const fetchImpl = async () =>
			new Response(JSON.stringify({ data: [{ id: 'a-model' }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		const models = await fetchOpenAICompatibleModels({ baseURL: base, apiKey: 'k', timeoutMs: 1000, fetchImpl });
		assert.deepEqual(models, [{ id: 'a-model', ownedBy: null }]);
	}
});

test('a DashScope region mismatch maps onto its own code', async () => {
	const fetchImpl = async () =>
		new Response(JSON.stringify({ error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } }), {
			status: 401,
			headers: { 'content-type': 'application/json' }
		});
	await assert.rejects(
		() =>
			fetchOpenAICompatibleModels({
				baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
				apiKey: 'k',
				timeoutMs: 1000,
				fetchImpl
			}),
		error => error.code === 'KEY_REGION_MISMATCH'
	);
});
