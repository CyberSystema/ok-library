/**
 * SRU and OAI-PMH — the two ways another system can read this catalogue.
 *
 * Z39.50 and SIP2 are the older equivalents and both need a persistent raw TCP
 * socket, which Cloudflare Workers cannot open. SRU is the HTTP successor to
 * Z39.50 (search, synchronous) and OAI-PMH is the harvesting protocol
 * (incremental, batch). Between them they cover what a union catalogue or an
 * aggregator would actually ask for.
 *
 * Both are PUBLIC and READ-ONLY, and expose bibliographic records ONLY —
 * never borrowers, loans, staff or holdings barcodes.
 */

export function xmlEscape(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── CQL ───────────────────────────────────────────────────────────────────

export type CqlTerm = { index: string; relation: string; value: string };
export type CqlParseResult =
  | { ok: true; terms: CqlTerm[] }
  | { ok: false; diagnostic: string; detail: string };

/**
 * A deliberately small, documented slice of CQL.
 *
 * Full CQL has nested boolean groups, proximity, sort specs and relation
 * modifiers. Implementing a fraction of that and silently ignoring the rest is
 * worse than not accepting it: the caller gets results that do not answer their
 * query and has no way to tell. So anything outside this subset returns an SRU
 * diagnostic naming what was not understood.
 *
 * Supported:
 *   bare terms                     →  general keyword search
 *   index = value / index any value
 *   indexes: cql.serverChoice, cql.anywhere, dc.title, dc.creator,
 *            dc.publisher, dc.identifier, dc.date, dc.language, bath.isbn
 *   joined by `and` only
 *   double-quoted phrases
 */
const CQL_INDEXES: Record<string, string> = {
  'cql.serverchoice': 'any',
  'cql.anywhere': 'any',
  'dc.title': 'title',
  'dc.creator': 'author',
  'dc.contributor': 'author',
  'dc.publisher': 'publisher',
  'dc.identifier': 'isbn',
  'dc.date': 'date',
  'dc.language': 'language',
  'bath.isbn': 'isbn',
  'bath.name': 'author',
  'bath.title': 'title'
};

export function parseCql(query: string): CqlParseResult {
  const text = query.trim();
  if (!text) return { ok: true, terms: [] };

  if (/\b(or|not|prox)\b/i.test(text.replace(/"[^"]*"/g, ''))) {
    return {
      ok: false, diagnostic: '37',
      detail: 'Only the boolean "and" is supported; "or", "not" and "prox" are not'
    };
  }
  if (/[()]/.test(text.replace(/"[^"]*"/g, ''))) {
    return { ok: false, diagnostic: '38', detail: 'Nested groups are not supported' };
  }

  const terms: CqlTerm[] = [];
  // Split on `and` at the top level, respecting quoted phrases.
  const clauses = text.split(/\s+and\s+/i);
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([A-Za-z][\w.]*)\s*(=|==|any|all|exact)\s*(.+)$/i);
    if (!m) {
      // A bare term is a keyword search — the commonest real query.
      terms.push({ index: 'any', relation: '=', value: stripQuotes(trimmed) });
      continue;
    }
    const rawIndex = (m[1] as string).toLowerCase();
    const mapped = CQL_INDEXES[rawIndex];
    if (!mapped) {
      return { ok: false, diagnostic: '16', detail: `Unsupported index "${m[1]}"` };
    }
    terms.push({ index: mapped, relation: (m[2] as string).toLowerCase(), value: stripQuotes(m[3] as string) });
  }
  return { ok: true, terms };
}

function stripQuotes(v: string): string {
  const t = v.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length > 1 ? t.slice(1, -1) : t;
}

export function sruDiagnostic(uriNumber: string, details: string, message: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">',
    '  <version>1.2</version>',
    '  <numberOfRecords>0</numberOfRecords>',
    '  <diagnostics xmlns:diag="http://www.loc.gov/zing/srw/diagnostic/">',
    '    <diag:diagnostic>',
    `      <diag:uri>info:srw/diagnostic/1/${xmlEscape(uriNumber)}</diag:uri>`,
    `      <diag:details>${xmlEscape(details)}</diag:details>`,
    `      <diag:message>${xmlEscape(message)}</diag:message>`,
    '    </diag:diagnostic>',
    '  </diagnostics>',
    '</searchRetrieveResponse>'
  ].join('\n');
}

