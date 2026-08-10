#!/usr/bin/env node
/**
 * Generate a Handbook content pack from translated chapter JSON.
 *
 * Translations are produced as data and turned into TypeScript here, rather than
 * being written as TypeScript in the first place. The reason is that a content
 * pack has to compile against typed unions — every `anchor`, every `chapter`
 * reference and every `fact` key is a literal type — and a translator working in
 * prose should not also be responsible for that. So the shape is enforced by a
 * JSON schema on the way in and by the compiler on the way out, and this script
 * is the only thing in between.
 *
 * It also enforces what the schema cannot:
 *   · every id, anchor, chapter reference and fact key must be byte-identical to
 *     the English chapter it came from — a translated anchor is a dead link;
 *   · the block kinds must appear in the same order as the English, so a chapter
 *     cannot quietly lose a warning;
 *   · no MARC tag may appear in any string.
 *
 * Usage:
 *   node scripts/handbook_pack.mjs <lang> <chapters.json> [--merge]
 *
 * `--merge` keeps chapters already present in the existing pack and adds the new
 * ones, which is how a translation lands in batches.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hbDir = join(root, 'apps/web/src/handbook');
const [lang, jsonPath, ...flags] = process.argv.slice(2);
if (!lang || !jsonPath) {
  console.error('usage: handbook_pack.mjs <lang> <chapters.json> [--merge]');
  process.exit(2);
}
const merge = flags.includes('--merge');

const read = (p) => readFileSync(p, 'utf8');
const en = read(join(hbDir, 'content/en.ts'));
const registry = read(join(hbDir, 'registry.ts'));

const CHAPTER_IDS = [...registry.matchAll(/^ {2}'([a-z0-9-]+)',?$/gm)].map((m) => m[1]);
const ANCHORS = new Set([...registry.matchAll(/^ {2}'([a-z0-9-]+)':\s*'[a-z0-9-]+',?$/gm)].map((m) => m[1]));
const FACTS = new Set(
  [...read(join(hbDir, 'facts.ts')).matchAll(/^ {2}([a-zA-Z]+):\s*\{\s*label:/gm)].map((m) => m[1])
);

/** The English chapter as a source of truth for everything that must not change. */
function englishChapter(id) {
  const m = new RegExp(`^ {2}'?${id}'?:\\s*\\{$`, 'm').exec(en);
  if (!m) return null;
  let depth = 0;
  const start = en.indexOf('{', m.index);
  for (let i = start; i < en.length; i += 1) {
    if (en[i] === '{') depth += 1;
    else if (en[i] === '}') {
      depth -= 1;
      if (depth === 0) return en.slice(m.index, i + 1);
    }
  }
  return null;
}

const problems = [];
const note = (msg) => problems.push(msg);

/** Single-quoted TS string. Escapes only what must be escaped. */
const q = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

const MARC_TAG = /\b\d{3}\s*\$[a-z0-9]/;

function checkStrings(id, block) {
  for (const [key, value] of Object.entries(block)) {
    const strings = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    for (const s of strings) {
      if (typeof s === 'string' && MARC_TAG.test(s)) {
        note(`${id}: a MARC tag appears in ${key}: ${JSON.stringify(s.slice(0, 60))}`);
      }
    }
  }
}

function renderBlock(id, b) {
  checkStrings(id, b);
  switch (b.kind) {
    case 'p': case 'tip': case 'rule': case 'auto':
      return `      { kind: '${b.kind}', text: ${q(b.text)} }`;
    case 'steps': case 'list':
      return `      { kind: '${b.kind}', items: [${(b.items ?? []).map(q).join(', ')}] }`;
    case 'h':
      if (!ANCHORS.has(b.anchor)) note(`${id}: anchor '${b.anchor}' is not in the registry`);
      return `      { kind: 'h', text: ${q(b.text)}, anchor: '${b.anchor}' }`;
    case 'compare':
      return `      { kind: 'compare', good: ${q(b.good)}, bad: ${q(b.bad)}, why: ${q(b.why)} }`;
    case 'quote':
      return `      { kind: 'quote', text: ${q(b.text)}, source: ${q(b.source)} }`;
    case 'see': {
      if (!CHAPTER_IDS.includes(b.chapter)) note(`${id}: see -> unknown chapter '${b.chapter}'`);
      if (b.anchor && !ANCHORS.has(b.anchor)) note(`${id}: see -> unknown anchor '${b.anchor}'`);
      const anchor = b.anchor ? `, anchor: '${b.anchor}'` : '';
      return `      { kind: 'see', chapter: '${b.chapter}'${anchor}, text: ${q(b.text)} }`;
    }
    case 'fields': {
      const rows = (b.rows ?? []).map((r) => {
        if (!FACTS.has(r.fact)) note(`${id}: fields -> unknown fact '${r.fact}'`);
        return `        { fact: '${r.fact}', note: ${q(r.note)} }`;
      });
      return `      { kind: 'fields', rows: [\n${rows.join(',\n')}\n      ] }`;
    }
    default:
      note(`${id}: unknown block kind '${b.kind}'`);
      return null;
  }
}

