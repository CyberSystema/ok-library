import { HTTPException } from 'hono/http-exception';
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

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  const passwordHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const timestamp = nowIso();
  await env.DB.prepare(
    `INSERT INTO staff_users (id, username, role, password_hash, active, created_at, updated_at)
     VALUES (?, ?, 'admin', ?, 1, ?, ?)`
  )
    .bind(crypto.randomUUID(), username, passwordHash, timestamp, timestamp)
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
    publicationYear: row.publication_year
  };
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
    roomCode?: string;
    shelfCode?: string;
    sortBy: string;
    sortDir: 'asc' | 'desc';
    page: number;
    pageSize: number;
    customFilters: Array<{ key: string; value: string }>;
  }
): Promise<{ total: number; rows: Array<Record<string, unknown>> }> {
  const parseSearchTokens = (input: string): string[] => {
    const tokens: string[] = [];
    const regex = /"([^"]+)"|(\S+)/g;
    let match: RegExpExecArray | null = regex.exec(input);
    while (match) {
      const token = (match[1] ?? match[2] ?? '').trim().toLowerCase();
      if (token) {
        tokens.push(token);
      }
      match = regex.exec(input);
    }
    return tokens;
  };

  const safeLike = (raw: string): string => raw.replaceAll('%', '').replaceAll('_', '');
  const splitWords = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

  const levenshtein = (a: string, b: string): number => {
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
  };

  const typoThreshold = (term: string): number => {
    if (term.length <= 4) return 1;
    if (term.length <= 9) return 2;
    return 3;
  };

  const fuzzyWordMatch = (text: string, term: string): boolean => {
    const words = splitWords(text);
    const threshold = typoThreshold(term);
    for (const word of words) {
      if (Math.abs(word.length - term.length) > threshold) continue;
      if (levenshtein(word, term) <= threshold) return true;
    }
    return false;
  };

  const fieldExprMap: Record<string, string> = {
    title: 'COALESCE(title, \'\')',
    author: 'COALESCE(author, \'\')',
    isbn: 'COALESCE(isbn, \'\')',
    publisher: 'COALESCE(publisher, \'\')',
    language: 'COALESCE(language, \'\')',
    description: 'COALESCE(description, \'\')',
    roomCode: 'COALESCE(room_code, \'\')',
    shelfCode: 'COALESCE(shelf_code, \'\')',
    tags: 'COALESCE(tags, \'\')',
    custom: 'COALESCE(custom_fields, \'\')'
  };

  const requestedFields = (opts.searchFields ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  const activeFields = (requestedFields.length > 0 ? requestedFields : ['title', 'author', 'isbn'])
    .filter((f) => Object.prototype.hasOwnProperty.call(fieldExprMap, f));

  const where: string[] = ['deleted_at IS NULL'];
  const values: unknown[] = [];
  const qText = normalize(opts.q);
  const excludeText = normalize(opts.qExclude);
  const useFuzzy = Boolean(opts.fuzzyTypos) && qText.length > 0 && opts.qMode !== 'exact';

  if (opts.status) {
    where.push('status = ?');
    values.push(opts.status);
  }

  if (opts.roomCode) {
    where.push('room_code = ?');
    values.push(opts.roomCode);
  }

  if (opts.shelfCode) {
    where.push('shelf_code = ?');
    values.push(opts.shelfCode);
  }

  for (const filter of opts.customFilters) {
    where.push(`json_extract(custom_fields, '$.${filter.key}') = ?`);
    values.push(filter.value);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const allowedSortMap: Record<string, string> = {
    title: 'title',
    author: 'author',
    publicationYear: 'publication_year',
    status: 'status',
    updatedAt: 'updated_at'
  };

  const sortColumn = allowedSortMap[opts.sortBy] ?? 'updated_at';
  const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.max(1, Math.min(100, opts.pageSize));
  const offset = (Math.max(1, opts.page) - 1) * limit;

  if (useFuzzy) {
    const rowsStmt = env.DB.prepare(`SELECT * FROM books ${whereSql}`).bind(...values);
    const rowsRes = await rowsStmt.all();
    const allRows = ((rowsRes.results ?? []) as Array<Record<string, unknown>>).map(parseBook);

    const getFieldText = (row: Record<string, unknown>, field: string): string => {
      if (field === 'custom') {
        return normalize(JSON.stringify(row.customFields ?? {}));
      }
      if (field === 'tags') {
        const tags = Array.isArray(row.tags) ? row.tags : [];
        return normalize(tags.join(' '));
      }
      return normalize(row[field]);
    };

    const searchTerms = opts.qMode === 'exact' ? [qText] : parseSearchTokens(qText);
    const excludeTerms = parseSearchTokens(excludeText);

    const termMatch = (texts: string[], term: string): boolean => {
      const directMatch = texts.some((text) => {
        if (!term) return true;
        if (opts.partialWords === false) {
          return splitWords(text).includes(term);
        }
        return text.includes(term);
      });
      if (directMatch) return true;
      return texts.some((text) => fuzzyWordMatch(text, term));
    };

    const filtered = allRows.filter((row) => {
      const texts = activeFields.map((field) => getFieldText(row, field)).filter(Boolean);
      if (texts.length === 0) return false;

      let include = true;
      if (qText) {
        if (opts.qMode === 'exact') {
          include = texts.some((text) => text.includes(qText));
        } else if (opts.qMode === 'any') {
          include = searchTerms.some((term) => termMatch(texts, term));
        } else {
          include = searchTerms.every((term) => termMatch(texts, term));
        }
      }
      if (!include) return false;

      if (excludeTerms.length > 0) {
        const hasExcluded = excludeTerms.some((term) => texts.some((text) => text.includes(term)));
        if (hasExcluded) return false;
      }

      return true;
    });

    const compareValues = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
      const pick = (row: Record<string, unknown>): string | number => {
        if (opts.sortBy === 'publicationYear') return Number(row.publicationYear ?? 0);
        if (opts.sortBy === 'updatedAt') return normalize(row.updatedAt);
        if (opts.sortBy === 'status') return normalize(row.status);
        if (opts.sortBy === 'author') return normalize(row.author);
        return normalize(row.title);
      };
      const av = pick(a);
      const bv = pick(b);
      if (av < bv) return sortDir === 'ASC' ? -1 : 1;
      if (av > bv) return sortDir === 'ASC' ? 1 : -1;
      return 0;
    };

    filtered.sort(compareValues);
    const paged = filtered.slice(offset, offset + limit);

    return {
      total: filtered.length,
      rows: paged
    };
  }

  if (qText) {
    const terms = opts.qMode === 'exact' ? [qText] : parseSearchTokens(qText);
    const termClauses: string[] = [];

    for (const term of terms) {
      const likeValue = opts.partialWords === false ? safeLike(term) : `%${safeLike(term)}%`;
      const perFieldClause = activeFields.map((field) => `LOWER(${fieldExprMap[field]}) LIKE LOWER(?)`).join(' OR ');
      if (perFieldClause) {
        termClauses.push(`(${perFieldClause})`);
        for (let i = 0; i < activeFields.length; i += 1) {
          values.push(likeValue);
        }
      }
    }

    if (termClauses.length > 0) {
      where.push(`(${termClauses.join(opts.qMode === 'any' ? ' OR ' : ' AND ')})`);
    }
  }

  if (excludeText) {
    const excludes = parseSearchTokens(excludeText);
    for (const term of excludes) {
      const likeValue = `%${safeLike(term)}%`;
      const perFieldClause = activeFields.map((field) => `LOWER(${fieldExprMap[field]}) LIKE LOWER(?)`).join(' OR ');
      if (perFieldClause) {
        where.push(`NOT (${perFieldClause})`);
        for (let i = 0; i < activeFields.length; i += 1) {
          values.push(likeValue);
        }
      }
    }
  }

  const whereSqlWithSearch = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countStmt = env.DB.prepare(`SELECT COUNT(*) as count FROM books ${whereSqlWithSearch}`).bind(...values);
  const rowsStmt = env.DB.prepare(
    `SELECT * FROM books ${whereSqlWithSearch} ORDER BY ${sortColumn} ${sortDir}, id DESC LIMIT ? OFFSET ?`
  ).bind(...values, limit, offset);

  const [countRes, rowsRes] = await Promise.all([countStmt.first<{ count: number }>(), rowsStmt.all()]);
  const rows = ((rowsRes.results ?? []) as Array<Record<string, unknown>>).map(parseBook);

  return {
    total: Number(countRes?.count ?? 0),
    rows
  };
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
  const defsResult = await env.DB.prepare(
    `SELECT id, field_key, field_type, required, enum_options
     FROM custom_field_definitions WHERE deleted_at IS NULL`
  ).all<CustomFieldDef>();

  const defs = defsResult.results ?? [];
  if (defs.length === 0) {
    return customFields;
  }

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

    if (missing) {
      continue;
    }

    if (def.field_type === 'text') {
      if (typeof raw !== 'string') {
        errors.push(`Custom field ${def.field_key} must be a text value`);
      } else {
        normalized[def.field_key] = raw;
      }
      continue;
    }

    if (def.field_type === 'number') {
      if (typeof raw !== 'number') {
        errors.push(`Custom field ${def.field_key} must be a number`);
      } else {
        normalized[def.field_key] = raw;
      }
      continue;
    }

    if (def.field_type === 'boolean') {
      if (typeof raw !== 'boolean') {
        errors.push(`Custom field ${def.field_key} must be a boolean`);
      } else {
        normalized[def.field_key] = raw;
      }
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
      const options = safeJsonParse<string[]>(def.enum_options ?? '[]', []);
      if (typeof raw !== 'string' || !options.includes(raw)) {
        errors.push(`Custom field ${def.field_key} must be one of: ${options.join(', ')}`);
      } else {
        normalized[def.field_key] = raw;
      }
    }
  }

  for (const key of Object.keys(customFields)) {
    if (!defMap.has(key)) {
      errors.push(`Unknown custom field key: ${key}`);
    }
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

  await env.DB.prepare('DELETE FROM book_attribute_values WHERE book_id = ?').bind(bookId).run();

  for (const [key, value] of Object.entries(attributeValues)) {
    const definitionId = keyToDef.get(key);
    if (!definitionId) {
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO book_attribute_values
        (id, book_id, attribute_definition_id, value_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), bookId, definitionId, JSON.stringify(value), nowIso(), nowIso())
      .run();
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
