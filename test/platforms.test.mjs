/**
 * Whole-plugin behaviour across platforms: a route added on the harness model
 * page grows a billing card without any plugin configuration, and one
 * platform's failure never hides another's data.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import {
	createFakeContext,
	createFakeCredentials,
	createFakeRequest,
	createFakeResponse,
	createFakeWebServer,
	delay,
	jsonOf,
	routeOf
} from '../test-utils/harness.mjs';

const API_KEY = 'sk-live-secret-value-123456';
const MOONSHOT_KEY = 'sk-moonshot-live-key-value';

/** A fetch double serving the DeepSeek and Kimi endpoints the plugin uses. */
function createFetchDouble({ moonshotFails = false } = {}) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		const json = (body, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
		if (url.includes('/users/me/balance')) {
			if (moonshotFails) return json({ error: { message: 'Authentication Fails' } }, 401);
			return json({ available_balance: '88.00', voucher_balance: '8.00', charge_balance: '80.00' });
		}
		if (url.includes('moonshot') && url.endsWith('/models')) {
			return json({ data: [{ id: 'kimi-k3', object: 'model' }] });
		}
		if (url.endsWith('/user/balance')) {
			return json({
				is_available: true,
				balance_infos: [
					{ currency: 'CNY', total_balance: '43.36', granted_balance: '0.00', topped_up_balance: '43.36' }
				]
			});
		}
		if (url.endsWith('/models')) {
			return json({ data: [{ id: 'deepseek-flash', object: 'model' }] });
		}
		if (url.includes('/users/get_user_summary')) {
			return json({ code: 0, data: { total_usage: 1000, monthly_costs: [{ cost: 1.0, currency: 'CNY' }] } });
		}
		if (url.includes('/usage/amount')) return json({ code: 0, data: { total: [] } });
		if (url.includes('/usage/cost')) return json({ code: 0, data: { total: [] } });
		return json({ detail: 'Not Found' }, 404);
	};
	return { fetchImpl, calls };
}

/** Boot the plugin against doubles, with a harness llm route table. */
function boot({ credentials, llmRoutes = [], services = {} } = {}) {
	const webServer = createFakeWebServer();
	const harness = createFakeContext({
		services: {
			webServer,
			credentials,
			llm: llmRoutes.length > 0 ? { providers: () => llmRoutes } : undefined,
			...services
		}
	});
	apply(harness.ctx, {
		api: { intervalMs: 3600000, minRefreshMs: 0 },
		platform: { intervalMs: 3600000, minRefreshMs: 0 },
		heartbeatMs: 60000
	});
	return { harness, webServer };
}

/** Read one snapshot through the registered route. */
async function snapshotOf(harness) {
	const handler = routeOf(harness, '/api/usageledger/snapshot').handler;
	const res = createFakeResponse();
	await handler(createFakeRequest({ method: 'GET', url: '/api/usageledger/snapshot' }), res);
	return jsonOf(res);
}

test('a Kimi route on the model page grows a billing card with no plugin config', async () => {
	const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY, MOONSHOT_API_KEY: MOONSHOT_KEY });
	const double = createFetchDouble();
	const original = globalThis.fetch;
	globalThis.fetch = double.fetchImpl;
	try {
		const { harness } = boot({
			credentials: creds,
			llmRoutes: [
				{ id: 'deepseek-official' },
				{ id: 'moonshotai', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' }
			]
		});
		await delay(30);
		const { snapshot } = await snapshotOf(harness);

		const ids = snapshot.platforms.map(row => row.id);
		assert.deepEqual(ids, ['deepseek-official', 'moonshot'], 'the card list follows the discovered routes');

		const moonshot = snapshot.platforms.find(row => row.id === 'moonshot');
		assert.equal(moonshot.label, 'Kimi');
		assert.equal(moonshot.baseURL, 'https://api.moonshot.cn/v1', 'the route baseURL is used');
		assert.equal(moonshot.error, null);
		assert.equal(moonshot.balance.infos[0].totalBalance, 88, 'the Kimi balance is read from its official endpoint');
		assert.deepEqual(
			moonshot.models.map(row => row.id),
			['kimi-k3']
		);
		assert.equal(
			double.calls.some(call => call.url.includes('/users/me/balance')),
			true,
			'the official balance endpoint was called'
		);
		// The legacy single-platform blocks keep their shape.
		assert.equal(snapshot.api.preferred.totalBalance, 43.36);
		harness.disposeAll();
	} finally {
		globalThis.fetch = original;
	}
});

test('one platform failing never hides another platform data', async () => {
	const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY, MOONSHOT_API_KEY: MOONSHOT_KEY });
	const double = createFetchDouble({ moonshotFails: true });
	const original = globalThis.fetch;
	globalThis.fetch = double.fetchImpl;
	try {
		const { harness } = boot({
			credentials: creds,
			llmRoutes: [
				{ id: 'deepseek-official' },
				{ id: 'moonshotai', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' }
			]
		});
		await delay(30);
		const { snapshot } = await snapshotOf(harness);
		const moonshot = snapshot.platforms.find(row => row.id === 'moonshot');
		assert.equal(moonshot.error.code, 'UNAUTHORIZED', 'the Kimi failure is named on the Kimi card');
		assert.equal(snapshot.api.preferred.totalBalance, 43.36, 'DeepSeek data is untouched');
		harness.disposeAll();
	} finally {
		globalThis.fetch = original;
	}
});

test('no credentials for a platform: the card appears with the reason, never a value', async () => {
	const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
	const double = createFetchDouble();
	const original = globalThis.fetch;
	globalThis.fetch = double.fetchImpl;
	try {
		const { harness } = boot({
			credentials: creds,
			llmRoutes: [{ id: 'moonshotai', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' }]
		});
		await delay(30);
		const { snapshot } = await snapshotOf(harness);
		const moonshot = snapshot.platforms.find(row => row.id === 'moonshot');
		assert.ok(moonshot, 'a discovered platform keeps its card without a credential');
		assert.equal(moonshot.error.code, 'NO_API_KEY');
		assert.equal(moonshot.balance, null);
		assert.equal(
			JSON.stringify(snapshot).includes(MOONSHOT_KEY),
			false,
			'no credential value ever reaches the snapshot'
		);
		harness.disposeAll();
	} finally {
		globalThis.fetch = original;
	}
});

test('an observed provider with no route still earns a metering-only card', async () => {
	const creds = createFakeCredentials({ DEEPSEEK_API_KEY: API_KEY });
	const { harness } = boot({ credentials: creds, llmRoutes: [{ id: 'deepseek-official' }] });
	const listener = harness.events.get('llm/stream')[0];
	const { streamOf, collect, createWaterfall } = await import('../test-utils/harness.mjs');
	const run = createWaterfall(harness, 'llm/stream');
	await collect(
		await run({ provider: 'totally-unknown-gw', model: 'm' }, () => streamOf([{ type: 'text', text: 'hi' }]))
	);
	const { snapshot } = await snapshotOf(harness);
	const gateway = snapshot.platforms.find(row => row.id === 'totally-unknown-gw');
	assert.ok(gateway, 'the observed gateway keeps a card');
	assert.equal(gateway.capabilities.balance, false, 'it has no platform API');
	assert.equal(gateway.observed, true);
	assert.equal(gateway.error, null, 'metering-only is not an error');
	harness.disposeAll();
});
