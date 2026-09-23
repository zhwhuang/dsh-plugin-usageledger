/**
 * DeepSeek platform-console client (console token): account usage totals and the
 * daily series behind the console's own 用量信息 page.
 *
 * The open API (`api.deepseek.com`) exposes balance and the model list but no
 * usage history at all; the console's own endpoints are the only official source
 * for 累计消费 / 累计 tokens / 每日趋势 / 调用次数:
 * - `GET /api/v0/users/get_user_summary` — all-time and monthly figures.
 * - `GET /api/v0/usage/amount?year=&month=` — per-day, per-model usage rows.
 * - `GET /api/v0/usage/cost?year=&month=` — per-day, per-model cost rows.
 *
 * They authenticate with the *console* token (a bearer JWT), not with an API key.
 * The token is read from the credential store per operation and never leaves the
 * host: it is not logged, not written to the plugin's own files, and never sent
 * to the browser.
 *
 * Response shapes are read tolerantly — key names differ between console builds —
 * and anything that cannot be read is reported as missing instead of guessed.
 *
 * @module dsh-plugin-usageledger/platform
 */

/** One failed console call, tagged with a stable code the panel can translate. */
export class PlatformError extends Error {
	/**
	 * @param {string} code - stable machine code (`NO_TOKEN`, `EXPIRED`, …).
	 * @param {string} message - human-readable detail.
	 * @param {number} [status] - HTTP status when there was a response.
	 */
	constructor(code, message, status) {
		super(message);
		this.name = 'PlatformError';
		this.code = code;
		this.status = status;
	}
}

/** A browser-like User-Agent; the console endpoints reject non-browser callers. */
const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * The `userToken` Local Storage value is a JSON envelope (`{"value":"<jwt>",…}`);
 * tolerate a direct copy of it on the request path too (e.g. when the token is
 * supplied via the environment variable).
 * @param {string} token - candidate token.
 * @returns {string} the bare token.
 */
function bareToken(token) {
	if (typeof token !== 'string') return token;
	const trimmed = token.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed !== null && typeof parsed === 'object') {
				const candidate = parsed.value ?? parsed.token ?? parsed.accessToken;
				if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
			}
		} catch {
			// Not JSON; use the trimmed input.
		}
	}
	return trimmed;
}

/**
 * Map a usage `type` onto one of the panel's buckets.
 *
 * The live console (verified 2026-09) uses uppercase enums:
 *   PROMPT_TOKEN · PROMPT_CACHE_HIT_TOKEN · PROMPT_CACHE_MISS_TOKEN ·
 *   RESPONSE_TOKEN · REQUEST
 * Older/CSV spellings are kept for tolerance.
 */
const TOKEN_KINDS = {
	// request / call count
	REQUEST: 'calls',
	request_count: 'calls',
	requestCount: 'calls',
	request: 'calls',
	call_count: 'calls',
	calls: 'calls',
	// prompt tokens (the console sometimes reports an aggregate separate from the
	// hit/miss split; kept in its own bucket so nothing is double-counted)
	PROMPT_TOKEN: 'promptTokens',
	input_tokens: 'promptTokens',
	prompt_tokens: 'promptTokens',
	// cache hit
	PROMPT_CACHE_HIT_TOKEN: 'cacheHitTokens',
	input_cache_hit_tokens: 'cacheHitTokens',
	prompt_cache_hit_tokens: 'cacheHitTokens',
	cache_hit_tokens: 'cacheHitTokens',
	// cache miss
	PROMPT_CACHE_MISS_TOKEN: 'cacheMissTokens',
	input_cache_miss_tokens: 'cacheMissTokens',
	prompt_cache_miss_tokens: 'cacheMissTokens',
	cache_miss_tokens: 'cacheMissTokens',
	// response / completion
	RESPONSE_TOKEN: 'outputTokens',
	output_tokens: 'outputTokens',
	completion_tokens: 'outputTokens',
	completion_tokens_count: 'outputTokens'
};

/** Field names the console has used for one row's date. */
const DATE_KEYS = ['utc_date', 'utcDate', 'date', 'day', 'time', 'timestamp', 'created_at', 'createdAt'];
/** Field names the console has used for one row's model. */
const MODEL_KEYS = ['model', 'model_name', 'modelName', 'model_id', 'modelId'];
/** Field names the console has used for one row's quantity. */
const AMOUNT_KEYS = ['amount', 'value', 'count', 'usage', 'tokens', 'token_count', 'call_count', 'calls', 'quantity'];
/** Field names the console has used for one row's cost. */
const COST_KEYS = ['cost', 'amount', 'value', 'price', 'total_cost', 'totalCost'];
/** Field names the console has used for one row's metric type. `name` is a
 * last-resort fallback for legacy rows that spell the *type* `name` (e.g.
 * `{ name: 'PROMPT_TOKEN', amount: 5 }`) — see {@link readRowType}. */
