/**
 * MARC 21 and Dublin Core mapping.
 *
 * One module, used in both directions: export renders a record to MARCXML /
 * MARC-in-JSON / Dublin Core, and ingest reads MARCXML back. Keeping the field
 * table in a single place is what stops the two from drifting — a tag that
 * exports as 260$b but imports as 264$b silently loses the publisher on every
 * round trip.
 *
 * The XLSX and CSV paths are untouched by any of this. They remain the
 * librarian's everyday route; MARC is for exchange with other libraries.
 */

import { EDTF_SENTINEL_MAX, EDTF_SENTINEL_MIN, formatHoldingStatement, fromIso639_2, toIso639_2 } from '@ok-library/shared';

export type MarcSubfield = { code: string; value: string };
export type MarcField =
  | { tag: string; value: string }
  | { tag: string; ind1: string; ind2: string; subfields: MarcSubfield[] };

export type MarcRecordInput = {
  id: string;
  title: string;
  titleRomanized?: string | null;
  subtitle?: string | null;
  author: string;
  authorRomanized?: string | null;
  isbn?: string | null;
  issn?: string | null;
  publisher?: string | null;
  publisherRomanized?: string | null;
  placeOfPublication?: string | null;
  dateEdtf?: string | null;
  publicationYear?: number | null;
  publicationYearEnd?: number | null;
  /** ISBD area 5, free text: "156,[3]σ. ; 21εκ." */
  extent?: string | null;
  language?: string | null;
  description?: string | null;
  ddc?: string | null;
  localClass?: string | null;
  edition?: string | null;
  seriesTitle?: string | null;
  volumeDesignation?: string | null;
  bibLevel?: string | null;
  updatedAt?: string | null;
  /** Contributors resolved through the authority file, with relator codes. */
  contributors?: Array<{ name: string; role: string; dates?: string | null; kind?: string | null }>;
  subjects?: Array<{ term: string; source?: string | null }>;
  /** The recorded run of a periodical — MARC 866 textual holdings. */
  serialHoldings?: Array<{
    caption?: string | null;
    fromVolume?: string | null;
    toVolume?: string | null;
    fromYear?: number | null;
    toYear?: number | null;
    gaps?: string | null;
    note?: string | null;
  }>;
  /** Physical copies — MARC 852 holdings. */
  items?: Array<{
    shelfCode?: string | null;
    roomCode?: string | null;
    callNumber?: string | null;
    barcode?: string | null;
    copyNumber?: number | null;
  }>;
  isil?: string | null;
};

/** MARC relator codes we emit, mapped to the added-entry tag they belong in. */
const RELATOR_TAG: Record<string, string> = {
  aut: '100',
  edt: '700',
  trl: '700',
  ill: '700',
  cmp: '700',
  ctb: '700'
};

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * ISBD punctuation, applied at RENDER time only.
 *
 * Entry stays free-form — asking a working librarian to type " : " before every
 * subtitle would slow cataloguing down for no benefit they can see. The
 * punctuation that other systems expect is added when the record leaves.
 */
function isbd(value: string, trailing: string): string {
  const trimmed = value.trim().replace(/[\s.,:;/]+$/, '');
  return trimmed ? trimmed + trailing : '';
}

/**
 * Build the MARC field list for one record.
 *
 * Parallel script forms become 880 fields linked with $6, which is how MARC
 * carries a vernacular/romanized pair — the whole reason those columns exist.
 */
/**
 * MARC 21 008 — forty fixed positions, and the field an importing system reads
 * for the language and the publication date.
 *
 *   00-05  date entered on file, yymmdd
 *   06     type of date   s = single, m = multiple, q = questionable,
 *                         c = continuing and still published, n = unknown
 *   07-10  date 1         four digits, or uuuu
 *   11-14  date 2         blank for a single date, 9999 for an open serial
 *   15-17  place of publication, MARC country code
 *   18-34  material-specific; '|' throughout means "no attempt to code",
 *          which is the honest answer for a catalogue that does not record
 *          illustration statements or literary form
 *   35-37  language, ISO 639-2/B
 *   38     modified record, blank = not modified
 *   39     cataloguing source, d = other
 *
 * `|` is the standard fill character, and a wrong code here is worse than an
 * uncoded one: it asserts something about the book that nobody checked.
 */
