/**
 * Test doubles for the UsageLedger host half.
 *
 * Lives outside `test/` so the Node test runner does not execute it as a test
 * file of its own.
 */

import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A credentials double implementing only what the plugin uses: per-operation
 * `resolve`, value-free `describe`, and `set`/`unset` into an in-memory store.
 *
 * @param {Record<string, string>} [initial] - reference → value.
 * @returns {object} the fake service.
 */
export function createFakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    store,
    writes,
    async resolve(ref) {
      const value = store.get(ref);
      return value === undefined || value === '' ? undefined : { value, source: 'file' };
    },
    async describe(ref) {
      return { configured: store.has(ref) && store.get(ref) !== '', writable: true, source: 'file' };
    },
    async set(ref, value) {
      store.set(ref, value);
      writes.push({ ref, length: value.length });
    },
    async unset(ref) {
      store.delete(ref);
    },
  };
}

/**
 * A web-server double that records the routes a plugin registers.
 * @returns {{ register: Function, routes: object[] }} fake server.
 */
export function createFakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

/**
 * A minimal cordis context good enough to run the plugin's `apply`.
 *
 * @param {object} [options] - harness options.
 * @param {Record<string, unknown>} [options.services] - lazily resolvable services.
 * @returns {object} harness with the context, its event table, and disposers.
 */
export function createFakeContext({ services = {} } = {}) {
  const events = new Map();
  const disposers = [];
  const registered = [];
  const warnings = [];

  /** @returns {object} a context bound to the shared event table. */
  function makeContext() {
    const ctx = {
      get(name) {
        return services[name];
      },
      on(event, listener, options) {
        const list = events.get(event) ?? [];
        list.push({ listener, options });
        events.set(event, list);
        const disposer = () => {
          const index = list.findIndex((entry) => entry.listener === listener);
          if (index >= 0) list.splice(index, 1);
          return index >= 0;
        };
        disposers.push(disposer);
        return disposer;
      },
      effect(callback, label) {
        const dispose = callback();
        registered.push(label ?? '(effect)');
        if (typeof dispose === 'function') disposers.push(dispose);
        return dispose;
      },
      inject(deps, callback) {
        // The real context re-runs this when a dependency appears; the harness
        // runs it immediately whenever every dependency is already present.
        if (deps.every((name) => services[name] !== undefined)) callback(makeContext());
        return { dispose() {} };
      },
      logger() {
        return {
          info() {},
          warn: (...args) => {
            warnings.push(args.map(String).join(' '));
          },
        };
      },
    };
    return ctx;
  }

  return {
    ctx: makeContext(),
    events,
    disposers,
    registered,
    warnings,
    services,
    disposeAll() {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {
          // A double that already disposed is not a failure.
        }
      }
    },
  };
}

/**
 * Build the cordis waterfall dispatcher for one event name.
 *
 * Copied in shape from cordis' own `EventsService.waterfall`:
 *
 * ```js
 * const cbs = this.dispatch('waterfall', args);
 * const inner = args.pop();
 * const next = () => (cbs.shift() ?? inner)(...args);
 * args.push(next);
 * return next();          // never awaited
 * ```
 *
 * The load-bearing detail is that **cordis never awaits `next()`**. A hook that
 * is declared `async` therefore returns a Promise, and the harness — which
 * iterates the result as a stream — fails with "stream is not async iterable".
 * This double reproduces that strictness: a hook that returns a thenable is
 * rejected outright rather than silently unwrapped, so the whole class of bug
 * is caught here instead of in a live conversation.
 *
 * @param {object} harness - harness from {@link createFakeContext}.
 * @param {string} name - event name.
 * @returns {(options: object, fallback: () => unknown) => unknown} dispatcher.
 */
export function createWaterfall(harness, name) {
  return function dispatch(options, fallback) {
    const list = harness.events.get(name) ?? [];
    const run = (index) => {
      if (index >= list.length) return fallback();
      const result = list[index].listener(options, () => run(index + 1));
      // cordis hands this value straight to the caller without awaiting it, so
      // the dispatcher must never launder a Promise into the returned stream.
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        throw new TypeError('an `llm/stream` hook returned a Promise; cordis never awaits a waterfall, so the hook must not be `async`');
      }
      return result;
    };
    return run(0);
  };
}

