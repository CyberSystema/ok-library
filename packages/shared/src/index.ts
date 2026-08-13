import { z } from 'zod';

// Strict boolean parser for query strings. Zod's `z.coerce.boolean()` calls
// Boolean(value) under the hood, which means the literal string "false" coerces
// to `true` — silently breaking any code that toggled a default-on flag off via
// the URL. This parser handles real bool-ish strings correctly.
const ZodQueryBoolean = z
  .union([z.boolean(), z.string()])
  .transform((v, ctx) => {
    if (typeof v === 'boolean') return v;
    const t = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'n', 'off', ''].includes(t)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid boolean: "${v}"` });
    return z.NEVER;
  });

// Attribute keys a librarian may not claim, because the import/export column
// mapping and the query layer already spell core book fields this way. Mirrored
// verbatim by RESERVED_ATTRIBUTE_KEYS in apps/web/src/main.tsx, which pre-checks
// the form so the error shows inline — change one and you must change the other,
// or the client and the server disagree about what is creatable.
//
// `subtitle` is the odd entry and stays anyway. Nothing standard claims it: there
// is no BookCoreSchema field and no `books` column, so for this one key the
// message's "standard book attribute" is a phantom. But the spelling the rest of
// the stack uses is `subTitle` — what the MARCXML importer writes for 245 $b,
// what the XLSX mapper writes, what marc.ts reads (with `sub_title` as its only
// fallback) — so a lowercase `subtitle` definition would be a decoy: the sheet's
// "Sub Title" column resolves to it through resolveImportCustomKey's fuzzy match,
// and marc.ts, which never looks there, would silently drop the subtitle from
// every exported record. Blocking the one spelling nothing reads is worth more
// than the accuracy of the message.
const ReservedBookAttributeKeys = new Set([
  'title',
  'subtitle',
  'author',
  'isbn',
  'publicationYear',
  'publisher',
  'language',
  'description',
  'roomCode',
  'shelfCode',
  'acquisitionDate',
  'status',
  'tags',
  'customFields',
  'version',
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt'
]);

/**
 * The widest value the facet rail can carry, on BOTH sides of the round trip.
 *
 * A rail bucket advertises a count and promises the list it opens will reproduce
 * it. That promise silently failed for long values: `facetValue` was capped at 200
 * characters while the values it selects were not. 40 live records have a title
 * over 200 characters (the longest is 289), so faceting on title produced 40
 * buckets whose click-through answered
 * `400 facetValue: Too big: expected string to have <=200 characters` — the
 * librarian clicks a number and the screen does not move.
 *
 * 500 because that is the widest title the catalogue can store (the catalogue
 * import row schema allows 500; the direct form allows 300), and custom attribute
 * values are capped at the same number below — they had no cap at all, which made
 * "the rail can always be opened" true only by luck. Longest live attribute value
 * is 247, and 8 exceed 200, so the cap is a guardrail rather than a narrowing.
 *
 * Raising either end without the other reopens exactly this bug, which is why
 * there is one constant and not two literals.
 */
export const FACET_VALUE_MAX = 500;

export const BookStatusSchema = z.enum(['available', 'borrowed', 'lost', 'maintenance']);
export const BibLevelSchema = z.enum(['monograph', 'serial']);
export const BIB_LEVELS = BibLevelSchema.options;

// An ISO-8601 instant — and, because the value is re-serialised on the way
// through, always the SAME ISO shape once parsed.
//
// The refinement was the whole check, and `Date.parse` accepts far more than ISO
// 8601: "March 3 2027", "2027/03/03", "05/03/2030". Nothing downstream
// reformatted the value, so whatever the caller sent was stored verbatim in a
// column that is only ever compared as TEXT — the overdue test is
// `due_at < nowIso()`, SQLite comparing strings. A loan due "05/03/2030"
// (a Greek librarian's 3 March) therefore sorted before every real timestamp and
// was reported overdue the moment it was created: in
// /api/borrow/active?overdueOnly=true, in the dashboard's overdue count and in
// the reader's overdue tally. UTC-offset forms failed the same way more quietly,
// comparing a wall clock against instants. So the name asserted ISO 8601 and
// only the transform below makes it true.
//
// NORMALIZING rather than rejecting is deliberate. The stricter reading — 400 on
// anything not ISO — would break a live caller: the XLSX importer puts a RAW
// spreadsheet cell into `acquisitionDate` (main.tsx reads the sheet with
// `raw: false`, so a date column arrives as whatever it was displayed as,
// "3/5/19" included), and /api/import/books validates the whole batch in one
// safeParse, so a single such cell would reject all 2000 rows. The set of
// accepted inputs is therefore exactly what it was; only the stored form
// changed. `Date.parse` is implementation-defined for those non-ISO shapes, but
// the web client imports no schema from this package — every parse happens in
// the Worker — so there is one interpretation, not one per browser.
export const ISODateTimeSchema = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid ISO datetime')
  .transform((v) => new Date(v).toISOString());

export const BookCoreSchema = z.object({
  // Title is optional at the schema level: the catalog legitimately contains
  // untitled entries, and since blank title/author both canonicalize to '' (see
  // normalizeBookData), a blank-title book must remain editable — a min(1) here
  // would 400 every save of such a book. The UI still nudges toward a title via
  // the "untitled" smart list and a localized placeholder.
  title: z.string().max(300).default(''),
  // MARC 880-style parallel forms: the romanized reading of a non-Latin title,
  // author or publisher. The ORIGINAL script is what displays; these are stored
  // alongside so they stay searchable and exchangeable instead of overwriting
  // the vernacular form, which is what made ISBN lookup fill the form with
  // "Epiphanios Salaminos Kyprou" in place of "Επιφάνιος Σαλαμίνος Κύπρου".
  titleRomanized: z.string().max(300).optional().nullable(),
  authorRomanized: z.string().max(200).optional().nullable(),
  publisherRomanized: z.string().max(200).optional().nullable(),
  // Author is optional: many works legitimately have none (liturgical books,
  // service books, anonymous editions). Stored as an empty string when absent
  // so the NOT NULL column and the "unknown author" placeholder both hold.
  author: z.string().max(200).default(''),
  isbn: z.string().max(32).optional().nullable(),
  publicationYear: z.number().int().min(1000).max(3000).optional().nullable(),
  // The authored date, in the EDTF subset above. When present it is
  // AUTHORITATIVE and `publicationYear` is derived from it, so the two can
  // never disagree. Free-form up to 64 chars: an unparseable value is warned
  // about, never rejected — a librarian must always be able to record what is
  // printed in the book.
  dateEdtf: z.string().max(64).optional().nullable(),
  // DERIVED, never trusted from a client: the latest year `dateEdtf` can denote.
  // Accepted in the schema only so the type flows through the write paths;
  // `reconcileBookDates` overwrites it on every write.
  publicationYearEnd: z.number().int().min(1000).max(3000).optional().nullable(),
  // Dewey Decimal, alongside the local shelf classification rather than
  // replacing it — no re-shelving, but imported records keep their DDC and the
  // catalogue gains a standard subject handle. MARC 082.
  ddc: z.string().max(40).optional().nullable(),
  // IFLA LRM's bibliographic level, and MARC leader/07: a monograph is a work
  // that is finished, a serial one that keeps arriving. Migration 0024 added
  // the column and nothing could ever write it, so all 12,675 records sat at
  // the default while thirteen of them carried an ISSN — and the ISO 2789
  // return the librarian files reported zero serial titles held.
  //
  // Deliberately just these two. MARC defines seven values (a, b, c, d, i, m,
  // s); the exporter understands 'm' and 's', and offering a level it would
  // silently flatten would be worse than not offering it.
  bibLevel: BibLevelSchema.optional(),
  publisher: z.string().max(200).optional().nullable(),
  // Catalogues frequently use multi-language tags like "EL,EN,FR" so we keep
  // the field free-form text rather than enumerated.
  language: z.string().max(120).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  roomCode: z.string().max(64).optional().nullable(),
  shelfCode: z.string().max(64).optional().nullable(),
  legacyId: z.string().min(1).max(64).optional().nullable(),
  customFields: z.record(z.string(), z.union([z.string().max(FACET_VALUE_MAX), z.number(), z.boolean(), z.null()])).default({})
});

export const CreateBookSchema = BookCoreSchema.extend({
  acquisitionDate: ISODateTimeSchema.optional().nullable(),
  tags: z.array(z.string().max(50)).max(30).default([]),
  status: BookStatusSchema.default('available')
});

// A PARTIAL update: any field the caller omits must be left untouched.
//
// `.partial()` alone is NOT enough. It makes every key optional but does not
// remove the `.default()` wrappers declared above, so Zod still SUBSTITUTES a
// default when a key is absent: parsing `{ shelfCode, version }` used to yield
// `{ shelfCode, version, title: '', author: '', tags: [], customFields: {},
// status: 'available' }`. The update handlers merge that over the stored row,
// which silently wiped the title, author, tags and custom fields of every book
// touched by a partial update (e.g. a bulk "set shelf code"). The defaulted
// fields are therefore re-declared here WITHOUT defaults — absent now really
// does mean "don't change this column".
export const UpdateBookSchema = CreateBookSchema.partial().extend({
  version: z.number().int().min(0),
  title: z.string().max(300).optional(),
  author: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
  status: BookStatusSchema.optional(),
  customFields: z.record(z.string(), z.union([z.string().max(FACET_VALUE_MAX), z.number(), z.boolean(), z.null()])).optional(),

  // PATCH forms, for setting one attribute across many books.
  //
  // `customFields` above REPLACES the whole map, which is right for a form that
  // renders every attribute but catastrophic for a bulk edit: sending
  // `{ series: 'X' }` for 300 books would erase every other attribute on all of
  // them. `customFieldsPatch` merges instead — listed keys are set, `null`
  // clears that one key, everything else is left alone. Making the safe shape
  // expressible on the wire means a bulk edit never has to send (and so can
  // never mangle) values it isn't changing.
  customFieldsPatch: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  // Same reasoning for tags: add/remove rather than replace, so bulk-tagging
  // 300 books doesn't strip the tags each of them already carries.
  tagsAdd: z.array(z.string().max(50)).max(30).optional(),
  tagsRemove: z.array(z.string().max(50)).max(30).optional()
});

export const BookSchema = CreateBookSchema.extend({
  id: z.string().min(1),
  status: BookStatusSchema,
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
  deletedAt: ISODateTimeSchema.nullable(),
  version: z.number().int().min(0)
});

/**
 * Fold duplicate records into copies of one survivor.
 *
 * The librarian catalogued ~44 books twice because each also sits on a back
 * shelf. With holdings, each of those pairs should be ONE record with two
 * copies — this is that cleanup.
 *
 * `dryRun` is the default on the client: a merge soft-deletes records and moves
 * their holdings, and the operator needs to see exactly what would happen
 * first. Never run unattended over the catalogue.
 */
export const MergeBooksSchema = z.object({
  /** The record that survives and absorbs the others. */
  keepId: z.string().min(1),
  /** Records folded into it. Soft-deleted, with a `merged_into` forwarding address. */
  mergeIds: z.array(z.string().min(1)).min(1).max(20),
  dryRun: z.boolean().default(true)
});

// ─── Publication dates (EDTF) ──────────────────────────────────────────────
//
// A plain integer year cannot say what an old theological collection actually
// holds. The librarian hit this on a volume bound from two parts: "έχουν 2
// διαφορετικές ημερομηνίες έκδοσης. Δεν μου επιτρέπει το σύστημα να καταχωρήσω
// 2 ημερομηνίες έκδοσης σε μια καταχώρηση βιβλίου." Undated, circa- and
// decade-only imprints are just as common.
//
// EDTF (Extended Date/Time Format, ISO 8601-2) is the standard libraries use
// for exactly this. We implement a documented SUBSET — the shapes that occur in
// this catalogue and that MARC 260$c / 008 map onto — and treat anything else
// as unparseable rather than pretending to understand it.
//
//   1955          exact
//   1955/1957     an interval — the two-volume bound-with
//   1955?         uncertain
//   ~1850         approximate ("circa", "χ. 1850")
//   1955~         approximate, EDTF's trailing form
//   19XX          unspecified digits — MARC's "[19--]"
//   [1955,1957]   one of these
//   ../1960       open start ("before 1960")
//   1960/..       open end
export type ParsedEdtf = {
  /** Earliest year the expression can denote; drives sorting and filtering. */
  start: number;
  /** Latest year it can denote. Equals `start` for a single date. */
  end: number;
  /** true when the value is a range/one-of rather than a single year. */
  isRange: boolean;
  qualifier: 'exact' | 'uncertain' | 'approximate';
};

/**
 * Sort sentinels for an EDTF interval with an OPEN end.
 *
 * "../1960" and "1960/.." have to sort and range-filter alongside real years, so an
 * unknown end is stored as one of these. They are machinery, NOT dates: anything
 * that presents a stored year to a human or to another library must recognise them
 * and say "unknown" rather than "1000". Exported because the MARC 008 builder read
 * them as authored dates and published "before 1960" as a work of the year 1000.
 */
export const EDTF_SENTINEL_MIN = 1000;
export const EDTF_SENTINEL_MAX = 3000;
const EDTF_MIN_YEAR = EDTF_SENTINEL_MIN;
const EDTF_MAX_YEAR = EDTF_SENTINEL_MAX;

function edtfYear(token: string): number | null {
  if (!/^\d{4}$/.test(token)) return null;
  const n = Number(token);
  return n >= EDTF_MIN_YEAR && n <= EDTF_MAX_YEAR ? n : null;
}

/**
 * Parse the supported EDTF subset. Returns null for anything outside it, which
 * the callers surface as a warning — never as a refusal to save. A librarian
 * transcribing what is printed in a book must always be able to record it.
 */
export function parseEdtf(raw: string): ParsedEdtf | null {
  let text = raw.trim();
  if (!text) return null;

  let qualifier: ParsedEdtf['qualifier'] = 'exact';
  // Approximation can be written either side; uncertainty trails.
  if (text.startsWith('~')) { qualifier = 'approximate'; text = text.slice(1).trim(); }
  if (text.endsWith('~')) { qualifier = 'approximate'; text = text.slice(0, -1).trim(); }
  if (text.endsWith('?')) { qualifier = 'uncertain'; text = text.slice(0, -1).trim(); }

  // One-of: [1955,1957] — the span between the extremes is what can be filtered.
  if (text.startsWith('[') && text.endsWith(']')) {
    const parts = text.slice(1, -1).split(',').map((p) => p.trim()).filter(Boolean);
    const years = parts.map(edtfYear);
    if (years.length === 0 || years.some((y) => y === null)) return null;
    const nums = years as number[];
    return { start: Math.min(...nums), end: Math.max(...nums), isRange: true, qualifier };
  }

  // Interval, including the open-ended forms.
  if (text.includes('/')) {
    const [lo, hi] = text.split('/', 2).map((p) => p.trim());
    const openStart = lo === '..' || lo === '';
    const openEnd = hi === '..' || hi === '';
    const loYear = openStart ? null : edtfYear(lo);
    const hiYear = openEnd ? null : edtfYear(hi);
    if (!openStart && loYear === null) return null;
    if (!openEnd && hiYear === null) return null;
    if (openStart && openEnd) return null;
    const start = loYear ?? EDTF_MIN_YEAR;
    const end = hiYear ?? EDTF_MAX_YEAR;
    if (start > end) return null;
    return { start, end, isRange: true, qualifier };
  }

  // Unspecified trailing digits: 19XX, 195X.
  if (/^\d{1,3}X+$/i.test(text) && text.length === 4) {
    const known = text.replace(/X+$/i, '');
    const pad = 4 - known.length;
    const start = Number(known + '0'.repeat(pad));
    const end = Number(known + '9'.repeat(pad));
    if (start < EDTF_MIN_YEAR || end > EDTF_MAX_YEAR) return null;
    return { start, end, isRange: true, qualifier };
  }

  const single = edtfYear(text);
  if (single === null) return null;
  return { start: single, end: single, isRange: false, qualifier };
}

/** Render a parsed date for display: "1955", "1955–1957", "c. 1850", "1955?". */
export function formatEdtfRange(parsed: ParsedEdtf): string {
  const span = parsed.start === parsed.end ? String(parsed.start) : `${parsed.start}–${parsed.end}`;
  if (parsed.qualifier === 'approximate') return `c. ${span}`;
  if (parsed.qualifier === 'uncertain') return `${span}?`;
  return span;
}

// ─── Standard identifiers ──────────────────────────────────────────────────
//
// Validated but NEVER blocking. A librarian transcribing what is printed in the
// book must always be able to save it — small publishers really do print ISBNs
// with a wrong check digit, and refusing would make the book uncatalogueable.
// The warning tells them; a smart list gathers them for review later.

export function isbn10CheckDigit(first9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(first9[i]);
  const check = (11 - (sum % 11)) % 11;
  return check === 10 ? 'X' : String(check);
}

export function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

export type IsbnCheck = { normalized: string; length: 10 | 13 | null; valid: boolean };

export function checkIsbn(raw: string | null | undefined): IsbnCheck {
  const s = (raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 10) return { normalized: s, length: 10, valid: isbn10CheckDigit(s.slice(0, 9)) === s[9] };
  if (s.length === 13) return { normalized: s, length: 13, valid: isbn13CheckDigit(s.slice(0, 12)) === s[12] };
  return { normalized: s, length: null, valid: false };
}

/**
 * ISBN-10 → ISBN-13, for MATCHING only.
 *
 * The same book carries a 10-digit ISBN on an old printing and a 13-digit one
 * on a new; a lookup or a duplicate check that compares them literally misses.
 * The stored value is left exactly as the librarian entered it.
 */
export function isbn10To13(raw: string | null | undefined): string | null {
  const c = checkIsbn(raw);
  if (c.length !== 10) return null;
  const core = `978${c.normalized.slice(0, 9)}`;
  return core + isbn13CheckDigit(core);
}

export function checkIssn(raw: string | null | undefined): { normalized: string; valid: boolean } {
  const s = (raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length !== 8) return { normalized: s, valid: false };
  let sum = 0;
  for (let i = 0; i < 7; i += 1) sum += Number(s[i]) * (8 - i);
  const rem = 11 - (sum % 11);
  const check = rem === 11 ? '0' : rem === 10 ? 'X' : String(rem);
  return { normalized: s, valid: check === s[7] };
}

// ─── Language codes (ISO 639-2/B) ──────────────────────────────────────────
//
// The catalogue stores two-letter uppercase codes ("EL", "KO") sometimes joined
// with commas ("EL,EN"). MARC 041 wants three-letter ISO 639-2/B codes, one per
// subfield. This maps what is actually in the data; anything unrecognised is
// passed through rather than guessed at.
const ISO639_1_TO_2B: Record<string, string> = {
  el: 'gre', en: 'eng', ko: 'kor', ru: 'rus', fr: 'fre', de: 'ger', it: 'ita',
  es: 'spa', la: 'lat', bg: 'bul', cs: 'cze', tr: 'tur', ar: 'ara', he: 'heb',
  sr: 'srp', ro: 'rum', uk: 'ukr', pl: 'pol', pt: 'por', nl: 'dut', sv: 'swe',
  fi: 'fin', hu: 'hun', ka: 'geo', hy: 'arm', zh: 'chi', ja: 'jpn',
  // Added after the first ISO 2789 run reported these as raw two-letter codes
  // because they were missing here. Church Slavonic above all — it is the
  // liturgical language of the tradition this collection serves, not an
  // afterthought — plus the Balkan and mission-field languages actually on
  // these shelves.
  cu: 'chu', sq: 'alb', mk: 'mac', sl: 'slv', sk: 'slo', hr: 'hrv',
  no: 'nor', da: 'dan', et: 'est', lv: 'lav', lt: 'lit', be: 'bel',
  sw: 'swa', hi: 'hin', fa: 'per', am: 'amh', syr: 'syr', cop: 'cop',
  grc: 'grc'
};

/**
 * Codes accepted on the way IN and never chosen on the way OUT.
 *
 * `ge` was in the table above, alongside the correct `ka`, and the inverse map is
 * built with `Object.fromEntries` — where the LAST key wins. So `geo` inverted to
 * `ge`, which is not an ISO 639-1 code at all (Georgian is `ka`), and a Georgian
 * record survived one MARCXML round trip as `KA` -> `geo` -> `GE`. The comment on
 * that inverse says it is derived rather than rewritten because "a second hand-kept
 * map would drift" — and deriving it from a map that is not injective is exactly
 * where it drifted.
 *
 * An input leniency belongs here, where it cannot reach the inverse.
 */
const ISO639_1_ALIASES: Record<string, string> = {
  ge: 'geo'
};

/** Split a stored language value into ISO 639-2/B codes: "EL,EN" → ["gre","eng"]. */
export function toIso639_2(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[,;/|]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => ISO639_1_TO_2B[part] ?? ISO639_1_ALIASES[part] ?? part)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

// Derived from the CANONICAL table above rather than written out again: a second
// hand-kept map would drift, and a language that exports as `gre` but imports as
// anything else breaks the round trip silently. The aliases are deliberately not in
// that table — an alias in it makes the inversion ambiguous, and `fromEntries` then
// resolves the ambiguity by taking whichever line happens to come last.
const ISO639_2B_TO_1: Record<string, string> = Object.fromEntries(
  Object.entries(ISO639_1_TO_2B).map(([two, three]) => [three, two])
);

/**
 * The inverse of `toIso639_2`: ISO 639-2/B codes back into the two-letter
 * upper-case form the catalogue stores. `["gre","eng"]` → `"EL,EN"`.
 *
 * A code with no two-letter equivalent (grc, chu, syr, cop) is kept as it came,
 * upper-cased — losing it would be worse than storing three letters, and
 * `toIso639_2` passes those straight back out again.
 */
export function fromIso639_2(codes: string[] | null | undefined): string {
  return (codes ?? [])
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .map((c) => (ISO639_2B_TO_1[c] ?? c).toUpperCase())
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(',');
}

// ─── Authority control ─────────────────────────────────────────────────────
//
// One controlled term: a preferred form, the variants that mean the same thing,
// and optionally an id in an external file. Covers names, corporate bodies,
// publishers and subject headings, because they are the same kind of object.

export const AuthorityKindSchema = z.enum(['person', 'corporate', 'publisher', 'subject', 'uniform_title']);
export const AuthoritySourceSchema = z.enum(['local', 'lcsh', 'viaf', 'lc', 'imported']);

// MARC relator codes. Not an invented enum — this is what a MARC export needs
// in $4/$e, and it gives the existing `editor`/`translator` attributes a
// standard home. 'sub' is our marker for a subject heading.
export const MARC_RELATORS = [
  'aut', // author
  'edt', // editor
  'trl', // translator
  'ill', // illustrator
  'cmp', // composer
  'com', // compiler
  'ctb', // contributor
  'pbl', // publisher
  'aui', // author of introduction
  'ann', // annotator
  'sub'  // subject (our marker, not a real relator)
] as const;
export const MarcRelatorSchema = z.enum(MARC_RELATORS);

export const UpsertAuthoritySchema = z.object({
  kind: AuthorityKindSchema,
  preferredForm: z.string().min(1).max(300),
  preferredFormRomanized: z.string().max(300).optional().nullable(),
  source: AuthoritySourceSchema.default('local'),
  viafId: z.string().max(64).optional().nullable(),
  lcId: z.string().max(64).optional().nullable(),
  isni: z.string().max(64).optional().nullable(),
  dates: z.string().max(64).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  variants: z.array(z.string().min(1).max(300)).max(50).default([])
});

// Turn approved category labels into subject headings, in one action.
//
// `GET /api/authorities/subject-candidates` has always been preview-only, and
// deliberately so: which of the 628 labels the librarian wrote are real headings
// is their judgement. But there was no POST to accept the ones they approved, so
// the only way to act on the preview was 628 individual creates.
export const SeedSubjectsSchema = z.object({
  labels: z.array(z.string().min(1).max(300)).min(1).max(500),
  /** Link every book carrying the label to the heading it becomes. */
  link: z.boolean().default(true)
});

export const LinkAuthoritiesSchema = z.object({
  links: z.array(z.object({
    authorityId: z.string().min(1),
    role: MarcRelatorSchema.default('aut')
  })).max(100),
  /*
   * The set of links the caller believes is stored right now.
   *
   * This route REPLACES every heading on a record — it deletes them all and re-inserts the
   * payload — and it had no concurrency control of any kind. Two librarians with the same record
   * open, each adding a heading: the second save deleted the first one's, silently, 200 OK.
   * Reproduced on a real record.
   *
   * The guard compares the HEADINGS rather than `books.version` on purpose. This is a set
   * replacement, and the client that sends it (BookAuthorities) never sees the record version —
   * it holds exactly the list it loaded. Comparing the list detects precisely the conflict that
   * matters and does not refuse a save because somebody corrected the title meanwhile, which a
   * version check would.
   *
   * Optional, so an older client keeps working — it simply gets the old unguarded behaviour
   * rather than a 400.
   */
  expectedLinks: z.array(z.object({
    authorityId: z.string().min(1),
    role: MarcRelatorSchema.default('aut')
  })).max(100).optional()
});

// ─── Multi-part works ──────────────────────────────────────────────────────
//
// Volume designations in this catalogue are free text and genuinely varied:
// "1", "12", "Α'", "τ. 3", "1-2", "ΜΕΡΟΣ Β'". Gap detection is only trustworthy
// if it is explicit about which of those it can and cannot count.

export type VolumeNumber =
  | { kind: 'int'; value: number }
  /** "1-2" — a single physical volume covering a span of the set. */
  | { kind: 'range'; from: number; to: number }
  /** Present but not numeric: "Α'", "τ. γ'". Counted, never used for gaps. */
  | { kind: 'opaque'; raw: string }
  | { kind: 'missing' };

const GREEK_NUMERALS: Record<string, number> = {
  Α: 1, Β: 2, Γ: 3, Δ: 4, Ε: 5, Ϛ: 6, ΣΤ: 6, Ζ: 7, Η: 8, Θ: 9, Ι: 10,
  ΙΑ: 11, ΙΒ: 12, ΙΓ: 13, ΙΔ: 14, ΙΕ: 15, ΙϚ: 16, ΙΣΤ: 16, ΙΖ: 17, ΙΗ: 18, ΙΘ: 19, Κ: 20
};

export function parseVolumeNumber(raw: string | null | undefined): VolumeNumber {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'missing' };

  if (/^\d{1,4}$/.test(text)) return { kind: 'int', value: Number(text) };

  const range = text.match(/^(\d{1,4})\s*[-–/]\s*(\d{1,4})$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from <= to) return { kind: 'range', from, to };
  }

  // A number embedded in noise: "τ. 3", "vol. 12", "ΜΕΡΟΣ 2".
  const embedded = text.match(/(?:^|\D)(\d{1,4})(?:\D|$)/);
  if (embedded) return { kind: 'int', value: Number(embedded[1]) };

  // Greek alphabetic numerals with the keraia — "Α'", "ΙΒ'" — are how this
  // collection numbers its patristic volumes, usually behind a word:
  // "ΜΕΡΟΣ Β'" appears in 110 titles here, so treating it as unnumerable would
  // blind gap detection to a whole series.
  //
  // Each token is tried rather than stripping known prefixes, because JS `\b`
  // is ASCII-only and never matches a boundary next to a Greek letter — a
  // prefix list looked right and silently did nothing.
  const tokens = text.split(/[\s.]+/).filter(Boolean);
  for (const token of tokens) {
    const hasKeraia = /[΄'ʹ’´]/.test(token);
    const greek = token.replace(/[΄'ʹ’´]/g, '').toUpperCase();
    if (!greek || !Object.prototype.hasOwnProperty.call(GREEK_NUMERALS, greek)) continue;
    // A bare letter only counts when it IS the whole value. Otherwise the
    // keraia is required — "Η" is the numeral 8 *and* the Greek definite
    // article, so "Η ΠΑΛΑΙΑ ΔΙΑΘΗΚΗ" would otherwise be read as volume 8.
    if (hasKeraia || tokens.length === 1) {
      return { kind: 'int', value: GREEK_NUMERALS[greek] as number };
    }
  }

  return { kind: 'opaque', raw: text };
}

export type SetGapReport = {
  /** Volume numbers between the lowest and highest held that are absent. */
  missing: number[];
  present: number[];
  /** Volumes counted but not numerable — reported, never silently dropped. */
  unnumbered: number;
  /**
   * false when gap maths would be misleading rather than merely incomplete:
   * mostly-opaque numbering, or an implausible span (one typo'd "1997" would
   * otherwise claim 1,996 missing volumes).
   */
  gapsAvailable: boolean;
  minVol: number | null;
  maxVol: number | null;
};

const MAX_PLAUSIBLE_SET_SPAN = 500;

export function computeSetGaps(rawVolumes: Array<string | null | undefined>, expectedVolumes?: number | null): SetGapReport {
  const present = new Set<number>();
  let unnumbered = 0;

  for (const raw of rawVolumes) {
    const parsed = parseVolumeNumber(raw);
    if (parsed.kind === 'int') present.add(parsed.value);
    else if (parsed.kind === 'range') {
      for (let n = parsed.from; n <= parsed.to; n += 1) present.add(n);
    } else unnumbered += 1;
  }

  const nums = [...present].sort((a, b) => a - b);
  const minVol = nums.length ? (nums[0] as number) : null;
  // An explicit expected count beats inference: a set that should have 29 but
  // whose tail is entirely absent looks complete at 20 otherwise.
  const highestHeld = nums.length ? (nums[nums.length - 1] as number) : null;
  const maxVol = expectedVolumes && highestHeld !== null
    ? Math.max(expectedVolumes, highestHeld)
    : highestHeld;

  const span = minVol !== null && maxVol !== null ? maxVol - minVol : 0;
  const gapsAvailable =
    nums.length > 0 &&
    unnumbered <= nums.length &&
    span <= MAX_PLAUSIBLE_SET_SPAN;

  const missing: number[] = [];
  if (gapsAvailable && minVol !== null && maxVol !== null) {
    for (let n = minVol; n <= maxVol; n += 1) if (!present.has(n)) missing.push(n);
  }
  return { missing, present: nums, unnumbered, gapsAvailable, minVol, maxVol };
}

// ─── Holdings ──────────────────────────────────────────────────────────────
// An Item is one physical copy of a bibliographic record — the shelf-level
// object, as distinct from the edition it is a copy of. Splitting the two is
// what lets one record be held twice (front shelf and back shelf) without
// cataloguing it twice.

export const ItemCoreSchema = z.object({
  // Free text: real volume designations are "Α'", "τ. 3", "1-2".
  volumeNum: z.string().max(64).optional().nullable(),
  volumeLabel: z.string().max(300).optional().nullable(),
  roomCode: z.string().max(64).optional().nullable(),
  shelfCode: z.string().max(64).optional().nullable(),
  callNumber: z.string().max(120).optional().nullable(),
  itemType: z.string().max(40).default('book'),
  condition: z.string().max(120).optional().nullable(),
  acquisitionDate: ISODateTimeSchema.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  // Code 128 payload. Unique across the catalogue when present.
  barcode: z.string().max(64).optional().nullable()
});

export const ItemSchema = ItemCoreSchema.extend({
  id: z.string().min(1),
  bookId: z.string().min(1),
  copyNumber: z.number().int().min(1),
  status: BookStatusSchema,
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
  version: z.number().int().min(0)
});

// Whole-array replace, mirroring PUT /api/books/:id/attributes — the form edits
// a book's copies as one list, and replace keeps the offline queue trivial.
// `id` is optional: present means "update this copy", absent means "add one".
export const ReplaceItemsSchema = z.object({
  expectedVersion: z.number().int().min(0).optional(),
  // ISO 2789 B.2.4 counts withdrawals, and the column to record one has existed
  // since migration 0030 with nothing able to write it. Removing a copy through
  // this endpoint IS a withdrawal, so it can carry the reason.
  withdrawalReason: z.string().max(200).optional().nullable(),
  items: z.array(
    ItemCoreSchema.extend({
      id: z.string().min(1).optional(),
      // Status is owned by the circulation flow, never by this form.
      copyNumber: z.number().int().min(1).optional(),
      // `.default('book')` is stripped here on purpose.
      //
      // ItemCoreSchema defaults itemType so a NEW copy gets a sensible type. This
      // schema also drives the UPDATE of an existing one, and a default turns an
      // omitted field into an assertion: a copy catalogued as a manuscript, a
      // periodical issue or a microform came back as a 'book' on any edit that did
      // not resend the type. That is the same `.default()` trap UpdateBookSchema,
      // UpsertBorrowerSchema and UpsertCustomFieldSchema each avoid by hand; this
      // one had not. The INSERT path below supplies 'book' explicitly instead.
      itemType: z.string().max(40).optional()
    })
  )
    // At least one. A record with no copies is not a record with no copies — it
    // is a record that has fallen out of the catalogue: invisible to every
    // location facet (which filter through EXISTS over items), absent from the
    // ISO 2789 stock count, and with its own shelf_code nulled by
    // syncBookFromItems. An empty array used to be accepted and did exactly
    // that, and the NEXT edit of the record then 500'd forever. Withdrawing the
    // last copy means withdrawing the record, which is what the trash is for.
    .min(1)
    .max(200)
});

// ─── Serial holdings ───────────────────────────────────────────────────────
//
// What is actually on the shelf for a periodical, as a RUN rather than as one
// record per issue. ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ is catalogued as 47 separate books;
// "τόμος 1-10 (1975-1984), λείπει ο τ. 12" says in one line what 47 rows cannot.
// Migration 0026 built the table for this and nothing could read or write it.
//
// `gaps` is free text on purpose: a real gap statement is "τ. 7, 12-14", and a
// numeric model would lose the librarian's own qualification of it.

export const SerialHoldingCoreSchema = z.object({
  /** What the enumeration is called on the piece: "τόμος", "vol.", "έτος". */
  caption: z.string().max(40).optional().nullable(),
  fromVolume: z.string().max(40).optional().nullable(),
  toVolume: z.string().max(40).optional().nullable(),
  fromYear: z.number().int().min(1000).max(3000).optional().nullable(),
  toYear: z.number().int().min(1000).max(3000).optional().nullable(),
  gaps: z.string().max(300).optional().nullable(),
  note: z.string().max(500).optional().nullable()
});

export const SerialHoldingSchema = SerialHoldingCoreSchema.extend({
  id: z.string().min(1),
  bookId: z.string().min(1),
  seq: z.number().int().min(0)
});

// Whole-array replace, like the copies list. An EMPTY array is legitimate here
// and deliberately allowed — unlike copies, where a record with none falls out
// of the catalogue: a periodical whose run nobody has written down yet is a
// normal state, not a broken one.
export const ReplaceSerialHoldingsSchema = z.object({
  expectedVersion: z.number().int().min(0).optional(),
  holdings: z.array(SerialHoldingCoreSchema.extend({ id: z.string().min(1).optional() })).max(50)
});

/**
 * Render one holdings row as a MARC 866 $a statement.
 *
 * 866 is the TEXTUAL holdings field, and it is the honest choice here. The
 * structured alternative is a paired 853 caption pattern and 863 enumeration,
 * which needs a level of detail this catalogue does not hold — emitting a
 * half-filled 853/863 pair would assert a pattern nobody recorded. 866 exists
 * precisely for a summary written out in words.
 *
 * Gaps and notes are NOT folded in here; they belong in $z, so a system reading
 * the statement does not have to guess which part of it is a caveat.
 */
export function formatHoldingStatement(h: {
  caption?: string | null;
  fromVolume?: string | null;
  toVolume?: string | null;
  fromYear?: number | null;
  toYear?: number | null;
}): string {
  const from = (h.fromVolume ?? '').trim();
  const to = (h.toVolume ?? '').trim();
  const enumeration = from && to && from !== to ? `${from}-${to}` : (from || to);
  const caption = (h.caption ?? '').trim();
  const head = [caption, enumeration].filter(Boolean).join(' ');

  const y1 = h.fromYear ?? null;
  const y2 = h.toYear ?? null;
  const years = y1 && y2 && y2 !== y1 ? `${y1}-${y2}` : (y1 ?? y2 ?? null);

  if (head && years) return `${head} (${years})`;
  return head || (years !== null ? String(years) : '');
}

// Add N copies to each of the given books, optionally overriding where they go.
// This is the answer to "29 volumes, each also on the back shelf" — one action
// instead of 29 re-typed records.
export const AddCopiesSchema = z.object({
  bookIds: z.array(z.string().min(1)).min(1).max(500),
  copies: z.number().int().min(1).max(10).default(1),
  shelfCode: z.string().max(64).optional().nullable(),
  roomCode: z.string().max(64).optional().nullable(),
  // A second exemplar of the same volume is not a new position in a set, so
  // the volume designation is dropped unless explicitly kept.
  copyVolume: z.boolean().default(false)
});

export const BorrowBookSchema = z.object({
  // Either pick an existing borrower (preferred — gives them a profile + history)…
  borrowerId: z.string().min(1).optional().nullable(),
  // …or create one inline by passing a name (kept for friction-free workflows).
  borrowerName: z.string().min(1).max(200).optional(),
  borrowerContact: z.string().max(200).optional().nullable(),
  /**
   * OPTIONAL since the loan policies of 0029: absent means "apply the rule for
   * this reader and this kind of copy", which is now the normal case. A value
   * is still honoured — a librarian must be able to say "back on Friday" — and
   * the audit log records that the rule was overridden.
   */
  dueAt: ISODateTimeSchema.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  // WHICH COPY leaves the building. Optional: the older clients (and the mobile
  // app) send only a book id, and the server then takes the lowest-numbered
  // free copy. Naming one is what scanning a copy's barcode does.
  itemId: z.string().min(1).max(64).optional().nullable()
}).refine((v) => Boolean(v.borrowerId) || Boolean(v.borrowerName), {
  // Don't pin the error to a specific path: the form may be picking from the
  // borrowerId combobox or typing borrowerName freely. A form-level error is
  // friendlier than a misleading field-level one.
  message: 'Either borrowerId or borrowerName must be provided.'
});

export const BorrowerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  contact: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  // One axis of the loan-policy matrix. Free text rather than an enum: a
  // library's reader classes are its own business, and the policy table is
  // what gives a category meaning.
  category: z.string().min(1).max(40).default('standard'),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema
});

export const UpsertBorrowerSchema = BorrowerSchema.pick({
  name: true,
  contact: true,
  notes: true
}).extend({
  // Optional so an existing three-field client cannot blank a category it does
  // not know about — PUT /api/borrowers/:id is a full replace. Same
  // preserve-when-absent rule UpdateBookSchema documents for title/tags.
  category: z.string().min(1).max(40).optional()
});

/**
 * What kind of physical thing a copy is.
 *
 * Two jobs at once: the second axis of the loan-policy matrix, and the
 * "collection by document category" breakdown ISO 2789 asks for. Kept short and
 * aligned to that standard's categories rather than exhaustive — a list nobody
 * can choose from correctly is worse than a coarse one, and 'other' is an
 * honest answer.
 *
 * NOT enforced as a DB CHECK: migration 0021 shipped item_type as free text and
 * constraining it now would mean rebuilding the table. The UI offers these; a
 * value from outside the list still stores and still resolves a policy.
 */
export const ITEM_TYPES = [
  'book',
  'serial',
  'manuscript',
  'audiovisual',
  'cartographic',
  'microform',
  'electronic',
  'other'
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

// ─── Loan policies, renewals and holds ──────────────────────────────────────

export const LoanPolicySchema = z.object({
  /** '*' matches any borrower category. */
  borrowerCategory: z.string().min(1).max(40).default('*'),
  /** '*' matches any item type. */
  itemType: z.string().min(1).max(40).default('*'),
  // A year is the outer bound of anything a library would call a loan; beyond
  // that is a typo, and a typo here is applied to every future borrow.
  loanDays: z.number().int().min(1).max(365).default(14),
  renewalLimit: z.number().int().min(0).max(20).default(2),
  /** Null = a renewal runs for another full loan period. */
  renewalDays: z.number().int().min(1).max(365).optional().nullable(),
  /** Null = unlimited. */
  maxConcurrentLoans: z.number().int().min(1).max(1000).optional().nullable(),
  /** false = consultation only; this copy never leaves the building. */
  lendable: z.boolean().default(true),
  notes: z.string().max(500).optional().nullable()
});

export const ReplaceLoanPoliciesSchema = z.object({
  // Whole-array replace, mirroring the items and attributes editors: the rules
  // are read as a table and edited as one.
  policies: z.array(LoanPolicySchema).max(200)
});

export const PlaceHoldSchema = z.object({
  borrowerId: z.string().min(1).optional().nullable(),
  borrowerName: z.string().min(1).max(200).optional(),
  borrowerContact: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable()
}).refine((v) => Boolean(v.borrowerId) || Boolean(v.borrowerName), {
  message: 'Either borrowerId or borrowerName must be provided.'
});

export const RenewLoanSchema = z.object({
  /**
   * How many times the operator believes this loan has already been renewed.
   *
   * A renewal is not idempotent and the web client retries a write four times
   * on a 5xx, so without a precondition a lost response silently extends the
   * loan twice. This is the RELIABLE precondition: the count strictly
   * increases, so a replay can never match.
   *
   * `expectedDueAt` cannot do this job on its own — renewing a fresh loan for
   * the same period lands on the same calendar date, and a replay would then
   * still match. Measured, not assumed: it consumed a second renewal.
   */
  expectedRenewalCount: z.number().int().min(0).max(100).optional().nullable(),
  /** The due date on the operator's screen. A secondary staleness check. */
  expectedDueAt: ISODateTimeSchema.optional().nullable(),
  notes: z.string().max(2000).optional().nullable()
});

export const ReturnBookSchema = z.object({
  notes: z.string().max(2000).optional().nullable(),
  // Which loan the operator believes they are closing. Optional for backward
  // compatibility, but when present the server refuses to close a different
  // one — a screen left open while someone else returned and re-lent the book
  // would otherwise silently close the NEW borrower's loan.
  transactionId: z.string().min(1).max(64).optional().nullable()
});

export const RoomSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  mapMetadata: z.record(z.string(), z.union([z.string().max(FACET_VALUE_MAX), z.number(), z.boolean(), z.null()])).default({}),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema
});

