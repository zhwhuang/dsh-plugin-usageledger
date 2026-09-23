/**
 * UsageLedger host half.
 *
 * The panel is a *view*: every figure it shows is fetched from DeepSeek on
 * demand and kept in memory only. Nothing about usage or balance is written to
 * disk, and the plugin owns no state file.
 *
 * Two credential-backed sources feed it:
 * 1. The DeepSeek API key (`api.deepseek.com`) — `GET /user/balance` and
 *    `GET /models`.
 * 2. The platform console token (`platform.deepseek.com`) — the console's own
 *    usage endpoints, which are the only official source for 累计消费 /
 *    累计 tokens / 每日趋势 / 调用次数.
 *
 * The only harness event the plugin listens to is `llm/stream`, and only to
 * learn which model is in flight for the sidebar label — it counts nothing.
 * Session token counts come from the harness's own `ctx.tokenMeter` fold
 * (see `./session-usage.js`), which is a different 口径 from the console's
 * account-scoped billing figures and is never mixed with them.
 *
 * @module dsh-plugin-usageledger
 */

import { looksLikeConsoleToken, normalizeConsoleToken, resolveConfig } from './config.js';
import { DeepSeekError, fetchBalance, fetchModels, preferredBalance } from './deepseek.js';
import { fetchBalance as fetchMoonshotBalance, fetchModels as fetchMoonshotModels } from './moonshot.js';
import { fetchOpenAICompatibleModels } from './restricted-platforms.js';
import { fetchSummary, fetchUsage, normalizeUsage } from './platform.js';
import { mergePlatforms, PLATFORM_IDS, routesFromLlm } from './provider.js';
import { createGate, createRoutes, createSseHub, ROUTE_PATHS } from './routes.js';
import { readSessionUsage } from './session-usage.js';

/** Plugin name shown by the loader. */
export const name = 'usageledger';

/** No required services: every dependency is optional and read lazily. */
export const inject = [];

/**
 * Build the host logger, degrading to the console when the harness logger is absent.
 * @param {object} ctx - host cordis context.
 * @returns {{ info: Function, warn: Function }} logger.
 */
function createLogger(ctx) {
	try {
		if (typeof ctx?.logger === 'function') {
			const logger = ctx.logger('usageledger');
			if (logger !== null && typeof logger?.warn === 'function') {
				return { info: (...args) => logger.info?.(...args), warn: (...args) => logger.warn(...args) };
			}
		}
	} catch {
		// A context without the logging service is normal in tests and headless boots.
	}
	return {
		info: (...args) => console.log('[usageledger]', ...args),
		warn: (...args) => console.warn('[usageledger]', ...args)
	};
}

/**
 * Read the credentials service without declaring it as a hard dependency.
 * @param {object} ctx - host cordis context.
 * @returns {object | null} the service, or null when it is absent.
 */
function credentialsOf(ctx) {
	try {
		const service = typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials;
		return service !== null && service !== undefined && typeof service.resolve === 'function' ? service : null;
	} catch {
		return null;
	}
}

/**
 * Resolve a credential reference for one operation.
 *
 * Resolution happens per call — never cached — so a credential changed in the
 * harness reaches the next refresh without a restart.
 *
 * @param {object} deps - inputs.
 * @param {object | null} deps.credentials - credentials service.
 * @param {string} deps.ref - credential reference (environment-variable name).
 * @returns {Promise<{ value: string, source: string } | null>} the value, or null.
 */
async function resolveSecret({ credentials, ref }) {
	if (credentials === null) {
		const fromEnv = typeof process.env?.[ref] === 'string' ? process.env[ref] : '';
		return fromEnv === '' ? null : { value: fromEnv, source: 'env' };
	}
	try {
		const resolved = await credentials.resolve(ref);
		if (resolved === null || resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '')
			return null;
		return { value: resolved.value, source: typeof resolved.source === 'string' ? resolved.source : 'unknown' };
	} catch (error) {
		throw new DeepSeekError('CREDENTIAL_ERROR', String(error?.message ?? error));
	}
}

/**
 * Describe a credential without exposing its value.
 * @param {object} deps - inputs.
 * @param {object | null} deps.credentials - credentials service.
 * @param {string} deps.ref - credential reference.
 * @returns {Promise<{ configured: boolean, source: string | null, writable: boolean }>} presence facts.
 */
