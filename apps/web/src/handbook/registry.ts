// What chapters exist, what anchors they own, and how a language pack is loaded.
//
// Eager on purpose — a few hundred bytes of ids — while the prose that fills them
// is lazy. That split is what lets a "?" button anywhere in the app name an anchor
// without pulling half a megabyte of handbook into the main bundle.
//
// `ChapterId` and `AnchorId` are string-literal unions rather than plain strings,
// so `<HelpLink anchor="ddc" />` and every `see` cross-reference are checked by
// the compiler. A dead link becomes a build error instead of something a librarian
// finds at the moment they most need the answer.

export const CHAPTER_IDS = [
  // Foundations
  'what-a-catalogue-is-for',
  'consistency',
  // Describing the publication
  'titles',
  'edition-and-imprint',
  'extent',
  'classification',
  'identifiers',
  'notes',
  // Access points — the ways in
  'names',
  'headings',
  'contributors',
  'subjects',
  'series-and-sets',
  'searching',
  'transliteration',
  'dates',
  // Reference
  'glossary'
] as const;

export type ChapterId = (typeof CHAPTER_IDS)[number];

/**
 * Every anchor in the Handbook, and the chapter that owns it.
 *
 * Declared here rather than inferred from the prose so that a form can point at
 * `'ddc'` before that chapter is written, and so `check_handbook.mjs` can tell the
 * difference between "this anchor is not written yet" and "this anchor is a typo".
 */
export const ANCHOR_OWNERS = {
  // headings
  'what-a-heading-is': 'headings',
  'making-a-heading': 'headings',
  'variant-forms': 'headings',
  'correcting-a-heading': 'headings',
  'retiring-a-heading': 'headings',
  // contributors
  'relators': 'contributors',
  'editor-and-translator': 'contributors',
  'free-text-contributors': 'contributors',
  // subjects
  'subject-headings': 'subjects',
  'seeding-subjects': 'subjects',
  'imported-subjects': 'subjects',
  // series-and-sets
  'series-statement': 'series-and-sets',
  'multi-part-works': 'series-and-sets',
  'missing-volumes': 'series-and-sets',
  // searching
  'how-search-works': 'searching',
  'partial-and-fuzzy': 'searching',
  'smart-lists': 'searching',
  // titles
  'title-proper': 'titles',
  'subtitle': 'titles',
  'non-filing': 'titles',
  'title-changes': 'titles',
  // edition-and-imprint
  'edition': 'edition-and-imprint',
  'publisher': 'edition-and-imprint',
  'place-of-publication': 'edition-and-imprint',
  'no-publisher': 'edition-and-imprint',
  // extent
  'extent-form': 'extent',
  'dimensions': 'extent',
  // classification
  'shelf-classification': 'classification',
  'ddc': 'classification',
  'code-vs-label': 'classification',
  // identifiers
  'isbn': 'identifiers',
  'bad-isbn': 'identifiers',
  'issn': 'identifiers',
  // notes
  'when-to-note': 'notes',
  'custom-attributes': 'notes',
  // what-a-catalogue-is-for
  'record-vs-copy': 'what-a-catalogue-is-for',
  'why-standards': 'what-a-catalogue-is-for',
  'standards-list': 'what-a-catalogue-is-for',
  // consistency
  'one-spelling': 'consistency',
  'consolidate-or-authority': 'consistency',
  'empty-vs-unknown': 'consistency',
  // names
  'greek-name-order': 'names',
  'monastics-and-bishops': 'names',
  'saints-and-fathers': 'names',
  'corporate-names': 'names',
  'no-author': 'names',
  // transliteration
  'why-romanize': 'transliteration',
  'iso-843': 'transliteration',
  'parallel-fields': 'transliteration',
  // dates
  'edtf': 'dates',
  'uncertain-dates': 'dates',
  'date-ranges': 'dates',
  // glossary
  'glossary-terms': 'glossary'
} as const satisfies Record<string, ChapterId>;

export type AnchorId = keyof typeof ANCHOR_OWNERS;

export function chapterForAnchor(anchor: AnchorId): ChapterId {
  return ANCHOR_OWNERS[anchor];
}

/**
 * The order chapters read in. Separate from `CHAPTER_IDS` so that adding a chapter
 * and placing it are two decisions — and so `check_handbook.mjs` can assert the
 * two lists agree rather than trusting one array to be maintained twice.
 */
export const CHAPTER_ORDER: readonly ChapterId[] = CHAPTER_IDS;

/**
 * One dynamic import per language, so a chunk exists per language.
 *
 * The map is written out rather than built from a template literal because a
 * bundler cannot split what it cannot see: `import(`./content/${lang}.ts`)` either
 * bundles every pack into one chunk or defeats the split entirely, depending on
 * the bundler's mood. Explicit imports make the four chunks a fact.
 *
 * Only English exists at present. Missing packs fall back to it, which is also the
 * runtime behaviour once a pack is partial — a chapter translated tomorrow appears
 * tomorrow, and until then the reader gets English rather than a blank page.
 */
export const CONTENT_LOADERS = {
  en: () => import('./content/en'),
  el: () => import('./content/en'),
  ru: () => import('./content/en'),
  ko: () => import('./content/en')
} as const;

export type ContentLang = keyof typeof CONTENT_LOADERS;

/** Languages with a pack of their own, as opposed to falling back to English. */
export const TRANSLATED_LANGS: readonly ContentLang[] = ['en'];
