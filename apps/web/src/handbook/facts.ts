// The facts, held apart from the prose and never translated.
//
// A Handbook that misstates a MARC tag is worse than no Handbook: the librarian
// acts on it, and the error leaves the building inside an exported record. If
// "MARC 245$a" were written into the English chapter and then again into the
// Greek, Russian and Korean ones, four copies of one fact would sit in four files
// that are edited months apart — and being wrong in exactly one of them is both
// the likeliest outcome and the hardest to notice.
//
// So every tag, subfield and internal field name lives here once. The prose
// supplies sentences; this supplies the spine. `check_handbook.mjs` asserts that
// no content pack states a tag TOGETHER WITH ITS SUBFIELD — that is the shape a
// copy of a fact takes. A bare tag number with no subfield is deliberately
// allowed and one is deliberately used: the transliteration chapter writes "880"
// in all four languages because it is the token a librarian quotes to a partner
// library. The check holds those to facts.ts too — a bare tag named in the prose
// must still be declared here — so the eight mentions cannot outlive the fact.
//
// `field` is the name the API and the forms use, so a reader can move between the
// Handbook and the screen without guessing.

export type FieldFact = {
  /**
   * The field's name as the ENGLISH form labels it — "Kind of publication",
   * "Shelf mark". Not translated, and it cannot be: a `fields` row is
   * `{ fact, note }`, so a pack can translate the note beside a row and nothing
   * else, and the table prints this string raw. The comment here used to say
   * "translated per pack", which promised a mechanism that has never existed and
   * hid the consequence — a Greek reader sees "Publisher" beside a form that says
   * Εκδότης, in a drawer they opened because they did not recognise the field.
   *
   * Left in English deliberately for now, and the packs' review docs record why:
   * the two columns this table is FOR — the `field` key and the MARC tag — are
   * language-independent identifiers, and the per-pack `note` is where a
   * translation names the field in the reader's own words. Translating the label
   * itself needs a key here and a `t()` in the renderer; that is a code change,
   * not a prose one, and until it is made this comment must not claim it.
   */
  label: string;
  /** The key the API uses. Deliberately the real one. */
  field: string;
  /** MARC 21 tag and subfield, or null where the catalogue has no MARC home. */
  marc: string | null;
  /** Dublin Core element, where one applies. */
  dc: string | null;
  /** Which standard says so, for the sceptical reader. */
  standard?: string;
};

