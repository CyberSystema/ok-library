import {
	BookFilterQuerySchema,
	BorrowBookSchema,
	CreateBookSchema,
	GenerateCodeSchema,
	ImportBooksSchema,
	ReturnBookSchema,
	SyncPushSchema,
	UpdateBookSchema,
	UpsertCustomFieldSchema,
	UpsertRoomSchema
} from '@ok-library/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { authMiddleware, createAccessToken, hashPassword, requireRole } from './auth';
import {
	ensureBootstrapAdmin,
	insertAuditLog,
	parseBook,
	queryBooksWithFilters,
	recordSyncMutation,
	validateCustomFields,
	withTxn
} from './db';
import type { AuthClaims, Env } from './types';
import { generateCodeValue, nowIso, toCsv } from './utils';

type App = Hono<{ Bindings: Env; Variables: { user: AuthClaims } }>;
type AppContext = Context<{ Bindings: Env; Variables: { user: AuthClaims } }>;

const app: App = new Hono();

function clientIp(c: AppContext): string {
	return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

async function enforceRateLimit(c: AppContext, bucket: string, perMinuteLimit: number): Promise<void> {
	if (!c.env.CACHE) {
		return;
	}

	try {
		const key = `rl:${bucket}:${clientIp(c)}:${Math.floor(Date.now() / 60000)}`;
		const countRaw = await c.env.CACHE.get(key);
		const count = Number(countRaw ?? '0');

		if (count >= perMinuteLimit) {
			throw new HTTPException(429, { message: 'Rate limit exceeded. Please retry shortly.' });
		}

		await c.env.CACHE.put(key, String(count + 1), { expirationTtl: 70 });
	} catch (error) {
		console.warn('Rate limiter unavailable, continuing without KV enforcement', error);
	}
}

app.use('*', async (c, next) => {
	const origin = c.env.CORS_ORIGIN ?? '*';
	return cors({ origin, allowHeaders: ['Authorization', 'Content-Type'] })(c, next);
});

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  const isAuthLogin = path === '/api/auth/login';
  await enforceRateLimit(c, isAuthLogin ? 'login' : 'api', isAuthLogin ? 20 : 180);
  await next();
});

app.use('*', async (c, next) => {
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('X-Frame-Options', 'DENY');
	c.header('Referrer-Policy', 'same-origin');
	c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
	c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
	await next();
});

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return c.json({ error: error.message }, error.status);
	}

	console.error('Unhandled error', error);
	return c.json({ error: 'Internal server error' }, 500);
});

app.get('/api/health', async (c) => {
	const dbCheck = await c.env.DB.prepare('SELECT 1 AS ok').first();
	return c.json({ ok: true, db: dbCheck?.ok === 1, timestamp: nowIso() });
});

app.post('/api/auth/login', async (c) => {
	await ensureBootstrapAdmin(c.env);

	const body = await c.req.json();
	const schema = z.object({ username: z.string().min(1), password: z.string().min(1) });
	const parsed = schema.parse(body);

	const user = await c.env.DB.prepare(
		`SELECT id, username, role, password_hash, active
		 FROM staff_users WHERE username = ? LIMIT 1`
	)
		.bind(parsed.username)
		.first<{
			id: string;
			username: string;
			role: 'admin' | 'librarian' | 'viewer';
			password_hash: string;
			active: number;
		}>();

	if (!user || user.active !== 1) {
		throw new HTTPException(401, { message: 'Invalid credentials' });
	}

	const candidate = await hashPassword(parsed.password);
	if (candidate !== user.password_hash) {
		throw new HTTPException(401, { message: 'Invalid credentials' });
	}

	const token = await createAccessToken(c.env, {
		sub: user.id,
		username: user.username,
		role: user.role
	});

	return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.use('/api/*', async (c, next) => {
	if (c.req.path === '/api/health' || c.req.path === '/api/auth/login') {
		await next();
		return;
	}
	await authMiddleware(c, next);
});

app.get('/api/books', async (c) => {
	const query = BookFilterQuerySchema.parse(c.req.query());
	const customFilters = Object.entries(c.req.query())
		.filter(([key]) => key.startsWith('custom_'))
		.map(([key, value]) => ({ key: key.replace('custom_', ''), value }));

	const cacheKey = `books:${JSON.stringify({ query, customFilters })}`;
	const cached = await c.env.CACHE.get(cacheKey, 'json');
	if (cached) {
		return c.json(cached);
	}

	const result = await queryBooksWithFilters(c.env, {
		...query,
		customFilters
	});

	const response = {
		page: query.page,
		pageSize: query.pageSize,
		total: result.total,
		items: result.rows
	};

	await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 });
	return c.json(response);
});