function marc008(book: MarcRecordInput): string {
  const entered = (book.updatedAt ?? '').replace(/[-:TZ.]/g, '').slice(2, 8) || '000000';
  const serial = book.bibLevel === 'serial';
  // EDTF's OPEN ends are stored as sort sentinels, not as dates.
  //
  // `parseEdtf` substitutes 1000 for an unknown start and 3000 for an unknown end
  // so that "../1960" and "1960/.." can be sorted and range-filtered alongside real
  // years. They are machinery, and this function was reading them as though a
  // cataloguer had written them down: "before 1960" was exported as a work
  // published from the year 1000, and "1960 onwards" as ceasing in 3000. That is
  // exactly what the note above forbids — asserting something about the book that
  // nobody checked — and it leaves the building inside a record a partner library
  // ingests.
  //
  // MARC has codes for these cases and they are used below: 'u' fills an unknown
  // digit and 9999 an open end.
  const openStart = book.publicationYear === EDTF_SENTINEL_MIN;
  const openEnd = book.publicationYearEnd === EDTF_SENTINEL_MAX;
  const y1 = openStart ? null : book.publicationYear;
  const y2 = openEnd ? null : book.publicationYearEnd;
  // A '?' or '~' in the EDTF expression is the librarian saying the date is
  // uncertain or approximate; MARC has a code for exactly that.
  const uncertain = /[?~]/.test(book.dateEdtf ?? '');

  let type: string;
  let date1: string;
  let date2: string;
  if (serial) {
    // 'c' is "continuing, currently published"; 'd' would be "ceased". Nothing
    // in this catalogue records a cessation, and a librarian marks a title a
    // serial precisely because it keeps arriving — so 9999 unless a real range
    // was authored. `publicationYearEnd` falls back to `publicationYear` on
    // read, which is right for a book (published 1987, spans 1987) and a false
    // claim for a periodical: it coded ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ as having stopped
    // in the year it started.
    type = 'c';
    date1 = y1 ? String(y1).padStart(4, '0') : 'uuuu';
    date2 = y2 && y1 && y2 > y1 ? String(y2).padStart(4, '0') : '9999';
  } else if (openStart && book.publicationYearEnd) {
    // "no later than 1960". MARC's continuum type for an unknown start with a
    // known end: 'uuuu' says the first date is not known, rather than inventing one.
    type = 'm';
    date1 = 'uuuu';
    date2 = String(book.publicationYearEnd).padStart(4, '0');
  } else if (openEnd && y1) {
    // "1960 onwards" — 9999 is MARC's open end, the same code the serial branch uses.
    type = 'm';
    date1 = String(y1).padStart(4, '0');
    date2 = '9999';
  } else if (y1 && y2 && y2 !== y1) {
    type = 'm';
    date1 = String(y1).padStart(4, '0');
    date2 = String(y2).padStart(4, '0');
  } else if (y1) {
    type = uncertain ? 'q' : 's';
    date1 = String(y1).padStart(4, '0');
    // A questionable date is a RANGE in MARC, so date2 has to carry the other
    // end of it; a single date leaves the field blank.
    date2 = uncertain ? String(y1).padStart(4, '0') : '    ';
  } else {
    type = 'n';
    date1 = 'uuuu';
    date2 = 'uuuu';
  }

  // The place is transcribed free text ("Θεσσαλονίκη"), and there is no
  // reliable way from that to a MARC country code. 'xx ' is the code for
  // "no place, unknown or undetermined" — the truthful one.
  const place = 'xx ';
  const lang = (toIso639_2(book.language)[0] ?? 'und').slice(0, 3).padEnd(3, ' ');

  const value = entered.padEnd(6, '0') + type + date1 + date2 + place + '|'.repeat(17) + lang + ' ' + 'd';
  // Same reasoning as the leader: a mis-sized 008 makes the record unreadable
  // elsewhere and fails silently here.
  if (value.length !== 40) throw new Error(`MARC 008 must be 40 chars, got ${value.length}: ${value}`);
  return value;
}