/** SRU explain — what this server supports, so a client can configure itself. */
export function sruExplain(base: string, libraryName: string, total: number): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<explainResponse xmlns="http://www.loc.gov/zing/srw/">',
    '  <version>1.2</version>',
    '  <record>',
    '    <recordSchema>http://explain.z3950.org/dtd/2.0/</recordSchema>',
    '    <recordPacking>xml</recordPacking>',
    '    <recordData>',
    '      <explain xmlns="http://explain.z3950.org/dtd/2.0/">',
    '        <serverInfo protocol="SRU" version="1.2">',
    `          <host>${xmlEscape(new URL(base).host)}</host>`,
    '          <port>443</port>',
    `          <database>${xmlEscape(new URL(base).pathname.replace(/^\//, '') || 'sru')}</database>`,
    '        </serverInfo>',
    '        <databaseInfo>',
    `          <title>${xmlEscape(libraryName)}</title>`,
    `          <description>${xmlEscape(`Bibliographic records (${total})`)}</description>`,
    '        </databaseInfo>',
    '        <indexInfo>',
    ...Object.keys(CQL_INDEXES).map((name) => {
      const [set, index] = name.includes('.') ? name.split('.', 2) : ['cql', name];
      return `          <index><map><name set="${xmlEscape(set as string)}">${xmlEscape(index as string)}</name></map></index>`;
    }),
    '        </indexInfo>',
    '        <schemaInfo>',
    '          <schema identifier="info:srw/schema/1/marcxml-v1.1" name="marcxml" sort="false"/>',
    '          <schema identifier="info:srw/schema/1/dc-v1.1" name="dc" sort="false"/>',
    '        </schemaInfo>',
    '        <configInfo>',
    '          <default type="numberOfRecords">10</default>',
    '          <setting type="maximumRecords">100</setting>',
    '        </configInfo>',
    '      </explain>',
    '    </recordData>',
    '  </record>',
    '</explainResponse>'
  ].join('\n');
}

// ─── OAI-PMH ───────────────────────────────────────────────────────────────

export const OAI_ERROR_CODES = [
  'badArgument', 'badResumptionToken', 'badVerb', 'cannotDisseminateFormat',
  'idDoesNotExist', 'noRecordsMatch', 'noMetadataFormats', 'noSetHierarchy'
] as const;
export type OaiErrorCode = (typeof OAI_ERROR_CODES)[number];

function oaiEnvelope(requestUrl: string, requestAttrs: string, body: string, responseDate: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/ http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd">',
    `  <responseDate>${responseDate}</responseDate>`,
    `  <request${requestAttrs}>${xmlEscape(requestUrl)}</request>`,
    body,
    '</OAI-PMH>'
  ].join('\n');
}