app.get('/api/books/:id', async (c) => {
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();

	if (!row) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	const codes = await c.env.DB.prepare('SELECT * FROM code_assignments WHERE book_id = ? AND active = 1').bind(id).all();

	return c.json({
		...parseBook(row as Record<string, unknown>),
		codes: codes.results
	});
});

app.post('/api/books', requireRole(['admin', 'librarian']), async (c) => {
	const payload = CreateBookSchema.parse(await c.req.json());
	const now = nowIso();
	const id = crypto.randomUUID();
	const customFields = await validateCustomFields(c.env, payload.customFields);

	await c.env.DB.prepare(
		`INSERT INTO books (
			id, title, author, isbn, publication_year, publisher, language, description,
			room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
			created_at, updated_at, deleted_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
	)
		.bind(
			id,
			payload.title,
			payload.author,
			payload.isbn ?? null,
			payload.publicationYear ?? null,
			payload.publisher ?? null,
			payload.language ?? null,
			payload.description ?? null,
			payload.roomCode ?? null,
			payload.shelfCode ?? null,
			payload.acquisitionDate ?? null,
			JSON.stringify(payload.tags),
			JSON.stringify(customFields),
			payload.status,
			now,
			now
		)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'book.create', 'book', id, {
		title: payload.title,
		author: payload.author
	});

	return c.json({ id }, 201);
});

app.put('/api/books/:id', requireRole(['admin', 'librarian']), async (c) => {
	const id = c.req.param('id');
	const payload = UpdateBookSchema.parse(await c.req.json());

	const existing = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!existing) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	const existingMap = existing as Record<string, unknown>;
	const currentVersion = Number(existingMap.version ?? 0);
	if (payload.version !== currentVersion) {
		throw new HTTPException(409, { message: 'Version conflict. Refresh and retry.' });
	}

	const now = nowIso();
	const customFields = await validateCustomFields(
		c.env,
		(payload.customFields ?? JSON.parse((existingMap.custom_fields as string) ?? '{}')) as Record<string, unknown>
	);
	const merged = {
		...parseBook(existingMap),
		...payload,
		tags: payload.tags ?? JSON.parse((existingMap.tags as string) ?? '[]'),
		customFields,
		version: currentVersion + 1,
		updatedAt: now
	};

	await c.env.DB.prepare(
		`UPDATE books SET
			title = ?, author = ?, isbn = ?, publication_year = ?, publisher = ?, language = ?, description = ?,
			room_code = ?, shelf_code = ?, acquisition_date = ?, tags = ?, custom_fields = ?, status = ?,
			version = ?, updated_at = ?
		 WHERE id = ? AND deleted_at IS NULL`
	)
		.bind(
			merged.title,
			merged.author,
			merged.isbn ?? null,
			merged.publicationYear ?? null,
			merged.publisher ?? null,
			merged.language ?? null,
			merged.description ?? null,
			merged.roomCode ?? null,
			merged.shelfCode ?? null,
			merged.acquisitionDate ?? null,
			JSON.stringify(merged.tags),
			JSON.stringify(merged.customFields),
			merged.status,
			merged.version,
			merged.updatedAt,
			id
		)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'book.update', 'book', id ?? null, {
		version: merged.version
	});

	return c.json({ id, version: merged.version });
});

app.delete('/api/books/:id', requireRole(['admin']), async (c) => {
	const id = c.req.param('id');
	const now = nowIso();
	const result = await c.env.DB.prepare(
		`UPDATE books SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL`
	)
		.bind(now, now, id)
		.run();

	if (!result.success) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	await insertAuditLog(c.env, c.get('user').sub, 'book.delete', 'book', id ?? null, {});
	return c.body(null, 204);
});

app.post('/api/books/:id/borrow', requireRole(['admin', 'librarian']), async (c) => {
	const bookId = c.req.param('id');
	const payload = BorrowBookSchema.parse(await c.req.json());

	const result = await withTxn(c.env, async () => {
		const book = await c.env.DB.prepare('SELECT status FROM books WHERE id = ? AND deleted_at IS NULL')
			.bind(bookId)
			.first<{ status: string }>();

		if (!book) {
			throw new HTTPException(404, { message: 'Book not found' });
		}

		if (book.status !== 'available') {
			throw new HTTPException(409, { message: 'Book is not available' });
		}

		const txId = crypto.randomUUID();
		const now = nowIso();

		await c.env.DB.prepare(
			`INSERT INTO borrow_transactions (
				id, book_id, borrower_name, borrower_contact, borrowed_at, due_at, returned_at, notes, created_by, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
		)
			.bind(
				txId,
				bookId,
				payload.borrowerName,
				payload.borrowerContact ?? null,
				now,
				payload.dueAt,
				payload.notes ?? null,
				c.get('user').sub,
				now
			)
			.run();

		await c.env.DB.prepare(`UPDATE books SET status = 'borrowed', version = version + 1, updated_at = ? WHERE id = ?`)
			.bind(now, bookId)
			.run();

		return { transactionId: txId };
	});

	await insertAuditLog(c.env, c.get('user').sub, 'book.borrow', 'book', bookId ?? null, {
		transactionId: result.transactionId,
		dueAt: payload.dueAt
	});

	return c.json(result, 201);
});