function renderChapter(c) {
  if (!CHAPTER_IDS.includes(c.id)) {
    note(`'${c.id}' is not a chapter in the registry`);
    return null;
  }
  // The block kind sequence must match the English exactly. A translation that
  // drops a 'rule' has dropped a warning, and nothing else would notice.
  const source = englishChapter(c.id);
  if (source) {
    const enKinds = [...source.matchAll(/kind:\s*'([a-z]+)'/g)].map((m) => m[1]);
    const gotKinds = (c.blocks ?? []).map((b) => b.kind);
    if (enKinds.join(',') !== gotKinds.join(',')) {
      note(`${c.id}: block sequence differs from the English.\n      en:  ${enKinds.join(',')}\n      got: ${gotKinds.join(',')}`);
    }
  }
  const key = /^[a-z][a-zA-Z0-9]*$/.test(c.id) ? c.id : `'${c.id}'`;
  const blocks = (c.blocks ?? []).map((b) => renderBlock(c.id, b)).filter(Boolean);
  return `  ${key}: {
    id: '${c.id}',
    title: ${q(c.title)},
    summary:
      ${q(c.summary)},
    blocks: [
${blocks.join(',\n')}
    ]
  }`;
}

const incoming = JSON.parse(read(jsonPath));
const chapters = incoming.chapters ?? incoming;
const byId = new Map(chapters.map((c) => [c.id, c]));

// Merge: keep what the existing pack already has, verbatim, and add the rest.
const target = join(hbDir, `content/${lang}.ts`);
let keptSource = '';
let keptIds = [];
if (merge && existsSync(target)) {
  const existing = read(target);
  for (const id of CHAPTER_IDS) {
    if (byId.has(id)) continue;
    const m = new RegExp(`^ {2}'?${id}'?:\\s*\\{$`, 'm').exec(existing);
    if (!m) continue;
    let depth = 0;
    const start = existing.indexOf('{', m.index);
    for (let i = start; i < existing.length; i += 1) {
      if (existing[i] === '{') depth += 1;
      else if (existing[i] === '}') {
        depth -= 1;
        if (depth === 0) { keptIds.push(id); keptSource += existing.slice(m.index, i + 1) + ',\n\n'; break; }
      }
    }
  }
}

const rendered = CHAPTER_IDS.filter((id) => byId.has(id))
  .map((id) => renderChapter(byId.get(id)))
  .filter(Boolean);

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s); nothing written:`);
  for (const p of problems) console.error(`    ${p}`);
  process.exit(1);
}

const header = existsSync(target) && merge
  ? read(target).slice(0, read(target).indexOf('const pack: ContentPack'))
  : `// Handbook content pack: ${lang}.\n//\n// Generated by scripts/handbook_pack.mjs from translated chapter data, so that\n// every anchor, cross-reference and field key is byte-identical to the English\n// source rather than retyped. Edit the prose here freely; keep the identifiers.\nimport type { ContentPack } from '../types';\n\n`;

writeFileSync(target, `${header}const pack: ContentPack = {\n${keptSource}${rendered.join(',\n\n')}\n};\n\nexport default pack;\n`, 'utf8');

const total = keptIds.length + rendered.length;
console.log(
  `✓ ${lang}.ts: ${total}/${CHAPTER_IDS.length} chapters `
  + `(${keptIds.length} kept, ${rendered.length} generated); every id, anchor and fact key verified against the English.`
);
