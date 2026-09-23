/**
 * Host half of dsh-plugin-usageledger.
 *
 * The declarations are structural on purpose: an out-of-tree plugin installed
 * into a dsh profile cannot resolve the harness's own packages for type
 * checking, so nothing here imports `@deepseek-ai/cordis`.
 */

/** The slice of the host cordis context this plugin uses. */
export interface HostContext {
	/** Resolve an optional service (`credentials`, `webServer`, `connection`). */
	get(name: string): unknown;
	/** Subscribe to a cordis event; returns a disposer. */
	on?(
		event: string,
		listener: (...args: never[]) => unknown,
		options?: { global?: boolean; prepend?: boolean }
	): (() => boolean) | undefined;
	/** Run `callback` for the lifetime of the plugin; its return value is the disposer. */
	effect?(callback: () => (() => void) | undefined | void, label?: string): unknown;
	/** Run `callback` once every named service is available. */
	inject?(deps: string[], callback: (scope: HostContext) => void): unknown;
	/** Named logger factory. */
	logger?(name: string): { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/** One endpoint group's settings. */
export interface SourceConfig {
	enabled?: boolean;
	/** Root without a trailing slash. */
	baseURL?: string;
	/** Refresh cadence in milliseconds. */
	intervalMs?: number;
	/** Floor between two on-demand refreshes. */
	minRefreshMs?: number;
	/** Per-request timeout. */
	timeoutMs?: number;
}

/** Loader-row configuration; every field is optional. */
export interface Config {
	/** Credential reference holding the DeepSeek API key. Default `DEEPSEEK_API_KEY`. */
	apiKeyEnv?: string;
	/** Credential reference holding the platform console token. Default `DEEPSEEK_PLATFORM_TOKEN`. */
	consoleTokenEnv?: string;
	/** Provider routes whose in-flight model the seat follows. Default `['deepseek-official']`. */
	trackProviders?: string[];
	/** Follow every provider route, not only `trackProviders`. Default `false`. */
	trackAllProviders?: boolean;
	/** Open API (`api.deepseek.com`): balance and model list. */
	api?: SourceConfig;
	/** Platform console (`platform.deepseek.com`): account usage totals and daily series. */
	platform?: SourceConfig;
	/** SSE heartbeat interval. Default `15000`. */
	heartbeatMs?: number;
	/** Concurrent SSE client cap. Default `8`. */
	maxSseClients?: number;
	/** Allow a non-loopback browser origin to read the snapshot. Default `false`. */
	allowRemote?: boolean;
	/**
	 * Optional per-platform overrides over the discovered list. Billing cards
	 * follow the harness's model routes without any configuration; an entry
	 * only renames, disables, or re-points a platform discovery found (or
	 * declares one it did not).
	 */
	providers?: ProviderOverride[];
}

/** One optional per-platform override row. Every field is optional. */
export interface ProviderOverride {
	/** Platform id (`deepseek-official`, `moonshot`, `zhipu`, `dashscope`, …) or a route id. */
	id: string;
	/** Card display name. */
	label?: string;
	/** Credential reference holding the platform API key. */
	apiKeyEnv?: string;
	/** Endpoint root; overrides the route's own baseURL. */
	baseURL?: string;
	/** `false` hides the card entirely. */
	enabled?: boolean;
	/** Per-request timeout override. */
	timeoutMs?: number;
	/** Refresh cadence override. */
	intervalMs?: number;
}

/** One currency view of the account balance. */
export interface BalanceInfo {
	currency: string | null;
	totalBalance: number | null;
	grantedBalance: number | null;
	toppedUpBalance: number | null;
}

/** One model id the key may call. */
export interface ModelInfo {
	id: string;
	ownedBy: string | null;
}

/** One day of the console's usage series. */
export interface UsageDay {
	day: string;
	calls: number;
	tokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
	outputTokens: number;
	cost: number | null;
}

/** The console's normalized usage window. */
export interface Usage {
	month: string;
	allTimeTokens: number | null;
	monthlyTokens: number | null;
	remainingTokens: number | null;
	allTimeCost: number | null;
	currency: string | null;
	window: { month: string; cost: number | null; calls: number; tokens: number; days: number } | null;
	days: UsageDay[];
	models: object[];
	complete: Record<string, boolean>;
	rows: { amount: number; cost: number };
}

/** One discovered platform's billing-card facts. */
export interface PlatformFacts {
	id: string;
	label: string;
	baseURL: string | null;
	apiKeyEnv: string | null;
	/** Whether a session was seen carrying traffic through this platform. */
	observed: boolean;
	routeIds: string[];
	capabilities: { balance: boolean; models: boolean; usage: boolean };
	updatedAt: number | null;
	error: { code: string; message: string } | null;
	balance: object | null;
	models: ModelInfo[];
}

/** The in-memory snapshot the browser half renders. */
export interface Snapshot {
	revision: number;
	generatedAt: number;
	api: {
		baseURL: string;
		updatedAt: number | null;
		error: { code: string; message: string } | null;
		balance: object | null;
		preferred: BalanceInfo | null;
		models: ModelInfo[];
	};
	console: {
		baseURL: string;
		updatedAt: number | null;
		month: string;
		error: { code: string; message: string } | null;
		usage: Usage | null;
	};
	/** One entry per discovered platform; the detail window renders one card per entry. */
	platforms: PlatformFacts[];
	credentials: Record<
		'apiKey' | 'consoleToken',
		{ configured: boolean; source: string | null; writable: boolean; ref: string }
	>;
	currentModel: { model: string | null; provider: string | null; streaming: boolean; at: number } | null;
	live: { streaming: boolean; model: string | null; provider: string | null };
}

/** Plugin name shown by the loader. */
export declare const name: 'usageledger';

/** No required cordis services. */
export declare const inject: string[];

/**
 * Mount the host half: read the balance and model list from the open API, read
 * the account's usage from the platform console, and serve `/api/usageledger/*`.
 * Nothing is written to disk.
 */
export declare function apply(ctx: HostContext, config?: Config): void;

export default apply;