app.post('/api/books/:id/return', requireRole(['admin', 'librarian']), async (c) => {
	const bookId = c.req.param('id');
	const payload = ReturnBookSchema.parse(await c.req.json());

	const tx = await c.env.DB.prepare(
		`SELECT id FROM borrow_transactions WHERE book_id = ? AND returned_at IS NULL ORDER BY borrowed_at DESC LIMIT 1`
	)
		.bind(bookId)
		.first<{ id: string }>();

	if (!tx) {
		throw new HTTPException(409, { message: 'No active borrow transaction found' });
	}

	const now = nowIso();
	await withTxn(c.env, async () => {
		await c.env.DB.prepare(
			`UPDATE borrow_transactions SET returned_at = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`
		)
			.bind(now, payload.notes ?? null, now, tx.id)
			.run();

		await c.env.DB.prepare(`UPDATE books SET status = 'available', version = version + 1, updated_at = ? WHERE id = ?`)
			.bind(now, bookId)
			.run();
	});

	await insertAuditLog(c.env, c.get('user').sub, 'book.return', 'book', bookId ?? null, {
		transactionId: tx.id
	});

	return c.json({ transactionId: tx.id, returnedAt: now });
});

app.post('/api/books/:id/codes', requireRole(['admin', 'librarian']), async (c) => {
	const bookId = c.req.param('id');
	const payload = GenerateCodeSchema.parse(await c.req.json());

	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').bind(bookId).first();
	if (!book) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	const id = crypto.randomUUID();
	const now = nowIso();

	let value = '';
	let attempts = 0;
	while (attempts < 8) {
		attempts += 1;
		const candidate = generateCodeValue(payload.type);
		const existingCode = await c.env.DB.prepare('SELECT id FROM code_assignments WHERE code_value = ? LIMIT 1')
			.bind(candidate)
			.first();
		if (!existingCode) {
			value = candidate;
			break;
		}
	}

	if (!value) {
		throw new HTTPException(500, { message: 'Could not allocate a unique code. Please retry.' });
	}

	await c.env.DB.prepare(
		`INSERT INTO code_assignments (id, book_id, code_type, code_value, label, active, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
	)
		.bind(id, bookId, payload.type, value, payload.label ?? null, now, now)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'code.create', 'book', bookId ?? null, {
		codeType: payload.type,
		codeValue: value
	});

	return c.json({ id, value, type: payload.type }, 201);
});

app.get('/api/scan/:value', async (c) => {
	const codeValue = c.req.param('value');
	const row = await c.env.DB.prepare(
		`SELECT b.*, ca.code_type, ca.code_value
		 FROM code_assignments ca
		 JOIN books b ON b.id = ca.book_id
		 WHERE ca.code_value = ? AND ca.active = 1 AND b.deleted_at IS NULL
		 LIMIT 1`
	)
		.bind(codeValue)
		.first();

	if (!row) {
		throw new HTTPException(404, { message: 'No book found for this code' });
	}

	return c.json({ book: parseBook(row as Record<string, unknown>) });
});

app.get('/api/rooms', async (c) => {
	const rows = await c.env.DB.prepare('SELECT * FROM rooms ORDER BY code ASC').all();
	return c.json({ items: rows.results ?? [] });
});

app.post('/api/rooms', requireRole(['admin', 'librarian']), async (c) => {
	const payload = UpsertRoomSchema.parse(await c.req.json());
	const id = crypto.randomUUID();
	const now = nowIso();

	await c.env.DB.prepare(
		`INSERT INTO rooms (id, code, name, description, map_metadata, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(id, payload.code, payload.name, payload.description ?? null, JSON.stringify(payload.mapMetadata), now, now)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'room.create', 'room', id, {
		code: payload.code
	});

	return c.json({ id }, 201);
});

app.put('/api/rooms/:id', requireRole(['admin', 'librarian']), async (c) => {
	const id = c.req.param('id');
	const payload = UpsertRoomSchema.parse(await c.req.json());
	const now = nowIso();

	await c.env.DB.prepare(
		`UPDATE rooms SET code = ?, name = ?, description = ?, map_metadata = ?, updated_at = ? WHERE id = ?`
	)
		.bind(payload.code, payload.name, payload.description ?? null, JSON.stringify(payload.mapMetadata), now, id)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'room.update', 'room', id ?? null, {
		code: payload.code
	});

	return c.json({ id });
});