export function toMarcFields(book: MarcRecordInput): MarcField[] {
  const fields: MarcField[] = [];
  const df = (tag: string, ind1: string, ind2: string, subs: Array<[string, string | null | undefined]>): void => {
    const subfields = subs
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
      .map(([code, v]) => ({ code, value: String(v).trim() }));
    if (subfields.length > 0) fields.push({ tag, ind1, ind2, subfields });
  };

  fields.push({ tag: '001', value: book.id });
  if (book.isil) fields.push({ tag: '003', value: book.isil });
  if (book.updatedAt) {
    // 005 is yyyymmddhhmmss.f
    fields.push({ tag: '005', value: book.updatedAt.replace(/[-:TZ]/g, '').slice(0, 14) + '.0' });
  }

  // 008, the fixed-length data elements. 35-37 is where a MARC reader looks for
  // the language of a record — 041 is the supplementary field, used when a work
  // is a translation or is in more than one language. Exporting 041 alone left
  // every importing system with no language in the slot it actually reads.
  fields.push({ tag: '008', value: marc008(book) });

  df('020', ' ', ' ', [['a', book.isbn]]);
  df('022', ' ', ' ', [['a', book.issn]]);
  // 041 wants ISO 639-2/B. The catalogue stores ISO 639-1 in upper case ("EL"),
  // which the comment here used to claim was already the right shape — so every
  // record exported a code no MARC system recognises. `toIso639_2` is the map,
  // and it has existed since B7.
  //
  // ind1 = 1 marks a record that includes a translation; with one language the
  // field is redundant beside 008 and is emitted anyway, because a reader that
  // ignores 008 still finds it.
  const langs = toIso639_2(book.language);
  df('041', langs.length > 1 ? '1' : '0', ' ', langs.map((l) => ['a', l] as [string, string]));
  df('082', '0', '4', [['a', book.ddc], ['2', book.ddc ? '23' : null]]);
  // 090 is the conventional local-classification slot.
  df('090', ' ', ' ', [['a', book.localClass]]);

  const mainAuthor = book.contributors?.find((c) => c.role === 'aut');
  if (mainAuthor || book.author) {
    df('100', '1', ' ', [
      ['a', mainAuthor?.name ?? book.author],
      ['d', mainAuthor?.dates],
      ['4', 'aut']
    ]);
  }

  // 245: title proper $a, other title info $b, statement of responsibility $c.
  // ind2 counts non-filing characters; 0 because the catalogue stores titles
  // without leading articles.
  df('245', book.author ? '1' : '0', '0', [
    ['a', isbd(book.title, book.subtitle ? ' :' : ' /')],
    ['b', book.subtitle ? isbd(book.subtitle, ' /') : null],
    ['c', book.author || null]
  ]);

  df('250', ' ', ' ', [['a', book.edition]]);

  // 264 _1 is the RDA production/publication statement; 260 is kept alongside
  // because plenty of systems still only read that one.
  const dateForImprint = book.dateEdtf ?? (book.publicationYear ? String(book.publicationYear) : null);
  df('264', ' ', '1', [
    ['a', book.placeOfPublication ? isbd(book.placeOfPublication, ' :') : null],
    ['b', book.publisher ? isbd(book.publisher, ',') : null],
    ['c', dateForImprint]
  ]);
  df('260', ' ', ' ', [
    ['a', book.placeOfPublication ? isbd(book.placeOfPublication, ' :') : null],
    ['b', book.publisher ? isbd(book.publisher, ',') : null],
    ['c', dateForImprint]
  ]);

  // 300$a is free text — this is why `pages` became an extent field.
  df('300', ' ', ' ', [['a', book.extent]]);
  df('490', '0', ' ', [['a', book.seriesTitle], ['v', book.volumeDesignation]]);
  df('520', ' ', ' ', [['a', book.description]]);

  for (const c of book.contributors ?? []) {
    if (c.role === 'aut') continue;
    const tag = RELATOR_TAG[c.role] ?? '700';
    df(tag, c.kind === 'corporate' ? '2' : '1', ' ', [['a', c.name], ['d', c.dates], ['4', c.role]]);
  }

  for (const s of book.subjects ?? []) {
    // ind2 identifies the thesaurus: 0 = LCSH, 7 = source named in $2.
    const lcsh = (s.source ?? '').toLowerCase() === 'lcsh';
    df('650', ' ', lcsh ? '0' : '7', [['a', s.term], ['2', lcsh ? null : 'local']]);
  }

  // 852 — holdings. One field per physical copy.
  for (const item of book.items ?? []) {
    df('852', ' ', ' ', [
      ['a', book.isil],
      ['b', item.roomCode],
      ['c', item.shelfCode],
      ['h', item.callNumber],
      ['p', item.barcode],
      ['t', item.copyNumber ? String(item.copyNumber) : null]
    ]);
  }

  // 866 — textual holdings for the basic bibliographic unit. This is the field
  // for a run written out in words, which is exactly what the catalogue holds;
  // the structured alternative is a paired 853 caption pattern and 863
  // enumeration, and emitting a half-filled pair would assert a pattern nobody
  // recorded. ind1 '3' is holdings level 3 (a summary), ind2 '0' compressed.
  //
  // Gaps and notes go in $z rather than being folded into $a, so a system
  // reading the statement does not have to guess which part is a caveat.
  for (const h of book.serialHoldings ?? []) {
    const statement = formatHoldingStatement(h);
    const note = [h.gaps, h.note].map((v) => (v ?? '').trim()).filter(Boolean).join('; ');
    df('866', '3', '0', [['a', statement], ['z', note]]);
  }

  // 880: the vernacular/romanized pairs, linked back by $6 occurrence number.
  let occ = 0;
  const linked = (tag: string, value: string | null | undefined, code = 'a'): void => {
    if (!value || !value.trim()) return;
    occ += 1;
    const seq = String(occ).padStart(2, '0');
    fields.push({
      tag: '880', ind1: ' ', ind2: ' ',
      subfields: [{ code: '6', value: `${tag}-${seq}` }, { code, value: value.trim() }]
    });
  };
  linked('245', book.titleRomanized);
  linked('100', book.authorRomanized);
  linked('264', book.publisherRomanized, 'b');

  return fields;
}

