import { HTTPException } from 'hono/http-exception';
import { defaultPbkdf2Iterations, generateSaltHex, hashPasswordPbkdf2 } from './auth';
import type { AuthClaims, Env } from './types';
import { checkIsbn } from '@ok-library/shared';
import { newId, normalizeCode, nowIso, safeJsonParse } from './utils';

type CustomFieldDef = {
  id: string;
  field_key: string;
  field_type: 'text' | 'number' | 'boolean' | 'date' | 'enum';
  required: number;
  enum_options: string;
  label?: string;
  pinned?: number;
  sort_order?: number;
};

type CustomFieldValidationOptions = {
  requireAllRequired?: boolean;
  // When true (default), unknown keys cause a 400. When false, unknown keys are
  // silently dropped — useful for the update path so legacy data on a book
  // (whose custom field definition was later deleted) doesn't block edits.
  rejectUnknownKeys?: boolean;
};

const BOOKS_CACHE_VERSION_KEY = 'books:cache:version';
const BOOKS_CACHE_PREFIX = 'books:list:';

export async function insertAuditLog(
  env: Env,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown>
): Promise<void> {
  // The audit write is best-effort and almost always runs AFTER the primary
  // mutation has committed. If it throws (e.g. audit_logs contention), we must
  // NOT turn a succeeded write into a 500 — that both misleads the user and, on
  // the web client, trips the transient-5xx retry which re-applies the mutation.
  // Swallow and log instead; every call site relies on this being non-fatal.
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), actorId, action, entityType, entityId, JSON.stringify(metadata), nowIso())
      .run();
  } catch (err) {
    console.warn('audit log insert failed, continuing', { action, entityType, entityId, err });
  }
}

export async function getBooksCacheVersion(env: Env): Promise<string> {
  if (!env.CACHE) {
    return '0';
  }
  try {
    const v = await env.CACHE.get(BOOKS_CACHE_VERSION_KEY);
    return v ?? '0';
  } catch {
    return '0';
  }
}

export async function bumpBooksCacheVersion(env: Env): Promise<void> {
  if (!env.CACHE) return;
  try {
    // Monotonic timestamp + random suffix avoids the read-modify-write race of
    // a counter-based scheme: two concurrent writers no longer collapse to the
    // same version, so neither will reuse a stale cache key.
    const v = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
    await env.CACHE.put(BOOKS_CACHE_VERSION_KEY, v, { expirationTtl: 86400 });
  } catch (err) {
    // A failed bump leaves the version key pointing at the OLD value, so every
    // version-keyed cache (books list, facets, rooms/summary) keeps serving the
    // pre-write snapshot until each entry's own TTL lapses (up to 24h) — not
    // "seconds". KV writes almost never fail, but when one does we want it in
    // the logs rather than silently masking stale reads.
    console.warn('bumpBooksCacheVersion failed — caches may serve stale data until TTL', err);
  }
}

export function booksCacheKey(version: string, payload: unknown): string {
  return `${BOOKS_CACHE_PREFIX}${version}:${JSON.stringify(payload)}`;
}

export async function ensureBootstrapAdmin(env: Env): Promise<void> {
  const username = env.BOOTSTRAP_ADMIN_USERNAME;
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    return;
  }

  const existing = await env.DB.prepare('SELECT id FROM staff_users WHERE username = ? LIMIT 1').bind(username).first();
  if (existing) {
    return;
  }

  // Seed the bootstrap admin with PBKDF2 from the start — no legacy hash.
  const salt = generateSaltHex();
  const iterations = defaultPbkdf2Iterations();
  const passwordHash = await hashPasswordPbkdf2(password, salt, iterations);
  const timestamp = nowIso();
  await env.DB.prepare(
    `INSERT INTO staff_users (id, username, role, password_hash, password_salt, password_iterations, active, created_at, updated_at)
     VALUES (?, ?, 'admin', ?, ?, ?, 1, ?, ?)`
  )
    .bind(crypto.randomUUID(), username, passwordHash, salt, iterations, timestamp, timestamp)
    .run();
}

// snake_case DB columns we re-emit under camelCase. Listed once to keep
// parseBook honest: any new column the frontend reads must be added here OR
// passed through with its original key (status, version, id, …).
const SNAKE_TO_CAMEL_BOOK_FIELDS: Record<string, string> = {
  custom_fields: 'customFields',
  title_romanized: 'titleRomanized',
  author_romanized: 'authorRomanized',
  publisher_romanized: 'publisherRomanized',
  publication_year: 'publicationYear',
  publication_year_end: 'publicationYearEnd',
  date_edtf: 'dateEdtf',
  shelf_code: 'shelfCode',
  room_code: 'roomCode',
  acquisition_date: 'acquisitionDate',
  legacy_id: 'legacyId',
  cover_url: 'coverUrl',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  deleted_at: 'deletedAt',
  merged_into: 'mergedInto',
  // The four columns migration 0024 added. They were never listed here, so they
  // passed through under their raw names — and `marc.ts` reads `row.bibLevel`
  // and `row.volumeDesignation`, which were therefore ALWAYS undefined. Every
  // serial-aware branch of the exporter was dead code: leader/07 could only be
  // 'm', 008/06 never took the 'c' branch, and MARC 490$v could only ever come
  // from the custom attribute. The comment above states the rule; these four
  // were the exception that proved nobody was checking it.
  bib_level: 'bibLevel',
  set_id: 'setId',
  set_position: 'setPosition',
  volume_designation: 'volumeDesignation'
};

// Internal search-index columns. `SELECT b.*` picks them up and parseBook used
// to pass them straight through, so every list response carried a second,
// accent-folded copy of the whole record: measured at 398 bytes/row against
// 395 bytes/row of useful text, i.e. roughly half of every page of results.
// Nothing outside the Worker reads them (verified across apps/web/src).
const INTERNAL_BOOK_COLUMNS = new Set([
  'title_fold',
  'author_fold',
  'isbn_fold',
  'publisher_fold',
  'description_fold',
  'tags_fold',
  'custom_fields_fold',
  'title_romanized_fold',
  'author_romanized_fold',
  'publisher_romanized_fold',
  // The GENERATED column migration 0031 added. It exists so `invalidIsbn=1` can
  // be a WHERE clause; the value every consumer reads is `isbnValid`, computed
  // below from the same ISBN. Emitting both invited them to disagree — and they
  // do: SQLite's `GLOB '[0-9]*'` only constrains the FIRST character, so a
  // stored "978C91105B479" is judged valid by the column and invalid by
  // checkIsbn, which strips the letters. One fact, one key.
  'isbn_valid'
]);

export function parseBook(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // Skip the snake_case copy if we know the camelCase key — keeps responses
    // small and prevents API consumers from depending on the legacy spelling.
    if (key in SNAKE_TO_CAMEL_BOOK_FIELDS) continue;
    if (INTERNAL_BOOK_COLUMNS.has(key)) continue;
    out[key] = value;
  }
  out.customFields = safeJsonParse((row.custom_fields as string) ?? '{}', {});
  out.tags = Array.isArray(row.tags) ? row.tags : safeJsonParse((row.tags as string) ?? '[]', []);
  // Computed, not stored: a pure function of the ISBN, so there is no column to
  // keep in sync and no write path to remember. `false` means the check digit
  // does not match — a warning, never a reason the book cannot be saved.
  out.isbnValid = row.isbn ? checkIsbn(String(row.isbn)).valid : null;
  out.ddc = row.ddc ?? null;
  out.titleRomanized = row.title_romanized ?? null;
  out.authorRomanized = row.author_romanized ?? null;
  out.publisherRomanized = row.publisher_romanized ?? null;
  out.publicationYear = row.publication_year ?? null;
  // Derived on read when absent, so the import paths — which never carry an
  // authored EDTF value — still present a consistent date. A stored NULL simply
  // means "the same as the year".
  out.publicationYearEnd = row.publication_year_end ?? row.publication_year ?? null;
  out.dateEdtf = row.date_edtf ?? (row.publication_year != null ? String(row.publication_year) : null);
  out.shelfCode = row.shelf_code ?? null;
  out.roomCode = row.room_code ?? null;
  out.acquisitionDate = row.acquisition_date ?? null;
  out.legacyId = row.legacy_id ?? null;
  out.coverUrl = row.cover_url ?? null;
  out.createdAt = row.created_at ?? null;
  out.updatedAt = row.updated_at ?? null;
  out.deletedAt = row.deleted_at ?? null;
  // The forwarding address left by a merge. Only ever set on a soft-deleted
  // row, so the trash view can say where the record went.
  out.mergedInto = row.merged_into ?? null;
  // IFLA LRM: 'monograph' is a work that is complete, 'serial' one that keeps
  // arriving. It drives MARC leader/07, 008/06, and the ISO 2789 serial count.
  out.bibLevel = row.bib_level ?? 'monograph';
  out.setId = row.set_id ?? null;
  out.setPosition = row.set_position ?? null;
  out.volumeDesignation = row.volume_designation ?? null;
  return out;
}

const FIELD_TO_FTS_COLUMN: Record<string, string> = {
  title: 'title',
  author: 'author',
  isbn: 'isbn',
  publisher: 'publisher',
  description: 'description',
  tags: 'tags',
  custom: 'custom_text'
};

const SQL_FIELD_EXPR: Record<string, string> = {
  title: "COALESCE(title, '')",
  author: "COALESCE(author, '')",
  isbn: "COALESCE(isbn, '')",
  publisher: "COALESCE(publisher, '')",
  language: "COALESCE(language, '')",
  description: "COALESCE(description, '')",
  roomCode: "COALESCE(room_code, '')",
  shelfCode: "COALESCE(shelf_code, '')",
  tags: "COALESCE(tags, '')",
  custom: "COALESCE(custom_fields, '')"
};

// Fold-aware mirror of SQL_FIELD_EXPR. The fuzzy LIKE path compares against
// fold-normalized query tokens, so we have to compare against fold-normalized
// columns or accented text like "Γαβριήλ" will never match a query of
// "γαβριηλ" via SQLite's ASCII-only LOWER(). The `*_fold` columns are
// populated by `computeBookFolds` on every write; we COALESCE through the
// raw column for legacy rows that pre-date migration 0012.
const SQL_FIELD_FOLD_EXPR: Record<string, string> = {
  title: "COALESCE(title_fold, LOWER(COALESCE(title, '')))",
  author: "COALESCE(author_fold, LOWER(COALESCE(author, '')))",
  isbn: "COALESCE(isbn_fold, LOWER(COALESCE(isbn, '')))",
  publisher: "COALESCE(publisher_fold, LOWER(COALESCE(publisher, '')))",
  // No fold column exists for language / roomCode / shelfCode — these tend
  // to be short ASCII codes anyway, so plain LOWER suffices.
  language: "LOWER(COALESCE(language, ''))",
  description: "COALESCE(description_fold, LOWER(COALESCE(description, '')))",
  roomCode: "LOWER(COALESCE(room_code, ''))",
  shelfCode: "LOWER(COALESCE(shelf_code, ''))",
  tags: "COALESCE(tags_fold, LOWER(COALESCE(tags, '')))",
  custom: "COALESCE(custom_fields_fold, LOWER(COALESCE(custom_fields, '')))"
};

