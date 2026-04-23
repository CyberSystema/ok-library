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
	getBookAttributeValues,
	insertAuditLog,
	parseBook,
	queryBooksWithFilters,
	replaceBookAttributeValues,
	recordSyncMutation,
	validateCustomFields,
	withTxn
} from './db';
import type { AuthClaims, Env } from './types';
import { generateCodeValue, nowIso, safeJsonParse, toCsv } from './utils';

type App = Hono<{ Bindings: Env; Variables: { user: AuthClaims } }>;
type AppContext = Context<{ Bindings: Env; Variables: { user: AuthClaims } }>;
type DefaultBookStructureColumn = {
	label: string;
	coreKey?: string;
	customKey?: string;
	customType?: 'text' | 'number' | 'boolean' | 'date' | 'enum';
};

type ExistingCustomFieldRef = {
	field_key: string;
	label: string;
};

const app: App = new Hono();

const DEFAULT_BOOK_STRUCTURE: DefaultBookStructureColumn[] = [
	{ label: 'ID', coreKey: 'id' },
	{ label: 'Title', coreKey: 'title' },
	{ label: 'Item', customKey: 'item', customType: 'text' },
	{ label: 'Sub Title', customKey: 'subTitle', customType: 'text' },
	{ label: 'Writer', coreKey: 'author' },
	{ label: 'Editor', customKey: 'editor', customType: 'text' },
	{ label: 'Publisher', coreKey: 'publisher' },
	{ label: 'Place of Publication', customKey: 'placeOfPublication', customType: 'text' },
	{ label: 'Published Date', customKey: 'publishedDate', customType: 'date' },
	{ label: 'Edition #', customKey: 'editionNumber', customType: 'text' },
	{ label: 'Category', customKey: 'category', customType: 'text' },
	{ label: 'Language', coreKey: 'language' },
	{ label: 'Translator', customKey: 'translator', customType: 'text' },
	{ label: 'Cover Type', customKey: 'coverType', customType: 'text' },
	{ label: 'Pages', customKey: 'pages', customType: 'number' },
	{ label: 'Condition', customKey: 'condition', customType: 'text' },
	{ label: 'Shelf Location', coreKey: 'shelfCode' },
	{ label: 'Description', coreKey: 'description' },
	{ label: 'ISBN', coreKey: 'isbn' },
	{ label: 'Num. Volume', customKey: 'numVolume', customType: 'number' },
	{ label: 'Color', customKey: 'color', customType: 'text' },
	{ label: 'Signature', customKey: 'signature', customType: 'text' },
	{ label: 'More copies', customKey: 'moreCopies', customType: 'number' }
];

function normalizeColumnName(input: string): string {
	if (!input || typeof input !== 'string') return '';
	return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalColumnName(input: string): string {
	if (!input || typeof input !== 'string') return '';
	const normalized = normalizeColumnName(input);

	if (normalized.includes('subtitle')) return 'subtitle';
	if (normalized.includes('edition')) return 'edition';
	if (normalized.includes('placeofpublication') || (normalized.includes('publication') && normalized.includes('place'))) {
		return 'placeofpublication';
	}
	if (normalized.includes('covertype') || normalized === 'cover') return 'covertype';
	if (normalized.includes('numvolume') || normalized.includes('volume')) return 'numvolume';
	if (normalized.includes('morecopies') || normalized.includes('copycount') || normalized === 'copies' || normalized === 'copy') {
		return 'morecopies';
	}

	return normalized;
}

function columnsAreSimilar(a: string, b: string): boolean {
	return canonicalColumnName(a) === canonicalColumnName(b);
}

function findSimilarCustomField(
	existingFields: ExistingCustomFieldRef[] | null | undefined,
	column: DefaultBookStructureColumn | null | undefined
): ExistingCustomFieldRef | null {
	if (!existingFields || !column) return null;
	const candidates = [column.customKey ?? '', column.label].filter(Boolean);
	for (const field of existingFields) {
		if (!field || !field.field_key || !field.label) continue;
		for (const candidate of candidates) {
			if (!candidate) continue;
			if (columnsAreSimilar(candidate, field.field_key) || columnsAreSimilar(candidate, field.label)) {
				return field;
			}
		}
	}

	return null;
}

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
	return cors({ origin, allowHeaders: ['Authorization', 'Content-Type'], credentials: true })(c, next);
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

	const requestId = crypto.randomUUID();
	console.error('Unhandled error', {
		requestId,
		method: c.req.method,
		path: c.req.path,
		error
	});
	return c.json({ error: 'Internal server error', requestId }, 500);
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

	c.header(
		'Set-Cookie',
		`ok_library_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`
	);

	return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', async (c) => {
	c.header('Set-Cookie', 'ok_library_session=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0');
	return c.json({ ok: true });
});