/**
 * MARC 21 leader — 24 fixed positions.
 *
 *   00-04 record length (00000 in XML, the parser recomputes it)
 *   05    record status        n = new
 *   06    type of record       a = language material
 *   07    bibliographic level  m = monograph, s = serial
 *   08    type of control      blank
 *   09    character coding     a = Unicode
 *   10-11 indicator / subfield code count, always "22"
 *   12-16 base address (00000, likewise recomputed)
 *   17    encoding level       blank = full
 *   18    cataloguing form     i = ISBD punctuation present (we add it on render)
 *   19    multipart level      blank
 *   20-23 entry map, always "4500"
 */
function marcLeader(book: MarcRecordInput): string {
  const level = book.bibLevel === 'serial' ? 's' : 'm';
  const leader = `00000na${level} a2200000 i 4500`;
  // A malformed leader makes a record unreadable to every other system, and the
  // failure is silent — so assert the width rather than trust the template.
  if (leader.length !== 24) throw new Error(`MARC leader must be 24 chars, got ${leader.length}`);
  return leader;
}

export function toMarcXml(book: MarcRecordInput): string {
  const parts: string[] = [];
  parts.push('  <record>');
  parts.push(`    <leader>${marcLeader(book)}</leader>`);
  for (const f of toMarcFields(book)) {
    if ('value' in f) {
      parts.push(`    <controlfield tag="${f.tag}">${esc(f.value)}</controlfield>`);
    } else {
      parts.push(`    <datafield tag="${f.tag}" ind1="${esc(f.ind1)}" ind2="${esc(f.ind2)}">`);
      for (const s of f.subfields) {
        parts.push(`      <subfield code="${esc(s.code)}">${esc(s.value)}</subfield>`);
      }
      parts.push('    </datafield>');
    }
  }
  parts.push('  </record>');
  return parts.join('\n');
}

/** MARC-in-JSON (the de-facto community serialization). */
export function toMarcJson(book: MarcRecordInput): Record<string, unknown> {
  return {
    leader: marcLeader(book),
    fields: toMarcFields(book).map((f) =>
      'value' in f
        ? { [f.tag]: f.value }
        : { [f.tag]: { ind1: f.ind1, ind2: f.ind2, subfields: f.subfields.map((s) => ({ [s.code]: s.value })) } }
    )
  };
}