// Friendly-name → ISO-code synonym table for the language filter.
// Catalog rows store ISO 639-1 codes ("EN", "EL,EN,FR"), but a librarian who
// types "English" / "Αγγλικά" / "영어" / "Английский" should all get the
// books they expect.
//
// Each ISO code lists synonyms in the four user languages we explicitly
// support: English, Greek, Korean, Russian. We also keep a few common
// adjacent spellings (French/Spanish autonyms, ISO-639-1 short codes, etc.).
// Keys are normalized once at module init: lower-cased, NFKD-decomposed, and
// stripped of combining diacritics — so "Ελληνικά" and "ελληνικα" both
// resolve to the same lookup key.
const RAW_LANGUAGE_SYNONYMS: Record<string, string> = {
  // English
  english: 'en', eng: 'en',
  αγγλικά: 'en', αγγλικα: 'en',
  영어: 'en',
  английский: 'en', английски: 'en', анг: 'en', англ: 'en',

  // Greek
  greek: 'el', hellenic: 'el', gr: 'el',
  ελληνικά: 'el', ελληνικα: 'el', ελληνικός: 'el', ελληνικος: 'el',
  그리스어: 'el',
  греческий: 'el', греч: 'el',

  // German
  german: 'de', deutsch: 'de',
  γερμανικά: 'de', γερμανικα: 'de',
  독일어: 'de',
  немецкий: 'de', нем: 'de',

  // French
  french: 'fr', francais: 'fr', français: 'fr',
  γαλλικά: 'fr', γαλλικα: 'fr',
  프랑스어: 'fr',
  французский: 'fr', франц: 'fr',

  // Italian
  italian: 'it', italiano: 'it',
  ιταλικά: 'it', ιταλικα: 'it',
  이탈리아어: 'it',
  итальянский: 'it', итал: 'it',

  // Spanish
  spanish: 'es', español: 'es', espanol: 'es', castellano: 'es',
  ισπανικά: 'es', ισπανικα: 'es',
  스페인어: 'es',
  испанский: 'es', исп: 'es',

  // Russian
  russian: 'ru',
  ρωσικά: 'ru', ρωσικα: 'ru',
  러시아어: 'ru',
  русский: 'ru', рус: 'ru',

  // Bulgarian
  bulgarian: 'bg',
  βουλγαρικά: 'bg', βουλγαρικα: 'bg',
  불가리아어: 'bg',
  болгарский: 'bg', болг: 'bg', български: 'bg',

  // Czech
  czech: 'cs', česky: 'cs', cesky: 'cs',
  τσεχικά: 'cs', τσεχικα: 'cs',
  체코어: 'cs',
  чешский: 'cs', чеш: 'cs',

  // Latin
  latin: 'la', latina: 'la',
  λατινικά: 'la', λατινικα: 'la',
  라틴어: 'la',
  латинский: 'la', латынь: 'la', лат: 'la',

  // Korean
  korean: 'ko', korea: 'ko',
  κορεατικά: 'ko', κορεατικα: 'ko',
  한국어: 'ko', 한국말: 'ko',
  корейский: 'ko', кор: 'ko',

  // Chinese
  chinese: 'zh', mandarin: 'zh',
  κινέζικα: 'zh', κινεζικα: 'zh',
  중국어: 'zh',
  китайский: 'zh', кит: 'zh',

  // Japanese
  japanese: 'ja',
  ιαπωνικά: 'ja', ιαπωνικα: 'ja',
  일본어: 'ja',
  японский: 'ja', яп: 'ja',

  // Arabic
  arabic: 'ar',
  αραβικά: 'ar', αραβικα: 'ar',
  아랍어: 'ar',
  арабский: 'ar', араб: 'ar',

  // Hebrew
  hebrew: 'he', ivrit: 'he',
  εβραϊκά: 'he', εβραϊκα: 'he',
  히브리어: 'he',
  иврит: 'he',

  // Turkish
  turkish: 'tr', türkçe: 'tr', turkce: 'tr',
  τουρκικά: 'tr', τουρκικα: 'tr',
  터키어: 'tr',
  турецкий: 'tr', тур: 'tr',

  // Romanian
  romanian: 'ro', română: 'ro', romana: 'ro',
  ρουμανικά: 'ro', ρουμανικα: 'ro',
  루마니아어: 'ro',
  румынский: 'ro', рум: 'ro',

  // Serbian
  serbian: 'sr', srpski: 'sr',
  σερβικά: 'sr', σερβικα: 'sr',
  세르비아어: 'sr',
  сербский: 'sr', серб: 'sr',

  // Georgian
  georgian: 'ka', kartuli: 'ka',
  γεωργιανά: 'ka', γεωργιανα: 'ka',
  조지아어: 'ka',
  грузинский: 'ka', груз: 'ka',

  // Swedish
  swedish: 'sv', svenska: 'sv',
  σουηδικά: 'sv', σουηδικα: 'sv',
  스웨덴어: 'sv',
  шведский: 'sv', швед: 'sv',

  // Multi-language synthetic marker — matches any row whose language column
  // contains a comma (i.e. multiple ISO codes).
  multilingual: ',', 'multi-language': ',', 'multi language': ',', multi: ',',
  πολύγλωσσο: ',', πολυγλωσσο: ',', 'πολλαπλές γλώσσες': ',',
  다국어: ',', '여러 언어': ',',
  многоязычный: ',', 'много языков': ','
};

// Strip combining diacritics + lowercase. So "Ελληνικά" === "ελληνικα" === "ελληνικά".
function normalizeLangKey(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const LANGUAGE_SYNONYMS: Record<string, string> = Object.fromEntries(
  Object.entries(RAW_LANGUAGE_SYNONYMS).map(([k, v]) => [normalizeLangKey(k), v])
);

function languageMatchTerm(input: string): string {
  const norm = normalizeLangKey(input);
  if (!norm) return '';
  if (LANGUAGE_SYNONYMS[norm]) return LANGUAGE_SYNONYMS[norm];
  // Strip common prefixes ("in english", "lang: el", "γλώσσα: ελ", "язык: ru") then retry.
  const stripped = norm.replace(/^(in|lang|language|γλωσσα|язык|언어)\s*[:\-]?\s*/i, '').trim();
  if (stripped !== norm && LANGUAGE_SYNONYMS[stripped]) return LANGUAGE_SYNONYMS[stripped];
  return stripped || norm;
}

const SORT_COLUMN: Record<string, string> = {
  title: 'title',
  author: 'author',
  publicationYear: 'publication_year',
  status: 'status',
  updatedAt: 'updated_at'
};

function parseSearchTokens(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null = regex.exec(input);
  while (match) {
    // Fold diacritics on the way in so the FTS query side matches what the
    // FTS index stores. SQLite's `unicode61 remove_diacritics 2` tokenizer
    // strips Latin diacritics but does NOT strip the Greek tonos from
    // precomposed characters like ή/ά/ί — so an indexed all-caps title
    // ΓΑΒΡΙΗΛ tokenizes to `γαβριηλ`, but a user query `γαβριήλ` stays as
    // `γαβριήλ` and never matches. Folding the query here normalizes
    // ή→η, ς→σ, etc., independent of FTS tokenizer quirks.
    const raw = (match[1] ?? match[2] ?? '').trim();
    const token = foldDiacritics(raw);
    if (token) tokens.push(token);
    match = regex.exec(input);
  }
  return tokens;
}

function escapeFtsTerm(token: string): string {
  // FTS5 special characters: quote the whole phrase to be safe.
  const cleaned = token.replace(/"/g, '""');
  return `"${cleaned}"`;
}

function buildFtsQuery(opts: {
  q: string;
  qMode: 'all' | 'any' | 'exact';
  partialWords: boolean;
  fields: string[];
}): string | null {
  // Exact mode must diacritic-fold the phrase the same way the tokenized path
  // does (parseSearchTokens → foldDiacritics), otherwise an accented Greek query
  // like "ψυχή" never matches the folded FTS index and exact search silently
  // returns nothing for accented titles.
  const tokens = opts.qMode === 'exact'
    ? [foldDiacritics(opts.q)].filter(Boolean)
    : parseSearchTokens(opts.q);
  if (tokens.length === 0) return null;

  const ftsCols = opts.fields.map((f) => FIELD_TO_FTS_COLUMN[f]).filter(Boolean);
  const colPrefix = ftsCols.length > 0 ? `{${ftsCols.join(' ')}}:` : '';

  const formatted = tokens.map((token) => {
    if (opts.qMode === 'exact') {
      return `${colPrefix}${escapeFtsTerm(token)}`;
    }
    if (opts.partialWords) {
      // Prefix match — append * to a quoted-but-trimmed term.
      const cleaned = token.replace(/[*"]/g, '');
      if (!cleaned) return null;
      return `${colPrefix}"${cleaned}"*`;
    }
    return `${colPrefix}${escapeFtsTerm(token)}`;
  }).filter(Boolean) as string[];

  if (formatted.length === 0) return null;
  const joiner = opts.qMode === 'any' ? ' OR ' : ' AND ';
  return formatted.join(joiner);
}

// ─── Holdings ──────────────────────────────────────────────────────────────

const SNAKE_TO_CAMEL_ITEM_FIELDS: Record<string, string> = {
  book_id: 'bookId',
  copy_number: 'copyNumber',
  volume_num: 'volumeNum',
  volume_label: 'volumeLabel',
  room_code: 'roomCode',
  shelf_code: 'shelfCode',
  call_number: 'callNumber',
  item_type: 'itemType',
  acquisition_date: 'acquisitionDate',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  deleted_at: 'deletedAt',
  // Added by migration 0030 for the ISO 2789 withdrawal count and, like the
  // book columns above, never listed here.
  withdrawal_reason: 'withdrawalReason'
};

export function parseItem(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[SNAKE_TO_CAMEL_ITEM_FIELDS[key] ?? key] = value;
  }
  return out;
}

// ─── Serial holdings ───────────────────────────────────────────────────────

const SNAKE_TO_CAMEL_SERIAL_HOLDING_FIELDS: Record<string, string> = {
  book_id: 'bookId',
  from_volume: 'fromVolume',
  to_volume: 'toVolume',
  from_year: 'fromYear',
  to_year: 'toYear',
  created_at: 'createdAt',
  updated_at: 'updatedAt'
};

export function parseSerialHolding(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[SNAKE_TO_CAMEL_SERIAL_HOLDING_FIELDS[key] ?? key] = value;
  }
  return out;
}

/** The recorded run for one periodical, in the order the librarian arranged. */
export async function loadSerialHoldings(env: Env, bookId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    `SELECT * FROM serial_holdings WHERE book_id = ? ORDER BY seq ASC, created_at ASC, id ASC`
  ).bind(bookId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(parseSerialHolding);
}

/**
 * Holdings for many titles at once, keyed by book id.
 *
 * The MARC export walks the whole catalogue, and one query per record would be a
 * round trip per book. Ids are interpolated after a strict shape check because
 * SQLite has no array binding — the same approach `loadItemsForBooks` takes.
 */
export async function loadSerialHoldingsForBooks(
  env: Env,
  bookIds: string[]
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  const safe = bookIds.filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
  if (safe.length === 0) return out;
  const list = safe.map((id) => `'${id}'`).join(',');
  const rows = await env.DB.prepare(
    `SELECT * FROM serial_holdings WHERE book_id IN (${list})
      ORDER BY seq ASC, created_at ASC, id ASC`
  ).all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    const parsed = parseSerialHolding(row);
    const key = String(parsed.bookId);
    const list2 = out.get(key);
    if (list2) list2.push(parsed);
    else out.set(key, [parsed]);
  }
  return out;
}

export async function loadBookItems(env: Env, bookId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    `SELECT * FROM items WHERE book_id = ? AND deleted_at IS NULL
      ORDER BY copy_number ASC, created_at ASC, id ASC`
  ).bind(bookId).all<Record<string, unknown>>();
  return (rows.results ?? []).map(parseItem);
}

