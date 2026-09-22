/**
 * APICost host half.
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
 * @module dsh-plugin-apicost
 */

import { looksLikeConsoleToken, normalizeConsoleToken, resolveConfig } from './config.js';
import { DeepSeekError, fetchBalance, fetchModels, preferredBalance } from './deepseek.js';
import { fetchSummary, fetchUsage, normalizeUsage, PlatformError } from './platform.js';
import { createGate, createRoutes, createSseHub, ROUTE_PATHS } from './routes.js';
import { readSessionUsage } from './session-usage.js';

/** Plugin name shown by the loader. */
export const name = 'apicost';

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
      const logger = ctx.logger('apicost');
      if (logger !== null && typeof logger?.warn === 'function') {
        return { info: (...args) => logger.info?.(...args), warn: (...args) => logger.warn(...args) };
      }
    }
  } catch {
    // A context without the logging service is normal in tests and headless boots.
  }
  return {
    info: (...args) => console.log('[apicost]', ...args),
    warn: (...args) => console.warn('[apicost]', ...args),
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
    if (resolved === null || resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') return null;
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
    return { configured: typeof process.env?.[ref] === 'string' && process.env[ref] !== '', source: 'env', writable: false };
  }
  try {
    const info = await credentials.describe(ref);
    return { configured: info?.configured === true, source: typeof info?.source === 'string' ? info.source : null, writable: info?.writable === true };
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

  /** @returns {number} the current revision, bumped on every change. */
  function bump() {
    revision += 1;
    hub?.publish();
  }

  /** @returns {object} the error as a translatable `{ code, message }`. */
  function errorOf(error) {
    if (error === null || error === undefined) return null;
    return { code: typeof error.code === 'string' ? error.code : 'ERROR', message: String(error?.message ?? error) };
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
          fetchBalance({ baseURL: config.api.baseURL, apiKey: secret.value, timeoutMs: config.api.timeoutMs }),
          fetchModels({ baseURL: config.api.baseURL, apiKey: secret.value, timeoutMs: config.api.timeoutMs }),
        ]);
        apiFacts = { balance, models, at: Date.now(), error: null };
        logger?.info?.(`apicost: balance and ${models.length} models refreshed`);
      } catch (error) {
        const mapped = errorOf(error);
        logger?.warn?.(`apicost: balance/models refresh failed (${mapped.code}): ${mapped.message}`);
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
    const fresh = usageFacts.error === null && usageFacts.at > 0 && !monthChanged && Date.now() - usageFacts.at < config.platform.intervalMs;
    if (options.force !== true && fresh) return usageFacts;
    if (usageInflight !== null) return usageInflight;
    if (options.force !== true && !monthChanged && Date.now() - usageLastAttemptAt < config.platform.minRefreshMs) return usageFacts;
    usageLastAttemptAt = Date.now();

    usageInflight = (async () => {
      try {
        const secret = await resolveSecret({ credentials: credentialsNow(), ref: config.consoleTokenEnv });
        if (secret === null) {
          usageFacts = { usage: null, at: Date.now(), month, error: { code: 'NO_CONSOLE_TOKEN', message: `credential ${config.consoleTokenEnv} is not configured` } };
          return usageFacts;
        }
        const [year, monthNumber] = month.split('-').map((part) => Number.parseInt(part, 10));
        // The summary and the two series endpoints are read independently: a
        // partial answer still renders, with the failure reported beside it.
        const [summaryResult, usageResult] = await Promise.allSettled([
          fetchSummary({ baseURL: config.platform.baseURL, token: secret.value, timeoutMs: config.platform.timeoutMs }),
          fetchUsage({ baseURL: config.platform.baseURL, token: secret.value, year, month: monthNumber, timeoutMs: config.platform.timeoutMs }),
        ]);
        if (summaryResult.status === 'rejected' && usageResult.status === 'rejected') throw summaryResult.reason;
        const usage = usageResult.status === 'fulfilled' ? usageResult.value : { amount: null, cost: null, partial: null, partialMessage: null };
        const partial = usage.partial ?? (summaryResult.status === 'rejected' ? 'summary' : null);
        const partialError =
          partial === null
            ? null
            : { code: 'PARTIAL', message: `${partial} rows could not be read${usage.partialMessage ? ': ' + usage.partialMessage : ''}` };
        usageFacts = {
          usage: normalizeUsage({
            summary: summaryResult.status === 'fulfilled' ? summaryResult.value : null,
            amount: usage.amount,
            cost: usage.cost,
            month,
            logger,
          }),
          at: Date.now(),
          month,
          error: partialError,
        };
        if (partialError === null) logger?.info?.(`apicost: console usage refreshed for ${month}`);
        else logger?.warn?.(`apicost: console usage partially read for ${month}: ${partialError.message}`);
      } catch (error) {
        const mapped = errorOf(error);
        logger?.warn?.(`apicost: console usage refresh failed (${mapped.code}): ${mapped.message}`);
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
    await Promise.all([refreshCredentialFacts(), refreshApi(options), refreshUsage(options)]);
    // The session read is synchronous and credential-free, so it runs after the
    // credential facts land: a session that only appears once the store resolves
    // is then picked up without an extra tick.
    refreshSessionUsage();
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
      return { configured: false, code: 'CREDENTIALS_UNAVAILABLE', message: 'the harness credential service is not available' };
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
        return { configured: false, code: 'INVALID_TOKEN', message: 'that does not look like a platform console token' };
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
    consoleToken: { configured: false, source: null, writable: false, ref: config.consoleTokenEnv },
  };

  /** @returns {object} the snapshot served to the browser. */
  function buildSnapshot() {
    const preferred = preferredBalance(apiFacts.balance);
    const current = liveModel;
    return {
      revision,
      generatedAt: Date.now(),
      api: {
        baseURL: config.api.baseURL,
        updatedAt: apiFacts.at || null,
        error: apiFacts.error,
        balance: apiFacts.balance,
        preferred,
        models: apiFacts.models,
      },
      console: {
        baseURL: config.platform.baseURL,
        updatedAt: usageFacts.at || null,
        month: usageFacts.month,
        error: usageFacts.error,
        usage: usageFacts.usage,
      },
      /**
       * Session-scoped usage, measured by the harness itself. Deliberately a
       * sibling of `console`, never folded into it: the console reports what
       * the *account* was billed, this reports what *this session* the provider
       * reported. Different 口径, so they are two blocks and never one number.
       */
      session: sessionUsage,
      credentials: credentialFacts,
      currentModel: current,
      live: { streaming: current !== null && current.streaming === true, model: current?.model ?? null, provider: current?.provider ?? null },
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
   * @returns {void}
   */
  function refreshSessionUsage() {
    let next;
    try {
      next = readSessionUsage({ ctx, sessionId: config.sessionId });
    } catch (error) {
      logger?.warn?.(`apicost: session usage read failed: ${String(error?.message ?? error)}`);
      return;
    }
    const before = sessionUsage === null ? '' : JSON.stringify(sessionUsage);
    const after = next === null ? '' : JSON.stringify(next);
    if (before === after) return;
    sessionUsage = next;
    bump();
  }

  /** Re-read credential presence; it is safe for a UI and carries no secret. */
  async function refreshCredentialFacts() {
    const [apiKey, consoleToken] = await Promise.all([
      describeSecret({ credentials: credentialsNow(), ref: config.apiKeyEnv }),
      describeSecret({ credentials: credentialsNow(), ref: config.consoleTokenEnv }),
    ]);
    credentialFacts = { apiKey: { ...apiKey, ref: config.apiKeyEnv }, consoleToken: { ...consoleToken, ref: config.consoleTokenEnv } };
  }

  const hub = createSseHub({
    buildPayload: () => ({ type: 'snapshot', revision, snapshot: buildSnapshot() }),
    maxClients: config.maxSseClients,
    heartbeatMs: config.heartbeatMs,
    logger,
  });

  const routes = createRoutes({
    buildSnapshot,
    refreshAll,
    setConsoleToken,
    hub,
    gate: createGate({ ctx, config }),
    logger,
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

  ctx.effect(
    () => {
      // Polling cadence: fast until the panel actually has data, then slow.
      // Credentials and tokens can resolve after the host boots, so we retry
      // quickly instead of waiting for the normal interval (up to a minute).
      const slowIntervalMs = Math.min(config.api.intervalMs, config.platform.intervalMs);
      const fastIntervalMs = 2000;

      function isDataReady() {
        const apiConfigured = credentialFacts.apiKey.configured;
        const apiReady = !apiConfigured || (apiFacts.error === null && apiFacts.at > 0);
        const tokenConfigured = credentialFacts.consoleToken.configured;
        const usageReady = !config.platform.enabled || !tokenConfigured || usageFacts.usage !== null;
        return apiReady && usageReady;
      }

      let apiTimer = null;
      function scheduleNextRefresh() {
        if (apiTimer !== null) clearTimeout(apiTimer);
        const interval = isDataReady() ? slowIntervalMs : fastIntervalMs;
        apiTimer = setTimeout(() => {
          void refreshAll(isDataReady() ? {} : { force: true })
            .catch((error) => logger.warn(`apicost: refresh tick failed: ${String(error?.message ?? error)}`))
            .finally(scheduleNextRefresh);
        }, interval);
        apiTimer.unref?.();
      }

      // Kick off the first read immediately, then start the adaptive loop.
      void refreshAll({ force: true })
        .catch((error) => logger.warn(`apicost: initial refresh failed: ${String(error?.message ?? error)}`))
        .finally(scheduleNextRefresh);

      // Warmup probes give a few extra pushes in the first seconds for
      // credentials, balance and usage, in case the credential store resolves late.
      const warmup = [1500, 4000, 8000].map((ms) =>
        setTimeout(() => {
          void Promise.all([refreshCredentialFacts(), refreshApi({ force: true }), refreshUsage({ force: true })]).catch(() => {});
        }, ms),
      );
      warmup.forEach((timer) => timer.unref?.());

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
    },
    'apicost: lifecycle',
  );

  ctx.inject?.(['webServer'], (scope) => {
    scope.effect(
      () => {
        const server = scope.get('webServer') ?? scope.webServer;
        if (server === null || server === undefined || typeof server.register !== 'function') return () => {};
        const registered = [
          { path: ROUTE_PATHS.snapshot, handler: routes.snapshot },
          { path: ROUTE_PATHS.events, handler: routes.events },
          { path: ROUTE_PATHS.refresh, handler: routes.refresh },
          { path: ROUTE_PATHS.consoleToken, handler: routes.consoleToken },
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
      },
      'apicost: routes',
    );
  });
}

export default apply;
