/**
 * Browser-facing transport for UsageLedger.
 *
 * Four exact routes are registered on the harness web server:
 *
 * ```text
 * GET  /api/usageledger/snapshot        one JSON snapshot
 * GET  /api/usageledger/events          Server-Sent Events feed (snapshot per change)
 * POST /api/usageledger/refresh         force a refresh, then answer a snapshot
 * POST /api/usageledger/console-token   store the console token, then answer a snapshot
 * ```
 *
 * The response never contains credential material: the snapshot carries the key
 * fingerprint and the layer it resolved from, and nothing else.
 *
 * Access is gated twice. When the harness exposes a `connection` service its own
 * `requestRejection` verdict is reused (the same seam the shipped API routes
 * use); otherwise the request must originate from the loopback interface unless
 * `config.allowRemote` is set.
 *
 * @module dsh-plugin-usageledger/routes
 */

/** Path prefix shared by every route. */
export const ROUTE_PREFIX = '/api/usageledger';

/** Routes registered on the web server. */
export const ROUTE_PATHS = {
	snapshot: `${ROUTE_PREFIX}/snapshot`,
	events: `${ROUTE_PREFIX}/events`,
	refresh: `${ROUTE_PREFIX}/refresh`,
	consoleToken: `${ROUTE_PREFIX}/console-token`
};

/** Largest accepted request body. */
const MAX_BODY_BYTES = 4096;

/** SSE frames are coalesced to at most one per this window. */
const SSE_COALESCE_MS = 200;

/** @returns {boolean} whether an address literal is loopback. */
export function isLoopbackAddress(address) {
	if (typeof address !== 'string') return false;
	const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
	return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

/**
 * Build the request gate for the routes.
 *
 * The `connection` service is looked up per request rather than once at load
 * time: plugin rows are composed in an arbitrary order, so capturing the service
 * during `apply` would silently downgrade the harness's own authentication to
 * the loopback fallback whenever this plugin happens to load first.
 *
 * @param {object} params - gate inputs.
 * @param {object} params.ctx - host cordis context.
 * @param {object} params.config - resolved configuration.
 * @returns {(req: object) => number | undefined} rejection status, or undefined to accept.
 */
export function createGate({ ctx, config }) {
	let connection;
	return req => {
		if (connection === undefined && typeof ctx?.get === 'function') connection = ctx.get('connection');
		if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
			try {
				return connection.requestRejection(req);
			} catch {
				return 503;
			}
		}
		if (config.allowRemote) return undefined;
		return isLoopbackAddress(req?.socket?.remoteAddress) ? undefined : 403;
	};
}

/** Write one JSON response. */
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload),
		...headers
	});
	res.end(payload);
}

/** Answer 405 with the allowed method set. */
function methodNotAllowed(res, allow) {
	writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `allowed: ${allow}` } }, { allow });
}

/** Read a small JSON body; an empty body is an empty object. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	await new Promise((resolve, reject) => {
		req.on('data', chunk => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(Object.assign(new Error('request body is too large'), { code: 'TOO_LARGE' }));
				req.destroy?.();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', resolve);
		req.on('error', reject);
		req.on('aborted', () => {
			reject(Object.assign(new Error('request aborted'), { code: 'ABORTED' }));
		});
	});
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (text === '') return {};
	const parsed = JSON.parse(text);
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw Object.assign(new Error('body must be an object'), { code: 'INVALID' });
	}
	return parsed;
}

/**
 * Create the SSE fan-out.
 *
 * @param {object} params - hub inputs.
 * @param {() => object} params.buildPayload - produces the frame body.
 * @param {number} params.maxClients - concurrent connection cap.
 * @param {number} params.heartbeatMs - heartbeat interval.
 * @param {{ warn: Function }} [params.logger] - host logger.
 * @returns {{ handleEventStream: Function, publish: () => void, close: () => void, clients: () => number }} hub.
 */
export function createSseHub({ buildPayload, maxClients, heartbeatMs, logger }) {
	const clients = new Set();
	let timer = null;

	function writeTo(client) {
		try {
			client.res.write(`data: ${JSON.stringify(buildPayload())}\n\n`);
		} catch (error) {
			logger?.warn?.(`usageledger: SSE write failed: ${String(error?.message ?? error)}`);
			drop(client);
		}
	}

	function drop(client) {
		clients.delete(client);
		clearInterval(client.heartbeat);
	}

	function broadcast() {
		for (const client of [...clients]) writeTo(client);
	}

	return {
		handleEventStream(req, res) {
			if (clients.size >= maxClients) {
				writeJson(res, 503, {
					ok: false,
					error: { code: 'TOO_MANY_CLIENTS', message: `at most ${maxClients} event streams are supported` }
				});
				return;
			}
			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store, no-transform',
				connection: 'keep-alive',
				'x-accel-buffering': 'no'
			});
			res.write('retry: 3000\n\n');
			const client = { res, heartbeat: null };
			clients.add(client);
			client.heartbeat = setInterval(() => {
				try {
					res.write(': ping\n\n');
				} catch {
					drop(client);
				}
			}, heartbeatMs);
			client.heartbeat.unref?.();
			const cleanup = () => drop(client);
			req.on?.('close', cleanup);
			req.on?.('error', cleanup);
			res.on?.('close', cleanup);
			res.on?.('error', cleanup);
			writeTo(client);
		},
		publish() {
			if (timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				broadcast();
			}, SSE_COALESCE_MS);
			timer.unref?.();
		},
		close() {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			for (const client of [...clients]) {
				try {
					client.res.end();
				} catch {
					// The socket is already gone; dropping the record is enough.
				}
				drop(client);
			}
		},
		clients: () => clients.size
	};
}