const TYPE_KEYS = ['type', 'usage_type', 'usageType', 'metric', 'category', 'name'];
/** Field names the console has used for one row's currency. */
const CURRENCY_KEYS = ['currency', 'unit', 'currency_code', 'currencyCode'];

/**
 * Buckets that must never contribute to a plain token sum.
 *
 * Two distinct reasons, both of which silently inflate a total if ignored:
 *
 * - **Aggregates.** `PROMPT_TOKEN` is the whole prompt; the cache hit/miss
 *   buckets split that same prompt in two. The console ships all three, so
 *   adding them charges one prompt twice. The per-day and per-model paths keep
 *   them in separate buckets already; a plain sum has no such protection.
 * - **Non-tokens.** `REQUEST` is a *call count*, not a token count. It has no
 *   dedicated token bucket and lands in `calls`, which a sum over "every bucket
 *   we recognise" would happily add as if it were a quantity of tokens.
 *
 * @type {ReadonlySet<string>}
 */
const NON_TOKEN_BUCKETS = new Set(['promptTokens', 'calls']);

/**
 * Whether one thrown fetch error means "the abort fired".
 *
 * The open-API half documents the reasoning at {@link module:dsh-plugin-usageledger/deepseek~isAbortFailure}:
 * Node's `AbortError`, a DOM `TimeoutError`, and a `signal.reason` that merely
 * spells out the abort are the same failure. `consoleJson` needs its own copy
 * because each client module stays dependency-free by design.
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

/** @returns {number | null} a finite number for one raw field, else null. */
function num(value) {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** @returns {string | null} a trimmed non-empty string, else null. */
function str(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/** @returns {unknown} the first present value among `keys`. */
function pick(source, keys) {
	if (source === null || typeof source !== 'object') return undefined;
	for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
	return undefined;
}

/**
 * Read one row's metric type without stealing the model name.
 *
 * `name` sits at the end of {@link TYPE_KEYS} only as a last-resort fallback
 * for legacy rows that spell the *type* `name`. But some legacy CSV rows use
 * `name` for the *model* (`{ name: 'deepseek-chat', amount: 5 }`); reading
 * `name` first there turns a model id into a type, which `TOKEN_KINDS` then
 * rejects — the row is silently dropped. The guard: when the row has no
 * `type`-like field but its `name` matches a known model id (or no known type
 * at all), treat `name` as the model, not the type.
 *
 * @param {object} row - one raw usage row.
 * @returns {string} the metric type, or '' when unreadable.
 */
function readRowType(row) {
	const typed = str(pick(row, ['type', 'usage_type', 'usageType', 'metric', 'category']));
	if (typed !== null) return typed;
	const named = str(row.name);
	if (named === null) return '';
	// A `name` that is a recognized metric kind is a type; anything else is a
	// model id (a real type is always one of the TOKEN_KINDS / REQUEST spellings).
	return TOKEN_KINDS[named] !== undefined || named === 'REQUEST' || named === 'CALL' ? named : '';
}

/** @returns {string | null} the model of one raw row, tolerating `name`. */
function readRowModel(row) {
	const model = str(pick(row, MODEL_KEYS));
	if (model !== null) return model;
	// `name` only becomes the model when it is NOT itself a metric type — a row
	// `{ name: 'PROMPT_TOKEN', amount }` spells the *type* `name`, and reading
	// that as a model would publish a bogus "PROMPT_TOKEN" model.
	const named = str(row.name);
	return named !== null && TOKEN_KINDS[named] === undefined && named !== 'REQUEST' && named !== 'CALL' ? named : null;
}

/**
 * Unwrap the console's envelopes.
 *
 * The console nests them: the outer transport envelope is `{ code, msg, data }`
 * and the business envelope inside it is `{ biz_code, biz_msg, biz_data }`.
 * Payloads under either key may be objects, arrays, or a JSON *string*
 * (double-encoded). This peels one layer per pass until the real business
 * payload remains.
 *
 *   `{ code, msg, data: { biz_code, biz_msg, biz_data: {...} } }`  → `{...}`
 *   `{ code, msg, data: [ ... ] }`                                 → `[ ... ]`
 *   `{ data }` / `{ biz_data }` / `{ result: { data } }`           → inner
 *
 * @param {unknown} payload - parsed response body.
 * @returns {unknown} the business payload.
 */
function unwrap(payload) {
	let current = payload;
	for (let pass = 0; pass < 5; pass += 1) {
		if (current === null || typeof current !== 'object') return current;
		const record = current;

		// A JSON-string payload (double-encoded) — parse and re-examine.
		if (typeof current === 'string') return current;

		const dataKey =
			record.data !== undefined ? 'data'
			: record.biz_data !== undefined ? 'biz_data'
			: undefined;
		if (dataKey !== undefined) {
			let inner = record[dataKey];
			// The console sometimes double-encodes: the payload is a JSON *string*.
			if (typeof inner === 'string') {
				const trimmed = inner.trim();
				if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
					try {
						inner = JSON.parse(trimmed);
					} catch {
						// Not JSON after all; leave `inner` as the raw string.
					}
				}
				if (typeof inner === 'string') {
					// A plain string payload is the value itself.
					return inner;
				}
			}
			if (Array.isArray(inner)) return inner;
			if (inner !== null && typeof inner === 'object') {
				// Descend and let the next pass peel the following envelope, if any.
				current = inner;
				continue;
			}
		}

		if (record.result !== undefined && record.result !== null && typeof record.result === 'object') {
			current = record.result;
			continue;
		}

		return record;
	}
	return current;
}

/**
 * Find the row array inside a console payload, tolerating the key names seen in
 * the wild (`total`, `rows`, `list`, `items`, `usage`, …), a bare array, and one
 * level of nesting inside `data`/`result`. An empty array means "no rows", never
 * "zero rows of real data".
 *
 * @param {unknown} payload - business payload.
 * @param {number} [depth] - remaining recursion depth.
 * @returns {object[]} the rows, or an empty array when none were found.
 */
function rowsOf(payload, depth = 3) {
	if (typeof payload === 'string') {
		const trimmed = payload.trim();
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				return rowsOf(JSON.parse(trimmed), depth);
			} catch {
				return [];
			}
		}
		return [];
	}
	if (Array.isArray(payload)) return payload.filter(row => row !== null && typeof row === 'object');
	if (payload === null || typeof payload !== 'object' || depth <= 0) return [];
	for (const key of ['total', 'totals', 'rows', 'list', 'items', 'usage', 'data', 'records', 'result', 'details']) {
		const value = payload[key];
		if (Array.isArray(value)) return value.filter(row => row !== null && typeof row === 'object');
		if (value !== null && typeof value === 'object') {
			const nested = rowsOf(value, depth - 1);
			if (nested.length > 0) return nested;
		}
	}
	return [];
}

