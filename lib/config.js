/**
 * UsageLedger plugin configuration: defaults, normalization, and URL resolution.
 *
 * Deliberately dependency-free. An out-of-tree plugin installed into a dsh
 * profile cannot resolve the harness's own packages (`profiles/<name>/node_modules`
 * carries no `@deepseek-ai` scope), so the host half imports nothing but
 * `node:` builtins and globals.
 *
 * @module dsh-plugin-usageledger/config
 */

import { normalizeProviderOverrides, PLATFORM_CREDENTIAL_REFS, PLATFORM_IDS } from './provider.js';

/** Public DeepSeek API root: serves `GET /user/balance` and `GET /models`. */
export const DEFAULT_API_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek platform console root: serves the account's own usage endpoints. */
export const DEFAULT_PLATFORM_BASE_URL = 'https://platform.deepseek.com';

/** Default credential reference holding the DeepSeek API key. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';

/** Default credential reference holding the platform console token. */
export const DEFAULT_CONSOLE_TOKEN_ENV = 'DEEPSEEK_PLATFORM_TOKEN';

/** Provider route registered by `@deepseek-ai/dsh-llm-deepseek`. */
export const DEFAULT_PROVIDER = 'deepseek-official';

/** Console token prefix check: the console issues a JWT, the API issues `sk-…`. */
export const MIN_CONSOLE_TOKEN_LENGTH = 16;

/** @returns {boolean} whether the value is a non-array object. */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce one integer setting, falling back to the default when unusable.
 * @param {unknown} value - raw configured value.
 * @param {number} fallback - value used when `value` is not a usable integer.
 * @param {{ min?: number, max?: number }} [bounds] - inclusive accepted range.
 * @returns {number} the coerced integer.
 */
function integer(value, fallback, bounds = {}) {
	const min = bounds.min ?? 0;
	const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed)) return fallback;
	const truncated = Math.trunc(parsed);
	if (truncated < min || truncated > max) return fallback;
	return truncated;
}

