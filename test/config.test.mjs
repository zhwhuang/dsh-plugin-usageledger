/**
 * Configuration helpers: console-token normalization and shape checks.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { looksLikeConsoleToken, normalizeConsoleToken } from '../lib/config.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.console-session-token';

test('normalizeConsoleToken accepts a bare JWT unchanged', () => {
  assert.equal(normalizeConsoleToken(JWT), JWT);
  assert.equal(normalizeConsoleToken('  ' + JWT + '  '), JWT);
});

test('normalizeConsoleToken extracts the inner value from a JSON envelope', () => {
  // DeepSeek stores userToken in Local Storage as a JSON object; a direct copy
  // of the "Value" is this whole string, not the bare JWT.
  const envelope = JSON.stringify({ value: JWT, expiresAt: 9999999999 });
  assert.equal(normalizeConsoleToken(envelope), JWT);
  assert.equal(normalizeConsoleToken('  ' + envelope + '  '), JWT);
});

test('normalizeConsoleToken tolerates other envelope keys', () => {
  assert.equal(normalizeConsoleToken(JSON.stringify({ token: JWT })), JWT);
  assert.equal(normalizeConsoleToken(JSON.stringify({ accessToken: JWT })), JWT);
});

test('normalizeConsoleToken leaves a non-JSON, non-token string untouched', () => {
  assert.equal(normalizeConsoleToken('not-a-token'), 'not-a-token');
});

test('looksLikeConsoleToken rejects an API key and a JSON envelope', () => {
  assert.equal(looksLikeConsoleToken('sk-live-secret-value-123456'), false);
  assert.equal(looksLikeConsoleToken(JSON.stringify({ value: JWT })), false, 'the raw envelope must be rejected before normalization');
  assert.equal(looksLikeConsoleToken(JWT), true);
});