/**
 * Normalize one day key to `YYYY-MM-DD`.
 * @param {unknown} value - raw date field.
 * @returns {string | null} the day key, or null when unreadable.
 */
function dayOf(value) {
	if (typeof value === 'number') {
		const date = new Date(value < 1e12 ? value * 1000 : value);
		return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
	}
	const raw = str(value);
	if (raw === null) return null;
	const matched = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u);
	if (matched !== null) return `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}`;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

/**
 * Pick a scalar value from a summary-like object, looking through common
 * wrapper keys (`data`, `result`, `user_summary`, `summary`) as well as the
 * top level.
 * @param {unknown} source - raw summary payload.
 * @param {string[]} keys - candidate keys.
 * @returns {unknown} the first present value, or undefined.
 */
function summaryPick(source, keys) {
	if (typeof source === 'string') {
		const trimmed = source.trim();
		if (trimmed.startsWith('{')) {
			try {
				return summaryPick(JSON.parse(trimmed), keys);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
	if (source === null || typeof source !== 'object') return undefined;
	const top = pick(source, keys);
	if (top !== undefined) return top;
	for (const wrapper of ['data', 'biz_data', 'result', 'user_summary', 'userSummary', 'summary']) {
		if (source[wrapper] !== undefined && typeof source[wrapper] === 'object') {
			const inner = pick(source[wrapper], keys);
			if (inner !== undefined) return inner;
		}
	}
	return undefined;
}

/**
 * Perform one authenticated console GET.
 *
 * @param {object} params - request inputs.
 * @param {string} params.url - absolute URL.
 * @param {string} params.token - console bearer token.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<unknown>} the business payload.
 * @throws {PlatformError} on transport, auth, or envelope failure.
 */
async function consoleJson({ url, token, timeoutMs, fetchImpl = globalThis.fetch }) {
	const abort = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = abort === null ? null : setTimeout(() => abort.abort(), timeoutMs);
	timer?.unref?.();
	const bearer = bareToken(token);
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${bearer}`,
				'user-agent': BROWSER_USER_AGENT,
				'x-client-platform': 'web',
				'x-app-version': '1.0.0'
			},
			...(abort === null ? {} : { signal: abort.signal })
		});
	} catch (error) {
		const aborted = isAbortFailure(error);
		throw new PlatformError(
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
	if (payload === null || typeof payload !== 'object') {
		throw new PlatformError(
			response.ok ? 'MALFORMED' : `HTTP_${response.status}`,
			'response body was not JSON',
			response.status
		);
	}
	const record = payload;
	// The business envelope may be nested one level deep (`data.biz_code`). The
	// outer `code` is often a transport-level 0, so a nested business code must be
	// preferred whenever the outer one is a success code — `??` cannot express
	// that, since 0 is not nullish.
	const inner = record.data !== null && typeof record.data === 'object' ? record.data : record;
	const outerCode = num(record.code ?? record.biz_code);
	const nestedCode = num(inner.biz_code);
	const code = outerCode === null || outerCode === 0 || outerCode === 200 ? (nestedCode ?? outerCode) : outerCode;
	// The console answers 200 with a business code: 40002 is "Missing Token".
	if (code !== null && code !== 0 && code !== 200) {
		const message =
			str(inner.biz_msg) ??
			str(record.biz_msg) ??
			str(record.msg) ??
			str(record.message) ??
			str(inner.msg) ??
			`console code ${code}`;
		const mapped =
			code === 40002 ? 'NO_TOKEN'
			: response.status === 401 ? 'EXPIRED'
			: `CODE_${code}`;
		throw new PlatformError(mapped, message, response.status);
	}
	// A business code the console *did* send but that could not be parsed as a
	// number is a failure, not a success: guessing "fine" would fabricate data
	// from a body the console was rejecting. Only a truly absent code (older
	// console builds ship none) falls through to the HTTP status.
	if (code === null && (record.code !== undefined || record.biz_code !== undefined)) {
		const rawCode = record.code ?? record.biz_code;
		throw new PlatformError(
			'CODE_UNKNOWN',
			`unrecognized console code: ${String(rawCode).slice(0, 40)}`,
			response.status
		);
	}
	if (!response.ok)
		throw new PlatformError(
			response.status === 401 ? 'EXPIRED' : `HTTP_${response.status}`,
			`HTTP ${response.status}`,
			response.status
		);
	return unwrap(record);
}

/**
 * `GET /api/v0/users/get_user_summary`.
 *
 * @param {object} params - call inputs.
 * @param {string} params.baseURL - console root without a trailing slash.
 * @param {string} params.token - console token.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<object>} the raw business payload.
 */
export function fetchSummary({ baseURL, token, timeoutMs, fetchImpl }) {
	return consoleJson({ url: `${baseURL}/api/v0/users/get_user_summary`, token, timeoutMs, fetchImpl });
}

/**
 * `GET /api/v0/usage/amount` and `/api/v0/usage/cost` for one month.
 *
 * The two endpoints are read independently: when only one answers, the panel
 * still gets that half of the series instead of nothing at all, and the failure
 * is reported beside the data. Only a double failure raises.
 *
 * @param {object} params - call inputs.
 * @param {string} params.baseURL - console root without a trailing slash.
 * @param {string} params.token - console token.
 * @param {number} params.year - four-digit year.
 * @param {number} params.month - one-based month.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<{ amount: unknown | null, cost: unknown | null, partial: string | null, partialMessage: string | null }>} both payloads.
 * @throws {PlatformError} when both reads fail.
 */
export async function fetchUsage({ baseURL, token, year, month, timeoutMs, fetchImpl }) {
	const query = `year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;
	const [amount, cost] = await Promise.allSettled([
		consoleJson({ url: `${baseURL}/api/v0/usage/amount?${query}`, token, timeoutMs, fetchImpl }),
		consoleJson({ url: `${baseURL}/api/v0/usage/cost?${query}`, token, timeoutMs, fetchImpl })
	]);
	if (amount.status === 'rejected' && cost.status === 'rejected') throw amount.reason;
	const failed =
		amount.status === 'rejected' ? 'amount'
		: cost.status === 'rejected' ? 'cost'
		: null;
	return {
		amount: amount.status === 'fulfilled' ? amount.value : null,
		cost: cost.status === 'fulfilled' ? cost.value : null,
		/** Which endpoint failed, when exactly one did. */
		partial: failed,
		/** Human detail for the panel when the read was partial. */
		partialMessage:
			failed === null ? null : String((failed === 'amount' ? amount.reason : cost.reason)?.message ?? '')
	};
}

/** One empty daily bucket. */
function emptyDay(day) {
	return {
		day,
		calls: 0,
		promptTokens: 0,
		cacheHitTokens: 0,
		cacheMissTokens: 0,
		outputTokens: 0,
		tokens: 0,
		cost: 0,
		costKnown: false
	};
}

/** One empty per-model bucket. */
function emptyModel(model) {
	return {
		model,
		calls: 0,
		promptTokens: 0,
		cacheHitTokens: 0,
		cacheMissTokens: 0,
		outputTokens: 0,
		tokens: 0,
		cost: null
	};
}

/** @returns {number} the token total for one bucket set (excluding call counts). */
function tokenSum(entry) {
	return entry.cacheHitTokens + entry.cacheMissTokens + entry.outputTokens + entry.promptTokens;
}

/**
 * Collect a short signature of a value's shape, for a diagnostic.
 * @param {unknown} value - any value.
 * @returns {string} a short signature of the value's shape.
 */
function shapeSignature(value) {
	if (value === null) return 'null';
	if (Array.isArray(value)) return `array(${value.length})`;
	if (typeof value === 'object') {
		const keys = Object.keys(value).slice(0, 20);
		return `{${keys.join(',')}${Object.keys(value).length > 20 ? '…' : ''}}`;
	}
	return typeof value;
}

/** @returns {unknown[]} a nested payload, parsed from a string when needed. */
function asObject(value) {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				return JSON.parse(trimmed);
			} catch {
				return null;
			}
		}
		return null;
	}
	return value !== null && typeof value === 'object' ? value : null;
}