/** @returns {string | null} a trimmed non-empty string, or null. */
function text(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/** @returns {string | null} a trimmed URL without trailing slashes, or null. */
function url(value) {
	const raw = text(value);
	return raw === null ? null : raw.replace(/\/+$/u, '');
}

/**
 * Resolve the plugin's effective configuration.
 *
 * Every field is optional; unknown fields are ignored rather than rejected, so
 * a profile patch written against a newer build still loads.
 *
 * @param {unknown} raw - the loader row's `config` value.
 * @returns {object} fully defaulted configuration.
 */
export function resolveConfig(raw) {
	const input = isPlainObject(raw) ? raw : {};
	const api = isPlainObject(input.api) ? input.api : {};
	const platform = isPlainObject(input.platform) ? input.platform : {};
	const providers =
		Array.isArray(input.trackProviders) ?
			input.trackProviders.map(text).filter(entry => entry !== null)
		:	[DEFAULT_PROVIDER];

	return {
		/** Credential reference holding the DeepSeek API key. */
		apiKeyEnv: text(input.apiKeyEnv) ?? DEFAULT_API_KEY_ENV,
		/** Credential reference holding the platform console token. */
		consoleTokenEnv: text(input.consoleTokenEnv) ?? DEFAULT_CONSOLE_TOKEN_ENV,
		/** Provider routes whose in-flight model the entry follows. */
		providers,
		/** Follow every provider route, not just {@link providers}. */
		trackAllProviders: input.trackAllProviders === true,
		/** Official API (API key): balance and model list. */
		api: {
			enabled: api.enabled !== false,
			baseURL: url(api.baseURL) ?? url(process.env?.DEEPSEEK_BASE_URL) ?? DEFAULT_API_BASE_URL,
			timeoutMs: integer(api.timeoutMs, 15000, { min: 500, max: 120000 }),
			/** Balance/model refresh cadence. */
			intervalMs: integer(api.intervalMs, 60000, { min: 5000, max: 86400000 }),
			/** Floor between two on-demand refreshes, so a hot panel cannot spam the API. */
			minRefreshMs: integer(api.minRefreshMs, 5000, { min: 0, max: 600000 })
		},
		/** Platform console (console token): account usage totals and daily series. */
		platform: {
			enabled: platform.enabled !== false,
			baseURL: url(platform.baseURL) ?? DEFAULT_PLATFORM_BASE_URL,
			timeoutMs: integer(platform.timeoutMs, 20000, { min: 500, max: 120000 }),
			/** Usage refresh cadence; usage changes slowly, so it is rarer than balance. */
			intervalMs: integer(platform.intervalMs, 300000, { min: 30000, max: 86400000 }),
			/** Floor between two on-demand usage refreshes. */
			minRefreshMs: integer(platform.minRefreshMs, 30000, { min: 0, max: 600000 })
		},
		/** Milliseconds between SSE heartbeats. */
		heartbeatMs: integer(input.heartbeatMs, 15000, { min: 1000, max: 120000 }),
		/** Maximum concurrent SSE clients. */
		maxSseClients: integer(input.maxSseClients, 8, { min: 1, max: 64 }),
		/** Allow a non-loopback browser origin to read the snapshot. */
		allowRemote: input.allowRemote === true,
		/**
		 * Pin the session whose usage the panel reports. Unset (the default), the
		 * plugin reports the only live session, or the newest one when several are
		 * live — and says how many it saw, so an ambiguous guess is visible.
		 */
		sessionId: text(input.sessionId),
		/**
		 * Per-platform overrides over the discovered platform list. Optional by
		 * design: billing cards follow the harness's model routes without any
		 * configuration here, and an entry only renames, disables, or re-points a
		 * platform the discovery already found (or declares one it did not).
		 */
		platformOverrides: normalizeProviderOverrides(input.providers),
		/** Per-platform refresh/timeout tuning, keyed by platform id with defaults. */
		platformDefaults: {
			...Object.fromEntries(
				PLATFORM_IDS.map(id => [
					id,
					{
						apiKeyEnv: PLATFORM_CREDENTIAL_REFS[id],
						timeoutMs: 15000,
						intervalMs: 60000,
						minRefreshMs: 5000
					}
				])
			)
		}
	};
}

/**
 * Whether a pasted console token looks usable. The console issues a JWT; an
 * `sk-` API key is a common mix-up and is rejected before it reaches the store.
 *
 * @param {unknown} value - candidate token.
 * @returns {boolean} true when the shape is acceptable.
 */
export function looksLikeConsoleToken(value) {
	const raw = text(value);
	if (raw === null || raw.length < MIN_CONSOLE_TOKEN_LENGTH) return false;
	if (/\s/u.test(raw)) return false;
	if (raw.startsWith('sk-')) return false;
	return /^[A-Za-z0-9._~+/=-]+$/u.test(raw);
}

/**
 * The DeepSeek platform stores `userToken` in Local Storage as a JSON object,
 * e.g. `{"value":"<jwt>","expiresAt":…}`, not as a bare JWT. A user copying the
 * Local Storage "Value" verbatim pastes the whole JSON string, which the shape
 * check would otherwise reject as `INVALID_TOKEN`.
 *
 * This extracts the inner token from such an envelope (keys `value`, `token`,
 * or `accessToken`) and otherwise returns the trimmed input untouched, so both
 * a raw JWT and a direct copy of the `userToken` Value are accepted.
 *
 * @param {unknown} value - candidate token, possibly JSON-wrapped.
 * @returns {string} the normalized token (or the original string).
 */
export function normalizeConsoleToken(value) {
	if (typeof value !== 'string') return value === null || value === undefined ? '' : String(value);
	const trimmed = value.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed !== null && typeof parsed === 'object') {
				const candidate = parsed.value ?? parsed.token ?? parsed.accessToken;
				if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
			}
		} catch {
			// Not JSON after all — fall through and return the trimmed string.
		}
	}
	return trimmed;
}