export const UpsertRoomSchema = RoomSchema.pick({
  code: true,
  name: true,
  description: true,
  mapMetadata: true
});

export const CustomFieldTypeSchema = z.enum(['text', 'number', 'boolean', 'date', 'enum']);

export const CustomFieldSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/),
  label: z.string().min(1).max(200),
  type: CustomFieldTypeSchema,
  required: z.boolean(),
  // Pinned attributes lead every attribute list, in `sortOrder`, so the fields
  // the librarian fills on nearly every book aren't buried among the rare ones.
  pinned: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  enumOptions: z.array(z.string().max(100)).default([]),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema
});

export const UpsertCustomFieldSchema = CustomFieldSchema.pick({
  key: true,
  label: true,
  type: true,
  required: true,
  enumOptions: true
}).extend({
  // Declared OPTIONAL here rather than picked from CustomFieldSchema, whose
  // `.default(false)` would make an omitted value indistinguishable from an
  // explicit `false`. A client that predates pinning — or simply a browser tab
  // left open across the deploy — omits these; defaulting them would silently
  // UNPIN an attribute as a side effect of renaming its label. Absent means
  // "leave the current placement alone" (the update handler falls back to the
  // stored row); on create there is nothing to fall back to, so it means
  // unpinned/0.
  pinned: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional()
}).superRefine((value, ctx) => {
  if (ReservedBookAttributeKeys.has(value.key)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['key'],
      message: 'This key is reserved by a standard book attribute. Choose another key.'
    });
  }

  if (value.type === 'enum' && value.enumOptions.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enumOptions'],
      message: 'Enum type requires at least one option.'
    });
  }

  if (value.type !== 'enum' && value.enumOptions.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enumOptions'],
      message: 'Enum options are only allowed when type is enum.'
    });
  }
});

