/**
 * UsageLedger provider registry: the platform contract plus the discovery
 * merge that turns "the platforms the harness actually reaches" into the
 * snapshot's billing-card list.
 *
 * Two sources feed the merge, in ascending priority:
 *
 * 1. The harness's model routes. Built-in adapters register stable ids
 *    (`deepseek-official`, `moonshotai`, `zai`); custom gateways registered by
 *    `dsh-llm-pi-ai` carry their own baseURL. The route table is read through
 *    `ctx.llm` defensively — the exact discovery surface is adapter-owned and
 *    may not exist, in which case that source contributes nothing.
 * 2. Explicit overrides in the plugin's own config (`providers:` array). An
 *    entry with a matching platform id (or matching a route baseURL) refines
 *    the discovered platform; an entry for an unknown platform declares one
 *    outright. Nothing else needs configuring: the cards follow the model page.
 *
 * A route that names no known platform lands in the generic OpenAI-compatible
 * group — session metering only, no balance/usage API. The registry never
 * throws: discovery runs on every refresh and a mis-shapen service must
 * degrade to "no cards beyond the config" rather than break the panel.
 *
 * @module dsh-plugin-usageledger/provider
 */

/** Stable platform ids the registry ships adapters for. */
export const PLATFORM_IDS = ['deepseek-official', 'moonshot', 'zhipu', 'dashscope'];

/** Human labels per platform id. */
export const PLATFORM_LABELS = {
	'deepseek-official': 'DeepSeek',
	moonshot: 'Kimi',
	zhipu: 'GLM',
	dashscope: 'Qwen'
};

/** Credential reference defaults per platform id. */
export const PLATFORM_CREDENTIAL_REFS = {
	'deepseek-official': 'DEEPSEEK_API_KEY',
	moonshot: 'MOONSHOT_API_KEY',
	zhipu: 'ZHIPU_API_KEY',
	dashscope: 'DASHSCOPE_API_KEY'
};

/** Default endpoint roots per platform id (OpenAI-compatible style bases). */
export const PLATFORM_BASE_URLS = {
	'deepseek-official': 'https://api.deepseek.com',
	moonshot: 'https://api.moonshot.cn/v1',
	zhipu: 'https://open.bigmodel.cn/api/paas/v4',
	dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
};

/**
 * Map a harness route id onto a platform id.
 *
 * Built-in ids map exactly; everything else matches on recognizable substrings
 * so a custom route named `my-moonshot-gateway` still lands on the Kimi card.
 * `null` means "no known platform" — the generic metering-only group.
 *
 * @param {string} routeId - the provider route id from the harness.
 * @returns {string | null} the platform id, or null.
 */
export function platformForRoute(routeId) {
	const id = typeof routeId === 'string' ? routeId.trim().toLowerCase() : '';
	if (id === '') return null;
	if (id === 'deepseek-official' || id.includes('deepseek')) return 'deepseek-official';
	if (id === 'moonshotai' || id.includes('moonshot') || id.includes('kimi')) return 'moonshot';
	if (id === 'zai' || id.includes('zhipu') || id.includes('glm')) return 'zhipu';
	if (id.includes('dashscope') || id.includes('qwen') || id.includes('bailian')) return 'dashscope';
	return null;
}

/**
 * Whether a custom-gateway baseURL points at a platform's host.
 *
 * Hostnames only: the scheme, port, and path are ignored, so a mirror or a
 * proxy path still matches while an unrelated host on the same IP cannot
 * impersonate a platform. `null` platform inputs return false.
 *
 * @param {string | null} platformId - the platform to match against.
 * @param {string | undefined} baseURL - the gateway root to test.
 * @returns {boolean} true when the host belongs to the platform.
 */
