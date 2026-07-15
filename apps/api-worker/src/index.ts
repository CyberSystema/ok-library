import {
	BookFilterQuerySchema,
	BorrowBookSchema,
	CreateBookSchema,
	GenerateCodeSchema,
	ImportBooksSchema,
	ImportCatalogSchema,
	ReturnBookSchema,
	SyncPushSchema,
	UpdateBookSchema,
	UpsertBorrowerSchema,
	UpsertCustomFieldSchema,
	UpsertRoomSchema
} from '@ok-library/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
	authMiddleware,
	constantTimeEqual,
	createAccessToken,
	defaultPbkdf2Iterations,
	generateSaltHex,
	hashPasswordPbkdf2,
	hashPasswordSha256,
	requirePermission,
	requireRole,
	userHasPermission
} from './auth';
import {
	booksCacheKey,
	bumpBooksCacheVersion,
	computeBookFolds,
	EMBEDDING_MODEL,
	ensureBootstrapAdmin,
	getBookAttributeValues,
	getBooksCacheVersion,
	insertAuditLog,
	loadCustomFieldDefs,
	parseBook,
	queryBooksWithFilters,
	replaceBookAttributeValues,
	recordSyncMutation,
	runAtomic,
	semanticSearchBookIds,
	semanticSearchEnabled,
	unvectorizeBook,
	validateCustomFields,
	validateCustomFieldsAgainst,
	vectorizeBook,
	withTxn
} from './db';
import type { AuthClaims, Env } from './types';
import { generateCodeValue, normalizeBookData, nowIso, safeJsonParse, toCsv } from './utils';

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

/**
 * Schedule a fire-and-forget side effect (e.g. Vectorize re-embedding) so it
 * doesn't add latency to the route's response. Falls back to running inline
 * when `executionCtx.waitUntil` is unavailable (e.g. some test harnesses) —
 * better to do the work synchronously than to silently drop it.
 */
function runAfterResponse(c: AppContext, work: () => Promise<unknown>): void {
	const ctx = c.executionCtx as ExecutionContext | undefined;
	if (ctx && typeof ctx.waitUntil === 'function') {
		ctx.waitUntil(
			work().catch((err) => console.warn('Background task failed', err))
		);
	} else {
		void work().catch((err) => console.warn('Background task failed', err));
	}
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
		// A real limit breach (the 429 we threw above) must propagate — only KV
		// I/O failures are allowed to fail open. Without this re-throw the catch
		// would swallow our own HTTPException and the limiter would never block.
		if (error instanceof HTTPException) throw error;
		console.warn('Rate limiter unavailable, continuing without KV enforcement', error);
	}
}

app.use('*', async (c, next) => {
	// Fail-closed in production: a missing CORS_ORIGIN with credentials:true and
	// `origin: '*'` would let any site read authenticated responses. Refuse to
	// boot rather than silently widening the exposure surface.
	const configured = c.env.CORS_ORIGIN;
	if ((c.env.APP_ENV === 'production') && (!configured || configured === '*')) {
		throw new HTTPException(500, { message: 'CORS_ORIGIN must be set to a specific origin in production.' });
	}

	// CORS_ORIGIN can now be a CSV of allowed origins. The single-string and
	// wildcard ('*') forms continue to work unchanged. We hand Hono's `cors`
	// helper a function so it echoes back only origins on the allowlist —
	// preserves the per-request `Access-Control-Allow-Origin` header that
	// browsers require with `credentials: true`.
	const raw = (configured ?? '*').trim();
	const allowlist = raw === '*'
		? null
		: raw.split(',').map((s) => s.trim()).filter(Boolean);

	const originFn = (incoming: string): string | null => {
		if (!allowlist) return incoming || '*';
		if (allowlist.includes(incoming)) return incoming;
		// Echo the first allowlisted entry as a deterministic fallback so a
		// hand-typed CURL without an Origin header still works in dev.
		return allowlist[0] ?? null;
	};

	return cors({
		origin: originFn,
		allowHeaders: ['Authorization', 'Content-Type', 'X-Client-Mutation-Id'],
		exposeHeaders: ['X-Idempotent-Replay'],
		credentials: true
	})(c, next);
});

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  const method = c.req.method;
  // Tighter buckets for high-cost operations:
  //   • login (brute-force surface)            → 20/min
  //   • cover uploads (payload up to 4 MB)     → 30/min
  //   • everything else                        → 180/min
  const isAuthLogin = path === '/api/auth/login';
  const isCoverWrite =
    /^\/api\/books\/[^/]+\/cover$/.test(path) && (method === 'PUT' || method === 'DELETE');

  if (isAuthLogin) {
    await enforceRateLimit(c, 'login', 20);
  } else if (isCoverWrite) {
    await enforceRateLimit(c, 'cover', 30);
  } else {
    await enforceRateLimit(c, 'api', 180);
  }
  await next();
});

app.use('*', async (c, next) => {
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('X-Frame-Options', 'DENY');
	c.header('Referrer-Policy', 'same-origin');
	c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
	// Strict CSP: this worker only serves JSON and the cover-image stream. No
	// inline scripts, no third-party loads. Cover responses get image/jpeg etc
	// content-type; CSP blocks everything else.
	c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; img-src 'self'");
	c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	// Cookie-aware caches mustn't share between users.
	c.header('Vary', 'Origin, Cookie, Authorization');
	await next();
});

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return c.json({ error: error.message }, error.status);
	}

	// Input validation failures are CLIENT errors (400), not server errors.
	// Without this they fall through to the generic 500 below, which (a) reports
	// a bogus "Internal server error" for what is really a bad field, and (b)
	// trips the web client's transient-error retry (it retries 5xx writes up to
	// 4×), so e.g. a too-long title is retried repeatedly and then surfaced as an
	// opaque server error instead of an actionable "title too long" message.
	if (error instanceof z.ZodError) {
		const issue = error.issues[0];
		const path = issue?.path?.length ? issue.path.join('.') : 'input';
		const message = issue ? `${path}: ${issue.message}` : 'Invalid request.';
		return c.json({ error: message, issues: error.issues }, 400);
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
	// Fail-fast indicator. Probes every binding the app actually relies on:
	//   • DB   — a `SELECT 1` round-trip
	//   • KV   — read a sentinel key (the cache namespace; treat read failure
	//            as a soft warning since the app degrades gracefully without it)
	//   • R2   — `head` on a sentinel key so we don't have to upload anything
	//   • auth — JWT_SECRET configured
	// `ok` is true only when the hard dependencies (DB + JWT) are healthy;
	// KV/R2 failures show up as `degraded: true` but don't flip the overall
	// status code, because the app keeps serving requests with reduced
	// behaviour when one of them is briefly unavailable.
	const dbCheck = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>().catch(() => null);
	const dbOk = dbCheck?.ok === 1;

	let kvOk = true;
	try {
		// `get` returns null for an absent key without throwing — any throw
		// means the namespace itself is unreachable.
		await c.env.CACHE.get('__health_probe__');
	} catch {
		kvOk = false;
	}

	let r2Ok = true;
	try {
		await c.env.ASSETS.head('__health_probe__');
	} catch {
		r2Ok = false;
	}

	const authOk = Boolean(c.env.JWT_SECRET);
	const ok = dbOk && authOk;
	const degraded = ok && (!kvOk || !r2Ok);
	return c.json({
		ok,
		degraded,
		db: dbOk,
		auth: authOk,
		kv: kvOk,
		r2: r2Ok,
		// Capability hint: the frontend uses this to decide whether to
		// expose the semantic-search toggle. We don't run a model probe
		// — that would charge for an embedding on every health hit — so
		// "true" here means "bindings exist," not "the model responded."
		semantic: semanticSearchEnabled(c.env),
		env: c.env.APP_ENV ?? 'unknown',
		timestamp: nowIso()
	}, ok ? 200 : 503);
});

app.post('/api/auth/login', async (c) => {
	await ensureBootstrapAdmin(c.env);

	const body = await c.req.json();
	const schema = z.object({ username: z.string().min(1), password: z.string().min(1) });
	const parsed = schema.parse(body);

	const user = await c.env.DB.prepare(
		`SELECT id, username, role, password_hash, password_salt, password_iterations, active
		 FROM staff_users WHERE username = ? LIMIT 1`
	)
		.bind(parsed.username)
		.first<{
			id: string;
			username: string;
			role: 'admin' | 'librarian' | 'viewer';
			password_hash: string;
			password_salt: string | null;
			password_iterations: number;
			active: number;
		}>();

	if (!user || user.active !== 1) {
		throw new HTTPException(401, { message: 'Invalid credentials' });
	}

	let authenticated = false;
	let needsMigration = false;

	if (user.password_salt && user.password_iterations > 0) {
		// Modern format: PBKDF2 with per-user salt.
		const candidate = await hashPasswordPbkdf2(parsed.password, user.password_salt, user.password_iterations);
		authenticated = constantTimeEqual(candidate, user.password_hash);
	} else {
		// Legacy format: unsalted SHA-256. If it matches, lazy-migrate to PBKDF2.
		const candidate = await hashPasswordSha256(parsed.password);
		authenticated = constantTimeEqual(candidate, user.password_hash);
		needsMigration = authenticated;
	}

	if (!authenticated) {
		throw new HTTPException(401, { message: 'Invalid credentials' });
	}

	if (needsMigration) {
		try {
			const salt = generateSaltHex();
			const iterations = defaultPbkdf2Iterations();
			const newHash = await hashPasswordPbkdf2(parsed.password, salt, iterations);
			await c.env.DB.prepare(
				`UPDATE staff_users
				   SET password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ?
				 WHERE id = ?`
			).bind(newHash, salt, iterations, nowIso(), user.id).run();
		} catch (err) {
			// Migration failure shouldn't block login — log and move on.
			console.warn('Password rehash failed; will retry next login', err);
		}
	}

	const token = await createAccessToken(c.env, {
		sub: user.id,
		username: user.username,
		role: user.role
	});

	const ttl = Number(c.env.ACCESS_TOKEN_TTL_SECONDS ?? '43200');
	c.header(
		'Set-Cookie',
		`ok_library_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${ttl}`
	);

	// Return the token in the body as well as the HttpOnly cookie. Browsers that
	// block the cross-site cookie (Safari/WebKit ITP — pages.dev and workers.dev
	// are different registrable sites) can fall back to sending it as a bearer
	// token, which authMiddleware already accepts. Native clients (mobile) read
	// it from here too.
	return c.json({ user: { id: user.id, username: user.username, role: user.role }, token });
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
	// GET /api/books/:id/cover is public so <img> tags load without round-tripping
	// the session cookie. Mutations on the cover (PUT/DELETE) still require auth.
	if (c.req.method === 'GET' && /^\/api\/books\/[^/]+\/cover$/.test(c.req.path)) {
		await next();
		return;
	}
	await authMiddleware(c, next);
});