app.delete('/api/rooms/:id', requireRole(['admin']), async (c) => {
	const id = c.req.param('id');
	const result = await c.env.DB.prepare('DELETE FROM rooms WHERE id = ?').bind(id).run();
	if (!result.success) {
		throw new HTTPException(404, { message: 'Room not found' });
	}

	await insertAuditLog(c.env, c.get('user').sub, 'room.delete', 'room', id ?? null, {});
	return c.body(null, 204);
});

app.get('/api/custom-fields', async (c) => {
	const rows = await c.env.DB.prepare(
		`SELECT id, field_key, label, field_type, required, enum_options, created_at, updated_at
		 FROM custom_field_definitions WHERE deleted_at IS NULL ORDER BY field_key ASC`
	).all();

	const items = (rows.results ?? []).map((row) => ({
		id: (row as Record<string, unknown>).id,
		key: (row as Record<string, unknown>).field_key,
		label: (row as Record<string, unknown>).label,
		type: (row as Record<string, unknown>).field_type,
		required: (row as Record<string, unknown>).required === 1,
		enumOptions: JSON.parse(((row as Record<string, unknown>).enum_options as string) ?? '[]'),
		createdAt: (row as Record<string, unknown>).created_at,
		updatedAt: (row as Record<string, unknown>).updated_at
	}));

	return c.json({ items });
});

app.post('/api/custom-fields', requireRole(['admin']), async (c) => {
	const payload = UpsertCustomFieldSchema.parse(await c.req.json());
	const id = crypto.randomUUID();
	const now = nowIso();

	await c.env.DB.prepare(
		`INSERT INTO custom_field_definitions
			(id, field_key, label, field_type, required, enum_options, created_at, updated_at, deleted_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
	)
		.bind(id, payload.key, payload.label, payload.type, payload.required ? 1 : 0, JSON.stringify(payload.enumOptions), now, now)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'customField.create', 'custom_field', id, {
		key: payload.key
	});

	return c.json({ id }, 201);
});

app.put('/api/custom-fields/:id', requireRole(['admin']), async (c) => {
	const id = c.req.param('id');
	const payload = UpsertCustomFieldSchema.parse(await c.req.json());
	const now = nowIso();

	await c.env.DB.prepare(
		`UPDATE custom_field_definitions
			 SET field_key = ?, label = ?, field_type = ?, required = ?, enum_options = ?, updated_at = ?
		 WHERE id = ? AND deleted_at IS NULL`
	)
		.bind(payload.key, payload.label, payload.type, payload.required ? 1 : 0, JSON.stringify(payload.enumOptions), now, id)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'customField.update', 'custom_field', id ?? null, {
		key: payload.key
	});

	return c.json({ id });
});

app.delete('/api/custom-fields/:id', requireRole(['admin']), async (c) => {
	const id = c.req.param('id');
	const now = nowIso();
	await c.env.DB.prepare('UPDATE custom_field_definitions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
		.bind(now, now, id)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'customField.delete', 'custom_field', id ?? null, {});
	return c.body(null, 204);
});

app.post('/api/import/books', requireRole(['admin', 'librarian']), async (c) => {
	const payload = ImportBooksSchema.parse(await c.req.json());
	const now = nowIso();

	const errors: Array<{ index: number; message: string }> = [];
	for (let i = 0; i < payload.rows.length; i += 1) {
		if (!payload.rows[i].title || !payload.rows[i].author) {
			errors.push({ index: i, message: 'title and author are required' });
		}
	}

	if (errors.length > 0) {
		return c.json({ dryRun: payload.dryRun, errors }, 400);
	}

	if (payload.dryRun) {
		return c.json({ dryRun: true, acceptedRows: payload.rows.length });
	}

	await withTxn(c.env, async () => {
		for (const row of payload.rows) {
			const customFields = await validateCustomFields(c.env, row.customFields);
			await c.env.DB.prepare(
				`INSERT INTO books (
					id, title, author, isbn, publication_year, publisher, language, description,
					room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
					created_at, updated_at, deleted_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
			)
				.bind(
					crypto.randomUUID(),
					row.title,
					row.author,
					row.isbn ?? null,
					row.publicationYear ?? null,
					row.publisher ?? null,
					row.language ?? null,
					row.description ?? null,
					row.roomCode ?? null,
					row.shelfCode ?? null,
					row.acquisitionDate ?? null,
					JSON.stringify(row.tags),
					JSON.stringify(customFields),
					row.status,
					now,
					now
				)
				.run();
		}
	});

	await insertAuditLog(c.env, c.get('user').sub, 'book.import', 'book', null, {
		rows: payload.rows.length
	});

	return c.json({ importedRows: payload.rows.length }, 201);
});