/**
 * Dublin Core (the 15 elements), as required by OAI-PMH.
 *
 * Lossy by design — DC cannot express holdings or a relator code — so it is the
 * harvesting format, never the exchange format. MARCXML is the lossless one.
 */
export function toDublinCoreXml(book: MarcRecordInput): string {
  const el = (name: string, value: string | null | undefined): string =>
    value && String(value).trim() ? `      <dc:${name}>${esc(String(value).trim())}</dc:${name}>` : '';
  const rows: string[] = [
    el('title', book.title),
    el('title', book.titleRomanized),
    el('creator', book.author)
  ];
  for (const c of book.contributors ?? []) if (c.role !== 'aut') rows.push(el('contributor', c.name));
  for (const s of book.subjects ?? []) rows.push(el('subject', s.term));
  rows.push(
    el('description', book.description),
    el('publisher', book.publisher),
    el('date', book.dateEdtf ?? (book.publicationYear ? String(book.publicationYear) : null)),
    el('type', book.bibLevel === 'serial' ? 'Text/Serial' : 'Text'),
    el('format', book.extent),
    el('identifier', book.isbn ? `urn:isbn:${book.isbn}` : null),
    el('identifier', book.issn ? `urn:issn:${book.issn}` : null),
    el('identifier', book.id),
    // DCMI's recommended encoding scheme for dc:language is ISO 639, one
    // element per language — not the catalogue's internal "EL,EN".
    ...toIso639_2(book.language).map((l) => el('language', l)),
    el('relation', book.seriesTitle)
  );
  return [
    '    <oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"',
    '                xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '                xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd">',
    ...rows.filter(Boolean),
    '    </oai_dc:dc>'
  ].join('\n');
}

/**
 * Assemble the MARC view of a stored book.
 *
 * Where a value lives in more than one place, the standard field wins over the
 * custom attribute that used to hold it — `ddc` over nothing, `volume_designation`
 * over `custom.volume_num` — but the attribute is still read as a fallback,
 * because Phase B deliberately did not rewrite the catalogue. A record that has
 * not been through the set/authority tools still exports correctly.
 */
export function bookRowToMarcInput(
  row: Record<string, unknown>,
  extra: {
    items?: Array<Record<string, unknown>>;
    contributors?: Array<{ name: string; role: string; dates?: string | null; kind?: string | null }>;
    subjects?: Array<{ term: string; source?: string | null }>;
    seriesTitle?: string | null;
    serialHoldings?: Array<Record<string, unknown>>;
    isil?: string | null;
  } = {}
): MarcRecordInput {
  const cf = (row.customFields ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  };
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    titleRomanized: str(row.titleRomanized),
    subtitle: str(cf.subTitle ?? cf.sub_title),
    author: String(row.author ?? ''),
    authorRomanized: str(row.authorRomanized),
    isbn: str(row.isbn),
    issn: str(cf.issn),
    publisher: str(row.publisher),
    publisherRomanized: str(row.publisherRomanized),
    placeOfPublication: str(cf.place_of_publication),
    dateEdtf: str(row.dateEdtf),
    publicationYear: typeof row.publicationYear === 'number' ? row.publicationYear : null,
    publicationYearEnd: typeof row.publicationYearEnd === 'number' ? row.publicationYearEnd : null,
    // ISBD area 5. `pages` is free text since the extent change.
    extent: str(cf.pages),
    language: str(row.language),
    description: str(row.description),
    ddc: str(row.ddc),
    localClass: str(cf.category_code),
    edition: str(cf.edition),
    seriesTitle: extra.seriesTitle ?? str(cf.series),
    volumeDesignation: str(row.volumeDesignation) ?? str(cf.volume_num),
    bibLevel: str(row.bibLevel) ?? 'monograph',
    updatedAt: str(row.updatedAt),
    contributors: extra.contributors,
    subjects: extra.subjects,
    items: (extra.items ?? []).map((i) => ({
      shelfCode: str(i.shelfCode),
      roomCode: str(i.roomCode),
      callNumber: str(i.callNumber),
      barcode: str(i.barcode),
      copyNumber: typeof i.copyNumber === 'number' ? i.copyNumber : null
    })),
    serialHoldings: (extra.serialHoldings ?? []) as MarcRecordInput['serialHoldings'],
    isil: extra.isil ?? null
  };
}

