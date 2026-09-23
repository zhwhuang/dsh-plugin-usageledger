/**
 * Session-scoped usage source.
 *
 * The console figures this plugin shows are *account* scoped: they are billed
 * by DeepSeek and only readable with a console token. Without that token the
 * panel had nothing at all to show. This module closes that gap by reading the
 * harness's own measurement of the session in flight, which needs no
 * credential and no network:
 *
 * 1. `ctx.sessionProjections.stateOf(session, 'tokenUsage')` — the
 *    provider-reported cumulative usage the official `dsh-token-meter` folds
 *    out of the durable session log.
 * 2. `ctx.tokenMeter.measure(session)` — the same package's live
 *    request-pressure read, used only for context occupancy.
 *
 * 口径 (measurement convention) — this is the load-bearing rule of the file:
 *
 * - The four projection buckets are **disjoint**: reasoning tokens are already
 *   inside `outputTokens`, and cache read/write are separate from uncached
 *   input. They must be added, never double-counted.
 * - Billed input = the three prompt-side buckets summed, which is exactly the
 *   official reference consumer's `billedInputTokens` helper in
 *   `dsh-client-ui-chat`. That name is reused here on purpose.
 * - These are **provider-reported** numbers for **one session**. They are never
 *   merged, summed, or compared against the console's account-scoped figures:
 *   a session is not an account, so one number cannot hold both.
 * - Everything else the meter produces (`surfaceTokens`, the heuristic
 *   estimate) is an approximation and is labelled as such, never as billing.
 *
 * The service is resolved per read, never captured — the plugin declares no
 * service dependencies, so it is applied before these providers exist.
 *
 * @module dsh-plugin-usageledger/session-usage
 */

/**
 * The projection key `dsh-token-meter` registers its cumulative usage under.
 * @type {string}
 */
const TOKEN_USAGE_KEY = 'tokenUsage';

/**
 * Read a service without declaring it as a hard dependency.
 * @param {object} ctx - host cordis context.
 * @param {string} name - service name.
 * @returns {object | null} the service, or null when it is absent.
 */
function serviceOf(ctx, name) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
    return service === null || service === undefined ? null : service;
  } catch {
    return null;
  }
}

/**
 * Coerce one bucket to a non-negative integer.
 *
 * The value crosses a schema boundary the plugin does not own, and a partial
 * or malformed projection must degrade to "unknown" rather than contaminate a
 * total with `NaN`.
 *
 * @param {unknown} value - the candidate.
 * @returns {number | null} the count, or null when it is not a usable number.
 */