export function baseURLMatches(platformId, baseURL) {
	if (platformId === null || typeof baseURL !== 'string' || baseURL === '') return false;
	let host = '';
	try {
		host = new URL(baseURL).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (host === '') return false;
	/** @returns {boolean} whether the host equals the suffix at a label boundary. */
	const at = suffix => host === suffix || host.endsWith(`.${suffix}`);
	if (platformId === 'deepseek-official') return at('deepseek.com');
	if (platformId === 'moonshot') return at('moonshot.cn') || at('moonshot.ai') || at('moonshotapi.com.cn');
	if (platformId === 'zhipu') return at('bigmodel.cn') || at('zhipuai.cn') || at('z.ai');
	if (platformId === 'dashscope') return at('aliyuncs.com') || at('aliyun.com');
	return false;
}

/** @returns {boolean} whether the value is a non-array object. */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns {string | null} a trimmed non-empty string, or null. */
function text(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Normalize one candidate route-table into an entry list.
 *
 * Surfaces vary: an array of profile objects (or bare ids), a plain record of
 * id → profile (`dsh-llm-pi-ai`'s `providers` dict is exactly this), or a Map
 * of the same. Returns `null` when the value names no recognizable shape, so
 * the caller can try the next surface.
 *
 * @param {unknown} value - a candidate route table.
 * @returns {{ id: string, profile: object }[] | string[] | null} entries, or null.
 */
function entriesOf(value) {
	if (Array.isArray(value)) return value;
	if (value instanceof Map) {
		return [...value.entries()].map(([id, profile]) => ({ id, profile: isPlainObject(profile) ? profile : {} }));
	}
	if (isPlainObject(value)) {
		return Object.entries(value).map(([id, profile]) => ({ id, profile: isPlainObject(profile) ? profile : {} }));
	}
	return null;
}

/**
 * Push one entry list onto the routes accumulator, accepting both bare id
 * strings and profile objects whose id lives on the entry or the wrapper.
 *
 * @param {ReturnType<typeof entriesOf>} entries - a normalized entry list.
 * @param {(id: string, baseURL: unknown, apiKeyEnv: unknown) => void} push - sink.
 * @param {string | null} wrapperId - the record/Map key when entries came from one.
 */
function pushEntries(entries, push, wrapperId = null) {
	if (entries === null) return;
	for (const entry of entries) {
		if (typeof entry === 'string') {
			push(entry, null, null);
			continue;
		}
		if (!isPlainObject(entry)) continue;
		const profile = isPlainObject(entry.profile) ? entry.profile : entry;
		const id = profile.id ?? profile.provider ?? profile.route ?? profile.name ?? (entry.profile ? entry.id : null) ?? wrapperId;
		const baseURL = profile.baseURL ?? profile.baseUrl ?? profile.base ?? null;
		const apiKeyEnv = profile.apiKeyEnv ?? profile.credentialRef ?? null;
		push(id, baseURL, apiKeyEnv);
	}
}

/**
 * Read the harness's model routes, tolerating every surface the adapters may
 * or may not expose. Each candidate is wrapped so a throwing getter only
 * removes its own contribution.
 *
 * @param {object | null} llm - the `ctx.llm` service.
 * @returns {{ routeId: string, baseURL: string | null, apiKeyEnv: string | null }[]} routes found.
 */
export function routesFromLlm(llm) {
	if (llm === null || llm === undefined || typeof llm !== 'object') return [];
	const routes = [];

	const push = (routeId, baseURL, apiKeyEnv) => {
		const id = text(routeId);
		if (id === null) return;
		routes.push({ routeId: id, baseURL: text(baseURL), apiKeyEnv: text(apiKeyEnv) });
	};

	// Candidate surfaces, each guarded independently. Both callables and plain
	// records are probed: `dsh-llm-pi-ai` declares its routes as a record of
	// id → profile, while other adapters may expose an array-returning getter.
	// `llm.providers` is read exactly once (getter when present, property
	// otherwise) — probing it twice would double every record-shaped route.
	for (const read of [
		() => (typeof llm.routes === 'function' ? llm.routes() : llm.routes),
		() => (typeof llm.providers === 'function' ? llm.providers() : llm.providers),
		() => llm.providerProfiles,
		() => llm.routeProfiles
	]) {
		try {
			const value = read();
			if (value === undefined || value === null || typeof value === 'function') continue;
			const entries = entriesOf(value);
			// A callable surface returning a record: its keys are the route ids and
			// the values are profiles. Rebuild entry objects carrying the key.
			pushEntries(entries, push);
		} catch {
			// One opaque surface must not hide the others.
		}
	}
	return routes;
}

/**
 * Normalize the config's optional `providers` override array.
 *
 * Every field is optional; unknown platform ids are kept (they declare a
 * platform the registry has no client for — metering only). Malformed entries
 * are dropped rather than rejected, so one bad row cannot blind the panel.
 *
 * @param {unknown} raw - the config's `providers` value.
 * @returns {object[]} normalized override entries.
 */
export function normalizeProviderOverrides(raw) {
	if (!Array.isArray(raw)) return [];
	const overrides = [];
	for (const entry of raw) {
		if (!isPlainObject(entry)) continue;
		const id = text(entry.id);
		if (id === null) continue;
		overrides.push({
			id,
			label: text(entry.label),
			apiKeyEnv: text(entry.apiKeyEnv),
			baseURL: text(entry.baseURL),
			enabled: entry.enabled !== false,
			timeoutMs: typeof entry.timeoutMs === 'number' && Number.isFinite(entry.timeoutMs) ? entry.timeoutMs : null,
			intervalMs:
				typeof entry.intervalMs === 'number' && Number.isFinite(entry.intervalMs) ? entry.intervalMs : null
		});
	}
	return overrides;
}

/**
 * Merge harness routes, observed activity, and config overrides into the
 * platform list the snapshot renders.
 *
 * Merge order per platform: defaults ← matching harness routes (first one's
 * baseURL/credential wins) ← observed activity ← the config override. A
 * platform appears when it is discovered, overridden, or observed — never
 * merely because the registry knows its name.
 *
 * @param {object} deps - merge inputs.
 * @param {{ routeId: string, baseURL: string | null, apiKeyEnv: string | null }[]} deps.routes - harness routes.
 * @param {string[]} deps.observed - provider ids seen carrying traffic in sessions.
 * @param {object[]} deps.overrides - normalized config overrides.
 * @returns {object[]} the platform rows for the snapshot.
 */
export function mergePlatforms({ routes, observed, overrides }) {
	/** platform id → mutable row. */
	const rows = new Map();

	/** @returns {object} an empty row for one platform id. */
	const blank = id => ({
		id,
		label: PLATFORM_LABELS[id] ?? id,
		// Deliberately null: the endpoint comes from a *route* or an override,
		// never silently from the platform default. Pre-filling the default here
		// once shipped a route's credential to the vendor's default host — a
		// credential the route's key was never bound to.
		baseURL: null,
		apiKeyEnv: PLATFORM_CREDENTIAL_REFS[id] ?? null,
		routeIds: [],
		observed: false,
		enabled: true,
		/** Whether (credential, baseURL) is a bound pair safe to send together. */
		baseUrlBound: false,
		// `null` capabilities mean "the registry has no client": metering only.
		capabilities:
			PLATFORM_IDS.includes(id) ?
				{ balance: id !== 'zhipu' && id !== 'dashscope', models: true, usage: id === 'deepseek-official' }
			:	{ balance: false, models: false, usage: false }
	});

	const ensure = id => {
		let row = rows.get(id);
		if (row === undefined) {
			row = blank(id);
			rows.set(id, row);
		}
		return row;
	};

	for (const route of routes) {
		const id = platformForRoute(route.routeId);
		if (id === null) {
			// Unknown route: the generic metering-only group, keyed by the route id.
			const row = ensure(route.routeId);
			row.routeIds.push(route.routeId);
			continue;
		}
		const row = ensure(id);
		row.routeIds.push(route.routeId);
		// The route's own endpoint wins over the platform default — the credential
		// the route names is bound to *its* host, and sending it to the vendor's
		// default domain (or vice versa) would leak it across trust boundaries.
		// A route that names no endpoint leaves the row without one: `index.js`
		// then keeps the card metering-only instead of guessing a host.
		if (route.baseURL !== null) row.baseURL = route.baseURL;
		if (route.apiKeyEnv !== null) row.apiKeyEnv = route.apiKeyEnv;
	}

	for (const observedId of observed) {
		// Observed entries carry *route* ids (`llm/stream` reports the route), so
		// they map through the same platform table the routes use; a route that
		// names no known platform keeps its own metering-only row.
		const row = ensure(platformForRoute(observedId) ?? observedId);
		row.observed = true;
	}

	for (const override of overrides) {
		const row = ensure(override.id);
		if (override.label !== null) row.label = override.label;
		if (override.baseURL !== null) row.baseURL = override.baseURL;
		if (override.apiKeyEnv !== null) row.apiKeyEnv = override.apiKeyEnv;
		if (override.timeoutMs !== null) row.timeoutMs = override.timeoutMs;
		if (override.intervalMs !== null) row.intervalMs = override.intervalMs;
		row.enabled = override.enabled;
	}

	// Last line of defense against cross-host credential leaks: a credential
	// reference is trusted for the host its route (or override) declared. Three
	// cases, judged per row after the merge above:
	//
	// - baseURL matches the platform's own host: inherently bound.
	// - baseURL is a foreign host but a route/override declared it: the pair
	//   (credential, host) is explicit and consistent — bound.
	// - anything else (a baseURL with no declared source): the refresh path
	//   must not guess where this credential belongs; the row degrades to
	//   metering-only (`baseUrlBound: false`, capabilities cleared).
	for (const row of rows.values()) {
		if (row.baseURL === null) {
			row.baseUrlBound = false;
			continue;
		}
		if (baseURLMatches(row.id, row.baseURL)) {
			row.baseUrlBound = true;
			continue;
		}
		const declaredByRoute = row.routeIds.length > 0 || overrides.some(override => override.id === row.id);
		if (declaredByRoute) {
			row.baseUrlBound = true;
		} else {
			row.baseUrlBound = false;
			row.capabilities = { balance: false, models: false, usage: false };
		}
	}

	// A platform without a registry client and without activity is noise: drop it.
	for (const [id, row] of [...rows]) {
		if (!PLATFORM_IDS.includes(id) && !row.observed) rows.delete(id);
	}

	// Drop disabled platforms entirely — an override's `enabled: false` hides a card.
	for (const [id, row] of [...rows]) {
		if (row.enabled === false) rows.delete(id);
	}

	return [...rows.values()].sort((left, right) => {
		if (left.observed !== right.observed) return left.observed ? -1 : 1;
		if (left.id === 'deepseek-official') return -1;
		if (right.id === 'deepseek-official') return 1;
		return left.label.localeCompare(right.label);
	});
}

/**
 * Find the platform row a custom gateway baseURL belongs to.
 *
 * @param {string} baseURL - the gateway root.
 * @param {object[]} rows - merged platform rows.
 * @returns {string | null} the platform id, or null for the generic group.
 */
export function platformForBaseURL(baseURL, rows) {
	for (const row of rows) {
		if (baseURLMatches(row.id, baseURL)) return row.id;
	}
	return null;
}