/** @returns {object} a fake `IncomingMessage`. */
export function createFakeRequest({ method = 'GET', url = '/', body = null, remoteAddress = '127.0.0.1', headers = {} } = {}) {
  const listeners = new Map();
  const request = {
    method,
    url,
    headers,
    socket: { remoteAddress },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return request;
    },
    destroy() {},
  };
  // Emit the body on the next microtask so a handler that subscribes first sees it.
  queueMicrotask(() => {
    const emit = (event, argument) => {
      for (const listener of listeners.get(event) ?? []) listener(argument);
    };
    if (body !== null) emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
    emit('end');
  });
  return request;
}

/** @returns {object} a fake `ServerResponse` capturing status, headers, and body. */
export function createFakeResponse() {
  const listeners = new Map();
  const response = {
    status: null,
    headers: null,
    body: '',
    frames: [],
    ended: false,
    headersSent: false,
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers;
      response.headersSent = true;
      return response;
    },
    write(chunk) {
      response.frames.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) response.body += String(chunk);
      response.ended = true;
      for (const listener of listeners.get('close') ?? []) listener();
      return response;
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return response;
    },
  };
  return response;
}

/** @returns {object} the parsed JSON body of a fake response. */
export function jsonOf(response) {
  return JSON.parse(response.body);
}

/** @param {object} harness - harness from {@link createFakeContext}. */
export function routeOf(harness, path) {
  for (const route of harness.services.webServer?.routes ?? []) {
    if (route.path === path) return route;
  }
  throw new Error(`route ${path} was not registered`);
}

/** @returns {Promise<object[]>} every chunk produced by an async iterable. */
export async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

/** Every temporary directory this process created, removed when the runner exits. */
const tempDirs = new Set();
let tempSweepRegistered = false;

/** @returns {Promise<string>} a fresh temporary directory. */
export async function createTempDir(prefix = 'usageledger-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(dir);
  if (!tempSweepRegistered) {
    tempSweepRegistered = true;
    // The runner outlives individual test files, so sweep once at process exit.
    process.on('exit', () => {
      for (const path of tempDirs) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          // A locked file must not turn a green run red; the next run sweeps again.
        }
      }
      tempDirs.clear();
    });
  }
  return dir;
}

/** @param {number} ms - delay. @returns {Promise<void>} resolves after the delay. */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A `ctx.sessions` double holding plain session stubs.
 *
 * Only the members the plugin reads are implemented: `list()` and `get(id)`.
 * Each stub carries `id` and `seq` (the durable log length), which is all the
 * session picker needs.
 *
 * @param {Array<{ id?: string, seq?: number, extra?: object }>} [entries] - sessions to expose.
 * @returns {object} the fake service.
 */
export function createFakeSessions(entries = []) {
  const raw = entries.map((entry, index) => ({ id: entry.id ?? `session-${index + 1}`, seq: entry.seq ?? index, ...(entry.extra ?? {}) }));
  return {
    /** The live stub list, for a test that needs to mutate it. */
    raw,
    list() {
      return raw;
    },
    get(id) {
      return raw.find((session) => session.id === id);
    },
  };
}

/**
 * A `ctx.sessionProjections` double serving one `tokenUsage` value per session.
 *
 * `stateOf` returns the UNIT state (`{ totals, last }`) rather than the wire
 * view, matching the real registry, so the plugin's unwrapping is exercised.
 *
 * @param {Map<object, object> | Record<string, object>} [totalsBySession] - session → projection value.
 * @returns {object} the fake service.
 */
export function createFakeProjections(totalsBySession = new Map()) {
  const calls = [];
  const lookup = totalsBySession instanceof Map ? totalsBySession : new Map(Object.entries(totalsBySession));
  return {
    calls,
    stateOf(session, key) {
      calls.push({ session, key });
      if (key !== 'tokenUsage') return undefined;
      const totals = lookup.get(session);
      return totals === undefined ? undefined : { totals, last: null };
    },
  };
}

/**
 * A `ctx.tokenMeter` double whose `measure` returns one fixed measurement.
 *
 * @param {object} [measurement] - the value `measure` resolves to.
 * @returns {object} the fake service.
 */
export function createFakeTokenMeter(measurement = { surfaceTokens: 0, nodes: [], baseline: { kind: 'none', tokens: 0 } }) {
  const calls = [];
  return {
    calls,
    measure(session) {
      calls.push(session);
      return measurement;
    },
  };
}

/** @returns {AsyncIterable<object>} a stream yielding the supplied chunks. */
export function streamOf(chunks, { failAfter = null } = {}) {
  return (async function* generate() {
    for (let index = 0; index < chunks.length; index += 1) {
      if (failAfter !== null && index === failAfter) throw new Error('stream failed');
      yield chunks[index];
    }
    if (failAfter === chunks.length) throw new Error('stream failed');
  })();
}