app.use('/api/*', async (c, next) => {
	if (c.req.path === '/api/health' || c.req.path === '/api/auth/login' || c.req.path === '/api/auth/logout') {
		await next();
		return;
	}
	await authMiddleware(c, next);
});

app.get('/api/auth/session', async (c) => {
	const user = c.get('user');
	return c.json({ user: { id: user.sub, username: user.username, role: user.role } });
});

app.get('/api/books', async (c) => {
	const query = BookFilterQuerySchema.parse(c.req.query());
	const customFilters = Object.entries(c.req.query())
		.filter(([key]) => key.startsWith('custom_'))
		.map(([key, value]) => ({ key: key.replace('custom_', ''), value }));

	const cacheKey = `books:${JSON.stringify({ query, customFilters })}`;
	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) {
				return c.json(cached);
			}
		} catch (error) {
			console.warn('Book list cache read failed, falling back to DB query', error);
		}
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

	if (c.env.CACHE) {
		try {
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 });
		} catch (error) {
			console.warn('Book list cache write failed, continuing without cache', error);
		}
	}
	return c.json(response);
});

app.get('/api/books/:id', async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}
	const row = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();

	if (!row) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	const codes = await c.env.DB.prepare('SELECT * FROM code_assignments WHERE book_id = ? AND active = 1').bind(id).all();
	const attributes = await getBookAttributeValues(c.env, id);

	return c.json({
		...parseBook(row as Record<string, unknown>),
		attributeValues: attributes,
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

	await replaceBookAttributeValues(c.env, id, customFields);

	await insertAuditLog(c.env, c.get('user').sub, 'book.create', 'book', id, {
		title: payload.title,
		author: payload.author
	});

	return c.json({ id }, 201);
});

app.put('/api/books/:id', requireRole(['admin', 'librarian']), async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}
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

	await replaceBookAttributeValues(c.env, id, merged.customFields as Record<string, unknown>);

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

app.get('/api/books/:id/history', async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}

	const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') ?? 20)));
	const now = nowIso();

	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!book) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	const rows = await c.env.DB.prepare(
		`SELECT
			id,
			book_id,
			borrower_name,
			borrower_contact,
			borrowed_at,
			due_at,
			returned_at,
			notes,
			CASE WHEN returned_at IS NULL AND due_at < ? THEN 1 ELSE 0 END AS was_overdue,
			created_by,
			updated_at
		 FROM borrow_transactions
		 WHERE book_id = ?
		 ORDER BY borrowed_at DESC
		 LIMIT ?`
	)
		.bind(now, id, limit)
		.all();

	return c.json({
		bookId: id,
		items: (rows.results ?? []).map((row) => ({
			id: (row as Record<string, unknown>).id,
			bookId: (row as Record<string, unknown>).book_id,
			borrowerName: (row as Record<string, unknown>).borrower_name,
			borrowerContact: (row as Record<string, unknown>).borrower_contact,
			borrowedAt: (row as Record<string, unknown>).borrowed_at,
			dueAt: (row as Record<string, unknown>).due_at,
			returnedAt: (row as Record<string, unknown>).returned_at,
			notes: (row as Record<string, unknown>).notes,
			wasOverdue: (row as Record<string, unknown>).was_overdue === 1,
			createdBy: (row as Record<string, unknown>).created_by,
			updatedAt: (row as Record<string, unknown>).updated_at
		}))
	});
});

app.get('/api/books/:id/attributes', async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}
	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!book) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	const values = await getBookAttributeValues(c.env, id);
	return c.json({ bookId: id, values });
});

app.put('/api/books/:id/attributes', requireRole(['admin', 'librarian']), async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}
	const schema = z.object({ values: z.record(z.string(), z.unknown()) });
	const payload = schema.parse(await c.req.json());

	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!book) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	const normalized = await validateCustomFields(c.env, payload.values, { requireAllRequired: false });
	await replaceBookAttributeValues(c.env, id, normalized);

	await c.env.DB.prepare('UPDATE books SET custom_fields = ?, updated_at = ?, version = version + 1 WHERE id = ?')
		.bind(JSON.stringify(normalized), nowIso(), id)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'book.attributes.update', 'book', id ?? null, {
		attributeCount: Object.keys(normalized).length
	});

	return c.json({ bookId: id, values: normalized });
});