export function oaiError(
  requestUrl: string, code: OaiErrorCode, message: string, responseDate: string,
  /** The verb and recognised arguments to echo, for every code except the two below. */
  echo?: { verb?: string; args?: Record<string, string | undefined> }
): string {
  // Per the spec the <request> element carries NO attributes when the VERB or an
  // ARGUMENT is what was wrong — echoing back the thing that was invalid would make
  // the response itself invalid. For every other code the spec says the opposite:
  // <request> carries the keys of the request's key=value pairs.
  //
  // This was `code === 'badVerb' || code === 'badArgument' ? '' : ''` — both arms
  // the empty string, so the distinction the comment describes was never made and
  // NO error response echoed anything. idDoesNotExist, cannotDisseminateFormat,
  // noRecordsMatch, badResumptionToken and noSetHierarchy all arrived at the
  // harvester stripped of the context that says which request failed.
  const bare = code === 'badVerb' || code === 'badArgument';
  const attrs = bare || !echo
    ? ''
    : (echo.verb ? ` verb="${xmlEscape(echo.verb)}"` : '')
      + Object.entries(echo.args ?? {})
        .filter(([, v]) => v)
        .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
        .join('');
  return oaiEnvelope(
    requestUrl, attrs,
    `  <error code="${code}">${xmlEscape(message)}</error>`,
    responseDate
  );
}

/**
 * Normalise an OAI-PMH UTCdatetime bound for comparison against `updated_at`.
 *
 * The spec REQUIRES day granularity to be accepted ("All repositories must support
 * YYYY-MM-DD") and `until` to be INCLUSIVE. `updated_at` is stored with
 * milliseconds, and these bounds went straight into a string comparison — so
 * `updated_at <= '2026-08-09'` is false for every record saved that day, because the
 * bare date is a strict prefix of every timestamp on it. A single-day harvest
 * returned nothing, and every `until` silently lost its last day.
 *
 * Returns null for a value that is not a legal UTCdatetime, so the caller can answer
 * badArgument instead of running a nonsense comparison.
 */
export function normalizeOaiBound(value: string, edge: 'from' | 'until'): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === 'until' ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    // Second granularity, inclusive at the top: .999 keeps every millisecond
    // inside the second the harvester named.
    return edge === 'until' ? value.replace(/Z$/, '.999Z') : value.replace(/Z$/, '.000Z');
  }
  return null;
}

/** Day or second granularity, as OAI-PMH defines them. Both bounds must match. */
export function oaiGranularity(value: string): 'day' | 'second' | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'day';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return 'second';
  return null;
}