// ─── Idempotency: replay lost responses for retried writes ────────────────────
// When the client sends a write with `X-Client-Mutation-Id`, we record the
// final (status, body) under that id. If the same id replays — usually
// because the response was lost on the wire and the client retried — we
// return the recorded response verbatim instead of re-executing the
// mutation. This is what makes our retry logic safe against double-writes.
app.use('/api/*', async (c, next) => {
	const method = c.req.method;
	if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
		await next();
		return;
	}
	const mutationId = c.req.header('x-client-mutation-id');
	if (!mutationId) {
		await next();
		return;
	}

	// 1. Replay path: did we already process this id? Return the same response —
	// but only to the user who originally made the mutation. A client-generated
	// id colliding across users (or a stolen id) must not let one user read
	// another user's mutation result.
	try {
		const prior = await c.env.DB.prepare(
			'SELECT status, response_body, user_id FROM mutation_log WHERE id = ? LIMIT 1'
		).bind(mutationId).first<{ status: number; response_body: string; user_id: string | null }>();
		if (prior) {
			const currentUserId = c.get('user')?.sub ?? null;
			if ((prior.user_id ?? null) !== currentUserId) {
				throw new HTTPException(409, { message: 'This request id was already used by another session.' });
			}
			return new Response(prior.response_body, {
				status: prior.status,
				headers: { 'Content-Type': 'application/json', 'X-Idempotent-Replay': '1' }
			});
		}
	} catch (err) {
		// Let an intentional conflict propagate; only swallow lookup I/O errors.
		if (err instanceof HTTPException) throw err;
		// If the lookup itself fails we proceed with the request rather than
		// failing closed — better to risk a duplicate (which the client's own
		// retry logic only triggers on transient errors anyway) than to block
		// every write because a single SELECT errored.
		console.warn('mutation_log lookup failed', err);
	}

	// 2. Run the route.
	await next();

	// 3. Persist the response if it succeeded. Only 2xx outcomes are recorded
	// because retrying a 4xx will deterministically produce the same 4xx and
	// caching errors would mask later code fixes.
	const res = c.res;
	if (!res || res.status < 200 || res.status >= 300) return;

	let bodyText = '';
	try {
		// Clone so the original response can still be sent to the client.
		bodyText = await res.clone().text();
	} catch {
		return;
	}

	const user = c.get('user');
	try {
		await c.env.DB.prepare(
			`INSERT OR IGNORE INTO mutation_log (id, user_id, method, path, status, response_body, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).bind(
			mutationId,
			user?.sub ?? null,
			method,
			c.req.path,
			res.status,
			bodyText,
			nowIso()
		).run();
	} catch (err) {
		// Non-fatal: the mutation already committed. Worst case is a future
		// retry repeats it. Log so we can investigate if this is frequent.
		console.warn('mutation_log insert failed', err);
	}
});

app.get('/api/auth/session', async (c) => {
	const user = c.get('user');
	return c.json({ user: { id: user.sub, username: user.username, role: user.role } });
});

// ─── Self-service profile (any authenticated user) ────────────────────────────
const UpdateMeSchema = z.object({
	username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Username may use letters, numbers, dot, underscore, dash').optional(),
	newPassword: z.string().min(8).max(200).optional(),
	currentPassword: z.string().min(1)
}).refine((v) => v.username !== undefined || v.newPassword !== undefined, {
	message: 'Provide a new username or password.'
});

app.patch('/api/me', async (c) => {
	const actor = c.get('user');
	const body = await c.req.json();
	const parsed = UpdateMeSchema.parse(body);

	const me = await c.env.DB.prepare(
		`SELECT id, username, role, password_hash, password_salt, password_iterations, active
		 FROM staff_users WHERE id = ? LIMIT 1`
	)
		.bind(actor.sub)
		.first<{
			id: string;
			username: string;
			role: 'admin' | 'librarian' | 'viewer';
			password_hash: string;
			password_salt: string | null;
			password_iterations: number;
			active: number;
		}>();
	if (!me || me.active !== 1) {
		throw new HTTPException(401, { message: 'Account not found or inactive.' });
	}

	// Verify current password (supports legacy SHA-256 too).
	let verified = false;
	if (me.password_salt && me.password_iterations > 0) {
		const candidate = await hashPasswordPbkdf2(parsed.currentPassword, me.password_salt, me.password_iterations);
		verified = constantTimeEqual(candidate, me.password_hash);
	} else {
		const candidate = await hashPasswordSha256(parsed.currentPassword);
		verified = constantTimeEqual(candidate, me.password_hash);
	}
	if (!verified) {
		throw new HTTPException(400, { message: 'Current password is incorrect.' });
	}

	const updates: string[] = [];
	const binds: Array<string | number> = [];
	const changes: Record<string, unknown> = {};

	if (parsed.username && parsed.username !== me.username) {
		const clash = await c.env.DB.prepare(
			'SELECT id FROM staff_users WHERE username = ? AND id != ? LIMIT 1'
		).bind(parsed.username, me.id).first<{ id: string }>();
		if (clash) {
			throw new HTTPException(409, { message: 'A user with this username already exists.' });
		}
		updates.push('username = ?');
		binds.push(parsed.username);
		changes.username = { from: me.username, to: parsed.username };
	}

	if (parsed.newPassword) {
		const salt = generateSaltHex();
		const iterations = defaultPbkdf2Iterations();
		const newHash = await hashPasswordPbkdf2(parsed.newPassword, salt, iterations);
		updates.push('password_hash = ?', 'password_salt = ?', 'password_iterations = ?');
		binds.push(newHash, salt, iterations);
		changes.password = true;
	}

	if (updates.length === 0) {
		// Nothing actually changed (e.g. username submitted matched current one).
		return c.json({ user: { id: me.id, username: me.username, role: me.role } });
	}

	const ts = nowIso();
	updates.push('updated_at = ?');
	binds.push(ts);
	binds.push(me.id);

	await c.env.DB.prepare(
		`UPDATE staff_users SET ${updates.join(', ')} WHERE id = ?`
	).bind(...binds).run();

	await insertAuditLog(c.env, me.id, 'user.self_update', 'staff_user', me.id, changes);

	const finalUsername = (changes.username as { to: string } | undefined)?.to ?? me.username;

	// If the username changed, the JWT still encodes the old one. Reissue the
	// session cookie (and hand back a fresh bearer token) so the client sees the
	// up-to-date identity right away.
	let refreshedToken: string | undefined;
	if (changes.username) {
		const token = await createAccessToken(c.env, {
			sub: me.id,
			username: finalUsername,
			role: me.role
		});
		refreshedToken = token;
		const ttl = Number(c.env.ACCESS_TOKEN_TTL_SECONDS ?? '43200');
		c.header(
			'Set-Cookie',
			`ok_library_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${ttl}`
		);
	}

	return c.json({
		user: { id: me.id, username: finalUsername, role: me.role },
		...(refreshedToken ? { token: refreshedToken } : {})
	});
});

app.get('/api/books', async (c) => {
	const query = BookFilterQuerySchema.parse(c.req.query());
	const customFilters = Object.entries(c.req.query())
		.filter(([key]) => key.startsWith('custom_'))
		.map(([key, value]) => ({ key: key.replace('custom_', ''), value }));

	// includeDeleted is admin-only — silently drop it for non-admins so a
	// librarian can't browse the trash via the public list endpoint.
	const includeDeleted = Boolean(query.includeDeleted) && c.get('user').role === 'admin';

	// Cache key must reflect the *effective* trash visibility, not the raw
	// query string. Otherwise two users with different roles passing the same
	// `?includeDeleted=1` collide on the same cache bucket and one role sees
	// the other role's response (admin missing trash, or non-admin getting it).
	const cacheVersion = await getBooksCacheVersion(c.env);
	const cacheKey = booksCacheKey(cacheVersion, {
		query: { ...query, includeDeleted },
		customFilters
	});

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
		customFilters,
		yearMin: query.yearMin,
		yearMax: query.yearMax,
		missingIsbn: query.missingIsbn,
		missingShelf: query.missingShelf,
		untitled: query.untitled,
		unknownAuthor: query.unknownAuthor,
		includeDeleted
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

// Distinct catalog values used to power the add/edit form autocomplete
// (title, author, publisher, language, shelf code). Ordered by frequency so
// the values a librarian actually reuses surface first, then capped to keep the
// payload small. Cached per books-cache-version so it refreshes after any write.
// NOTE: registered before `/api/books/:id` so "facets" isn't captured as an id.
// Gated to writers: the values only feed the add/edit form autocomplete, which
// viewers can't open, so there's no reason to expose the full catalog value
// enumeration to read-only accounts.
app.get('/api/books/facets', requirePermission('books.write', { librarian: true }), async (c) => {
	const cacheVersion = await getBooksCacheVersion(c.env);
	const cacheKey = `facets:${cacheVersion}`;

	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) return c.json(cached);
		} catch (error) {
			console.warn('Facets cache read failed, falling back to DB query', error);
		}
	}

	// `column` is always one of the hard-coded literals below — never user
	// input — so interpolating it into the SQL is safe from injection.
	async function distinctValues(column: string, limit: number): Promise<string[]> {
		const { results } = await c.env.DB.prepare(
			`SELECT ${column} AS v, COUNT(*) AS n
			   FROM books
			  WHERE deleted_at IS NULL AND ${column} IS NOT NULL AND TRIM(${column}) != ''
			    AND ${column} NOT IN ('(Unknown)', '(Untitled)')
			  GROUP BY ${column}
			  ORDER BY n DESC, ${column} ASC
			  LIMIT ?`
		)
			.bind(limit)
			.all<{ v: string; n: number }>();
		return (results ?? [])
			.map((r) => r.v)
			.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
	}

	const [titles, authors, publishers, languages, shelfCodes] = await Promise.all([
		distinctValues('title', 1000),
		distinctValues('author', 1000),
		distinctValues('publisher', 1000),
		distinctValues('language', 200),
		distinctValues('shelf_code', 1000)
	]);

	const response = { titles, authors, publishers, languages, shelfCodes };

	if (c.env.CACHE) {
		try {
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 300 });
		} catch (error) {
			console.warn('Facets cache write failed, continuing without cache', error);
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

app.post('/api/books', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = normalizeBookData(CreateBookSchema.parse(await c.req.json()));
	const now = nowIso();
	const id = crypto.randomUUID();
	const customFields = await validateCustomFields(c.env, payload.customFields);

	const tagsJson = JSON.stringify(payload.tags);
	const customFieldsJson = JSON.stringify(customFields);
	const folds = computeBookFolds({
		title: payload.title,
		author: payload.author,
		isbn: payload.isbn ?? null,
		publisher: payload.publisher ?? null,
		description: payload.description ?? null,
		tagsJson,
		customFieldsJson
	});

	await c.env.DB.prepare(
		`INSERT INTO books (
			id, title, author, isbn, publication_year, publisher, language, description,
			room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
			legacy_id, created_at, updated_at, deleted_at,
			title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
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
			tagsJson,
			customFieldsJson,
			payload.status,
			payload.legacyId ?? null,
			now,
			now,
			folds.title_fold,
			folds.author_fold,
			folds.isbn_fold,
			folds.publisher_fold,
			folds.description_fold,
			folds.tags_fold,
			folds.custom_fields_fold
		)
		.run();

	await replaceBookAttributeValues(c.env, id, customFields);
	await bumpBooksCacheVersion(c.env);

	// Fire-and-forget: keep the response snappy while the embedding round-
	// trip (Workers AI → Vectorize) runs in the background. No-ops cleanly
	// when the optional bindings aren't configured.
	runAfterResponse(c, () => vectorizeBook(c.env, id, {
		title: payload.title,
		author: payload.author,
		description: payload.description ?? null,
		publisher: payload.publisher ?? null,
		language: payload.language ?? null,
		publicationYear: payload.publicationYear ?? null,
		tags: payload.tags,
		customFields
	}));

	await insertAuditLog(c.env, c.get('user').sub, 'book.create', 'book', id, {
		title: payload.title,
		author: payload.author
	});

	// Duplicate check: warn if another non-deleted book has the same title+author.
	// Canonicalize the legacy '(Unknown)'/'(Untitled)' sentinels to '' on both
	// sides so a re-catalogued legacy book (author '(Unknown)') is still detected
	// as a duplicate of the same title added blank (author '') and vice versa.
	const dupCheck = await c.env.DB.prepare(
		`SELECT id, title, author FROM books
		 WHERE deleted_at IS NULL AND id != ?
		   AND CASE WHEN LOWER(TRIM(title)) = '(untitled)' THEN '' ELSE LOWER(TRIM(title)) END = LOWER(TRIM(?))
		   AND CASE WHEN LOWER(TRIM(author)) = '(unknown)' THEN '' ELSE LOWER(TRIM(author)) END = LOWER(TRIM(?))`
	)
		.bind(id, payload.title, payload.author)
		.all<{ id: string; title: string; author: string }>();

	const duplicateOf = dupCheck.results ?? [];

	return c.json({ id, ...(duplicateOf.length > 0 ? { duplicateOf } : {}) }, 201);
});

app.put('/api/books/:id', requirePermission('books.write', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}
	const payload = normalizeBookData(UpdateBookSchema.parse(await c.req.json()));

	const existing = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!existing) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	const existingMap = existing as Record<string, unknown>;
	const currentVersion = Number(existingMap.version ?? 0);
	if (payload.version !== currentVersion) {
		throw new HTTPException(409, { message: 'Version conflict. Refresh and retry.' });
	}

	// Circulation invariant: the 'borrowed' status must always own an open loan
	// row, so the generic metadata edit may not move a book INTO or OUT OF the
	// borrowed state — that belongs to the borrow/return actions. Without this
	// guard, a status <select> edit desyncs book.status from borrow_transactions
	// (phantom loans, an unreturnable "borrowed" book, and a later opaque 500 when
	// the next borrow trips the unique active-loan index). The one legitimate
	// exception is marking a book lost/maintenance while it is on loan (it left
	// the shelf physically); we allow that but close the open loan in the same
	// transaction so the borrower's open/overdue counts stay accurate.
	const currentStatus = String(existingMap.status ?? 'available');
	const incomingStatus = payload.status;
	let closeOpenLoanOnWrite = false;
	if (incomingStatus && incomingStatus !== currentStatus) {
		if (incomingStatus === 'borrowed') {
			throw new HTTPException(409, { message: 'Use the borrow action to lend a book.' });
		}
		if (currentStatus === 'borrowed') {
			if (incomingStatus === 'available') {
				throw new HTTPException(409, { message: 'Return the book before marking it available.' });
			}
			// borrowed → lost/maintenance: allowed, but the open loan must be closed too.
			closeOpenLoanOnWrite = true;
		}
	}

	const now = nowIso();
	// Lenient mode: tolerate keys whose custom field definition was deleted,
	// so a legacy value on the book doesn't block an unrelated edit.
	const customFields = await validateCustomFields(
		c.env,
		(payload.customFields ?? JSON.parse((existingMap.custom_fields as string) ?? '{}')) as Record<string, unknown>,
		{ requireAllRequired: payload.customFields !== undefined, rejectUnknownKeys: false }
	);
	const merged = {
		...parseBook(existingMap),
		...payload,
		tags: payload.tags ?? JSON.parse((existingMap.tags as string) ?? '[]'),
		customFields,
		version: currentVersion + 1,
		updatedAt: now
	};

	const mergedTagsJson = JSON.stringify(merged.tags);
	const mergedCustomFieldsJson = JSON.stringify(merged.customFields);
	const mergedFolds = computeBookFolds({
		title: merged.title as string | null,
		author: merged.author as string | null,
		isbn: (merged.isbn as string | null) ?? null,
		publisher: (merged.publisher as string | null) ?? null,
		description: (merged.description as string | null) ?? null,
		tagsJson: mergedTagsJson,
		customFieldsJson: mergedCustomFieldsJson
	});

	const updateBookStmt = c.env.DB.prepare(
		`UPDATE books SET
			title = ?, author = ?, isbn = ?, publication_year = ?, publisher = ?, language = ?, description = ?,
			room_code = ?, shelf_code = ?, acquisition_date = ?, tags = ?, custom_fields = ?, status = ?,
			legacy_id = ?, version = ?, updated_at = ?,
			title_fold = ?, author_fold = ?, isbn_fold = ?, publisher_fold = ?, description_fold = ?, tags_fold = ?, custom_fields_fold = ?
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
			mergedTagsJson,
			mergedCustomFieldsJson,
			merged.status,
			(merged as { legacyId?: string | null }).legacyId ?? (existingMap.legacy_id as string | null) ?? null,
			merged.version,
			merged.updatedAt,
			mergedFolds.title_fold,
			mergedFolds.author_fold,
			mergedFolds.isbn_fold,
			mergedFolds.publisher_fold,
			mergedFolds.description_fold,
			mergedFolds.tags_fold,
			mergedFolds.custom_fields_fold,
			id
		);

	if (closeOpenLoanOnWrite) {
		// Atomically close the open loan when a borrowed book is marked lost/
		// maintenance, so no phantom active loan is left behind.
		await runAtomic(c.env, [
			c.env.DB.prepare(
				`UPDATE borrow_transactions
				    SET returned_at = ?, notes = TRIM(COALESCE(notes, '') || ' [auto-closed: marked ' || ? || ']')
				  WHERE book_id = ? AND returned_at IS NULL`
			).bind(now, merged.status, id),
			updateBookStmt
		]);
	} else {
		await updateBookStmt.run();
	}

	await replaceBookAttributeValues(c.env, id, merged.customFields as Record<string, unknown>);
	await bumpBooksCacheVersion(c.env);

	// Re-embed if any field the embedding text consumes might have changed.
	// `vectorizeBook` already short-circuits if the source-hash matches.
	runAfterResponse(c, () => vectorizeBook(c.env, id, {
		title: merged.title as string | null,
		author: merged.author as string | null,
		description: (merged.description as string | null) ?? null,
		publisher: (merged.publisher as string | null) ?? null,
		language: (merged.language as string | null) ?? null,
		publicationYear: (merged.publicationYear as number | null) ?? null,
		tags: (merged.tags as string[] | null) ?? [],
		customFields: merged.customFields as Record<string, unknown>
	}));

	await insertAuditLog(c.env, c.get('user').sub, 'book.update', 'book', id ?? null, {
		version: merged.version
	});

	return c.json({ id, version: merged.version });
});

app.delete('/api/books/:id', requirePermission('books.delete'), async (c) => {
	const id = c.req.param('id');
	const now = nowIso();
	// Refuse to delete a book that is still on loan — otherwise the open
	// borrow_transactions row is stranded (the book vanishes from the shelf but
	// the loan stays "active" forever, permanently inflating the borrower's
	// open/overdue counts). Only OPEN loans block; a book whose loans are all
	// returned is fine to delete. The partial unique active-loan index means this
	// is at most one row.
	const result = await c.env.DB.prepare(
		`UPDATE books SET deleted_at = ?, updated_at = ?, version = version + 1
		 WHERE id = ? AND deleted_at IS NULL
		   AND NOT EXISTS (
		     SELECT 1 FROM borrow_transactions
		      WHERE book_id = books.id AND returned_at IS NULL
		   )`
	)
		.bind(now, now, id)
		.run();

	// D1's `success` is true for any well-formed statement, even if zero rows
	// matched. The accurate signal that something was actually deleted is
	// `meta.changes`. Zero changes means either the book doesn't exist / is
	// already trashed, OR it has an open loan — disambiguate so the librarian
	// gets an actionable message instead of a misleading 404.
	if ((result.meta?.changes ?? 0) === 0) {
		const openLoan = await c.env.DB.prepare(
			`SELECT 1 FROM borrow_transactions bt
			   JOIN books b ON b.id = bt.book_id
			  WHERE bt.book_id = ? AND bt.returned_at IS NULL AND b.deleted_at IS NULL
			  LIMIT 1`
		).bind(id).first();
		if (openLoan) {
			throw new HTTPException(409, { message: 'Cannot delete: the book is on loan. Return it first.' });
		}
		throw new HTTPException(404, { message: 'Book not found' });
	}

	await bumpBooksCacheVersion(c.env);
	// Soft-deleted books should not surface from semantic search either.
	// We remove the embedding now; if the book is restored later, restore
	// re-queues the embedding work below.
	if (id) runAfterResponse(c, () => unvectorizeBook(c.env, id));
	await insertAuditLog(c.env, c.get('user').sub, 'book.delete', 'book', id ?? null, {});
	return c.body(null, 204);
});

// Restore a previously soft-deleted book. Admin-only. Useful when a librarian
// undoes an accidental deletion — book row, cover image, and history all stay
// in the DB until a hard purge, so this is a single UPDATE.
app.post('/api/books/:id/restore', requirePermission('books.delete'), async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}
	const now = nowIso();
	const result = await c.env.DB.prepare(
		`UPDATE books SET deleted_at = NULL, updated_at = ?, version = version + 1
		 WHERE id = ? AND deleted_at IS NOT NULL`
	).bind(now, id).run();

	if ((result.meta?.changes ?? 0) === 0) {
		throw new HTTPException(404, { message: 'Book not found in trash' });
	}

	await bumpBooksCacheVersion(c.env);
	// Restored books need a fresh embedding because we deleted it on
	// soft-delete. Re-read just the fields the embedding cares about.
	if (id) {
		runAfterResponse(c, async () => {
			const row = await c.env.DB.prepare(
				`SELECT title, author, description, publisher, language, publication_year, tags, custom_fields
				 FROM books WHERE id = ? LIMIT 1`
			).bind(id).first<{
				title: string | null; author: string | null; description: string | null;
				publisher: string | null; language: string | null; publication_year: number | null;
				tags: string | null; custom_fields: string | null;
			}>();
			if (!row) return;
			await vectorizeBook(c.env, id, {
				title: row.title,
				author: row.author,
				description: row.description,
				publisher: row.publisher,
				language: row.language,
				publicationYear: row.publication_year,
				tags: safeJsonParse<string[]>(row.tags ?? '[]', []),
				customFields: safeJsonParse<Record<string, unknown>>(row.custom_fields ?? '{}', {})
			});
		});
	}
	await insertAuditLog(c.env, c.get('user').sub, 'book.restore', 'book', id, {});
	return c.json({ id, restored: true });
});

// List soft-deleted books — the "trash" view. Admin-only. Paged so a runaway
// bulk-delete doesn't return a 12K-row payload.
app.get('/api/books/trash', requirePermission('books.delete'), async (c) => {
	const page = Math.max(1, Number(c.req.query('page') ?? 1));
	const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 25)));
	const offset = (page - 1) * pageSize;

	const [rowsRes, countRes] = await Promise.all([
		c.env.DB.prepare(
			`SELECT * FROM books WHERE deleted_at IS NOT NULL
			 ORDER BY deleted_at DESC LIMIT ? OFFSET ?`
		).bind(pageSize, offset).all(),
		c.env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NOT NULL').first<{ n: number }>()
	]);

	return c.json({
		page,
		pageSize,
		total: Number(countRes?.n ?? 0),
		items: ((rowsRes.results ?? []) as Array<Record<string, unknown>>).map(parseBook)
	});
});

// Hard-delete a book from the trash. Admin-only. Removes the book row plus
// orphan rows that referenced it; covers in R2 are wiped too.
app.delete('/api/books/:id/purge', requirePermission('books.delete'), async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}
	const existing = await c.env.DB.prepare('SELECT id, cover_url FROM books WHERE id = ? AND deleted_at IS NOT NULL')
		.bind(id)
		.first<{ id: string; cover_url: string | null }>();
	if (!existing) {
		throw new HTTPException(404, { message: 'Book not in trash (must soft-delete first)' });
	}

	await runAtomic(c.env, [
		// Cascade in app code since SQLite ALTER TABLE can't add ON DELETE CASCADE
		// retroactively. Order matters: kill children first. db.batch() guarantees
		// all-or-nothing — a partial failure can't leave orphaned child rows.
		c.env.DB.prepare('DELETE FROM book_attribute_values WHERE book_id = ?').bind(id),
		c.env.DB.prepare('DELETE FROM code_assignments WHERE book_id = ?').bind(id),
		c.env.DB.prepare('DELETE FROM borrow_transactions WHERE book_id = ?').bind(id),
		c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id)
	]);

	// Best-effort R2 cleanup — failing here doesn't roll back the DB delete,
	// orphan files would be cleaned by the maintenance sweep.
	for (const ext of ['jpg', 'png', 'webp', 'gif']) {
		try { await c.env.ASSETS.delete(`covers/${id}.${ext}`); } catch { /* ignore */ }
	}

	await bumpBooksCacheVersion(c.env);
	// Drop the embedding too — purge is irreversible, the vector should go
	// with the row. `book_vectorized` cascades through the FK once `books`
	// is gone, but the Vectorize index doesn't, hence the explicit call.
	runAfterResponse(c, () => unvectorizeBook(c.env, id));
	await insertAuditLog(c.env, c.get('user').sub, 'book.purge', 'book', id, {});
	return c.body(null, 204);
});

// Resolve a borrower (existing id, existing name+contact, or new) and return
// the canonical row. Used by both the direct borrow endpoint and the offline
// sync push path so they stay in lockstep.
async function resolveBorrower(
	env: Env,
	input: { borrowerId?: string | null; borrowerName?: string | null; borrowerContact?: string | null }
): Promise<{ borrowerId: string | null; borrowerName: string; borrowerContact: string | null }> {
	let borrowerId: string | null = input.borrowerId ?? null;
	let borrowerName = input.borrowerName?.trim() ?? '';
	let borrowerContact = input.borrowerContact ?? null;
	const now = nowIso();

	if (borrowerId) {
		const existing = await env.DB.prepare('SELECT id, name, contact FROM borrowers WHERE id = ? LIMIT 1')
			.bind(borrowerId)
			.first<{ id: string; name: string; contact: string | null }>();
		if (!existing) {
			throw new HTTPException(404, { message: 'Borrower not found' });
		}
		return { borrowerId: existing.id, borrowerName: existing.name, borrowerContact: borrowerContact ?? existing.contact };
	}

	if (borrowerName) {
		const existing = await env.DB.prepare(
			`SELECT id FROM borrowers WHERE LOWER(name) = LOWER(?)
			   AND COALESCE(contact, '') = COALESCE(?, '') LIMIT 1`
		).bind(borrowerName, borrowerContact ?? '').first<{ id: string }>();
		if (existing) {
			return { borrowerId: existing.id, borrowerName, borrowerContact };
		}
		borrowerId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO borrowers (id, name, contact, notes, created_at, updated_at)
			 VALUES (?, ?, ?, NULL, ?, ?)`
		).bind(borrowerId, borrowerName, borrowerContact ?? null, now, now).run();
		return { borrowerId, borrowerName, borrowerContact };
	}

	return { borrowerId: null, borrowerName, borrowerContact };
}

