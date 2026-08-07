import { parseEdtf } from '@ok-library/shared';

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * Derive a stable UUID-shaped id from a seed string (SHA-256 → first 16 bytes,
 * formatted as a UUID). Same seed always yields the same id, so a create that
 * commits but whose response is lost can be safely retried: the retry produces
 * the identical id and an `INSERT OR IGNORE` becomes a no-op instead of a
 * duplicate row. Not RFC-4122-strict (we don't set version/variant bits) — it
 * only needs to be deterministic and collision-free for our seeds.
 */
export async function deterministicUuid(seed: string): Promise<string> {
  const data = new TextEncoder().encode(seed);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(digest.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toSqlLike(value: string): string {
  return `%${value.replaceAll('%', '').replaceAll('_', '')}%`;
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateCodeValue(kind: 'qr' | 'barcode'): string {
  const ts = Date.now().toString(36).toUpperCase();
  let randomPart = '';
  for (let i = 0; i < 12; i += 1) {
    randomPart += B32[Math.floor(Math.random() * B32.length)];
  }
  const prefix = kind === 'qr' ? 'QR' : 'BC';
  return `${prefix}-${ts}-${randomPart}`;
}

export type NormalizableBook = {
  title?: string | null;
  titleRomanized?: string | null;
  authorRomanized?: string | null;
  publisherRomanized?: string | null;
  author?: string | null;
  isbn?: string | null;
  publisher?: string | null;
  language?: string | null;
  description?: string | null;
  roomCode?: string | null;
  shelfCode?: string | null;
  acquisitionDate?: string | null;
  publicationYear?: number | null;
  publicationYearEnd?: number | null;
  dateEdtf?: string | null;
  tags?: string[];
  customFields?: Record<string, unknown>;
};

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Greek (incl. Coptic) and Greek Extended (polytonic) blocks.
const GREEK_LETTER = /[Ͱ-Ͽἀ-῿]/;

/**
 * Upper-case a room/shelf code the way its own language does.
 *
 * Plain `.toUpperCase()` is wrong for Greek: it maps ί → Ί, so the librarian's
 * back-shelf "19-000 πίσω" was being stored as "19-000 ΠΊΣΩ". Greek orthography
 * drops the tonos when a word is written in capitals — the correct form is
 * "19-000 ΠΙΣΩ" — and ICU's `el` tailoring knows that, including the ΐ/ΰ and
 * disjunctive-eta cases a hand-written accent map would miss.
 *
 * The Greek path is taken ONLY when the string actually contains a Greek
 * letter, so every existing Latin/numeric code upper-cases byte-identically to
 * before and the healing pass (POST /api/admin/normalize-books) rewrites only
 * the handful of rows that need it.
 *
 * MUST be used on both sides of a comparison. `shelfExact` in db.ts upper-cases
 * the bound value separately; if the two ever disagree, "select every book on
 * this shelf" silently matches nothing.
 */
export function normalizeCode(value: string): string {
  const trimmed = value.trim();
  return GREEK_LETTER.test(trimmed) ? trimmed.toLocaleUpperCase('el') : trimmed.toUpperCase();
}

/**
 * Reconcile a book's date fields.
 *
 * `dateEdtf` is authoritative when it parses: `publicationYear` becomes the
 * earliest year it can denote and `publicationYearEnd` the latest, so the two
 * representations can never drift apart and every existing year query keeps
 * working untouched.
 *
 * An unparseable expression is KEPT — the librarian is transcribing what is
 * printed in the book, and refusing to store it would lose the only record of
 * it. The derived years are simply left alone in that case, and the UI warns.
 *
 * With no `dateEdtf` at all, a plain `publicationYear` still round-trips and is
 * mirrored into `dateEdtf`, which is how rows written by an older client (or
 * the offline queue) stay consistent.
 */
export function reconcileBookDates<T extends {
  publicationYear?: number | null;
  publicationYearEnd?: number | null;
  dateEdtf?: string | null;
}>(input: T): T {
  const out = { ...input } as Record<string, unknown>;

  // ABSENT means "leave this alone" — the same contract every other field
  // honours in a partial update. Only an explicit null clears.
  //
  // Getting this wrong is silent data loss: a bulk edit that sets a shelf code
  // sends neither date field, and treating that as "no date" collapsed a
  // 1955/1957 bound-with back to a bare 1955. Exactly the trap UpdateBookSchema
  // was already written to avoid for title/author/tags — it reappeared here
  // because this function runs on the incoming payload, not the merged row.
  const hasEdtf = Object.prototype.hasOwnProperty.call(out, 'dateEdtf') && out.dateEdtf !== undefined;
  const hasYear = Object.prototype.hasOwnProperty.call(out, 'publicationYear') && out.publicationYear !== undefined;
  if (!hasEdtf && !hasYear) return out as T;

  const raw = typeof out.dateEdtf === 'string' ? out.dateEdtf.trim() : '';

  if (raw) {
    out.dateEdtf = raw;
    const parsed = parseEdtf(raw);
    if (parsed) {
      out.publicationYear = parsed.start;
      out.publicationYearEnd = parsed.end;
    } else {
      // Unparseable: keep the transcription, but never let a client-supplied
      // span stand in for one we did not derive.
      out.publicationYearEnd = out.publicationYear ?? null;
    }
    return out as T;
  }

  // An explicitly-cleared EDTF value, or a bare year from an older client / the
  // offline queue: mirror the year across so the two never disagree.
  out.dateEdtf = null;
  if (typeof out.publicationYear === 'number') {
    out.dateEdtf = String(out.publicationYear);
    out.publicationYearEnd = out.publicationYear;
  } else {
    out.publicationYearEnd = null;
  }
  return out as T;
}

/**
 * Normalizes book fields before persistence:
 * - Reconciles dateEdtf with the derived publicationYear / publicationYearEnd
 * - Collapses multiple spaces and trims text fields (title, author, publisher, …)
 * - Strips hyphens/spaces from ISBN and upper-cases it
 * - Trims language, description, acquisitionDate
 * - Upper-cases roomCode / shelfCode (locale-aware — see `normalizeCode`)
 * - Deduplicates tags (case-insensitive) and removes empty entries
 * - Trims string-typed custom field values
 */
export function normalizeBookData<T extends NormalizableBook>(input: T): T {
  // Dates are reconciled here so EVERY write path — direct, sync, import —
  // gets it without having to remember to call it.
  const out = { ...reconcileBookDates(input as Record<string, unknown>) } as Record<string, unknown>;

  // Converge the two historical representations of "no value" into one canonical
  // form: the empty string. Legacy catalog imports minted the English sentinels
  // '(Untitled)'/'(Unknown)', while the forms/JSON import store ''. Keeping both
  // split duplicate detection, autocomplete, sorting, and (worst) leaked raw
  // English placeholders into the localized UI. Normalizing on every write means
  // any edit/import/sync heals the row; the UI renders '' as a translated
  // placeholder. We match ONLY the exact system-minted sentinels so a real book
  // legitimately titled "Unknown" is never clobbered.
  if (typeof out.title === 'string') {
    const t = collapseSpaces(out.title);
    out.title = t === '(Untitled)' ? '' : t;
  }
  if (typeof out.author === 'string') {
    const a = collapseSpaces(out.author);
    out.author = a === '(Unknown)' ? '' : a;
  }
  if (typeof out.isbn === 'string') {
    const cleaned = out.isbn.replace(/[\s-]/g, '').toUpperCase();
    out.isbn = cleaned || null;
  }
  if (typeof out.publisher === 'string') {
    out.publisher = collapseSpaces(out.publisher) || null;
  }
  // Parallel (romanized) forms. NFC-normalized because Open Library returns
  // ALA-LC romanization DECOMPOSED — "ē" as e + U+0304 — and a decomposed
  // string never compares or indexes equal to its composed twin.
  for (const key of ['titleRomanized', 'authorRomanized', 'publisherRomanized'] as const) {
    if (typeof out[key] === 'string') {
      out[key] = collapseSpaces((out[key] as string).normalize('NFC')) || null;
    }
  }
  if (typeof out.language === 'string') {
    out.language = out.language.trim() || null;
  }
  if (typeof out.description === 'string') {
    out.description = out.description.trim() || null;
  }
  if (typeof out.roomCode === 'string') {
    out.roomCode = normalizeCode(out.roomCode) || null;
  }
  if (typeof out.shelfCode === 'string') {
    out.shelfCode = normalizeCode(out.shelfCode) || null;
  }
  if (typeof out.acquisitionDate === 'string') {
    out.acquisitionDate = out.acquisitionDate.trim() || null;
  }
  if (Array.isArray(out.tags)) {
    const seen = new Set<string>();
    out.tags = (out.tags as unknown[])
      .map((t) => (typeof t === 'string' ? t.trim() : t))
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .filter((t) => {
        const lower = t.toLowerCase();
        if (seen.has(lower)) return false;
        seen.add(lower);
        return true;
      });
  }
  if (out.customFields && typeof out.customFields === 'object') {
    const cf: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(out.customFields as Record<string, unknown>)) {
      cf[key] = typeof val === 'string' ? (val.trim() || null) : val;
    }
    out.customFields = cf;
  }

  return out as T;
}

export function toCsv(rows: Array<Record<string, unknown>>, orderedColumns: string[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) {
      return '';
    }
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    // CSV formula-injection defense: a cell that begins with =, +, -, @, or a
    // leading tab/CR is interpreted as a formula by Excel/LibreOffice/Sheets, so
    // a book title like `=HYPERLINK(...)` or `+cmd|...` would execute when the
    // librarian opens the export. Neutralize by prefixing a single quote, which
    // spreadsheets treat as "force text" and hide. (This export is opened in a
    // spreadsheet, not re-imported — the app imports XLSX — so no round-trip drift.)
    if (/^[=+\-@\t\r]/.test(text)) {
      text = `'${text}`;
    }
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };

  const lines = [orderedColumns.join(',')];
  for (const row of rows) {
    lines.push(orderedColumns.map((column) => escape(row[column])).join(','));
  }
  return lines.join('\n');
}
