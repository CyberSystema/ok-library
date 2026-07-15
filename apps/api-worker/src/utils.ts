export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
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
  author?: string | null;
  isbn?: string | null;
  publisher?: string | null;
  language?: string | null;
  description?: string | null;
  roomCode?: string | null;
  shelfCode?: string | null;
  acquisitionDate?: string | null;
  tags?: string[];
  customFields?: Record<string, unknown>;
};

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes book fields before persistence:
 * - Collapses multiple spaces and trims text fields (title, author, publisher, …)
 * - Strips hyphens/spaces from ISBN and upper-cases it
 * - Trims language, description, acquisitionDate
 * - Upper-cases roomCode / shelfCode
 * - Deduplicates tags (case-insensitive) and removes empty entries
 * - Trims string-typed custom field values
 */
export function normalizeBookData<T extends NormalizableBook>(input: T): T {
  const out = { ...input } as Record<string, unknown>;

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
  if (typeof out.language === 'string') {
    out.language = out.language.trim() || null;
  }
  if (typeof out.description === 'string') {
    out.description = out.description.trim() || null;
  }
  if (typeof out.roomCode === 'string') {
    out.roomCode = out.roomCode.trim().toUpperCase() || null;
  }
  if (typeof out.shelfCode === 'string') {
    out.shelfCode = out.shelfCode.trim().toUpperCase() || null;
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