app.get('/api/borrow/active', async (c) => {
	try {
		const overdueOnly = c.req.query('overdueOnly') === 'true';
		const now = nowIso();

		const rows = await c.env.DB.prepare(
			`SELECT
				bt.id,
				bt.book_id,
				b.title,
				b.author,
				bt.borrower_name,
				bt.borrower_contact,
				bt.borrowed_at,
				bt.due_at,
				CASE WHEN bt.due_at < ? THEN 1 ELSE 0 END AS is_overdue
			 FROM borrow_transactions bt
			 JOIN books b ON b.id = bt.book_id
			 WHERE bt.returned_at IS NULL
				AND b.deleted_at IS NULL
				AND (? = 0 OR bt.due_at < ?)
			 ORDER BY is_overdue DESC, bt.due_at ASC
			 LIMIT 500`
		)
			.bind(now, overdueOnly ? 1 : 0, now)
			.all();

		const items = (rows.results ?? []).map((row) => {
			const r = row as Record<string, unknown>;
			return {
				id: r.id ?? '',
				bookId: r.book_id ?? '',
				title: r.title ?? '',
				author: r.author ?? '',
				borrowerName: r.borrower_name ?? '',
				borrowerContact: r.borrower_contact ?? null,
				borrowedAt: r.borrowed_at ?? '',
				dueAt: r.due_at ?? '',
				isOverdue: r.is_overdue === 1
			};
		});

		return c.json({
			total: items.length,
			overdueCount: items.filter((item) => item.isOverdue).length,
			items
		});
	} catch (error) {
		console.error('Error in /api/borrow/active:', error);
		throw error;
	}
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

app.get('/api/setup/default-book-structure', async (c) => {
	const customFields = await c.env.DB.prepare(
		`SELECT field_key, label FROM custom_field_definitions WHERE deleted_at IS NULL`
	).all<ExistingCustomFieldRef>();

	const existingCustomFields = customFields.results ?? [];
	const columns = DEFAULT_BOOK_STRUCTURE.map((column) => {
		try {
			return {
				label: column?.label ?? '',
				key: column?.coreKey ?? column?.customKey ?? '',
				type: column?.coreKey ? 'core' : 'custom',
				ready: column?.coreKey ? true : Boolean(findSimilarCustomField(existingCustomFields, column))
			};
		} catch (e) {
			console.error('Error mapping column:', column, e);
			return {
				label: column?.label ?? '',
				key: column?.coreKey ?? column?.customKey ?? '',
				type: 'custom',
				ready: false
			};
		}
	});

	return c.json({ columns });
});

app.post('/api/setup/default-book-structure', requireRole(['admin']), async (c) => {
	const now = nowIso();
	const customColumns = DEFAULT_BOOK_STRUCTURE.filter((column) => column.customKey && column.customType);
	const existingCustomFieldsResult = await c.env.DB.prepare(
		`SELECT field_key, label FROM custom_field_definitions WHERE deleted_at IS NULL`
	).all<ExistingCustomFieldRef>();
	const existingCustomFields = [...(existingCustomFieldsResult.results ?? [])];

	let configuredCustomColumns = 0;
	const skippedAsSimilar: string[] = [];

	for (const column of customColumns) {
		const similar = findSimilarCustomField(existingCustomFields, column);
		if (similar) {
			skippedAsSimilar.push(column.label);
			continue;
		}

		await c.env.DB.prepare(
			`INSERT INTO custom_field_definitions
				(id, field_key, label, field_type, required, enum_options, created_at, updated_at, deleted_at)
			 VALUES (?, ?, ?, ?, 0, '[]', ?, ?, NULL)
			 ON CONFLICT(field_key) DO UPDATE SET
				label = excluded.label,
				field_type = excluded.field_type,
				required = 0,
				enum_options = '[]',
				updated_at = excluded.updated_at,
				deleted_at = NULL`
		)
			.bind(
				crypto.randomUUID(),
				column.customKey,
				column.label,
				column.customType,
				now,
				now
			)
			.run();

		existingCustomFields.push({ field_key: column.customKey ?? '', label: column.label });
		configuredCustomColumns += 1;
	}

	await insertAuditLog(c.env, c.get('user').sub, 'setup.defaultBookStructure', 'custom_field', null, {
		count: configuredCustomColumns,
		skippedAsSimilar
	});

	return c.json({ ok: true, configuredCustomColumns, skippedAsSimilar });
});

app.get('/api/rooms/summary', async (c) => {
	try {
		const rows = await c.env.DB.prepare(
			`SELECT
				r.id,
				r.code,
				r.name,
				r.description,
				COUNT(b.id) AS total_books,
				SUM(CASE WHEN b.status = 'available' THEN 1 ELSE 0 END) AS available_books,
				SUM(CASE WHEN b.status = 'borrowed' THEN 1 ELSE 0 END) AS borrowed_books,
				SUM(CASE WHEN b.status = 'lost' THEN 1 ELSE 0 END) AS lost_books,
				SUM(CASE WHEN b.status = 'maintenance' THEN 1 ELSE 0 END) AS maintenance_books
			 FROM rooms r
			 LEFT JOIN books b ON b.room_code = r.code AND b.deleted_at IS NULL
			 GROUP BY r.id, r.code, r.name, r.description
			 ORDER BY r.code ASC`
		).all();

		const unassigned = await c.env.DB.prepare(
			`SELECT
				COUNT(*) AS total_books,
				SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_books,
				SUM(CASE WHEN status = 'borrowed' THEN 1 ELSE 0 END) AS borrowed_books,
				SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS lost_books,
				SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) AS maintenance_books
			 FROM books
			 WHERE deleted_at IS NULL AND (room_code IS NULL OR TRIM(room_code) = '')`
		).first<Record<string, unknown>>();

		const ua = unassigned ?? {};
		return c.json({
			items: rows.results ?? [],
			unassigned: {
				totalBooks: Number(ua.total_books ?? 0),
				availableBooks: Number(ua.available_books ?? 0),
				borrowedBooks: Number(ua.borrowed_books ?? 0),
				lostBooks: Number(ua.lost_books ?? 0),
				maintenanceBooks: Number(ua.maintenance_books ?? 0)
			}
		});
	} catch (error) {
		console.error('Error in /api/rooms/summary:', error);
		throw error;
	}
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
	try {
		const rows = await c.env.DB.prepare(
			`SELECT id, field_key, label, field_type, required, enum_options, created_at, updated_at
			 FROM custom_field_definitions WHERE deleted_at IS NULL ORDER BY field_key ASC`
		).all();

		const items = (rows.results ?? []).map((row) => {
			try {
				const r = row as Record<string, unknown>;
				return {
					id: r.id ?? '',
					key: r.field_key ?? '',
					label: r.label ?? '',
					type: r.field_type ?? 'text',
					required: r.required === 1,
					enumOptions: JSON.parse((r.enum_options as string) ?? '[]'),
					createdAt: r.created_at ?? '',
					updatedAt: r.updated_at ?? ''
				};
			} catch (parseError) {
				console.error('Error parsing custom field row:', row, parseError);
				return {
					id: (row as Record<string, unknown>).id ?? '',
					key: (row as Record<string, unknown>).field_key ?? '',
					label: (row as Record<string, unknown>).label ?? '',
					type: (row as Record<string, unknown>).field_type ?? 'text',
					required: false,
					enumOptions: [],
					createdAt: (row as Record<string, unknown>).created_at ?? '',
					updatedAt: (row as Record<string, unknown>).updated_at ?? ''
				};
			}
		});

		return c.json({ items });
	} catch (error) {
		console.error('Error in /api/custom-fields:', error);
		throw error;
	}
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
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing custom field id' });
	}

	const payload = UpsertCustomFieldSchema.parse(await c.req.json());
	const now = nowIso();

	const existing = await c.env.DB.prepare(
		'SELECT id, field_key FROM custom_field_definitions WHERE id = ? AND deleted_at IS NULL LIMIT 1'
	)
		.bind(id)
		.first<{ id: string; field_key: string }>();

	if (!existing) {
		throw new HTTPException(404, { message: 'Custom field not found' });
	}

	let renamedBooks = 0;

	await withTxn(c.env, async () => {
		await c.env.DB.prepare(
			`UPDATE custom_field_definitions
				 SET field_key = ?, label = ?, field_type = ?, required = ?, enum_options = ?, updated_at = ?
			 WHERE id = ? AND deleted_at IS NULL`
		)
			.bind(payload.key, payload.label, payload.type, payload.required ? 1 : 0, JSON.stringify(payload.enumOptions), now, id)
			.run();

		if (existing.field_key === payload.key) {
			return;
		}

		const books = await c.env.DB.prepare('SELECT id, custom_fields FROM books WHERE deleted_at IS NULL').all<{
			id: string;
			custom_fields: string;
		}>();

		for (const row of books.results ?? []) {
			const values = safeJsonParse<Record<string, unknown>>(row.custom_fields ?? '{}', {});
			if (!Object.prototype.hasOwnProperty.call(values, existing.field_key)) {
				continue;
			}

			const oldValue = values[existing.field_key];
			if (!Object.prototype.hasOwnProperty.call(values, payload.key)) {
				values[payload.key] = oldValue;
			}
			delete values[existing.field_key];

			await c.env.DB.prepare('UPDATE books SET custom_fields = ?, updated_at = ?, version = version + 1 WHERE id = ?')
				.bind(JSON.stringify(values), nowIso(), row.id)
				.run();

			renamedBooks += 1;
		}
	});

	await insertAuditLog(c.env, c.get('user').sub, 'customField.update', 'custom_field', id, {
		oldKey: existing.field_key,
		key: payload.key,
		renamedBooks
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

	const skippedRows: number[] = [];
	const validRows = payload.rows.filter((row, index) => {
		const isValid = Boolean(row.title) && Boolean(row.author);
		if (!isValid) {
			skippedRows.push(index);
		}
		return isValid;
	});

	if (validRows.length === 0) {
		return c.json({
			dryRun: payload.dryRun,
			error: 'No valid rows to import. title and author are required.',
			skippedRows
		}, 400);
	}

	if (payload.dryRun) {
		return c.json({ dryRun: true, acceptedRows: validRows.length, skippedRows });
	}

	await withTxn(c.env, async () => {
		for (const row of validRows) {
			const customFields = await validateCustomFields(c.env, row.customFields);
			const bookId = crypto.randomUUID();
			await c.env.DB.prepare(
				`INSERT INTO books (
					id, title, author, isbn, publication_year, publisher, language, description,
					room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
					created_at, updated_at, deleted_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`
			)
				.bind(
					bookId,
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

			await replaceBookAttributeValues(c.env, bookId, customFields);
		}
	});

	await insertAuditLog(c.env, c.get('user').sub, 'book.import', 'book', null, {
		rows: validRows.length,
		skippedRows
	});

	return c.json({ importedRows: validRows.length, skippedRows }, 201);
});

app.get('/api/export/books.csv', async (c) => {
	const where: string[] = ['deleted_at IS NULL'];
	const values: unknown[] = [];

	const q = c.req.query('q');
	const status = c.req.query('status');
	const roomCode = c.req.query('roomCode');
	const shelfCode = c.req.query('shelfCode');

	if (q) {
		const qValue = `%${q.replaceAll('%', '').replaceAll('_', '')}%`;
		where.push('(title LIKE ? OR author LIKE ? OR isbn LIKE ?)');
		values.push(qValue, qValue, qValue);
	}

	if (status) {
		where.push('status = ?');
		values.push(status);
	}

	if (roomCode) {
		where.push('room_code = ?');
		values.push(roomCode);
	}

	if (shelfCode) {
		where.push('shelf_code = ?');
		values.push(shelfCode);
	}

	const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
	const rowsResult = await c.env.DB.prepare(`SELECT * FROM books ${whereSql} ORDER BY title ASC, id ASC`).bind(...values).all();
	const rows = (rowsResult.results ?? []).map((row) => parseBook(row as Record<string, unknown>));
	const exportRows = rows.map((row) => {
		const customFields = (row.customFields as Record<string, unknown> | undefined) ?? {};
		const shaped: Record<string, unknown> = {};

		for (const column of DEFAULT_BOOK_STRUCTURE) {
			if (column.coreKey) {
				shaped[column.label] = row[column.coreKey];
			} else if (column.customKey) {
				shaped[column.label] = customFields[column.customKey] ?? null;
			}
		}

		return shaped;
	});

	const csv = toCsv(
		exportRows,
		DEFAULT_BOOK_STRUCTURE.map((column) => column.label)
	);

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
				await replaceBookAttributeValues(c.env, id, customFields);
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

				await replaceBookAttributeValues(c.env, row.id, merged.customFields as Record<string, unknown>);
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