app.post('/api/books/:id/borrow', requirePermission('circulation', { librarian: true }), async (c) => {
	const bookId = c.req.param('id');
	const payload = BorrowBookSchema.parse(await c.req.json());

	// Reject due dates that are not strictly in the future. Catches calendar
	// typos (last year) and timezone-crossed clocks before they create
	// already-overdue loans.
	if (Date.parse(payload.dueAt) <= Date.now()) {
		throw new HTTPException(400, { message: 'dueAt must be in the future.' });
	}

	const { borrowerId, borrowerName, borrowerContact } = await resolveBorrower(c.env, payload);

	const now = nowIso();
	const txId = crypto.randomUUID();

	// Atomic state transition: only flip the row if it is still 'available'.
	// A second concurrent borrow request will see meta.changes === 0 and 409.
	// This replaces the previous read-then-write pattern that raced under load.
	const flip = await c.env.DB.prepare(
		`UPDATE books SET status = 'borrowed', version = version + 1, updated_at = ?
		 WHERE id = ? AND deleted_at IS NULL AND status = 'available'`
	).bind(now, bookId).run();

	if ((flip.meta?.changes ?? 0) === 0) {
		const exists = await c.env.DB.prepare('SELECT status FROM books WHERE id = ? AND deleted_at IS NULL')
			.bind(bookId).first<{ status: string }>();
		if (!exists) {
			throw new HTTPException(404, { message: 'Book not found' });
		}
		throw new HTTPException(409, { message: 'Book is not available' });
	}

	try {
		await c.env.DB.prepare(
			`INSERT INTO borrow_transactions (
				id, book_id, borrower_id, borrower_name, borrower_contact, borrowed_at, due_at, returned_at, notes, created_by, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
		)
			.bind(
				txId,
				bookId,
				borrowerId,
				borrowerName,
				borrowerContact,
				now,
				payload.dueAt,
				payload.notes ?? null,
				c.get('user').sub,
				now
			)
			.run();
	} catch (err) {
		// Compensating revert if the transaction insert fails (e.g. partial
		// unique-active-loan index trips because another writer raced in).
		await c.env.DB.prepare(
			`UPDATE books SET status = 'available', updated_at = ? WHERE id = ? AND status = 'borrowed'`
		).bind(nowIso(), bookId).run();
		throw err;
	}

	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.borrow', 'book', bookId ?? null, {
		transactionId: txId,
		dueAt: payload.dueAt
	});

	return c.json({ transactionId: txId, borrowerId }, 201);
});

app.post('/api/books/:id/return', requirePermission('circulation', { librarian: true }), async (c) => {
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
	// Atomic: borrow row is closed AND the book becomes available, or neither.
	await runAtomic(c.env, [
		c.env.DB.prepare(
			`UPDATE borrow_transactions SET returned_at = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`
		).bind(now, payload.notes ?? null, now, tx.id),
		c.env.DB.prepare(`UPDATE books SET status = 'available', version = version + 1, updated_at = ? WHERE id = ?`)
			.bind(now, bookId)
	]);

	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.return', 'book', bookId ?? null, {
		transactionId: tx.id
	});

	return c.json({ transactionId: tx.id, returnedAt: now });
});

app.get('/api/books/:id/history', requirePermission('circulation', { librarian: true }), async (c) => {
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

app.put('/api/books/:id/attributes', requirePermission('books.write', { librarian: true }), async (c) => {
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

	const normalizedJson = JSON.stringify(normalized);
	const normalizedFold = computeBookFolds({ customFieldsJson: normalizedJson }).custom_fields_fold;
	await c.env.DB.prepare('UPDATE books SET custom_fields = ?, custom_fields_fold = ?, updated_at = ?, version = version + 1 WHERE id = ?')
		.bind(normalizedJson, normalizedFold, nowIso(), id)
		.run();

	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.attributes.update', 'book', id ?? null, {
		attributeCount: Object.keys(normalized).length
	});

	return c.json({ bookId: id, values: normalized });
});

app.get('/api/borrow/active', requirePermission('circulation', { librarian: true }), async (c) => {
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

app.post('/api/books/:id/codes', requirePermission('books.write', { librarian: true }), async (c) => {
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
	let row = await c.env.DB.prepare(
		`SELECT b.*, ca.code_type, ca.code_value
		 FROM code_assignments ca
		 JOIN books b ON b.id = ca.book_id
		 WHERE ca.code_value = ? AND ca.active = 1 AND b.deleted_at IS NULL
		 LIMIT 1`
	)
		.bind(codeValue)
		.first();

	// Fallback: printed labels (labels.ts) encode /api/scan/<legacy_id | book id>,
	// NOT a generated code_value, so scanning a printed label would otherwise
	// always 404. If no code assignment matches, resolve the value directly
	// against the book's legacy_id or id. Generated codes still take priority.
	if (!row) {
		row = await c.env.DB.prepare(
			`SELECT b.* FROM books b
			 WHERE (b.legacy_id = ? OR b.id = ?) AND b.deleted_at IS NULL
			 LIMIT 1`
		)
			.bind(codeValue, codeValue)
			.first();
	}

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

app.post('/api/setup/default-book-structure', requirePermission('setup'), async (c) => {
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

app.post('/api/rooms', requirePermission('rooms.write', { librarian: true }), async (c) => {
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

app.put('/api/rooms/:id', requirePermission('rooms.write', { librarian: true }), async (c) => {
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

app.delete('/api/rooms/:id', requirePermission('rooms.delete'), async (c) => {
	const id = c.req.param('id');
	const result = await c.env.DB.prepare('DELETE FROM rooms WHERE id = ?').bind(id).run();
	if ((result.meta?.changes ?? 0) === 0) {
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

app.post('/api/custom-fields', requirePermission('customFields.manage', { librarian: true }), async (c) => {
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

app.put('/api/custom-fields/:id', requirePermission('customFields.manage', { librarian: true }), async (c) => {
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

	// The definition rename + per-book key rewrites are run together where
	// possible, but D1's batch() caps at 50 statements per call — so libraries
	// with more than ~49 books carrying this key would have thrown if we
	// shoved everything into one batch. We chunk in groups of 50 and put the
	// definition update in the very first batch so the def is committed
	// alongside the first slice of book rewrites. Later book batches lose
	// strict cross-batch atomicity, but each book UPDATE is idempotent on
	// (custom_fields, custom_fields_fold) — retrying the rename completes
	// any books that were missed mid-flight, since `validateCustomFields`
	// tolerates unknown keys on the update path.
	const D1_BATCH_LIMIT = 50;
	const defUpdate = c.env.DB.prepare(
		`UPDATE custom_field_definitions
			 SET field_key = ?, label = ?, field_type = ?, required = ?, enum_options = ?, updated_at = ?
		 WHERE id = ? AND deleted_at IS NULL`
	).bind(payload.key, payload.label, payload.type, payload.required ? 1 : 0, JSON.stringify(payload.enumOptions), now, id);

	const bookUpdates: D1PreparedStatement[] = [];
	if (existing.field_key !== payload.key) {
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

			const valuesJson = JSON.stringify(values);
			const valuesFold = computeBookFolds({ customFieldsJson: valuesJson }).custom_fields_fold;
			bookUpdates.push(
				c.env.DB.prepare('UPDATE books SET custom_fields = ?, custom_fields_fold = ?, updated_at = ?, version = version + 1 WHERE id = ?')
					.bind(valuesJson, valuesFold, nowIso(), row.id)
			);
			renamedBooks += 1;
		}
	}

	// First batch: def update + as many book updates as will fit alongside it.
	const firstChunk = bookUpdates.slice(0, D1_BATCH_LIMIT - 1);
	await runAtomic(c.env, [defUpdate, ...firstChunk]);
	for (let i = firstChunk.length; i < bookUpdates.length; i += D1_BATCH_LIMIT) {
		await runAtomic(c.env, bookUpdates.slice(i, i + D1_BATCH_LIMIT));
	}

	// A rename rewrites many books' custom_fields; without bumping the cache
	// version the 60s KV books-list cache keeps serving the old key/value shape.
	if (renamedBooks > 0) {
		await bumpBooksCacheVersion(c.env);
	}

	await insertAuditLog(c.env, c.get('user').sub, 'customField.update', 'custom_field', id, {
		oldKey: existing.field_key,
		key: payload.key,
		renamedBooks
	});

	return c.json({ id });
});

app.delete('/api/custom-fields/:id', requirePermission('customFields.manage', { librarian: true }), async (c) => {
	const id = c.req.param('id');
	const now = nowIso();
	await c.env.DB.prepare('UPDATE custom_field_definitions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
		.bind(now, now, id)
		.run();

	await insertAuditLog(c.env, c.get('user').sub, 'customField.delete', 'custom_field', id ?? null, {});
	return c.body(null, 204);
});

app.post('/api/import/books', requirePermission('import'), async (c) => {
	let rawPayload: unknown;
	try {
		rawPayload = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON payload.' }, 400);
	}

	const parsedPayload = ImportBooksSchema.safeParse(rawPayload);
	if (!parsedPayload.success) {
		return c.json(
			{
				error: 'Invalid import payload.',
				details: parsedPayload.error.issues.slice(0, 20)
			},
			400
		);
	}

	const payload = parsedPayload.data;
	const now = nowIso();

	const skippedRows: Array<{ index: number; reason: string }> = [];
	const readyRows: Array<{ index: number; row: (typeof payload.rows)[number]; customFields: Record<string, unknown> }> = [];

	// Load custom field definitions once for the whole import — was N round-trips.
	const customDefs = await loadCustomFieldDefs(c.env);

	for (let index = 0; index < payload.rows.length; index += 1) {
		const row = payload.rows[index];
		if (!row.title) {
			skippedRows.push({ index, reason: 'title is required' });
			continue;
		}

		try {
			const customFields = validateCustomFieldsAgainst(customDefs, row.customFields);
			readyRows.push({ index, row, customFields });
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'custom field validation failed';
			skippedRows.push({ index, reason });
		}
	}

	if (readyRows.length === 0) {
		return c.json({
			dryRun: payload.dryRun,
			error: 'No valid rows to import.',
			skippedRows
		}, 400);
	}

	if (payload.dryRun) {
		return c.json({ dryRun: true, acceptedRows: readyRows.length, skippedRows });
	}

	let importedRows = 0;
	for (const item of readyRows) {
		const { index, customFields } = item;
		const row = normalizeBookData(item.row);
		try {
			const bookId = crypto.randomUUID();
			const importTagsJson = JSON.stringify(row.tags);
			const importCustomFieldsJson = JSON.stringify(customFields);
			const importFolds = computeBookFolds({
				title: row.title,
				author: row.author,
				isbn: row.isbn ?? null,
				publisher: row.publisher ?? null,
				description: row.description ?? null,
				tagsJson: importTagsJson,
				customFieldsJson: importCustomFieldsJson
			});
			await c.env.DB.prepare(
				`INSERT INTO books (
					id, title, author, isbn, publication_year, publisher, language, description,
					room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
					created_at, updated_at, deleted_at,
					title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
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
					importTagsJson,
					importCustomFieldsJson,
					row.status,
					now,
					now,
					importFolds.title_fold,
					importFolds.author_fold,
					importFolds.isbn_fold,
					importFolds.publisher_fold,
					importFolds.description_fold,
					importFolds.tags_fold,
					importFolds.custom_fields_fold
				)
				.run();

			await replaceBookAttributeValues(c.env, bookId, customFields);
			importedRows += 1;
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'insert failed';
			skippedRows.push({ index, reason });
		}
	}

	if (importedRows > 0) {
		await bumpBooksCacheVersion(c.env);
	}

	try {
		await insertAuditLog(c.env, c.get('user').sub, 'book.import', 'book', null, {
			rows: importedRows,
			skippedRows
		});
	} catch (error) {
		console.warn('Audit log failed for book.import, continuing', error);
	}

	return c.json({ importedRows, skippedRows }, 201);
});