async function describeSecret({ credentials, ref }) {
	if (credentials === null || typeof credentials.describe !== 'function') {
		return {
			configured: typeof process.env?.[ref] === 'string' && process.env[ref] !== '',
			source: 'env',
			writable: false
		};
	}
	try {
		const info = await credentials.describe(ref);
		return {
			configured: info?.configured === true,
			source: typeof info?.source === 'string' ? info.source : null,
			writable: info?.writable === true
		};
	} catch {
		return { configured: false, source: null, writable: false };
	}
}

/** @returns {string} the `YYYY-MM` key of the current local month. */
function currentMonthKey(now = Date.now()) {
	const date = new Date(now);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Host plugin entry.
 * @param {object} ctx - host cordis context.
 * @param {object} [rawConfig] - loader row configuration.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	const logger = createLogger(ctx);
	/**
	 * The credentials service is resolved per operation, never captured: the
	 * plugin declares no service dependencies, so it is applied before the
	 * credentials provider registers — a value captured here would stay
	 * `undefined` and every read would fall back to the bare process environment.
	 */
	const credentialsNow = () => credentialsOf(ctx);

	/* ------------------------------------------------------------------ *
	 * In-memory facts. Nothing here is persisted.
	 * ------------------------------------------------------------------ */

	/** Latest successful open-API read. */
	let apiFacts = { balance: null, models: [], at: 0, error: null };
	/** Latest successful console read. */
	let usageFacts = { usage: null, at: 0, month: currentMonthKey(), error: null };
	/**
	 * Per-platform facts, keyed by platform id. Each entry mirrors the api/usage
	 * facts shape for one platform the discovery found. DeepSeek's own entries
	 * are the legacy `apiFacts`/`usageFacts` pair re-exported into this map, so
	 * the single-platform snapshot keeps its exact shape.
	 */
	let platformFacts = new Map();
	/**
	 * Provider ids observed carrying traffic in sessions (from `llm/stream`).
	 * A platform with a record but no credentials still earns a metering card.
	 */
	let observedProviders = [];
	/**
	 * Latest session-scoped measurement (see `./session-usage.js`). Replaced
	 * wholesale by `refreshSessionUsage`, never merged with `usageFacts`.
	 */
	let sessionUsage = null;
	/** The model of the call in flight, else the last one seen. */
	let liveModel = null;
	let revision = 0;
	let apiInflight = null;
	let usageInflight = null;
	let apiLastAttemptAt = 0;
	let usageLastAttemptAt = 0;
	/** Per-platform inflight promises and attempt floors, keyed by platform id. */
	const platformInflight = new Map();
	/** Floor between two *forced* refreshes of one platform (see refreshOnePlatform). */
	const PLATFORM_FORCE_FLOOR_MS = 5000;
	const platformLastAttemptAt = new Map();

	/**
	 * The platform rows the snapshot renders: harness routes + observed
	 * activity + config overrides, merged by the registry. Recomputed per
	 * snapshot rather than cached, so a route added on the model page appears
	 * at the next read without any plugin restart.
	 */
	function currentPlatforms() {
		return mergePlatforms({
			routes: routesFromLlm(llmServiceNow()),
			observed: observedProviders,
			overrides: config.platformOverrides
		});
	}

	/** Read the harness llm service lazily; absent in tests and headless boots. */
	function llmServiceNow() {
		try {
			const service = typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm;
			return service !== null && service !== undefined ? service : null;
		} catch {
			return null;
		}
	}

	/** Bump the revision and push a coalesced snapshot to every SSE client. */
	function bump() {
		revision += 1;
		hub?.publish();
	}

	/** @returns {object} the error as a translatable `{ code, message }`. */
	function errorOf(error) {
		if (error === null || error === undefined) return null;
		return {
			code: typeof error.code === 'string' ? error.code : 'ERROR',
			message: String(error?.message ?? error)
		};
	}

	/**
	 * Refresh balance and the model list over the open API.
	 * @param {{ force?: boolean }} [options] - `force` skips both the TTL and the retry floor.
	 * @returns {Promise<object>} the api facts after the attempt.
	 */
	async function refreshApi(options = {}) {
		if (!config.api.enabled) return apiFacts;
		const fresh = apiFacts.error === null && apiFacts.at > 0 && Date.now() - apiFacts.at < config.api.intervalMs;
		if (options.force !== true && fresh) return apiFacts;
		if (apiInflight !== null) return apiInflight;
		if (options.force !== true && Date.now() - apiLastAttemptAt < config.api.minRefreshMs) return apiFacts;
		apiLastAttemptAt = Date.now();

		apiInflight = (async () => {
			const missing = { code: 'NO_API_KEY', message: `credential ${config.apiKeyEnv} is not configured` };
			try {
				const secret = await resolveSecret({ credentials: credentialsNow(), ref: config.apiKeyEnv });
				if (secret === null) {
					apiFacts = { ...apiFacts, error: missing, at: Date.now() };
					return apiFacts;
				}
				const [balance, models] = await Promise.all([
					fetchBalance({
						baseURL: config.api.baseURL,
						apiKey: secret.value,
						timeoutMs: config.api.timeoutMs
					}),
					fetchModels({ baseURL: config.api.baseURL, apiKey: secret.value, timeoutMs: config.api.timeoutMs })
				]);
				apiFacts = { balance, models, at: Date.now(), error: null };
				logger?.info?.(`usageledger: balance and ${models.length} models refreshed`);
			} catch (error) {
				const mapped = errorOf(error);
				logger?.warn?.(`usageledger: balance/models refresh failed (${mapped.code}): ${mapped.message}`);
				apiFacts = { ...apiFacts, error: mapped, at: Date.now() };
			}
			bump();
			return apiFacts;
		})();

		try {
			return await apiInflight;
		} finally {
			apiInflight = null;
		}
	}

	/**
	 * Refresh the console usage figures for the current month.
	 * @param {{ force?: boolean }} [options] - `force` skips both the TTL and the retry floor.
	 * @returns {Promise<object>} the usage facts after the attempt.
	 */
	async function refreshUsage(options = {}) {
		if (!config.platform.enabled) return usageFacts;
		const month = currentMonthKey();
		const monthChanged = usageFacts.month !== month;
		const fresh =
			usageFacts.error === null &&
			usageFacts.at > 0 &&
			!monthChanged &&
			Date.now() - usageFacts.at < config.platform.intervalMs;
		if (options.force !== true && fresh) return usageFacts;
		if (usageInflight !== null) return usageInflight;
		if (options.force !== true && !monthChanged && Date.now() - usageLastAttemptAt < config.platform.minRefreshMs)
			return usageFacts;
		usageLastAttemptAt = Date.now();

		usageInflight = (async () => {
			try {
				const secret = await resolveSecret({ credentials: credentialsNow(), ref: config.consoleTokenEnv });
				if (secret === null) {
					usageFacts = {
						usage: null,
						at: Date.now(),
						month,
						error: {
							code: 'NO_CONSOLE_TOKEN',
							message: `credential ${config.consoleTokenEnv} is not configured`
						}
					};
					return usageFacts;
				}
				const [year, monthNumber] = month.split('-').map(part => Number.parseInt(part, 10));
				// The summary and the two series endpoints are read independently: a
				// partial answer still renders, with the failure reported beside it.
				const [summaryResult, usageResult] = await Promise.allSettled([
					fetchSummary({
						baseURL: config.platform.baseURL,
						token: secret.value,
						timeoutMs: config.platform.timeoutMs
					}),
					fetchUsage({
						baseURL: config.platform.baseURL,
						token: secret.value,
						year,
						month: monthNumber,
						timeoutMs: config.platform.timeoutMs
					})
				]);
				if (summaryResult.status === 'rejected' && usageResult.status === 'rejected')
					throw summaryResult.reason;
				const usage =
					usageResult.status === 'fulfilled' ?
						usageResult.value
					:	{ amount: null, cost: null, partial: null, partialMessage: null };
				const partial = usage.partial ?? (summaryResult.status === 'rejected' ? 'summary' : null);
				const partialError =
					partial === null ? null : (
						{
							code: 'PARTIAL',
							message: `${partial} rows could not be read${usage.partialMessage ? ': ' + usage.partialMessage : ''}`
						}
					);
				usageFacts = {
					usage: normalizeUsage({
						summary: summaryResult.status === 'fulfilled' ? summaryResult.value : null,
						amount: usage.amount,
						cost: usage.cost,
						month,
						logger
					}),
					at: Date.now(),
					month,
					error: partialError
				};
				if (partialError === null) logger?.info?.(`usageledger: console usage refreshed for ${month}`);
				else logger?.warn?.(`usageledger: console usage partially read for ${month}: ${partialError.message}`);
			} catch (error) {
				const mapped = errorOf(error);
				logger?.warn?.(`usageledger: console usage refresh failed (${mapped.code}): ${mapped.message}`);
				usageFacts = { ...usageFacts, month, error: mapped, at: Date.now() };
			}
			bump();
			return usageFacts;
		})();

		try {
			return await usageInflight;
		} finally {
			usageInflight = null;
		}
	}

	/** Refresh every fact the panel shows: credential presence, API, usage, session. */
	async function refreshAll(options = {}) {
		await Promise.all([
			refreshCredentialFacts(),
			refreshApi(options),
			refreshUsage(options),
			refreshPlatforms(options)
		]);
		// The session read is synchronous and credential-free, so it runs after the
		// credential facts land: a session that only appears once the store resolves
		// is then picked up without an extra tick.
		refreshSessionUsage();
	}

	/**
	 * Refresh every discovered non-DeepSeek platform.
	 *
	 * The platform list is recomputed each round, so a route added on the model
	 * page starts refreshing at the next tick. Each platform refreshes
	 * independently via `allSettled`: one platform's failure never blocks or
	 * hides another's data.
	 *
	 * @param {{ force?: boolean }} [options] - `force` skips TTL and retry floors.
	 * @returns {Promise<void>} resolved once every platform round completes.
	 */
	async function refreshPlatforms(options = {}) {
		const rows = currentPlatforms().filter(row => PLATFORM_IDS.includes(row.id) && row.id !== 'deepseek-official');
		if (rows.length === 0) return;
		await Promise.allSettled(rows.map(row => refreshOnePlatform(row, options)));
	}

	/**
	 * Refresh one platform's balance/model facts according to its capabilities.
	 *
	 * @param {object} row - a merged platform row.
	 * @param {{ force?: boolean }} [options] - `force` skips TTL and retry floors.
	 * @returns {Promise<void>} resolved when the platform's facts land.
	 */
	async function refreshOnePlatform(row, options = {}) {
		const defaults = config.platformDefaults[row.id] ?? {};
		const overrideTimeout = row.timeoutMs ?? defaults.timeoutMs;
		const interval = row.intervalMs ?? defaults.intervalMs;
		const minRefresh = defaults.minRefreshMs;
		// A per-platform floor on *forced* refreshes too: one click on the panel's
		// refresh button fans out to every platform, and an unbounded force path
		// turns that click into 2N outbound requests per click.
		const forceFloor = PLATFORM_FORCE_FLOOR_MS;

		const inflight = platformInflight.get(row.id);
		if (inflight !== undefined) return inflight;
		const previous = platformFacts.get(row.id) ?? { balance: null, models: [], at: 0, error: null };
		const fresh = previous.error === null && previous.at > 0 && Date.now() - previous.at < interval;
		if (fresh) return;
		if (Date.now() - (platformLastAttemptAt.get(row.id) ?? 0) < (options.force === true ? forceFloor : minRefresh))
			return;
		platformLastAttemptAt.set(row.id, Date.now());

		const run = (async () => {
			try {
				// Credentials ride with their host. A row whose (credential, endpoint)
				// pair the registry could not bind must not send its key anywhere:
				// metering-only is the honest answer, not a guess.
				const usableCaps =
					row.baseUrlBound === false ?
						{ balance: false, models: false, usage: false }
					:	row.capabilities;
				if (usableCaps.balance !== true && usableCaps.models !== true) {
					platformFacts.set(row.id, { balance: null, models: [], at: previous.at, error: null });
					return;
				}
				const secret = await resolveSecret({ credentials: credentialsNow(), ref: row.apiKeyEnv });
				if (secret === null) {
					platformFacts.set(row.id, {
						...previous,
						error: { code: 'NO_API_KEY', message: `credential ${row.apiKeyEnv} is not configured` },
						at: Date.now()
					});
					return;
				}
				const baseURL = row.baseURL ?? '';
				const calls = [];
				if (usableCaps.balance === true && row.id === 'moonshot') {
					calls.push(fetchMoonshotBalance({ baseURL, apiKey: secret.value, timeoutMs: overrideTimeout }));
				} else if (usableCaps.balance === true) {
					calls.push(fetchBalance({ baseURL, apiKey: secret.value, timeoutMs: overrideTimeout }));
				}
				if (usableCaps.models === true) {
					calls.push(
						row.id === 'moonshot' ?
							fetchMoonshotModels({ baseURL, apiKey: secret.value, timeoutMs: overrideTimeout })
						:	fetchOpenAICompatibleModels({ baseURL, apiKey: secret.value, timeoutMs: overrideTimeout })
					);
				}
				if (calls.length === 0) {
					// Metering-only platform: nothing to fetch, and that is not an error.
					platformFacts.set(row.id, { balance: null, models: [], at: previous.at, error: null });
					return;
				}
				const [balance, models] = await Promise.all([
					calls[0] ?? Promise.resolve(null),
					calls[1] ?? Promise.resolve([])
				]);
				platformFacts.set(row.id, { balance, models, at: Date.now(), error: null });
				logger?.info?.(`usageledger: ${row.id} refreshed (${models.length} models)`);
			} catch (error) {
				const mapped = errorOf(error);
				logger?.warn?.(`usageledger: ${row.id} refresh failed (${mapped.code}): ${mapped.message}`);
				platformFacts.set(row.id, { ...previous, error: mapped, at: Date.now() });
			} finally {
				platformInflight.delete(row.id);
			}
		})();
		platformInflight.set(row.id, run);
		return run;
	}

	/**
	 * Store or clear the console token in the harness credential store.
	 *
	 * The token is validated for shape, written through `credentials.set`, and
	 * dropped: it is never logged, never returned, and never included in a
	 * snapshot that reaches the browser.
	 *
	 * @param {string | null} token - the token to store, or null to clear it.
	 * @returns {Promise<{ configured: boolean, code?: string, message?: string }>} outcome.
	 */
	async function setConsoleToken(token) {
		const credentials = credentialsNow();
		if (credentials === null || typeof credentials.set !== 'function') {
			return {
				configured: false,
				code: 'CREDENTIALS_UNAVAILABLE',
				message: 'the harness credential service is not available'
			};
		}
		try {
			if (token === null) {
				await credentials.unset(config.consoleTokenEnv);
				usageFacts = { usage: null, at: 0, month: currentMonthKey(), error: null };
				await refreshCredentialFacts();
				bump();
				return { configured: false };
			}
			// The Local Storage `userToken` is a JSON envelope; accept a direct copy
			// of it as well as a bare JWT so the panel never rejects a valid paste.
			const normalized = normalizeConsoleToken(token);
			if (!looksLikeConsoleToken(normalized)) {
				return {
					configured: false,
					code: 'INVALID_TOKEN',
					message: 'that does not look like a platform console token'
				};
			}
			await credentials.set(config.consoleTokenEnv, normalized);
			usageLastAttemptAt = 0;
			// Re-read presence and usage together, so the panel that just saved the
			// token immediately sees it as connected.
			await Promise.all([refreshCredentialFacts(), refreshUsage({ force: true })]);
			bump();
			return { configured: true };
		} catch (error) {
			return { configured: false, code: 'STORE_FAILED', message: String(error?.message ?? error) };
		}
	}

	/* ------------------------------------------------------------------ *
	 * Snapshot
	 * ------------------------------------------------------------------ */

	/** Credential presence for the panel: configured/source/writable, never a value. */
	let credentialFacts = {
		apiKey: { configured: false, source: null, writable: false, ref: config.apiKeyEnv },
		consoleToken: { configured: false, source: null, writable: false, ref: config.consoleTokenEnv }
	};

	/** @returns {object} the snapshot served to the browser. */
	function buildSnapshot() {
		const preferred = preferredBalance(apiFacts.balance);
		const current = liveModel;
		const platforms = currentPlatforms().map(row => {
			const facts = platformFacts.get(row.id) ?? null;
			return {
				id: row.id,
				label: row.label,
				baseURL: row.baseURL,
				apiKeyEnv: row.apiKeyEnv,
				observed: row.observed,
				routeIds: row.routeIds,
				capabilities: row.capabilities,
				updatedAt: facts?.at ?? null,
				error: facts?.error ?? null,
				balance: facts?.balance ?? null,
				models: facts?.models ?? []
			};
		});
		// The slowest source's timeout, so the browser can wait at least as long
		// as the host legitimately does instead of reporting a premature failure.
		const hostTimeoutMs = Math.max(
			config.api.timeoutMs,
			config.platform.timeoutMs,
			...[...platformFacts.keys()].map(id => config.platformDefaults[id]?.timeoutMs ?? 0),
			0
		);
		return {
			revision,
			generatedAt: Date.now(),
			api: {
				baseURL: config.api.baseURL,
				updatedAt: apiFacts.at || null,
				error: apiFacts.error,
				balance: apiFacts.balance,
				preferred,
				models: apiFacts.models
			},
			console: {
				baseURL: config.platform.baseURL,
				updatedAt: usageFacts.at || null,
				month: usageFacts.month,
				error: usageFacts.error,
				usage: usageFacts.usage
			},
			/**
			 * One card per discovered platform. Ordered by the registry (observed
			 * first, then label), and carrying only presence facts — the credential
			 * value never appears anywhere in the snapshot.
			 */
			platforms,
			/** Slowest host-side per-request timeout; the browser aligns to it. */
			hostTimeoutMs,
			/**
			 * Session-scoped usage, measured by the harness itself. Deliberately a
			 * sibling of `console`, never folded into it: the console reports what
			 * the *account* was billed, this reports what *this session* the provider
			 * reported. Different 口径, so they are two blocks and never one number.
			 */
			session: sessionUsage,
			credentials: credentialFacts,
			currentModel: current,
			live: {
				streaming: current !== null && current.streaming === true,
				model: current?.model ?? null,
				provider: current?.provider ?? null
			}
		};
	}

	/**
	 * Re-read the session-scoped usage and push only when it actually moved.
	 *
	 * The projection advances on every committed provider usage sample, so this
	 * runs on the same adaptive tick as the credential reads. Comparison is on
	 * the serialized value: the read builds a fresh object every time, so an
	 * identity check would push on every tick and keep the SSE feed warm for
	 * nothing.
	 *
	 * The whole body is guarded: this is invoked from a `setInterval` callback,
	 * and an exception escaping a timer callback in Node terminates the process.
	 * Today the data is plain numbers, but a future shape that serializes badly
	 * (BigInt, a cycle) must degrade to a skipped tick, not a dead host.
	 *
	 * @returns {void}
	 */
	function refreshSessionUsage() {
		try {
			let next;
			try {
				next = readSessionUsage({ ctx, sessionId: config.sessionId });
			} catch (error) {
				logger?.warn?.(`usageledger: session usage read failed: ${String(error?.message ?? error)}`);
				return;
			}
			const before = sessionUsage === null ? '' : JSON.stringify(sessionUsage);
			const after = next === null ? '' : JSON.stringify(next);
			if (before === after) return;
			sessionUsage = next;
			bump();
		} catch (error) {
			// Serialization or fan-out failed; skip this tick rather than die.
			logger?.warn?.(`usageledger: session usage update failed: ${String(error?.message ?? error)}`);
		}
	}

	/** Re-read credential presence; it is safe for a UI and carries no secret. */
	async function refreshCredentialFacts() {
		const [apiKey, consoleToken] = await Promise.all([
			describeSecret({ credentials: credentialsNow(), ref: config.apiKeyEnv }),
			describeSecret({ credentials: credentialsNow(), ref: config.consoleTokenEnv })
		]);
		credentialFacts = {
			apiKey: { ...apiKey, ref: config.apiKeyEnv },
			consoleToken: { ...consoleToken, ref: config.consoleTokenEnv }
		};
	}

	/**
	 * A forced refresh skips both the TTL and the min-refresh floor, so an
	 * automated caller (or a double click) can fire the full 5-request burst
	 * with no gap. `refreshAllBounded` keeps one small floor for exactly that
	 * path — short enough to stay responsive, long enough that hammering the
	 * refresh route cannot translate into hammering DeepSeek. Boot-time calls
	 * pass `warmup: true`, which bypasses the floor: those run once, on purpose.
	 */
	const FORCE_MIN_GAP_MS = 2000;
	let lastForceAt = 0;
	async function refreshAllBounded(options = {}) {
		if (options.force === true && options.warmup !== true) {
			const sinceLast = Date.now() - lastForceAt;
			if (sinceLast < FORCE_MIN_GAP_MS) {
				const wait = FORCE_MIN_GAP_MS - sinceLast;
				lastForceAt = Date.now() + wait;
				await new Promise(resolve => setTimeout(resolve, wait));
			} else {
				lastForceAt = Date.now();
			}
		}
		return refreshAll(options);
	}

	const hub = createSseHub({
		buildPayload: () => ({ type: 'snapshot', revision, snapshot: buildSnapshot() }),
		maxClients: config.maxSseClients,
		heartbeatMs: config.heartbeatMs,
		logger
	});

	const routes = createRoutes({
		buildSnapshot,
		refreshAll: refreshAllBounded,
		setConsoleToken,
		hub,
		gate: createGate({ ctx, config }),
		logger
	});

	/**
	 * Remember which model is in flight for the sidebar label. The stream itself
	 * is forwarded untouched and nothing is counted.
	 *
	 * `llm/stream` is a cordis *waterfall* hook, and cordis drives a waterfall
	 * **synchronously**:
	 *
	 * ```js
	 * waterfall(...args) {
	 *   const cbs = this.dispatch('waterfall', args);
	 *   const inner = args.pop();
	 *   const next = () => (cbs.shift() ?? inner)(...args);
	 *   args.push(next);
	 *   return next();          // never awaited
	 * }
	 * ```
	 *
	 * The caller of `llm.stream()` therefore gets whatever `next()` returns and
	 * iterates it directly. Two consequences this function must respect:
	 *
	 * 1. It must NOT be `async`. An `async` function always returns a Promise, so
	 *    returning its result would hand the harness a Promise where it expects an
	 *    async iterable — the harness then fails with "stream is not async
	 *    iterable". This is a real regression that shipped once.
	 * 2. It must NOT `await next()`. `next()` already returns the stream (the
	 *    adapter is an async generator function, not a promise-returning one), and
	 *    awaiting it would only re-wrap the value in a Promise.
	 *
	 * So the hook stays synchronous, forwards whatever it is handed unchanged, and
	 * only wraps a genuine async iterable in a cursor that observes start and
	 * settle. When the event is a plain (non-waterfall) listener with no `next`,
	 * it only observes and returns undefined, which is harmless.
	 *
	 * @param {object} options - stream options (`provider`, `model`).
	 * @param {(() => AsyncIterable<object>) | undefined} next - waterfall continuation.
	 * @returns {AsyncIterable<object> | undefined} the forwarded stream, or undefined.
	 */
	function trackStream(options, next) {
		const provider = typeof options?.provider === 'string' ? options.provider : '';
		const model = typeof options?.model === 'string' && options.model !== '' ? options.model : null;
		// Every observed provider earns a metering card even when the seat follows
		// only a subset: the platform list is about what the harness *reaches*, and
		// a call through any route is exactly such a fact.
		if (provider !== '' && !observedProviders.includes(provider)) {
			observedProviders = [...observedProviders, provider].sort((left, right) => left.localeCompare(right));
		}
		const tracked = config.trackAllProviders || config.providers.includes(provider);

		// Defensive branch: a plain event listener has no `next`. Observe only and
		// never try to transform a stream we were not handed.
		if (typeof next !== 'function') {
			if (tracked && model !== null) {
				liveModel = { model, provider, streaming: true, at: Date.now() };
				bump();
				Promise.resolve().then(() => {
					liveModel = { model, provider, streaming: false, at: Date.now() };
					bump();
					refreshSessionUsage();
				});
			}
			return undefined;
		}

		// The provider guard is decided *before* the continuation is invoked: a
		// route we do not track must not be entered at all, so the plugin cannot
		// ever affect a stream it has no business observing. `next()` returns the
		// stream directly (never a promise — see the note above) and is forwarded
		// untouched.
		if (!tracked) return next();
		const inner = next();
		if (inner === null || inner === undefined || typeof inner[Symbol.asyncIterator] !== 'function') return inner;
		liveModel = { model, provider, streaming: true, at: Date.now() };
		bump();
		return (async function* forward() {
			try {
				yield* inner;
			} finally {
				liveModel = { model, provider, streaming: false, at: Date.now() };
				bump();
				// A settled request is exactly when the provider's usage sample has just
				// entered the durable log, so this is the one moment worth re-reading.
				refreshSessionUsage();
			}
		})();
	}

	ctx.effect(() => {
		// Polling cadence: fast until the panel actually has data, then slow.
		// Credentials and tokens can resolve after the host boots, so we retry
		// quickly instead of waiting for the normal interval (up to a minute).
		const slowIntervalMs = Math.min(config.api.intervalMs, config.platform.intervalMs);
		const fastIntervalMs = 2000;
		// The "not ready yet" cadence backs off to this ceiling. Without it, a
		// permanently-unready source (an expired console token, a console shape
		// that no longer parses) pins the loop to the 2s floor — and every tick
		// below is forced, so a stuck source then fires the full 5-request burst
		// (balance + models + summary + amount + cost) twice a second forever.
		const fastIntervalCeilingMs = Math.max(fastIntervalMs, Math.min(60000, slowIntervalMs));

		function isDataReady() {
			const apiConfigured = credentialFacts.apiKey.configured;
			const apiReady = !apiConfigured || (apiFacts.error === null && apiFacts.at > 0);
			const tokenConfigured = credentialFacts.consoleToken.configured;
			const usageReady = !config.platform.enabled || !tokenConfigured || usageFacts.usage !== null;
			// Platforms count toward readiness only when a credential for them is
			// actually configured — an unreachable-but-configured platform keeps
			// the fast cadence (with backoff), exactly like the DeepSeek source.
			const platformsReady = currentPlatforms()
				.filter(row => PLATFORM_IDS.includes(row.id) && row.id !== 'deepseek-official')
				.every(row => {
					if (credentialFactsByRef(row.apiKeyEnv) === false) return true;
					const facts = platformFacts.get(row.id);
					return facts !== undefined && facts.error === null && facts.at > 0;
				});
			return apiReady && usageReady && platformsReady;
		}

		/**
		 * Credential presence for one reference, judged from the same facts the
		 * snapshot exposes. The registry default (e.g. `MOONSHOT_API_KEY`) may
		 * differ from the configured DeepSeek reference, so the check is by ref.
		 * @param {string | null} ref - credential reference, or null.
		 * @returns {boolean} whether the harness reports the credential configured.
		 */
		function credentialFactsByRef(ref) {
			if (ref === null || ref === undefined) return false;
			if (ref === config.apiKeyEnv) return credentialFacts.apiKey.configured === true;
			if (ref === config.consoleTokenEnv) return credentialFacts.consoleToken.configured === true;
			// Other platform refs live outside this snapshot's two fact slots; a
			// platform whose ref we cannot see is treated as unconfigured, which
			// keeps the fast cadence until its first successful read proves otherwise.
			return false;
		}

		let apiTimer = null;
		let fastAttempt = 0;
		function scheduleNextRefresh() {
			if (apiTimer !== null) clearTimeout(apiTimer);
			const ready = isDataReady();
			let interval = ready ? slowIntervalMs : fastIntervalMs;
			if (!ready) {
				// Exponential backoff while data has not landed; reset on success.
				fastAttempt += 1;
				interval = Math.min(fastIntervalMs * 2 ** Math.min(fastAttempt - 1, 6), fastIntervalCeilingMs);
			} else {
				fastAttempt = 0;
			}
			apiTimer = setTimeout(() => {
				void refreshAll(ready ? {} : { force: true })
					.catch(error => logger.warn(`usageledger: refresh tick failed: ${String(error?.message ?? error)}`))
					.finally(scheduleNextRefresh);
			}, interval);
			apiTimer.unref?.();
		}

		// Kick off the first read immediately, then start the adaptive loop.
		void refreshAll({ force: true, warmup: true })
			.catch(error => logger.warn(`usageledger: initial refresh failed: ${String(error?.message ?? error)}`))
			.finally(scheduleNextRefresh);

		// Warmup probes give a few extra pushes in the first seconds for
		// credentials, balance, usage and the discovered platforms, in case the
		// credential store resolves late.
		const warmup = [1500, 4000, 8000].map(ms =>
			setTimeout(() => {
				void Promise.all([
					refreshCredentialFacts(),
					refreshApi({ force: true }),
					refreshUsage({ force: true }),
					refreshPlatforms({ force: true })
				]).catch(() => {});
			}, ms)
		);
		warmup.forEach(timer => timer.unref?.());

		// The session read is cheap and local, but the projection only moves when
		// a session is found, so a session created after boot (the usual case:
		// the plugin applies before the first session exists) still gets picked
		// up without waiting for the next API tick.
		let sessionTimer = null;
		sessionTimer = setInterval(refreshSessionUsage, fastIntervalMs);
		sessionTimer.unref?.();

		const offStream = ctx.on?.('llm/stream', trackStream, { global: true });
		return () => {
			for (const timer of warmup) clearTimeout(timer);
			if (apiTimer !== null) clearTimeout(apiTimer);
			if (sessionTimer !== null) clearInterval(sessionTimer);
			try {
				offStream?.();
			} catch {
				// Disposal is best-effort; the fiber is going away regardless.
			}
			hub?.close();
		};
	}, 'usageledger: lifecycle');

	ctx.inject?.(['webServer'], scope => {
		scope.effect(() => {
			const server = scope.get('webServer') ?? scope.webServer;
			if (server === null || server === undefined || typeof server.register !== 'function') return () => {};
			const registered = [
				{ path: ROUTE_PATHS.snapshot, handler: routes.snapshot },
				{ path: ROUTE_PATHS.events, handler: routes.events },
				{ path: ROUTE_PATHS.refresh, handler: routes.refresh },
				{ path: ROUTE_PATHS.consoleToken, handler: routes.consoleToken }
			].map(({ path, handler }) => server.register({ kind: 'exact', path, handler }));
			return () => {
				for (const dispose of registered) {
					try {
						dispose?.();
					} catch {
						// A route already removed by server teardown needs no second removal.
					}
				}
			};
		}, 'usageledger: routes');
	});
}

export default apply;