app.get('/api/export/books.csv', async (c) => {
	const result = await queryBooksWithFilters(c.env, {
		q: c.req.query('q'),
		status: c.req.query('status'),
		roomCode: c.req.query('roomCode'),
		shelfCode: c.req.query('shelfCode'),
		sortBy: 'title',
		sortDir: 'asc',
		page: 1,
		pageSize: 2000,
		customFilters: []
	});

	const csv = toCsv(result.rows, [
		'id',
		'title',
		'author',
		'isbn',
		'publicationYear',
		'publisher',
		'language',
		'roomCode',
		'shelfCode',
		'status',
		'createdAt',
		'updatedAt'
	]);

	c.header('Content-Type', 'text/csv; charset=utf-8');
	c.header('Content-Disposition', 'attachment; filename="books.csv"');
	return c.body(csv);
});

app.get('/api/sync/pull', async (c) => {
	const since = c.req.query('since') ?? '1970-01-01T00:00:00.000Z';
	const rows = await c.env.DB.prepare(
		`SELECT * FROM books WHERE updated_at > ? AND deleted_at IS NULL ORDER BY updated_at ASC LIMIT 1000`
	)
		.bind(since)
		.all();

	const items = (rows.results ?? []).map((row) => parseBook(row as Record<string, unknown>));
	const nextCursor = items.length > 0 ? (items[items.length - 1].updatedAt as string) : since;

	return c.json({ since, nextCursor, items });
});