/**
 * Create the four route handlers.
 *
 * @param {object} params - route inputs.
 * @param {() => object} params.buildSnapshot - current snapshot.
 * @param {(options?: object) => Promise<object>} params.refreshAll - force refresh, then answer a snapshot.
 * @param {(token: string | null) => Promise<object>} params.setConsoleToken - store or clear the console token.
 * @param {object} params.hub - SSE hub.
 * @param {(req: object) => number | undefined} params.gate - request gate.
 * @param {{ warn: Function }} [params.logger] - host logger.
 * @returns {Record<string, (req: object, res: object) => Promise<void>>} handlers keyed by route name.
 */
export function createRoutes({ buildSnapshot, refreshAll, setConsoleToken, hub, gate, logger }) {
	/** Run one gated request. */
	async function guarded(req, res, run) {
		const rejection = gate(req);
		if (rejection !== undefined) {
			writeJson(res, rejection, {
				ok: false,
				error: {
					code:
						rejection === 503 ? 'AUTHENTICATION_UNAVAILABLE'
						: rejection === 401 ? 'UNAUTHORIZED'
						: 'FORBIDDEN',
					message: 'the request was rejected by the harness connection gate'
				}
			});
			return;
		}
		try {
			await run();
		} catch (error) {
			logger?.warn?.(`usageledger: route failed: ${String(error?.message ?? error)}`);
			if (!res.headersSent)
				writeJson(res, 500, {
					ok: false,
					error: { code: 'INTERNAL', message: String(error?.message ?? error) }
				});
			else res.end();
		}
	}

	return {
		async snapshot(req, res) {
			await guarded(req, res, async () => {
				if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
				writeJson(res, 200, { ok: true, snapshot: buildSnapshot() });
			});
		},

		async events(req, res) {
			await guarded(req, res, async () => {
				if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
				hub.handleEventStream(req, res);
			});
		},

		async refresh(req, res) {
			await guarded(req, res, async () => {
				if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
				await refreshAll({ force: true });
				writeJson(res, 200, { ok: true, snapshot: buildSnapshot() });
			});
		},

		/**
		 * Store or clear the platform console token. The body carries it once, the
		 * host hands it to the credential store, and the response reports only
		 * whether it is now configured — the token is never echoed back.
		 */
		async consoleToken(req, res) {
			await guarded(req, res, async () => {
				if (req.method !== 'POST' && req.method !== 'DELETE') return methodNotAllowed(res, 'POST, DELETE');
				if (req.method === 'DELETE') {
					const result = await setConsoleToken(null);
					writeJson(res, 200, { ok: true, snapshot: buildSnapshot(), result });
					return;
				}
				const body = await readJsonBody(req).catch(error => {
					writeJson(res, error?.code === 'TOO_LARGE' ? 413 : 400, {
						ok: false,
						error: { code: 'INVALID_BODY', message: String(error?.message ?? error) }
					});
					return null;
				});
				if (body === null) return undefined;
				// Deleting the stored token is destructive, so it requires explicit
				// intent: a DELETE method, or a body carrying an explicit `token: null`
				// (JSON `null`). A POST whose body merely *lacks* `token` is a malformed
				// save, not a clear request — treating it as one silently wiped a
				// working credential while answering 400 "INVALID_TOKEN".
				if (body.token === undefined) {
					return writeJson(res, 400, {
						ok: false,
						error: { code: 'INVALID_BODY', message: 'missing "token"' }
					});
				}
				if (body.token === null) {
					const cleared = await setConsoleToken(null);
					return writeJson(res, 200, { ok: true, snapshot: buildSnapshot(), result: cleared });
				}
				const result = await setConsoleToken(typeof body.token === 'string' ? body.token : null);
				if (result.configured !== true) {
					return writeJson(res, 400, {
						ok: false,
						error: {
							code: result.code ?? 'INVALID_TOKEN',
							message: result.message ?? 'the console token was rejected'
						}
					});
				}
				writeJson(res, 200, { ok: true, snapshot: buildSnapshot(), result });
			});
		}
	};
}
