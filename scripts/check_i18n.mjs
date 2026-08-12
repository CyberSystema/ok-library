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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'apps/web/src/i18n.tsx'), 'utf8');

// Every locale dictionary is a top-level `const <lang> = { 'a.b': '…', … }`.
// Counting occurrences per key is enough: each dict declares a key at most once
// (a duplicate would be a TS error), so a key present in all four appears 4×.
//
// `-` is IN the character class. Without it this regex could not see a key whose
// name contains a hyphen, and three of them exist: the course chapter labels
// `course.chapter.what-a-catalogue-is-for`, `.copies-and-shelves` and
// `.daily-work`, whose ids come from the Handbook's chapter slugs. The file holds
// 1,080 keys per locale and this saw 1,077 — so any of those three could be
// dropped from a locale and the check still printed "no drift", which is exactly
// the omission it exists to catch. Verified by deleting the Greek `daily-work`:
// green before, drift after.
const keyLines = [...src.matchAll(/^ {2}'([a-zA-Z0-9_.-]+)':/gm)].map((m) => m[1]);
const counts = new Map();
for (const k of keyLines) counts.set(k, (counts.get(k) ?? 0) + 1);

const LOCALES = 4;
const drift = [...counts.entries()].filter(([, n]) => n !== LOCALES);

// Keys the app asks for. Discovered by walking the whole source tree rather than
// from a hand-kept list: that list named three files, so every screen under
// `screens/` — four of them by the time this was noticed — referenced keys that
// nothing checked, and a missing one renders as the raw dotted key on screen.
// The same blind spot the accessibility section of the gate had.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const consumers = walk(join(root, 'apps/web/src'));
// The negative lookbehind avoids matching `.t('…')` or any other method call
// that merely ends in `t`. The character class carries the hyphen for the same
// reason the one above does: without it a reference to a hyphenated key that
// exists in NO locale could not be flagged either, so the blind spot ran both
// ways.
const referenced = new Set();
for (const abs of consumers) {
  const text = readFileSync(abs, 'utf8');
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.])t\('([a-zA-Z0-9_.-]+)'/g)) referenced.add(m[1]);
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
console.log(`✓ i18n: ${counts.size} keys × ${LOCALES} locales, no drift; ${referenced.size} referenced keys all defined across ${consumers.length} files.`);
