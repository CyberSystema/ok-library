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
    const current = Number((await env.CACHE.get(BOOKS_CACHE_VERSION_KEY)) ?? '0');
    await env.CACHE.put(BOOKS_CACHE_VERSION_KEY, String(current + 1), { expirationTtl: 86400 });
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

export function parseBook(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    customFields: safeJsonParse(row.custom_fields as string, {}),
    tags: safeJsonParse(row.tags as string, []),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publicationYear: row.publication_year,
    legacyId: row.legacy_id ?? null,
    coverUrl: row.cover_url ?? null
  };
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
    const token = (match[1] ?? match[2] ?? '').trim().toLowerCase();
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
  const limit = Math.max(1, Math.min(100, opts.pageSize));
  const offset = (Math.max(1, opts.page) - 1) * limit;

  const where: string[] = ['b.deleted_at IS NULL'];
  const values: unknown[] = [];
  let useFtsJoin = false;

  if (opts.status) {
    where.push('b.status = ?');
    values.push(opts.status);
  }
  if (opts.language) {
    where.push('LOWER(b.language) = LOWER(?)');
    values.push(opts.language);
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
    where.push("b.title = '(Untitled)'");
  }
  if (opts.unknownAuthor) {
    where.push("b.author = '(Unknown)'");
  }
  if (opts.roomCode) {
    where.push('b.room_code = ?');
    values.push(opts.roomCode);
  }
  if (opts.shelfCode) {
    where.push('b.shelf_code = ?');
    values.push(opts.shelfCode);
  }
  for (const filter of opts.customFilters) {
    // json_extract validates the path; key is constrained to [a-zA-Z0-9_] in custom_field schema.
    if (!/^[a-zA-Z0-9_]+$/.test(filter.key)) continue;
    where.push(`json_extract(b.custom_fields, '$.${filter.key}') = ?`);
    values.push(filter.value);
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
     ORDER BY b.${sortColumn} ${sortDir}, b.id DESC LIMIT ? OFFSET ?`
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
  // Higher cap is safe because fuzzy mode no longer rides on top of an FTS
  // MATCH constraint — the candidates here are the structurally-filtered set
  // (status, language, year, …) and we Levenshtein-filter them in the Worker.
  const FUZZY_CANDIDATE_CAP = 5000;
  const fromClause = ctx.useFtsJoin
    ? 'books b JOIN books_fts ON books_fts.rowid = b.ROWID'
    : 'books b';
  const whereSql = `WHERE ${ctx.where.join(' AND ')}`;

  const candidateStmt = env.DB.prepare(
    `SELECT b.* FROM ${fromClause} ${whereSql}
     ORDER BY b.${ctx.sortColumn} ${ctx.sortDir}, b.id DESC LIMIT ?`
  ).bind(...ctx.values, FUZZY_CANDIDATE_CAP);
  const res = await candidateStmt.all();
  const rows = ((res.results ?? []) as Array<Record<string, unknown>>).map(parseBook);

  const tokens = parseSearchTokens(ctx.qText.toLowerCase());
  const filtered = rows.filter((row) => fuzzyRowMatches(row, tokens, ctx.activeFields, ctx.qMode));

  const paged = filtered.slice(ctx.offset, ctx.offset + ctx.limit);
  return { total: filtered.length, rows: paged };
}

function splitWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
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
  const threshold = typoThreshold(term);
  for (const word of words) {
    if (Math.abs(word.length - term.length) > threshold) continue;
    if (levenshtein(word, term) <= threshold) return true;
  }
  return false;
}

function fieldText(row: Record<string, unknown>, field: string): string {
  if (field === 'custom') return JSON.stringify(row.customFields ?? {}).toLowerCase();
  if (field === 'tags') return (Array.isArray(row.tags) ? (row.tags as unknown[]).join(' ') : '').toLowerCase();
  return String(row[field] ?? '').toLowerCase();
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
  const matchTerm = (term: string): boolean =>
    texts.some((text) => text.includes(term)) || texts.some((text) => fuzzyWordMatch(text, term));
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

  for (const key of Object.keys(customFields)) {
    if (!defMap.has(key)) errors.push(`Unknown custom field key: ${key}`);
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

  const ops: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM book_attribute_values WHERE book_id = ?').bind(bookId)
  ];
  const now = nowIso();
  for (const [key, value] of Object.entries(attributeValues)) {
    const definitionId = keyToDef.get(key);
    if (!definitionId) continue;
    ops.push(
      env.DB.prepare(
        `INSERT INTO book_attribute_values
          (id, book_id, attribute_definition_id, value_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), bookId, definitionId, JSON.stringify(value), now, now)
    );
  }
  if (ops.length > 1) {
    await env.DB.batch(ops);
  } else {
    await ops[0].run();
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
