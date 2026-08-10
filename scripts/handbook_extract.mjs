#!/usr/bin/env node
/**
 * Dump a Handbook content pack back to JSON — the inverse of handbook_pack.mjs.
 *
 * Translating a chapter means rewriting only its strings: every id, anchor,
 * cross-reference and fact key has to survive byte-identical, and the block
 * sequence has to match. Handing a translator 98 KB of TypeScript and asking them
 * to be careful is how those get broken, so this emits exactly the chapters asked
 * for, as data, in the shape handbook_pack.mjs reads back.
 *
 * The pack is TypeScript, but only barely: one type-only import and one type
 * annotation. Strip those two and it is a JSON-shaped ES module, which is safer
 * than regex-parsing a file full of apostrophes in four languages.
 *
 * Usage:
 *   node scripts/handbook_extract.mjs <lang> [chapterId ...] [--out FILE]
 *   node scripts/handbook_extract.mjs en --list
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hbDir = join(root, 'apps/web/src/handbook');
const argv = process.argv.slice(2);
const lang = argv[0];
if (!lang) {
  console.error('usage: handbook_extract.mjs <lang> [chapterId ...] [--out FILE] [--list]');
  process.exit(2);
}
// Walk the arguments rather than filtering them: `--out FILE` consumes the token
// after it, and treating that filename as a chapter id silently yields an empty
// pack — which looks like a successful extraction of nothing.
let outFile = null;
let wantList = false;
const ids = [];
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i] === '--out') { outFile = argv[i + 1]; i += 1; }
  else if (argv[i] === '--list') wantList = true;
  else if (argv[i].startsWith('--')) { console.error(`unknown flag ${argv[i]}`); process.exit(2); }
  else ids.push(argv[i]);
}

async function loadPack(file) {
  const src = readFileSync(file, 'utf8')
    .replace(/^import type[^\n]*\n/gm, '')
    .replace(/const pack: ContentPack =/, 'const pack =');
  const dir = mkdtempSync(join(tmpdir(), 'hbx-'));
  const tmp = join(dir, 'pack.mjs');
  writeFileSync(tmp, src, 'utf8');
  try {
    return (await import(pathToFileURL(tmp).href)).default;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const registry = readFileSync(join(hbDir, 'registry.ts'), 'utf8');
const order = [...registry.matchAll(/^ {2}'([a-z0-9-]+)',?$/gm)].map((m) => m[1]);

const pack = await loadPack(join(hbDir, `content/${lang}.ts`));

if (wantList) {
  for (const id of order) {
    const c = pack[id];
    const blocks = c ? c.blocks.length : 0;
    const words = c ? JSON.stringify(c).split(/\s+/).length : 0;
    console.log(`${c ? '·' : '✗'} ${id.padEnd(26)} ${String(blocks).padStart(3)} blocks  ~${words} words`);
  }
  process.exit(0);
}

const picked = (ids.length ? ids : order).filter((id) => {
  if (!pack[id]) { console.error(`! ${lang}.ts has no chapter '${id}'`); return false; }
  return true;
});

const out = JSON.stringify({ chapters: picked.map((id) => pack[id]) }, null, 1);
if (outFile) {
  writeFileSync(outFile, out, 'utf8');
  console.error(`✓ ${picked.length} chapter(s) from ${lang}.ts → ${outFile}`);
} else {
  process.stdout.write(out);
}
