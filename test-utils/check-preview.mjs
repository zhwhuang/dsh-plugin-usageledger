/**
 * Structural linter for the design review sheet.
 *
 * Run with `node test-utils/check-preview.mjs`. It catches the failure modes a
 * hand-written HTML/CSS sheet actually suffers from: unbalanced markup, a
 * stylesheet that does not close, script hooks pointing at ids that do not
 * exist, and annotations whose callout number has no legend entry.
 */

import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../preview/ui-preview.html', import.meta.url), 'utf8');
const failures = [];
const notes = [];

/* ── stylesheet ─────────────────────────────────────────────────────── */
const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
if (style === undefined) {
  failures.push('no <style> block');
} else {
  let depth = 0;
  for (const character of style) {
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    if (depth < 0) {
      failures.push('stylesheet closes a block that was never opened');
      break;
    }
  }
  if (depth !== 0) failures.push(`stylesheet leaves ${depth} block(s) open`);
  notes.push(`stylesheet: ${style.split('\n').length} lines, ${(style.length / 1024).toFixed(1)} KB`);
}

/* ── markup balance ─────────────────────────────────────────────────── */
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1] ?? '';
for (const tag of ['div', 'section', 'button', 'span', 'ol', 'ul', 'li', 'dl', 'dt', 'dd', 'header', 'p', 'table', 'svg', 'style', 'script']) {
  const open = (body.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
  const close = (body.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
  // <li> and <p> may legally omit their closing tag, but the sheet always writes them.
  if (open !== close) failures.push(`<${tag}> unbalanced: ${open} open / ${close} close`);
}

/* ── script hooks ───────────────────────────────────────────────────── */
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
for (const [, id] of script.matchAll(/getElementById\("([^"]+)"\)/g)) {
  if (!ids.has(id)) failures.push(`script references #${id}, which does not exist`);
}
const selectors = [...script.matchAll(/querySelector(?:All)?\("([^"]+)"\)/g)].map((match) => match[1]);
for (const selector of selectors) {
  const token = selector.replace(/^:scope > /u, '').replace(/^\./u, '').split(/[\s,[:]/u)[0];
  if (token !== '' && !style?.includes(`.${token}`)) failures.push(`script selects "${selector}", but .${token} has no rule`);
}

/* ── annotation callouts must all be explained ──────────────────────── */
const tagsBySection = new Map();
let section = 'none';
for (const line of body.split('\n')) {
  const heading = line.match(/class="block-t">([^<]+)</u);
  if (heading !== null) section = heading[1];
  for (const [, number] of line.matchAll(/class="tag"[^>]*>(\d+)</g)) {
    tagsBySection.set(section, (tagsBySection.get(section) ?? new Set()).add(number));
  }
}
const legendNumbers = new Set([...body.matchAll(/class="n">(\d+)</g)].map((match) => match[1]));
for (const [name, numbers] of tagsBySection) {
  for (const number of numbers) {
    if (!legendNumbers.has(number)) failures.push(`section "${name}": callout ${number} has no legend entry`);
  }
}
notes.push(`annotated callouts: ${[...tagsBySection].map(([name, numbers]) => `${name}=${numbers.size}`).join(', ') || 'none'}`);

/* ── external deps should be fonts only, plus the one real outbound link ── */
// The sheet must not depend on anything it does not ship. The single allowed
// exception is the 去充值 anchor the plugin itself renders, which points at the
// official top-up page exactly like the platform's own usage board does.
const ALLOWED_LINKS = /^https:\/\/platform\.deepseek\.com\//u;
for (const [, url] of html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)) {
  if (/fonts\.(googleapis|gstatic)\.com/u.test(url)) continue;
  if (ALLOWED_LINKS.test(url)) continue;
  failures.push(`unexpected external dependency: ${url}`);
}
for (const [, url] of html.matchAll(/(?:src|srcset)="(https?:\/\/[^"]+)"/g)) {
  if (!/fonts\.(googleapis|gstatic)\.com/u.test(url)) failures.push(`unexpected external asset: ${url}`);
}

/* ── report ─────────────────────────────────────────────────────────── */
for (const note of notes) console.log('·', note);
if (failures.length > 0) {
  for (const failure of failures) console.error('✗', failure);
  process.exitCode = 1;
} else {
  console.log('✓ preview sheet is structurally sound');
}
