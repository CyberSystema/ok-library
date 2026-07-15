import { HTTPException } from 'hono/http-exception';
import { defaultPbkdf2Iterations, generateSaltHex, hashPasswordPbkdf2 } from './auth';
import type { AuthClaims, Env } from './types';
import { nowIso, safeJsonParse } from './utils';

type CustomFieldDef = {
  id: string;
  field_key: string;
  field_type: 'text' | 'number' | 'boolean' | 'date' | 'enum';
  required: number;
  enum_options: string;
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
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), actorId, action, entityType, entityId, JSON.stringify(metadata), nowIso())
    .run();
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
  } catch {
    // Ignore cache invalidation errors — stale entries expire within seconds anyway.
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
  publication_year: 'publicationYear',
  shelf_code: 'shelfCode',
  room_code: 'roomCode',
  acquisition_date: 'acquisitionDate',
  legacy_id: 'legacyId',
  cover_url: 'coverUrl',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  deleted_at: 'deletedAt'
};

export function parseBook(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // Skip the snake_case copy if we know the camelCase key — keeps responses
    // small and prevents API consumers from depending on the legacy spelling.
    if (key in SNAKE_TO_CAMEL_BOOK_FIELDS) continue;
    out[key] = value;
  }
  out.customFields = safeJsonParse((row.custom_fields as string) ?? '{}', {});
  out.tags = Array.isArray(row.tags) ? row.tags : safeJsonParse((row.tags as string) ?? '[]', []);
  out.publicationYear = row.publication_year ?? null;
  out.shelfCode = row.shelf_code ?? null;
  out.roomCode = row.room_code ?? null;
  out.acquisitionDate = row.acquisition_date ?? null;
  out.legacyId = row.legacy_id ?? null;
  out.coverUrl = row.cover_url ?? null;
  out.createdAt = row.created_at ?? null;
  out.updatedAt = row.updated_at ?? null;
  out.deletedAt = row.deleted_at ?? null;
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
  const tokens = opts.qMode === 'exact' ? [opts.q] : parseSearchTokens(opts.q);
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
    unknownAuthor?: boolean;
    includeDeleted?: boolean;
    sortBy: string;
    sortDir: 'asc' | 'desc';
    page: number;
    pageSize: number;
    customFilters: Array<{ key: string; value: string }>;
  }
): Promise<{ total: number; rows: Array<Record<string, unknown>> }> {
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
  if (opts.year) {
    where.push('b.publication_year = ?');
    values.push(opts.year);
  }
  if (opts.yearMin !== undefined) {
    where.push('b.publication_year >= ?');
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
    where.push("(b.shelf_code IS NULL OR TRIM(b.shelf_code) = '')");
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
  if (opts.roomCode) {
    // Substring + case-insensitive so "06" matches "06-005", "06-105", etc.
    where.push('LOWER(b.room_code) LIKE LOWER(?)');
    values.push(`%${opts.roomCode}%`);
  }
  if (opts.shelfCode) {
    where.push('LOWER(b.shelf_code) LIKE LOWER(?)');
    values.push(`%${opts.shelfCode}%`);
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
  if (!fuzzyEnabled) {
    if (qText && opts.qMode !== 'exact') {
      const ftsQuery = buildFtsQuery({
        q: qText,
        qMode: opts.qMode ?? 'all',
        partialWords: opts.partialWords ?? true,
        fields: activeFields
      });
      if (ftsQuery) {
        useFtsJoin = true;
        where.push('books_fts MATCH ?');
        values.push(ftsQuery);
      }
    } else if (qText && opts.qMode === 'exact') {
      const ftsQuery = buildFtsQuery({
        q: qText,
        qMode: 'exact',
        partialWords: false,
        fields: activeFields
      });
      if (ftsQuery) {
        useFtsJoin = true;
        where.push('books_fts MATCH ?');
        values.push(ftsQuery);
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
      useFtsJoin
    });
  }

  const fromClause = useFtsJoin
    ? 'books b JOIN books_fts ON books_fts.rowid = b.ROWID'
    : 'books b';
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const countStmt = env.DB.prepare(`SELECT COUNT(*) as count FROM ${fromClause} ${whereSql}`).bind(...values);
  const rowsStmt = env.DB.prepare(
    `SELECT b.* FROM ${fromClause} ${whereSql}
     ORDER BY ${blankLastSort}b.${sortColumn} ${sortDir}, b.id DESC LIMIT ? OFFSET ?`
  ).bind(...values, limit, offset);

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
  }
): Promise<{ total: number; rows: Array<Record<string, unknown>> }> {
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

  const candidateStmt = env.DB.prepare(
    `SELECT b.* FROM ${fromClause} ${whereSql}
     ORDER BY b.${ctx.sortColumn} ${ctx.sortDir}, b.id DESC LIMIT ?`
  ).bind(...values, FUZZY_CANDIDATE_CAP);
  const res = await candidateStmt.all();
  const rows = ((res.results ?? []) as Array<Record<string, unknown>>).map(parseBook);

  const filtered = rows.filter((row) => fuzzyRowMatches(row, tokens, ctx.activeFields, ctx.qMode));

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
}): {
  title_fold: string | null;
  author_fold: string | null;
  isbn_fold: string | null;
  publisher_fold: string | null;
  description_fold: string | null;
  tags_fold: string | null;
  custom_fields_fold: string | null;
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
    custom_fields_fold: fold(input.customFieldsJson)
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
  const defsResult = await env.DB.prepare(
    `SELECT id, field_key, field_type, required, enum_options
     FROM custom_field_definitions WHERE deleted_at IS NULL`
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