function bucket(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Sum the three disjoint prompt-side buckets — the official billing convention.
 *
 * Mirrors `billedInputTokens` in the reference consumer (`dsh-client-ui-chat`):
 * uncached input, cache reads and cache writes are three separate charges for
 * one prompt, and their sum is what the provider billed as input.
 *
 * @param {{ uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }} usage - the projection value.
 * @returns {number} billed input tokens.
 */
function billedInputTokens(usage) {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * Fraction of the billed prompt that was served from cache, when provable.
 *
 * Cache writes are excluded from the numerator because a write is not a hit.
 * Returns null when the prompt was empty, so the panel shows nothing instead of
 * a fabricated 0%.
 *
 * @param {{ uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }} usage - the projection value.
 * @returns {number | null} the percent in `[0, 100]`, or null.
 */
function cacheHitPercent(usage) {
  const denominator = billedInputTokens(usage);
  if (denominator <= 0) return null;
  const percent = (usage.cacheReadTokens / denominator) * 100;
  return Math.min(100, Math.max(0, percent));
}

/**
 * Normalize one raw `tokenUsage` projection value into the panel's shape.
 *
 * @param {unknown} raw - the projection value (four disjoint buckets, or extras).
 * @returns {object | null} the normalized usage, or null when unusable.
 */
function normalize(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const uncachedInputTokens = bucket(raw.uncachedInputTokens);
  const outputTokens = bucket(raw.outputTokens);
  const cacheReadTokens = bucket(raw.cacheReadTokens);
  const cacheWriteTokens = bucket(raw.cacheWriteTokens);
  // A partially-shaped value is not a measurement; refuse it whole rather than
  // reporting a total that silently dropped a bucket.
  if (uncachedInputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWriteTokens === null) return null;

  const usage = { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  const billedInput = billedInputTokens(usage);
  return {
    ...usage,
    billedInputTokens: billedInput,
    // Providers bill input + output; reasoning is already inside outputTokens.
    totalTokens: billedInput + outputTokens,
    cacheHitPercent: cacheHitPercent(usage),
  };
}

/**
 * Resolve the session whose usage should be reported.
 *
 * Preference order, most specific first:
 * 1. an explicit id (the caller knows which session it means), else
 * 2. the only live session — which is the common case in a single-session
 *    harness, and the only case where guessing is safe, else
 * 3. the most recently active session, never overruling (2)'s certainty.
 *
 * Guessing wrong would attribute one session's tokens to another, so the
 * ambiguous multi-session case deliberately reports the newest one *and* says
 * how many sessions were considered.
 *
 * @param {object | null} sessions - the `ctx.sessions` service.
 * @param {string | null} sessionId - an explicit session id, or null.
 * @returns {{ session: object, id: string, count: number, pinned: boolean } | null} the choice.
 */
function pickSession(sessions, sessionId) {
  if (sessions === null || typeof sessions.list !== 'function') return null;
  let list = [];
  try {
    list = sessions.list() ?? [];
  } catch {
    return null;
  }
  if (!Array.isArray(list)) list = [];
  const ids = list.filter((entry) => entry !== null && entry !== undefined && typeof entry.id === 'string');

  if (typeof sessionId === 'string' && sessionId !== '') {
    const exact = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
    if (exact !== undefined && exact !== null) return { session: exact, id: sessionId, count: ids.length, pinned: true };
    return null;
  }
  if (ids.length === 0) return null;
  // `seq` is the durable log length — the only activity signal available
  // without reading events, and enough to identify the session in flight.
  const newest = ids.reduce((best, entry) => (Number(entry.seq ?? 0) >= Number(best.seq ?? 0) ? entry : best), ids[0]);
  return { session: newest, id: newest.id, count: ids.length, pinned: false };
}

/**
 * Read the harness's own measurement of one session.
 *
 * Every step is optional: a harness without the projection registry, without
 * `tokenMeter`, or with an unmounted lm service still produces a snapshot — with
 * `available: false` and a reason, so the panel can say "not measured" instead
 * of showing a zero it cannot stand behind.
 *
 * @param {object} deps - inputs.
 * @param {object} deps.ctx - host cordis context.
 * @param {string | null} [deps.sessionId] - an explicit session id to report.
 * @returns {object} the `session` block for the snapshot.
 */
export function readSessionUsage({ ctx, sessionId = null }) {
  const empty = { available: false, reason: 'NO_SESSION', sessionId: null, sessions: 0, usage: null, context: null };
  let sessions = null;
  try {
    sessions = serviceOf(ctx, 'sessions');
  } catch {
    sessions = null;
  }
  const picked = pickSession(sessions, sessionId);
  if (picked === null) return empty;

  const base = { available: false, reason: null, sessionId: picked.id, sessions: picked.count, usage: null, context: null };

  /** @type {object | null} */
  let raw = null;
  try {
    const projections = serviceOf(ctx, 'sessionProjections');
    if (projections !== null && typeof projections.stateOf === 'function') {
      // `stateOf` returns the UNIT's internal state (`{ totals, last }`), not the
      // wire view — the four buckets live one level down under `totals`.
      const state = projections.stateOf(picked.session, TOKEN_USAGE_KEY);
      if (state !== null && state !== undefined && typeof state === 'object') raw = state.totals ?? null;
    }
  } catch {
    // A projection that throws must not take the whole snapshot down.
    raw = null;
  }

  const usage = normalize(raw);
  const context = readContext(ctx, sessions, picked.session);
  if (usage === null) {
    return { ...base, reason: raw === null ? 'NOT_MEASURED' : 'UNUSABLE', context };
  }
  return { ...base, available: true, usage, context };
}

/**
 * Read context occupancy from the token meter, when it is mounted.
 *
 * Only whole, provider-anchored figures are reported. The heuristic node
 * prices the meter also exposes are approximations of *composition*, so they
 * are summed here under an explicit `approxTokens` name rather than being
 * presented as a cost.
 *
 * @param {object} ctx - host cordis context.
 * @param {object | null} sessions - the `ctx.sessions` service.
 * @param {object} session - the session to measure.
 * @returns {{ surfaceTokens: number, heuristicTokens: number, nodes: number, approximated: boolean } | null} occupancy, or null.
 */
function readContext(ctx, sessions, session) {
  void sessions;
  const meter = serviceOf(ctx, 'tokenMeter');
  if (meter === null || typeof meter.measure !== 'function') return null;
  try {
    const measured = meter.measure(session);
    if (measured === null || measured === undefined || typeof measured !== 'object') return null;
    const nodes = Array.isArray(measured.nodes) ? measured.nodes : [];
    const surfaceTokens = Number(measured.surfaceTokens);
    if (!Number.isFinite(surfaceTokens)) return null;
    const heuristicTokens = nodes.reduce((sum, node) => {
      const price = Number(node?.heuristicTokens);
      return sum + (Number.isFinite(price) ? price : 0);
    }, 0);
    return {
      surfaceTokens: Math.round(surfaceTokens),
      heuristicTokens: Math.round(heuristicTokens),
      nodes: nodes.length,
      // The meter falls back to a fixed density estimate before a provider
      // reports usage; the panel must label those numbers as approximations.
      approximated: measured.baseline?.kind !== 'usage',
    };
  } catch {
    return null;
  }
}

/** Re-exported for tests: the official billing convention. */
export { billedInputTokens, cacheHitPercent, TOKEN_USAGE_KEY };
