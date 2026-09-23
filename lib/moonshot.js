/**
 * Moonshot Kimi client: account balance and the model list.
 *
 * Kimi is the one platform in the registry with an official, documented
 * balance endpoint on its OpenAI-compatible API — the same shape DeepSeek
 * serves, and reachable with the plain API key the harness route already
 * resolves. Only the two account-level endpoints are used:
 *
 * - `GET /v1/users/me/balance` — available/voucher balances, in CNY.
 * - `GET /v1/models` — the model ids this key may call.
 *
 * Everything is read per operation: no response is written to disk, and the
 * key never leaves the host.
 *
 * @see https://platform.moonshot.cn/docs/api/misc#%E6%9F%A5%E8%AF%A2%E8%B4%A6%E6%88%B7%E4%BD%99%E9%A2%9D
 * @module dsh-plugin-usageledger/moonshot
 */

/**
 * One failed Kimi call, tagged with the same stable codes the panel already
 * translates (`TIMEOUT`, `UNAUTHORIZED`, …).
 */
export class MoonshotError extends Error {
	/**
	 * @param {string} code - stable machine code.
	 * @param {string} message - human-readable detail.
	 * @param {number} [status] - HTTP status when there was a response.
	 */
	constructor(code, message, status) {
		super(message);
		this.name = 'MoonshotError';
		this.code = code;
		this.status = status;
	}
}

/** Map an HTTP status onto a stable code (identical semantics to DeepSeek's). */
function codeForStatus(status) {
	if (status === 401) return 'UNAUTHORIZED';
	if (status === 403) return 'FORBIDDEN';
	if (status === 402) return 'INSUFFICIENT_BALANCE';
	if (status === 404) return 'UNSUPPORTED_ENDPOINT';
	if (status === 429) return 'RATE_LIMITED';
	return `HTTP_${status}`;
}

/** Coerce one balance field to a number, keeping `null` for anything unusable. */
function amount(value) {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether one thrown fetch error means "the abort fired". Same three shapes as
 * the other clients (AbortError, DOMException TimeoutError, signal.reason).
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
 * Perform one authenticated JSON request.
 *
 * @param {object} params - request inputs.
 * @param {string} params.url - absolute URL.
 * @param {string} params.apiKey - bearer credential.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<object>} the parsed JSON body.
 * @throws {MoonshotError} when the call fails or the body is not JSON.
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
		throw new MoonshotError(
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
		throw new MoonshotError(codeForStatus(response.status), String(detail), response.status);
	}
	if (payload === null || typeof payload !== 'object')
		throw new MoonshotError('MALFORMED', 'response body was not JSON');
	return payload;
}

/**
 * `GET /v1/users/me/balance`.
 *
 * The documented response carries `available_balance` (recharge + voucher,
 * spendable) plus the two split figures, and no currency field — Kimi bills in
 * CNY, so the currency is asserted here rather than guessed from a field.
 *
 * @param {object} params - call inputs.
 * @param {string} params.baseURL - API root without a trailing slash.
 * @param {string} params.apiKey - bearer credential.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<{ isAvailable: boolean, infos: object[] }>} normalized balance, DeepSeek-compatible shape.
 */
export async function fetchBalance({ baseURL, apiKey, timeoutMs, fetchImpl }) {
	const payload = await requestJson({ url: `${baseURL}/users/me/balance`, apiKey, timeoutMs, fetchImpl });
	const available = amount(payload.available_balance ?? payload.availableBalance);
	const voucher = amount(payload.voucher_balance ?? payload.voucherBalance);
	const recharge = amount(payload.charge_balance ?? payload.chargeBalance);
	// The spendable total wins; the split figures stay informational. When the
	// endpoint answered but named nothing usable, report unknown rather than 0.
	const total = available ?? (recharge !== null || voucher !== null ? (recharge ?? 0) + (voucher ?? 0) : null);
	return {
		isAvailable: payload.is_available === true || payload.isAvailable === true || total !== null,
		infos:
			total === null && voucher === null ?
				[]
			:	[
					{
						currency: typeof payload.currency === 'string' ? payload.currency : 'CNY',
						totalBalance: total,
						grantedBalance: voucher,
						toppedUpBalance: recharge
					}
				]
	};
}

/**
 * `GET /v1/models`.
 *
 * @param {object} params - call inputs.
 * @param {string} params.baseURL - API root without a trailing slash.
 * @param {string} params.apiKey - bearer credential.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<{ id: string, ownedBy: string | null }[]>} the model list.
 */
export async function fetchModels({ baseURL, apiKey, timeoutMs, fetchImpl }) {
	const payload = await requestJson({ url: `${baseURL}/models`, apiKey, timeoutMs, fetchImpl });
	const data = Array.isArray(payload.data) ? payload.data : [];
	return data
		.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
		.map(entry => ({ id: entry.id, ownedBy: typeof entry.owned_by === 'string' ? entry.owned_by : null }));
}
