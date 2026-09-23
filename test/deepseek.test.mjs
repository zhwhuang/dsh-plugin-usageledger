/** DeepSeek open-API client: the two documented account endpoints. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DeepSeekError, fetchBalance, fetchModels, preferredBalance } from '../lib/deepseek.js';

/** A fetch double answering one route table. */
function fakeFetch(routes) {
	const calls = [];
	return {
		calls,
		async fetchImpl(url, init) {
			calls.push({ url, init });
			const route = routes[url] ?? routes['*'];
			if (route === undefined)
				return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
			if (typeof route === 'function') return route(url, init);
			return new Response(JSON.stringify(route.body), {
				status: route.status ?? 200,
				headers: { 'content-type': 'application/json' }
			});
		}
	};
}

const BASE = 'https://api.deepseek.com';

test('reads the balance with the API key and normalizes every field', async () => {
	const fake = fakeFetch({
		[`${BASE}/user/balance`]: {
			body: {
				is_available: true,
				balance_infos: [
					{ currency: 'CNY', total_balance: '43.36', granted_balance: '0.00', topped_up_balance: '43.36' }
				]
			}
		}
	});
	const balance = await fetchBalance({
		baseURL: BASE,
		apiKey: 'sk-secret',
		timeoutMs: 1000,
		fetchImpl: fake.fetchImpl
	});

	assert.equal(balance.isAvailable, true);
	assert.deepEqual(balance.infos, [
		{ currency: 'CNY', totalBalance: 43.36, grantedBalance: 0, toppedUpBalance: 43.36 }
	]);
	assert.equal(fake.calls.length, 1, 'exactly one request');
	assert.equal(fake.calls[0].init.headers.authorization, 'Bearer sk-secret', 'the key travels as a bearer token');
	assert.equal(fake.calls[0].init.method, 'GET');
});

test('keeps both currencies and prefers CNY without converting', async () => {
	const fake = fakeFetch({
		[`${BASE}/user/balance`]: {
			body: {
				is_available: true,
				balance_infos: [
					{ currency: 'USD', total_balance: '6.10', granted_balance: '0', topped_up_balance: '6.10' },
					{ currency: 'CNY', total_balance: '43.36', granted_balance: '0', topped_up_balance: '43.36' }
				]
			}
		}
	});
	const balance = await fetchBalance({ baseURL: BASE, apiKey: 'k', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
	assert.equal(balance.infos.length, 2);
	assert.equal(preferredBalance(balance).currency, 'CNY', 'the panel shows CNY when the account quotes it');

	const usdOnly = preferredBalance({
		infos: [{ currency: 'USD', totalBalance: 1, grantedBalance: 0, toppedUpBalance: 1 }]
	});
	assert.equal(usdOnly.currency, 'USD', 'a USD-only account stays USD rather than being converted');
});

test('an unusable amount becomes null instead of zero', async () => {
	const fake = fakeFetch({
		[`${BASE}/user/balance`]: {
			body: {
				is_available: false,
				balance_infos: [{ currency: 'CNY', total_balance: 'n/a', granted_balance: null, topped_up_balance: '' }]
			}
		}
	});
	const balance = await fetchBalance({ baseURL: BASE, apiKey: 'k', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
	assert.deepEqual(balance.infos[0], {
		currency: 'CNY',
		totalBalance: null,
		grantedBalance: null,
		toppedUpBalance: null
	});
	assert.equal(preferredBalance(balance).totalBalance, null, 'the panel prints a dash rather than ¥0.00');
});

test('lists the models the key may call', async () => {
	const fake = fakeFetch({
		[`${BASE}/models`]: {
			body: {
				object: 'list',
				data: [
					{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
					{ id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
					{ id: '', object: 'model' }
				]
			}
		}
	});
	const models = await fetchModels({ baseURL: BASE, apiKey: 'k', timeoutMs: 1000, fetchImpl: fake.fetchImpl });
	assert.deepEqual(models, [
		{ id: 'deepseek-flash', ownedBy: 'deepseek' },
		{ id: 'deepseek-v4-pro', ownedBy: 'deepseek' }
	]);
});

test('maps HTTP failures onto stable codes', async () => {
	for (const [status, code] of [
		[401, 'UNAUTHORIZED'],
		[402, 'INSUFFICIENT_BALANCE'],
		[429, 'RATE_LIMITED'],
		[500, 'HTTP_500']
	]) {
		const fake = fakeFetch({ [`${BASE}/user/balance`]: { status, body: { error: { message: 'nope' } } } });
		await assert.rejects(
			() => fetchBalance({ baseURL: BASE, apiKey: 'k', timeoutMs: 1000, fetchImpl: fake.fetchImpl }),
			error => {
				assert.ok(error instanceof DeepSeekError);
				assert.equal(error.code, code);
				assert.equal(error.status, status);
				return true;
			}
		);
	}
});

test('a transport failure and a non-JSON body both raise, never return empty data', async () => {
	await assert.rejects(
		() =>
			fetchModels({
				baseURL: BASE,
				apiKey: 'k',
				timeoutMs: 1000,
				fetchImpl: async () => {
					throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
				}
			}),
		error => error.code === 'NETWORK' && /socket hang up/u.test(error.message)
	);
	const fake = fakeFetch({
		[`${BASE}/models`]: () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
	});
	await assert.rejects(
		() => fetchModels({ baseURL: BASE, apiKey: 'k', timeoutMs: 1000, fetchImpl: fake.fetchImpl }),
		error => error.code === 'MALFORMED'
	);
});

test('a hanging request times out instead of blocking the panel', async () => {
	const fetchImpl = (url, init) =>
		new Promise((resolve, reject) => {
			init.signal?.addEventListener('abort', () =>
				reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
			);
		});
	await assert.rejects(
		() => fetchBalance({ baseURL: BASE, apiKey: 'k', timeoutMs: 20, fetchImpl }),
		error => error.code === 'TIMEOUT'
	);
});

test('a DOMException TimeoutError abort is TIMEOUT, not NETWORK', async () => {
	// A DOM runtime surfaces the same abort as a DOMException whose name is
	// `TimeoutError`; matching only `AbortError` misfiled it as a network fault.
	const fetchImpl = (url, init) =>
		new Promise((resolve, reject) => {
			init.signal?.addEventListener('abort', () =>
				reject(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))
			);
		});
	await assert.rejects(
		() => fetchBalance({ baseURL: BASE, apiKey: 'k', timeoutMs: 20, fetchImpl }),
		error => error.code === 'TIMEOUT' && /timed out after 20ms/u.test(error.message)
	);
});

test('a message-only abort (signal.reason) is TIMEOUT, not NETWORK', async () => {
	// Some runtimes propagate `signal.reason` — a plain error whose message
	// spells the abort out — instead of an `AbortError` name.
	const fetchImpl = (url, init) =>
		new Promise((resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
		});
	await assert.rejects(
		() => fetchModels({ baseURL: BASE, apiKey: 'k', timeoutMs: 20, fetchImpl }),
		error => error.code === 'TIMEOUT'
	);
});
