/**
 * Zhipu GLM and Alibaba DashScope (Qwen) clients: metering-limited support.
 *
 * Neither platform publishes an official balance or usage endpoint today (see
 * `docs/upgrade-plan.md` §2), so these clients only fetch the OpenAI-compatible
 * model list. The panel renders their cards with the balance/usage areas
 * explicitly unavailable rather than erroring, and the session metering block
 * stays the source of truth for actual consumption.
 *
 * @module dsh-plugin-usageledger/zhipu
 * @module dsh-plugin-usageledger/dashscope
 */

/**
 * One failed model-list call, tagged with the panel's stable codes. A region
 * mismatch (DashScope keys are region-bound) gets its own code with a remedy,
 * because a generic 401 reads as "bad key" when the key is fine.
 */
export class RestrictedPlatformError extends Error {
	/**
	 * @param {string} code - stable machine code.
	 * @param {string} message - human-readable detail.
	 * @param {number} [status] - HTTP status when there was a response.
	 */
	constructor(code, message, status) {
		super(message);
		this.name = 'RestrictedPlatformError';
		this.code = code;
		this.status = status;
	}
}

/**
 * Whether one thrown fetch error means "the abort fired" — the same three
 * shapes the other clients recognize.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true when the failure is the abort itself.
 */
function isAbortFailure(error) {
	if (error === null || typeof error !== 'object') return false;
	const name = /** @type {string | undefined} */ (error?.name);
	if (name === 'AbortError' || name === 'TimeoutError') return true;
	const message = String(/** @type {Error} */ (error)?.message ?? '');
	return /\babort(ed)?\b/iu.test(message);
}

/**
 * Map one failure onto the panel's stable codes. A DashScope 401 whose body
 * spells `invalid_api_key` is the documented cross-region mismatch, not an
 * invalid credential.
 *
 * @param {number} status - HTTP status.
 * @param {unknown} payload - parsed body, when one arrived.
 * @returns {string} the stable code.
 */
function codeFor(status, payload) {
	const detail = String((payload && typeof payload === 'object' && (payload.error?.code ?? payload.code)) ?? '');
	if (status === 401 && /invalid_api_key/u.test(detail)) return 'KEY_REGION_MISMATCH';
	if (status === 401) return 'UNAUTHORIZED';
	if (status === 403) return 'FORBIDDEN';
	if (status === 404) return 'UNSUPPORTED_ENDPOINT';
	if (status === 429) return 'RATE_LIMITED';
	return `HTTP_${status}`;
}

/**
 * Perform one authenticated JSON GET against an OpenAI-compatible base.
 *
 * @param {object} params - request inputs.
 * @param {string} params.url - absolute URL.
 * @param {string} params.apiKey - bearer credential.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<object>} the parsed JSON body.
 * @throws {RestrictedPlatformError} when the call fails or the body is not JSON.
 */
async function requestJson({ url, apiKey, timeoutMs, fetchImpl = globalThis.fetch }) {
	const abort = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = abort === null ? null : setTimeout(() => abort.abort(), timeoutMs);
	timer?.unref?.();
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'GET',
			headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
			...(abort === null ? {} : { signal: abort.signal })
		});
	} catch (error) {
		const aborted = isAbortFailure(error);
		throw new RestrictedPlatformError(
			aborted ? 'TIMEOUT' : 'NETWORK',
			aborted ? `request timed out after ${timeoutMs}ms` : String(error?.message ?? error)
		);
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
	let payload = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}
	if (!response.ok) {
		const detail = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
		throw new RestrictedPlatformError(codeFor(response.status, payload), String(detail), response.status);
	}
	if (payload === null || typeof payload !== 'object') {
		throw new RestrictedPlatformError('MALFORMED', 'response body was not JSON');
	}
	return payload;
}

/**
 * `GET /models` on an OpenAI-compatible base, shared by both platforms.
 *
 * @param {object} params - call inputs.
 * @param {string} params.baseURL - API root without a trailing slash.
 * @param {string} params.apiKey - bearer credential.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<{ id: string, ownedBy: string | null }[]>} the model list.
 */
export async function fetchOpenAICompatibleModels({ baseURL, apiKey, timeoutMs, fetchImpl }) {
	const payload = await requestJson({ url: `${baseURL}/models`, apiKey, timeoutMs, fetchImpl });
	const data =
		Array.isArray(payload.data) ? payload.data
		: Array.isArray(payload.models) ? payload.models
		: [];
	return data
		.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
		.map(entry => ({ id: entry.id, ownedBy: typeof entry.owned_by === 'string' ? entry.owned_by : null }));
}

/** GLM: model list only — the balance/usage endpoints are not published. */
export const zhipu = { fetchModels: fetchOpenAICompatibleModels };

/** Qwen (DashScope): model list only; keys are region-bound to the baseURL. */
export const dashscope = { fetchModels: fetchOpenAICompatibleModels };