/**
 * Collect the per-day usage rows from a console `usage/*` payload.
 *
 * The live shape is nested rather than flat:
 *   `{ total: [ { model, usage: [ { type, amount } ] } ],
 *      days:  [ { date, data: [ { model, usage: [ { type, amount } ] } ] } ] }`
 * A flat `[{ date, model, type, amount }]` array is also accepted, so the
 * normalizer survives both the console's current and legacy forms.
 *
 * @param {unknown} payload - a `usage/amount` or `usage/cost` business payload.
 * @param {boolean} [isCost] - read the quantity from the cost keys rather than
 *   the token keys (legacy flat cost rows carry `cost`, not `amount`).
 * @param {'days' | 'total'} [section] - which series to read. The live payload
 *   carries both: `days` is the per-day window, `total` is the per-model
 *   lifetime roll-up. They must be read separately — summing both double-counts.
 * @returns {Array<{ day: string | null, model: string | null, type: string, value: number }>} flattened entries.
 */
function usageEntries(payload, isCost = false, section = 'days') {
	const amountKeys = isCost ? COST_KEYS : AMOUNT_KEYS;
	let root = asObject(payload);
	if (root === null) return [];
	// Some payloads wrap the real object in a one-element array:
	//   `[{ total, days, currency }]`
	if (Array.isArray(root) && root.length > 0) {
		const first = asObject(root[0]);
		// If the wrapper carries the `days`/`total` structure, descend into it; a
		// genuine flat row array has `date`/`type` keys instead.
		if (first !== null && (first.days !== undefined || first.total !== undefined)) root = first;
	}
	const entries = [];

	/**
	 * Push one `{ type, amount }` group.
	 * @param {string | null} day - owning day.
	 * @param {string | null} model - owning model.
	 * @param {unknown} usage - the `[{ type, amount }]` group.
	 * @param {string[]} amountKeys - field names to read the quantity from. Legacy
	 *   flat rows carry `cost` rather than `amount`, so the key list differs
	 *   between the amount payload and the cost payload.
	 */
	const pushUsage = (day, model, usage, amountKeys = AMOUNT_KEYS) => {
		if (!Array.isArray(usage)) return;
		for (const item of usage) {
			const obj = asObject(item);
			if (obj === null) continue;
			const type = readRowType(obj);
			const value = num(pick(obj, amountKeys));
			if (value === null) continue;
			entries.push({ day, model, type, value });
		}
	};

	// Nested per-day shape: days[].date + days[].data[].usage[].
	// `root.data` is only a day list when its entries actually look like days —
	// several legacy payloads wrap a flat row array under `data`, and treating
	// those as days would find no `date` and drop every row.
	const looksLikeDays = list =>
		Array.isArray(list) &&
		list.some(entry => {
			const obj = asObject(entry);
			return obj !== null && obj.usage === undefined && pick(obj, DATE_KEYS) !== undefined;
		});
	const days =
		Array.isArray(root.days) ? root.days
		: looksLikeDays(root.data) ? root.data
		: null;
	const dayList = Array.isArray(days) ? days : null;
	const flatRows = Array.isArray(root) ? root : null;
	const totalList =
		Array.isArray(root.total) ? root.total
		: Array.isArray(root.totals) ? root.totals
		: null;

	// `total` requested explicitly: read the per-model lifetime roll-up. Only the
	// entries whose quantity lives in a nested `usage` array qualify — a legacy
	// flat row parked under `total` belongs to the daily series instead.
	if (section === 'total') {
		if (totalList === null) return entries;
		for (const modelEntry of totalList) {
			const modelObj = asObject(modelEntry);
			if (modelObj === null) continue;
			const usage = modelObj.usage ?? modelObj.items ?? modelObj.rows;
			if (Array.isArray(usage)) pushUsage(null, readRowModel(modelObj), usage, amountKeys);
		}
		return entries;
	}

	if (dayList !== null) {
		for (const dayEntry of dayList) {
			const dayObj = asObject(dayEntry);
			if (dayObj === null) continue;
			const day = dayOf(pick(dayObj, DATE_KEYS));
			const data = dayObj.data ?? dayObj.models ?? dayObj.rows;
			if (Array.isArray(data)) {
				for (const modelEntry of data) {
					const modelObj = asObject(modelEntry);
					if (modelObj === null) continue;
					pushUsage(
						day,
						readRowModel(modelObj),
						modelObj.usage ?? modelObj.items ?? modelObj.rows,
						amountKeys
					);
				}
			} else {
				pushUsage(day, readRowModel(dayObj), dayObj.usage, amountKeys);
			}
		}
		// A `total` block, when present, is a per-model roll-up; it is ignored here
		// because `days` already carries the same figures, and summing both would
		// double-count.
		return entries;
	}

	if (flatRows !== null) {
		for (const row of flatRows) {
			const line = asObject(row);
			if (line === null) continue;
			pushUsage(dayOf(pick(line, DATE_KEYS)), readRowModel(line), [line], amountKeys);
		}
		return entries;
	}

	// A `total`-only payload: the console omitted the daily breakdown and only
	// shipped the per-model lifetime roll-up. Fold the *nested* blocks in so the
	// model list still populates.
	//
	// Only entries whose quantity lives in a nested `usage` array qualify. A flat
	// row parked under `total` (`{utc_date, type, amount}`) is NOT part of this
	// series: it is a daily row that a legacy console merely parented under
	// `total`. Letting it through would put the same day in `days`/`window` *and*
	// in the lifetime roll-up `normalizeUsage` reads with `section === 'total'` —
	// two 口径 fed from one row.
	if (totalList !== null) {
		for (const modelEntry of totalList) {
			const modelObj = asObject(modelEntry);
			if (modelObj === null) continue;
			const usage = modelObj.usage ?? modelObj.items ?? modelObj.rows;
			// A nested block only. A flat row has no `usage` list and is skipped here;
			// it is picked up by the flat-row pass below, which is the series it
			// actually belongs to.
			if (Array.isArray(usage)) pushUsage(null, readRowModel(modelObj), usage, amountKeys);
		}
	}

	// Legacy flat rows parked under `total`. These are daily rows in disguise, so
	// they are folded into the daily series — and only there, which is why the
	// `section === 'total'` branch above refuses flat rows outright.
	//
	// This runs on *every* entry, not only when nothing else was read: a list can
	// legitimately mix a nested per-model roll-up with flat daily rows, and gating
	// on `entries.length` silently dropped every daily row the moment one
	// unrelated nested entry appeared. A flat row is a flat row regardless of its
	// neighbours.
	if (totalList !== null) {
		for (const modelEntry of totalList) {
			const modelObj = asObject(modelEntry);
			if (modelObj === null) continue;
			const usage = modelObj.usage ?? modelObj.items ?? modelObj.rows;
			if (!Array.isArray(usage))
				pushUsage(dayOf(pick(modelObj, DATE_KEYS)), readRowModel(modelObj), [modelObj], amountKeys);
		}
	}
	return entries;
}

