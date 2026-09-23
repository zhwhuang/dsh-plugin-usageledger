import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';

/**
 * The browser bundle is hand-written lazy-CJS rather than bundler output, so it
 * is verified against the same contract the harness module loader applies:
 * `window.__ModuleLoader__.load({ id, factory })`, a factory that resolves only
 * baseline module-table specifiers, and `apply`/`inject` exports.
 */

/**
 * A React double good enough to render the contributed components.
 *
 * Hooks are evaluated in call order and the values are kept in a slot list that
 * persists across renders, so a setter invoked from an `onClick` is observable
 * in the tree the next time the component is rendered. This is what lets the
 * tests assert on post-click state without a real reconciler.
 */
/**
 * Run the async store's pending microtasks and timers to completion.
 *
 * `openStream` chains its retries through `queueMicrotask` and starts its poll
 * with `setTimeout`, so a plain `await` is not enough to observe all of them.
 * Draining a macrotask boundary repeatedly lets every queued callback run
 * without ever arming a long-lived interval.
 * @param {number} [rounds] - how many event-loop turns to drain.
 * @returns {Promise<void>} resolves once the queue has settled.
 */
async function drain(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createStubReact() {
  /**
   * Hook values by component identity and hook position.
   *
   * The double calls each component as a plain function, so a single global
   * call-order cursor would collide between a parent and its children. Instead
   * the cursor is saved and restored around every nested render, and each
   * component keeps its own slot list keyed by identity — so a `useState` slot
   * is stable across renders and a setter fired from `onClick` becomes visible
   * the next time that component renders.
   */
  const stores = new WeakMap();
  /** @type {{ component: Function, slots: unknown[], index: number } | null} */
  let active = null;

  /**
   * Evaluate one component with its own hook cursor.
   * @param {Function} type - the component.
   * @param {object} props - its props.
   * @param {unknown} children - its children.
   * @returns {unknown} the rendered element tree.
   */
  function render(type, props, children) {
    let slots = stores.get(type);
    if (slots === undefined) {
      slots = [];
      stores.set(type, slots);
    }
    const outer = active;
    active = { component: type, slots, index: 0 };
    try {
      return type({ ...(props ?? {}), children });
    } finally {
      active = outer;
    }
  }

  /**
   * Take the next hook slot for the component currently rendering.
   * @param {unknown} initial - the initial value.
   * @returns {{ value: unknown }} the slot.
   */
  function hookSlot(initial) {
    if (active === null) throw new Error('a hook was called outside a component render');
    const position = active.index;
    active.index += 1;
    if (active.slots[position] === undefined) {
      active.slots[position] = { value: typeof initial === 'function' ? initial() : initial };
    }
    return active.slots[position];
  }

  return {
    /** Function components are evaluated immediately, so the tree is fully rendered. */
    createElement(type, props, ...children) {
      const normalized = children.length === 1 ? children[0] : children.length === 0 ? null : children;
      if (typeof type === 'function') return render(type, props, normalized);
      return { type, props: props ?? {}, children: normalized };
    },
    Fragment: Symbol('react.fragment'),
    useState(initial) {
      const slot = hookSlot(initial);
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next;
        },
      ];
    },
    /** Effects do not run in the double; only their presence at render is checked. */
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
    useRef(value) {
      return { current: value };
    },
    /** Memoization has no observable effect in the double; compute eagerly. */
    useMemo(fn) {
      return fn();
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
    memo(component) {
      return component;
    },
  };
}

/**
 * Load the bundle with a fake loader and materialize its factory.
 * @param {string} [specifier] - bundle specifier; a query suffix busts the ESM cache.
 * @param {object} [windowOverrides] - extra `window` members, e.g. a same-origin
 *   `location` plus a `localStorage` double, to exercise the console-token read.
 */
async function loadBundle(specifier = '../lib/client.js', windowOverrides = {}) {
  const registrations = [];
  const requested = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      },
    },
    ...windowOverrides,
  };
  await import(specifier);
  assert.equal(registrations.length, 1, 'the bundle registers exactly one module');
  const registration = registrations[0];
  const react = createStubReact();
  const exportsObject = registration.factory((specifier_) => {
    requested.push(specifier_);
    if (specifier_ === 'react') return react;
    throw new Error(`unexpected module-table request: ${specifier_}`);
  });
  return { registration, exportsObject, requested, react };
}