/**
 * Load the copies for many books at once, keyed by book id.
 *
 * The list view renders a location per row, and doing that with one query per
 * book would be 50 extra D1 round-trips per page. Ids are interpolated after a
 * strict shape check because SQLite has no array binding — the same approach
 * `/api/books/by-ids` already takes.
 */
export async function loadItemsForBooks(
  env: Env,
  bookIds: string[]
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  const safe = bookIds.filter((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id));
  if (safe.length === 0) return out;
  // CHUNKED at 90: D1 accepts at most 100 bound parameters per statement. This is
  // a shared helper — the book list, the merge-candidate screen and the MARC export
  // all reach it — and every caller that passed more than 100 ids got a 500 rather
  // than a page of results. A book list at pageSize 100 sat exactly on the ceiling.
  for (let i = 0; i < safe.length; i += 90) {
    const slice = safe.slice(i, i + 90);
    const placeholders = slice.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT * FROM items WHERE deleted_at IS NULL AND book_id IN (${placeholders})
        ORDER BY copy_number ASC, created_at ASC, id ASC`
    ).bind(...slice).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      const parsed = parseItem(row);
      const key = String(parsed.bookId);
      const list = out.get(key);
      if (list) list.push(parsed);
      else out.set(key, [parsed]);
    }
  }
  return out;
}

/**
 * Make sure a record has a primary copy, and that it carries the record's own
 * location.
 *
 * The single-book form still edits `books.shelf_code` directly — it is one
 * book in one place, and making the librarian open a holdings editor to move it
 * would be worse, not better. So the write flows record → primary copy here,
 * and `syncBookFromItems` flows the other way when the copies themselves are
 * edited. A book created before this layer existed, or created by an old
 * offline client, gets its copy minted on the next write rather than staying
 * invisible to every location filter.
 */
export async function ensurePrimaryItem(
  env: Env,
  bookId: string,
  book: { shelfCode?: string | null; roomCode?: string | null; status?: string; acquisitionDate?: string | null }
): Promise<void> {
  const now = nowIso();
  const primary = await env.DB.prepare(
    `SELECT id FROM items WHERE book_id = ? AND deleted_at IS NULL
      ORDER BY copy_number ASC, created_at ASC, id ASC LIMIT 1`
  ).bind(bookId).first<{ id: string }>();

  if (primary) {
    await env.DB.prepare(
      'UPDATE items SET shelf_code = ?, room_code = ?, updated_at = ? WHERE id = ?'
    ).bind(book.shelfCode ?? null, book.roomCode ?? null, now, primary.id).run();
    return;
  }
  // The deterministic id migration 0021 minted for this book may still be
  // sitting on a SOFT-DELETED row, in which case inserting it again is a primary
  // key collision — and this runs inside PUT /api/books/:id, so the record
  // became permanently uneditable behind a 500 the client retried four times.
  // Mint a fresh id instead of reviving the old row: the same reasoning as the
  // trash restore, which deliberately does not call this function, because
  // clearing `deleted_at` would put back a copy somebody withdrew on purpose.
  const deterministic = `itm_${bookId.replace(/-/g, '')}`;
  const taken = await env.DB.prepare('SELECT id FROM items WHERE id = ?')
    .bind(deterministic).first<{ id: string }>();

  await env.DB.prepare(
    `INSERT INTO items (id, book_id, copy_number, room_code, shelf_code, item_type, status,
                        acquisition_date, created_at, updated_at, version)
     VALUES (?, ?, 1, ?, ?, 'book', ?, ?, ?, ?, 0)`
  ).bind(
    taken ? newId('itm') : deterministic,
    bookId,
    book.roomCode ?? null,
    book.shelfCode ?? null,
    // Never mint a copy already on loan; circulation owns that transition.
    book.status === 'borrowed' ? 'borrowed' : (book.status ?? 'available'),
    book.acquisitionDate ?? null,
    now, now
  ).run();
}

/**
 * Soft-delete a record's copies alongside the record itself.
 *
 * Only touches copies that are currently live. A copy the librarian removed
 * earlier stays removed, and — because the stamp it carries is the book's own
 * deletion time — `restoreItemsDeletedAt` can tell the two apart.
 */
export async function setItemsDeleted(env: Env, bookId: string, deletedAt: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE items SET deleted_at = ?, updated_at = ? WHERE book_id = ? AND deleted_at IS NULL'
  ).bind(deletedAt, nowIso(), bookId).run();
}

/**
 * Bring back exactly the copies that the book's deletion took down.
 *
 * Matching on the deletion timestamp matters: clearing `deleted_at` for every
 * copy of the record would resurrect ones the librarian had deliberately
 * removed beforehand, silently putting books back on shelves they are not on.
 * Caught by the regression gate — the naive version restored a third copy.
 */
export async function restoreItemsDeletedAt(
  env: Env,
  bookId: string,
  deletedAt: string | null
): Promise<void> {
  if (!deletedAt) return;
  await env.DB.prepare(
    'UPDATE items SET deleted_at = NULL, updated_at = ? WHERE book_id = ? AND deleted_at = ?'
  ).bind(nowIso(), bookId, deletedAt).run();
}

/**
 * Keep the record's own location and status agreeing with its copies.
 *
 * `books.shelf_code` / `room_code` / `status` stay populated deliberately: the
 * CSV export, the label printer, sorting and every existing consumer read them,
 * and rewriting all of that at once would be a far riskier change than keeping
 * one derived value honest. The record now shows its PRIMARY copy's location
 * (lowest copy_number), and is available if ANY copy is.
 *
 * Location *filtering* does not use these — it queries items directly, so a
 * book held in two places is found under both.
 *
 * An OPEN LOAN pins a copy, whatever items.status happens to say. Circulation
 * writes items.status itself, so the two normally agree; the loan check is what
 * makes this safe to call from anywhere. Before migration 0028 nothing wrote
 * items.status at all, and this function would quietly free a borrowed record
 * whenever add-copies or a merge ran over it.
 */
/**
 * When a copy may leave the building.
 *
 * Three things must be true: the copy is physically available, nobody has it
 * out, and it is not set aside for someone in the hold queue. A ready hold is
 * a reservation, not a property of the copy — which is why it lives in `holds`
 * rather than as a fifth value of the CHECK-constrained items.status.
 */
const ITEM_IS_FREE = `i.status = 'available'
       AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
                        WHERE t.item_id = i.id AND t.returned_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM holds h
                        WHERE h.item_id = i.id AND h.status = 'ready')`;

export async function syncBookFromItems(env: Env, bookId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE books SET
       shelf_code = (SELECT i.shelf_code FROM items i
                      WHERE i.book_id = books.id AND i.deleted_at IS NULL
                      ORDER BY i.copy_number ASC, i.created_at ASC, i.id ASC LIMIT 1),
       room_code  = (SELECT i.room_code FROM items i
                      WHERE i.book_id = books.id AND i.deleted_at IS NULL
                      ORDER BY i.copy_number ASC, i.created_at ASC, i.id ASC LIMIT 1),
       status = CASE
         WHEN EXISTS (SELECT 1 FROM items i WHERE i.book_id = books.id AND i.deleted_at IS NULL
                                              AND ${ITEM_IS_FREE}) THEN 'available'
         WHEN EXISTS (SELECT 1 FROM borrow_transactions t
                       WHERE t.book_id = books.id AND t.returned_at IS NULL) THEN 'borrowed'
         ELSE COALESCE((SELECT i.status FROM items i
                         WHERE i.book_id = books.id AND i.deleted_at IS NULL
                         ORDER BY i.copy_number ASC, i.created_at ASC, i.id ASC LIMIT 1), books.status)
       END
     WHERE id = ?`
  ).bind(bookId).run();
}

/**
 * The copy a borrow should take when the operator did not name one.
 *
 * Lowest copy number first, so "copy 1" leaves before "copy 2" and the shelf
 * empties predictably. Returns null when every copy is out, lost or in
 * maintenance — the caller turns that into a 409 rather than lending a copy
 * that is not there.
 */
export async function pickLendableItem(
  env: Env,
  bookId: string,
  itemId?: string | null,
  /**
   * The borrower this loan is for. Their OWN ready hold does not block them —
   * collecting a hold is the one case where a copy set aside is handed over.
   */
  forHoldBorrowerId?: string | null
): Promise<{ id: string; shelfCode: string | null; copyNumber: number; itemType: string } | null> {
  const where = itemId
    ? 'i.book_id = ? AND i.id = ? AND i.deleted_at IS NULL'
    : 'i.book_id = ? AND i.deleted_at IS NULL';
  const args: unknown[] = itemId ? [bookId, itemId] : [bookId];
  const free = forHoldBorrowerId
    ? ITEM_IS_FREE.replace(
      "h.item_id = i.id AND h.status = 'ready'",
      "h.item_id = i.id AND h.status = 'ready' AND (h.borrower_id IS NULL OR h.borrower_id <> ?)"
    )
    : ITEM_IS_FREE;
  if (forHoldBorrowerId) args.push(forHoldBorrowerId);
  const row = await env.DB.prepare(
    `SELECT i.id, i.shelf_code, i.copy_number, i.item_type FROM items i
      WHERE ${where} AND ${free}
      ORDER BY i.copy_number ASC, i.created_at ASC, i.id ASC LIMIT 1`
  ).bind(...args).first<{ id: string; shelf_code: string | null; copy_number: number; item_type: string }>();
  return row
    ? { id: row.id, shelfCode: row.shelf_code, copyNumber: Number(row.copy_number), itemType: row.item_type }
    : null;
}

/** A resolved loan rule. Every field the borrow and renew paths need. */
export interface LoanPolicy {
  id: string;
  borrowerCategory: string;
  itemType: string;
  loanDays: number;
  renewalLimit: number;
  renewalDays: number;
  maxConcurrentLoans: number | null;
  lendable: boolean;
}

/**
 * The rule that applies to this borrower and this kind of copy.
 *
 * Most specific wins: an exact (category, type) match beats a category-wide
 * rule, which beats a type-wide rule, which beats the default. Ordering by the
 * two wildcard tests rather than fetching all four candidates keeps it to one
 * indexed read.
 *
 * There is always an answer — migration 0029 seeds ('*','*') — but the fallback
 * below means a library that deletes it still lends rather than 500s.
 */
export async function resolveLoanPolicy(
  env: Env,
  borrowerCategory: string,
  itemType: string
): Promise<LoanPolicy> {
  const row = await env.DB.prepare(
    `SELECT * FROM loan_policies
      WHERE (borrower_category = ? OR borrower_category = '*')
        AND (item_type = ? OR item_type = '*')
      ORDER BY (borrower_category <> '*') DESC, (item_type <> '*') DESC
      LIMIT 1`
  ).bind(borrowerCategory || 'standard', itemType || 'book').first<Record<string, unknown>>();

  if (!row) {
    return {
      id: 'pol_fallback', borrowerCategory: '*', itemType: '*',
      loanDays: 14, renewalLimit: 2, renewalDays: 14, maxConcurrentLoans: null, lendable: true
    };
  }
  const loanDays = Number(row.loan_days ?? 14);
  return {
    id: String(row.id),
    borrowerCategory: String(row.borrower_category),
    itemType: String(row.item_type),
    loanDays,
    renewalLimit: Number(row.renewal_limit ?? 0),
    // NULL renewal_days means "another full loan period".
    renewalDays: row.renewal_days == null ? loanDays : Number(row.renewal_days),
    maxConcurrentLoans: row.max_concurrent_loans == null ? null : Number(row.max_concurrent_loans),
    lendable: Number(row.lendable ?? 1) === 1
  };
}