/** @returns {number | null} the balance of a wallet record. */
function walletBalance(entry) {
	const obj = asObject(entry);
	if (obj === null) return null;
	return num(
		pick(obj, ['balance', 'amount', 'total_balance', 'totalBalance', 'topped_up_balance', 'toppedUpBalance'])
	);
}

/**
 * Fold the summary, the amount rows, and the cost rows into the model the panel
 * renders. Every figure is either read from a field or left `null`; nothing is
 * inferred from a different unit, and unknown shapes only shrink `complete`.
 *
 * @param {object} params - inputs.
 * @param {unknown} [params.summary] - `/users/get_user_summary` payload.
 * @param {unknown} [params.amount] - `/usage/amount` payload.
 * @param {unknown} [params.cost] - `/usage/cost` payload.
 * @param {string} params.month - the window's `YYYY-MM`, for labelling.
 * @param {{ warn?: Function }} [params.logger] - host logger. A shape diagnostic
 *   is routed here rather than to `console` so the host owns its own output;
 *   with no logger the diagnostic is dropped rather than printed.
 * @returns {object} normalized usage.
 */
export function normalizeUsage({ summary, amount, cost, month, logger }) {
	// Accept either already-unwrapped payloads (the host passes `fetchUsage().cost`)
	// or raw enveloped responses, so the normalizer is safe to call with either.
	const summaryRecord = asObject(unwrap(summary)) ?? {};
	const amountValue = unwrap(amount);
	const costValue = unwrap(cost);

	/* ---- all-time figures from the wallet/`total_costs` blocks ---- */
	const normalWallets = summaryRecord.normal_wallets ?? summaryRecord.normalWallets ?? [];
	const bonusWallets = summaryRecord.bonus_wallets ?? summaryRecord.bonusWallets ?? [];
	const totalCosts = summaryRecord.total_costs ?? summaryRecord.totalCosts ?? [];

	const walletBalanceOf = list => {
		if (!Array.isArray(list)) return null;
		const cny = list.find(entry => str(pick(asObject(entry) ?? {}, CURRENCY_KEYS)) === 'CNY');
		return walletBalance(cny ?? list[0]);
	};
	const remainingTokens =
		num(
			summaryPick(summaryRecord, [
				'token_estimation',
				'total_available_token_estimation',
				'totalAvailableTokenEstimation',
				'available_tokens',
				'remaining_tokens'
			])
		) ??
		(Array.isArray(normalWallets) ?
			num(pick(asObject(normalWallets[0]) ?? {}, ['token_estimation', 'tokenEstimation']))
		:	null);

	/* All-time spend: the `total_costs` list, else the monthly-cost list. */
	const spendByCurrency = {};
	const monthlyCostList = summaryPick(summaryRecord, ['monthly_costs', 'monthlyCosts']);
	const costList =
		Array.isArray(totalCosts) && totalCosts.length > 0 ? totalCosts
		: Array.isArray(monthlyCostList) ? monthlyCostList
		: [];
	for (const entry of costList) {
		const obj = asObject(entry);
		if (obj === null) continue;
		const value = num(pick(obj, COST_KEYS));
		const currency = str(pick(obj, CURRENCY_KEYS)) ?? 'CNY';
		if (value === null) continue;
		spendByCurrency[currency] = (spendByCurrency[currency] ?? 0) + value;
	}
	const explicitAllTimeCost = num(
		summaryPick(summaryRecord, [
			'total_cost',
			'totalCost',
			'all_time_cost',
			'allTimeCost',
			'total_spend',
			'totalSpend',
			'lifetime_cost',
			'lifetimeCost'
		])
	);
	const spendCurrency =
		Object.keys(spendByCurrency).includes('CNY') ? 'CNY' : (Object.keys(spendByCurrency)[0] ?? null);
	const allTimeCost =
		explicitAllTimeCost ?? (spendCurrency === null ? null : Number(spendByCurrency[spendCurrency].toFixed(6)));

	/* ---- per-day and per-model rows from the two usage endpoints ---- */
	const days = new Map();
	const models = new Map();
	const amountEntries = usageEntries(amountValue, false);
	const costEntries = usageEntries(costValue, true);

	for (const entry of amountEntries) {
		const bucket = TOKEN_KINDS[entry.type] ?? null;
		if (bucket === null) continue;
		const model = entry.model ?? 'unknown';
		const modelEntry = models.get(model) ?? emptyModel(model);
		models.set(model, modelEntry);
		modelEntry[bucket] += entry.value;
		if (entry.day !== null) {
			const dayEntry = days.get(entry.day) ?? emptyDay(entry.day);
			days.set(entry.day, dayEntry);
			dayEntry[bucket] += entry.value;
		}
	}

	for (const entry of costEntries) {
		const costBucket = str(entry.type) !== '' ? entry.type : 'COST';
		// Skip the call counters *before* materializing a model or a day: a
		// `REQUEST` cost row carries no amount, and creating a `models` entry for
		// it would publish a zero-token model that never spent a token.
		if (costBucket === 'REQUEST' || costBucket === 'CALL') continue;
		const model = entry.model ?? 'unknown';
		const modelEntry = models.get(model) ?? emptyModel(model);
		models.set(model, modelEntry);
		modelEntry.cost = (modelEntry.cost ?? 0) + entry.value;
		if (entry.day !== null) {
			const dayEntry = days.get(entry.day) ?? emptyDay(entry.day);
			days.set(entry.day, dayEntry);
			dayEntry.cost += entry.value;
			dayEntry.costKnown = true;
		}
	}

	const dayList = [...days.values()]
		.map(entry => ({
			...entry,
			tokens: tokenSum(entry),
			cost: entry.costKnown ? Number(entry.cost.toFixed(6)) : null
		}))
		.sort((left, right) => left.day.localeCompare(right.day));
	const modelList = [...models.values()]
		.map(entry => ({
			...entry,
			tokens: tokenSum(entry),
			cost: entry.cost === null ? null : Number(entry.cost.toFixed(6))
		}))
		.sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model));

	const windowCost = dayList.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
	const windowCalls = dayList.reduce((sum, entry) => sum + entry.calls, 0);
	const windowTokens = dayList.reduce((sum, entry) => sum + entry.tokens, 0);
	const anyCost = dayList.some(entry => entry.costKnown);
	// The live summary (verified 2026-09) carries only the wallets and
	// `total_costs` — no token counters at all. The one lifetime token figure the
	// console does publish is the per-model `total` roll-up of `/usage/amount`,
	// which is delivered *alongside* the daily window rather than summed from it.
	// That roll-up is therefore the only honest source for 累计 TOKEN; the days in
	// `window` come from the `days` branch and are a separate series.
	const totalRollUp = usageEntries(amountValue, false, 'total');
	const lifetimeTokens = (() => {
		if (totalRollUp.length === 0) return null;
		let sum = 0;
		let seen = false;
		for (const entry of totalRollUp) {
			const bucket = TOKEN_KINDS[entry.type];
			if (bucket === undefined) continue;
			// Excluded: the `PROMPT_TOKEN` aggregate (already split into hit/miss) and
			// the `REQUEST` call count (not a token at all).
			if (NON_TOKEN_BUCKETS.has(bucket)) continue;
			sum += entry.value;
			seen = true;
		}
		return seen ? sum : null;
	})();
	// The summary's own counters, when a future console build exposes them, win.
	const allTimeTokens =
		num(
			summaryPick(summaryRecord, [
				'total_usage',
				'totalUsage',
				'total_tokens',
				'totalTokens',
				'all_time_tokens',
				'allTimeTokens',
				'lifetime_tokens',
				'tokens_used'
			])
		) ?? lifetimeTokens;
	// 本月 TOKEN is the current-month window only. It is never backfilled from the
	// lifetime roll-up, which would report a lifetime figure as a monthly one.
	const monthlyTokens =
		num(summaryPick(summaryRecord, ['monthly_usage', 'monthlyUsage', 'monthly_tokens', 'current_month_tokens'])) ??
		(windowTokens > 0 ? windowTokens : null);

	// Shape-only diagnostic: when nothing usable was extracted but payloads
	// arrived, warn so developers can see which keys the console is using now.
	// Routed through the caller's logger, never `console`: this module is a
	// library and must not write to the host's stdout on its own.
	const diagnose = typeof logger?.warn === 'function' ? logger.warn : null;
	if (diagnose !== null) {
		if (amountEntries.length === 0 && amountValue !== null && amountValue !== undefined) {
			diagnose(
				`usageledger: usage/amount produced no readable entries; payload shape: ${shapeSignature(asObject(amountValue) ?? amountValue)}`
			);
		}
		if (costEntries.length === 0 && costValue !== null && costValue !== undefined) {
			diagnose(
				`usageledger: usage/cost produced no readable entries; payload shape: ${shapeSignature(asObject(costValue) ?? costValue)}`
			);
		}
		if (Object.keys(summaryRecord).length > 0 && allTimeCost === null && remainingTokens === null) {
			diagnose(
				`usageledger: get_user_summary produced no usable totals; shape: ${shapeSignature(summaryRecord)}`
			);
		}
	}

	return {
		month,
		allTimeTokens,
		monthlyTokens,
		remainingTokens,
		allTimeCost,
		/** Wallet balances, kept for the panel's balance card when present. */
		wallets: {
			normal: walletBalanceOf(normalWallets),
			bonus: walletBalanceOf(bonusWallets),
			currency:
				spendCurrency ??
				(Array.isArray(normalWallets) ? str(pick(asObject(normalWallets[0]) ?? {}, CURRENCY_KEYS)) : null)
		},
		currency: spendCurrency,
		window: {
			month,
			cost: anyCost ? Number(windowCost.toFixed(6)) : null,
			calls: windowCalls,
			tokens: windowTokens,
			cacheHitTokens: dayList.reduce((sum, entry) => sum + entry.cacheHitTokens, 0),
			cacheMissTokens: dayList.reduce((sum, entry) => sum + entry.cacheMissTokens, 0),
			promptTokens: dayList.reduce((sum, entry) => sum + entry.promptTokens, 0),
			outputTokens: dayList.reduce((sum, entry) => sum + entry.outputTokens, 0),
			days: dayList.length
		},
		days: dayList,
		models: modelList,
		/** Whether every figure the panel wants was present. */
		complete: {
			allTimeTokens: allTimeTokens !== null,
			allTimeCost: allTimeCost !== null,
			dailyCost: anyCost,
			dailyTokens: dayList.length > 0,
			calls: dayList.some(entry => entry.calls > 0)
		},
		/** Entry counts, for a diagnostic that never carries values. */
		rows: { amount: amountEntries.length, cost: costEntries.length }
	};
}