app.get('/api/export/books.csv', requirePermission('export.csv', { librarian: true }), async (c) => {
	// Route the export through the same query path the list endpoint uses
	// so FTS5, fold-aware accent-insensitive matching, fuzzy mode, and every
	// `custom_*` filter all work consistently. The previous home-grown
	// `title LIKE ?` clause silently stripped `%` and `_` and missed any
	// accent-stripped search — exporting "γαβριήλ" wouldn't include rows
	// titled "Γαβριήλ".
	const query = BookFilterQuerySchema.parse(c.req.query());
	const customFilters = Object.entries(c.req.query())
		.filter(([key]) => key.startsWith('custom_'))
		.map(([key, value]) => ({ key: key.replace('custom_', ''), value }));

	// Walk the full result set page by page so we can stream an export of
	// arbitrary size without holding the whole table in memory or tripping
	// any single-query result cap. Using a generous pageSize keeps the
	// round-trip count low; the loop terminates as soon as we hit a short page.
	const PAGE_SIZE = 100;
	const aggregatedRows: Array<Record<string, unknown>> = [];
	for (let page = 1; ; page += 1) {
		const slice = await queryBooksWithFilters(c.env, {
			...query,
			customFilters,
			page,
			pageSize: PAGE_SIZE,
			includeDeleted: false
		});
		for (const row of slice.rows) aggregatedRows.push(row);
		if (slice.rows.length < PAGE_SIZE) break;
		// Safety stop so a malformed loop can't run forever. 200K rows is
		// well above the realistic library size; if anyone exports past
		// that, the result is still useful — just truncated with a header.
		if (aggregatedRows.length >= 200_000) break;
	}

	const exportRows = aggregatedRows.map((row) => {
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
	// Prepend a UTF-8 BOM so Excel (which otherwise assumes the legacy locale
	// codepage) renders Greek/Korean/Cyrillic titles correctly on double-click.
	return c.body('﻿' + csv);
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

app.post('/api/sync/push', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = SyncPushSchema.parse(await c.req.json());
	const actor = c.get('user');

	const results: Array<Record<string, unknown>> = [];

	for (const mutation of payload.mutations) {
		let status: 'success' | 'error' = 'success';
		let resultData: Record<string, unknown> = {};

		try {
			if (mutation.operation === 'create_book') {
				const row = normalizeBookData(CreateBookSchema.parse(mutation.payload));
				const customFields = await validateCustomFields(c.env, row.customFields);
				const now = nowIso();
				const id = crypto.randomUUID();
				const tagsJson = JSON.stringify(row.tags);
				const customFieldsJson = JSON.stringify(customFields);
				// Sync-pushed books need the same fold columns as direct creates,
				// otherwise the books_fts trigger indexes the unfolded raw text
				// (COALESCE falls through to the raw column) and accent-stripped
				// searches silently fail to match. Mirror the POST /api/books path.
				const folds = computeBookFolds({
					title: row.title,
					author: row.author,
					isbn: row.isbn ?? null,
					publisher: row.publisher ?? null,
					description: row.description ?? null,
					tagsJson,
					customFieldsJson
				});
				await c.env.DB.prepare(
					`INSERT INTO books (
						id, title, author, isbn, publication_year, publisher, language, description,
						room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
						created_at, updated_at, deleted_at,
						title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
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
						tagsJson,
						customFieldsJson,
						row.status,
						now,
						now,
						folds.title_fold,
						folds.author_fold,
						folds.isbn_fold,
						folds.publisher_fold,
						folds.description_fold,
						folds.tags_fold,
						folds.custom_fields_fold
					)
					.run();
				await replaceBookAttributeValues(c.env, id, customFields);
				resultData = { id };
			} else if (mutation.operation === 'delete_book') {
				const row = z.object({ id: z.string().min(1) }).parse(mutation.payload);
				const now = nowIso();
				// Don't strand an open loan (mirror the direct DELETE guard).
				const del = await c.env.DB.prepare(
					`UPDATE books SET deleted_at = ?, updated_at = ?, version = version + 1
					 WHERE id = ? AND deleted_at IS NULL
					   AND NOT EXISTS (SELECT 1 FROM borrow_transactions WHERE book_id = books.id AND returned_at IS NULL)`
				)
					.bind(now, now, row.id)
					.run();
				if ((del.meta?.changes ?? 0) === 0) {
					const openLoan = await c.env.DB.prepare(
						`SELECT 1 FROM borrow_transactions bt JOIN books b ON b.id = bt.book_id
						  WHERE bt.book_id = ? AND bt.returned_at IS NULL AND b.deleted_at IS NULL LIMIT 1`
					).bind(row.id).first();
					if (openLoan) {
						throw new HTTPException(409, { message: 'Cannot delete: the book is on loan. Return it first.' });
					}
				}
				resultData = { id: row.id };
			} else if (mutation.operation === 'update_book') {
				const row = z.object({ id: z.string().min(1), data: UpdateBookSchema }).parse(mutation.payload);
				const current = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').bind(row.id).first();
				if (!current) {
					throw new HTTPException(404, { message: 'Book not found' });
				}

				const incoming = normalizeBookData(UpdateBookSchema.parse(row.data));
				const currentVersion = Number((current as Record<string, unknown>).version ?? 0);
				if (incoming.version !== currentVersion) {
					throw new HTTPException(409, { message: 'Version conflict' });
				}
				// Same circulation invariant as the direct PUT: never let a generic
				// update move a book into or out of 'borrowed' (that desyncs the loan
				// row). Offline clients should use the borrow/return operations.
				const curStatus = String((current as Record<string, unknown>).status ?? 'available');
				if (incoming.status && incoming.status !== curStatus
					&& (incoming.status === 'borrowed' || curStatus === 'borrowed')) {
					throw new HTTPException(409, { message: 'Change loan status via the borrow/return actions.' });
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

				const mergedTagsJson = JSON.stringify(merged.tags);
				const mergedCustomFieldsJson = JSON.stringify(merged.customFields);
				// Same reason as create_book above — without writing the fold
				// columns, an edit via sync push would leave the fts trigger
				// indexing whatever fold was there before the edit (or the raw
				// values via COALESCE), making the updated row's accented text
				// silently unsearchable.
				const mergedFolds = computeBookFolds({
					title: (merged.title as string | null) ?? null,
					author: (merged.author as string | null) ?? null,
					isbn: (merged.isbn as string | null) ?? null,
					publisher: (merged.publisher as string | null) ?? null,
					description: (merged.description as string | null) ?? null,
					tagsJson: mergedTagsJson,
					customFieldsJson: mergedCustomFieldsJson
				});

				await c.env.DB.prepare(
					`UPDATE books SET
						 title = ?, author = ?, isbn = ?, publication_year = ?, publisher = ?, language = ?, description = ?,
						 room_code = ?, shelf_code = ?, acquisition_date = ?, tags = ?, custom_fields = ?, status = ?,
						 version = ?, updated_at = ?,
						 title_fold = ?, author_fold = ?, isbn_fold = ?, publisher_fold = ?, description_fold = ?, tags_fold = ?, custom_fields_fold = ?
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
						mergedTagsJson,
						mergedCustomFieldsJson,
						merged.status,
						merged.version,
						merged.updatedAt,
						mergedFolds.title_fold,
						mergedFolds.author_fold,
						mergedFolds.isbn_fold,
						mergedFolds.publisher_fold,
						mergedFolds.description_fold,
						mergedFolds.tags_fold,
						mergedFolds.custom_fields_fold,
						row.id
					)
					.run();

				await replaceBookAttributeValues(c.env, row.id, merged.customFields as Record<string, unknown>);
				resultData = { id: row.id, version: merged.version };
			} else if (mutation.operation === 'borrow_book') {
				// Lending is a 'circulation' action — enforce it here too, otherwise
				// /api/sync/push (gated only by the coarse books.write) would bypass
				// the circulation gate the direct borrow endpoint requires.
				if (!(await userHasPermission(c, 'circulation', { librarian: true }))) {
					throw new HTTPException(403, { message: 'Permission denied: circulation' });
				}
				const row = z.object({ id: z.string().min(1), data: BorrowBookSchema }).parse(mutation.payload);
				if (Date.parse(row.data.dueAt) <= Date.now()) {
					throw new HTTPException(400, { message: 'dueAt must be in the future.' });
				}
				const { borrowerId, borrowerName, borrowerContact } = await resolveBorrower(c.env, row.data);
				const txId = crypto.randomUUID();
				const now = nowIso();
				// Same atomic flip as the direct endpoint — prevents two queued
				// offline borrows on the same book from both succeeding.
				const flip = await c.env.DB.prepare(
					`UPDATE books SET status = 'borrowed', version = version + 1, updated_at = ?
					 WHERE id = ? AND deleted_at IS NULL AND status = 'available'`
				).bind(now, row.id).run();
				if ((flip.meta?.changes ?? 0) === 0) {
					throw new HTTPException(409, { message: 'Book is not available' });
				}
				try {
					await c.env.DB.prepare(
						`INSERT INTO borrow_transactions (
							 id, book_id, borrower_id, borrower_name, borrower_contact, borrowed_at, due_at, returned_at, notes, created_by, updated_at
						 ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
					)
						.bind(
							txId,
							row.id,
							borrowerId,
							borrowerName,
							borrowerContact,
							now,
							row.data.dueAt,
							row.data.notes ?? null,
							actor.sub,
							now
						)
						.run();
				} catch (err) {
					await c.env.DB.prepare(
						`UPDATE books SET status = 'available', updated_at = ? WHERE id = ? AND status = 'borrowed'`
					).bind(nowIso(), row.id).run();
					throw err;
				}

				resultData = { transactionId: txId, borrowerId };
			} else if (mutation.operation === 'return_book') {
				if (!(await userHasPermission(c, 'circulation', { librarian: true }))) {
					throw new HTTPException(403, { message: 'Permission denied: circulation' });
				}
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

	if (payload.mutations.length > 0) {
		await bumpBooksCacheVersion(c.env);
	}
	await insertAuditLog(c.env, actor.sub, 'sync.push', 'sync', null, {
		mutations: payload.mutations.length
	});

	return c.json({ results });
});

app.get('/api/books/duplicates', requirePermission('books.write', { librarian: true }), async (c) => {
	// Step 1: aggregate to find duplicate keys directly in SQL — never loads the full table.
	const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') ?? 50)));
	const offset = Math.max(0, Number(c.req.query('offset') ?? 0));

	// Canonical grouping keys: fold the legacy '(Unknown)'/'(Untitled)' sentinels
	// to '' so a re-catalogued blank-author book and its legacy '(Unknown)' twin
	// land in the SAME duplicate group. Must be identical in the GROUP BY, the
	// match predicates, and the details projection or the buckets won't line up.
	const TITLE_KEY = "CASE WHEN LOWER(TRIM(title)) = '(untitled)' THEN '' ELSE LOWER(TRIM(title)) END";
	const AUTHOR_KEY = "CASE WHEN LOWER(TRIM(author)) = '(unknown)' THEN '' ELSE LOWER(TRIM(author)) END";

	// Get the global count of duplicate groups in parallel with the paged
	// slice. The previous `total` was just the count of returned groups,
	// which made UI pagination misleading once more than `limit` groups
	// existed.
	const [groupsRes, totalRes] = await Promise.all([
		c.env.DB.prepare(
			`SELECT
				${TITLE_KEY} AS title_key,
				${AUTHOR_KEY} AS author_key,
				COUNT(*) AS dup_count
			 FROM books
			 WHERE deleted_at IS NULL
			 GROUP BY title_key, author_key
			 HAVING COUNT(*) > 1
			 ORDER BY dup_count DESC, title_key ASC
			 LIMIT ? OFFSET ?`
		).bind(limit, offset).all<{ title_key: string; author_key: string; dup_count: number }>(),
		c.env.DB.prepare(
			`SELECT COUNT(*) AS n FROM (
				SELECT 1 FROM books
				 WHERE deleted_at IS NULL
				 GROUP BY ${TITLE_KEY}, ${AUTHOR_KEY}
				HAVING COUNT(*) > 1
			)`
		).first<{ n: number }>()
	]);

	const totalGroups = Number(totalRes?.n ?? 0);
	const groups = groupsRes.results ?? [];
	if (groups.length === 0) {
		return c.json({ total: totalGroups, groups: [], page: { limit, offset } });
	}

	// Step 2: bulk-fetch only the rows in those duplicate buckets via OR predicates.
	const orClauses = groups
		.map(() => `(${TITLE_KEY} = ? AND ${AUTHOR_KEY} = ?)`)
		.join(' OR ');
	const params: unknown[] = [];
	for (const g of groups) {
		params.push(g.title_key, g.author_key);
	}

	const detailsRes = await c.env.DB.prepare(
		`SELECT id, title, author, isbn,
				${TITLE_KEY} AS title_key, ${AUTHOR_KEY} AS author_key
		 FROM books
		 WHERE deleted_at IS NULL AND (${orClauses})
		 ORDER BY title_key ASC, author_key ASC, id ASC`
	).bind(...params).all<{
		id: string;
		title: string;
		author: string;
		isbn: string | null;
		title_key: string;
		author_key: string;
	}>();

	const groupMap = new Map<string, Array<{ id: string; title: string; author: string; isbn: string | null }>>();
	for (const row of detailsRes.results ?? []) {
		const key = `${row.title_key}|||${row.author_key}`;
		const list = groupMap.get(key) ?? [];
		list.push({ id: row.id, title: row.title, author: row.author, isbn: row.isbn });
		groupMap.set(key, list);
	}

	const orderedGroups = groups
		.map((g) => groupMap.get(`${g.title_key}|||${g.author_key}`) ?? [])
		.filter((list) => list.length > 1);

	return c.json({ total: totalGroups, groups: orderedGroups, page: { limit, offset } });
});

// ─── Semantic search ─────────────────────────────────────────────────────
// Free-text → embedding → Vectorize ANN lookup → hydrate book rows.
// Falls back to a 503 when either binding is missing so the frontend can
// gracefully fall back to FTS without speculating about whether the feature
// is wired up.

app.get('/api/books/semantic', async (c) => {
	if (!semanticSearchEnabled(c.env)) {
		throw new HTTPException(503, { message: 'Semantic search is not enabled on this deployment.' });
	}
	const q = (c.req.query('q') ?? '').trim();
	if (!q) {
		return c.json({ items: [], total: 0, model: EMBEDDING_MODEL });
	}
	const topK = Math.max(1, Math.min(100, Number(c.req.query('topK') ?? 24)));

	const matches = await semanticSearchBookIds(c.env, q, topK);
	if (matches.length === 0) {
		return c.json({ items: [], total: 0, model: EMBEDDING_MODEL });
	}

	// Hydrate by id while preserving Vectorize's score order. The IN clause
	// is bounded by topK ≤ 100, well within D1 parameter limits.
	const placeholders = matches.map(() => '?').join(',');
	const rowsRes = await c.env.DB.prepare(
		`SELECT * FROM books WHERE id IN (${placeholders}) AND deleted_at IS NULL`
	).bind(...matches.map((m) => m.id)).all();
	const byId = new Map<string, Record<string, unknown>>();
	for (const row of rowsRes.results ?? []) {
		const r = row as Record<string, unknown>;
		const id = r.id as string;
		byId.set(id, parseBook(r));
	}

	const items = matches
		.map((m) => {
			const book = byId.get(m.id);
			return book ? { ...book, _score: m.score } : null;
		})
		.filter(Boolean);

	return c.json({ items, total: items.length, model: EMBEDDING_MODEL });
});

// Backfill / re-embed pass. Admin-only. Pages through books that either
// have no embedding yet OR were embedded with a different model than the
// one in code (allowing migration after EMBEDDING_MODEL changes). Designed
// to be re-runnable from the UI or a cron.
app.post('/api/admin/vectorize-backfill', requireRole(['admin']), async (c) => {
	if (!semanticSearchEnabled(c.env)) {
		throw new HTTPException(503, { message: 'Semantic search is not enabled on this deployment.' });
	}
	const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50)));

	// Books missing an embedding, or with a stale model identifier. We
	// LEFT JOIN so a brand-new install with an empty book_vectorized table
	// gets every book picked up on the first pass.
	const rowsRes = await c.env.DB.prepare(
		`SELECT b.id, b.title, b.author, b.description, b.publisher, b.language,
		        b.publication_year, b.tags, b.custom_fields
		   FROM books b
		   LEFT JOIN book_vectorized v ON v.book_id = b.id
		  WHERE b.deleted_at IS NULL
		    AND (v.book_id IS NULL OR v.model != ?)
		  ORDER BY b.updated_at DESC
		  LIMIT ?`
	).bind(EMBEDDING_MODEL, limit).all<{
		id: string; title: string | null; author: string | null;
		description: string | null; publisher: string | null; language: string | null;
		publication_year: number | null; tags: string | null; custom_fields: string | null;
	}>();

	let embedded = 0;
	let skipped = 0;
	for (const row of rowsRes.results ?? []) {
		try {
			await vectorizeBook(c.env, row.id, {
				title: row.title,
				author: row.author,
				description: row.description,
				publisher: row.publisher,
				language: row.language,
				publicationYear: row.publication_year,
				tags: safeJsonParse<string[]>(row.tags ?? '[]', []),
				customFields: safeJsonParse<Record<string, unknown>>(row.custom_fields ?? '{}', {})
			});
			embedded += 1;
		} catch (error) {
			console.warn('Backfill embed failed for book', row.id, error);
			skipped += 1;
		}
	}

	const remaining = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM books b
		   LEFT JOIN book_vectorized v ON v.book_id = b.id
		  WHERE b.deleted_at IS NULL AND (v.book_id IS NULL OR v.model != ?)`
	).bind(EMBEDDING_MODEL).first<{ n: number }>();

	await insertAuditLog(c.env, c.get('user').sub, 'admin.vectorize.backfill', 'system', null, {
		embedded, skipped, remaining: Number(remaining?.n ?? 0)
	});

	return c.json({
		embedded,
		skipped,
		remaining: Number(remaining?.n ?? 0),
		model: EMBEDDING_MODEL
	});
});

app.post('/api/admin/normalize-books', requirePermission('setup'), async (c) => {
	const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 500)));
	const offset = Math.max(0, Number(c.req.query('offset') ?? 0));

	const rows = await c.env.DB.prepare(
		`SELECT id, title, author, isbn, publisher, language, description,
		        room_code, shelf_code, acquisition_date, tags, custom_fields
		 FROM books WHERE deleted_at IS NULL ORDER BY id LIMIT ? OFFSET ?`
	).bind(limit, offset).all<Record<string, unknown>>();

	let updated = 0;
	const processed = rows.results?.length ?? 0;
	const now = nowIso();
	const updates: D1PreparedStatement[] = [];

	for (const row of rows.results ?? []) {
		const original = {
			title: (row.title as string) ?? '',
			author: (row.author as string) ?? '',
			isbn: row.isbn as string | null,
			publisher: row.publisher as string | null,
			language: row.language as string | null,
			description: row.description as string | null,
			roomCode: row.room_code as string | null,
			shelfCode: row.shelf_code as string | null,
			acquisitionDate: row.acquisition_date as string | null,
			tags: safeJsonParse<string[]>((row.tags as string) ?? '[]', []),
			customFields: safeJsonParse<Record<string, unknown>>((row.custom_fields as string) ?? '{}', {})
		};

		const n = normalizeBookData(original);

		const changed =
			n.title !== original.title ||
			n.author !== original.author ||
			n.isbn !== original.isbn ||
			n.publisher !== original.publisher ||
			n.language !== original.language ||
			n.description !== original.description ||
			n.roomCode !== original.roomCode ||
			n.shelfCode !== original.shelfCode ||
			n.acquisitionDate !== original.acquisitionDate ||
			JSON.stringify(n.tags) !== JSON.stringify(original.tags) ||
			JSON.stringify(n.customFields) !== JSON.stringify(original.customFields);

		if (!changed) continue;

		const tagsJson = JSON.stringify(n.tags);
		const customFieldsJson = JSON.stringify(n.customFields);
		// Recompute diacritic folds in lock-step with the normalized text so the
		// books_fts trigger doesn't re-index against the pre-normalization values.
		const folds = computeBookFolds({
			title: n.title,
			author: n.author,
			isbn: n.isbn ?? null,
			publisher: n.publisher ?? null,
			description: n.description ?? null,
			tagsJson,
			customFieldsJson
		});

		updates.push(
			c.env.DB.prepare(
				`UPDATE books SET
				   title=?, author=?, isbn=?, publisher=?, language=?, description=?,
				   room_code=?, shelf_code=?, acquisition_date=?, tags=?, custom_fields=?,
				   updated_at=?, version=version+1,
				   title_fold=?, author_fold=?, isbn_fold=?, publisher_fold=?,
				   description_fold=?, tags_fold=?, custom_fields_fold=?
				 WHERE id=?`
			).bind(
				n.title, n.author, n.isbn ?? null, n.publisher ?? null, n.language ?? null, n.description ?? null,
				n.roomCode ?? null, n.shelfCode ?? null, n.acquisitionDate ?? null,
				tagsJson, customFieldsJson, now,
				folds.title_fold, folds.author_fold, folds.isbn_fold, folds.publisher_fold,
				folds.description_fold, folds.tags_fold, folds.custom_fields_fold,
				row.id as string
			)
		);

		updated++;
	}

	// D1 batch caps at 50 statements per call.
	const BATCH_SIZE = 50;
	for (let i = 0; i < updates.length; i += BATCH_SIZE) {
		await c.env.DB.batch(updates.slice(i, i + BATCH_SIZE));
	}

	if (updated > 0) {
		await bumpBooksCacheVersion(c.env);
	}

	const countResult = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').first<{ n: number }>();
	const totalBooks = countResult?.n ?? 0;

	await insertAuditLog(c.env, c.get('user').sub, 'admin.normalizeBooks', 'book', null, {
		processed, updated, offset, limit
	});

	return c.json({ processed, updated, unchanged: processed - updated, offset, nextOffset: offset + processed, totalBooks });
});

// ─── Rebuild the full-text search index ───────────────────────────────────────
// `books_fts` is a contentless FTS5 table kept in sync by triggers that read the
// pre-folded `*_fold` columns (see migration 0012). If those folds ever drift
// from the raw text — e.g. a catalog re-import or normalize pass that predates
// the fold-write fix — accent-insensitive (Greek) search silently misses rows.
//
// This endpoint recomputes every non-deleted book's folds from its CURRENT raw
// columns and writes them back. The UPDATE fires `books_fts_au`, which deletes
// the stale FTS entry (keyed by the old folds, which still match what's indexed)
// and re-inserts the corrected one — so the index is rebuilt as a side effect,
// and the underlying fold data is healed too. Only fold columns are touched, so
// `version`/`updated_at` are left alone (this is derived data, not a content
// edit — no mobile re-sync churn).
//
// Paginated (limit/offset) so large libraries can be rebuilt in chunks within
// Worker CPU/D1 limits; loop with `nextOffset` until `done`. By default only
// rows whose folds actually changed are rewritten; pass `?force=1` to re-emit
// every row (a true FTS rebuild, useful if the index itself is suspected out of
// sync even when the folds happen to match).
app.post('/api/admin/rebuild-search-index', requirePermission('setup'), async (c) => {
	const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 500)));
	const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
	const force = c.req.query('force') === '1' || c.req.query('force') === 'true';

	const rows = await c.env.DB.prepare(
		`SELECT id, title, author, isbn, publisher, description, tags, custom_fields,
		        title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold
		 FROM books WHERE deleted_at IS NULL ORDER BY id LIMIT ? OFFSET ?`
	).bind(limit, offset).all<Record<string, unknown>>();

	const processed = rows.results?.length ?? 0;
	let rebuilt = 0;
	const updates: D1PreparedStatement[] = [];

	for (const row of rows.results ?? []) {
		const folds = computeBookFolds({
			title: (row.title as string) ?? null,
			author: (row.author as string) ?? null,
			isbn: (row.isbn as string) ?? null,
			publisher: (row.publisher as string) ?? null,
			description: (row.description as string) ?? null,
			tagsJson: (row.tags as string) ?? null,
			customFieldsJson: (row.custom_fields as string) ?? null
		});

		const changed =
			folds.title_fold !== ((row.title_fold as string | null) ?? null) ||
			folds.author_fold !== ((row.author_fold as string | null) ?? null) ||
			folds.isbn_fold !== ((row.isbn_fold as string | null) ?? null) ||
			folds.publisher_fold !== ((row.publisher_fold as string | null) ?? null) ||
			folds.description_fold !== ((row.description_fold as string | null) ?? null) ||
			folds.tags_fold !== ((row.tags_fold as string | null) ?? null) ||
			folds.custom_fields_fold !== ((row.custom_fields_fold as string | null) ?? null);

		if (!force && !changed) continue;

		updates.push(
			c.env.DB.prepare(
				`UPDATE books SET
				   title_fold=?, author_fold=?, isbn_fold=?, publisher_fold=?,
				   description_fold=?, tags_fold=?, custom_fields_fold=?
				 WHERE id=?`
			).bind(
				folds.title_fold, folds.author_fold, folds.isbn_fold, folds.publisher_fold,
				folds.description_fold, folds.tags_fold, folds.custom_fields_fold,
				row.id as string
			)
		);

		rebuilt++;
	}

	// D1 batch caps at 50 statements per call.
	const BATCH_SIZE = 50;
	for (let i = 0; i < updates.length; i += BATCH_SIZE) {
		await c.env.DB.batch(updates.slice(i, i + BATCH_SIZE));
	}

	if (rebuilt > 0) {
		await bumpBooksCacheVersion(c.env);
	}

	const countResult = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').first<{ n: number }>();
	const totalBooks = countResult?.n ?? 0;
	const nextOffset = offset + processed;
	const done = nextOffset >= totalBooks;

	await insertAuditLog(c.env, c.get('user').sub, 'admin.rebuildSearchIndex', 'book', null, {
		processed, rebuilt, offset, limit, force
	});

	return c.json({
		processed,
		rebuilt,
		unchanged: processed - rebuilt,
		offset,
		nextOffset: done ? null : nextOffset,
		totalBooks,
		done
	});
});

// Category browser: aggregates books by their `category_code` custom field.
// Cached for 60 s in KV so a 12K-book sidebar loads instantly. Cache keys are
// invalidated on book writes via the same version mechanism the list query uses.
app.get('/api/categories', async (c) => {
	const cacheVersion = await getBooksCacheVersion(c.env);
	const cacheKey = `categories:${cacheVersion}`;
	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) return c.json(cached);
		} catch (error) {
			console.warn('Categories cache read failed', error);
		}
	}

	const rows = await c.env.DB.prepare(
		`SELECT
			json_extract(custom_fields, '$.category_code') AS code,
			MAX(json_extract(custom_fields, '$.category_label')) AS label,
			COUNT(*) AS count
		 FROM books
		 WHERE deleted_at IS NULL
			 AND json_extract(custom_fields, '$.category_code') IS NOT NULL
			 AND json_extract(custom_fields, '$.category_code') != ''
		 GROUP BY code
		 ORDER BY count DESC, code ASC
		 LIMIT 500`
	).all<{ code: string | null; label: string | null; count: number }>();

	const items = (rows.results ?? []).map((r) => ({
		code: r.code ?? '',
		label: r.label,
		count: Number(r.count ?? 0)
	}));

	const response = { items };
	if (c.env.CACHE) {
		try {
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 });
		} catch (error) {
			console.warn('Categories cache write failed', error);
		}
	}
	return c.json(response);
});