/**
 * A due date `days` from now, at the end of that day in UTC.
 *
 * Anchored to 23:59:59.999 for the same reason the web client already does it:
 * "due in 14 days" is a date the reader reads off a slip, not an hour of the
 * afternoon that silently makes the book overdue at lunchtime.
 */
export function dueDateFromPolicy(days: number, from: Date = new Date()): string {
  const due = new Date(from.getTime() + days * 86400000);
  due.setUTCHours(23, 59, 59, 999);
  return due.toISOString();
}

/** Open loans this borrower already has. Advisory — the real check is in the borrow batch. */
export async function countOpenLoansFor(env: Env, borrowerId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM borrow_transactions WHERE borrower_id = ? AND returned_at IS NULL'
  ).bind(borrowerId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Close out ready holds nobody collected.
 *
 * This worker has no scheduled() handler, so nothing can run on a timer.
 * Expiry is therefore swept whenever the queue is looked at or a copy comes
 * back — cheap (one indexed UPDATE), and it means the librarian never sees a
 * copy held for someone who stopped coming three weeks ago. A hold that has
 * expired stops holding its copy immediately; the next return re-offers it.
 */
export async function expireStaleHolds(
  env: Env,
  now: string,
  /**
   * When the copy freed by an expiry is put aside for the next reader, this is
   * when THEIR pickup window closes. Passed in because the shelf period is
   * circulation policy and belongs with the rest of it, not in this module.
   */
  shelfExpiresAt?: string
): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE holds SET status = 'expired', closed_at = ?, updated_at = ?
      WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at < ?`
  ).bind(now, now, now).run();
  const expired = res.meta?.changes ?? 0;
  // Expiring a hold frees the copy it was pinning, and the queue behind it has
  // to move. This used to stop at the expiry, so the second reader waited for a
  // return that had already happened: the copy sat on the hold shelf marked
  // available, and nothing promoted the next 'waiting' hold until someone
  // borrowed and returned the book again.
  //
  // Two things were then wrong with the promotion itself, and both stranded a
  // reader rather than merely delaying them.
  //
  // ONE PER BOOK, not one per sweep. The subquery ended in a bare `LIMIT 1` over
  // every affected title, so when two titles' pickup windows lapsed together —
  // the normal state after a weekend, since expiry is only evaluated on read —
  // exactly one queue advanced. And because the outer match is
  // `closed_at = <this sweep's now>`, no later sweep could repair the other: its
  // own `now` differs, so those expired rows never match again. The correlated
  // `h.rowid = (head of THIS book's queue)` promotes the head of each affected
  // title instead.
  //
  // AND IT MUST PIN THE COPY. The promotion set only `status`, leaving item_id
  // and expires_at NULL. A 'ready' hold with no item_id pins nothing (a copy is
  // considered free unless a ready hold NAMES it), is invisible to
  // `fillNextHold` (which looks for 'waiting'), and can never lapse (expiry
  // requires expires_at IS NOT NULL) — so a walk-in could borrow the copy that
  // reader was promoted to, the next return would skip them for the person
  // behind them, and the unique index would refuse them a fresh hold. Promoted
  // for good, served never. It now carries over the freed copy and starts the
  // pickup clock, exactly as `fillNextHold` does, and promotes only when there
  // is a copy to carry — otherwise the reader stays 'waiting', which is the
  // state `fillNextHold` can still serve.
  if (expired > 0) {
    await env.DB.prepare(
      `UPDATE holds
          SET status = 'ready',
              item_id = (SELECT x.item_id FROM holds x
                          WHERE x.book_id = holds.book_id AND x.status = 'expired'
                            AND x.closed_at = ? AND x.item_id IS NOT NULL
                          LIMIT 1),
              ready_at = ?,
              expires_at = ?,
              updated_at = ?
        WHERE id IN (
          SELECT h.id FROM holds h
           WHERE h.status = 'waiting'
             AND h.book_id IN (SELECT book_id FROM holds
                                WHERE status = 'expired' AND closed_at = ? AND item_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM holds r
                              WHERE r.book_id = h.book_id AND r.status = 'ready')
             AND h.rowid = (SELECT h2.rowid FROM holds h2
                             WHERE h2.book_id = h.book_id AND h2.status = 'waiting'
                             ORDER BY h2.placed_at ASC, h2.rowid ASC
                             LIMIT 1)
        )`
    ).bind(now, now, shelfExpiresAt ?? null, now, now).run();
  }
  return expired;
}