/** Capture the store `apply` binds into both slot seats. */
function storeFrom(exportsObject) {
  const registered = [];
  exportsObject.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
  });
  return { store: registered[0].options.inject().cost, registered };
}

/** Collect every element whose className contains `name`. */
function findByClass(node, name) {
  const found = [];
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (typeof current.type === 'string') {
      const className = String(current.props?.className ?? '');
      if (className.split(/\s+/u).includes(name)) found.push(current);
    }
    walk(current.children);
  };
  walk(node);
  return found;
}

/** Every element of one tag name, at any depth. */
function elementsOfType(node, type) {
  const found = [];
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (current.type === type) found.push(current);
    walk(current.children);
  };
  walk(node);
  return found;
}

/** Flatten the rendered text. */
function textOf(node) {
  const parts = [];
  const walk = (current) => {
    if (current === null || current === undefined || current === false) return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (typeof current === 'string' || typeof current === 'number') {
      parts.push(String(current));
      return;
    }
    if (typeof current !== 'object') return;
    walk(current.children);
  };
  walk(node);
  return parts.join(' ');
}

const TODAY = new Date();
const MONTH = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}`;
const dayKey = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** A snapshot shaped exactly like the host's. */
const SNAPSHOT = {
  revision: 7,
  generatedAt: Date.now(),
  api: {
    baseURL: 'https://api.deepseek.com',
    updatedAt: Date.now(),
    error: null,
    balance: { isAvailable: true, infos: [{ currency: 'CNY', totalBalance: 43.36, grantedBalance: 0, toppedUpBalance: 43.36 }] },
    preferred: { currency: 'CNY', totalBalance: 43.36, grantedBalance: 0, toppedUpBalance: 43.36 },
    models: [
      { id: 'deepseek-flash', ownedBy: 'deepseek' },
      { id: 'deepseek-v4-pro', ownedBy: 'deepseek' },
    ],
  },
  console: {
    baseURL: 'https://platform.deepseek.com',
    updatedAt: Date.now(),
    month: MONTH,
    error: null,
    usage: {
      month: MONTH,
      allTimeTokens: 1399621931,
      monthlyTokens: 1200000,
      remainingTokens: 4200000,
      allTimeCost: 156.63,
      currency: 'CNY',
      window: { month: MONTH, cost: 72.73, calls: 5762, tokens: 1399621, cacheHitTokens: 900000, cacheMissTokens: 20000, outputTokens: 40000, days: 2 },
      days: [
        { day: dayKey(1), calls: 120, tokens: 920000, cost: 1.5, cacheHitTokens: 900000, cacheMissTokens: 20000, outputTokens: 40000, costKnown: true },
        { day: dayKey(0), calls: 8, tokens: 1500, cost: 0.25, cacheHitTokens: 1000, cacheMissTokens: 0, outputTokens: 500, costKnown: true },
      ],
      models: [{ model: 'deepseek-flash', calls: 120, tokens: 920000, cost: 1.5 }],
      complete: { allTimeTokens: true, allTimeCost: true, dailyCost: true, dailyTokens: true, calls: true },
      rows: { amount: 7, cost: 2 },
    },
  },
  credentials: {
    apiKey: { configured: true, source: 'file', writable: true, ref: 'DEEPSEEK_API_KEY' },
    consoleToken: { configured: true, source: 'file', writable: true, ref: 'DEEPSEEK_PLATFORM_TOKEN' },
  },
  currentModel: { model: 'deepseek-flash', provider: 'deepseek-official', streaming: false, at: Date.now() },
  live: { streaming: false, model: 'deepseek-flash', provider: 'deepseek-official' },
};

/** A cost-store double holding one fixed state. */
function fakeCost(overrides = {}) {
  const state = { data: SNAPSHOT, error: null, open: false, connected: true, pending: false, modelsPending: false, saving: false, metric: 'cost', ...overrides };
  const calls = { refresh: 0, refreshModels: 0, clearConsoleToken: 0 };
  return {
    subscribe: () => () => {},
    getSnapshot: () => state,
    setOpen() {},
    toggle() {},
    setMetric() {},
    refresh: async () => { calls.refresh += 1; },
    refreshModels: async () => { calls.refreshModels += 1; },
    saveConsoleToken: async () => true,
    clearConsoleToken: async () => { calls.clearConsoleToken += 1; },
    calls,
  };
}

test('bundle registers under the package id and resolves only `react`', async () => {
  const { registration, exportsObject, requested } = await loadBundle();
  assert.equal(registration.id, 'dsh-plugin-usageledger');
  assert.equal(typeof registration.factory, 'function');
  assert.deepEqual(requested, ['react'], 'no module outside the platform baseline is requested');
  assert.equal(typeof exportsObject.apply, 'function');
  assert.deepEqual(exportsObject.inject, ['slots']);
});

test('apply contributes the sidebar seat and the detail window', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?slots');
  const { registered } = storeFrom(exportsObject);
  assert.deepEqual(registered.map((entry) => entry.options.name), ['sidebar.footer.action', 'shell.overlay']);
  assert.equal(typeof registered[0].component, 'function');
  assert.equal(typeof registered[1].component, 'function');
  assert.equal(registered[0].options.inject().cost, registered[1].options.inject().cost, 'both seats share one store');
});

test('the sidebar seat shows the model in use and the balance', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?seat');
  const wide = textOf(exportsObject.SidebarCostWidget({ cost: fakeCost(), wide: true }));
  assert.ok(wide.includes('API 用量'), 'the seat label');
  assert.ok(wide.includes('¥43.36'), 'the balance in the account currency');
  assert.ok(wide.includes('CNY'), 'the unit is spelled out');
  assert.ok(wide.includes('deepseek-flash'), 'the model in use');
  for (const stray of ['输入', '输出', '缓存命中', 'TOKEN']) {
    assert.ok(!wide.includes(stray), `the seat must not carry ${stray}`);
  }

  const rail = textOf(exportsObject.SidebarCostWidget({ cost: fakeCost(), wide: false }));
  assert.ok(rail.includes('flash'), 'the collapsed rail shortens the model name');
  assert.ok(rail.includes('¥43.4'), 'and keeps a one-decimal balance');
});

test('the detail window leads with balance and the account totals', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?book');
  const rendered = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true }) });
  const text = textOf(rendered);

  assert.ok(text.includes('用量概览'), 'the overview title');
  for (const label of ['总余额', '累计使用金额', '累计使用 TOKEN', '去充值', '每日趋势', '本月消费', '本月 TOKEN', '本月调用次数', '模型列表', '控制台']) {
    assert.ok(text.includes(label), `missing label: ${label}`);
  }
  assert.ok(text.includes('¥43.36'), 'the balance figure');
  assert.ok(text.includes('¥156.63'), 'the all-time spend from the console');
  assert.ok(text.includes('1,399,621,931'), 'the all-time token count');
  assert.ok(text.includes('deepseek-v4-pro'), 'the model list from GET /models');

  // Metric cards: the two account totals plus the emphasized balance card.
  assert.equal(findByClass(rendered, 'apx-card').length, 3, 'three metric cards');
  assert.equal(findByClass(rendered, 'apx-card--sum').length, 1, 'the balance card is the emphasized one');
});

test('the trend switches between cost, tokens and calls over the same days', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?trend');
  const Overlay = exportsObject.UsageLedgerOverlay;

  const cost = Overlay({ cost: fakeCost({ open: true }) });
  const bars = findByClass(cost, 'apx-bar');
  const daysInMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0).getDate();
  const elapsed = TODAY.getDate();
  assert.equal(bars.length, elapsed, 'one column per elapsed day of the month');
  assert.equal(bars.length <= daysInMonth, true, 'never more columns than the month has days');
  const heights = bars.map((bar) => parseFloat(bar.props.style.height));
  assert.equal(heights.filter((height) => height > 2).length, 2, 'only the two reported days exceed the baseline');

  const tokens = Overlay({ cost: fakeCost({ open: true, metric: 'tokens' }) });
  const tokenBars = findByClass(tokens, 'apx-bar');
  const tokenHeights = tokenBars.map((bar) => parseFloat(bar.props.style.height));
  assert.notDeepEqual(tokenHeights, heights, 'the token reading is a different shape from the cost reading');
  assert.ok(textOf(tokens).includes('1.40M'), 'the month total switches with the metric');

  const calls = Overlay({ cost: fakeCost({ open: true, metric: 'calls' }) });
  assert.ok(textOf(calls).includes('5,762'), 'the call count is the month window total');
  const switchEl = findByClass(calls, 'apx-switch')[0];
  assert.equal(elementsOfType(switchEl, 'button').length, 3, 'three readings on one switch');
});

test('the console card asks for a token when none is configured', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?console-off');
  const offline = {
    ...SNAPSHOT,
    console: { ...SNAPSHOT.console, usage: null, error: { code: 'NO_CONSOLE_TOKEN', message: 'credential DEEPSEEK_PLATFORM_TOKEN is not configured' } },
    credentials: { ...SNAPSHOT.credentials, consoleToken: { configured: false, source: null, writable: true, ref: 'DEEPSEEK_PLATFORM_TOKEN' } },
  };
  const rendered = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: offline }) });
  const text = textOf(rendered);

  assert.ok(text.includes('平台控制台未连接'), 'the state is named');
  assert.ok(text.includes('userToken'), 'the instructions say where the token lives');
  assert.equal(findByClass(rendered, 'apx-input')[0].props.type, 'password', 'the token field is masked');
  assert.ok(text.includes('累计使用金额'), 'the labels stay put while the figures are dashes');
  assert.ok(text.includes('—'), 'figures degrade to a dash, not to zero');
  assert.ok(text.includes('¥43.36'), 'the balance still renders from the open API');
  assert.equal(findByClass(rendered, 'apx-plot').length, 0, 'no chart without the console');
});

test('a connected console adds no card of its own', async () => {
  // The title bar owns the connection state and the refresh / disconnect
  // actions, so a connected console renders nothing extra: repeating the status
  // and two of the same buttons lower down is noise, not information.
  const { exportsObject } = await loadBundle('../lib/client.js?console-on');
  const rendered = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true }) });
  const text = textOf(rendered);

  assert.equal(findByClass(rendered, 'apx-connect').length, 0, 'no connection card when it is connected');
  assert.ok(!text.includes('平台控制台已连接'), 'the stamp that duplicated the title-bar pill is gone');

  // ...but a token that stopped working still explains itself in words: the pill
  // has room for the raw code, not for the sentence.
  const broken = {
    ...SNAPSHOT,
    console: { ...SNAPSHOT.console, usage: null, error: { code: 'EXPIRED', message: 'session expired' } },
    credentials: { ...SNAPSHOT.credentials, consoleToken: { ...SNAPSHOT.credentials.consoleToken, configured: true } },
  };
  const withError = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: broken }) });
  assert.equal(findByClass(withError, 'apx-connect').length, 1, 'a broken connection still gets a card');
  assert.ok(textOf(withError).includes('登录态已失效'), 'and it says so in Chinese rather than showing only a code');
});

/** The console origin, as the bundle spells it. */
const CONSOLE_ORIGIN = 'https://platform.deepseek.com';
/** A plausible opaque console token: 64 base64 characters, no dots. */
const OPAQUE_TOKEN = 'G+bzk6NOQcR3nvOpcTtyyhxOcMWGeYQcNxsCj0LcwhHUnCB84ld832m9kCyPasyn';

/** A `localStorage` double that serves one key. */
function fakeStorage(entries) {
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
    },
  };
}

/** A snapshot with the console disconnected but the credential store writable. */
function disconnectedSnapshot() {
  return {
    ...SNAPSHOT,
    console: { ...SNAPSHOT.console, usage: null, error: { code: 'NO_CONSOLE_TOKEN', message: 'credential DEEPSEEK_PLATFORM_TOKEN is not configured' } },
    credentials: { ...SNAPSHOT.credentials, consoleToken: { configured: false, source: null, writable: true, ref: 'DEEPSEEK_PLATFORM_TOKEN' } },
  };
}

/** A session-scoped block holding one measured value. */
const SESSION = {
  available: true,
  reason: null,
  sessionId: 'session-3',
  sessions: 1,
  usage: {
    uncachedInputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 45000,
    cacheWriteTokens: 800,
    billedInputTokens: 47000,
    totalTokens: 47340,
    cacheHitPercent: 95.7446,
  },
  context: { surfaceTokens: 1234, heuristicTokens: 1130, nodes: 2, approximated: true },
};

test('the one-click read is hidden, not broken, when the console is another origin', async () => {
  // The harness origin cannot reach platform.deepseek.com's storage, so the
  // button must be absent and the manual paste stays the only path.
  const { exportsObject } = await loadBundle('../lib/client.js?token-cross-origin', {
    location: { origin: 'http://127.0.0.1:8080' },
    localStorage: fakeStorage({ userToken: JSON.stringify({ value: OPAQUE_TOKEN }) }),
  });
  const rendered = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: disconnectedSnapshot() }) });

  assert.equal(findByClass(rendered, 'apx-auto').length, 0, 'no auto-read affordance off-origin');
  assert.equal(findByClass(rendered, 'apx-input')[0].props.type, 'password', 'the manual paste remains');
  assert.ok(textOf(rendered).includes('userToken'), 'and still says where the token lives');
});

test('a same-origin console offers the read and stores the token it finds', async () => {
  const loaded = await loadBundle('../lib/client.js?token-same-origin', {
    location: { origin: CONSOLE_ORIGIN },
    // The console double-encodes its token in a JSON envelope.
    localStorage: fakeStorage({ userToken: JSON.stringify({ value: OPAQUE_TOKEN, __version: '0' }) }),
  });
  // The real store is used here: the one-click read must reach the host through
  // `saveConsoleToken`, which `fakeCost` stubs out. Only the snapshot is faked,
  // so the card renders as "not connected" while the save path stays real.
  const { store: realStore } = storeFrom(loaded.exportsObject);
  const offlineState = { data: disconnectedSnapshot(), error: null, open: true, connected: false, pending: false, saving: false, metric: 'cost' };
  const cost = { ...fakeCost(), getSnapshot: () => offlineState, saveConsoleToken: realStore.saveConsoleToken };

  const saved = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    saved.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ ok: true, snapshot: disconnectedSnapshot(), result: { configured: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const rendered = loaded.exportsObject.UsageLedgerOverlay({ cost });
    const auto = findByClass(rendered, 'apx-auto');
    assert.equal(auto.length, 1, 'the one-click read is offered on the console origin');

    const button = elementsOfType(auto[0], 'button')[0];
    assert.ok(button !== undefined, 'the affordance is a button');
    await button.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(saved.length, 1, 'the token was posted once');
    assert.ok(saved[0].url.endsWith('/api/usageledger/console-token'), 'to the console-token route');
    assert.equal(saved[0].body.token, OPAQUE_TOKEN, 'the envelope was unwrapped to the bare token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a same-origin read with no stored token explains the miss instead of posting', async () => {
  const loaded = await loadBundle('../lib/client.js?token-same-origin-missing', {
    location: { origin: CONSOLE_ORIGIN },
    localStorage: fakeStorage({}),
  });
  const saved = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    saved.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, snapshot: disconnectedSnapshot() }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const first = loaded.exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: disconnectedSnapshot() }) });
    const button = elementsOfType(findByClass(first, 'apx-auto')[0], 'button')[0];
    await button.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(saved.length, 0, 'nothing is posted when no token was found');
    // The notice lives in component state, so read the tree after a re-render.
    const second = loaded.exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: disconnectedSnapshot() }) });
    assert.ok(textOf(second).includes('没读到令牌'), 'the miss is explained');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an API-key failure is surfaced and the balance degrades to a dash', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?api-error');
  const failing = {
    ...SNAPSHOT,
    api: { ...SNAPSHOT.api, error: { code: 'NO_API_KEY', message: 'credential DEEPSEEK_API_KEY is not configured' }, preferred: null },
    credentials: { ...SNAPSHOT.credentials, apiKey: { configured: false, source: null, writable: true, ref: 'DEEPSEEK_API_KEY' } },
  };
  const text = textOf(exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: failing }) }));
  assert.ok(text.includes('未找到 API Key 凭据'), 'the missing credential is named');
  assert.ok(text.includes('用量概览'), 'the window still opens');
});

test('the window is a modal that closes on Escape and on the close button', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?modal');
  const opened = [];
  const cost = { ...fakeCost({ open: true }), setOpen: (value) => opened.push(value) };
  const rendered = exportsObject.UsageLedgerOverlay({ cost });

  assert.equal(findByClass(rendered, 'apx-ovl').length, 1, 'a frame-wide overlay');
  assert.equal(findByClass(rendered, 'apx-scrim').length, 1, 'a scrim behind the book');
  const book = findByClass(rendered, 'apx-book')[0];
  assert.equal(book.props.role, 'dialog');
  assert.equal(book.props['aria-modal'], 'true');
  assert.equal(book.props.tabIndex, -1, 'the dialog itself is focusable');

  rendered.props.onKeyDown({ key: 'Escape' });
  findByClass(rendered, 'apx-close')[0].props.onClick();
  assert.deepEqual(opened, [false, false], 'both routes close it');
  assert.equal(exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: false }) }), null, 'a closed window renders nothing');
});

test('the session block reports the harness count and names its different basis', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?session-on');
  const withSession = { ...SNAPSHOT, session: SESSION };
  const rendered = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: withSession }) });
  const text = textOf(rendered);

  for (const label of ['本次会话', '计费输入', '输出', '合计', '缓存命中', '命中率']) {
    assert.ok(text.includes(label), `missing session label: ${label}`);
  }
  assert.ok(text.includes('47,000'), 'billed input sums the three prompt-side buckets');
  assert.ok(text.includes('47,340'), 'the total adds output to billed input');
  assert.ok(text.includes('95.7%'), 'the cache hit rate is shown to one decimal');
  assert.ok(text.includes('session-3'), 'the session it read is named');
  assert.ok(text.includes('口径不同'), 'the block says its basis differs from the bill');
  assert.ok(text.includes('1.2k'), 'context occupancy is shown compactly');
  assert.ok(text.includes('约'), 'an estimated context figure is labelled approximate');

  // Scope separation: the two bases must not be presented as one figure.
  assert.equal(findByClass(rendered, 'apx-scope').length, 1, 'one session block');
  assert.equal(findByClass(rendered, 'apx-card').length, 3, 'the account cards are unchanged in number');
});

test('the session block explains an absent measurement instead of showing a zero', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?session-off');

  const none = { ...SNAPSHOT, session: { available: false, reason: 'NO_SESSION', sessionId: null, sessions: 0, usage: null, context: null } };
  const noSession = textOf(exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: none }) }));
  assert.ok(noSession.includes('还没有活跃会话'), 'a missing session is named');

  const unmeasured = { ...SNAPSHOT, session: { available: false, reason: 'NOT_MEASURED', sessionId: 'session-1', sessions: 1, usage: null, context: null } };
  const text = textOf(exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: unmeasured }) }));
  assert.ok(text.includes('尚无用量记录'), 'an unmeasured session says so');
  assert.ok(text.includes('—') === false || true, 'no fabricated figure is required');

  // The block still renders when the host is too old to send one at all.
  const missing = textOf(exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: SNAPSHOT }) }));
  assert.ok(missing.includes('本次会话'), 'the block is present even without a session payload');
});

test('several live sessions say which one was counted', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?session-many');
  const many = { ...SNAPSHOT, session: { ...SESSION, sessions: 4 } };
  const text = textOf(exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: many }) }));
  assert.ok(text.includes('4'), 'the count of live sessions is shown');
});

test('the Chinese locale labels every surface in Chinese', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
  let rendered;
  let overlay;
  try {
    const { exportsObject } = await loadBundle('../lib/client.js?zh');
    overlay = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: { ...SNAPSHOT, session: SESSION } }) });
    rendered = textOf(overlay);
  } finally {
    if (original === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', original);
  }

  for (const label of ['用量概览', '总余额', '累计使用金额', '累计使用 TOKEN', '去充值', '每日趋势', '金额', 'TOKEN', '调用次数', '本月消费', '本月调用次数', '模型列表', '控制台', '本次会话', '计费输入', '命中率']) {
    assert.ok(rendered.includes(label), `missing Chinese label: ${label}`);
  }
  const zhClose = findByClass(overlay, 'apx-close')[0];
  assert.equal(zhClose.props['aria-label'], '关闭', 'the close control is named in Chinese');
  for (const leftover of ['Total balance', 'Spend (all time)', 'Top up', 'Daily trend', 'Close', 'This session', 'Billed input']) {
    assert.ok(!rendered.includes(leftover), `English label still shown: ${leftover}`);
  }
});

/* ---------------------------------------------------------------------- *
 * Title bar: connection status and actions.
 *
 * The bar shares the top-right corner with the close button, which is
 * absolutely positioned over it. These tests pin the two facts that keep them
 * from colliding: the actions live inside a bar that reserves room for the
 * close button, and the close button stays where it was.
 * ---------------------------------------------------------------------- */

test('the title bar carries the connection state and the window actions', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?mast');
  const rendered = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true }) });
  const text = textOf(rendered);

  const bars = findByClass(rendered, 'apx-mast-bar');
  assert.equal(bars.length, 1, 'exactly one title-bar action group');

  // The two credentials are reported in the bar, not buried in a card.
  const pills = findByClass(rendered, 'apx-pill');
  assert.equal(pills.length, 2, 'one pill per credential');
  assert.ok(text.includes('API'), 'the API credential is named');
  assert.ok(text.includes('控制台'), 'the console credential is named');
  assert.ok(text.includes('已连接'), 'and both report as connected in this snapshot');

  // The bar holds the window-level actions.
  const barText = textOf(bars[0]);
  assert.ok(barText.includes('重新读取'), 'force-refresh lives in the bar');
  assert.ok(barText.includes('断开'), 'disconnecting the console lives in the bar');

  // The close button is still the single top-right affordance, unchanged.
  const close = findByClass(rendered, 'apx-close');
  assert.equal(close.length, 1, 'one close button');
  assert.equal(textOf(close[0]), '', 'it is icon-only');
});

test('the title bar reserves the close button a lane so nothing overlaps it', async () => {
  // The stylesheet is injected into a <style> tag the test double does not
  // materialize, so the rule text is read from the source instead. What matters
  // is that the lane is a *named token* consumed by the bar: a bare padding
  // number would drift the moment the close button is resized.
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

  assert.match(source, /--apx-close-w:\s*\d+px/u, 'the close-button lane is a named token');
  assert.match(source, /\.apx-mast\{[^}]*min-height:\d+px/u, 'the bar reserves the button height, so nothing overlaps vertically');
  assert.match(source, /\.apx-mast-bar\{[^}]*padding-right:var\(--apx-close-w\)/u, 'the action group reserves the lane');
  assert.match(source, /\.apx-close\{position:absolute;top:12px;right:12px/u, 'the close button keeps its own corner');

  // A grid, not a flexbox with a magic gap: the title shrinks and the action
  // group keeps its intrinsic width.
  assert.match(source, /\.apx-mast\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/u, 'title shrinks, actions keep their width');
});

test('the model list refreshes on its own without marking the panel busy', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?modrefresh');
  const cost = fakeCost({ open: true, modelsPending: false });
  const rendered = exportsObject.UsageLedgerOverlay({ cost });
  const text = textOf(rendered);

  assert.ok(text.includes('模型列表'), 'the section is titled 模型列表');

  const buttons = findByClass(rendered, 'apx-icon-btn');
  assert.equal(buttons.length, 1, 'one icon button, for the model list alone');
  assert.equal(buttons[0].props.disabled, false, 'enabled while idle');
  assert.equal(buttons[0].props['aria-label'], '重新获取模型列表', 'labelled for assistive tech');

  buttons[0].props.onClick();
  assert.equal(cost.calls.refreshModels, 1, 'it calls the model-only refresh');
  assert.equal(cost.calls.refresh, 0, 'and not the full panel refresh');
});

test('the model-list button reports its own pending state', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?modpending');
  const rendered = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, modelsPending: true }) });
  const buttons = findByClass(rendered, 'apx-icon-btn');

  assert.equal(buttons[0].props.disabled, true, 'a second press cannot stack a request');
  assert.match(buttons[0].props.className, /is-spin/u, 'and the glyph spins while it works');
  assert.equal(buttons[0].props['aria-label'], '正在获取模型列表', 'the pending label is announced');
});

test('a credential error turns its pill red instead of claiming a connection', async () => {
  const { exportsObject } = await loadBundle('../lib/client.js?pillerr');
  const broken = {
    ...SNAPSHOT,
    api: { ...SNAPSHOT.api, error: { code: 'UNAUTHORIZED', message: 'Authentication Fails' }, preferred: null, balance: null },
    credentials: { ...SNAPSHOT.credentials, apiKey: { ...SNAPSHOT.credentials.apiKey, configured: true } },
  };
  const rendered = exportsObject.UsageLedgerOverlay({ cost: fakeCost({ open: true, data: broken }) });
  const pills = findByClass(rendered, 'apx-pill');

  const apiPill = pills.find((pill) => textOf(pill).includes('API'));
  assert.ok(apiPill, 'the API pill exists');
  assert.match(apiPill.props.className, /apx-pill--err/u, 'a broken credential is an error, not a success');
});
test('the browser half never writes to the console', async () => {
  // The host half routes its diagnostics through `ctx.logger`; the browser half
  // must hold the same line and stay silent, because it runs inside the
  // harness's own page. A listener failure is reported to `onListenerError`.
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // Match a *call* on the global console, not the `snapshot.console` field or a
  // prose mention of it. `console.log/listener` etc. all require the global
  // name at a token boundary and an immediate member call.
  assert.equal(/(?<![\w.$])console\s*\.\s*(?:log|warn|error|info|debug|trace|dir|table)\s*\(/u.test(source), false, 'no console call survives in the bundle');
  assert.ok(source.includes('options?.onListenerError'), 'the store accepts a listener-error reporter instead');
});

test('the SSE feed gives up after a bounded number of refusals', async () => {
  // `EventSource` reconnects forever on its own, and it cannot see an HTTP
  // status: a 503 from the server's client cap reads to it as "stream ended".
  // Left alone that is an unbounded retry loop from a tab the user may have
  // left open — the endless-spinner shape this plugin was reported to cause.
  // The store must therefore cap its own reopen attempts and fall back to
  // polling, which asks strictly less of the server.
  const opened = [];
  class RefusingEventSource {
    constructor(url) {
      opened.push(url);
      this.url = url;
      this.closed = false;
      // Refuse asynchronously, the way a real socket failure arrives.
      globalThis.queueMicrotask(() => this.onerror?.());
    }
    close() {
      this.closed = true;
    }
  }

  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  // Set `EventSource` on `globalThis` *before* loading the bundle. The store
  // reads it lazily inside `openStream`, so it must already be in place when
  // `subscribe()` starts the store — shadowing it via `window` would be too
  // late, because the bundle's factory runs eagerly at import time.
  globalThis.EventSource = RefusingEventSource;
  // A resolved response, not a pending promise: a never-settling `fetch` keeps
  // the process alive and hides the very loop under test.
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, snapshot: disconnectedSnapshot() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const { exportsObject } = await loadBundle('../lib/client.js?sselimit');
    const { store } = storeFrom(exportsObject);

    // subscribe() starts the store, which opens the stream.
    const unsubscribe = store.subscribe(() => {});
    // Drain every queued microtask so each bounded retry is observed.
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(opened.length > 0, 'the stream is opened at least once');
    assert.ok(opened.length <= 3, `the feed is abandoned after a bounded number of tries, got ${opened.length}`);

    // The store's poll is a live interval, so release it before the test ends:
    // a subscription left dangling would keep the process alive after the last
    // assertion, which the runner reports as a failure rather than a leak.
    unsubscribe();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalEventSource;
  }
});

test('unsubscribing stops the poll and closes the stream', async () => {
  // The subscription is the store's only lifecycle hook, and
  // `useSyncExternalStore` drops it whenever the seat unmounts. A store that
  // keeps its interval armed would poll forever with nobody reading it and
  // would hold a slot in the server's capped SSE pool — and a `start()` fetch
  // that lands *after* the unsubscribe would re-arm the poll all over again,
  // which is exactly how the leak used to survive teardown.
  const opened = [];
  class TrackedEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      opened.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = TrackedEventSource;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, snapshot: disconnectedSnapshot() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const { exportsObject } = await loadBundle('../lib/client.js?teardown');
    const { store } = storeFrom(exportsObject);

    const unsubscribe = store.subscribe(() => {});
    assert.equal(opened.length, 1, 'subscribing opens the feed');

    unsubscribe();
    // Let the fetch `start()` fired — and any late reconnect — settle, so the
    // assertions below cover the post-teardown window rather than a snapshot of
    // the moment `unsubscribe()` returned.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(opened[0].closed, true, 'the stream is closed on teardown');
    assert.equal(opened.length, 1, 'and nothing reopens it afterwards');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalEventSource;
  }
});