// ─── Reading MARCXML ───────────────────────────────────────────────────────

export type ParsedMarcRecord = {
  leader: string | null;
  controlFields: Record<string, string>;
  /** tag -> occurrences -> subfield code -> values. */
  dataFields: Array<{ tag: string; ind1: string; ind2: string; subfields: MarcSubfield[] }>;
};

/**
 * Parse MARCXML with HTMLRewriter.
 *
 * workerd has no DOMParser and no XML parser, and a regex over MARCXML is a
 * trap: it silently mangles entity-encoded text, which is precisely how Koha
 * serves Greek (`&#x394;&#x3B9;…`). HTMLRewriter decodes for us.
 *
 * MARCXML element names are lowercase, so HTMLRewriter's HTML-mode lowercasing
 * is harmless here.
 */
export async function parseMarcXml(xml: string): Promise<ParsedMarcRecord[]> {
  const records: ParsedMarcRecord[] = [];
  let current: ParsedMarcRecord | null = null;
  let field: { tag: string; ind1: string; ind2: string; subfields: MarcSubfield[] } | null = null;
  let subCode: string | null = null;
  let buffer = '';
  let controlTag: string | null = null;

  const rewriter = new HTMLRewriter()
    .on('record', {
      element(el) {
        current = { leader: null, controlFields: {}, dataFields: [] };
        records.push(current);
        el.onEndTag(() => { current = null; });
      }
    })
    .on('leader', {
      element(el) { buffer = ''; el.onEndTag(() => { if (current) current.leader = buffer; buffer = ''; }); },
      text(t) { buffer += t.text; }
    })
    .on('controlfield', {
      element(el) {
        controlTag = el.getAttribute('tag');
        buffer = '';
        el.onEndTag(() => {
          if (current && controlTag) current.controlFields[controlTag] = buffer.trim();
          controlTag = null; buffer = '';
        });
      },
      text(t) { buffer += t.text; }
    })
    .on('datafield', {
      element(el) {
        field = {
          tag: el.getAttribute('tag') ?? '',
          ind1: el.getAttribute('ind1') ?? ' ',
          ind2: el.getAttribute('ind2') ?? ' ',
          subfields: []
        };
        el.onEndTag(() => {
          if (current && field && field.tag) current.dataFields.push(field);
          field = null;
        });
      }
    })
    .on('subfield', {
      element(el) {
        subCode = el.getAttribute('code');
        buffer = '';
        el.onEndTag(() => {
          if (field && subCode !== null) field.subfields.push({ code: subCode, value: buffer.trim() });
          subCode = null; buffer = '';
        });
      },
      // Koha splits long values across text chunks, so accumulate rather than
      // assigning — assigning keeps only the last fragment of a long title.
      text(t) { buffer += t.text; }
    });

  await rewriter.transform(new Response(xml)).arrayBuffer();
  return records;
}

/** Strip the ISBD punctuation a source added, so it is not stored twice. */
function unIsbd(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s*[/:;,]\s*$/, '').trim();
  return cleaned || null;
}

