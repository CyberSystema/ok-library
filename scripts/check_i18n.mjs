#!/usr/bin/env node
/**
 * Four-locale parity for apps/web/src/i18n.tsx.
 *
 * 785 keys × 4 locales currently hold zero drift with nothing checking. That is
 * luck, not a guarantee: `makeT` falls back to English when a key is missing, so
 * an omitted Greek string renders in English and looks like a translation
 * nobody got round to rather than a bug. The first omission would ship green.
 *
 * Also catches the opposite failure — a key referenced by the app that exists in
 * no locale at all, which renders as the raw dotted key on screen. One of those
 * (`common.remove`) shipped during the WCAG pass and was only caught by hand.
 *
 * Exits non-zero on any problem so CI fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'apps/web/src/i18n.tsx'), 'utf8');

// Every locale dictionary is a top-level `const <lang> = { 'a.b': '…', … }`.
// Counting occurrences per key is enough: each dict declares a key at most once
// (a duplicate would be a TS error), so a key present in all four appears 4×.
const keyLines = [...src.matchAll(/^ {2}'([a-zA-Z0-9_.]+)':/gm)].map((m) => m[1]);
const counts = new Map();
for (const k of keyLines) counts.set(k, (counts.get(k) ?? 0) + 1);

const LOCALES = 4;
const drift = [...counts.entries()].filter(([, n]) => n !== LOCALES);

// Keys the app asks for. The negative lookbehind avoids matching `.t('…')` or
// any other method call that merely ends in `t`.
const consumers = ['apps/web/src/main.tsx', 'apps/web/src/ui.tsx', 'apps/web/src/onboarding.tsx'];
const referenced = new Set();
for (const rel of consumers) {
  let text;
  try {
    text = readFileSync(join(root, rel), 'utf8');
  } catch {
    continue;
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.])t\('([a-zA-Z0-9_.]+)'/g)) referenced.add(m[1]);
}
// Template keys like t(`status.${x}`) cannot be resolved statically; they are
// not checked here rather than guessed at.
const undefinedKeys = [...referenced].filter((k) => !counts.has(k)).sort();

let failed = false;
if (drift.length) {
  failed = true;
  console.error(`\n✗ ${drift.length} key(s) are not present in all ${LOCALES} locales:`);
  for (const [k, n] of drift.slice(0, 40)) console.error(`    ${k}  (found ${n}×)`);
  if (drift.length > 40) console.error(`    …and ${drift.length - 40} more`);
}
if (undefinedKeys.length) {
  failed = true;
  console.error(`\n✗ ${undefinedKeys.length} key(s) are used by the app but defined nowhere:`);
  for (const k of undefinedKeys.slice(0, 40)) console.error(`    ${k}`);
}

if (failed) process.exit(1);
console.log(`✓ i18n: ${counts.size} keys × ${LOCALES} locales, no drift; ${referenced.size} referenced keys all defined.`);
