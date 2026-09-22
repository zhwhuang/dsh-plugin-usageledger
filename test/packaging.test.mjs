/**
 * Packaging contract: the manifest, the bundle patch, and the promise that the
 * plugin ships a view rather than an accounting of its own.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
const clientBundle = await readFile(new URL('lib/client.js', root), 'utf8');
const hostBundle = await readFile(new URL('lib/index.js', root), 'utf8');

test('the manifest declares one host entry and one browser entry', () => {
  assert.equal(manifest.name, 'dsh-plugin-apicost');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, 'lib/index.js');
  assert.equal(manifest.exports['.'].default, './lib/index.js');
  assert.equal(manifest.exports['./client'].default, './lib/client.js');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(
    manifest.dsh.client.inject,
    ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'],
    'the browser half needs the seat packages it renders into',
  );
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'the plugin has no runtime dependencies');
});

test('the bundle patch mounts the plugin with the documented defaults', () => {
  assert.match(patch, /id: apicost/u);
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'the patch names the package it mounts');
  for (const key of ['apiKeyEnv: DEEPSEEK_API_KEY', 'consoleTokenEnv: DEEPSEEK_PLATFORM_TOKEN', 'trackProviders:', 'api:', 'platform:']) {
    assert.ok(patch.includes(key), `missing patch key ${key}`);
  }
  assert.ok(patch.includes('https://api.deepseek.com'), 'the patch documents the open API root');
  assert.ok(patch.includes('https://platform.deepseek.com'), 'and the console root');
});

test('the plugin owns no state file and ships no accumulator', () => {
  assert.equal(/stateDir|historyDays|persistDebounceMs/u.test(JSON.stringify(manifest)), false, 'no persistence settings remain');
  assert.equal(/stateDir|apicost-state/u.test(patch), false, 'the patch no longer mentions a state directory');
  assert.equal(/writeFile|mkdir|createWriteStream|node:fs|node:path/u.test(hostBundle), false, 'the host imports no filesystem writer');
  assert.ok(hostBundle.includes("ctx.on?.('llm/stream'"), 'the only harness event it observes is the stream, for the model label');
  assert.ok(hostBundle.includes("ctx.on?.('llm/stream', trackStream, { global: true })"), 'and it must be a global waterfall hook');
});

test('the browser bundle carries the v9 Apple compact design and no external asset', () => {
  for (const token of ['--surface:#ffffff', '--ink:#1d1d1f', '--accent:#0a84ff', '--font:-apple-system', '--mono:ui-monospace']) {
    assert.ok(clientBundle.includes(token), `missing design token ${token}`);
  }
  for (const rule of ['.apx-row{', '.apx-book{', '.apx-mast{', '.apx-metrics{', '.apx-card{', '.apx-switch{', '.apx-plot{', '.apx-chip{', '.apx-connect{', '.apx-input{', '.apx-scope{', '.apx-pill{', '.apx-icon-btn{', '.apx-mast-bar{']) {
    assert.ok(clientBundle.includes(rule), `missing rule ${rule}`);
  }
  assert.ok(clientBundle.includes('body[data-ds-dark-theme] .apx'), 'the dark mapping keys off the product attribute');
  assert.ok(clientBundle.includes('prefers-reduced-motion'), 'motion must be optional');
  assert.ok(clientBundle.includes('document.createElement("style")'), 'the bundle injects its own stylesheet');
  const urls = clientBundle.match(/https?:\/\/[a-z0-9.-]+/giu) ?? [];
  const allowed = urls.every((url) => url.startsWith('https://platform.deepseek.com') || url.startsWith('https://api.deepseek.com'));
  assert.equal(allowed, true, `unexpected external URL in the bundle: ${urls.filter((url) => !url.startsWith('https://platform.deepseek.com') && !url.startsWith('https://api.deepseek.com'))}`);
});

test('the session source reads the harness meter without joining the dependency graph', async () => {
  const sessionBundle = await readFile(new URL('lib/session-usage.js', root), 'utf8');
  // It must reach the official packages only through optional context services:
  // an out-of-tree plugin cannot resolve the harness's own modules.
  assert.equal(/^import\s/mu.test(sessionBundle.replace(/^import[^;]+from '\.\/[^']+';$/gmu, '')), false, 'the host half imports nothing but its own modules');
  assert.ok(sessionBundle.includes("serviceOf(ctx, 'sessionProjections')"), 'the projection registry is resolved lazily');
  assert.ok(sessionBundle.includes("serviceOf(ctx, 'sessions')"), 'as is the session store');
  assert.ok(sessionBundle.includes("serviceOf(ctx, 'tokenMeter')"), 'as is the token meter');
  assert.ok(sessionBundle.includes("TOKEN_USAGE_KEY = 'tokenUsage'"), 'the official projection key');
  // The billing convention must be the official one, not a second arithmetic.
  assert.ok(sessionBundle.includes('uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens'), 'the three prompt-side buckets are summed');
  assert.ok(sessionBundle.includes('billedInputTokens'), 'and named as the official helper names it');
});

test('the browser half talks only to the plugin routes', () => {
  for (const path of ['/api/apicost/snapshot', '/api/apicost/events', '/api/apicost/refresh', '/api/apicost/console-token']) {
    assert.ok(clientBundle.includes(path), `missing client path ${path}`);
  }
  assert.equal(clientBundle.includes('sk-'), true, 'the copy warns about API keys, but the bundle never holds one');
  assert.equal(/Bearer/u.test(clientBundle), false, 'the browser never sends a credential of its own');
});
