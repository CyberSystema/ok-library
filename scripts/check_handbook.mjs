#!/usr/bin/env node
/**
 * Static guarantees for the Handbook.
 *
 * The Handbook is prose, so the compiler cannot check most of what matters about
 * it. Four things can be checked, and each of them has a specific failure in mind:
 *
 * 1. Every anchor a content pack declares is in the registry, and every anchor the
 *    registry declares is owned by the chapter that claims it. A "?" pointing at a
 *    section that does not exist is worse than no "?": the librarian presses it at
 *    the exact moment they need the answer.
 *
 * 2. Every chapter the registry lists exists in the English pack. English is the
 *    fallback for all four languages, so a chapter missing THERE is missing
 *    everywhere.
 *
 * 3. No content pack states a MARC tag of its own. Tags live in `facts.ts`, once.
 *    Four translations each carrying "245 $a" is four copies of one fact in files
 *    edited months apart, and being wrong in exactly one of them is both the
 *    likeliest outcome and the hardest to notice.
 *
 * 4. No content pack is reachable from the main bundle. The packs are the largest
 *    thing in the app and they are lazy on purpose; a single static import would
 *    silently undo that and nothing else would complain.
 *
 * Exits non-zero on any problem so CI fails.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hb = join(root, 'apps/web/src/handbook');
const read = (p) => readFileSync(p, 'utf8');

let failed = false;
const fail = (msg, detail) => {
  failed = true;
  console.error(`\n✗ ${msg}`);
  if (detail) for (const d of [].concat(detail).slice(0, 25)) console.error(`    ${d}`);
};

// ── the registry ────────────────────────────────────────────────────────────
const registry = read(join(hb, 'registry.ts'));
const chapterIds = [...registry.matchAll(/^\s{2}'([a-z0-9-]+)',?$/gm)].map((m) => m[1]);
const anchorOwners = new Map(
  [...registry.matchAll(/^\s{2}'([a-z0-9-]+)':\s*'([a-z0-9-]+)',?$/gm)].map((m) => [m[1], m[2]])
);

if (chapterIds.length === 0) fail('no chapter ids found in registry.ts — has the format changed?');
if (anchorOwners.size === 0) fail('no anchors found in registry.ts — has the format changed?');

for (const [anchor, owner] of anchorOwners) {
  if (!chapterIds.includes(owner)) {
    fail(`anchor '${anchor}' is owned by '${owner}', which is not a chapter`);
  }
}

// ── the packs ───────────────────────────────────────────────────────────────
const contentDir = join(hb, 'content');
const packs = existsSync(contentDir)
  ? readdirSync(contentDir).filter((f) => /\.ts$/.test(f))
  : [];
if (!packs.includes('en.ts')) fail('there is no English content pack; English is the fallback for every language');

for (const file of packs) {
  const src = read(join(contentDir, file));
  const lang = file.replace(/\.ts$/, '');

  // (1) anchors declared in the prose must be in the registry, and must belong to
  // the chapter they are written in.
  let currentChapter = null;
  for (const line of src.split('\n')) {
    const chap = /^\s{2}'?([a-z0-9-]+)'?:\s*\{$/.exec(line);
    if (chap && chapterIds.includes(chap[1])) currentChapter = chap[1];
    const anchorUse = /anchor:\s*'([a-z0-9-]+)'/.exec(line);
    if (!anchorUse) continue;
    const anchor = anchorUse[1];
    if (!anchorOwners.has(anchor)) {
      fail(`${lang}: anchor '${anchor}' is used but not declared in registry.ts`);
      continue;
    }
    // `h` blocks define an anchor and must sit in its owning chapter; `see`
    // blocks merely point at one and may cross chapters.
    if (/kind:\s*'h'/.test(line) && anchorOwners.get(anchor) !== currentChapter) {
      fail(`${lang}: anchor '${anchor}' is defined in chapter '${currentChapter}' but the registry says '${anchorOwners.get(anchor)}'`);
    }
  }

  // (3) no bare MARC tags in the prose.
  const tagLike = [...src.matchAll(/(?:MARC\s+)?\b(\d{3})\s*\$[a-z0-9]/g)]
    .map((m) => m[0].trim())
    .filter((v, i, a) => a.indexOf(v) === i);
  if (tagLike.length > 0) {
    fail(`${lang}: MARC tags appear in the prose; put them in facts.ts so they are stated once`, tagLike);
  }

  // Chapter ids in a pack must be real.
  for (const m of src.matchAll(/^\s{2}'?([a-z][a-z0-9-]+)'?:\s*\{$/gm)) {
    if (!chapterIds.includes(m[1])) {
      fail(`${lang}: '${m[1]}' is not a chapter in the registry`);
    }
  }
}

// (1b) A translated chapter must carry the SAME blocks as the English, in order.
//
// This lived only in the generator, which runs once per batch — so a later hand
// edit could quietly drop a 'rule' and take a warning out of a translation with
// nothing to notice. A handbook that omits a caution in one language is worse
// than one that omits a chapter: the reader believes they have read it.
function chapterBody(src, id) {
  const m = new RegExp(`^ {2}'?${id}'?:\\s*\\{$`, 'm').exec(src);
  if (!m) return null;
  let depth = 0;
  const start = src.indexOf('{', m.index);
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}
const kindsOf = (body) => [...body.matchAll(/kind:\s*'([a-z]+)'/g)].map((x) => x[1]).join(',');

if (packs.includes('en.ts')) {
  const enSrc = read(join(contentDir, 'en.ts'));
  for (const file of packs.filter((f) => f !== 'en.ts')) {
    const lang = file.replace(/\.ts$/, '');
    const src = read(join(contentDir, file));
    for (const id of chapterIds) {
      const mine = chapterBody(src, id);
      if (!mine) continue; // not translated yet — English fills in at runtime
      const theirs = chapterBody(enSrc, id);
      if (!theirs) continue;
      if (kindsOf(mine) !== kindsOf(theirs)) {
        fail(`${lang}: chapter '${id}' has a different block sequence from the English`,
          [`en:  ${kindsOf(theirs)}`, `${lang}: ${kindsOf(mine)}`]);
      }
    }
  }
}

// (2) every registry chapter is present in English.
if (packs.includes('en.ts')) {
  const en = read(join(contentDir, 'en.ts'));
  const missing = chapterIds.filter((id) => !new RegExp(`^\\s{2}'?${id}'?:\\s*\\{$`, 'm').test(en));
  if (missing.length) fail('chapters in the registry with no English text', missing);
}

// (3b) A language listed as TRANSLATED must actually be complete.
//
// `TRANSLATED_LANGS` is a claim, and the runtime uses it to decide whether to stop
// fetching the English fallback. A language listed there with chapters missing
// would show a reader blank pages where English used to appear — the claim has to
// be checked rather than trusted.
const translated = (/TRANSLATED_LANGS[^=]*=\s*\[([^\]]*)\]/.exec(registry)?.[1] ?? '')
  .split(',').map((v) => v.trim().replace(/['"]/g, '')).filter(Boolean);
for (const lang of translated) {
  const file = join(contentDir, `${lang}.ts`);
  if (!existsSync(file)) {
    fail(`registry lists '${lang}' as translated, but content/${lang}.ts does not exist`);
    continue;
  }
  const src = read(file);
  const missing = chapterIds.filter((id) => !new RegExp(`^ {2}'?${id}'?:\\s*\\{$`, 'm').test(src));
  if (missing.length) {
    fail(`registry lists '${lang}' as translated, but ${missing.length} chapter(s) are missing`, missing);
  }
}
console.log(`  complete languages: ${translated.join(', ')}`);

// (3c) Every language the INTERFACE offers must have a loader.
//
// `CONTENT_LOADERS[lang]()` is called with no guard, so a language present in the
// switcher but absent from the map throws the moment a reader opens the Handbook
// — and the switcher is the one place a new language gets added first. A missing
// pack is meant to fall back to English; a missing LOADER cannot.
const uiLangs = (/export type Lang =([^;]*);/.exec(read(join(root, 'apps/web/src/i18n.tsx')))?.[1] ?? '')
  .split('|').map((v) => v.trim().replace(/['"]/g, '')).filter(Boolean);
const loaders = [...registry.matchAll(/^ {2}([a-z]{2}):\s*\(\)\s*=>\s*import\(/gm)].map((m) => m[1]);
if (uiLangs.length === 0) fail('could not read the interface languages from i18n.tsx — has `export type Lang` changed?');
const unloadable = uiLangs.filter((l) => !loaders.includes(l));
if (unloadable.length) {
  fail('the interface offers languages the Handbook cannot load', unloadable.map(
    (l) => `'${l}' is in i18n.tsx's Lang but has no entry in CONTENT_LOADERS — opening the Handbook in it throws`));
}

// ── (5) the collisions that broke two translations ──────────────────────────
//
// Every previous language pack shipped with a concept collision: one word doing
// two jobs, in a sentence that read perfectly and instructed the opposite. Greek
// used σειρά for both a publisher's series and a periodical's run, so "record its
// run" told the librarian to record the series. Russian did the identical thing
// with комплект. Greek also used one verb for a reader collecting a hold and the
// library taking a volume back, and διαγραφή for both erasing a reader's personal
// data and deleting the reader — in the chapter that exists to distinguish them.
//
// None of that is detectable by a compiler, by a fluent reader of one language, or
// by the block-sequence check: the prose is grammatical and the structure intact.
// What IS detectable is the vocabulary rule each resolution rests on. A term that
// must never appear in a given chapter is a grep.
//
// So each pack declares, per chapter, which words are REQUIRED (the distinction is
// actually drawn) and which are FORBIDDEN (its collision partner cannot leak in).
// English is the reference for what the chapters are about; the rules are per
// language because the collisions are properties of the language, not the content.
const COLLISION_RULES = {
  ko: {
    // 총서 (a publisher's series) vs 소장권호 (the issues of a periodical we hold)
    // vs 다권본 (one work in several volumes). The Greek and Russian failure.
    'periodical-runs': { required: ['소장권호', '결호'], forbidden: ['총서'] },
    'series-and-sets': { required: ['총서', '다권본'], forbidden: ['소장권호'] },
    // 제적 (strike a copy from the register) vs 표목 폐지 (retire a heading).
    'withdrawal': { required: ['제적'], forbidden: ['폐지'] },
    'headings': { required: ['폐지'], forbidden: ['제적'] },
    // 개인정보 파기 (destroy personal data, the statutory act) vs 레코드 삭제
    // (delete the record, reversible). 삭제 must never take 개인정보 as its object.
    'data-protection': { required: ['파기'], forbiddenPatterns: [/개인정보[^.\n]{0,6}삭제/] },
    // 반납 (the library receives it back) vs 예약 자료 수령 (the reader collects).
    'readers-and-loans': { required: ['반납'], forbiddenPatterns: [/반납[^.\n]{0,12}수령|수령[^.\n]{0,12}반납/] }
  }
};
// Words banned pack-wide, each because it can silently take another's job:
// 사본 is a photocopy and must never mean a volume the library owns; 서명 means
// both "title" and "signature"; 폐기 would happily serve as both 제적 and 폐지;
// 복본 sits one syllable from 중복.
const BANNED_TERMS = { ko: ['사본', '서명', '폐기', '복본', '시리즈'] };

for (const [lang, rules] of Object.entries(COLLISION_RULES)) {
  const file = join(contentDir, `${lang}.ts`);
  if (!existsSync(file)) continue;
  const src = read(file);
  for (const [chapterId, rule] of Object.entries(rules)) {
    const body = chapterBody(src, chapterId);
    if (!body) continue; // not translated yet; English fills in
    for (const term of rule.required ?? []) {
      if (!body.includes(term)) {
        fail(`${lang}: chapter '${chapterId}' never says '${term}' — the distinction it exists to draw may have been flattened`);
      }
    }
    for (const term of rule.forbidden ?? []) {
      if (body.includes(term)) {
        fail(`${lang}: '${term}' appears in chapter '${chapterId}', where it names a different concept`,
          [`this is the collision that reversed the advice in the Greek and Russian packs`]);
      }
    }
    for (const re of rule.forbiddenPatterns ?? []) {
      const m = re.exec(body);
      if (m) fail(`${lang}: chapter '${chapterId}' collides two concepts in one sentence`, [m[0].slice(0, 90)]);
    }
  }
  for (const term of BANNED_TERMS[lang] ?? []) {
    if (src.includes(term)) {
      const line = src.split('\n').find((l) => l.includes(term))?.trim().slice(0, 100);
      fail(`${lang}: the banned term '${term}' appears in the pack`, [line ?? '']);
    }
  }
}

// ── (4) the packs must be LAZY ──────────────────────────────────────────────
// Two checks, because the obvious one is not enough. "The prose is in its own
// chunk" proves nothing: a static import leaves the chunk separate and merely
// makes the main bundle depend on it eagerly, so the file is fetched at startup
// anyway. Measured — the first version of this check passed while the pack was
// being loaded on every page load.
//
// (4a) Source: nothing may import a content pack except the registry's loader map.
const webSrc = join(root, 'apps/web/src');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : /\.(tsx?|ts)$/.test(e.name) ? [join(dir, e.name)] : []);
for (const abs of walk(webSrc)) {
  const rel = abs.slice(root.length + 1);
  if (rel.endsWith('handbook/registry.ts')) continue;
  if (rel.includes('handbook/content/')) continue;
  const src = read(abs);
  // A STATIC import: `import x from '...content/en'`. The registry's
  // `() => import('./content/en')` is dynamic and is what makes the chunk lazy.
  for (const m of src.matchAll(/^\s*import\s[^\n]*?['"][^'"]*handbook\/content\/([a-z]{2})['"]/gm)) {
    fail(`${rel} imports the '${m[1]}' content pack statically; only registry.ts may reference a pack, and only through a dynamic import`);
  }
}

// (4b) Bundle: the main chunk must not import a pack chunk STATICALLY.
//
// Mere mention is not evidence. A dynamic import puts the chunk's name into the
// `__vite__mapDeps` preload manifest inside the importing chunk, which is exactly
// how `modulepreload` is emitted for a lazy chunk — so "index names en-*.js" is
// true of a correct build. What distinguishes the two is the FORM: a static
// dependency appears as `import"./en-x.js"` or `from"./en-x.js"`, a lazy one only
// ever as `import("./en-x.js")`. Checking presence instead of form is how the
// first version of this check passed on a broken build.
const dist = join(root, 'apps/web/dist/assets');
if (existsSync(dist)) {
  const files = readdirSync(dist);
  const main = files.filter((f) => /^index-.*\.js$/.test(f));
  const NEEDLE = 'A catalogue is not a list of books';
  if (!read(join(contentDir, 'en.ts')).includes(NEEDLE)) {
    fail(`the bundle check needs the sentence "${NEEDLE}" in en.ts; it has been edited away`);
  }
  const packChunks = files.filter((f) => /\.js$/.test(f) && read(join(dist, f)).includes(NEEDLE));
  if (packChunks.length === 0) fail('no built chunk contains the Handbook prose — is the lazy import reachable?');
  for (const m of main) {
    const src = read(join(dist, m));
    // `import` or `from` followed by the chunk path, with no `(` between them.
    const eager = packChunks.filter((chunk) =>
      new RegExp(`(?:\\bimport|\\bfrom)\\s*["'][^"'()]*${chunk.replace(/[.]/g, '\\.')}["']`).test(src));
    if (eager.length) {
      fail(`${m} imports the pack chunk(s) ${eager.join(', ')} statically — the prose is fetched at startup`);
    }
    if (src.includes(NEEDLE)) fail(`${m} contains the Handbook prose outright`);
  }
  console.log(`  bundle: prose in ${packChunks.join(', ')}, loaded on demand by ${main.join(', ')}`);
} else {
  console.log('  bundle: apps/web/dist not built, skipping the lazy-loading check');
}

if (failed) process.exit(1);
console.log(
  `✓ handbook: ${chapterIds.length} chapters, ${anchorOwners.size} anchors, ${packs.length} pack(s); `
  + 'every anchor resolves, no MARC tag in the prose.'
);