export function oaiResponse(
  requestUrl: string, verb: string, extraAttrs: Record<string, string>, body: string, responseDate: string
): string {
  const attrs = [` verb="${xmlEscape(verb)}"`]
    .concat(Object.entries(extraAttrs)
      .filter(([, v]) => v)
      .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`))
    .join('');
  return oaiEnvelope(requestUrl, attrs, body, responseDate);
}

export function oaiIdentify(
  requestUrl: string, opts: {
    repositoryName: string; baseUrl: string; adminEmail: string;
    earliestDatestamp: string; responseDate: string; isil: string | null;
  }
): string {
  const body = [
    '  <Identify>',
    `    <repositoryName>${xmlEscape(opts.repositoryName)}</repositoryName>`,
    `    <baseURL>${xmlEscape(opts.baseUrl)}</baseURL>`,
    '    <protocolVersion>2.0</protocolVersion>',
    `    <adminEmail>${xmlEscape(opts.adminEmail)}</adminEmail>`,
    `    <earliestDatestamp>${xmlEscape(opts.earliestDatestamp)}</earliestDatestamp>`,
    // We soft-delete and keep the row, so deletions can be reported forever
    // rather than a harvester silently keeping a withdrawn book.
    '    <deletedRecord>persistent</deletedRecord>',
    '    <granularity>YYYY-MM-DDThh:mm:ssZ</granularity>',
    '    <description>',
    '      <oai-identifier xmlns="http://www.openarchives.org/OAI/2.0/oai-identifier"',
    '                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '                      xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai-identifier http://www.openarchives.org/OAI/2.0/oai-identifier.xsd">',
    '        <scheme>oai</scheme>',
    `        <repositoryIdentifier>${xmlEscape(opts.isil ?? new URL(opts.baseUrl).host)}</repositoryIdentifier>`,
    '        <delimiter>:</delimiter>',
    `        <sampleIdentifier>${xmlEscape(oaiIdentifier(opts.isil, new URL(opts.baseUrl).host, '00000000-0000-0000-0000-000000000000'))}</sampleIdentifier>`,
    '      </oai-identifier>',
    '    </description>',
    '  </Identify>'
  ].join('\n');
  return oaiResponse(requestUrl, 'Identify', {}, body, opts.responseDate);
}

/** `oai:<repository>:<book id>` — the ISIL names the repository when set. */
export function oaiIdentifier(isil: string | null, host: string, bookId: string): string {
  return `oai:${isil ?? host}:${bookId}`;
}

export function parseOaiIdentifier(identifier: string): string | null {
  const parts = identifier.split(':');
  if (parts.length < 3 || parts[0] !== 'oai') return null;
  const id = parts[parts.length - 1] ?? '';
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null;
}

/**
 * Resumption tokens.
 *
 * Opaque to the client but stateless for us: the cursor and the original
 * arguments are encoded into the token itself. Storing them server-side would
 * mean a KV write per page, and KV writes are the tightest budget here.
 */
export type OaiResumption = {
  /** Records already delivered — for the spec's `cursor` attribute, not for paging. */
  delivered: number;
  /** Keyset position: the (updated_at, id) of the last row handed out. */
  lastUpdatedAt?: string;
  lastId?: string;
  /** Legacy: a bare row offset. Honoured for tokens issued before the keyset. */
  offset?: number;
  /** completeListSize, carried so the COUNT is not recomputed on every page. */
  total?: number;
  from?: string; until?: string; prefix: string;
};

/**
 * A resumption token is a POSITION, and it has to survive the catalogue changing
 * underneath a harvest.
 *
 * It used to carry a row OFFSET over an `updated_at ASC, id ASC` ordering. Saving
 * any already-delivered record moves it to the end of that ordering, which shifts
 * every undelivered row one place earlier — so the row sitting at the next offset is
 * stepped over and never harvested. A harvest of a live catalogue silently loses a
 * record for every edit made while it runs, and reports success. The same defect was
 * found and fixed in `/api/sync/pull`; the ordering here is already the total order
 * `(updated_at, id)`, so the keyset was available all along.
 *
 * `delivered` is kept only to populate the spec's `cursor` attribute honestly.
 */
export function encodeResumptionToken(state: OaiResumption): string {
  return btoa(JSON.stringify(state)).replace(/=+$/, '');
}

export function decodeResumptionToken(token: string): OaiResumption | null {
  try {
    const parsed = JSON.parse(atob(token)) as Record<string, unknown>;
    const prefix = String(parsed.prefix ?? '');
    if (!prefix) return null;
    const lastUpdatedAt = typeof parsed.lastUpdatedAt === 'string' ? parsed.lastUpdatedAt : undefined;
    const lastId = typeof parsed.lastId === 'string' ? parsed.lastId : undefined;
    const rawOffset = Number(parsed.offset);
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : undefined;
    // A token must say WHERE it is, one way or the other. A keyset position is
    // preferred; a legacy offset-only token still resumes rather than 400ing a
    // harvest that was already in flight when this shipped.
    if (lastUpdatedAt === undefined && offset === undefined) return null;
    const rawDelivered = Number(parsed.delivered);
    return {
      delivered: Number.isInteger(rawDelivered) && rawDelivered >= 0 ? rawDelivered : (offset ?? 0),
      lastUpdatedAt,
      lastId,
      offset,
      total: Number.isInteger(Number(parsed.total)) && Number(parsed.total) >= 0
        ? Number(parsed.total) : undefined,
      prefix,
      from: typeof parsed.from === 'string' ? parsed.from : undefined,
      until: typeof parsed.until === 'string' ? parsed.until : undefined
    };
  } catch {
    return null;
  }
}

/** OAI datestamps are UTC, second granularity, no milliseconds. */
export function oaiDatestamp(iso: string | null | undefined): string {
  if (!iso) return new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z')
    : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