export const FIELD_FACTS = {
  title: { label: 'Title', field: 'title', marc: '245 $a', dc: 'dc:title', standard: 'ISBD Area 1' },
  subtitle: { label: 'Other title information', field: 'customFields.subTitle', marc: '245 $b', dc: null, standard: 'ISBD Area 1' },
  titleRomanized: { label: 'Title, romanized', field: 'titleRomanized', marc: '880 ‡6 245', dc: 'dc:title', standard: 'ISO 843' },
  author: { label: 'Author', field: 'author', marc: '100 $a', dc: 'dc:creator', standard: 'ISBD Area 1' },
  // `dc` is null, and not for want of an element to map to: `toDublinCoreXml`
  // emits the romanized TITLE as a second dc:title and never emits the romanized
  // author at all, so a harvester taking oai_dc receives the vernacular author
  // only. This said `dc:creator` and was therefore a promise about what leaves
  // the building that the exporter does not keep. It goes back to `dc:creator`
  // the moment marc.ts emits it.
  authorRomanized: { label: 'Author, romanized', field: 'authorRomanized', marc: '880 ‡6 100', dc: null, standard: 'ISO 843' },
  authorDates: { label: 'Author dates', field: 'authorities.dates', marc: '100 $d', dc: null },
  contributor: { label: 'Other contributor', field: 'authorities (role)', marc: '700 $a $4', dc: 'dc:contributor', standard: 'MARC relators' },
  subject: { label: 'Subject', field: 'authorities (kind=subject)', marc: '650 $a', dc: 'dc:subject' },
  publisher: { label: 'Publisher', field: 'publisher', marc: '264 $b', dc: 'dc:publisher', standard: 'ISBD Area 4' },
  place: { label: 'Place of publication', field: 'customFields.place_of_publication', marc: '264 $a', dc: null, standard: 'ISBD Area 4' },
  date: { label: 'Date of publication', field: 'dateEdtf', marc: '264 $c', dc: 'dc:date', standard: 'EDTF / ISO 8601-2' },
  edition: { label: 'Edition', field: 'customFields.edition', marc: '250 $a', dc: null, standard: 'ISBD Area 2' },
  extent: { label: 'Extent', field: 'customFields.pages', marc: '300 $a', dc: 'dc:format', standard: 'ISBD Area 5' },
  isbn: { label: 'ISBN', field: 'isbn', marc: '020 $a', dc: 'dc:identifier', standard: 'ISO 2108' },
  issn: { label: 'ISSN', field: 'customFields.issn', marc: '022 $a', dc: 'dc:identifier', standard: 'ISO 3297' },
  language: { label: 'Language', field: 'language', marc: '008/35-37, 041 $a', dc: 'dc:language', standard: 'ISO 639-2/B' },
  ddc: { label: 'Dewey number', field: 'ddc', marc: '082 $a', dc: null, standard: 'DDC 23' },
  localClass: { label: 'Shelf classification', field: 'customFields.category_code', marc: '090 $a', dc: null },
  series: { label: 'Series', field: 'customFields.series', marc: '490 $a', dc: 'dc:relation', standard: 'ISBD Area 6' },
  // Not `volumeDesignation`, which is what this said. `books.volume_designation`
  // (migration 0024) is READ everywhere — the exporter prefers it for 490 $v, set
  // gap detection prefers it — and can be written by nothing: it is absent from
  // BookCoreSchema, so the API drops it silently, and the form and the MARCXML
  // import both write `volume_num`. It is NULL on every row in the catalogue. The
  // same failure the code already documents for `bib_level`, one column over, and
  // the Handbook was stating it as the field to fill. `volume_num` is what the
  // screen writes and what the exporter falls back to, so 490 $v still holds.
  volume: { label: 'Volume number', field: 'customFields.volume_num', marc: '490 $v', dc: null },
  bibLevel: { label: 'Kind of publication', field: 'bibLevel', marc: 'leader/07, 008/06', dc: 'dc:type', standard: 'IFLA LRM' },
  description: { label: 'Note', field: 'description', marc: '520 $a', dc: 'dc:description' },
  shelfCode: { label: 'Shelf mark', field: 'items[].shelfCode', marc: '852 $c', dc: null },
  roomCode: { label: 'Room', field: 'items[].roomCode', marc: '852 $b', dc: null },
  callNumber: { label: 'Call number', field: 'items[].callNumber', marc: '852 $h', dc: null },
  barcode: { label: 'Barcode', field: 'items[].barcode', marc: '852 $p', dc: null, standard: 'Code 128' },
  copyNumber: { label: 'Copy number', field: 'items[].copyNumber', marc: '852 $t', dc: null },
  serialRun: { label: 'Run held', field: 'serialHoldings', marc: '866 $a', dc: null },
  isil: { label: 'Library code', field: 'librarySettings.isil', marc: '003, 852 $a', dc: null, standard: 'ISO 15511' }
} as const satisfies Record<string, FieldFact>;

export type FieldFactKey = keyof typeof FIELD_FACTS;

/**
 * Standards this catalogue actually implements, for the chapter that says so.
 *
 * Only what is implemented. A list that claims conformance the code does not have
 * is the same failure as a misstated tag, one level up.
 */
export const STANDARDS = [
  { code: 'MARC 21', what: 'Bibliographic and holdings format', where: 'Export and import, SRU, OAI-PMH' },
  { code: 'Dublin Core', what: 'Fifteen-element metadata set', where: 'OAI-PMH, SRU' },
  { code: 'ISBD', what: 'Areas of description and their punctuation', where: 'Added when a record is exported' },
  { code: 'IFLA LRM', what: 'Record vs copy, monograph vs serial', where: 'The copies layer and Kind of publication' },
  { code: 'EDTF (ISO 8601-2)', what: 'Uncertain and approximate dates', where: 'Date of publication' },
  { code: 'ISO 639-2/B', what: 'Three-letter language codes', where: 'MARC 008 and 041 on export' },
  { code: 'ISO 843', what: 'Romanization of Greek', where: 'The romanized title and author fields' },
  { code: 'ISO 15511', what: 'ISIL, the library identifier', where: 'Library identity, MARC 003 and 852' },
  { code: 'ISO 2789', what: 'Library statistics', where: 'The statistics report' },
  { code: 'Code 128', what: 'Barcode symbology', where: 'Copy barcodes and labels' },
  { code: 'SRU 1.2', what: 'Search and retrieve over HTTP', where: 'Open to peer libraries when sharing is on' },
  { code: 'OAI-PMH 2.0', what: 'Metadata harvesting', where: 'Open to harvesters when sharing is on' },
  { code: 'WCAG 2.1 AA', what: 'Accessibility', where: 'This interface' }
] as const;
