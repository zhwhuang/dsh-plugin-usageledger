/**
 * DeepSeek open-API client (API key): account balance and the model list.
 *
 * Only the two documented account-level endpoints are used here:
 * - `GET /user/balance` — currency, total balance, granted balance, topped-up balance.
 * - `GET /models` — the model ids this key may call.
 *
 * Everything is read per operation: no response is written to disk, and nothing
 * is cached across operations except in the caller's own short-lived snapshot.
 *
 * @see https://api-docs.deepseek.com/zh-cn/api/get-user-balance
 * @see https://api-docs.deepseek.com/zh-cn/api/list-models
 * @module dsh-plugin-usageledger/deepseek
 */

/** One failed open-API call, tagged with a stable code the panel can translate. */
export class DeepSeekError extends Error {
  /**
   * @param {string} code - stable machine code (`TIMEOUT`, `UNAUTHORIZED`, …).
   * @param {string} message - human-readable detail.
   * @param {number} [status] - HTTP status when there was a response.
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.status = status;
  }
}

/** Map an HTTP status onto a stable code. */
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
 * Perform one authenticated JSON request.
 *
 * @param {object} params - request inputs.
 * @param {string} params.url - absolute URL.
 * @param {string} params.apiKey - bearer credential.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<object>} the parsed JSON body.
 * @throws {DeepSeekError} when the call fails or the body is not JSON.
 */
async function requestJson({ url, apiKey, timeoutMs, fetchImpl = globalThis.fetch }) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = abort === null ? null : setTimeout(() => abort.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      ...(abort === null ? {} : { signal: abort.signal }),
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    throw new DeepSeekError(aborted ? 'TIMEOUT' : 'NETWORK', aborted ? `request timed out after ${timeoutMs}ms` : String(error?.message ?? error));
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
    throw new DeepSeekError(codeForStatus(response.status), String(detail), response.status);
  }
  if (payload === null || typeof payload !== 'object') throw new DeepSeekError('MALFORMED', 'response body was not JSON');
  return payload;
}

/**
 * `GET /user/balance`.
 *
 * @param {object} params - call inputs.
 * @param {string} params.baseURL - API root without a trailing slash.
 * @param {string} params.apiKey - bearer credential.
 * @param {number} params.timeoutMs - per-request timeout.
 * @param {typeof fetch} [params.fetchImpl] - injection seam for tests.
 * @returns {Promise<{ isAvailable: boolean, infos: object[] }>} normalized balance.
 */
export async function fetchBalance({ baseURL, apiKey, timeoutMs, fetchImpl }) {
  const payload = await requestJson({ url: `${baseURL}/user/balance`, apiKey, timeoutMs, fetchImpl });
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  return {
    isAvailable: payload.is_available === true,
    infos: infos.map((info) => ({
      currency: typeof info?.currency === 'string' ? info.currency : null,
      totalBalance: amount(info?.total_balance),
      grantedBalance: amount(info?.granted_balance),
      toppedUpBalance: amount(info?.topped_up_balance),
    })),
  };
}

/**
 * `GET /models`.
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
    .filter((entry) => typeof entry?.id === 'string' && entry.id !== '')
    .map((entry) => ({ id: entry.id, ownedBy: typeof entry.owned_by === 'string' ? entry.owned_by : null }));
}

/**
 * Pick the CNY view of a multi-currency balance, falling back to the first
 * quoted currency. The panel states the unit it shows; it never converts.
 *
 * @param {{ infos: object[] }} balance - normalized balance.
 * @returns {object | null} the preferred entry, or null when the account has none.
 */
export function preferredBalance(balance) {
  const infos = Array.isArray(balance?.infos) ? balance.infos : [];
  if (infos.length === 0) return null;
  return infos.find((info) => info.currency === 'CNY') ?? infos[0];
}
