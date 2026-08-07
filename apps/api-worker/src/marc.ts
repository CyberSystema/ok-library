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

  df('020', ' ', ' ', [['a', book.isbn]]);
  df('022', ' ', ' ', [['a', book.issn]]);
  // 041 wants ISO 639-2/B; the catalogue stores that shape already (B7).
  df('041', '0', ' ', (book.language ?? '').split(',').map((l) => ['a', l.trim()] as [string, string]));
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
    el('language', book.language),
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
    isil: extra.isil ?? null
  };
}

export const MARCXML_COLLECTION_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<collection xmlns="http://www.loc.gov/MARC21/slim"\n' +
  '            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n' +
  '            xsi:schemaLocation="http://www.loc.gov/MARC21/slim http://www.loc.gov/standards/marcxml/schema/MARC21slim.xsd">';
export const MARCXML_COLLECTION_CLOSE = '</collection>';
