import { HTTPException } from 'hono/http-exception';
import type { AuthClaims, Env } from './types';
import { nowIso, safeJsonParse } from './utils';

type CustomFieldDef = {
  field_key: string;
  field_type: 'text' | 'number' | 'boolean' | 'date' | 'enum';
  required: number;
  enum_options: string;
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
  const where: string[] = ['deleted_at IS NULL'];
  const values: unknown[] = [];

  if (opts.q) {
    where.push('(title LIKE ? OR author LIKE ? OR isbn LIKE ?)');
    const qValue = `%${opts.q.replaceAll('%', '').replaceAll('_', '')}%`;
    values.push(qValue, qValue, qValue);
  }

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

  const countStmt = env.DB.prepare(`SELECT COUNT(*) as count FROM books ${whereSql}`).bind(...values);
  const rowsStmt = env.DB.prepare(
    `SELECT * FROM books ${whereSql} ORDER BY ${sortColumn} ${sortDir}, id DESC LIMIT ? OFFSET ?`
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
  customFields: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const defsResult = await env.DB.prepare(
    `SELECT field_key, field_type, required, enum_options
     FROM custom_field_definitions WHERE deleted_at IS NULL`
  ).all<CustomFieldDef>();

  const defs = defsResult.results ?? [];
  if (defs.length === 0) {
    return customFields;
  }

  const defMap = new Map(defs.map((d) => [d.field_key, d]));
  const normalized: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const def of defs) {
    const raw = customFields[def.field_key];
    const missing = raw === undefined || raw === null || raw === '';
    if (def.required === 1 && missing) {
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