/** How many copies of a record could be lent right now. Drives the UI's "2 of 3 available". */
export async function countLendableItems(env: Env, bookId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items i
      WHERE i.book_id = ? AND i.deleted_at IS NULL AND ${ITEM_IS_FREE}`
  ).bind(bookId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// Fields the facet rail can group by, and that the `(empty)` bucket can filter
// on. Whitelisted: a field name never reaches the SQL text unchecked, and a
// custom key's JSON path is BOUND rather than interpolated.
//
// Shared by /api/facets (which counts) and queryBooksWithFilters (which lists),
// deliberately — the two must agree on what "empty" means or the rail's counts
// stop reproducing as lists, which is the one thing the librarian relies on
// when reconciling the catalogue against a shelf.
const FACET_COLUMNS: Record<string, string> = {
  shelfCode: 'shelf_code',
  roomCode: 'room_code',
  language: 'language',
  status: 'status',
  publisher: 'publisher',
  publicationYear: 'publication_year',
  title: 'title',
  author: 'author',
  isbn: 'isbn'
};

/**
 * Everything the MARC / Dublin Core view of a record needs, for many books at
 * once.
 *
 * Batched deliberately: an export walks the whole catalogue, and doing four
 * lookups per book would be ~50,000 D1 round-trips. Three grouped queries per
 * page instead, keyed by book id.
 */
export async function loadMarcExtrasForBooks(
  env: Env,
  bookIds: string[]
): Promise<Map<string, {
  contributors: Array<{ name: string; role: string; dates?: string | null; kind?: string | null }>;
  subjects: Array<{ term: string; source?: string | null }>;
  seriesTitle: string | null;
}>> {
  const out = new Map<string, {
    contributors: Array<{ name: string; role: string; dates?: string | null; kind?: string | null }>;
    subjects: Array<{ term: string; source?: string | null }>;
    seriesTitle: string | null;
  }>();
  const safe = bookIds.filter((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id));
  if (safe.length === 0) return out;
  for (const id of safe) out.set(id, { contributors: [], subjects: [], seriesTitle: null });
  // CHUNKED at 90: D1 accepts at most 100 bound parameters per statement, and the
  // SRU path can ask for 100 records at once. Recursing on slices keeps the two
  // queries below exactly as they are — this function only ever fills `out` per
  // book id, so merging the slices is the same as one pass.
  if (safe.length > 90) {
    for (let i = 0; i < safe.length; i += 90) {
      const part = await loadMarcExtrasForBooks(env, safe.slice(i, i + 90));
      for (const [k, v] of part) out.set(k, v);
    }
    return out;
  }
  const ph = safe.map(() => '?').join(',');

  const links = await env.DB.prepare(
    `SELECT ba.book_id, ba.role, a.kind, a.preferred_form, a.dates, a.source
       FROM book_authorities ba JOIN authorities a ON a.id = ba.authority_id
      WHERE a.deleted_at IS NULL AND ba.book_id IN (${ph})
      ORDER BY ba.seq ASC`
  ).bind(...safe).all<{
    book_id: string; role: string; kind: string; preferred_form: string;
    dates: string | null; source: string | null;
  }>();
  for (const r of links.results ?? []) {
    const entry = out.get(r.book_id);
    if (!entry) continue;
    // A subject authority is a 650, everyone else is a name added entry.
    if (r.kind === 'subject') entry.subjects.push({ term: r.preferred_form, source: r.source });
    else entry.contributors.push({ name: r.preferred_form, role: r.role, dates: r.dates, kind: r.kind });
  }

  const sets = await env.DB.prepare(
    `SELECT b.id AS book_id, s.title
       FROM books b JOIN book_sets s ON s.id = b.set_id
      WHERE s.deleted_at IS NULL AND b.id IN (${ph})`
  ).bind(...safe).all<{ book_id: string; title: string }>();
  for (const r of sets.results ?? []) {
    const entry = out.get(r.book_id);
    if (entry) entry.seriesTitle = r.title;
  }

  return out;
}

/**
 * Records for an OAI-PMH harvest window.
 *
 * Its own query rather than queryBooksWithFilters, because harvesting has
 * requirements the browse path does not: ordered by `updated_at` so a resumption
 * token is a stable cursor, filtered on that same column, and it must INCLUDE
 * soft-deleted rows — a harvester that never hears about a withdrawal keeps
 * serving the book forever. `deletedRecord: persistent` in Identify is a promise
 * this query is what keeps.
 */
export async function loadOaiPage(
  env: Env,
  opts: {
    from?: string; until?: string; limit: number;
    /** Keyset position — resume strictly after this (updated_at, id). */
    after?: { updatedAt: string; id: string } | null;
    /** Legacy offset, for resumption tokens issued before the keyset. */
    offset?: number;
  }
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const where: string[] = ['1=1'];
  const values: unknown[] = [];
  if (opts.from) { where.push('updated_at >= ?'); values.push(opts.from); }
  if (opts.until) { where.push('updated_at <= ?'); values.push(opts.until); }
  // The total is counted over the RANGE, not the remainder, so completeListSize
  // keeps its meaning across pages.
  const countSql = `WHERE ${where.join(' AND ')}`;
  const countValues = [...values];

  // Keyset, not OFFSET. `updated_at` is not unique in this catalogue and rows MOVE
  // when a record is saved, so an offset over this ordering steps over a row for
  // every edit made during a harvest. `(updated_at, id)` is a total order, which is
  // what makes "strictly after this exact row" expressible.
  if (opts.after) {
    where.push('(updated_at > ? OR (updated_at = ? AND id > ?))');
    values.push(opts.after.updatedAt, opts.after.updatedAt, opts.after.id);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [countRes, rowsRes] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM books ${countSql}`).bind(...countValues).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT * FROM books ${whereSql} ORDER BY updated_at ASC, id ASC LIMIT ? OFFSET ?`
    ).bind(...values, opts.limit, opts.after ? 0 : (opts.offset ?? 0)).all<Record<string, unknown>>()
  ]);
  return {
    rows: (rowsRes.results ?? []).map(parseBook),
    total: Number(countRes?.n ?? 0)
  };
}

/**
 * Groups of records that look like the same book catalogued more than once.
 *
 * Grouped on the accent+case fold of title AND author together — title alone
 * would propose merging "ΠΟΙΗΜΑΤΑ" by four different poets. Blank authors are
 * folded to one bucket so the catalogue's author-less entries still group.
 *
 * Read-only. Deciding whether two records are the same book is a judgement the
 * librarian makes; this only narrows the field.
 *
 * Two strictnesses, because title+author alone finds 367 groups in this
 * catalogue and most are NOT the back-shelf duplication — two printings of the
 * same work by the same author legitimately share both. `strict` also requires
 * the publisher, the year and the ISBN to agree, which is the shape of a record
 * that was copied rather than catalogued twice, and is the safe bulk case.
 */
export async function loadMergeCandidateGroups(
  env: Env,
  opts: { limit: number; offset: number; strict?: boolean; q?: string }
): Promise<{ groups: Array<{ key: string; bookIds: string[] }>; total: number }> {
  // `IFNULL(fold, raw)` because rows written before migration 0012 can still
  // have a null fold; without it those books would never be offered.
  const parts = [
    `IFNULL(b.title_fold, LOWER(TRIM(b.title)))`,
    `IFNULL(b.author_fold, LOWER(TRIM(b.author)))`
  ];
  if (opts.strict) {
    parts.push(
      `IFNULL(b.publisher_fold, LOWER(TRIM(COALESCE(b.publisher, ''))))`,
      `COALESCE(CAST(b.publication_year AS TEXT), '')`,
      `IFNULL(b.isbn_fold, LOWER(TRIM(COALESCE(b.isbn, ''))))`
    );
  }
  const keyExpr = parts.join(` || CHAR(31) || `);

  // Narrowing by title, so the librarian can work one shelf or one series at a
  // time instead of a 367-group list. Folded on both sides, matching how the
  // rest of the catalogue searches: an accent typed or not typed is the same.
  const q = foldDiacritics((opts.q ?? '').trim());
  const where = `WHERE b.deleted_at IS NULL AND TRIM(COALESCE(b.title, '')) <> ''`
    + (q ? ` AND IFNULL(b.title_fold, LOWER(TRIM(b.title))) LIKE ?` : '');
  const filterArgs = q ? [`%${q.replace(/[%_]/g, '')}%`] : [];

  const [countRes, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT ${keyExpr} AS k FROM books b
          ${where}
          GROUP BY k HAVING COUNT(*) > 1)`
    ).bind(...filterArgs).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT ${keyExpr} AS k, GROUP_CONCAT(b.id) AS ids, COUNT(*) AS n
         FROM books b
        ${where}
        GROUP BY k HAVING COUNT(*) > 1
        ORDER BY n DESC, k ASC
        LIMIT ? OFFSET ?`
    ).bind(...filterArgs, opts.limit, opts.offset).all<{ k: string; ids: string; n: number }>()
  ]);

  return {
    total: Number(countRes?.n ?? 0),
    // CHAR(31) is a separator, not content: it cannot occur in a catalogue
    // string, which is the point, but it must not travel to the client either.
    groups: (rows.results ?? []).map((r) => ({
      key: (r.k ?? '').replaceAll('\u001f', ' · '),
      bookIds: (r.ids ?? '').split(',').filter(Boolean)
    }))
  };
}

/** The institution's own identifiers — MARC 040/852, OAI-PMH repository id. */
export async function getLibrarySettings(env: Env): Promise<Record<string, string | null>> {
  const rows = await env.DB.prepare('SELECT key, value FROM library_settings').all<{ key: string; value: string | null }>();
  const out: Record<string, string | null> = {};
  for (const r of rows.results ?? []) out[r.key] = r.value;
  return out;
}

// Fields that live on the COPIES rather than the record. Faceting and filtering
// on these has to go through `items`, or a book held in two places is only ever
// counted at one of them.
export const ITEM_BACKED_FACETS: Record<string, string> = {
  shelfCode: 'shelf_code',
  roomCode: 'room_code'
};

export function resolveEmptyFieldExpr(
  field: string,
  prefix = 'b.'
): { expr: string; bind: string[] } | null {
  if (field.startsWith('custom:')) {
    const key = field.slice('custom:'.length);
    if (!/^[a-zA-Z0-9_]+$/.test(key)) return null;
    return { expr: `json_extract(${prefix}custom_fields, ?)`, bind: [`$.${key}`] };
  }
  const column = FACET_COLUMNS[field];
  return column ? { expr: `${prefix}${column}`, bind: [] } : null;
}

export async function queryBooksWithFilters(
  env: Env,
  opts: {
    q?: string;
    qMode?: 'all' | 'any' | 'exact';
    qExclude?: string;
    partialWords?: boolean;
    fuzzyTypos?: boolean;
    searchFields?: string;
    status?: string;
    language?: string;
    year?: number;
    yearMin?: number;
    yearMax?: number;
    roomCode?: string;
    shelfCode?: string;
    missingIsbn?: boolean;
    missingShelf?: boolean;
    untitled?: boolean;
    invalidIsbn?: boolean;
    unknownAuthor?: boolean;
    /** Facet-rail selection: one exact value of a whitelisted field. */
    facetField?: string;
    facetValue?: string;
    /** "Nothing recorded in this field" — the facet rail's `(empty)` bucket. */
    emptyField?: string;
    includeDeleted?: boolean;
    sortBy: string;
    sortDir: 'asc' | 'desc';
    page: number;
    pageSize: number;
    customFilters: Array<{ key: string; value: string }>;
    // Callers that don't need the total (e.g. the full-catalogue CSV export,
    // which walks every page and discards `total`) set this to skip the
    // COUNT(*) scan — that's ~12,500 D1 rows read PER page otherwise.
    skipCount?: boolean;
    // Exact "same as this book" criteria for criteria-based selection.
    authorExact?: string;
    publisherExact?: string;
    shelfExact?: string;
    // Return ONLY the matching ids (unpaginated, up to `idsLimit`) instead of
    // full rows. Used by "select all matching": selecting 3,000 books must not
    // read 3,000 whole rows when the client only needs their ids.
    idsOnly?: boolean;
    idsLimit?: number;
  }
): Promise<{ total: number; rows: Array<Record<string, unknown>>; ids?: string[] }> {
  const qText = (opts.q ?? '').trim();
  const excludeText = (opts.qExclude ?? '').trim();
  const requestedFields = (opts.searchFields ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  const activeFields = (requestedFields.length > 0 ? requestedFields : ['title', 'author', 'isbn'])
    .filter((f) => Object.prototype.hasOwnProperty.call(SQL_FIELD_EXPR, f));

  const sortColumn = SORT_COLUMN[opts.sortBy] ?? 'updated_at';
  const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';
  // When sorting by author or title, keep the "no value" rows (empty string or
  // the legacy '(Unknown)'/'(Untitled)' sentinels) at the END regardless of
  // direction — otherwise an A→Z author sort buries every real author under
  // pages of placeholders. `sortColumn` is from a fixed whitelist, so it is safe
  // to interpolate here.
  const blankLastSort = (opts.sortBy === 'author' || opts.sortBy === 'title')
    ? `CASE WHEN b.${sortColumn} IS NULL OR TRIM(b.${sortColumn}) = '' OR b.${sortColumn} IN ('(Unknown)', '(Untitled)') THEN 1 ELSE 0 END, `
    : '';
  const limit = Math.max(1, Math.min(100, opts.pageSize));
  const offset = (Math.max(1, opts.page) - 1) * limit;

  const where: string[] = [];
  if (!opts.includeDeleted) {
    where.push('b.deleted_at IS NULL');
  }
  const values: unknown[] = [];
  let useFtsJoin = false;

  if (opts.status) {
    where.push('b.status = ?');
    values.push(opts.status);
  }
  if (opts.language) {
    // Smart match: friendly names ("English", "Greek") → ISO codes; case-
    // insensitive substring so "EN" still matches multi-language values like
    // "EL,EN,FR" without forcing the user to type the exact string.
    const term = languageMatchTerm(opts.language);
    if (term) {
      where.push('LOWER(b.language) LIKE ?');
      values.push(`%${term}%`);
    }
  }
  // Year filters test OVERLAP with the book's date span, not equality with a
  // single year. A volume bound from two parts and dated 1955/1957 is genuinely
  // a 1956 book as far as browsing goes, and "before 1960" has to include it.
  // COALESCE because the span end is only stored when it differs — for the
  // ~12.5K single-year rows this reduces to exactly the old comparison.
  if (opts.year) {
    where.push('(b.publication_year <= ? AND COALESCE(b.publication_year_end, b.publication_year) >= ?)');
    values.push(opts.year, opts.year);
  }
  if (opts.yearMin !== undefined) {
    where.push('COALESCE(b.publication_year_end, b.publication_year) >= ?');
    values.push(opts.yearMin);
  }
  if (opts.yearMax !== undefined) {
    where.push('b.publication_year <= ?');
    values.push(opts.yearMax);
  }
  if (opts.missingIsbn) {
    where.push("(b.isbn IS NULL OR TRIM(b.isbn) = '')");
  }
  if (opts.missingShelf) {
    // "Unshelved" means no copy has a location — a record with one copy on a
    // shelf and one still unplaced is not lost, so it must not appear here.
    where.push(`NOT EXISTS (SELECT 1 FROM items i WHERE i.book_id = b.id AND i.deleted_at IS NULL
                             AND TRIM(COALESCE(i.shelf_code, '')) <> '')`);
  }
  if (opts.invalidIsbn) {
    // The generated column, so this is a plain indexed predicate rather than a
    // scan — idx_books_isbn_invalid is partial on exactly this value.
    where.push('b.isbn_valid = 0');
  }
  if (opts.untitled) {
    where.push("(b.title = '(Untitled)' OR b.title IS NULL OR TRIM(b.title) = '')");
  }
  if (opts.unknownAuthor) {
    // Author-less books exist in two on-disk forms: the catalog-import
    // placeholder '(Unknown)' and the empty string written when the add/edit
    // form or a JSON/sync import leaves author blank. Match both (plus NULL for
    // safety) so every author-less book surfaces in this smart list.
    where.push("(b.author = '(Unknown)' OR b.author IS NULL OR TRIM(b.author) = '')");
  }
  // Facet-rail selection.
  //
  // Both predicates are character-for-character what /api/facets groups by, and
  // they have to stay that way: the librarian compares a shelf's count here
  // against the books physically on it, so a count that doesn't reproduce as a
  // list is worse than no count. That is also why these don't reuse the
  // existing `language`/`shelfCode`/`custom_<key>` filters — those match
  // loosely (synonyms, substrings, or value-equals-'' which misses absent keys)
  // and would return a different number than the rail advertised.
  if (opts.facetField && opts.facetValue !== undefined && opts.facetValue !== '') {
    const itemColumn = ITEM_BACKED_FACETS[opts.facetField];
    if (itemColumn) {
      // "has a copy there" — the same thing the facet counted.
      where.push(`EXISTS (SELECT 1 FROM items i WHERE i.book_id = b.id AND i.deleted_at IS NULL
                           AND TRIM(COALESCE(i.${itemColumn}, '')) = ?)`);
      values.push(opts.facetValue);
    } else {
      const spec = resolveEmptyFieldExpr(opts.facetField);
      if (spec) {
        where.push(`TRIM(COALESCE(CAST(${spec.expr} AS TEXT), '')) = ?`);
        values.push(...spec.bind, opts.facetValue);
      }
    }
  }
  if (opts.emptyField) {
    const itemColumn = ITEM_BACKED_FACETS[opts.emptyField];
    if (itemColumn) {
      // "NO copy has one" — a record with one shelved and one unplaced copy is
      // not missing a location, so it must not be listed here.
      where.push(`NOT EXISTS (SELECT 1 FROM items i WHERE i.book_id = b.id AND i.deleted_at IS NULL
                               AND TRIM(COALESCE(i.${itemColumn}, '')) <> '')`);
    } else {
      const spec = resolveEmptyFieldExpr(opts.emptyField);
      if (spec) {
        where.push(`TRIM(COALESCE(CAST(${spec.expr} AS TEXT), '')) = ''`);
        values.push(...spec.bind);
      }
    }
  }
  // Location filters run over the book's COPIES, not the record.
  //
  // A record can now be held in more than one place — the whole point of the
  // holdings layer — so asking "what is on shelf 19-000 ΠΙΣΩ" has to mean "which
  // records have a copy there". Matching `books.shelf_code` would only ever see
  // the primary copy and would silently omit the back-shelf duplicates the
  // librarian created the copies for.
  //
  // Substring + case-insensitive so "06" matches "06-005", "06-105", etc.
  // SQLite's LOWER() is ASCII-only and cannot case-fold Greek — a librarian
  // typing "πισω" would never reach the stored "ΠΙΣΩ". Codes are persisted
  // upper-cased by normalizeCode, so upper-casing the needle the SAME way lets
  // the plain LIKE match Greek too, and the LOWER() pair still covers the
  // ASCII half for any legacy row that predates normalization.
  if (opts.roomCode) {
    where.push(`EXISTS (SELECT 1 FROM items i WHERE i.book_id = b.id AND i.deleted_at IS NULL
                         AND (LOWER(i.room_code) LIKE LOWER(?) OR i.room_code LIKE ?))`);
    values.push(`%${opts.roomCode}%`, `%${normalizeCode(opts.roomCode)}%`);
  }
  if (opts.shelfCode) {
    where.push(`EXISTS (SELECT 1 FROM items i WHERE i.book_id = b.id AND i.deleted_at IS NULL
                         AND (LOWER(i.shelf_code) LIKE LOWER(?) OR i.shelf_code LIKE ?))`);
    values.push(`%${opts.shelfCode}%`, `%${normalizeCode(opts.shelfCode)}%`);
  }
  // EXACT "same as this book" criteria, used by the criteria-based selection
  // ("select every book by this author / on this shelf / from this publisher").
  // Author and publisher match on the accent+case FOLD so the variant spellings
  // of one name ("ΜΙΓΝΕ" / "Migne") are treated as the same person — which is
  // exactly what a librarian means by "the same author". Shelf codes are stored
  // upper-cased by normalizeBookData, so those compare literally.
  // Match the fold column when it is populated (that catches variant spellings
  // of one name), and fall back to raw equality otherwise. The fallback matters:
  // the bulk-imported catalogue has NULL *_fold on many rows, and SQLite's
  // LOWER() is ASCII-only, so a Greek name would never match through the fold
  // expression alone.
  if (opts.authorExact !== undefined) {
    where.push("(COALESCE(b.author_fold, '') = ? OR TRIM(COALESCE(b.author, '')) = ?)");
    values.push(foldDiacritics(opts.authorExact), opts.authorExact.trim());
  }
  if (opts.publisherExact !== undefined) {
    where.push("(COALESCE(b.publisher_fold, '') = ? OR TRIM(COALESCE(b.publisher, '')) = ?)");
    values.push(foldDiacritics(opts.publisherExact), opts.publisherExact.trim());
  }
  if (opts.shelfExact !== undefined) {
    // Over COPIES, so "select everything on this shelf" reaches the back-shelf
    // duplicates as well as the primary copies.
    //
    // Two bound forms, because Greek has two upper-case spellings in play:
    // `normalizeCode` produces the correct accent-less "ΠΙΣΩ", while rows
    // written before that fix hold "ΠΊΣΩ" from a plain .toUpperCase(). Matching
    // both keeps this working during the window before
    // POST /api/admin/normalize-books has healed the catalogue. For every
    // non-Greek code the two forms are identical and this degenerates to the
    // original single comparison.
    const shelfTrimmed = opts.shelfExact.trim();
    where.push(`EXISTS (SELECT 1 FROM items i WHERE i.book_id = b.id AND i.deleted_at IS NULL
                         AND (UPPER(TRIM(COALESCE(i.shelf_code, ''))) = ?
                              OR TRIM(COALESCE(i.shelf_code, '')) = ?))`);
    values.push(shelfTrimmed.toUpperCase(), normalizeCode(shelfTrimmed));
  }
  for (const filter of opts.customFilters) {
    // json_extract validates the path; key is constrained to [a-zA-Z0-9_] in custom_field schema.
    if (!/^[a-zA-Z0-9_]+$/.test(filter.key)) continue;
    // Normalize boolean string values so '1'/'true'/'yes' and '0'/'false'/'no'
    // both match JSON booleans (which json_extract returns as int 0/1) and
    // legacy text values. We CAST the extracted value to TEXT so SQLite's
    // strict type affinity doesn't make `1 = '1'` evaluate to false.
    const raw = String(filter.value).trim();
    const lower = raw.toLowerCase();
    const truthy = ['1', 'true', 'yes', 'y'].includes(lower);
    const falsy = ['0', 'false', 'no', 'n'].includes(lower);
    if (truthy || falsy) {
      where.push(
        `CAST(json_extract(b.custom_fields, '$.${filter.key}') AS TEXT) IN (?, ?)`
      );
      if (truthy) {
        values.push('1', 'true');
      } else {
        values.push('0', 'false');
      }
    } else {
      where.push(
        `CAST(json_extract(b.custom_fields, '$.${filter.key}') AS TEXT) = ?`
      );
      values.push(raw);
    }
  }

  const fuzzyEnabled = Boolean(opts.fuzzyTypos) && qText.length > 0 && opts.qMode !== 'exact';

  // Path A: fuzzy mode — skip the FTS MATCH constraint so severe typos still
  // get candidates. The post-filter Levenshtein step runs in the Worker, on
  // the structurally-filtered candidate set (capped at 5000).
  if (!fuzzyEnabled && qText) {
    // Only some fields are FTS-indexed (title/author/isbn/publisher/description/
    // tags/custom). If the user restricts the search to a NON-FTS field
    // (language / shelf / room code), FTS can't target it — previously the
    // empty column list collapsed to an unrestricted all-column match, silently
    // ignoring the restriction. Split the fields and handle each kind properly.
    const ftsFields = activeFields.filter((f) => FIELD_TO_FTS_COLUMN[f]);
    const nonFtsFields = activeFields.filter((f) => !FIELD_TO_FTS_COLUMN[f] && SQL_FIELD_FOLD_EXPR[f]);

    if (ftsFields.length > 0) {
      const ftsQuery = buildFtsQuery({
        q: qText,
        qMode: opts.qMode ?? 'all',
        partialWords: opts.qMode === 'exact' ? false : (opts.partialWords ?? true),
        fields: ftsFields
      });
      if (ftsQuery) {
        useFtsJoin = true;
        where.push('books_fts MATCH ?');
        values.push(ftsQuery);
      }
    } else if (nonFtsFields.length > 0) {
      // Fold-aware substring match on the selected non-FTS field(s).
      const folded = foldDiacritics(qText).trim();
      if (folded) {
        const likeConds = nonFtsFields.map((f) => `${SQL_FIELD_FOLD_EXPR[f]} LIKE ?`);
        where.push(`(${likeConds.join(' OR ')})`);
        for (let i = 0; i < nonFtsFields.length; i += 1) values.push(`%${folded}%`);
      }
    }
  }

  // Exclusion terms: NOT EXISTS subquery against FTS to keep the main plan fast.
  if (excludeText) {
    const excludes = parseSearchTokens(excludeText);
    if (excludes.length > 0) {
      const excludeFts = excludes.map((t) => escapeFtsTerm(t)).join(' OR ');
      where.push('b.ROWID NOT IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)');
      values.push(excludeFts);
    }
  }

  if (fuzzyEnabled) {
    return await runFuzzyFiltered(env, {
      where,
      values,
      qText,
      qMode: opts.qMode ?? 'all',
      activeFields,
      sortColumn,
      sortDir,
      limit,
      offset,
      useFtsJoin,
      idsOnly: opts.idsOnly,
      idsLimit: opts.idsLimit
    });
  }

  const fromClause = useFtsJoin
    ? 'books b JOIN books_fts ON books_fts.rowid = b.ROWID'
    : 'books b';
  const whereSql = `WHERE ${where.join(' AND ')}`;

  // Ids-only: one narrow, unpaginated query over the same WHERE. Capped so a
  // pathological "select everything" can't stream the whole table.
  if (opts.idsOnly) {
    const cap = Math.max(1, Math.min(20000, opts.idsLimit ?? 10000));
    const idsRes = await env.DB.prepare(
      `SELECT b.id FROM ${fromClause} ${whereSql}
       ORDER BY ${blankLastSort}b.${sortColumn} ${sortDir}, b.id DESC LIMIT ?`
    )
      .bind(...values, cap)
      .all<{ id: string }>();
    const ids = (idsRes.results ?? []).map((r) => r.id);
    return { total: ids.length, rows: [], ids };
  }

  const rowsStmt = env.DB.prepare(
    `SELECT b.* FROM ${fromClause} ${whereSql}
     ORDER BY ${blankLastSort}b.${sortColumn} ${sortDir}, b.id DESC LIMIT ? OFFSET ?`
  ).bind(...values, limit, offset);

  // Skip the COUNT(*) entirely when the caller doesn't need the total — it's a
  // full index scan of every matching row on each call.
  if (opts.skipCount) {
    const rowsRes = await rowsStmt.all();
    const rows = ((rowsRes.results ?? []) as Array<Record<string, unknown>>).map(parseBook);
    return { total: rows.length, rows };
  }

  const countStmt = env.DB.prepare(`SELECT COUNT(*) as count FROM ${fromClause} ${whereSql}`).bind(...values);
  const [countRes, rowsRes] = await Promise.all([countStmt.first<{ count: number }>(), rowsStmt.all()]);
  const rows = ((rowsRes.results ?? []) as Array<Record<string, unknown>>).map(parseBook);

  return {
    total: Number(countRes?.count ?? 0),
    rows
  };
}

async function runFuzzyFiltered(
  env: Env,
  ctx: {
    where: string[];
    values: unknown[];
    qText: string;
    qMode: 'all' | 'any' | 'exact';
    activeFields: string[];
    sortColumn: string;
    sortDir: 'ASC' | 'DESC';
    limit: number;
    offset: number;
    useFtsJoin: boolean;
    // Mirrors the non-fuzzy path: return every matching id instead of one page.
    // Without this, "select all matching" fell back to a single 25-row page
    // whenever a search term was active (fuzzy is on by default), so a bulk
    // action silently applied to a slice of what the user was shown.
    idsOnly?: boolean;
    idsLimit?: number;
  }
): Promise<{ total: number; rows: Array<Record<string, unknown>>; ids?: string[] }> {
  // Build a permissive SQL LIKE pre-filter so substring matches *always*
  // surface even when the catalog has more rows than the candidate cap. For
  // each query token we OR a `%token%` (catches exact-substring hits) and a
  // `%prefix%` (catches tail typos within the configured Levenshtein
  // threshold) across every active field. Tokens combine with AND for
  // qMode='all' (default) or OR for qMode='any'.
  //
  // The Worker-side Levenshtein step still runs against the resulting set so
  // mid-word typos are also caught — but the SQL gate prevents the previous
  // bug where a book that matched exactly was simply outside the 5000-row
  // window taken from the structurally-filtered candidate set.
  const tokens = parseSearchTokens(ctx.qText.toLowerCase());

  const where = [...ctx.where];
  const values = [...ctx.values];
  // Use the fold-aware expressions: the tokens have already been folded via
  // `parseSearchTokens` → `foldDiacritics`, so we need to compare against
  // the fold-normalized columns. Without this the LIKE branch would fail to
  // match accented text (e.g. "Γαβριήλ" vs query "γαβριηλ") — the previous
  // `LOWER(COALESCE(title, ''))` only ASCII-lowercased, so Greek tonos
  // characters slipped through. Falling through `COALESCE(_fold, LOWER(raw))`
  // is correct for both new and legacy rows.
  const fieldExprs = ctx.activeFields
    .map((f) => SQL_FIELD_FOLD_EXPR[f])
    .filter((expr): expr is string => Boolean(expr));
  if (tokens.length > 0 && fieldExprs.length > 0) {
    // Per-token recall gate: a row passes if EITHER
    //   (a) any active column LIKE '%token%' / '%prefix%'  — substring & tail-typo recall
    //   (b) the row appears in the FTS5 index for `token*` — diacritic-insensitive
    //       prefix recall (FTS is configured with `remove_diacritics 2`).
    // Combining both is required because LIKE is byte-exact (so "ψυχη" misses
    // "ψυχή") and FTS only indexes whole words (so "%mid%" misses substrings
    // not at a word boundary). The OR keeps recall a strict superset of what
    // the non-fuzzy FTS path would have returned.
    const perTokenSql: string[] = [];
    for (const token of tokens) {
      const threshold = typoThreshold(token);
      const prefixLen = Math.max(2, token.length - threshold);
      const prefix = token.slice(0, prefixLen);
      const orParts: string[] = [];
      for (const expr of fieldExprs) {
        orParts.push(`${expr} LIKE ?`);
        values.push(`%${token}%`);
        if (prefix && prefix !== token) {
          orParts.push(`${expr} LIKE ?`);
          values.push(`%${prefix}%`);
        }
      }
      // FTS recall: prefix-match the token in any of the active FTS columns.
      const ftsCols = ctx.activeFields
        .map((f) => FIELD_TO_FTS_COLUMN[f])
        .filter((c): c is string => Boolean(c));
      const cleaned = token.replace(/[*"]/g, '');
      if (cleaned) {
        const colPrefix = ftsCols.length > 0 ? `{${ftsCols.join(' ')}}:` : '';
        orParts.push('b.ROWID IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)');
        values.push(`${colPrefix}"${cleaned}"*`);
      }
      perTokenSql.push(`(${orParts.join(' OR ')})`);
    }
    const joiner = ctx.qMode === 'any' ? ' OR ' : ' AND ';
    where.push(`(${perTokenSql.join(joiner)})`);
  }

  // Higher cap is safe because fuzzy mode no longer rides on top of an FTS
  // MATCH constraint — the candidates here are the structurally-filtered set
  // (status, language, year, plus the per-token LIKE gate above).
  const FUZZY_CANDIDATE_CAP = 5000;
  const fromClause = ctx.useFtsJoin
    ? 'books b JOIN books_fts ON books_fts.rowid = b.ROWID'
    : 'books b';
  const whereSql = `WHERE ${where.join(' AND ')}`;

  // Same blanks-last rule as the primary list query so author/title sorts don't
  // bury real values under empty/placeholder rows (the candidate order is
  // preserved through the JS fuzzy filter + slice below).
  const fuzzyBlankLast = (ctx.sortColumn === 'author' || ctx.sortColumn === 'title')
    ? `CASE WHEN b.${ctx.sortColumn} IS NULL OR TRIM(b.${ctx.sortColumn}) = '' OR b.${ctx.sortColumn} IN ('(Unknown)', '(Untitled)') THEN 1 ELSE 0 END, `
    : '';
  const candidateStmt = env.DB.prepare(
    `SELECT b.* FROM ${fromClause} ${whereSql}
     ORDER BY ${fuzzyBlankLast}b.${ctx.sortColumn} ${ctx.sortDir}, b.id DESC LIMIT ?`
  ).bind(...values, FUZZY_CANDIDATE_CAP);
  const res = await candidateStmt.all();
  const rows = ((res.results ?? []) as Array<Record<string, unknown>>).map(parseBook);

  const filtered = rows.filter((row) => fuzzyRowMatches(row, tokens, ctx.activeFields, ctx.qMode));

  // Ids-only callers ("select all matching") need the WHOLE matched set, not a
  // page — otherwise a bulk action runs on 25 books while the UI promised N.
  if (ctx.idsOnly) {
    const cap = Math.max(1, Math.min(20000, ctx.idsLimit ?? 10000));
    const ids = filtered.slice(0, cap).map((r) => String((r as { id: unknown }).id));
    return { total: ids.length, rows: [], ids };
  }

  const paged = filtered.slice(ctx.offset, ctx.offset + ctx.limit);
  return { total: filtered.length, rows: paged };
}

function splitWords(text: string): string[] {
  // Split on any non-letter/non-number character. The Unicode `\p{L}` and
  // `\p{N}` classes ensure Greek / Korean / Cyrillic / etc. tokens are
  // preserved (the previous `[a-z0-9]` regex stripped non-ASCII entirely,
  // which made fuzzy match silently fail on non-Latin titles).
  return foldDiacritics(text.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Case-fold + diacritic-fold + Greek final-sigma normalize. Mirrors the FTS5
 * tokenizer's `remove_diacritics 2` *and* covers a few cases SQLite's LOWER
 * doesn't:
 *   • SQLite's built-in LOWER only handles ASCII, so a stored "Γαβριήλ"
 *     never matched a typed "γαβριηλ" through the LIKE branch — JS
 *     toLowerCase here folds Greek capitals correctly.
 *   • Greek final sigma `ς` (end of word) and `σ` (mid-word) are the same
 *     letter; collapse them so `Δούλος` and `δούλοσ` (or `δουλος` after
 *     diacritic strip) compare equal.
 *   • NFKD decomposition + combining-mark strip removes tonos / dialytika /
 *     accents across Greek, Latin, Cyrillic, and Vietnamese alike.
 */
export function foldDiacritics(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ς/g, 'σ');
}

/**
 * Compute the seven `*_fold` column values written to `books` alongside the
 * raw fields. The trigger in migration 0012 feeds these (with COALESCE
 * fallback) into the `books_fts` virtual table, so that what the FTS index
 * actually sees is already normalized — independent of FTS5's tokenizer
 * limitations on Greek/Cyrillic precomposed accents.
 *
 * Inputs are the *exact* values about to be stored on the row (tags and
 * custom_fields as their JSON-serialized strings, since that's what the
 * raw columns hold). Returns `null` for null/empty inputs so the trigger's
 * COALESCE falls back to the raw column.
 */
export function computeBookFolds(input: {
  title?: string | null;
  author?: string | null;
  isbn?: string | null;
  publisher?: string | null;
  description?: string | null;
  tagsJson?: string | null;
  customFieldsJson?: string | null;
  // MARC 880-style parallel forms. Optional, so the eleven existing call sites
  // keep compiling and simply produce nulls for them.
  titleRomanized?: string | null;
  authorRomanized?: string | null;
  publisherRomanized?: string | null;
}): {
  title_fold: string | null;
  author_fold: string | null;
  isbn_fold: string | null;
  publisher_fold: string | null;
  description_fold: string | null;
  tags_fold: string | null;
  custom_fields_fold: string | null;
  title_romanized_fold: string | null;
  author_romanized_fold: string | null;
  publisher_romanized_fold: string | null;
} {
  const fold = (v: string | null | undefined): string | null => {
    if (v == null) return null;
    const s = String(v);
    if (!s) return null;
    return foldDiacritics(s);
  };
  return {
    title_fold: fold(input.title),
    author_fold: fold(input.author),
    isbn_fold: fold(input.isbn),
    publisher_fold: fold(input.publisher),
    description_fold: fold(input.description),
    tags_fold: fold(input.tagsJson),
    custom_fields_fold: fold(input.customFieldsJson),
    title_romanized_fold: fold(input.titleRomanized),
    author_romanized_fold: fold(input.authorRomanized),
    publisher_romanized_fold: fold(input.publisherRomanized)
  };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let curr = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, curr + 1, prev[j - 1] + cost);
      curr = temp;
    }
    prev[0] = i;
  }
  return prev[b.length];
}

function typoThreshold(term: string): number {
  if (term.length <= 4) return 1;
  if (term.length <= 9) return 2;
  return 3;
}

function fuzzyWordMatch(text: string, term: string): boolean {
  const words = splitWords(text);
  const folded = foldDiacritics(term);
  const threshold = typoThreshold(folded);
  for (const word of words) {
    if (Math.abs(word.length - folded.length) > threshold) continue;
    if (levenshtein(word, folded) <= threshold) return true;
  }
  return false;
}

function fieldText(row: Record<string, unknown>, field: string): string {
  // Lowercase + diacritic-fold so the post-filter accepts rows that the SQL
  // FTS gate matched via its `remove_diacritics 2` tokenizer.
  if (field === 'custom') return foldDiacritics(JSON.stringify(row.customFields ?? {}).toLowerCase());
  if (field === 'tags') return foldDiacritics((Array.isArray(row.tags) ? (row.tags as unknown[]).join(' ') : '').toLowerCase());
  return foldDiacritics(String(row[field] ?? '').toLowerCase());
}

function fuzzyRowMatches(
  row: Record<string, unknown>,
  tokens: string[],
  activeFields: string[],
  qMode: 'all' | 'any' | 'exact'
): boolean {
  if (tokens.length === 0) return true;
  const texts = activeFields.map((f) => fieldText(row, f)).filter(Boolean);
  if (texts.length === 0) return false;
  const matchTerm = (rawTerm: string): boolean => {
    const term = foldDiacritics(rawTerm);
    return texts.some((text) => text.includes(term)) || texts.some((text) => fuzzyWordMatch(text, rawTerm));
  };
  if (qMode === 'any') return tokens.some(matchTerm);
  return tokens.every(matchTerm);
}

export async function withTxn<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  await env.DB.exec('BEGIN');
  try {
    const result = await fn();
    await env.DB.exec('COMMIT');
    return result;
  } catch (error) {
    await env.DB.exec('ROLLBACK');
    throw error;
  }
}

/**
 * D1's only guaranteed-atomic primitive. All prepared statements in the array
 * succeed together or none do; D1 wraps them in a single SQLite transaction
 * server-side. Prefer this over `withTxn` for any multi-statement write — the
 * BEGIN/COMMIT pattern in `withTxn` is best-effort under the Workers binding
 * and may not actually roll back on failure.
 *
 * Returns the per-statement results in the same order.
 */
export async function runAtomic<T = unknown>(
  env: Env,
  statements: D1PreparedStatement[]
): Promise<D1Result<T>[]> {
  if (statements.length === 0) return [];
  return env.DB.batch<T>(statements);
}

export async function recordSyncMutation(
  env: Env,
  actor: AuthClaims,
  clientMutationId: string,
  operation: string,
  payload: Record<string, unknown>,
  resultStatus: 'success' | 'error',
  resultData: Record<string, unknown>
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sync_mutations
      (id, client_mutation_id, operation, payload, actor_id, processed_at, result_status, result_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      clientMutationId,
      operation,
      JSON.stringify(payload),
      actor.sub,
      nowIso(),
      resultStatus,
      JSON.stringify(resultData)
    )
    .run();
}

export async function validateCustomFields(
  env: Env,
  customFields: Record<string, unknown>,
  options?: CustomFieldValidationOptions
): Promise<Record<string, unknown>> {
  const defs = await loadCustomFieldDefs(env);
  if (defs.length === 0) {
    return customFields;
  }
  return validateCustomFieldsAgainst(defs, customFields, options);
}

export async function loadCustomFieldDefs(env: Env): Promise<CustomFieldDef[]> {
  // Same ORDER BY as GET /api/custom-fields. This list is not only used for
  // validation: it also decides the trailing column order of the CSV export and
  // the order of the autocomplete facet keys. Leaving it unordered meant the
  // backup file and the screens the librarian works in listed the same
  // attributes differently.
  const defsResult = await env.DB.prepare(
    `SELECT id, field_key, field_type, required, enum_options, label, pinned, sort_order
     FROM custom_field_definitions WHERE deleted_at IS NULL
     ORDER BY pinned DESC, sort_order ASC, label ASC, field_key ASC`
  ).all<CustomFieldDef>();
  return defsResult.results ?? [];
}

export function validateCustomFieldsAgainst(
  defs: CustomFieldDef[],
  customFields: Record<string, unknown>,
  options?: CustomFieldValidationOptions
): Record<string, unknown> {
  if (defs.length === 0) return customFields;

  const defMap = new Map(defs.map((d) => [d.field_key, d]));
  const normalized: Record<string, unknown> = {};
  const errors: string[] = [];
  const requireAllRequired = options?.requireAllRequired !== false;

  for (const def of defs) {
    const raw = customFields[def.field_key];
    const missing = raw === undefined || raw === null || raw === '';
    if (requireAllRequired && def.required === 1 && missing) {
      errors.push(`Required custom field missing: ${def.field_key}`);
      continue;
    }
    if (missing) continue;

    if (def.field_type === 'text') {
      if (typeof raw !== 'string') errors.push(`Custom field ${def.field_key} must be a text value`);
      else normalized[def.field_key] = raw;
      continue;
    }
    if (def.field_type === 'number') {
      if (typeof raw !== 'number') errors.push(`Custom field ${def.field_key} must be a number`);
      else normalized[def.field_key] = raw;
      continue;
    }
    if (def.field_type === 'boolean') {
      if (typeof raw !== 'boolean') errors.push(`Custom field ${def.field_key} must be a boolean`);
      else normalized[def.field_key] = raw;
      continue;
    }
    if (def.field_type === 'date') {
      if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
        errors.push(`Custom field ${def.field_key} must be an ISO date string`);
      } else {
        normalized[def.field_key] = new Date(raw).toISOString();
      }
      continue;
    }
    if (def.field_type === 'enum') {
      const opts = safeJsonParse<string[]>(def.enum_options ?? '[]', []);
      if (typeof raw !== 'string' || !opts.includes(raw)) {
        errors.push(`Custom field ${def.field_key} must be one of: ${opts.join(', ')}`);
      } else {
        normalized[def.field_key] = raw;
      }
    }
  }

  const rejectUnknownKeys = options?.rejectUnknownKeys !== false;
  for (const key of Object.keys(customFields)) {
    if (defMap.has(key)) continue;
    if (rejectUnknownKeys) {
      errors.push(`Unknown custom field key: ${key}`);
    }
    // If unknown keys are tolerated we silently drop them; legacy values for
    // since-deleted definitions stay in the source row's JSON until the next
    // overwrite, which is fine because the frontend only renders defined keys.
  }

  if (errors.length > 0) {
    throw new HTTPException(400, { message: errors.join('; ') });
  }

  return normalized;
}

export async function replaceBookAttributeValues(
  env: Env,
  bookId: string,
  attributeValues: Record<string, unknown>
): Promise<void> {
  const defsResult = await env.DB.prepare(
    `SELECT id, field_key FROM custom_field_definitions WHERE deleted_at IS NULL`
  ).all<{ id: string; field_key: string }>();

  const defs = defsResult.results ?? [];
  const keyToDef = new Map(defs.map((d) => [d.field_key, d.id]));

  const deleteStmt = env.DB.prepare('DELETE FROM book_attribute_values WHERE book_id = ?').bind(bookId);
  const inserts: D1PreparedStatement[] = [];
  const now = nowIso();
  for (const [key, value] of Object.entries(attributeValues)) {
    const definitionId = keyToDef.get(key);
    if (!definitionId) continue;
    // `INSERT OR REPLACE` on the (book_id, attribute_definition_id) UNIQUE
    // constraint makes follow-up batches re-runnable: a partial failure of
    // a later chunk can be retried without tripping the unique violation
    // that a plain INSERT would raise.
    inserts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO book_attribute_values
          (id, book_id, attribute_definition_id, value_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), bookId, definitionId, JSON.stringify(value), now, now)
    );
  }
  if (inserts.length === 0) {
    await deleteStmt.run();
    return;
  }
  // D1 caps batch() at 50 statements per call. The DELETE goes in the first
  // chunk so the replace is atomic with the first batch of inserts; if the
  // book has more than 49 attributes the remaining inserts ride in follow-up
  // batches — non-atomic, but safe because each insert is idempotent on
  // (book_id, attribute_definition_id) thanks to `INSERT OR REPLACE`.
  const BATCH_SIZE = 50;
  const firstChunkSize = Math.min(inserts.length, BATCH_SIZE - 1);
  await env.DB.batch([deleteStmt, ...inserts.slice(0, firstChunkSize)]);
  for (let i = firstChunkSize; i < inserts.length; i += BATCH_SIZE) {
    await env.DB.batch(inserts.slice(i, i + BATCH_SIZE));
  }
}

// ─── Semantic search (Vectorize + Workers AI) ────────────────────────────
// All of these helpers fail soft when either binding is missing — the rest
// of the app keeps working, the relevant feature just degrades. We never
// surface a 500 to the caller because of an optional binding.

// Default embedding model. Workers AI's `@cf/baai/bge-base-en-v1.5` is
// multilingual-friendly and gives 768-dim cosine vectors that match the
// Vectorize index config in wrangler.toml. Switch both at the same time.
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBEDDING_DIMS = 768;

// Compose the text we feed the embedding model. Mirror what users type
// when looking for books: title + author + a short description snippet,
// plus the top few tag/category fields. Limiting length keeps embedding
// cheap and avoids confusing the model with structural noise from
// custom_fields JSON blobs.
export function bookEmbeddingText(book: {
  title?: string | null;
  author?: string | null;
  description?: string | null;
  publisher?: string | null;
  language?: string | null;
  publicationYear?: number | null;
  tags?: string[] | null;
  customFields?: Record<string, unknown> | null;
}): string {
  const parts: string[] = [];
  // Skip the "no value" placeholders so embeddings don't carry a spurious
  // "(Untitled)" / "by (Unknown)" that pollutes semantic-search relevance.
  if (book.title && book.title !== '(Untitled)') parts.push(book.title);
  if (book.author && book.author !== '(Unknown)') parts.push(`by ${book.author}`);
  if (book.publisher) parts.push(book.publisher);
  if (book.publicationYear) parts.push(String(book.publicationYear));
  if (book.language) parts.push(`(${book.language})`);
  if (Array.isArray(book.tags) && book.tags.length > 0) parts.push(book.tags.slice(0, 8).join(', '));
  const cf = book.customFields ?? {};
  const cat = (cf as Record<string, unknown>).category_label
    ?? (cf as Record<string, unknown>).category;
  if (typeof cat === 'string' && cat) parts.push(cat);
  if (book.description) parts.push(book.description.slice(0, 1500));
  return parts.filter(Boolean).join(' — ');
}

// Stable short hash of the embedding source text so we can skip re-
// embedding when an UPDATE doesn't change anything the model cares about.
async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function semanticSearchEnabled(env: Env): boolean {
  return Boolean(env.VECTORIZE && env.AI);
}

async function embedSingle(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    // Workers AI returns `{ data: number[][] }` for the embedding models.
    const result = (await env.AI.run(EMBEDDING_MODEL, { text: [text] })) as { data?: number[][] };
    const vec = result.data?.[0];
    return vec && vec.length === EMBEDDING_DIMS ? vec : null;
  } catch (error) {
    console.warn('Embedding call failed', error);
    return null;
  }
}

// Re-embed (or initial-embed) a single book. Safe to call on every write —
// if AI/Vectorize is unbound we no-op, and the tracking-table row tells the
// future backfill what's still pending.
export async function vectorizeBook(env: Env, bookId: string, source: Parameters<typeof bookEmbeddingText>[0]): Promise<void> {
  if (!semanticSearchEnabled(env)) return;
  const text = bookEmbeddingText(source);
  if (!text.trim()) {
    // Empty text -> drop any prior embedding so search doesn't return a
    // book that the model would have nothing to say about.
    await unvectorizeBook(env, bookId);
    return;
  }
  const hash = await shortHash(text);

  // Skip work if the embedding is already current for this model + text.
  const prior = await env.DB.prepare(
    'SELECT model, source_hash FROM book_vectorized WHERE book_id = ? LIMIT 1'
  ).bind(bookId).first<{ model: string; source_hash: string }>();
  if (prior && prior.model === EMBEDDING_MODEL && prior.source_hash === hash) {
    return;
  }

  const vector = await embedSingle(env, text);
  if (!vector) return;

  try {
    await env.VECTORIZE!.upsert([
      {
        id: bookId,
        values: vector,
        // Metadata that the search endpoint reads back without a follow-up
        // DB hit. Keep this small — Vectorize charges per byte of metadata.
        metadata: {
          title: source.title ?? '',
          author: source.author ?? ''
        }
      }
    ]);
  } catch (error) {
    console.warn('Vectorize upsert failed', error);
    return;
  }

  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO book_vectorized (book_id, model, source_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET
       model = excluded.model,
       source_hash = excluded.source_hash,
       updated_at = excluded.updated_at`
  ).bind(bookId, EMBEDDING_MODEL, hash, now).run();
}