app.post('/api/sync/push', requireRole(['admin', 'librarian']), async (c) => {
	const payload = SyncPushSchema.parse(await c.req.json());
	const actor = c.get('user');

	const results: Array<Record<string, unknown>> = [];

	for (const mutation of payload.mutations) {
		let status: 'success' | 'error' = 'success';
		let resultData: Record<string, unknown> = {};

		try {
			if (mutation.operation === 'create_book') {
				const row = CreateBookSchema.parse(mutation.payload);
				const customFields = await validateCustomFields(c.env, row.customFields);
				const now = nowIso();
				const id = crypto.randomUUID();
				await c.env.DB.prepare(
					`INSERT INTO books (
						id, title, author, isbn, publication_year, publisher, language, description,
						room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
						created_at, updated_at, deleted_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
				)
					.bind(
						id,
						row.title,
						row.author,
						row.isbn ?? null,
						row.publicationYear ?? null,
						row.publisher ?? null,
						row.language ?? null,
						row.description ?? null,
						row.roomCode ?? null,
						row.shelfCode ?? null,
						row.acquisitionDate ?? null,
						JSON.stringify(row.tags),
						JSON.stringify(customFields),
						row.status,
						now,
						now
					)
					.run();
				resultData = { id };
			} else if (mutation.operation === 'delete_book') {
				const row = z.object({ id: z.string().min(1) }).parse(mutation.payload);
				const now = nowIso();
				await c.env.DB.prepare(`UPDATE books SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
					.bind(now, now, row.id)
					.run();
				resultData = { id: row.id };
			} else if (mutation.operation === 'update_book') {
				const row = z.object({ id: z.string().min(1), data: UpdateBookSchema }).parse(mutation.payload);
				const current = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').bind(row.id).first();
				if (!current) {
					throw new HTTPException(404, { message: 'Book not found' });
				}

				const incoming = UpdateBookSchema.parse(row.data);
				const currentVersion = Number((current as Record<string, unknown>).version ?? 0);
				if (incoming.version !== currentVersion) {
					throw new HTTPException(409, { message: 'Version conflict' });
				}

				const merged = {
					...parseBook(current as Record<string, unknown>),
					...incoming,
					customFields: await validateCustomFields(
						c.env,
						(incoming.customFields ??
							JSON.parse(((current as Record<string, unknown>).custom_fields as string) ?? '{}')) as Record<string, unknown>
					),
					version: currentVersion + 1,
					updatedAt: nowIso()
				};

				await c.env.DB.prepare(
					`UPDATE books SET
						 title = ?, author = ?, isbn = ?, publication_year = ?, publisher = ?, language = ?, description = ?,
						 room_code = ?, shelf_code = ?, acquisition_date = ?, tags = ?, custom_fields = ?, status = ?,
						 version = ?, updated_at = ?
					 WHERE id = ? AND deleted_at IS NULL`
				)
					.bind(
						merged.title,
						merged.author,
						merged.isbn ?? null,
						merged.publicationYear ?? null,
						merged.publisher ?? null,
						merged.language ?? null,
						merged.description ?? null,
						merged.roomCode ?? null,
						merged.shelfCode ?? null,
						merged.acquisitionDate ?? null,
						JSON.stringify(merged.tags),
						JSON.stringify(merged.customFields),
						merged.status,
						merged.version,
						merged.updatedAt,
						row.id
					)
					.run();
				resultData = { id: row.id, version: merged.version };
			} else if (mutation.operation === 'borrow_book') {
				const row = z.object({ id: z.string().min(1), data: BorrowBookSchema }).parse(mutation.payload);
				const txId = crypto.randomUUID();
				const now = nowIso();
				await c.env.DB.prepare(
					`INSERT INTO borrow_transactions (
						 id, book_id, borrower_name, borrower_contact, borrowed_at, due_at, returned_at, notes, created_by, updated_at
					 ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
				)
					.bind(
						txId,
						row.id,
						row.data.borrowerName,
						row.data.borrowerContact ?? null,
						now,
						row.data.dueAt,
						row.data.notes ?? null,
						actor.sub,
						now
					)
					.run();

				await c.env.DB.prepare(`UPDATE books SET status = 'borrowed', version = version + 1, updated_at = ? WHERE id = ?`)
					.bind(now, row.id)
					.run();

				resultData = { transactionId: txId };
			} else if (mutation.operation === 'return_book') {
				const row = z.object({ id: z.string().min(1), data: ReturnBookSchema }).parse(mutation.payload);
				const tx = await c.env.DB.prepare(
					`SELECT id FROM borrow_transactions WHERE book_id = ? AND returned_at IS NULL ORDER BY borrowed_at DESC LIMIT 1`
				)
					.bind(row.id)
					.first<{ id: string }>();

				if (!tx) {
					throw new HTTPException(409, { message: 'No active borrow transaction found' });
				}

				const now = nowIso();
				await c.env.DB.prepare(`UPDATE borrow_transactions SET returned_at = ?, updated_at = ? WHERE id = ?`)
					.bind(now, now, tx.id)
					.run();
				await c.env.DB.prepare(`UPDATE books SET status = 'available', version = version + 1, updated_at = ? WHERE id = ?`)
					.bind(now, row.id)
					.run();

				resultData = { transactionId: tx.id };
			}
		} catch (error) {
			status = 'error';
			resultData = {
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}

		await recordSyncMutation(
			c.env,
			actor,
			mutation.clientMutationId,
			mutation.operation,
			mutation.payload,
			status,
			resultData
		);

		results.push({
			clientMutationId: mutation.clientMutationId,
			operation: mutation.operation,
			status,
			result: resultData
		});
	}

	await insertAuditLog(c.env, actor.sub, 'sync.push', 'sync', null, {
		mutations: payload.mutations.length
	});

	return c.json({ results });
});

app.get('/api/audit-logs', requireRole(['admin']), async (c) => {
	const page = Math.max(1, Number(c.req.query('page') ?? 1));
	const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 25)));
	const offset = (page - 1) * pageSize;

	const rows = await c.env.DB.prepare(
		`SELECT id, actor_id, action, entity_type, entity_id, metadata, created_at
		 FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`
	)
		.bind(pageSize, offset)
		.all();

	return c.json({
		page,
		pageSize,
		items: (rows.results ?? []).map((row) => ({
			...(row as Record<string, unknown>),
			metadata: JSON.parse(((row as Record<string, unknown>).metadata as string) ?? '{}')
		}))
	});
});

export default app;