// Aggregated stats for the Dashboard. Single endpoint that returns all the
// numbers the dashboard needs in one round-trip. KV-cached for 60s; the cache
// version key is shared with the books list, so book writes invalidate this too.
app.get('/api/stats', async (c) => {
	const cacheVersion = await getBooksCacheVersion(c.env);
	const cacheKey = `stats:${cacheVersion}`;
	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) return c.json(cached);
		} catch (error) {
			console.warn('Stats cache read failed', error);
		}
	}

	const [statusRows, langRows, yearRows, completenessRow, recentRows, topShelvesRows] = await Promise.all([
		c.env.DB.prepare(
			`SELECT status, COUNT(*) AS count FROM books WHERE deleted_at IS NULL GROUP BY status`
		).all<{ status: string; count: number }>(),
		c.env.DB.prepare(
			`SELECT language, COUNT(*) AS count FROM books
			 WHERE deleted_at IS NULL AND language IS NOT NULL AND language != ''
			 GROUP BY language ORDER BY count DESC LIMIT 12`
		).all<{ language: string; count: number }>(),
		c.env.DB.prepare(
			`SELECT
				CASE
					WHEN publication_year IS NULL THEN 'Unknown'
					WHEN publication_year < 1900 THEN 'Pre-1900'
					WHEN publication_year < 1950 THEN '1900–49'
					WHEN publication_year < 1980 THEN '1950–79'
					WHEN publication_year < 2000 THEN '1980–99'
					WHEN publication_year < 2010 THEN '2000–09'
					WHEN publication_year < 2020 THEN '2010–19'
					ELSE '2020+'
				END AS bucket,
				COUNT(*) AS count
			 FROM books WHERE deleted_at IS NULL
			 GROUP BY bucket
			 ORDER BY MIN(COALESCE(publication_year, 9999))`
		).all<{ bucket: string; count: number }>(),
		c.env.DB.prepare(
			`SELECT
				COUNT(*) AS total,
				SUM(CASE WHEN isbn IS NOT NULL AND TRIM(isbn) != '' THEN 1 ELSE 0 END) AS with_isbn,
				SUM(CASE WHEN shelf_code IS NOT NULL AND TRIM(shelf_code) != '' THEN 1 ELSE 0 END) AS with_shelf,
				SUM(CASE WHEN publisher IS NOT NULL AND TRIM(publisher) != '' THEN 1 ELSE 0 END) AS with_publisher,
				SUM(CASE WHEN publication_year IS NOT NULL THEN 1 ELSE 0 END) AS with_year,
				SUM(CASE WHEN title = '(Untitled)' OR title IS NULL OR TRIM(title) = '' THEN 1 ELSE 0 END) AS untitled,
				SUM(CASE WHEN author = '(Unknown)' OR author IS NULL OR TRIM(author) = '' THEN 1 ELSE 0 END) AS unknown_author
			 FROM books WHERE deleted_at IS NULL`
		).first<{
			total: number; with_isbn: number; with_shelf: number; with_publisher: number;
			with_year: number; untitled: number; unknown_author: number;
		}>(),
		c.env.DB.prepare(
			`SELECT id, title, author, legacy_id, updated_at
			 FROM books WHERE deleted_at IS NULL
			 ORDER BY updated_at DESC LIMIT 8`
		).all<{ id: string; title: string; author: string; legacy_id: string | null; updated_at: string }>(),
		c.env.DB.prepare(
			`SELECT shelf_code, COUNT(*) AS count FROM books
			 WHERE deleted_at IS NULL AND shelf_code IS NOT NULL AND TRIM(shelf_code) != ''
			 GROUP BY shelf_code ORDER BY count DESC LIMIT 10`
		).all<{ shelf_code: string; count: number }>()
	]);

	const response = {
		byStatus: statusRows.results ?? [],
		byLanguage: (langRows.results ?? []).map((r) => ({ language: r.language, count: Number(r.count) })),
		byYear: (yearRows.results ?? []).map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
		completeness: {
			total: Number(completenessRow?.total ?? 0),
			withIsbn: Number(completenessRow?.with_isbn ?? 0),
			withShelf: Number(completenessRow?.with_shelf ?? 0),
			withPublisher: Number(completenessRow?.with_publisher ?? 0),
			withYear: Number(completenessRow?.with_year ?? 0),
			untitled: Number(completenessRow?.untitled ?? 0),
			unknownAuthor: Number(completenessRow?.unknown_author ?? 0)
		},
		recentlyUpdated: (recentRows.results ?? []).map((r) => ({
			id: r.id,
			title: r.title,
			author: r.author,
			legacyId: r.legacy_id,
			updatedAt: r.updated_at
		})),
		topShelves: (topShelvesRows.results ?? []).map((r) => ({ shelfCode: r.shelf_code, count: Number(r.count) }))
	};

	if (c.env.CACHE) {
		try {
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 });
		} catch (error) {
			console.warn('Stats cache write failed', error);
		}
	}
	return c.json(response);
});