export async function unvectorizeBook(env: Env, bookId: string): Promise<void> {
  if (!semanticSearchEnabled(env)) return;
  try { await env.VECTORIZE!.deleteByIds([bookId]); } catch { /* ignore */ }
  try {
    await env.DB.prepare('DELETE FROM book_vectorized WHERE book_id = ?').bind(bookId).run();
  } catch { /* ignore */ }
}

// Embed a free-text query and return Vectorize's top-K matching book ids.
// Returns an empty array (not an error) when the binding is missing so the
// caller can transparently fall through to the FTS path.
export async function semanticSearchBookIds(
  env: Env,
  query: string,
  topK = 50
): Promise<Array<{ id: string; score: number }>> {
  if (!semanticSearchEnabled(env) || !query.trim()) return [];
  const vector = await embedSingle(env, query);
  if (!vector) return [];
  try {
    const hits = await env.VECTORIZE!.query(vector, { topK });
    const matches = hits.matches ?? [];
    return matches.map((m) => ({ id: m.id, score: m.score }));
  } catch (error) {
    console.warn('Vectorize query failed', error);
    return [];
  }
}

export async function getBookAttributeValues(env: Env, bookId: string): Promise<Record<string, unknown>> {
  const result = await env.DB.prepare(
    `SELECT cfd.field_key, bav.value_json
     FROM book_attribute_values bav
     JOIN custom_field_definitions cfd ON cfd.id = bav.attribute_definition_id
     WHERE bav.book_id = ? AND cfd.deleted_at IS NULL`
  )
    .bind(bookId)
    .all<{ field_key: string; value_json: string }>();

  const map: Record<string, unknown> = {};
  for (const row of result.results ?? []) {
    map[row.field_key] = safeJsonParse(row.value_json, null);
  }

  return map;
}