export const CodeTypeSchema = z.enum(['qr', 'barcode']);

export const GenerateCodeSchema = z.object({
  type: CodeTypeSchema,
  label: z.string().max(120).optional().nullable()
});

export const CodeAssignmentSchema = z.object({
  id: z.string().min(1),
  bookId: z.string().min(1),
  type: CodeTypeSchema,
  value: z.string().min(1),
  label: z.string().max(120).nullable(),
  active: z.boolean(),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema
});

export const BookFilterQuerySchema = z.object({
  q: z.string().max(200).optional(),
  qMode: z.enum(['all', 'any', 'exact']).default('all'),
  qExclude: z.string().max(200).optional(),
  partialWords: ZodQueryBoolean.default(true),
  // Fuzzy is on by default: typos and accents shouldn't block librarians from
  // finding the book they're looking for. The server caps the candidate set so
  // it stays fast even at 20K rows.
  fuzzyTypos: ZodQueryBoolean.default(true),
  searchFields: z.string().max(200).optional(),
  status: BookStatusSchema.optional(),
  language: z.string().max(50).optional(),
  year: z.coerce.number().int().min(1000).max(3000).optional(),
  yearMin: z.coerce.number().int().min(1000).max(3000).optional(),
  yearMax: z.coerce.number().int().min(1000).max(3000).optional(),
  roomCode: z.string().max(64).optional(),
  shelfCode: z.string().max(64).optional(),
  // Smart-list filters: each maps to a WHERE clause server-side. Composable.
  missingIsbn: ZodQueryBoolean.optional(),
  missingShelf: ZodQueryBoolean.optional(),
  untitled: ZodQueryBoolean.optional(),
  unknownAuthor: ZodQueryBoolean.optional(),
  // Books whose ISBN check digit does not compute. Reads the generated column
  // added in migration 0031 — the value has been available on every record
  // since Phase B but was unreachable from a query until it became a column.
  invalidIsbn: ZodQueryBoolean.optional(),
  // Facet-rail selection. `facetField` + `facetValue` matches ONE exact value of
  // a whitelisted field; `emptyField` matches "nothing recorded here" — the
  // rail's `(empty)` bucket.
  //
  // These exist rather than reusing `language`/`shelfCode`/`custom_<key>`
  // because those apply looser predicates: `language` resolves synonyms and
  // matches as a substring (so "EL" also catches "EL,EN"), `shelfCode` is a
  // substring match, and `custom_<key>=` compares the extracted value to ''
  // which misses rows where the key is absent altogether. Any of those makes
  // the rail's count differ from the list it opens — and the librarian is using
  // that exact pair to reconcile the catalogue against a physical shelf, so a
  // count that doesn't reproduce is worse than no count at all.
  facetField: z.string().max(80).optional(),
  facetValue: z.string().max(FACET_VALUE_MAX).optional(),
  emptyField: z.string().max(80).optional(),
  includeDeleted: ZodQueryBoolean.optional(),
  sortBy: z.enum(['title', 'author', 'updatedAt', 'publicationYear', 'status']).default('updatedAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

export const SyncPushMutationSchema = z.object({
  operation: z.enum(['create_book', 'update_book', 'delete_book', 'borrow_book', 'return_book']),
  payload: z.record(z.string(), z.unknown()),
  clientMutationId: z.string().min(1),
  clientTimestamp: ISODateTimeSchema
});

export const SyncPushSchema = z.object({
  mutations: z.array(SyncPushMutationSchema).max(200)
});

export const ImportBooksSchema = z.object({
  dryRun: z.boolean().default(true),
  // Rows carry the optional `legacyId` from BookCoreSchema — a stable key from
  // the source spreadsheet. Without one, importing the same file twice creates
  // a second copy of every book; with one, the second run updates the first.
  rows: z.array(CreateBookSchema).max(2000)
});

// Catalogue-import path is permissive: rows from a real-world XLSX often have
// blank titles, blank authors, multi-language tags, or category codes that
// look numeric. The server normalizes these — we just need to accept them.
export const CatalogImportRowSchema = z.object({
  legacyId: z.string().min(1).max(64).optional().nullable(),
  title: z.string().max(500).optional().nullable(),
  author: z.string().max(500).optional().nullable(),
  isbn: z.string().max(64).optional().nullable(),
  publicationYear: z.number().int().min(1000).max(3000).optional().nullable(),
  publisher: z.string().max(300).optional().nullable(),
  language: z.string().max(120).optional().nullable(),
  description: z.string().max(8000).optional().nullable(),
  shelfCode: z.string().max(64).optional().nullable(),
  needsReview: z.boolean().optional(),
  customFields: z.record(z.string(), z.union([z.string().max(FACET_VALUE_MAX), z.number(), z.boolean(), z.null()])).default({})
});

export const ImportCatalogSchema = z.object({
  dryRun: z.boolean().default(true),
  // Each call carries up to 1000 catalog rows; the frontend chunks the file.
  rows: z.array(CatalogImportRowSchema).max(1000)
});

export type BookStatus = z.infer<typeof BookStatusSchema>;
export type Book = z.infer<typeof BookSchema>;
export type CreateBookInput = z.infer<typeof CreateBookSchema>;
export type UpdateBookInput = z.infer<typeof UpdateBookSchema>;
export type BorrowBookInput = z.infer<typeof BorrowBookSchema>;
export type ReturnBookInput = z.infer<typeof ReturnBookSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type CustomField = z.infer<typeof CustomFieldSchema>;
export type CodeAssignment = z.infer<typeof CodeAssignmentSchema>;
export type CatalogImportRow = z.infer<typeof CatalogImportRowSchema>;
export type Borrower = z.infer<typeof BorrowerSchema>;
export type UpsertBorrowerInput = z.infer<typeof UpsertBorrowerSchema>;

// Code 128, in its own module because it is a lookup table and a checksum
// rather than a schema. Re-exported here so callers keep one import path.
export { code128Values, code128Pattern, code128Svg, formatItemBarcode } from './code128';
export type { Code128SvgOptions } from './code128';

// ─── CSV ───────────────────────────────────────────────────────────────────

/**
 * One CSV cell, quoted and made safe to open in a spreadsheet.
 *
 * Lives here because there are TWO export paths — the Worker's `toCsv` and the
 * Library tab's "Export CSV" button — and they had drifted: the server neutralised
 * formula injection and the browser did not, on the same data, for the same
 * librarian, opened in the same spreadsheet. A defence that exists on one of two
 * paths is a defence that is not deployed.
 *
 * A cell beginning `=`, `+`, `-`, `@`, or a leading tab/CR is read as a FORMULA by
 * Excel, LibreOffice and Sheets, so a catalogued title like `=HYPERLINK(...)` or
 * `+cmd|...` would execute when the export is opened. A leading apostrophe is the
 * spreadsheet convention for "force text"; it is hidden on display. These exports
 * are opened, not re-imported — the app imports XLSX — so nothing round-trips it.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}