app.get('/api/needs-review-count', async (c) => {
	const result = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM books
		 WHERE deleted_at IS NULL
		   AND json_extract(custom_fields, '$.needs_review') = 1`
	).first<{ n: number }>();
	return c.json({ count: Number(result?.n ?? 0) });
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

// ─── User management (admin-only) ─────────────────────────────────────────────
const RoleSchema = z.enum(['admin', 'librarian', 'viewer']);
const CreateUserSchema = z.object({
	username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Username may use letters, numbers, dot, underscore, dash'),
	password: z.string().min(8).max(200),
	role: RoleSchema,
	active: z.boolean().optional()
});
const UpdateUserSchema = z.object({
	role: RoleSchema.optional(),
	active: z.boolean().optional(),
	password: z.string().min(8).max(200).optional()
});

app.get('/api/users', requireRole(['admin']), async (c) => {
	// Only surface active accounts. DELETE is a soft-delete (audit FKs prevent
	// hard removal), so deactivated users would otherwise linger in the UI.
	const rows = await c.env.DB.prepare(
		`SELECT id, username, role, active, created_at, updated_at
		 FROM staff_users WHERE active = 1 ORDER BY username ASC`
	).all();
	return c.json({ items: rows.results ?? [] });
});

app.post('/api/users', requireRole(['admin']), async (c) => {
	const body = await c.req.json();
	const parsed = CreateUserSchema.parse(body);

	const existing = await c.env.DB.prepare(
		'SELECT id, active FROM staff_users WHERE username = ? LIMIT 1'
	)
		.bind(parsed.username)
		.first<{ id: string; active: number }>();
	if (existing && existing.active === 1) {
		throw new HTTPException(409, { message: 'A user with this username already exists.' });
	}

	const salt = generateSaltHex();
	const iterations = defaultPbkdf2Iterations();
	const passwordHash = await hashPasswordPbkdf2(parsed.password, salt, iterations);
	const ts = nowIso();
	const active = parsed.active === false ? 0 : 1;

	let id: string;
	if (existing) {
		// Reactivate the previously soft-deleted row instead of inserting a new
		// one — the username is still bound to that id and audit history points
		// to it.
		id = existing.id;
		await c.env.DB.prepare(
			`UPDATE staff_users
			   SET role = ?, password_hash = ?, password_salt = ?, password_iterations = ?,
			       active = ?, updated_at = ?
			 WHERE id = ?`
		)
			.bind(parsed.role, passwordHash, salt, iterations, active, ts, id)
			.run();
	} else {
		id = crypto.randomUUID();
		await c.env.DB.prepare(
			`INSERT INTO staff_users (id, username, role, password_hash, password_salt, password_iterations, active, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(id, parsed.username, parsed.role, passwordHash, salt, iterations, active, ts, ts)
			.run();
	}

	const actor = c.get('user');
	await insertAuditLog(c.env, actor.sub, existing ? 'user.reactivate' : 'user.create', 'staff_user', id, {
		username: parsed.username,
		role: parsed.role,
		active: Boolean(active)
	});

	return c.json({
		user: {
			id,
			username: parsed.username,
			role: parsed.role,
			active: Boolean(active),
			created_at: ts,
			updated_at: ts
		}
	}, 201);
});

app.put('/api/users/:id', requireRole(['admin']), async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing user id' });
	}
	const body = await c.req.json();
	const parsed = UpdateUserSchema.parse(body);

	const existing = await c.env.DB.prepare(
		'SELECT id, username, role, active FROM staff_users WHERE id = ? LIMIT 1'
	)
		.bind(id)
		.first<{ id: string; username: string; role: 'admin' | 'librarian' | 'viewer'; active: number }>();
	if (!existing) {
		throw new HTTPException(404, { message: 'User not found' });
	}

	const actor = c.get('user');
	// Guard against an admin demoting or deactivating themselves and locking
	// the system out of admin access entirely.
	if (existing.id === actor.sub) {
		if (parsed.role && parsed.role !== 'admin') {
			throw new HTTPException(400, { message: 'You cannot change your own role.' });
		}
		if (parsed.active === false) {
			throw new HTTPException(400, { message: 'You cannot deactivate yourself.' });
		}
	}

	// Don't allow demoting / deactivating the last active admin.
	if ((parsed.role && parsed.role !== 'admin' && existing.role === 'admin') ||
		(parsed.active === false && existing.role === 'admin')) {
		const otherAdmins = await c.env.DB.prepare(
			"SELECT COUNT(*) AS n FROM staff_users WHERE role = 'admin' AND active = 1 AND id != ?"
		).bind(id).first<{ n: number }>();
		if (!otherAdmins || otherAdmins.n === 0) {
			throw new HTTPException(400, { message: 'Cannot remove the last active admin.' });
		}
	}

	const updates: string[] = [];
	const binds: Array<string | number> = [];

	if (parsed.role) {
		updates.push('role = ?');
		binds.push(parsed.role);
	}
	if (typeof parsed.active === 'boolean') {
		updates.push('active = ?');
		binds.push(parsed.active ? 1 : 0);
	}
	if (parsed.password) {
		const salt = generateSaltHex();
		const iterations = defaultPbkdf2Iterations();
		const passwordHash = await hashPasswordPbkdf2(parsed.password, salt, iterations);
		updates.push('password_hash = ?', 'password_salt = ?', 'password_iterations = ?');
		binds.push(passwordHash, salt, iterations);
	}

	if (updates.length === 0) {
		throw new HTTPException(400, { message: 'No fields to update.' });
	}

	updates.push('updated_at = ?');
	binds.push(nowIso());
	binds.push(id);

	await c.env.DB.prepare(`UPDATE staff_users SET ${updates.join(', ')} WHERE id = ?`)
		.bind(...binds)
		.run();

	await insertAuditLog(c.env, actor.sub, 'user.update', 'staff_user', id, {
		role: parsed.role,
		active: parsed.active,
		passwordChanged: Boolean(parsed.password)
	});

	const updated = await c.env.DB.prepare(
		'SELECT id, username, role, active, created_at, updated_at FROM staff_users WHERE id = ?'
	).bind(id).first();

	return c.json({ user: updated });
});

app.delete('/api/users/:id', requireRole(['admin']), async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing user id' });
	}
	const existing = await c.env.DB.prepare(
		'SELECT id, username, role FROM staff_users WHERE id = ? LIMIT 1'
	)
		.bind(id)
		.first<{ id: string; username: string; role: 'admin' | 'librarian' | 'viewer' }>();
	if (!existing) {
		throw new HTTPException(404, { message: 'User not found' });
	}

	const actor = c.get('user');
	if (existing.id === actor.sub) {
		throw new HTTPException(400, { message: 'You cannot delete your own account.' });
	}

	if (existing.role === 'admin') {
		const otherAdmins = await c.env.DB.prepare(
			"SELECT COUNT(*) AS n FROM staff_users WHERE role = 'admin' AND active = 1 AND id != ?"
		).bind(id).first<{ n: number }>();
		if (!otherAdmins || otherAdmins.n === 0) {
			throw new HTTPException(400, { message: 'Cannot delete the last active admin.' });
		}
	}

	// Try hard-delete first; if FK references in audit_logs / code_assignments
	// block it, fall back to soft-delete (deactivate) so audit history stays
	// intact. This mirrors the user's preferred "adaptive" behaviour.
	let soft = false;
	try {
		await c.env.DB.prepare('DELETE FROM staff_users WHERE id = ?').bind(id).run();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// D1 surfaces FK violations as SQLITE_CONSTRAINT errors. Anything else
		// is a real failure and should propagate.
		if (!/FOREIGN KEY|constraint/i.test(message)) {
			throw err;
		}
		soft = true;
		await c.env.DB.prepare(
			"UPDATE staff_users SET active = 0, updated_at = ? WHERE id = ?"
		).bind(nowIso(), id).run();
	}

	await insertAuditLog(c.env, actor.sub, 'user.delete', 'staff_user', id, {
		username: existing.username,
		role: existing.role,
		soft
	});

	return c.json({ ok: true, soft });
});

// ─── Role permissions (admin-only) ────────────────────────────────────────────
// Catalogue of permissions the admin can toggle per role. Keep in sync with
// the frontend `PERMISSION_CATALOG` and with the seed in migration 0007.
// Admins always have every permission (not configurable).
const PERMISSION_KEYS = [
	'books.write',
	'books.delete',
	'rooms.write',
	'rooms.delete',
	'customFields.manage',
	'labels.print',
	'export.csv',
	'import',
	'setup',
	'circulation',
	'dashboard',
	'settings'
] as const;
type PermissionKey = typeof PERMISSION_KEYS[number];
const PERMISSION_KEY_SET = new Set<string>(PERMISSION_KEYS);

// Defaults applied when a row is missing from the table (also used by
// `requirePermission` middleware as the fallback).
const DEFAULT_PERMS: Record<'librarian' | 'viewer', Record<PermissionKey, boolean>> = {
	librarian: {
		'books.write': true,
		'books.delete': false,
		'rooms.write': true,
		'rooms.delete': false,
		'customFields.manage': true,
		'labels.print': true,
		'export.csv': true,
		'import': false,
		'setup': false,
		'circulation': true,
		'dashboard': true,
		'settings': true
	},
	viewer: {
		'books.write': false,
		'books.delete': false,
		'rooms.write': false,
		'rooms.delete': false,
		'customFields.manage': false,
		'labels.print': false,
		'export.csv': false,
		'import': false,
		'setup': false,
		'circulation': false,
		'dashboard': false,
		'settings': false
	}
};

async function loadPermissionMatrix(env: Env): Promise<Record<'admin' | 'librarian' | 'viewer', Record<PermissionKey, boolean>>> {
	const rows = await env.DB.prepare(
		'SELECT role, permission, allowed FROM role_permissions'
	).all<{ role: 'admin' | 'librarian' | 'viewer'; permission: string; allowed: number }>();
	const matrix: Record<'admin' | 'librarian' | 'viewer', Record<PermissionKey, boolean>> = {
		admin: Object.fromEntries(PERMISSION_KEYS.map((p) => [p, true])) as Record<PermissionKey, boolean>,
		librarian: { ...DEFAULT_PERMS.librarian },
		viewer: { ...DEFAULT_PERMS.viewer }
	};
	for (const row of rows.results ?? []) {
		if (row.role === 'admin') continue; // admins are immutable
		if (!PERMISSION_KEY_SET.has(row.permission)) continue;
		matrix[row.role][row.permission as PermissionKey] = row.allowed === 1;
	}
	return matrix;
}

app.get('/api/role-permissions', requireRole(['admin']), async (c) => {
	const matrix = await loadPermissionMatrix(c.env);
	return c.json({ catalog: PERMISSION_KEYS, matrix });
});

const UpdatePermissionsSchema = z.object({
	matrix: z.object({
		librarian: z.record(z.string(), z.boolean()),
		viewer: z.record(z.string(), z.boolean())
	})
});

app.put('/api/role-permissions', requireRole(['admin']), async (c) => {
	const body = await c.req.json();
	const parsed = UpdatePermissionsSchema.parse(body);
	const ts = nowIso();

	const stmts: D1PreparedStatement[] = [];
	for (const role of ['librarian', 'viewer'] as const) {
		const desired = parsed.matrix[role];
		for (const perm of PERMISSION_KEYS) {
			const allowed = desired[perm] === true ? 1 : 0;
			stmts.push(
				c.env.DB.prepare(
					`INSERT INTO role_permissions (role, permission, allowed, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(role, permission) DO UPDATE
					   SET allowed = excluded.allowed, updated_at = excluded.updated_at`
				).bind(role, perm, allowed, ts)
			);
		}
	}
	await c.env.DB.batch(stmts);

	const actor = c.get('user');
	await insertAuditLog(c.env, actor.sub, 'role_permissions.update', 'role_permissions', null, {
		matrix: parsed.matrix
	});

	const matrix = await loadPermissionMatrix(c.env);
	return c.json({ catalog: PERMISSION_KEYS, matrix });
});

// Lightweight read endpoint for ALL authenticated users — returns the
// effective matrix so the frontend can gate UI without leaking the catalogue.
// Admins also use this; they always see all `true`s.
app.get('/api/me/permissions', async (c) => {
	const matrix = await loadPermissionMatrix(c.env);
	const user = c.get('user');
	return c.json({ catalog: PERMISSION_KEYS, permissions: matrix[user.role] });
});

// ─── Library catalogue (LIBRARY_normalized.xlsx) — first-class support ────────
// The xlsx ships with snake_case columns (id, title, authors, publisher,
// place_of_publication, …). The two endpoints below let an admin (1) seed the
// custom-field definitions that match the catalogue's columns and (2) import
// the rows idempotently — re-running the same xlsx updates existing books in
// place via the legacy_id key, instead of creating duplicates.

const CATALOG_CUSTOM_FIELDS: Array<{
	key: string;
	label: string;
	type: 'text' | 'number' | 'boolean' | 'date';
}> = [
	{ key: 'series', label: 'Series', type: 'text' },
	{ key: 'volume_label', label: 'Volume Label', type: 'text' },
	{ key: 'volume_num', label: 'Volume Number', type: 'text' },
	{ key: 'editor', label: 'Editor', type: 'text' },
	{ key: 'translator', label: 'Translator', type: 'text' },
	{ key: 'place_of_publication', label: 'Place of Publication', type: 'text' },
	{ key: 'edition', label: 'Edition', type: 'text' },
	{ key: 'category_code', label: 'Category Code', type: 'text' },
	{ key: 'category_label', label: 'Category Label', type: 'text' },
	{ key: 'cover_type', label: 'Cover Type', type: 'text' },
	{ key: 'pages', label: 'Pages', type: 'number' },
	{ key: 'condition', label: 'Condition', type: 'text' },
	{ key: 'isbn_10', label: 'ISBN-10', type: 'text' },
	{ key: 'issn', label: 'ISSN', type: 'text' },
	{ key: 'additional_isbns', label: 'Additional ISBNs', type: 'text' },
	{ key: 'has_illustrations', label: 'Has Illustrations', type: 'boolean' },
	{ key: 'illustration_type', label: 'Illustration Type', type: 'text' },
	{ key: 'signed_copy', label: 'Signed Copy', type: 'boolean' },
	{ key: 'signature_notes', label: 'Signature Notes', type: 'text' },
	{ key: 'copies_count', label: 'Copies Count', type: 'number' },
	{ key: 'source_sheet', label: 'Source Sheet', type: 'text' },
	{ key: 'original_id', label: 'Original ID', type: 'text' },
	{ key: 'transformations_applied', label: 'Transformations Applied', type: 'text' },
	{ key: 'cleanup_notes', label: 'Cleanup Notes', type: 'text' },
	{ key: 'needs_review', label: 'Needs Review', type: 'boolean' }
];

app.post('/api/setup/library-catalog', requirePermission('setup'), async (c) => {
	const now = nowIso();
	let created = 0;
	let updated = 0;

	for (const field of CATALOG_CUSTOM_FIELDS) {
		const existing = await c.env.DB.prepare(
			'SELECT id FROM custom_field_definitions WHERE field_key = ? LIMIT 1'
		)
			.bind(field.key)
			.first<{ id: string } | null>();

		if (existing) {
			await c.env.DB.prepare(
				`UPDATE custom_field_definitions
				   SET label = ?, field_type = ?, required = 0, enum_options = '[]',
				       updated_at = ?, deleted_at = NULL
				 WHERE id = ?`
			)
				.bind(field.label, field.type, now, existing.id)
				.run();
			updated += 1;
		} else {
			await c.env.DB.prepare(
				`INSERT INTO custom_field_definitions
					(id, field_key, label, field_type, required, enum_options, created_at, updated_at, deleted_at)
				 VALUES (?, ?, ?, ?, 0, '[]', ?, ?, NULL)`
			)
				.bind(crypto.randomUUID(), field.key, field.label, field.type, now, now)
				.run();
			created += 1;
		}
	}

	await insertAuditLog(c.env, c.get('user').sub, 'setup.libraryCatalog', 'custom_field', null, {
		created,
		updated
	});

	return c.json({ ok: true, created, updated, total: CATALOG_CUSTOM_FIELDS.length });
});

