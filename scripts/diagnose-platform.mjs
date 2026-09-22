/**
 * Diagnostic: fetch raw shapes from the DeepSeek platform console.
 *
 * Usage (PowerShell):
 *   $env:DEEPSEEK_PLATFORM_TOKEN = "<paste the Local Storage userToken value>"
 *   node scripts/diagnose-platform.mjs
 *
 * What it does:
 *  - calls the three console endpoints with the real token
 *  - prints the FULL nesting tree of each response: every key, its type, and
 *    (for scalars) a short preview — so we can see exactly where the figures live
 *  - never writes the token or the response to disk; stdout only
 *
 * Sensitive values are truncated; the token itself is never printed.
 */

const BASE = process.env.DEEPSEEK_PLATFORM_BASE_URL || 'https://platform.deepseek.com';
const token = process.env.DEEPSEEK_PLATFORM_TOKEN;

if (!token) {
  console.error('Set DEEPSEEK_PLATFORM_TOKEN to run this diagnostic.');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function bareToken(value) {
  const trimmed = String(value).trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      return String(parsed.value ?? parsed.token ?? parsed.accessToken ?? trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** Print a value's tree, redacting long strings. */
function tree(value, indent = '  ', depth = 0) {
  if (depth > 6) return `${indent}…(max depth)`;
  if (value === null) return `${indent}null`;
  if (Array.isArray(value)) {
    const lines = [`${indent}array(${value.length})`];
    if (value.length > 0) lines.push(tree(value[0], indent + '  ', depth + 1));
    return lines.join('\n');
  }
  if (typeof value === 'object') {
    const lines = [];
    for (const [key, child] of Object.entries(value)) {
      if (child !== null && typeof child === 'object') {
        lines.push(`${indent}${key}:`);
        lines.push(tree(child, indent + '  ', depth + 1));
      } else {
        const preview = typeof child === 'string' && child.length > 80 ? `${child.slice(0, 80)}…(${child.length})` : String(child);
        lines.push(`${indent}${key}: ${typeof child} = ${preview}`);
      }
    }
    return lines.join('\n');
  }
  return `${indent}${typeof value} = ${String(value).slice(0, 80)}`;
}

async function raw(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${bareToken(token)}`,
      'user-agent': UA,
      'x-client-platform': 'web',
      'x-app-version': '1.0.0',
    },
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, parsed };
}

async function probe(label, url) {
  console.log(`\n=== ${label} ===`);
  console.log(`url: ${url}`);
  try {
    const { status, parsed } = await raw(url);
    console.log(`status: ${status}`);
    console.log('tree:');
    console.log(tree(parsed));
  } catch (error) {
    console.log(`error: ${String(error?.message ?? error)}`);
  }
}

async function main() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const query = `year=${year}&month=${month}`;

  console.log(`Console root : ${BASE}`);
  console.log(`Month        : ${year}-${String(month).padStart(2, '0')}`);
  console.log(`Token length : ${bareToken(token).length}`);

  await probe('/api/v0/users/get_user_summary', `${BASE}/api/v0/users/get_user_summary`);
  await probe('/api/v0/usage/amount', `${BASE}/api/v0/usage/amount?${query}`);
  await probe('/api/v0/usage/cost', `${BASE}/api/v0/usage/cost?${query}`);
}

main();