/** Read one parsed MARC record into the shape the catalogue stores. */
export function marcToBookFields(rec: ParsedMarcRecord): Partial<MarcRecordInput> & {
  subjectTerms?: Array<{ term: string; source: string }>;
} {
  const first = (tag: string, code: string): string | undefined =>
    rec.dataFields.find((f) => f.tag === tag)?.subfields.find((s) => s.code === code)?.value;
  const all = (tag: string, code: string): string[] =>
    rec.dataFields.filter((f) => f.tag === tag)
      .flatMap((f) => f.subfields.filter((s) => s.code === code).map((s) => s.value));

  // 880s carry the parallel script forms, linked by $6 "<tag>-<occurrence>".
  const linkedFor = (tag: string): string | undefined =>
    rec.dataFields
      .filter((f) => f.tag === '880' && (f.subfields.find((s) => s.code === '6')?.value ?? '').startsWith(tag))
      .flatMap((f) => f.subfields.filter((s) => s.code !== '6').map((s) => s.value))[0];

  const title = unIsbd(first('245', 'a'));
  const subtitle = unIsbd(first('245', 'b'));
  // 264 is the RDA form and wins when present; 260 is the fallback.
  const place = unIsbd(first('264', 'a') ?? first('260', 'a'));
  const publisher = unIsbd(first('264', 'b') ?? first('260', 'b'));
  const dateRaw = unIsbd(first('264', 'c') ?? first('260', 'c'));
  const yearMatch = (dateRaw ?? '').match(/\b(\d{4})\b/);

  const subjectTerms: Array<{ term: string; source: string }> = [];
  for (const f of rec.dataFields.filter((x) => x.tag === '650')) {
    const term = f.subfields.find((s) => s.code === 'a')?.value;
    if (!term) continue;
    // ind2 = 0 means LCSH; anything else names its own thesaurus in $2.
    subjectTerms.push({ term: unIsbd(term) ?? term, source: f.ind2 === '0' ? 'lcsh' : 'imported' });
  }

  // leader/07 is the bibliographic level. 's' is a serial; the other five
  // values MARC defines all describe kinds of monograph as far as this
  // catalogue is concerned. `undefined` rather than 'monograph' when it is not
  // a serial, so re-importing a plain record can never DEMOTE a title the
  // librarian has already marked as one.
  const bibLevel = (rec.leader ?? '')[7] === 's' ? 'serial' : undefined;

  return {
    bibLevel,
    title: title ?? undefined,
    subtitle: subtitle ?? undefined,
    titleRomanized: linkedFor('245'),
    author: unIsbd(first('100', 'a') ?? first('700', 'a')) ?? undefined,
    authorRomanized: linkedFor('100'),
    // Passed through as transcribed. Stripping to [0-9X] here REWROTE the
    // identifier rather than tidying it — anything unexpected in the field came
    // out as a different, plausible-looking ISBN. normalizeBookData removes the
    // formatting (spaces, hyphens) and nothing else, which is the correct scope.
    isbn: first('020', 'a') ?? undefined,
    issn: first('022', 'a') ?? undefined,
    publisher: publisher ?? undefined,
    publisherRomanized: linkedFor('264'),
    placeOfPublication: place ?? undefined,
    // The imprint date is transcribed as printed, which is already close to
    // EDTF; the caller normalizes it through parseEdtf.
    dateEdtf: dateRaw ?? undefined,
    publicationYear: yearMatch ? Number(yearMatch[1]) : undefined,
    // 300$a is the extent, free text — exactly what the `pages` field now holds.
    extent: unIsbd(first('300', 'a')) ?? undefined,
    // Read every 041$a, not just the first — a bilingual record lost its second
    // language on the way in. Records from other libraries are often
    // monolingual and carry no 041 at all, so 008/35-37 is the fallback, and
    // the codes come back as the two-letter upper-case form the catalogue
    // stores so an exported record re-imports as what it started as.
    language: fromIso639_2(
      (all('041', 'a').length ? all('041', 'a') : [(rec.controlFields['008'] ?? '').slice(35, 38)])
        // und / mul / zxx say "we did not determine one" — storing them would
        // put a fake language on the record and into the facet rail.
        .filter((c) => !['und', 'mul', 'zxx', ''].includes(c.trim().toLowerCase()))
    ) || undefined,
    description: first('520', 'a') ?? undefined,
    ddc: first('082', 'a') ?? undefined,
    edition: unIsbd(first('250', 'a')) ?? undefined,
    seriesTitle: unIsbd(first('490', 'a')) ?? undefined,
    volumeDesignation: first('490', 'v') ?? undefined,
    subjectTerms: subjectTerms.length ? subjectTerms : undefined
  };
}

export const MARCXML_COLLECTION_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<collection xmlns="http://www.loc.gov/MARC21/slim"\n' +
  '            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n' +
  '            xsi:schemaLocation="http://www.loc.gov/MARC21/slim http://www.loc.gov/standards/marcxml/schema/MARC21slim.xsd">';
export const MARCXML_COLLECTION_CLOSE = '</collection>';