app.post('/api/import/books-catalog', requirePermission('import'), async (c) => {
	let rawPayload: unknown;
	try {
		rawPayload = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON payload.' }, 400);
	}

	const parsed = ImportCatalogSchema.safeParse(rawPayload);
	if (!parsed.success) {
		return c.json(
			{ error: 'Invalid catalog import payload.', details: parsed.error.issues.slice(0, 20) },
			400
		);
	}

	const payload = parsed.data;
	const now = nowIso();

	// Load custom field defs once (was N round-trips when validating per row).
	const defs = await loadCustomFieldDefs(c.env);

	type Prepared = {
		legacyId: string | null;
		title: string;
		author: string;
		isbn: string | null;
		publicationYear: number | null;
		publisher: string | null;
		language: string | null;
		description: string | null;
		shelfCode: string | null;
		customFields: Record<string, unknown>;
	};

	const prepared: Prepared[] = [];
	const skippedRows: Array<{ index: number; reason: string }> = [];

	for (let index = 0; index < payload.rows.length; index += 1) {
		const row = payload.rows[index];
		try {
			const cf = { ...row.customFields };
			if (row.needsReview && !('needs_review' in cf)) {
				cf.needs_review = true;
			}
			const validated = validateCustomFieldsAgainst(defs, cf, { requireAllRequired: false });

			const normalized = normalizeBookData({
				title: row.title ?? null,
				author: row.author ?? null,
				isbn: row.isbn ?? null,
				publisher: row.publisher ?? null,
				language: row.language ?? null,
				description: row.description ?? null,
				shelfCode: row.shelfCode ?? null,
				customFields: validated
			});

			prepared.push({
				legacyId: row.legacyId ? row.legacyId.trim() : null,
				// Blank title/author are stored as the empty string (the canonical
				// "no value" form — see normalizeBookData). The NOT NULL columns are
				// satisfied and the UI renders '' as a localized placeholder; we no
				// longer mint the raw English '(Untitled)'/'(Unknown)' sentinels.
				title: normalized.title ?? '',
				author: normalized.author ?? '',
				isbn: normalized.isbn ?? null,
				publicationYear: row.publicationYear ?? null,
				publisher: normalized.publisher ?? null,
				language: normalized.language ?? null,
				description: normalized.description ?? null,
				shelfCode: normalized.shelfCode ?? null,
				customFields: normalized.customFields ?? {}
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'validation failed';
			skippedRows.push({ index, reason });
		}
	}

	if (payload.dryRun) {
		// Quickly count which prepared rows would update vs. insert by checking legacy_id existence.
		let willUpdate = 0;
		let willInsert = 0;
		for (const p of prepared) {
			if (!p.legacyId) {
				willInsert += 1;
				continue;
			}
			const hit = await c.env.DB.prepare('SELECT id FROM books WHERE legacy_id = ? LIMIT 1')
				.bind(p.legacyId)
				.first<{ id: string } | null>();
			if (hit) willUpdate += 1;
			else willInsert += 1;
		}
		return c.json({
			dryRun: true,
			acceptedRows: prepared.length,
			willInsert,
			willUpdate,
			skippedRows
		});
	}

	let inserted = 0;
	let updated = 0;
	let skippedTrashed = 0;
	let attributeFailures = 0;

	for (const p of prepared) {
		const tags = '[]';
		try {
			let bookId: string;
			let didUpdate = false;
			// Fetch deleted_at + existing custom_fields so we can (a) refuse to
			// resurrect a soft-deleted book and (b) merge rather than clobber the
			// librarian's manually-entered custom fields on re-import.
			let existingRow: { id: string; deleted_at: string | null; custom_fields: string | null } | null = null;

			if (p.legacyId) {
				existingRow = await c.env.DB.prepare(
					'SELECT id, deleted_at, custom_fields FROM books WHERE legacy_id = ? LIMIT 1'
				)
					.bind(p.legacyId)
					.first<{ id: string; deleted_at: string | null; custom_fields: string | null } | null>();
			}

			// The book to write into custom_fields / attribute values. For an
			// UPDATE this is the merge below; for an INSERT it's the source row.
			let effectiveCf: Record<string, unknown> = p.customFields;

			if (existingRow) {
				// A librarian deliberately trashed this book; a source re-import must
				// not silently bring it back. Leave it in the trash untouched.
				if (existingRow.deleted_at) {
					skippedTrashed += 1;
					continue;
				}

				bookId = existingRow.id;
				// Merge custom fields: preserve keys the librarian added that aren't
				// in the source sheet; source values win for overlapping keys. Never
				// re-raise needs_review on an existing book (the reviewer may have
				// cleared it) — only a fresh insert carries the source flag.
				const existingCf = safeJsonParse<Record<string, unknown>>(existingRow.custom_fields ?? '{}', {});
				const sourceCf = { ...p.customFields };
				delete (sourceCf as Record<string, unknown>).needs_review;
				effectiveCf = { ...existingCf, ...sourceCf };
				const mergedCustomJson = JSON.stringify(effectiveCf);
				const folds = computeBookFolds({
					title: p.title, author: p.author, isbn: p.isbn, publisher: p.publisher,
					description: p.description, tagsJson: tags, customFieldsJson: mergedCustomJson
				});
				await c.env.DB.prepare(
					`UPDATE books SET
						title = ?, author = ?, isbn = ?, publication_year = ?, publisher = ?, language = ?,
						description = ?, shelf_code = ?, custom_fields = ?, updated_at = ?,
						version = version + 1,
						title_fold = ?, author_fold = ?, isbn_fold = ?, publisher_fold = ?,
						description_fold = ?, custom_fields_fold = ?
					 WHERE id = ? AND deleted_at IS NULL`
				)
					.bind(
						p.title,
						p.author,
						p.isbn,
						p.publicationYear,
						p.publisher,
						p.language,
						p.description,
						p.shelfCode,
						mergedCustomJson,
						now,
						folds.title_fold,
						folds.author_fold,
						folds.isbn_fold,
						folds.publisher_fold,
						folds.description_fold,
						folds.custom_fields_fold,
						bookId
					)
					.run();
				didUpdate = true;
			} else {
				bookId = crypto.randomUUID();
				const customJson = JSON.stringify(p.customFields);
				const folds = computeBookFolds({
					title: p.title, author: p.author, isbn: p.isbn, publisher: p.publisher,
					description: p.description, tagsJson: tags, customFieldsJson: customJson
				});
				await c.env.DB.prepare(
					`INSERT INTO books (
						id, title, author, isbn, publication_year, publisher, language, description,
						room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
						legacy_id, created_at, updated_at, deleted_at,
						title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, 'available', 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
				)
					.bind(
						bookId,
						p.title,
						p.author,
						p.isbn,
						p.publicationYear,
						p.publisher,
						p.language,
						p.description,
						p.shelfCode,
						tags,
						customJson,
						p.legacyId,
						now,
						now,
						folds.title_fold,
						folds.author_fold,
						folds.isbn_fold,
						folds.publisher_fold,
						folds.description_fold,
						folds.tags_fold,
						folds.custom_fields_fold
					)
					.run();
			}

			try {
				await replaceBookAttributeValues(c.env, bookId, effectiveCf);
			} catch {
				attributeFailures += 1;
			}

			if (didUpdate) updated += 1;
			else inserted += 1;
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'insert/update failed';
			skippedRows.push({ index: -1, reason });
		}
	}

	if (inserted > 0 || updated > 0) {
		await bumpBooksCacheVersion(c.env);
	}

	try {
		await insertAuditLog(c.env, c.get('user').sub, 'book.importCatalog', 'book', null, {
			inserted,
			updated,
			skipped: skippedRows.length,
			attributeFailures
		});
	} catch (error) {
		console.warn('Audit log failed for book.importCatalog, continuing', error);
	}

	return c.json({
		dryRun: false,
		inserted,
		updated,
		skippedTrashed,
		skippedRows,
		attributeFailures
	}, 201);
});

// ─── Borrowers ─────────────────────────────────────────────────────────────
// Repeat-borrower visibility: a librarian can see who has the most loans, who
// is overdue, and who to contact. The autocomplete endpoint backs the borrow
// form's combobox.

app.get('/api/borrowers', requirePermission('circulation', { librarian: true }), async (c) => {
	const q = (c.req.query('q') ?? '').trim();
	const limit = Math.max(1, Math.min(50, Number(c.req.query('limit') ?? 20)));
	const params: unknown[] = [];
	let where = '';
	if (q) {
		where = 'WHERE LOWER(b.name) LIKE LOWER(?) OR LOWER(COALESCE(b.contact, \'\')) LIKE LOWER(?)';
		const like = `%${q.replace(/[%_]/g, '')}%`;
		params.push(like, like);
	}

	const rows = await c.env.DB.prepare(
		`SELECT b.id, b.name, b.contact, b.notes, b.created_at, b.updated_at,
		        COALESCE(c.total_loans, 0) AS total_loans,
		        COALESCE(c.open_loans, 0) AS open_loans,
		        COALESCE(c.overdue_loans, 0) AS overdue_loans
		 FROM borrowers b
		 LEFT JOIN (
		   SELECT borrower_id,
		          COUNT(*) AS total_loans,
		          SUM(CASE WHEN returned_at IS NULL THEN 1 ELSE 0 END) AS open_loans,
		          SUM(CASE WHEN returned_at IS NULL AND due_at < ? THEN 1 ELSE 0 END) AS overdue_loans
		     FROM borrow_transactions
		    WHERE borrower_id IS NOT NULL
		    GROUP BY borrower_id
		 ) c ON c.borrower_id = b.id
		 ${where}
		 ORDER BY total_loans DESC, LOWER(b.name) ASC
		 LIMIT ?`
	).bind(nowIso(), ...params, limit).all<{
		id: string; name: string; contact: string | null; notes: string | null;
		created_at: string; updated_at: string;
		total_loans: number; open_loans: number; overdue_loans: number;
	}>();

	return c.json({
		items: (rows.results ?? []).map((r) => ({
			id: r.id,
			name: r.name,
			contact: r.contact,
			notes: r.notes,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			totalLoans: Number(r.total_loans ?? 0),
			openLoans: Number(r.open_loans ?? 0),
			overdueLoans: Number(r.overdue_loans ?? 0)
		}))
	});
});

app.get('/api/borrowers/:id', requirePermission('circulation', { librarian: true }), async (c) => {
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM borrowers WHERE id = ? LIMIT 1').bind(id).first<{
		id: string; name: string; contact: string | null; notes: string | null;
		created_at: string; updated_at: string;
	}>();
	if (!row) {
		throw new HTTPException(404, { message: 'Borrower not found' });
	}
	const loans = await c.env.DB.prepare(
		`SELECT bt.id, bt.book_id, b.title, b.author, bt.borrowed_at, bt.due_at, bt.returned_at, bt.notes,
		        CASE WHEN bt.returned_at IS NULL AND bt.due_at < ? THEN 1 ELSE 0 END AS is_overdue
		 FROM borrow_transactions bt
		 JOIN books b ON b.id = bt.book_id
		 WHERE bt.borrower_id = ?
		 ORDER BY bt.borrowed_at DESC LIMIT 100`
	).bind(nowIso(), id).all();

	return c.json({
		id: row.id,
		name: row.name,
		contact: row.contact,
		notes: row.notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		loans: (loans.results ?? []).map((r) => {
			const x = r as Record<string, unknown>;
			return {
				id: x.id, bookId: x.book_id, title: x.title, author: x.author,
				borrowedAt: x.borrowed_at, dueAt: x.due_at, returnedAt: x.returned_at,
				notes: x.notes, isOverdue: x.is_overdue === 1
			};
		})
	});
});

app.post('/api/borrowers', requirePermission('circulation', { librarian: true }), async (c) => {
	const payload = UpsertBorrowerSchema.parse(await c.req.json());
	const id = crypto.randomUUID();
	const now = nowIso();
	await c.env.DB.prepare(
		`INSERT INTO borrowers (id, name, contact, notes, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).bind(id, payload.name, payload.contact ?? null, payload.notes ?? null, now, now).run();
	await insertAuditLog(c.env, c.get('user').sub, 'borrower.create', 'borrower', id, { name: payload.name });
	return c.json({ id }, 201);
});

app.put('/api/borrowers/:id', requirePermission('circulation', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const payload = UpsertBorrowerSchema.parse(await c.req.json());
	const result = await c.env.DB.prepare(
		`UPDATE borrowers SET name = ?, contact = ?, notes = ?, updated_at = ? WHERE id = ?`
	).bind(payload.name, payload.contact ?? null, payload.notes ?? null, nowIso(), id).run();
	if ((result.meta?.changes ?? 0) === 0) {
		throw new HTTPException(404, { message: 'Borrower not found' });
	}
	await insertAuditLog(c.env, c.get('user').sub, 'borrower.update', 'borrower', id, { name: payload.name });
	return c.json({ id });
});

app.delete('/api/borrowers/:id', requirePermission('circulation'), async (c) => {
	const id = c.req.param('id') ?? '';
	// Refuse if the borrower has any historical loans — better to mark inactive
	// than orphan transaction history. Frontend can suggest the rename flow.
	const inUse = await c.env.DB.prepare(
		'SELECT COUNT(*) AS n FROM borrow_transactions WHERE borrower_id = ?'
	).bind(id).first<{ n: number }>();
	if (inUse && inUse.n > 0) {
		throw new HTTPException(409, { message: `Cannot delete: borrower has ${inUse.n} loan(s) on record. Use /erase to anonymize.` });
	}
	const result = await c.env.DB.prepare('DELETE FROM borrowers WHERE id = ?').bind(id).run();
	if ((result.meta?.changes ?? 0) === 0) {
		throw new HTTPException(404, { message: 'Borrower not found' });
	}
	await insertAuditLog(c.env, c.get('user').sub, 'borrower.delete', 'borrower', id, {});
	return c.body(null, 204);
});

// GDPR: subject-access export. Returns the borrower row plus every loan ever
// recorded for them, in a single JSON document suitable for handing to the
// data subject. Admin-only via the `setup` permission to match the rest of
// the privacy-sensitive surface area.
app.get('/api/borrowers/:id/export', requirePermission('setup'), async (c) => {
	const id = c.req.param('id') ?? '';
	const borrower = await c.env.DB.prepare(
		'SELECT id, name, contact, notes, created_at, updated_at FROM borrowers WHERE id = ? LIMIT 1'
	).bind(id).first<{
		id: string; name: string; contact: string | null; notes: string | null;
		created_at: string; updated_at: string;
	}>();
	if (!borrower) {
		throw new HTTPException(404, { message: 'Borrower not found' });
	}
	const loans = await c.env.DB.prepare(
		`SELECT bt.id, bt.book_id, b.title, b.author, bt.borrowed_at, bt.due_at, bt.returned_at, bt.notes
		   FROM borrow_transactions bt
		   LEFT JOIN books b ON b.id = bt.book_id
		  WHERE bt.borrower_id = ?
		  ORDER BY bt.borrowed_at ASC`
	).bind(id).all<{
		id: string; book_id: string; title: string | null; author: string | null;
		borrowed_at: string; due_at: string; returned_at: string | null; notes: string | null;
	}>();

	await insertAuditLog(c.env, c.get('user').sub, 'borrower.export', 'borrower', id, {});

	const filename = `borrower-${id}.json`;
	c.header('Content-Type', 'application/json; charset=utf-8');
	c.header('Content-Disposition', `attachment; filename="${filename}"`);
	return c.body(JSON.stringify({
		exportedAt: nowIso(),
		borrower: {
			id: borrower.id,
			name: borrower.name,
			contact: borrower.contact,
			notes: borrower.notes,
			createdAt: borrower.created_at,
			updatedAt: borrower.updated_at
		},
		loans: (loans.results ?? []).map((r) => ({
			id: r.id,
			bookId: r.book_id,
			title: r.title,
			author: r.author,
			borrowedAt: r.borrowed_at,
			dueAt: r.due_at,
			returnedAt: r.returned_at,
			notes: r.notes
		}))
	}, null, 2));
});

// GDPR: right-to-erasure. Anonymizes the borrower row in place — replaces
// name with a sentinel, clears contact/notes, and keeps the id so foreign
// keys on borrow_transactions remain valid. This preserves aggregate loan
// statistics (which are not personal data once detached from the name)
// while making the row no longer identify a natural person.
app.post('/api/borrowers/:id/erase', requirePermission('setup'), async (c) => {
	const id = c.req.param('id') ?? '';
	const sentinel = `[Erased ${id.slice(0, 8)}]`;
	const result = await c.env.DB.prepare(
		`UPDATE borrowers SET name = ?, contact = NULL, notes = NULL, updated_at = ? WHERE id = ?`
	).bind(sentinel, nowIso(), id).run();
	if ((result.meta?.changes ?? 0) === 0) {
		throw new HTTPException(404, { message: 'Borrower not found' });
	}
	// Also strip any free-text `notes` on the borrower's loan history that
	// might contain identifying phrases the operator typed at borrow time.
	await c.env.DB.prepare(
		'UPDATE borrow_transactions SET notes = NULL WHERE borrower_id = ?'
	).bind(id).run();
	await insertAuditLog(c.env, c.get('user').sub, 'borrower.erase', 'borrower', id, {});
	return c.json({ id, anonymizedName: sentinel });
});

app.get('/api/borrowers/export.csv', requirePermission('circulation', { librarian: true }), async (c) => {
	const rows = await c.env.DB.prepare(
		`SELECT b.id, b.name, b.contact, b.notes, b.created_at, b.updated_at,
		        COUNT(bt.id) AS total_loans,
		        SUM(CASE WHEN bt.returned_at IS NULL THEN 1 ELSE 0 END) AS open_loans,
		        SUM(CASE WHEN bt.returned_at IS NULL AND bt.due_at < ? THEN 1 ELSE 0 END) AS overdue_loans
		   FROM borrowers b
		   LEFT JOIN borrow_transactions bt ON bt.borrower_id = b.id
		  GROUP BY b.id
		  ORDER BY total_loans DESC, LOWER(b.name) ASC`
	).bind(nowIso()).all<{
		id: string; name: string; contact: string | null; notes: string | null;
		created_at: string; updated_at: string;
		total_loans: number; open_loans: number; overdue_loans: number;
	}>();

	const csv = toCsv(
		(rows.results ?? []).map((r) => ({
			ID: r.id,
			Name: r.name,
			Contact: r.contact ?? '',
			Notes: r.notes ?? '',
			'Total loans': Number(r.total_loans ?? 0),
			'Open loans': Number(r.open_loans ?? 0),
			'Overdue loans': Number(r.overdue_loans ?? 0),
			'Created at': r.created_at,
			'Updated at': r.updated_at
		})),
		['ID', 'Name', 'Contact', 'Notes', 'Total loans', 'Open loans', 'Overdue loans', 'Created at', 'Updated at']
	);

	c.header('Content-Type', 'text/csv; charset=utf-8');
	c.header('Content-Disposition', 'attachment; filename="borrowers.csv"');
	// UTF-8 BOM so Excel renders non-Latin borrower names correctly (see books.csv).
	return c.body('﻿' + csv);
});

// Maintenance endpoint: orphan cleanup. Sweeps:
//   • code_assignments / book_attribute_values whose book row is gone
//   • R2 covers whose books are also gone
//   • inactive borrowers (no loans on record)            ← optional
// Admin-only and idempotent — safe to run from a cron or on-demand.
app.post('/api/maintenance/cleanup', requireRole(['admin']), async (c) => {
	// Wrap in a transaction so a partial failure can't leave book_attribute_values
	// referencing a still-present book_id while code_assignments was already gone.
	const summary = await (async () => {
		// Three independent DELETEs — atomic so a half-cleaned state never leaks.
		const results = await runAtomic(c.env, [
			c.env.DB.prepare(
				`DELETE FROM code_assignments
			 WHERE book_id NOT IN (SELECT id FROM books)`
			),
			c.env.DB.prepare(
				`DELETE FROM book_attribute_values
			 WHERE book_id NOT IN (SELECT id FROM books)`
			),
			c.env.DB.prepare(
				`DELETE FROM borrow_transactions
			 WHERE book_id NOT IN (SELECT id FROM books)`
			)
		]);
		return {
			orphanCodes: results[0]?.meta?.changes ?? 0,
			orphanAttributes: results[1]?.meta?.changes ?? 0,
			orphanLoans: results[2]?.meta?.changes ?? 0
		};
	})();

	// Mutation log retention: the idempotency table grows monotonically as
	// every write punches a new row. Without this sweep a busy library would
	// see the table swell indefinitely. 7 days is well past the longest
	// realistic client retry window, so anything older can be safely dropped
	// — re-running the exact same mutation id after that point is no longer
	// guarded by the replay logic, but a 7-day-old client retry is already
	// an anomaly we'd want to investigate, not silently coalesce.
	const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const sweepRes = await c.env.DB.prepare(
		'DELETE FROM mutation_log WHERE created_at < ?'
	).bind(cutoff).run();
	const purgedMutationLog = sweepRes.meta?.changes ?? 0;

	const fullSummary = { ...summary, purgedMutationLog };
	await insertAuditLog(c.env, c.get('user').sub, 'maintenance.cleanup', 'system', null, fullSummary);
	return c.json(fullSummary);
});

// ─── Cover images (R2) ────────────────────────────────────────────────────
// Covers are stored in the ASSETS R2 bucket under `covers/<bookId>` and served
// back through the worker so the frontend never has to deal with R2 directly
// or handle CORS/signed URLs.

const COVER_MIME_ALLOWLIST = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const COVER_MAX_BYTES = 4 * 1024 * 1024; // 4 MB

app.put('/api/books/:id/cover', requirePermission('books.write', { librarian: true }), async (c) => {
	const bookId = c.req.param('id') ?? '';
	if (!/^[a-zA-Z0-9-]{1,64}$/.test(bookId)) {
		throw new HTTPException(400, { message: 'Invalid book id' });
	}
	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').bind(bookId).first();
	if (!book) {
		throw new HTTPException(404, { message: 'Book not found' });
	}
	const contentType = c.req.header('content-type') ?? '';
	if (!COVER_MIME_ALLOWLIST.has(contentType)) {
		throw new HTTPException(415, { message: 'Cover must be JPEG, PNG, WebP, or GIF.' });
	}
	const buffer = await c.req.arrayBuffer();
	if (buffer.byteLength === 0) {
		throw new HTTPException(400, { message: 'Empty upload.' });
	}
	if (buffer.byteLength > COVER_MAX_BYTES) {
		throw new HTTPException(413, { message: 'Cover image too large (max 4 MB).' });
	}
	const ext = contentType === 'image/jpeg' ? 'jpg'
		: contentType === 'image/png' ? 'png'
		: contentType === 'image/webp' ? 'webp' : 'gif';
	const key = `covers/${bookId}.${ext}`;
	await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
	// Purge any previously-stored cover for this book under a DIFFERENT extension.
	// Covers are keyed by content-type-derived extension, and the GET handler
	// serves the first extension it finds in a fixed order (jpg, png, webp, gif).
	// Without this cleanup, replacing e.g. a JPG cover with a PNG would leave the
	// old covers/<id>.jpg behind — orphaning storage AND making GET serve the
	// STALE image (jpg is tried before png), so the new cover never appears.
	for (const otherExt of ['jpg', 'png', 'webp', 'gif']) {
		if (otherExt === ext) continue;
		try { await c.env.ASSETS.delete(`covers/${bookId}.${otherExt}`); } catch { /* ignore */ }
	}
	const coverUrl = `/api/books/${bookId}/cover?v=${Date.now()}`;
	// Return the new version so the client keeps its copy authoritative — a cover
	// upload bumps version, and without this the next metadata edit would send a
	// stale version and spuriously 409.
	const bumped = await c.env.DB.prepare(
		'UPDATE books SET cover_url = ?, updated_at = ?, version = version + 1 WHERE id = ? RETURNING version'
	).bind(coverUrl, nowIso(), bookId).first<{ version: number }>();
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.cover.upload', 'book', bookId, { contentType, bytes: buffer.byteLength });
	return c.json({ ok: true, coverUrl, version: Number(bumped?.version ?? 0) });
});

app.delete('/api/books/:id/cover', requirePermission('books.write', { librarian: true }), async (c) => {
	const bookId = c.req.param('id') ?? '';
	if (!/^[a-zA-Z0-9-]{1,64}$/.test(bookId)) {
		throw new HTTPException(400, { message: 'Invalid book id' });
	}
	const book = await c.env.DB.prepare('SELECT id, cover_url FROM books WHERE id = ? AND deleted_at IS NULL')
		.bind(bookId).first<{ id: string; cover_url: string | null }>();
	if (!book) {
		throw new HTTPException(404, { message: 'Book not found' });
	}
	for (const ext of ['jpg', 'png', 'webp', 'gif']) {
		try { await c.env.ASSETS.delete(`covers/${bookId}.${ext}`); } catch { /* ignore */ }
	}
	const bumped = await c.env.DB.prepare(
		'UPDATE books SET cover_url = NULL, updated_at = ?, version = version + 1 WHERE id = ? RETURNING version'
	).bind(nowIso(), bookId).first<{ version: number }>();
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.cover.delete', 'book', bookId, {});
	return c.json({ ok: true, version: Number(bumped?.version ?? 0) });
});

app.get('/api/books/:id/cover', async (c) => {
	const bookId = c.req.param('id') ?? '';
	if (!/^[a-zA-Z0-9-]{1,64}$/.test(bookId)) {
		throw new HTTPException(400, { message: 'Invalid book id' });
	}
	// This endpoint is intentionally public (so <img> tags load without the
	// session cookie), but it must not serve covers for soft-deleted/trashed
	// books. One indexed point lookup; covers are cached for an hour anyway.
	const live = await c.env.DB.prepare(
		'SELECT 1 AS ok FROM books WHERE id = ? AND deleted_at IS NULL LIMIT 1'
	).bind(bookId).first<{ ok: number }>();
	if (!live) {
		throw new HTTPException(404, { message: 'No cover image' });
	}
	const ifNoneMatch = c.req.header('if-none-match');
	for (const ext of ['jpg', 'png', 'webp', 'gif']) {
		const obj = await c.env.ASSETS.get(`covers/${bookId}.${ext}`);
		if (obj) {
			// Honor If-None-Match so the browser can skip the body on revisits.
			if (ifNoneMatch && obj.httpEtag && ifNoneMatch === obj.httpEtag) {
				return new Response(null, { status: 304, headers: { ETag: obj.httpEtag } });
			}
			return new Response(obj.body, {
				headers: {
					'Content-Type': obj.httpMetadata?.contentType ?? `image/${ext === 'jpg' ? 'jpeg' : ext}`,
					// Workers cache for 1 hour; browsers must revalidate so fresh
					// uploads land within seconds (the cover_url query string also
					// changes after an upload, double-defending against stale cache).
					'Cache-Control': 'public, max-age=3600, must-revalidate',
					ETag: obj.httpEtag
				}
			});
		}
	}
	throw new HTTPException(404, { message: 'No cover image' });
});

// ─── ISBN enrichment (OpenLibrary + Google Books) ────────────────────────
// Looks up bibliographic metadata for an ISBN via two public APIs, normalizes
// the response into the same shape our `BookCoreSchema` accepts, and caches
// the merged result in KV for a week. Results are deliberately conservative —
// we only return fields the librarian would otherwise have to type by hand.
//
// Source semantics:
//   • openlibrary  — Open Library Books API (https://openlibrary.org/dev/docs/api/books)
//   • googlebooks  — Google Books Volume API (https://developers.google.com/books)
//   • both         — merge with OpenLibrary as primary source
//
// We hit both endpoints in parallel, prefer non-empty values from OpenLibrary
// (it's typically richer for older books and has multilingual data), and fall
// back to Google Books for whatever's still missing. Both APIs are unauth'd
// and rate-limited at the network layer; the KV cache keeps us well under any
// realistic limit during normal use.

type EnrichedBookFields = {
	isbn: string;
	title?: string | null;
	subTitle?: string | null;
	author?: string | null;
	publisher?: string | null;
	publicationYear?: number | null;
	language?: string | null;
	description?: string | null;
	pages?: number | null;
	coverUrl?: string | null;
	source: 'openlibrary' | 'googlebooks' | 'both' | 'none';
};

function sanitizeIsbn(raw: string): string {
	// Strip everything but digits and X (some ISBN-10 end in 'X'), upper-case.
	// Keeps the cache key tight and protects us from someone passing a URL
	// fragment or a quoted string in.
	return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

function isValidIsbn(isbn: string): boolean {
	// We don't checksum-validate (some catalogue ISBNs in the wild are typo'd).
	// 10- and 13-digit lengths cover the legitimate cases; anything else is
	// almost certainly junk and we shouldn't burn an upstream call on it.
	return /^(\d{9}[\dX]|\d{13})$/.test(isbn);
}

async function fetchOpenLibrary(isbn: string): Promise<Partial<EnrichedBookFields> | null> {
	try {
		const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`, {
			cf: { cacheEverything: true, cacheTtl: 86400 }
		} as RequestInit);
		if (!res.ok) return null;
		const data = (await res.json()) as Record<string, unknown>;
		const entry = data[`ISBN:${isbn}`] as Record<string, unknown> | undefined;
		if (!entry) return null;
		const authors = (entry.authors as Array<{ name?: string }> | undefined) ?? [];
		const publishers = (entry.publishers as Array<{ name?: string }> | undefined) ?? [];
		const yearRaw = (entry.publish_date as string | undefined) ?? '';
		const yearMatch = yearRaw.match(/\b(\d{4})\b/);
		const cover = entry.cover as Record<string, string> | undefined;
		return {
			title: typeof entry.title === 'string' ? entry.title : null,
			subTitle: typeof entry.subtitle === 'string' ? (entry.subtitle as string) : null,
			author: authors.map((a) => a.name).filter(Boolean).join(', ') || null,
			publisher: publishers.map((p) => p.name).filter(Boolean).join(', ') || null,
			publicationYear: yearMatch ? Number(yearMatch[1]) : null,
			pages: typeof entry.number_of_pages === 'number' ? entry.number_of_pages : null,
			coverUrl: cover?.large ?? cover?.medium ?? cover?.small ?? null
		};
	} catch {
		return null;
	}
}

async function fetchGoogleBooks(isbn: string): Promise<Partial<EnrichedBookFields> | null> {
	try {
		const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`, {
			cf: { cacheEverything: true, cacheTtl: 86400 }
		} as RequestInit);
		if (!res.ok) return null;
		const data = (await res.json()) as {
			items?: Array<{
				volumeInfo?: {
					title?: string;
					subtitle?: string;
					authors?: string[];
					publisher?: string;
					publishedDate?: string;
					description?: string;
					language?: string;
					pageCount?: number;
					imageLinks?: { thumbnail?: string; smallThumbnail?: string };
				};
			}>;
		};
		const info = data.items?.[0]?.volumeInfo;
		if (!info) return null;
		const yearMatch = (info.publishedDate ?? '').match(/\b(\d{4})\b/);
		const rawCover = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail ?? null;
		return {
			title: info.title ?? null,
			subTitle: info.subtitle ?? null,
			author: info.authors?.join(', ') ?? null,
			publisher: info.publisher ?? null,
			publicationYear: yearMatch ? Number(yearMatch[1]) : null,
			language: info.language ?? null,
			description: info.description ?? null,
			pages: typeof info.pageCount === 'number' ? info.pageCount : null,
			// Google's thumbnails come back as http://; upgrade so mixed-content
			// blocking doesn't shoot the image down on the frontend.
			coverUrl: rawCover ? rawCover.replace(/^http:\/\//, 'https://') : null
		};
	} catch {
		return null;
	}
}

function mergeEnrichment(
	primary: Partial<EnrichedBookFields> | null,
	fallback: Partial<EnrichedBookFields> | null
): Partial<EnrichedBookFields> {
	const out: Partial<EnrichedBookFields> = {};
	for (const key of [
		'title', 'subTitle', 'author', 'publisher', 'publicationYear',
		'language', 'description', 'pages', 'coverUrl'
	] as Array<keyof EnrichedBookFields>) {
		const p = primary?.[key];
		const f = fallback?.[key];
		// Pick the non-empty/non-null value; primary wins ties.
		const chosen = (p !== null && p !== undefined && p !== '') ? p : f;
		if (chosen !== undefined && chosen !== null && chosen !== '') {
			(out as Record<string, unknown>)[key] = chosen;
		}
	}
	return out;
}

app.get('/api/lookup/isbn/:isbn', async (c) => {
	const sourceParam = (c.req.query('source') ?? 'both').toLowerCase();
	if (!['openlibrary', 'googlebooks', 'both'].includes(sourceParam)) {
		throw new HTTPException(400, { message: 'source must be openlibrary, googlebooks, or both' });
	}
	const isbn = sanitizeIsbn(c.req.param('isbn') ?? '');
	if (!isValidIsbn(isbn)) {
		throw new HTTPException(400, { message: 'Invalid ISBN (need 10 or 13 digits).' });
	}

	const cacheKey = `enrich:isbn:${sourceParam}:${isbn}`;
	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) return c.json(cached);
		} catch (error) {
			console.warn('ISBN enrichment cache read failed', error);
		}
	}

	let merged: Partial<EnrichedBookFields> = {};
	let source: EnrichedBookFields['source'] = 'none';
	if (sourceParam === 'openlibrary') {
		const ol = await fetchOpenLibrary(isbn);
		merged = ol ?? {};
		source = ol ? 'openlibrary' : 'none';
	} else if (sourceParam === 'googlebooks') {
		const gb = await fetchGoogleBooks(isbn);
		merged = gb ?? {};
		source = gb ? 'googlebooks' : 'none';
	} else {
		const [ol, gb] = await Promise.all([fetchOpenLibrary(isbn), fetchGoogleBooks(isbn)]);
		merged = mergeEnrichment(ol, gb);
		if (ol && gb) source = 'both';
		else if (ol) source = 'openlibrary';
		else if (gb) source = 'googlebooks';
		else source = 'none';
	}

	const response: EnrichedBookFields = { isbn, source, ...merged };

	if (c.env.CACHE && source !== 'none') {
		try {
			// 7 days. We cache positive hits aggressively because they're
			// effectively static; negative hits are NOT cached so a typo'd
			// ISBN can self-correct as soon as the user fixes it.
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 7 * 24 * 60 * 60 });
		} catch (error) {
			console.warn('ISBN enrichment cache write failed', error);
		}
	}

	return c.json(response);
});

export default app;
