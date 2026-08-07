import {
	AddCopiesSchema,
	parseEdtf,
	BookFilterQuerySchema,
	BorrowBookSchema,
	CreateBookSchema,
	GenerateCodeSchema,
	ReplaceItemsSchema,
	computeSetGaps,
	LinkAuthoritiesSchema,
	MergeBooksSchema,
	PlaceHoldSchema,
	RenewLoanSchema,
	ReplaceLoanPoliciesSchema,
	UpsertAuthoritySchema,
	ImportBooksSchema,
	ITEM_TYPES,
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
	foldDiacritics,
	getBookAttributeValues,
	getBooksCacheVersion,
	insertAuditLog,
	loadCustomFieldDefs,
	parseBook,
	queryBooksWithFilters,
	replaceBookAttributeValues,
	recordSyncMutation,
	resolveEmptyFieldExpr,
	getLibrarySettings,
	loadMarcExtrasForBooks,
	loadOaiPage,
	ensurePrimaryItem,
	setItemsDeleted,
	restoreItemsDeletedAt,
	ITEM_BACKED_FACETS,
	loadBookItems,
	loadItemsForBooks,
	loadMergeCandidateGroups,
	pickLendableItem,
	countLendableItems,
	resolveLoanPolicy,
	dueDateFromPolicy,
	countOpenLoansFor,
	expireStaleHolds,
	parseItem,
	syncBookFromItems,
	runAtomic,
	semanticSearchBookIds,
	semanticSearchEnabled,
	unvectorizeBook,
	validateCustomFields,
	validateCustomFieldsAgainst,
	vectorizeBook,
	withTxn
} from './db';
import {
	bookRowToMarcInput,
	MARCXML_COLLECTION_CLOSE,
	MARCXML_COLLECTION_OPEN,
	marcToBookFields,
	parseMarcXml,
	toDublinCoreXml,
	toMarcJson,
	toMarcXml
} from './marc';
import type { ParsedMarcRecord } from './marc';
import {
	decodeResumptionToken,
	encodeResumptionToken,
	oaiDatestamp,
	oaiError,
	oaiIdentifier,
	oaiIdentify,
	oaiResponse,
	parseCql,
	parseOaiIdentifier,
	sruDiagnostic,
	sruExplain,
	xmlEscape
} from './protocols';
import type { AuthClaims, Env } from './types';
import { deterministicUuid, generateCodeValue, newId, normalizeBookData, normalizeCode, nowIso, safeJsonParse, toCsv } from './utils';

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

// D1 caps a batch at 50 statements; add-copies can generate 500 books x 10
// copies, so it chunks. Kept below the batch limit rather than at it, since
// each chunk is a subrequest and the per-invocation budget is unconfirmed.
const D1_ADD_COPIES_BATCH = 40;

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
	// Extent, not a page count — free text per ISBD area 5 / MARC 300$a, so
	// "σ. 351-700" and "156,[3]σ." are recordable. Matches CATALOG_CUSTOM_FIELDS.
	{ label: 'Pages', customKey: 'pages', customType: 'text' },
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
/**
 * Refuse a patch that CLEARS a required attribute.
 *
 * Patch-shaped writes are deliberately lenient about required attributes — a
 * bulk edit must not fail because some unrelated book is missing one. But
 * actively deleting a required value is different: the book form sends the
 * whole map and DOES enforce required, so the book would 400 the next time
 * anyone opened and saved it. Cheaper to refuse the clear than to strand books.
 */
async function assertPatchKeepsRequiredFields(
	env: Env,
	patch: { customFieldsPatch?: Record<string, unknown> } | undefined
): Promise<void> {
	const cleared = Object.entries(patch?.customFieldsPatch ?? {})
		.filter(([, value]) => value === null || (typeof value === 'string' && value.trim() === ''))
		.map(([key]) => key);
	if (cleared.length === 0) return;

	const defs = await loadCustomFieldDefs(env);
	const required = defs.filter((def) => def.required === 1).map((def) => def.field_key);
	const blocked = cleared.filter((key) => required.includes(key));
	if (blocked.length > 0) {
		throw new HTTPException(400, {
			message: `Cannot clear required attribute(s): ${blocked.join(', ')}`
		});
	}
}

/**
 * Apply the PATCH-shaped fields of an update (`customFieldsPatch`, `tagsAdd`,
 * `tagsRemove`) on top of the values a book already has.
 *
 * These exist so a bulk edit can change ONE attribute across many books without
 * transmitting — and therefore without being able to destroy — the attributes it
 * isn't touching. `customFields` / `tags` remain whole-value replacements for
 * the single-book form, which does render every field.
 *
 * A `null` in the patch clears that one key. Tag add/remove is de-duplicated and
 * order-preserving, and remove wins over add for the same tag so a request that
 * says both is at least deterministic.
 */
function applyBookPatchFields(
	base: { customFields: Record<string, unknown>; tags: string[] },
	patch: { customFieldsPatch?: Record<string, unknown>; tagsAdd?: string[]; tagsRemove?: string[] }
): { customFields: Record<string, unknown>; tags: string[] } {
	let customFields = base.customFields;
	if (patch.customFieldsPatch) {
		customFields = { ...base.customFields };
		for (const [key, value] of Object.entries(patch.customFieldsPatch)) {
			if (value === null) delete customFields[key];
			// Trim text the same way the core columns are normalized, and treat a
			// whitespace-only value as a clear rather than storing " " as if it
			// were content.
			else if (typeof value === 'string') {
				const trimmed = value.trim();
				if (trimmed === '') delete customFields[key];
				else customFields[key] = trimmed;
			} else customFields[key] = value;
		}
	}

	let tags = base.tags;
	if (patch.tagsAdd?.length || patch.tagsRemove?.length) {
		// Tags match case-insensitively, because that is how they are SEARCHED
		// (tags_fold). Comparing exactly meant "remove History" silently did
		// nothing to a book tagged "history", and "add History" produced a second
		// near-identical tag alongside it. The tag's original casing is preserved
		// on the book; only the comparison is folded.
		const fold = (tag: string) => tag.trim().toLowerCase();
		const removing = new Set((patch.tagsRemove ?? []).map(fold).filter(Boolean));
		const next = base.tags.filter((tag) => !removing.has(fold(tag)));
		const present = new Set(next.map(fold));
		for (const tag of patch.tagsAdd ?? []) {
			const clean = tag.trim();
			const key = fold(clean);
			if (clean && !removing.has(key) && !present.has(key)) {
				next.push(clean);
				present.add(key);
			}
		}
		tags = next;
	}

	return { customFields, tags };
}

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
  // The rate limiter is backed by KV, whose FREE-TIER WRITE budget (1,000/day)
  // is the tightest limit in the whole system. Writing a limiter counter on
  // EVERY request would have capped the app at ~1,000 requests/day. So we only
  // spend a KV limiter write where abuse actually has a cost:
  //   • login            → brute-force surface (pre-auth)              20/min
  //   • cover upload      → up to 4 MB payload + R2 write              30/min
  //   • any mutation      → protects the D1-write budget from a flood  180/min
  //   • expensive GETs    → Workers AI (semantic), external fetch      60/min
  //                          (ISBN lookup) and full-table CSV export
  // Cheap authenticated GETs (list/detail/facets/stats/…) are already read-
  // through cached and cannot mutate state, so they skip the limiter entirely —
  // this is what makes normal browsing/searching effectively free on KV writes.
  const isAuthLogin = path === '/api/auth/login';
  const isCoverWrite =
    /^\/api\/books\/[^/]+\/cover$/.test(path) && (method === 'PUT' || method === 'DELETE');
  const isMutating = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  const isExpensiveGet = method === 'GET' && (
    path === '/api/books/semantic'
    || path.startsWith('/api/lookup/isbn/')
    || path.endsWith('/export.csv')
    || /\/export$/.test(path)
  );

  // SRU and OAI-PMH are UNAUTHENTICATED and world-reachable, so they get their
  // own bucket rather than sharing one with signed-in staff: a harvester
  // looping must never be able to exhaust the librarian's own allowance, and
  // the account has 100k requests/day in total.
  const isPublicProtocol = method === 'GET' && (path === '/api/sru' || path === '/api/oai');

  if (isAuthLogin) {
    await enforceRateLimit(c, 'login', 20);
  } else if (isPublicProtocol) {
    await enforceRateLimit(c, 'harvest', 60);
  } else if (isCoverWrite) {
    await enforceRateLimit(c, 'cover', 30);
  } else if (isMutating) {
    await enforceRateLimit(c, 'api', 180);
  } else if (isExpensiveGet) {
    await enforceRateLimit(c, 'read', 60);
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

// Current version of the librarian onboarding course. A user whose
// staff_users.onboarding_completed_version is below this is shown the mandatory
// course on next sign-in. Bump this to re-trigger the course for everyone after
// a major change to the cataloguing workflow.
const ONBOARDING_VERSION = 1;

app.post('/api/auth/login', async (c) => {
	await ensureBootstrapAdmin(c.env);

	const body = await c.req.json();
	const schema = z.object({ username: z.string().min(1), password: z.string().min(1) });
	const parsed = schema.parse(body);

	const user = await c.env.DB.prepare(
		`SELECT id, username, role, password_hash, password_salt, password_iterations, active, onboarding_completed_version
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
			onboarding_completed_version: number;
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
	return c.json({
		user: {
			id: user.id,
			username: user.username,
			role: user.role,
			needsOnboarding: (user.onboarding_completed_version ?? 0) < ONBOARDING_VERSION
		},
		token
	});
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
	// SRU and OAI-PMH are the two protocols other libraries read this catalogue
	// with, and both are unauthenticated by definition — a harvester has no
	// account here. They are read-only, expose bibliographic records ONLY, and
	// stay switched off until the librarian turns on `publicSharing`, so nothing
	// leaves the building by default. See the handlers for the guard.
	if (c.req.method === 'GET' && (c.req.path === '/api/sru' || c.req.path === '/api/oai')) {
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
	// The JWT carries only sub/username/role, so read the onboarding version from
	// the row (one D1 read per app load) — otherwise a returning user restored via
	// cookie/token would never see the mandatory course.
	const row = await c.env.DB.prepare(
		'SELECT onboarding_completed_version FROM staff_users WHERE id = ? LIMIT 1'
	).bind(user.sub).first<{ onboarding_completed_version: number }>();
	return c.json({
		user: {
			id: user.sub,
			username: user.username,
			role: user.role,
			needsOnboarding: (row?.onboarding_completed_version ?? 0) < ONBOARDING_VERSION
		}
	});
});

// Mark the current user's onboarding course as completed at the current version.
// Any authenticated user marks their OWN onboarding (no permission gate).
app.post('/api/me/onboarding-complete', async (c) => {
	const actor = c.get('user');
	await c.env.DB.prepare(
		'UPDATE staff_users SET onboarding_completed_version = ?, updated_at = ? WHERE id = ?'
	).bind(ONBOARDING_VERSION, nowIso(), actor.sub).run();
	await insertAuditLog(c.env, actor.sub, 'user.onboarding_complete', 'staff_user', actor.sub, { version: ONBOARDING_VERSION });
	return c.json({ ok: true, onboardingVersion: ONBOARDING_VERSION });
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

	// The COUNT(*) for a fully-unfiltered list scans every non-deleted row
	// (~12,500 D1 reads). That total is identical across pages and sort orders,
	// so memoize it under a version-keyed KV key: pagination and re-sorting of
	// the default browse then reuse one count instead of re-scanning per view.
	// Version-keyed → any write self-invalidates it, so it can't drift.
	const isFullyUnfiltered = !(query.q ?? '').trim() && !(query.qExclude ?? '').trim()
		&& !query.status && !query.language && !query.year
		&& query.yearMin === undefined && query.yearMax === undefined
		&& !query.roomCode && !query.shelfCode && !query.missingIsbn && !query.missingShelf
		&& !query.untitled && !query.unknownAuthor && !query.emptyField && !query.facetField
		&& customFilters.length === 0 && !includeDeleted;
	const totalKey = `books:total:${cacheVersion}`;
	let cachedTotal: number | undefined;
	if (isFullyUnfiltered && c.env.CACHE) {
		try {
			const t = await c.env.CACHE.get(totalKey);
			if (t !== null && t !== undefined) cachedTotal = Number(t);
		} catch { /* fall back to counting */ }
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
		facetField: query.facetField,
		facetValue: query.facetValue,
		emptyField: query.emptyField,
		includeDeleted,
		skipCount: cachedTotal !== undefined
	});

	const total = cachedTotal !== undefined ? cachedTotal : result.total;

	// Attach each record's copies in ONE extra query for the page, not one per
	// row. The list has to show where a book actually is, and a record held on
	// two shelves must say so rather than showing only its primary location.
	const pageIds = result.rows.map((r) => String((r as { id: unknown }).id));
	const itemsByBook = await loadItemsForBooks(c.env, pageIds);
	const rowsWithItems = result.rows.map((r) => ({
		...r,
		items: itemsByBook.get(String((r as { id: unknown }).id)) ?? []
	}));

	const response = {
		page: query.page,
		pageSize: query.pageSize,
		total,
		items: rowsWithItems
	};

	if (c.env.CACHE) {
		try {
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 });
			// Store the freshly-computed unfiltered total for the pages/sorts that
			// follow (skip if we already had it, to avoid a redundant KV write).
			if (isFullyUnfiltered && cachedTotal === undefined) {
				await c.env.CACHE.put(totalKey, String(total), { expirationTtl: 3600 });
			}
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
// Resolve a set of book ids to their full current records. This is what lets a
// bulk selection SPAN PAGES: the client keeps only ids, and before a bulk edit
// or label print it fetches the live rows here so every book carries its current
// `version` for the per-row optimistic-concurrency check. Deliberately a GET —
// a read-only POST would burn a KV rate-limiter write, a D1 mutation-log row and
// a client cache-bust on every selection resolve. Ids come in a comma-separated
// query string, so the client chunks them to stay well under URL length limits.
// NOTE: registered before `/api/books/:id` so "by-ids" isn't captured as an id.
app.get('/api/books/by-ids', async (c) => {
	const ids = (c.req.query('ids') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 100);
	if (ids.length === 0) return c.json({ items: [] });
	const placeholders = ids.map(() => '?').join(',');
	const res = await c.env.DB.prepare(
		`SELECT * FROM books WHERE id IN (${placeholders}) AND deleted_at IS NULL`
	)
		.bind(...ids)
		.all<Record<string, unknown>>();
	return c.json({ items: (res.results ?? []).map(parseBook) });
});

// Criteria-based selection: return every id matching a filter set, unpaginated.
// Two uses: "select all matching what I'm looking at" (the client forwards its
// current search/filters verbatim) and "select every book by this author / on
// this shelf / from this publisher" (the exact* params). Ids only — selecting a
// few thousand books must not read a few thousand whole rows.
// NOTE: registered before `/api/books/:id` so "ids" isn't captured as an id.
app.get('/api/books/ids', async (c) => {
	const query = BookFilterQuerySchema.parse(c.req.query());
	const customFilters = Object.entries(c.req.query())
		.filter(([key]) => key.startsWith('custom_'))
		.map(([key, value]) => ({ key: key.replace('custom_', ''), value }));
	const authorExact = c.req.query('authorExact');
	const publisherExact = c.req.query('publisherExact');
	const shelfExact = c.req.query('shelfExact');

	const result = await queryBooksWithFilters(c.env, {
		...query,
		customFilters,
		missingIsbn: query.missingIsbn,
		missingShelf: query.missingShelf,
		untitled: query.untitled,
		unknownAuthor: query.unknownAuthor,
		facetField: query.facetField,
		facetValue: query.facetValue,
		emptyField: query.emptyField,
		includeDeleted: false,
		authorExact,
		publisherExact,
		shelfExact,
		idsOnly: true,
		// Comfortably above the whole catalogue so "select all matching" is never
		// silently truncated for this library's size.
		idsLimit: 20000
	});
	// The fuzzy-search path returns rows rather than ids; fall back to mapping.
	const ids = result.ids ?? result.rows.map((r) => String((r as { id: unknown }).id));
	return c.json({ ids, total: ids.length });
});

// Books whose title starts with what the librarian is typing.
//
// This is a DUPLICATE WARNING shown during entry, not an autocomplete. The
// catalogue has ~12.5K titles and they are near-unique, so suggesting one as a
// value to accept is worse than useless — it invites picking an existing book's
// title by mistake, which is exactly why title is excluded from
// /api/books/facets. What the librarian actually asked for is to be told
// "you already have this" BEFORE typing the whole record, instead of after
// saving it.
//
// Read economy (free tier), in order of importance:
//  • Prefix range on the indexed fold, not LIKE '%q%'. `title_fold >= q AND
//    title_fold < q+'￿'` is two index seeks on idx_books_title_author_fold
//    (migration 0018); a substring scan would be 12,552 row reads per
//    debounced keystroke, which at everyday use would eat a meaningful slice of
//    the daily D1 budget for one feature.
//  • No KV cache. Per-prefix keys would explode the keyspace for a near-zero
//    hit rate, and KV writes (1,000/day) are the scarcest resource here. A
//    short private Cache-Control plus the client's debounce is the right trade.
//
// Depends on the *_fold backfill: rows written before migration 0012 have a
// NULL title_fold and are invisible to this query, which is the same blind spot
// that stopped the post-create duplicate warning from ever firing on imported
// books. POST /api/admin/normalize-books repairs both.
//
// NOTE: registered before `/api/books/:id` so "title-suggest" isn't an id.
app.get('/api/books/title-suggest', async (c) => {
	const raw = (c.req.query('q') ?? '').trim();
	const folded = foldDiacritics(raw);
	// Below three characters every other book matches, so the list is noise and
	// the query is at its most expensive.
	if (folded.length < 3) {
		return c.json({ items: [], total: 0 });
	}
	const excludeId = c.req.query('excludeId') ?? '';
	// '￿' is above every character that can appear in a folded title, so
	// [folded, folded+￿) is exactly the set of titles with this prefix.
	const upperBound = `${folded}￿`;

	const rows = await c.env.DB.prepare(
		`SELECT id, title, author, shelf_code, publication_year, isbn
		   FROM books
		  WHERE deleted_at IS NULL AND title_fold >= ? AND title_fold < ? AND id != ?
		  ORDER BY title_fold LIMIT 8`
	).bind(folded, upperBound, excludeId).all<{
		id: string; title: string; author: string;
		shelf_code: string | null; publication_year: number | null; isbn: string | null;
	}>();

	const total = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM books
		  WHERE deleted_at IS NULL AND title_fold >= ? AND title_fold < ? AND id != ?`
	).bind(folded, upperBound, excludeId).first<{ n: number }>();

	// Private: these are catalogue rows behind auth, and the response is
	// per-librarian keystroke state — never store it in a shared cache.
	c.header('Cache-Control', 'private, max-age=30');
	return c.json({
		items: (rows.results ?? []).map((r) => ({
			id: r.id,
			title: r.title,
			author: r.author,
			shelfCode: r.shelf_code,
			publicationYear: r.publication_year,
			isbn: r.isbn
		})),
		total: Number(total?.n ?? 0)
	});
});

// NOTE: registered before `/api/books/:id` so "facets" isn't captured as an id.
// Distinct catalog values that power predictive autocomplete on BOTH the
// cataloguing forms and the search filters — for everyone, since search helps
// viewers too and these are the same non-sensitive values GET /api/books already
// returns. Read-economy is critical (free tier): the result is cached in KV
// keyed on the books-cache-version, so the DB is only re-queried after a WRITE
// (the long TTL is just a backstop), and the browser then filters the datalist
// client-side with ZERO further requests per keystroke.
app.get('/api/books/facets', async (c) => {
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

	// Distinct catalog values for autocomplete, deduplicated by their fold key so
	// case/accent variants of the SAME value (e.g. "ΕΚΔΟΣΕΙΣ ΑΘΩΣ" / "Εκδόσεις
	// Άθως") collapse to ONE suggestion — the most-frequently-used spelling. This
	// actively steers new manual entries toward the existing canonical form
	// instead of minting yet another spelling, without touching stored data.
	// `column`/`foldKey` are always the hard-coded literals below — never user
	// input — so interpolating them into the SQL is safe from injection.
	async function distinctValues(column: string, foldKey: string, limit: number): Promise<string[]> {
		const { results } = await c.env.DB.prepare(
			`WITH counts AS (
				SELECT ${column} AS v, ${foldKey} AS k, COUNT(*) AS n
				  FROM books
				 WHERE deleted_at IS NULL AND ${column} IS NOT NULL AND TRIM(${column}) != ''
				   AND ${column} NOT IN ('(Unknown)', '(Untitled)')
				 GROUP BY ${column}
			 ),
			 ranked AS (
				SELECT v,
				       ROW_NUMBER() OVER (PARTITION BY k ORDER BY n DESC, v ASC) AS rn,
				       SUM(n) OVER (PARTITION BY k) AS total
				  FROM counts
			 )
			 SELECT v FROM ranked WHERE rn = 1 ORDER BY total DESC, v ASC LIMIT ?`
		)
			.bind(limit)
			.all<{ v: string }>();
		return (results ?? [])
			.map((r) => r.v)
			.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
	}

	// Distinct values for the free-text CUSTOM fields, aggregated in the Worker
	// from ONE scan of the books.custom_fields JSON (book_attribute_values is
	// empty for the imported catalogue, and a per-field json_extract GROUP BY
	// would be N table scans — this is a single scan + cheap CPU). Only text
	// fields get autocomplete; enum has its own dropdown, number/date/bool don't
	// need it. Deduped case-insensitively to the most-common spelling, capped.
	async function customFieldFacets(): Promise<Record<string, string[]>> {
		const defs = await loadCustomFieldDefs(c.env);
		const textKeys = new Set(defs.filter((d) => d.field_type === 'text').map((d) => d.field_key));
		if (textKeys.size === 0) return {};

		const { results } = await c.env.DB.prepare(
			`SELECT custom_fields FROM books
			  WHERE deleted_at IS NULL AND custom_fields IS NOT NULL AND custom_fields NOT IN ('', '{}')`
		).all<{ custom_fields: string }>();

		// key -> foldKey -> { value, count } (keep the most-frequent spelling).
		const acc = new Map<string, Map<string, { value: string; count: number }>>();
		for (const row of results ?? []) {
			const obj = safeJsonParse<Record<string, unknown>>(row.custom_fields ?? '{}', {});
			for (const key of textKeys) {
				const raw = obj[key];
				if (typeof raw !== 'string') continue;
				const v = raw.trim();
				if (!v) continue;
				const fold = v.toLowerCase();
				let byFold = acc.get(key);
				if (!byFold) { byFold = new Map(); acc.set(key, byFold); }
				const cur = byFold.get(fold);
				if (cur) cur.count += 1;
				else byFold.set(fold, { value: v, count: 1 });
			}
		}

		const out: Record<string, string[]> = {};
		for (const [key, byFold] of acc) {
			out[key] = [...byFold.values()]
				.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
				.slice(0, 500)
				.map((e) => e.value);
		}
		return out;
	}

	// Fold key per column: the *_fold columns (accent+case folded) for the
	// FTS-indexed text fields; a plain LOWER(TRIM()) for the short code fields
	// that have no fold column.
	// NOTE: title is intentionally NOT aggregated — titles are ~unique, so
	// autocompleting them is low-value and risks a librarian picking an existing
	// book's title. Skipping it also saves one aggregation + ~1000 strings.
	// Author/publisher use a LOOSE fold key (accent+case fold, then strip spaces,
	// dots and dashes) so "J.-P.MIGNE" / "J. -P. MIGNE" / "J.P. MIGNE" collapse to
	// ONE suggestion. This only chooses which spelling to SUGGEST — stored data
	// and search are untouched.
	const [authors, publishers, languages, shelfCodes, customFields] = await Promise.all([
		distinctValues('author', looseFold('COALESCE(author_fold, LOWER(author))'), 1000),
		distinctValues('publisher', looseFold('COALESCE(publisher_fold, LOWER(publisher))'), 1000),
		distinctValues('language', "LOWER(TRIM(language))", 200),
		distinctValues('shelf_code', "LOWER(TRIM(shelf_code))", 1000),
		customFieldFacets()
	]);

	const response = { authors, publishers, languages, shelfCodes, customFields };

	if (c.env.CACHE) {
		try {
			// Long TTL: correctness comes from the version-keyed cacheKey (a write
			// bumps the version → a fresh key → recompute), so the DB is not
			// re-queried on a timer. The TTL only bounds stale-key cleanup.
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 86400 });
		} catch (error) {
			console.warn('Facets cache write failed, continuing without cache', error);
		}
	}

	return c.json(response);
});

// Which normalizable text fields the consistency tools operate on, mapped to
// their column, optional accent+case fold column, and computeBookFolds input
// key. Whitelist — the keys are the only accepted `field` values, so the
// interpolated column names below can never be user-controlled.
const CONSISTENCY_FIELDS: Record<string, { column: string; foldColumn: string | null; foldInput: 'title' | 'author' | 'publisher' | null }> = {
	title: { column: 'title', foldColumn: 'title_fold', foldInput: 'title' },
	author: { column: 'author', foldColumn: 'author_fold', foldInput: 'author' },
	publisher: { column: 'publisher', foldColumn: 'publisher_fold', foldInput: 'publisher' },
	language: { column: 'language', foldColumn: null, foldInput: null },
	shelfCode: { column: 'shelf_code', foldColumn: null, foldInput: null }
};

// Wrap a fold expression to also strip spaces, dots and dashes, so spelling
// variants that differ only in punctuation/spacing ("J.-P.MIGNE" vs
// "J. -P. MIGNE") share a grouping key. Used only to pick a canonical
// suggestion / group variants — never to rewrite stored values or to search.
function looseFold(expr: string): string {
	return `REPLACE(REPLACE(REPLACE(${expr}, ' ', ''), '.', ''), '-', '')`;
}

function consistencyFoldKey(f: { column: string; foldColumn: string | null }): string {
	// Name fields (with a fold column) use the LOOSE fold so punctuation/spacing
	// variants group together; short code fields use a plain case-fold.
	return f.foldColumn ? looseFold(`COALESCE(${f.foldColumn}, LOWER(${f.column}))`) : `LOWER(TRIM(${f.column}))`;
}

// Value-consistency review: surface groups of values that fold to the SAME key
// but are spelled differently (e.g. "ΕΚΔΟΣΕΙΣ ΑΘΩΣ" vs "Εκδόσεις Άθως") so a
// librarian can consolidate the librarians' natural casing/accent variants into
// one canonical spelling. Read-only.
app.get('/api/books/value-variants', requirePermission('books.write', { librarian: true }), async (c) => {
	const field = c.req.query('field') ?? '';
	const meta = CONSISTENCY_FIELDS[field];
	if (!meta) {
		throw new HTTPException(400, { message: `Unknown field: ${field}` });
	}
	const { column } = meta;
	const foldKey = consistencyFoldKey(meta);

	const { results } = await c.env.DB.prepare(
		`WITH counts AS (
			SELECT ${column} AS v, ${foldKey} AS k, COUNT(*) AS n
			  FROM books
			 WHERE deleted_at IS NULL AND ${column} IS NOT NULL AND TRIM(${column}) != ''
			   AND ${column} NOT IN ('(Unknown)', '(Untitled)')
			 GROUP BY ${column}
		 ),
		 grp AS (
			SELECT k, COUNT(*) AS spellings, SUM(n) AS total
			  FROM counts GROUP BY k HAVING COUNT(*) > 1
		 )
		 SELECT c.k AS k, c.v AS v, c.n AS n, g.total AS total
		   FROM counts c JOIN grp g ON g.k = c.k
		  ORDER BY g.total DESC, c.k ASC, c.n DESC, c.v ASC
		  LIMIT 2000`
	).all<{ k: string; v: string; n: number; total: number }>();

	// Fold the flat rows into groups; the first variant per group is the most
	// frequent (already ordered n DESC), which we suggest as the canonical form.
	const groupMap = new Map<string, { canonical: string; total: number; variants: Array<{ value: string; count: number }> }>();
	for (const row of results ?? []) {
		let g = groupMap.get(row.k);
		if (!g) {
			g = { canonical: row.v, total: Number(row.total), variants: [] };
			groupMap.set(row.k, g);
		}
		g.variants.push({ value: row.v, count: Number(row.n) });
	}

	return c.json({ field, groups: [...groupMap.values()] });
});

// Consolidate the librarians' spelling variants of a value into one canonical
// form: rewrite every non-deleted book whose `field` matches one of `from` to
// `to`, recomputing the fold column so search + the fold-group stay correct.
const ConsolidateValueSchema = z.object({
	field: z.string().min(1),
	from: z.array(z.string().min(1)).min(1).max(100),
	to: z.string().min(1).max(500)
});

app.post('/api/admin/consolidate-value', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = ConsolidateValueSchema.parse(await c.req.json());
	const meta = CONSISTENCY_FIELDS[payload.field];
	if (!meta) {
		throw new HTTPException(400, { message: `Unknown field: ${payload.field}` });
	}
	const to = payload.to.trim();
	if (!to) {
		throw new HTTPException(400, { message: 'Target value cannot be blank.' });
	}
	// Don't rewrite the canonical rows onto themselves; only the OTHER spellings.
	const fromValues = payload.from.map((v) => v).filter((v) => v !== to);
	if (fromValues.length === 0) {
		return c.json({ updated: 0 });
	}

	const { column, foldColumn, foldInput } = meta;
	const placeholders = fromValues.map(() => '?').join(', ');
	const now = nowIso();

	// Count the affected books explicitly — meta.changes can over-report because
	// the books_fts triggers fire on each UPDATE and (on some D1 backends) their
	// row changes are included in the count.
	const countRow = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL AND ${column} IN (${placeholders})`
	).bind(...fromValues).first<{ n: number }>();
	const updated = Number(countRow?.n ?? 0);

	if (updated > 0) {
		if (foldColumn && foldInput) {
			// computeBookFolds returns keys like `publisher_fold`, matching foldColumn.
			const newFold = computeBookFolds({ [foldInput]: to })[foldColumn as keyof ReturnType<typeof computeBookFolds>];
			await c.env.DB.prepare(
				`UPDATE books SET ${column} = ?, ${foldColumn} = ?, updated_at = ?, version = version + 1
				 WHERE deleted_at IS NULL AND ${column} IN (${placeholders})`
			).bind(to, newFold, now, ...fromValues).run();
		} else {
			await c.env.DB.prepare(
				`UPDATE books SET ${column} = ?, updated_at = ?, version = version + 1
				 WHERE deleted_at IS NULL AND ${column} IN (${placeholders})`
			).bind(to, now, ...fromValues).run();
		}
		await bumpBooksCacheVersion(c.env);
	}
	await insertAuditLog(c.env, c.get('user').sub, 'value.consolidate', 'books', null, {
		field: payload.field, to, fromCount: fromValues.length, updated
	});

	return c.json({ updated });
});

// ── Static /api/books/* routes ───────────────────────────────────────────
// These MUST stay above `/api/books/:id`: Hono matches in registration order,
// so if `:id` is registered first it swallows /trash, /duplicates and
// /semantic and every one of those requests 404s "Book not found".
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
// ─── The library itself ───────────────────────────────────────────────────
//
// Who this catalogue belongs to. MARC 040/852, the OAI-PMH repository
// identifier and an SRU response all need it, and the ISIL is how an
// institution is named in shared records.
app.get('/api/library-settings', async (c) => {
	const rows = await c.env.DB.prepare('SELECT key, value FROM library_settings').all<{ key: string; value: string | null }>();
	const out: Record<string, string | null> = {};
	for (const r of rows.results ?? []) out[r.key] = r.value;
	return c.json({ settings: out });
});

app.put('/api/library-settings', requirePermission('setup'), async (c) => {
	const payload = z.record(z.string().max(64), z.string().max(300).nullable()).parse(await c.req.json());
	// Whitelisted: this is a key/value table, and an open write would let any
	// admin invent settings nothing reads.
	const allowed = new Set(['isil', 'libraryName', 'libraryPlace', 'catalogueLanguage', 'publicSharing', 'adminEmail']);
	const now = nowIso();
	const statements: D1PreparedStatement[] = [];
	for (const [key, value] of Object.entries(payload)) {
		if (!allowed.has(key)) continue;
		statements.push(
			c.env.DB.prepare(
				`INSERT INTO library_settings (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			).bind(key, value?.trim() || null, now)
		);
	}
	if (statements.length > 0) await runAtomic(c.env, statements);
	await insertAuditLog(c.env, c.get('user').sub, 'librarySettings.update', 'system', null, {
		keys: Object.keys(payload).filter((k) => allowed.has(k))
	});
	return c.json({ ok: true, updated: statements.length });
});

// ─── Authority control ────────────────────────────────────────────────────
//
// One controlled term with a preferred form and the variants that mean the same
// thing. Names, corporate bodies, publishers and subject headings are all the
// same kind of object, so one table serves them.
//
// Nothing here is compulsory: the free-text `author`/`publisher` columns stay
// authoritative until a book is explicitly linked, so the catalogue keeps
// working untouched while the librarian converts at their own pace.

app.get('/api/authorities', async (c) => {
	const kind = c.req.query('kind');
	const q = (c.req.query('q') ?? '').trim();
	const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));

	const where: string[] = ['a.deleted_at IS NULL'];
	const values: unknown[] = [];
	if (kind) { where.push('a.kind = ?'); values.push(kind); }
	if (q) {
		// Matches the preferred form OR any variant — the whole point of holding
		// variants is that the librarian can type the spelling they remember.
		const folded = foldDiacritics(q);
		where.push(`(a.preferred_form_fold LIKE ?
		             OR EXISTS (SELECT 1 FROM authority_variants v
		                         WHERE v.authority_id = a.id AND v.form_fold LIKE ?))`);
		values.push(`${folded}%`, `${folded}%`);
	}

	const rows = await c.env.DB.prepare(
		`SELECT a.*, (SELECT COUNT(*) FROM book_authorities ba WHERE ba.authority_id = a.id) AS use_count
		   FROM authorities a WHERE ${where.join(' AND ')}
		  ORDER BY use_count DESC, a.preferred_form ASC LIMIT ?`
	).bind(...values, limit).all<Record<string, unknown>>();

	return c.json({
		items: (rows.results ?? []).map((r) => ({
			id: r.id,
			kind: r.kind,
			preferredForm: r.preferred_form,
			preferredFormRomanized: r.preferred_form_romanized,
			source: r.source,
			viafId: r.viaf_id,
			lcId: r.lc_id,
			isni: r.isni,
			dates: r.dates,
			notes: r.notes,
			useCount: Number(r.use_count ?? 0)
		}))
	});
});

app.post('/api/authorities', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = UpsertAuthoritySchema.parse(await c.req.json());
	const now = nowIso();
	const id = newId('auth');
	const preferred = payload.preferredForm.trim();

	// One preferred form per kind. Two authority records for the same person is
	// the problem this table exists to solve, so it must not be creatable here.
	const clash = await c.env.DB.prepare(
		'SELECT id FROM authorities WHERE kind = ? AND preferred_form_fold = ? AND deleted_at IS NULL LIMIT 1'
	).bind(payload.kind, foldDiacritics(preferred)).first<{ id: string }>();
	if (clash) throw new HTTPException(409, { message: 'An authority with that preferred form already exists' });

	const statements: D1PreparedStatement[] = [
		c.env.DB.prepare(
			`INSERT INTO authorities (id, kind, preferred_form, preferred_form_romanized, preferred_form_fold,
			                          source, viaf_id, lc_id, isni, dates, notes, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(
			id, payload.kind, preferred, payload.preferredFormRomanized ?? null, foldDiacritics(preferred),
			payload.source, payload.viafId ?? null, payload.lcId ?? null, payload.isni ?? null,
			payload.dates ?? null, payload.notes ?? null, now, now
		)
	];
	for (const variant of payload.variants) {
		const form = variant.trim();
		if (!form || foldDiacritics(form) === foldDiacritics(preferred)) continue;
		statements.push(
			c.env.DB.prepare(
				'INSERT INTO authority_variants (id, authority_id, form, form_fold, created_at) VALUES (?, ?, ?, ?, ?)'
			).bind(newId('avar'), id, form, foldDiacritics(form), now)
		);
	}
	await runAtomic(c.env, statements);
	await insertAuditLog(c.env, c.get('user').sub, 'authority.create', 'authority', id, {
		kind: payload.kind, preferredForm: preferred
	});
	return c.json({ id }, 201);
});

app.get('/api/books/:id/authorities', async (c) => {
	const id = c.req.param('id') ?? '';
	const rows = await c.env.DB.prepare(
		`SELECT ba.role, ba.seq, a.id, a.kind, a.preferred_form, a.preferred_form_romanized, a.dates
		   FROM book_authorities ba JOIN authorities a ON a.id = ba.authority_id
		  WHERE ba.book_id = ? AND a.deleted_at IS NULL
		  ORDER BY ba.role ASC, ba.seq ASC`
	).bind(id).all<Record<string, unknown>>();
	return c.json({
		bookId: id,
		links: (rows.results ?? []).map((r) => ({
			authorityId: r.id,
			kind: r.kind,
			role: r.role,
			preferredForm: r.preferred_form,
			preferredFormRomanized: r.preferred_form_romanized,
			dates: r.dates
		}))
	});
});

// Whole-list replace, same shape as attributes and holdings.
app.put('/api/books/:id/authorities', requirePermission('books.write', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!book) throw new HTTPException(404, { message: 'Book not found' });

	const payload = LinkAuthoritiesSchema.parse(await c.req.json());
	const now = nowIso();
	const statements: D1PreparedStatement[] = [
		c.env.DB.prepare('DELETE FROM book_authorities WHERE book_id = ?').bind(id)
	];
	payload.links.forEach((link, index) => {
		statements.push(
			c.env.DB.prepare(
				`INSERT OR REPLACE INTO book_authorities (book_id, authority_id, role, seq, created_at)
				 VALUES (?, ?, ?, ?, ?)`
			).bind(id, link.authorityId, link.role, index, now)
		);
	});
	await runAtomic(c.env, statements);
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.authorities.replace', 'book', id, {
		count: payload.links.length
	});
	return c.json({ bookId: id, count: payload.links.length });
});

// Soft delete. The links go with it via ON DELETE CASCADE only on a hard
// delete, so they are cleared explicitly — a book must not keep pointing at a
// heading the librarian has retired.
app.delete('/api/authorities/:id', requirePermission('books.write', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const now = nowIso();
	await runAtomic(c.env, [
		c.env.DB.prepare('DELETE FROM book_authorities WHERE authority_id = ?').bind(id),
		c.env.DB.prepare('UPDATE authorities SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
			.bind(now, now, id)
	]);
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'authority.delete', 'authority', id, {});
	return c.body(null, 204);
});

// Propose subject headings from the category labels already in the catalogue.
//
// Preview only — it creates nothing. 629 distinct `category_label` values are
// the librarian's own vocabulary already, so they are the obvious seed for a
// controlled subject list, but which of them are real headings is a judgement
// call and belongs with the person who wrote them.
app.get('/api/authorities/subject-candidates', requirePermission('books.write', { librarian: true }), async (c) => {
	const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? 500)));
	const rows = await c.env.DB.prepare(
		`SELECT CAST(json_extract(custom_fields, '$.category_label') AS TEXT) AS label, COUNT(*) AS n
		   FROM books
		  WHERE deleted_at IS NULL
		    AND TRIM(COALESCE(CAST(json_extract(custom_fields, '$.category_label') AS TEXT), '')) <> ''
		  GROUP BY label ORDER BY n DESC LIMIT ?`
	).bind(limit).all<{ label: string; n: number }>();

	const existing = await c.env.DB.prepare(
		"SELECT preferred_form_fold FROM authorities WHERE kind = 'subject' AND deleted_at IS NULL"
	).all<{ preferred_form_fold: string }>();
	const known = new Set((existing.results ?? []).map((r) => r.preferred_form_fold));

	return c.json({
		items: (rows.results ?? [])
			.map((r) => ({ label: r.label, bookCount: Number(r.n ?? 0), alreadyExists: known.has(foldDiacritics(r.label)) }))
	});
});

// ─── Multi-part works: which volume is missing? ───────────────────────────
//
// "Μπορώ να κάνω έλεγχο … έπειτα να ψάξω ποιο βιβλίο λείπει" — the same
// question as the facet rail, asked of a set rather than a shelf.
//
// Reads the EXISTING data rather than requiring a migration first: `series`
// is populated on 12,514 books and `volume_num` on 644, which already yields
// ~930 real multi-book sets. Records formally joined by `set_id` (once the
// librarian has approved the grouping) take precedence over the inferred form.
//
// Clustering is done in the Worker on the diacritic fold — SQLite's LOWER() is
// ASCII-only and would leave "ΒΙΒΛΙΟΘΗΚΗ" and "Βιβλιοθήκη" as separate sets.
// Same one-scan-and-aggregate shape as /api/books/facets.
app.get('/api/books/sets', async (c) => {
	const minBooks = Math.max(1, Math.min(50, Number(c.req.query('minBooks') ?? 2)));
	const withGapsOnly = c.req.query('withGapsOnly') === 'true';
	const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200)));

	const cacheVersion = await getBooksCacheVersion(c.env);
	const cacheKey = `sets:${minBooks}:${withGapsOnly}:${limit}:${cacheVersion}`;
	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) return c.json(cached);
		} catch (error) {
			console.warn('Sets cache read failed', error);
		}
	}

	const rows = await c.env.DB.prepare(
		`SELECT b.id, b.title, b.author, b.set_id, b.volume_designation, b.custom_fields,
		        s.title AS set_title, s.expected_volumes
		   FROM books b
		   LEFT JOIN book_sets s ON s.id = b.set_id AND s.deleted_at IS NULL
		  WHERE b.deleted_at IS NULL
		    AND (b.set_id IS NOT NULL
		         OR (b.custom_fields IS NOT NULL AND b.custom_fields NOT IN ('', '{}')
		             AND TRIM(COALESCE(CAST(json_extract(b.custom_fields, '$.series') AS TEXT), '')) <> ''))`
	).all<{
		id: string; title: string; author: string; set_id: string | null;
		volume_designation: string | null; custom_fields: string;
		set_title: string | null; expected_volumes: number | null;
	}>();

	type Cluster = {
		key: string; label: string; setId: string | null; expected: number | null;
		labels: Map<string, number>; author: string; volumes: Array<string | null>; bookCount: number;
	};
	const clusters = new Map<string, Cluster>();

	for (const row of rows.results ?? []) {
		const cf = safeJsonParse<Record<string, unknown>>(row.custom_fields ?? '{}', {});
		const series = String(row.set_title ?? cf.series ?? '').trim();
		if (!series) continue;
		// 7,144 rows have `series` equal to their own title — an import artifact,
		// not a set. Dropped PER BOOK, so one member whose title happens to match
		// the series name cannot disqualify a genuine set.
		if (!row.set_id && foldDiacritics(series) === foldDiacritics(row.title ?? '')) continue;

		// Grouped on the EXACT series string, not its fold.
		//
		// Folding would merge accent/case variants, but measured against this
		// catalogue it merges exactly ONE pair out of ~930 sets (an ellipsis
		// character), and it would break the rule that a count in the rail opens
		// a list of the same size — clicking a set filters on the exact spelling.
		// Two spellings showing as two sets is also the more useful answer: it
		// surfaces an inconsistency the existing value-consistency merge tool can
		// fix, instead of hiding it. (The series-equals-title test below still
		// folds; that is a different comparison.)
		const key = row.set_id ?? `series:${series}`;
		let cluster = clusters.get(key);
		if (!cluster) {
			cluster = {
				key, label: series, setId: row.set_id, expected: row.expected_volumes ?? null,
				labels: new Map(), author: row.author ?? '', volumes: [], bookCount: 0
			};
			clusters.set(key, cluster);
		}
		// Display the most frequent original spelling, the way the value facets do.
		cluster.labels.set(series, (cluster.labels.get(series) ?? 0) + 1);
		cluster.volumes.push(row.volume_designation ?? (cf.volume_num as string | null) ?? null);
		cluster.bookCount += 1;
	}

	const items = [...clusters.values()]
		.filter((cluster) => cluster.bookCount >= minBooks)
		.map((cluster) => {
			const label = [...cluster.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? cluster.label;
			const gaps = computeSetGaps(cluster.volumes, cluster.expected);
			return {
				key: cluster.key,
				setId: cluster.setId,
				title: label,
				sampleAuthor: cluster.author,
				bookCount: cluster.bookCount,
				expectedVolumes: cluster.expected,
				minVol: gaps.minVol,
				maxVol: gaps.maxVol,
				unnumbered: gaps.unnumbered,
				gapsAvailable: gaps.gapsAvailable,
				// Capped: a report is for acting on, and a thousand-entry list is not.
				missing: gaps.missing.slice(0, 200),
				missingCount: gaps.missing.length
			};
		})
		.filter((item) => (withGapsOnly ? item.gapsAvailable && item.missingCount > 0 : true))
		.sort((a, b) => b.missingCount - a.missingCount || b.bookCount - a.bookCount)
		.slice(0, limit);

	const response = { items, total: items.length };
	if (c.env.CACHE) {
		try {
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 86400 });
		} catch (error) {
			console.warn('Sets cache write failed', error);
		}
	}
	return c.json(response);
});

// ─── Facet browser ───────────────────────────────────────────────────────
// Counts of books per distinct value of one field, for the left-hand rail.
//
// Generalized from the old category-only browser because the librarian needs to
// reconcile the catalogue against the shelves: "μπορώ να κάνω έλεγχο αριθμητικό
// επιτόπου στο ράφι και αν δεν συμφωνεί ο αριθμός αυτός με τον αριθμό των
// καταχωρήσεων στη βάση … έπειτα να ψάξω ποιο βιβλίο λείπει." A count is only
// useful for that if it is exactly reproducible as a filtered list, which is
// why the `(empty)` predicate below and the one in db.ts must stay identical.
//
// The field whitelist lives in db.ts alongside the list filter that has to
// agree with it — see `resolveEmptyFieldExpr`.

// ─── Merging duplicate records ────────────────────────────────────────────
//
// The librarian catalogued ~44 books twice, once per shelf, because before the
// holdings layer there was no other way to record a second exemplar. Each of
// those pairs should be ONE record with two copies.
//
// Everything here is preview-first. A merge soft-deletes records and moves
// their holdings; the operator sees the exact consequences before anything
// moves, and 5 of those 44 have no twin at all — a genuinely different book or
// a typo — so this can never be a script that runs unattended.

/** Fields compared side by side so the operator can see what differs. */
const MERGE_COMPARE_FIELDS = [
	'title', 'author', 'isbn', 'publisher', 'language', 'dateEdtf', 'ddc',
	'description', 'legacyId', 'titleRomanized', 'authorRomanized'
] as const;

app.get('/api/books/merge-candidates', requirePermission('books.write', { librarian: true }), async (c) => {
	const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 25)));
	const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
	// Default strict: on this catalogue the loose match finds 367 groups, most
	// of them different printings that must NOT be merged. Strict is the
	// back-shelf duplication the librarian actually asked to clean up.
	const strict = c.req.query('match') !== 'loose';
	const { groups, total } = await loadMergeCandidateGroups(c.env, {
		limit, offset, strict, q: c.req.query('q') ?? ''
	});

	const allIds = groups.flatMap((g) => g.bookIds);
	if (allIds.length === 0) return c.json({ groups: [], total, limit, offset });

	const ph = allIds.map(() => '?').join(',');
	const [rows, itemsByBook] = await Promise.all([
		c.env.DB.prepare(`SELECT * FROM books WHERE id IN (${ph})`).bind(...allIds).all<Record<string, unknown>>(),
		loadItemsForBooks(c.env, allIds)
	]);
	const byId = new Map((rows.results ?? []).map((r) => [String(r.id), parseBook(r)]));

	// Open loans block a merge, so surface them here rather than letting the
	// operator pick a group and only then discover it cannot proceed.
	const loans = await c.env.DB.prepare(
		`SELECT book_id, COUNT(*) AS n FROM borrow_transactions
		  WHERE returned_at IS NULL AND book_id IN (${ph}) GROUP BY book_id`
	).bind(...allIds).all<{ book_id: string; n: number }>();
	const openLoans = new Map((loans.results ?? []).map((r) => [r.book_id, Number(r.n)]));

	return c.json({
		total, limit, offset,
		groups: groups.map((g) => {
			const books = g.bookIds.map((id) => byId.get(id)).filter(Boolean) as Array<Record<string, unknown>>;
			// Which fields actually differ across the group — the operator only
			// needs to look at those, not at every column.
			const differing = MERGE_COMPARE_FIELDS.filter((f) => {
				const seen = new Set(books.map((b) => JSON.stringify(b[f] ?? null)));
				return seen.size > 1;
			});
			return {
				key: g.key,
				differingFields: differing,
				books: books.map((b) => ({
					id: b.id,
					title: b.title,
					author: b.author,
					isbn: b.isbn,
					publisher: b.publisher,
					dateEdtf: b.dateEdtf,
					legacyId: b.legacyId,
					updatedAt: b.updatedAt,
					// How many attributes carry a value — the fullest record is
					// usually the right one to keep.
					filledFields: MERGE_COMPARE_FIELDS.filter((f) => {
						const v = b[f];
						return v !== null && v !== undefined && String(v).trim() !== '';
					}).length + Object.values((b.customFields ?? {}) as Record<string, unknown>)
						.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').length,
					openLoans: openLoans.get(String(b.id)) ?? 0,
					items: (itemsByBook.get(String(b.id)) ?? []).map((i) => ({
						id: i.id, shelfCode: i.shelfCode, roomCode: i.roomCode,
						copyNumber: i.copyNumber, status: i.status, barcode: i.barcode
					}))
				}))
			};
		})
	});
});

app.post('/api/books/merge', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = MergeBooksSchema.parse(await c.req.json());
	const mergeIds = payload.mergeIds.filter((id) => id !== payload.keepId);
	if (mergeIds.length === 0) throw new HTTPException(400, { message: 'Nothing to merge into the kept record' });

	const ids = [payload.keepId, ...mergeIds];
	const ph = ids.map(() => '?').join(',');
	const rows = await c.env.DB.prepare(
		`SELECT * FROM books WHERE id IN (${ph}) AND deleted_at IS NULL`
	).bind(...ids).all<Record<string, unknown>>();
	const byId = new Map((rows.results ?? []).map((r) => [String(r.id), parseBook(r)]));

	const keeper = byId.get(payload.keepId);
	if (!keeper) throw new HTTPException(404, { message: 'The record to keep was not found' });
	const missing = mergeIds.filter((id) => !byId.has(id));
	if (missing.length) throw new HTTPException(404, { message: `Not found: ${missing.join(', ')}` });

	// A record on loan cannot be merged away: the loan points at the book, and
	// moving it would rewrite the borrower's history under them.
	//
	// The KEEPER is checked too. It is not being moved, but the merge ends by
	// re-deriving its status from its copies and renumbering them, and a
	// borrower is holding one of those copies. Before 0028 this hole silently
	// freed a record whose loan was still open.
	const loans = await c.env.DB.prepare(
		`SELECT book_id FROM borrow_transactions WHERE returned_at IS NULL AND book_id IN (${ids.map(() => '?').join(',')})`
	).bind(...ids).all<{ book_id: string }>();
	if ((loans.results ?? []).length > 0) {
		throw new HTTPException(409, {
			message: 'Cannot merge a record that is on loan. Return it first.'
		});
	}

	// Fill the keeper's BLANKS from the records being folded in — a merge must
	// never lose a value someone typed. A field the keeper already has always
	// wins; this only rescues what would otherwise be deleted with the loser.
	const filled: Record<string, unknown> = {};
	const rescuedCustom: Record<string, unknown> = { ...((keeper.customFields ?? {}) as Record<string, unknown>) };
	const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
	for (const id of mergeIds) {
		const loser = byId.get(id) as Record<string, unknown>;
		for (const f of MERGE_COMPARE_FIELDS) {
			// legacyId is UNIQUE — copying it across would collide with the row we
			// are about to soft-delete, which still holds it.
			if (f === 'legacyId') continue;
			if (blank(keeper[f]) && blank(filled[f]) && !blank(loser[f])) filled[f] = loser[f];
		}
		for (const [k, v] of Object.entries((loser.customFields ?? {}) as Record<string, unknown>)) {
			if (blank(rescuedCustom[k]) && !blank(v)) rescuedCustom[k] = v;
		}
	}
	const mergedTags = Array.from(new Set([
		...((keeper.tags ?? []) as string[]),
		...mergeIds.flatMap((id) => ((byId.get(id)?.tags ?? []) as string[]))
	]));

	const itemsByBook = await loadItemsForBooks(c.env, ids);
	const movingItems = mergeIds.flatMap((id) => itemsByBook.get(id) ?? []);
	const keeperItems = itemsByBook.get(payload.keepId) ?? [];

	if (payload.dryRun) {
		return c.json({
			dryRun: true,
			keepId: payload.keepId,
			mergeIds,
			// Exactly what would change, so the operator judges before committing.
			wouldFillFields: filled,
			wouldRescueAttributes: Object.fromEntries(
				Object.entries(rescuedCustom).filter(([k, v]) =>
					blank(((keeper.customFields ?? {}) as Record<string, unknown>)[k]) && !blank(v))
			),
			wouldAddTags: mergedTags.filter((t) => !((keeper.tags ?? []) as string[]).includes(t)),
			copiesAfter: keeperItems.length + movingItems.length,
			copiesMoving: movingItems.map((i) => ({ shelfCode: i.shelfCode, copyNumber: i.copyNumber })),
			recordsRemoved: mergeIds.length
		});
	}

	const now = nowIso();
	const statements: D1PreparedStatement[] = [];
	const mergePh = mergeIds.map(() => '?').join(',');

	// The copies move — this IS the merge. Renumbered so the survivor's copies
	// read 1..n rather than repeating whatever numbers they had apart.
	let copyNumber = keeperItems.length;
	for (const item of movingItems) {
		copyNumber += 1;
		statements.push(
			c.env.DB.prepare('UPDATE items SET book_id = ?, copy_number = ?, updated_at = ? WHERE id = ?')
				.bind(payload.keepId, copyNumber, now, item.id)
		);
	}

	// Everything else that points at a book has to follow it, or it is orphaned:
	// loan history (so a borrower's record stays intact), printed codes, and
	// authority links.
	statements.push(
		c.env.DB.prepare(`UPDATE borrow_transactions SET book_id = ? WHERE book_id IN (${mergePh})`).bind(payload.keepId, ...mergeIds),
		c.env.DB.prepare(`UPDATE code_assignments SET book_id = ? WHERE book_id IN (${mergePh})`).bind(payload.keepId, ...mergeIds),
		// OR IGNORE: the same authority may already be linked to the keeper, and
		// (book_id, authority_id, role) is the primary key.
		c.env.DB.prepare(
			`INSERT OR IGNORE INTO book_authorities (book_id, authority_id, role, seq, created_at)
			 SELECT ?, authority_id, role, seq, ? FROM book_authorities WHERE book_id IN (${mergePh})`
		).bind(payload.keepId, now, ...mergeIds),
		c.env.DB.prepare(`DELETE FROM book_authorities WHERE book_id IN (${mergePh})`).bind(...mergeIds),
		// Serial run statements ("vol. 1–10, 12 missing") describe the title, so
		// they belong to whichever record survives it.
		c.env.DB.prepare(`UPDATE serial_holdings SET book_id = ? WHERE book_id IN (${mergePh})`).bind(payload.keepId, ...mergeIds),
		// A bound-with link says "this work is also in that physical volume". If
		// the keeper is already linked to the same item the row is redundant.
		c.env.DB.prepare(
			`INSERT OR IGNORE INTO bound_with_items (item_id, book_id, seq, created_at)
			 SELECT item_id, ?, seq, ? FROM bound_with_items WHERE book_id IN (${mergePh})`
		).bind(payload.keepId, now, ...mergeIds),
		c.env.DB.prepare(`DELETE FROM bound_with_items WHERE book_id IN (${mergePh})`).bind(...mergeIds),
		// The normalized attribute table mirrors custom_fields. Only rows for
		// definitions the keeper has no value for can move — UNIQUE(book_id,
		// attribute_definition_id) — which matches the "keeper's value wins" rule
		// applied to custom_fields above.
		c.env.DB.prepare(
			`INSERT OR IGNORE INTO book_attribute_values (id, book_id, attribute_definition_id, value_json, created_at, updated_at)
			 SELECT LOWER(HEX(RANDOMBLOB(16))), ?, attribute_definition_id, value_json, ?, ?
			   FROM book_attribute_values WHERE book_id IN (${mergePh})`
		).bind(payload.keepId, now, now, ...mergeIds),
		c.env.DB.prepare(`DELETE FROM book_attribute_values WHERE book_id IN (${mergePh})`).bind(...mergeIds)
	);

	// Apply the rescued values to the keeper.
	const merged = normalizeBookData({
		...keeper,
		...filled,
		customFields: rescuedCustom,
		tags: mergedTags
	} as Record<string, unknown>) as Record<string, unknown>;
	const tagsJson = JSON.stringify(merged.tags ?? []);
	const cfJson = JSON.stringify(await validateCustomFields(c.env, merged.customFields as Record<string, unknown>));
	const folds = computeBookFolds({
		title: merged.title as string, author: merged.author as string,
		isbn: (merged.isbn as string | null) ?? null, publisher: (merged.publisher as string | null) ?? null,
		description: (merged.description as string | null) ?? null,
		tagsJson, customFieldsJson: cfJson,
		titleRomanized: (merged.titleRomanized as string | null) ?? null,
		authorRomanized: (merged.authorRomanized as string | null) ?? null,
		publisherRomanized: (merged.publisherRomanized as string | null) ?? null
	});
	statements.push(
		c.env.DB.prepare(
			`UPDATE books SET title = ?, author = ?, isbn = ?, publisher = ?, language = ?, description = ?,
			        ddc = ?, date_edtf = ?, publication_year = ?, publication_year_end = ?,
			        title_romanized = ?, author_romanized = ?, publisher_romanized = ?,
			        tags = ?, custom_fields = ?, updated_at = ?, version = version + 1,
			        title_fold = ?, author_fold = ?, isbn_fold = ?, publisher_fold = ?, description_fold = ?,
			        tags_fold = ?, custom_fields_fold = ?,
			        title_romanized_fold = ?, author_romanized_fold = ?, publisher_romanized_fold = ?
			  WHERE id = ?`
		).bind(
			merged.title, merged.author, merged.isbn ?? null, merged.publisher ?? null,
			merged.language ?? null, merged.description ?? null, merged.ddc ?? null,
			merged.dateEdtf ?? null, merged.publicationYear ?? null, merged.publicationYearEnd ?? null,
			merged.titleRomanized ?? null, merged.authorRomanized ?? null, merged.publisherRomanized ?? null,
			tagsJson, cfJson, now,
			folds.title_fold, folds.author_fold, folds.isbn_fold, folds.publisher_fold, folds.description_fold,
			folds.tags_fold, folds.custom_fields_fold,
			folds.title_romanized_fold, folds.author_romanized_fold, folds.publisher_romanized_fold,
			payload.keepId
		),
		// The tombstone. `merged_into` is the forwarding address for an old label,
		// a bookmarked URL, or an OAI-PMH harvester holding the identifier.
		c.env.DB.prepare(
			`UPDATE books SET deleted_at = ?, merged_into = ?, updated_at = ?, version = version + 1
			  WHERE id IN (${mergePh})`
		).bind(now, payload.keepId, now, ...mergeIds)
	);

	for (let i = 0; i < statements.length; i += 40) {
		await runAtomic(c.env, statements.slice(i, i + 40));
	}
	await syncBookFromItems(c.env, payload.keepId);
	await bumpBooksCacheVersion(c.env);
	// The folded-in records must stop coming back from semantic search.
	for (const id of mergeIds) runAfterResponse(c, () => unvectorizeBook(c.env, id));
	await insertAuditLog(c.env, c.get('user').sub, 'book.merge', 'book', payload.keepId, {
		mergedIds: mergeIds,
		filledFields: Object.keys(filled),
		copiesMoved: movingItems.length,
		// Item id → where it came from. Restoring a merged record cannot infer
		// this (the copy is not deleted, just re-parented), so the log is the
		// only record of which copy belonged to which record before the merge.
		movedItems: movingItems.map((i) => ({ itemId: i.id, from: i.bookId }))
	});

	return c.json({
		dryRun: false,
		keepId: payload.keepId,
		mergedIds: mergeIds,
		copiesMoved: movingItems.length,
		copiesAfter: (await loadBookItems(c.env, payload.keepId)).length,
		filledFields: Object.keys(filled)
	});
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
		codes: codes.results,
		items: await loadBookItems(c.env, id)
	});
});

app.post('/api/books', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = normalizeBookData(CreateBookSchema.parse(await c.req.json()));
	// No create path establishes a loan row, so 'borrowed' at create time is
	// always a phantom (dashboard borrowed-counts would diverge from open loans).
	// Coerce to available; lending is done via the borrow action.
	if (payload.status === 'borrowed') payload.status = 'available';
	const now = nowIso();
	// Derive the row id from the client's mutation id when there is one, and
	// INSERT OR IGNORE below. The idempotency middleware already replays a
	// recorded response, but it only records 2xx — so if the INSERT committed
	// and a LATER step (cache bump, audit log) turned the request into a 500,
	// the client's retry re-ran the whole handler and added a second copy of
	// the book. A deterministic id makes the retry land on the same row.
	const clientMutationId = c.req.header('x-client-mutation-id');
	const id = clientMutationId
		? await deterministicUuid(`create_book:${clientMutationId}`)
		: crypto.randomUUID();
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
		customFieldsJson,
		titleRomanized: payload.titleRomanized ?? null,
		authorRomanized: payload.authorRomanized ?? null,
		publisherRomanized: payload.publisherRomanized ?? null
	});

	await c.env.DB.prepare(
		`INSERT OR IGNORE INTO books (
			id, title, author, isbn, publication_year, publication_year_end, date_edtf,
			publisher, language, description, ddc,
			title_romanized, author_romanized, publisher_romanized,
			room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
			legacy_id, created_at, updated_at, deleted_at,
			title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold,
			title_romanized_fold, author_romanized_fold, publisher_romanized_fold
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			payload.title,
			payload.author,
			payload.isbn ?? null,
			payload.publicationYear ?? null,
			payload.publicationYearEnd ?? payload.publicationYear ?? null,
			payload.dateEdtf ?? null,
			payload.publisher ?? null,
			payload.language ?? null,
			payload.description ?? null,
			payload.ddc ?? null,
			payload.titleRomanized ?? null,
			payload.authorRomanized ?? null,
			payload.publisherRomanized ?? null,
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
			folds.custom_fields_fold,
			folds.title_romanized_fold,
			folds.author_romanized_fold,
			folds.publisher_romanized_fold
		)
		.run();

	await replaceBookAttributeValues(c.env, id, customFields);
	// Every record needs a copy from the moment it exists, or it is invisible to
	// every location filter and facet — those read holdings now, not the record.
	await ensurePrimaryItem(c.env, id, payload);
	// The book is already committed. A failure to invalidate the cache is a
	// staleness problem, not a reason to report failure — reporting failure
	// makes the client retry a write that already succeeded.
	try {
		await bumpBooksCacheVersion(c.env);
	} catch (error) {
		console.warn('Cache version bump failed after book create, continuing', error);
	}

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

	try {
		await insertAuditLog(c.env, c.get('user').sub, 'book.create', 'book', id, {
			title: payload.title,
			author: payload.author
		});
	} catch (error) {
		console.warn('Audit log failed for book.create, continuing', error);
	}

	// Duplicate check: warn if another non-deleted book has the same title+author.
	// Matched on the *_fold columns (indexed, and already accent/case folded in
	// JS so Greek folds too — SQLite's LOWER() is ASCII-only). The previous
	// LOWER(TRIM(title)) form could not use an index and therefore scanned all
	// ~12.5K rows on every single book added.
	//
	// The legacy '(Unknown)'/'(Untitled)' sentinels canonicalize to '' on both
	// sides so a re-catalogued legacy book still matches the same title added
	// with a blank author, and vice versa.
	const dupFolds = computeBookFolds({ title: payload.title, author: payload.author });
	// A blank value folds to NULL, while legacy rows spell the same thing
	// '(untitled)'/'(unknown)'. Match either spelling by giving each column two
	// candidate values. `IS` rather than `=` so the NULL candidate matches, and
	// unlike COALESCE(col, '') it leaves the column bare so the fold index is
	// still usable.
	const dupTitles: Array<string | null> =
		dupFolds.title_fold === null ? [null, '(untitled)']
		: dupFolds.title_fold === '(untitled)' ? ['(untitled)', null]
		: [dupFolds.title_fold, dupFolds.title_fold];
	const dupAuthors: Array<string | null> =
		dupFolds.author_fold === null ? [null, '(unknown)']
		: dupFolds.author_fold === '(unknown)' ? ['(unknown)', null]
		: [dupFolds.author_fold, dupFolds.author_fold];
	// One indexed probe per candidate pair (at most four, normally one). An
	// `OR` across the alternatives would have forced SQLite back to scanning
	// every active row, which is the whole cost this is avoiding.
	const dupSeen = new Map<string, { id: string; title: string; author: string }>();
	const dupPairs = new Set<string>();
	for (const tf of new Set(dupTitles)) {
		for (const af of new Set(dupAuthors)) {
			const key = `${tf ?? '\u0000'}|${af ?? '\u0000'}`;
			if (dupPairs.has(key)) continue;
			dupPairs.add(key);
			const hit = await c.env.DB.prepare(
				`SELECT id, title, author FROM books
				 WHERE deleted_at IS NULL AND id != ? AND title_fold IS ? AND author_fold IS ?
				 LIMIT 20`
			)
				.bind(id, tf, af)
				.all<{ id: string; title: string; author: string }>();
			for (const r of hit.results ?? []) dupSeen.set(r.id, r);
		}
	}

	const duplicateOf = Array.from(dupSeen.values()).slice(0, 20);

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
	await assertPatchKeepsRequiredFields(c.env, payload);
	// Patch first, validate second. Validating only the whole-value form would
	// let a bulk edit slip an unchecked value past the type/enum rules — a
	// string into a number field, say — and books carrying an invalid value
	// become unsaveable the next time anyone opens them.
	const customFields = await validateCustomFields(
		c.env,
		applyBookPatchFields(
			{
				customFields: (payload.customFields ??
					JSON.parse((existingMap.custom_fields as string) ?? '{}')) as Record<string, unknown>,
				tags: []
			},
			payload
		).customFields,
		{
			requireAllRequired: payload.customFields !== undefined,
			rejectUnknownKeys: false
		}
	);
	// Preserve values whose custom-field DEFINITION was soft-deleted. validate…
	// strips keys with no live definition, so without this an unrelated edit
	// would silently destroy the book's stored value and make definition
	// deletion irreversible. Re-merge orphaned keys from the existing row.
	{
		const existingCustom = JSON.parse((existingMap.custom_fields as string) ?? '{}') as Record<string, unknown>;
		const liveKeys = new Set((await loadCustomFieldDefs(c.env)).map((d) => d.field_key));
		// …except keys the patch explicitly cleared. Re-merging those would undo
		// the deletion the caller just asked for, so clearing an attribute whose
		// definition had been soft-deleted would silently never take effect.
		const explicitlyCleared = new Set(
			Object.entries(payload.customFieldsPatch ?? {})
				.filter(([, value]) => value === null || (typeof value === 'string' && value.trim() === ''))
				.map(([key]) => key)
		);
		for (const [k, v] of Object.entries(existingCustom)) {
			if (!liveKeys.has(k) && !(k in customFields) && !explicitlyCleared.has(k)) customFields[k] = v;
		}
	}
	// customFieldsPatch was already folded in above (before validation); only the
	// tag add/remove still needs applying here.
	const patched = applyBookPatchFields(
		{
			customFields,
			tags: (payload.tags ?? JSON.parse((existingMap.tags as string) ?? '[]')) as string[]
		},
		{ tagsAdd: payload.tagsAdd, tagsRemove: payload.tagsRemove }
	);

	const merged = {
		...parseBook(existingMap),
		...payload,
		tags: patched.tags,
		customFields: patched.customFields,
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
		customFieldsJson: mergedCustomFieldsJson,
		titleRomanized: (merged.titleRomanized as string | null) ?? null,
		authorRomanized: (merged.authorRomanized as string | null) ?? null,
		publisherRomanized: (merged.publisherRomanized as string | null) ?? null
	});

	const updateBookStmt = c.env.DB.prepare(
		`UPDATE books SET
			title = ?, author = ?, isbn = ?, publication_year = ?, publication_year_end = ?, date_edtf = ?,
			publisher = ?, language = ?, description = ?, ddc = ?,
			title_romanized = ?, author_romanized = ?, publisher_romanized = ?,
			room_code = ?, shelf_code = ?, acquisition_date = ?, tags = ?, custom_fields = ?, status = ?,
			legacy_id = ?, version = ?, updated_at = ?,
			title_fold = ?, author_fold = ?, isbn_fold = ?, publisher_fold = ?, description_fold = ?, tags_fold = ?, custom_fields_fold = ?,
			title_romanized_fold = ?, author_romanized_fold = ?, publisher_romanized_fold = ?
		 WHERE id = ? AND deleted_at IS NULL AND version = ?`
	)
		.bind(
			merged.title,
			merged.author,
			merged.isbn ?? null,
			merged.publicationYear ?? null,
			merged.publicationYearEnd ?? merged.publicationYear ?? null,
			merged.dateEdtf ?? null,
			merged.publisher ?? null,
			merged.language ?? null,
			merged.description ?? null,
			merged.ddc ?? null,
			merged.titleRomanized ?? null,
			merged.authorRomanized ?? null,
			merged.publisherRomanized ?? null,
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
			mergedFolds.title_romanized_fold,
			mergedFolds.author_romanized_fold,
			mergedFolds.publisher_romanized_fold,
			id,
			// Concurrency guard lives in the WHERE clause, not just the earlier
			// read: comparing the version and THEN updating is check-then-act, so
			// two simultaneous saves both passed the check and the second silently
			// overwrote the first. Matching on the version we read makes the write
			// itself conditional — a loser changes 0 rows and is reported below.
			currentVersion
		);

	if (closeOpenLoanOnWrite) {
		// Atomically close the open loan when a borrowed book is marked lost/
		// maintenance, so no phantom active loan is left behind. Since 0028 the
		// copies carry the status too, and they must move with the record or
		// syncBookFromItems will put the record straight back to 'borrowed'.
		await runAtomic(c.env, [
			c.env.DB.prepare(
				`UPDATE items SET status = ?, version = version + 1, updated_at = ?
				  WHERE deleted_at IS NULL AND status = 'borrowed'
				    AND id IN (SELECT item_id FROM borrow_transactions
				                WHERE book_id = ? AND returned_at IS NULL AND item_id IS NOT NULL)`
			).bind(merged.status, now, id),
			c.env.DB.prepare(
				`UPDATE borrow_transactions
				    SET returned_at = ?, notes = TRIM(COALESCE(notes, '') || ' [auto-closed: marked ' || ? || ']')
				  WHERE book_id = ? AND returned_at IS NULL`
			).bind(now, merged.status, id),
			updateBookStmt
		]);
	} else {
		const res = await updateBookStmt.run();
		if ((res.meta?.changes ?? 0) === 0) {
			// Someone else committed between our read and this write.
			throw new HTTPException(409, { message: 'Version conflict. Refresh and retry.' });
		}
	}

	await replaceBookAttributeValues(c.env, id, merged.customFields as Record<string, unknown>);
	// The single-book form edits the record's own shelf; carry it to the primary
	// copy so location filters agree with what the librarian just saved.
	await ensurePrimaryItem(c.env, id, merged as { shelfCode?: string | null; roomCode?: string | null });
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

	// A record's copies go with it, so a deleted book stops appearing in shelf
	// facets and location filters — those read holdings now.
	//
	// Stamped with the SAME `now` the book row got, not a fresh one: restore
	// matches on that timestamp to bring back exactly these copies and not ones
	// the librarian had removed earlier.
	if (id) await setItemsDeleted(c.env, id, now);
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
	// Read the deletion stamp BEFORE clearing it: it identifies exactly which
	// copies went down with the record, as opposed to ones the librarian had
	// already removed. Restoring all of them would put books back on shelves
	// they are not on.
	const trashed = await c.env.DB.prepare(
		'SELECT deleted_at, merged_into, shelf_code, room_code FROM books WHERE id = ? AND deleted_at IS NOT NULL'
	).bind(id).first<{ deleted_at: string; merged_into: string | null; shelf_code: string | null; room_code: string | null }>();
	const result = await c.env.DB.prepare(
		// Clearing `merged_into` is part of coming back: the record is no longer
		// forwarding anywhere. Its copies stay with the keeper — they were moved,
		// not deleted — so the fresh copy minted below is what puts it on a shelf
		// again. The merge's audit log names the item ids if they must go back.
		`UPDATE books SET deleted_at = NULL, merged_into = NULL, updated_at = ?, version = version + 1
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
	// Bring the copies back with the record — restore must return it to the
	// shelf it was on, not leave it holdings-less.
	await restoreItemsDeletedAt(c.env, id, trashed?.deleted_at ?? null);
	// A merged-away record has no copies to restore — they left with the merge.
	// Every live record must have at least one copy (the invariant the healing
	// pass enforces), so mint one. NOT `ensurePrimaryItem`: its deterministic
	// `itm_<bookId>` is the very row that moved to the keeper, and re-inserting
	// it would collide.
	if (trashed?.merged_into) {
		const live = await c.env.DB.prepare(
			'SELECT COUNT(*) AS n FROM items WHERE book_id = ? AND deleted_at IS NULL'
		).bind(id).first<{ n: number }>();
		if (Number(live?.n ?? 0) === 0) {
			await c.env.DB.prepare(
				`INSERT INTO items (id, book_id, copy_number, room_code, shelf_code, item_type, status,
				                    created_at, updated_at, version)
				 VALUES (?, ?, 1, ?, ?, 'book', 'available', ?, ?, 0)`
			).bind(newId('itm'), id, trashed.room_code, trashed.shelf_code, now, now).run();
		}
	}
	await insertAuditLog(c.env, c.get('user').sub, 'book.restore', 'book', id, {
		unmergedFrom: trashed?.merged_into ?? null
	});
	return c.json({ id, restored: true });
});

// List soft-deleted books — the "trash" view. Admin-only. Paged so a runaway
// bulk-delete doesn't return a 12K-row payload.

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
		// Before the book row: items hold an FK to it, and purge is a hard delete.
		c.env.DB.prepare('DELETE FROM bound_with_items WHERE book_id = ?').bind(id),
		c.env.DB.prepare('DELETE FROM items WHERE book_id = ?').bind(id),
		// A record that absorbed a merge is pointed at by its tombstones, and
		// `merged_into` is a real foreign key — without this the DELETE below
		// fails and the record can never leave the trash. There is no forwarding
		// address left to keep once the destination is gone.
		c.env.DB.prepare('UPDATE books SET merged_into = NULL WHERE merged_into = ?').bind(id),
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
	// already-overdue loans. An absent dueAt is not a typo — it means "use the
	// policy", which is the normal case since 0029.
	if (payload.dueAt && Date.parse(payload.dueAt) <= Date.now()) {
		throw new HTTPException(400, { message: 'dueAt must be in the future.' });
	}

	const { borrowerId, borrowerName, borrowerContact } = await resolveBorrower(c.env, payload);

	// Which physical copy leaves the building. The operator may name one — that
	// is what scanning a copy's barcode does — otherwise the lowest-numbered
	// free copy goes. Before migration 0028 a loan named only the record, so a
	// two-copy book could be lent exactly once.
	//
	// A copy set aside for THIS borrower's own hold is fair game: handing over a
	// hold is exactly what collecting one means.
	const item = await pickLendableItem(c.env, bookId ?? '', payload.itemId ?? null, borrowerId);
	if (!item) {
		const exists = await c.env.DB.prepare('SELECT status FROM books WHERE id = ? AND deleted_at IS NULL')
			.bind(bookId).first<{ status: string }>();
		if (!exists) throw new HTTPException(404, { message: 'Book not found' });
		// A copy held for somebody else is a different situation from no copy at
		// all, and the operator needs to know which.
		const heldFor = await c.env.DB.prepare(
			`SELECT h.borrower_name FROM holds h JOIN items i ON i.id = h.item_id
			  WHERE i.book_id = ? AND h.status = 'ready' LIMIT 1`
		).bind(bookId).first<{ borrower_name: string }>();
		if (heldFor) {
			throw new HTTPException(409, {
				message: `The available copy is being held for ${heldFor.borrower_name}.`
			});
		}
		throw new HTTPException(409, {
			message: payload.itemId ? 'That copy is not available' : 'No copy of this book is available'
		});
	}

	// The rule for this reader and this kind of copy. It decides how long the
	// loan runs, whether the copy may leave at all, and how many the reader may
	// hold at once — replacing three hard-coded buttons in the web app and a
	// hard-coded 14 in the mobile one.
	const category = borrowerId
		? (await c.env.DB.prepare('SELECT category FROM borrowers WHERE id = ?').bind(borrowerId)
			.first<{ category: string }>())?.category ?? 'standard'
		: 'standard';
	const policy = await resolveLoanPolicy(c.env, category, item.itemType);
	if (!policy.lendable) {
		throw new HTTPException(409, {
			message: 'This is a consultation-only copy and cannot be lent.'
		});
	}
	// An explicit dueAt is an override the librarian is entitled to make; the
	// policy is the default, not a cage. The audit log records both so an
	// override is visible afterwards.
	const dueAt = payload.dueAt ?? dueDateFromPolicy(policy.loanDays);
	const policyDueAt = dueDateFromPolicy(policy.loanDays);

	const now = nowIso();
	const txId = crypto.randomUUID();

	// A loan is three facts that must be true together: the ledger row exists,
	// the copy reads as 'borrowed', and the record agrees. Writing them as
	// independent statements meant a crash between them left a copy flagged
	// borrowed with nobody on the hook for it, and the compensating revert that
	// tried to paper over that could itself fail. One batch = one D1
	// transaction, so all three land or none do.
	//
	// The INSERT and the copy UPDATE carry the SAME availability guard, so a
	// concurrent borrow that wins the race makes both no-ops rather than
	// inserting an orphan ledger row. The INSERT runs first for exactly that
	// reason — after the UPDATE the copy is no longer 'available' and its own
	// guard would never match. `idx_borrow_active_item` is the backstop.
	// The cap lives INSIDE the insert's guard, not in a read before it. Checking
	// "does this borrower already have N out?" and then inserting is
	// check-then-act: two borrows arriving together both pass a read of N-1.
	// Folded into the WHERE, the second one simply inserts nothing.
	const capClause = policy.maxConcurrentLoans != null && borrowerId
		? ` AND (SELECT COUNT(*) FROM borrow_transactions t2
		          WHERE t2.borrower_id = ? AND t2.returned_at IS NULL) < ?`
		: '';
	const guard = `(SELECT 1 FROM items i
			 WHERE i.id = ? AND i.deleted_at IS NULL AND i.status = 'available'
			   AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
			                    WHERE t.item_id = i.id AND t.returned_at IS NULL)
			   AND NOT EXISTS (SELECT 1 FROM holds h
			                    WHERE h.item_id = i.id AND h.status = 'ready'
			                      AND (h.borrower_id IS NULL OR h.borrower_id <> ?))${capClause})`;
	const borrowResults = await runAtomic(c.env, [
		c.env.DB.prepare(
			`INSERT INTO borrow_transactions (
				id, book_id, item_id, borrower_id, borrower_name, borrower_contact, borrowed_at, due_at, returned_at, notes, created_by, updated_at
			)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
			 WHERE EXISTS ${guard}`
		).bind(
			txId,
			bookId,
			item.id,
			borrowerId,
			borrowerName,
			borrowerContact,
			now,
			dueAt,
			payload.notes ?? null,
			c.get('user').sub,
			now,
			item.id,
			borrowerId,
			...(capClause ? [borrowerId, policy.maxConcurrentLoans] : [])
		),
		c.env.DB.prepare(
			`UPDATE items SET status = 'borrowed', version = version + 1, updated_at = ?
			 WHERE id = ? AND deleted_at IS NULL AND status = 'available'`
		).bind(now, item.id),
		// The record is available while ANY copy still is, so a three-copy book
		// stays lendable after the first goes out. Same derivation as
		// syncBookFromItems, inlined so it lands inside this transaction.
		c.env.DB.prepare(
			`UPDATE books SET status = CASE
			   WHEN EXISTS (SELECT 1 FROM items i WHERE i.book_id = books.id AND i.deleted_at IS NULL
			                  AND i.status = 'available'
			                  AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
			                                   WHERE t.item_id = i.id AND t.returned_at IS NULL))
			     THEN 'available' ELSE 'borrowed' END,
			     version = version + 1, updated_at = ?
			 WHERE id = ? AND deleted_at IS NULL`
		).bind(now, bookId)
	]);

	if ((borrowResults[1]?.meta?.changes ?? 0) === 0) {
		// The guard covers three refusals at once. Distinguish the cap, because
		// "this reader already has 5 out" is the operator's problem to solve and
		// "the copy went" is not.
		if (policy.maxConcurrentLoans != null && borrowerId) {
			const open = await countOpenLoansFor(c.env, borrowerId);
			if (open >= policy.maxConcurrentLoans) {
				throw new HTTPException(409, {
					message: `${borrowerName} already has ${open} item(s) on loan (limit ${policy.maxConcurrentLoans}).`
				});
			}
		}
		throw new HTTPException(409, { message: 'That copy is not available' });
	}

	// Collecting a hold closes it. Done after the loan so a failed borrow never
	// consumes the reader's place in the queue.
	let holdFulfilled: string | null = null;
	if (borrowerId) {
		const fulfil = await c.env.DB.prepare(
			`UPDATE holds SET status = 'fulfilled', fulfilled_at = ?, closed_at = ?, updated_at = ?
			  WHERE book_id = ? AND borrower_id = ? AND status IN ('waiting', 'ready')`
		).bind(now, now, now, bookId, borrowerId).run();
		if ((fulfil.meta?.changes ?? 0) > 0) holdFulfilled = borrowerId;
	}

	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.borrow', 'book', bookId ?? null, {
		transactionId: txId,
		itemId: item.id,
		copyNumber: item.copyNumber,
		dueAt,
		policyId: policy.id,
		// Recorded only when the operator overrode the rule, so an override is
		// visible in the log rather than indistinguishable from the default.
		...(dueAt !== policyDueAt ? { policyDueAt, overridden: true } : {})
	});

	return c.json({
		transactionId: txId,
		borrowerId,
		itemId: item.id,
		copyNumber: item.copyNumber,
		shelfCode: item.shelfCode,
		dueAt,
		policy: { id: policy.id, loanDays: policy.loanDays, renewalLimit: policy.renewalLimit },
		holdFulfilled: Boolean(holdFulfilled),
		// How many copies are still lendable — the operator's next question.
		copiesAvailable: await countLendableItems(c.env, bookId ?? '')
	}, 201);
});

app.post('/api/books/:id/return', requirePermission('circulation', { librarian: true }), async (c) => {
	const bookId = c.req.param('id');
	const payload = ReturnBookSchema.parse(await c.req.json());

	// A record can now have several copies out at once, so "return this book"
	// is ambiguous unless the operator says which loan. transactionId picks one
	// exactly; otherwise the oldest open loan comes back first, which is the one
	// most likely to be overdue and the one a person handing back a book means.
	const tx = payload.transactionId
		? await c.env.DB.prepare(
			`SELECT id, borrower_name, item_id FROM borrow_transactions
			  WHERE id = ? AND book_id = ? AND returned_at IS NULL`
		).bind(payload.transactionId, bookId).first<{ id: string; borrower_name: string | null; item_id: string | null }>()
		: await c.env.DB.prepare(
			`SELECT id, borrower_name, item_id FROM borrow_transactions
			  WHERE book_id = ? AND returned_at IS NULL ORDER BY borrowed_at ASC LIMIT 1`
		).bind(bookId).first<{ id: string; borrower_name: string | null; item_id: string | null }>();

	if (!tx) {
		// Distinguish "nothing is out" from "the loan you named is not the open
		// one" — the operator's screen being stale is a different problem from
		// the book already being back.
		const anyOpen = await c.env.DB.prepare(
			`SELECT borrower_name FROM borrow_transactions
			  WHERE book_id = ? AND returned_at IS NULL ORDER BY borrowed_at ASC LIMIT 1`
		).bind(bookId).first<{ borrower_name: string | null }>();
		if (payload.transactionId && anyOpen) {
			throw new HTTPException(409, {
				message: `This copy has since been lent to ${anyOpen.borrower_name || 'someone else'}. Refresh and check before returning.`
			});
		}
		throw new HTTPException(409, { message: 'No active borrow transaction found' });
	}

	const now = nowIso();
	// Atomic: the borrow row is closed AND the copy comes back AND the record
	// agrees, or none of it happens. The `returned_at IS NULL` guard makes the
	// close idempotent under a double-click or a retried request.
	const returnResults = await runAtomic(c.env, [
		c.env.DB.prepare(
			`UPDATE borrow_transactions SET returned_at = ?, return_notes = COALESCE(?, return_notes), updated_at = ?
			 WHERE id = ? AND returned_at IS NULL`
		).bind(now, payload.notes ?? null, now, tx.id),
		// Only free the copy if the statement above is the one that closed the
		// loan — matching on OUR timestamp, not merely "returned_at is set".
		// Had the loan already been closed and the copy lent to someone else,
		// this would otherwise mark an active loan's copy as available.
		//
		// `status = 'borrowed'` also means a copy marked lost or in maintenance
		// while it was out stays that way: the book is back in the building but
		// not back on the shelf, and only a person can decide that.
		c.env.DB.prepare(
			`UPDATE items SET status = 'available', version = version + 1, updated_at = ?
			 WHERE id = ? AND deleted_at IS NULL AND status = 'borrowed'
			   AND EXISTS (SELECT 1 FROM borrow_transactions WHERE id = ? AND returned_at = ?)`
		).bind(now, tx.item_id ?? '', tx.id, now),
		c.env.DB.prepare(
			`UPDATE books SET status = CASE
			   WHEN EXISTS (SELECT 1 FROM items i WHERE i.book_id = books.id AND i.deleted_at IS NULL
			                  AND i.status = 'available'
			                  AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
			                                   WHERE t.item_id = i.id AND t.returned_at IS NULL))
			     THEN 'available' ELSE books.status END,
			     version = version + 1, updated_at = ?
			 WHERE id = ? AND deleted_at IS NULL
			   AND EXISTS (SELECT 1 FROM borrow_transactions WHERE id = ? AND returned_at = ?)`
		).bind(now, bookId, tx.id, now)
	]);

	if ((returnResults[0]?.meta?.changes ?? 0) === 0) {
		throw new HTTPException(409, { message: 'This loan was already closed. Refresh to see the current state.' });
	}

	// The returned copy goes to whoever is first in the queue. This is the whole
	// point of holds being on the title rather than on a copy: the reader asked
	// for the book, and this is the copy that came back.
	//
	// Deliberately AFTER the return batch rather than inside it. A hold that
	// fails to attach must not roll back a return that physically happened —
	// the book is on the desk either way — and the next return re-offers the
	// copy because the queue is re-read every time.
	const filledHold = await fillNextHold(c, bookId ?? '', tx.item_id, now);

	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.return', 'book', bookId ?? null, {
		transactionId: tx.id,
		itemId: tx.item_id,
		...(filledHold ? { holdFilledFor: filledHold.borrowerName, holdId: filledHold.id } : {})
	});

	return c.json({
		transactionId: tx.id,
		returnedAt: now,
		itemId: tx.item_id,
		// Names the reader the copy must now be put aside for, so the operator
		// shelves it behind the desk rather than back on 19-000.
		heldFor: filledHold ? { id: filledHold.id, borrowerName: filledHold.borrowerName, expiresAt: filledHold.expiresAt } : null,
		copiesAvailable: await countLendableItems(c.env, bookId ?? '')
	});
});

// ─── Holds: a queue on the title, filled by whichever copy returns first ───
//
// How many days a collected-but-uncollected copy stays behind the desk. Not a
// setting yet: a library needs to live with one number before it knows whether
// it wants to change it, and every configurable value is one more thing that
// can be set to something nonsensical.
const HOLD_SHELF_DAYS = 7;

/**
 * Put a just-returned copy aside for the head of the queue, if anyone is in it.
 *
 * Returns the hold it filled, or null. Sweeps expired holds first so a copy is
 * never handed to somebody who stopped coming — there is no cron in this
 * worker, so "on read" is the only moment expiry can be evaluated.
 */
async function fillNextHold(
	c: AppContext,
	bookId: string,
	itemId: string | null,
	now: string
): Promise<{ id: string; borrowerName: string; expiresAt: string } | null> {
	if (!itemId) return null;
	await expireStaleHolds(c.env, now);

	const next = await c.env.DB.prepare(
		`SELECT id, borrower_name FROM holds
		  WHERE book_id = ? AND status = 'waiting'
		  ORDER BY placed_at ASC, id ASC LIMIT 1`
	).bind(bookId).first<{ id: string; borrower_name: string }>();
	if (!next) return null;

	const expiresAt = dueDateFromPolicy(HOLD_SHELF_DAYS, new Date(now));
	// The `status = 'waiting'` guard makes two simultaneous returns of two
	// copies fill two DIFFERENT holds rather than both claiming the head.
	const res = await c.env.DB.prepare(
		`UPDATE holds SET status = 'ready', item_id = ?, ready_at = ?, expires_at = ?, updated_at = ?
		  WHERE id = ? AND status = 'waiting'`
	).bind(itemId, now, expiresAt, now, next.id).run();
	if ((res.meta?.changes ?? 0) === 0) return null;

	return { id: next.id, borrowerName: next.borrower_name, expiresAt };
}

app.get('/api/books/:id/holds', requirePermission('circulation', { librarian: true }), async (c) => {
	const bookId = c.req.param('id') ?? '';
	await expireStaleHolds(c.env, nowIso());
	const rows = await c.env.DB.prepare(
		`SELECT h.*, i.copy_number, i.shelf_code FROM holds h
		   LEFT JOIN items i ON i.id = h.item_id
		  WHERE h.book_id = ? AND h.status IN ('waiting', 'ready')
		  ORDER BY h.placed_at ASC, h.id ASC`
	).bind(bookId).all<Record<string, unknown>>();
	return c.json({
		bookId,
		holds: (rows.results ?? []).map((r, idx) => ({
			id: r.id,
			// Position in the queue, computed rather than stored: a stored
			// position goes stale the moment anyone cancels.
			position: idx + 1,
			borrowerId: r.borrower_id,
			borrowerName: r.borrower_name,
			borrowerContact: r.borrower_contact,
			status: r.status,
			itemId: r.item_id,
			copyNumber: r.copy_number ?? null,
			shelfCode: r.shelf_code ?? null,
			placedAt: r.placed_at,
			readyAt: r.ready_at,
			expiresAt: r.expires_at,
			notes: r.notes
		}))
	});
});

app.post('/api/books/:id/holds', requirePermission('circulation', { librarian: true }), async (c) => {
	const bookId = c.req.param('id') ?? '';
	const payload = PlaceHoldSchema.parse(await c.req.json());

	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL')
		.bind(bookId).first();
	if (!book) throw new HTTPException(404, { message: 'Book not found' });

	const { borrowerId, borrowerName, borrowerContact } = await resolveBorrower(c.env, payload);
	const now = nowIso();
	await expireStaleHolds(c.env, now);

	// A reader already holding a copy does not need to queue for it.
	const alreadyOut = borrowerId
		? await c.env.DB.prepare(
			`SELECT 1 FROM borrow_transactions WHERE book_id = ? AND borrower_id = ? AND returned_at IS NULL`
		).bind(bookId, borrowerId).first()
		: null;
	if (alreadyOut) {
		throw new HTTPException(409, { message: `${borrowerName} already has this book on loan.` });
	}

	const id = newId('hold');
	try {
		await c.env.DB.prepare(
			`INSERT INTO holds (id, book_id, borrower_id, borrower_name, borrower_contact,
			                    status, placed_at, notes, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)`
		).bind(id, bookId, borrowerId, borrowerName, borrowerContact, now,
			payload.notes ?? null, c.get('user').sub, now, now).run();
	} catch (error) {
		// idx_holds_one_per_borrower. Placing the same hold twice is a
		// double-click, not a request for two copies.
		const existing = borrowerId
			? await c.env.DB.prepare(
				`SELECT id FROM holds WHERE book_id = ? AND borrower_id = ? AND status IN ('waiting','ready')`
			).bind(bookId, borrowerId).first<{ id: string }>()
			: null;
		if (existing) throw new HTTPException(409, { message: `${borrowerName} is already in the queue for this book.` });
		throw error;
	}

	// If a copy is sitting free right now there is nothing to wait for — put it
	// aside immediately rather than making the reader come back for a return
	// that will never happen.
	const free = await pickLendableItem(c.env, bookId, null, borrowerId);
	const ready = free ? await fillNextHold(c, bookId, free.id, now) : null;

	const position = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM holds
		  WHERE book_id = ? AND status IN ('waiting','ready') AND placed_at <= ? AND id <= ?`
	).bind(bookId, now, id).first<{ n: number }>();

	await insertAuditLog(c.env, c.get('user').sub, 'hold.place', 'book', bookId, {
		holdId: id, borrowerId, ready: Boolean(ready)
	});

	return c.json({
		id, bookId, borrowerId, borrowerName,
		status: ready?.id === id ? 'ready' : 'waiting',
		position: Number(position?.n ?? 1),
		expiresAt: ready?.id === id ? ready.expiresAt : null
	}, 201);
});

app.delete('/api/holds/:id', requirePermission('circulation', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const now = nowIso();
	const hold = await c.env.DB.prepare(
		`SELECT book_id, item_id, status FROM holds WHERE id = ? AND status IN ('waiting','ready')`
	).bind(id).first<{ book_id: string; item_id: string | null; status: string }>();
	if (!hold) throw new HTTPException(404, { message: 'Hold not found or already closed' });

	await c.env.DB.prepare(
		`UPDATE holds SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ? AND status IN ('waiting','ready')`
	).bind(now, now, id).run();

	// A cancelled READY hold frees the copy it was sitting on — pass it to the
	// next reader in the queue rather than leaving it behind the desk.
	const passedOn = hold.status === 'ready' ? await fillNextHold(c, hold.book_id, hold.item_id, now) : null;

	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'hold.cancel', 'book', hold.book_id, { holdId: id });
	return c.json({ id, cancelled: true, passedOnTo: passedOn?.borrowerName ?? null });
});

// Every copy waiting behind the desk, across the catalogue — the shelf the
// librarian actually has to walk past.
app.get('/api/holds', requirePermission('circulation', { librarian: true }), async (c) => {
	await expireStaleHolds(c.env, nowIso());
	const rows = await c.env.DB.prepare(
		`SELECT h.id, h.book_id, h.borrower_name, h.borrower_contact, h.status,
		        h.placed_at, h.ready_at, h.expires_at, h.item_id,
		        b.title, b.author, i.copy_number, i.shelf_code
		   FROM holds h
		   JOIN books b ON b.id = h.book_id AND b.deleted_at IS NULL
		   LEFT JOIN items i ON i.id = h.item_id
		  WHERE h.status IN ('waiting', 'ready')
		  ORDER BY (h.status = 'ready') DESC, h.placed_at ASC
		  LIMIT 500`
	).all<Record<string, unknown>>();
	const items = (rows.results ?? []).map((r) => ({
		id: r.id, bookId: r.book_id, title: r.title, author: r.author,
		borrowerName: r.borrower_name, borrowerContact: r.borrower_contact,
		status: r.status, placedAt: r.placed_at, readyAt: r.ready_at, expiresAt: r.expires_at,
		itemId: r.item_id, copyNumber: r.copy_number ?? null, shelfCode: r.shelf_code ?? null
	}));
	return c.json({
		total: items.length,
		readyCount: items.filter((h) => h.status === 'ready').length,
		items
	});
});

// ─── Loan policies ─────────────────────────────────────────────────────────
//
// Readable by anyone who can circulate — the borrow form needs to show what the
// rule will do — but writable only by an admin. A loan period is the kind of
// thing that should be decided once, not adjusted by whoever is at the desk.

app.get('/api/loan-policies', requirePermission('circulation', { librarian: true }), async (c) => {
	const [rows, cats] = await Promise.all([
		c.env.DB.prepare(
			`SELECT * FROM loan_policies
			  ORDER BY (borrower_category = '*'), borrower_category, (item_type = '*'), item_type`
		).all<Record<string, unknown>>(),
		// The categories actually in use, so the editor offers real values
		// rather than asking the librarian to remember what they typed.
		c.env.DB.prepare(
			`SELECT category, COUNT(*) AS n FROM borrowers GROUP BY category ORDER BY n DESC`
		).all<{ category: string; n: number }>()
	]);
	return c.json({
		policies: (rows.results ?? []).map((r) => ({
			id: r.id,
			borrowerCategory: r.borrower_category,
			itemType: r.item_type,
			loanDays: Number(r.loan_days),
			renewalLimit: Number(r.renewal_limit),
			renewalDays: r.renewal_days == null ? null : Number(r.renewal_days),
			maxConcurrentLoans: r.max_concurrent_loans == null ? null : Number(r.max_concurrent_loans),
			lendable: Number(r.lendable) === 1,
			notes: r.notes
		})),
		borrowerCategories: (cats.results ?? []).map((r) => ({ category: r.category, borrowers: Number(r.n) })),
		itemTypes: ITEM_TYPES
	});
});

app.put('/api/loan-policies', requirePermission('setup'), async (c) => {
	const payload = ReplaceLoanPoliciesSchema.parse(await c.req.json());

	// (category, type) is UNIQUE, and a whole-array replace that contained the
	// same pair twice would fail halfway through the batch. Say so instead.
	const seen = new Set<string>();
	for (const p of payload.policies) {
		const key = `${p.borrowerCategory}${p.itemType}`;
		if (seen.has(key)) {
			throw new HTTPException(400, {
				message: `Two rules for the same pair: ${p.borrowerCategory} / ${p.itemType}`
			});
		}
		seen.add(key);
	}
	// Without a fallback, a borrower category nobody wrote a rule for would fall
	// through to the hard-coded default in resolveLoanPolicy — which is correct
	// but invisible. Requiring the row keeps the table the whole truth.
	if (!seen.has('**')) {
		throw new HTTPException(400, { message: 'A default rule (* / *) is required.' });
	}

	const now = nowIso();
	const statements: D1PreparedStatement[] = [
		c.env.DB.prepare('DELETE FROM loan_policies'),
		...payload.policies.map((p) =>
			c.env.DB.prepare(
				`INSERT INTO loan_policies (id, borrower_category, item_type, loan_days, renewal_limit,
				                            renewal_days, max_concurrent_loans, lendable, notes, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(
				// Deterministic id from the pair: re-saving the same table keeps
				// the same ids, so an audit log diff reads as a change rather than
				// as everything being replaced.
				`pol_${normalizeCode(p.borrowerCategory)}_${normalizeCode(p.itemType)}`.replace(/[^A-Za-z0-9_*]/g, '_'),
				p.borrowerCategory, p.itemType, p.loanDays, p.renewalLimit,
				p.renewalDays ?? null, p.maxConcurrentLoans ?? null, p.lendable ? 1 : 0,
				p.notes ?? null, now, now
			)
		)
	];
	for (let i = 0; i < statements.length; i += 40) {
		await runAtomic(c.env, statements.slice(i, i + 40));
	}
	await insertAuditLog(c.env, c.get('user').sub, 'loanPolicies.replace', 'system', null, {
		count: payload.policies.length
	});
	return c.json({ saved: payload.policies.length });
});

// ─── Renewals ──────────────────────────────────────────────────────────────

app.post('/api/loans/:id/renew', requirePermission('circulation', { librarian: true }), async (c) => {
	const loanId = c.req.param('id') ?? '';
	const payload = RenewLoanSchema.parse(await c.req.json());

	const loan = await c.env.DB.prepare(
		`SELECT t.id, t.book_id, t.item_id, t.borrower_id, t.due_at, t.renewal_count, t.original_due_at,
		        i.item_type, COALESCE(br.category, 'standard') AS category
		   FROM borrow_transactions t
		   LEFT JOIN items i ON i.id = t.item_id
		   LEFT JOIN borrowers br ON br.id = t.borrower_id
		  WHERE t.id = ? AND t.returned_at IS NULL`
	).bind(loanId).first<{
		id: string; book_id: string; item_id: string | null; borrower_id: string | null;
		due_at: string; renewal_count: number; original_due_at: string | null;
		item_type: string | null; category: string;
	}>();
	if (!loan) throw new HTTPException(404, { message: 'No open loan with that id' });

	// The renewal count is the precondition that actually works. It strictly
	// increases, so the web client's automatic retry of a request whose response
	// was lost cannot match and cannot double-extend the loan. The due date
	// alone is not enough: renewing a fresh 14-day loan for another 14 days
	// lands on the same calendar date, and a replay then still matches.
	if (payload.expectedRenewalCount != null && payload.expectedRenewalCount !== loan.renewal_count) {
		throw new HTTPException(409, {
			message: 'This loan has already been renewed. Refresh to see the current due date.'
		});
	}
	if (payload.expectedDueAt && payload.expectedDueAt !== loan.due_at) {
		throw new HTTPException(409, {
			message: 'This loan has already been renewed. Refresh to see the current due date.'
		});
	}

	const policy = await resolveLoanPolicy(c.env, loan.category, loan.item_type ?? 'book');
	if (loan.renewal_count >= policy.renewalLimit) {
		throw new HTTPException(409, {
			message: policy.renewalLimit === 0
				? 'This kind of loan cannot be renewed.'
				: `Renewal limit reached (${policy.renewalLimit}).`
		});
	}

	// Somebody is waiting. Renewing past a queue is how a hold never gets
	// filled, so the answer is no and the operator can see who is waiting.
	const waiting = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM holds WHERE book_id = ? AND status IN ('waiting','ready')`
	).bind(loan.book_id).first<{ n: number }>();
	if (Number(waiting?.n ?? 0) > 0) {
		throw new HTTPException(409, {
			message: `Cannot renew: ${waiting?.n} reader(s) are waiting for this book.`
		});
	}

	const now = nowIso();
	// Renew from TODAY, not from the old due date: an overdue loan renewed from
	// its own due date would still be overdue, which is not what anyone means.
	// Never shorter than it already is, though — a renewal cannot take time away.
	const fromToday = dueDateFromPolicy(policy.renewalDays);
	const newDueAt = fromToday > loan.due_at ? fromToday : loan.due_at;
	// Renewing a loan taken this morning buys nothing and would spend one of the
	// reader's renewals for no extra time. Say so rather than charging them.
	if (newDueAt === loan.due_at) {
		throw new HTTPException(409, {
			message: 'This loan already runs to the maximum the rule allows; renewing would not extend it.'
		});
	}
	const res = await c.env.DB.prepare(
		`UPDATE borrow_transactions
		    SET due_at = ?, renewal_count = renewal_count + 1,
		        original_due_at = COALESCE(original_due_at, due_at),
		        return_notes = return_notes, updated_at = ?
		  WHERE id = ? AND returned_at IS NULL AND due_at = ? AND renewal_count = ?`
	).bind(newDueAt, now, loanId, loan.due_at, loan.renewal_count).run();
	if ((res.meta?.changes ?? 0) === 0) {
		throw new HTTPException(409, { message: 'This loan changed while you were looking at it. Refresh and retry.' });
	}

	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'loan.renew', 'book', loan.book_id, {
		transactionId: loanId, from: loan.due_at, to: newDueAt, renewalCount: loan.renewal_count + 1
	});

	return c.json({
		transactionId: loanId,
		dueAt: newDueAt,
		originalDueAt: loan.original_due_at ?? loan.due_at,
		renewalCount: loan.renewal_count + 1,
		renewalsLeft: policy.renewalLimit - (loan.renewal_count + 1)
	});
});

app.get('/api/books/:id/history', requirePermission('circulation', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	if (!id) {
		throw new HTTPException(400, { message: 'Missing book id' });
	}

	const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') ?? 20)));
	const offset = Math.max(0, Math.floor(Number(c.req.query('offset') ?? 0) || 0));
	const now = nowIso();

	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!book) {
		throw new HTTPException(404, { message: 'Book not found' });
	}

	// Over-fetch one row to detect whether more history exists past this page,
	// so the client can offer a "load more" without a second count query.
	const rows = await c.env.DB.prepare(
		`SELECT
			id,
			book_id,
			item_id,
			borrower_name,
			borrower_contact,
			borrowed_at,
			due_at,
			returned_at,
			notes,
			return_notes,
			CASE WHEN returned_at IS NULL AND due_at < ? THEN 1 ELSE 0 END AS was_overdue,
			created_by,
			updated_at
		 FROM borrow_transactions
		 WHERE book_id = ?
		 ORDER BY borrowed_at DESC
		 LIMIT ? OFFSET ?`
	)
		.bind(now, id, limit + 1, offset)
		.all();

	const allRows = rows.results ?? [];
	const hasMore = allRows.length > limit;

	return c.json({
		bookId: id,
		limit,
		offset,
		hasMore,
		items: allRows.slice(0, limit).map((row) => ({
			id: (row as Record<string, unknown>).id,
			bookId: (row as Record<string, unknown>).book_id,
			// Which copy this loan was of — a two-copy record's history is
			// meaningless without it.
			itemId: (row as Record<string, unknown>).item_id ?? null,
			borrowerName: (row as Record<string, unknown>).borrower_name,
			borrowerContact: (row as Record<string, unknown>).borrower_contact,
			borrowedAt: (row as Record<string, unknown>).borrowed_at,
			dueAt: (row as Record<string, unknown>).due_at,
			returnedAt: (row as Record<string, unknown>).returned_at,
			notes: (row as Record<string, unknown>).notes,
			returnNotes: (row as Record<string, unknown>).return_notes,
			wasOverdue: (row as Record<string, unknown>).was_overdue === 1,
			createdBy: (row as Record<string, unknown>).created_by,
			updatedAt: (row as Record<string, unknown>).updated_at
		}))
	});
});

// ─── Holdings: the physical copies of a record ────────────────────────────

app.get('/api/books/:id/items', async (c) => {
	const id = c.req.param('id') ?? '';
	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!book) throw new HTTPException(404, { message: 'Book not found' });
	return c.json({ bookId: id, items: await loadBookItems(c.env, id) });
});

// Whole-array replace, mirroring PUT /api/books/:id/attributes — the form edits
// a record's copies as one list, and replace keeps the offline queue trivial.
//
// Unlike /attributes this takes an `expectedVersion` and 409s on a mismatch:
// losing a hand-entered set of holdings to a concurrent save is exactly the
// data loss §3 and §14 of the regression gate exist to prevent.
app.put('/api/books/:id/items', requirePermission('books.write', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const book = await c.env.DB.prepare(
		'SELECT id, version FROM books WHERE id = ? AND deleted_at IS NULL'
	).bind(id).first<{ id: string; version: number }>();
	if (!book) throw new HTTPException(404, { message: 'Book not found' });

	const payload = ReplaceItemsSchema.parse(await c.req.json());
	if (payload.expectedVersion !== undefined && payload.expectedVersion !== book.version) {
		throw new HTTPException(409, { message: 'Book was modified by someone else' });
	}

	const existing = await loadBookItems(c.env, id);
	const existingById = new Map(existing.map((i) => [String(i.id), i]));
	const keptIds = new Set(payload.items.map((i) => i.id).filter(Boolean) as string[]);
	const now = nowIso();
	const statements: D1PreparedStatement[] = [];

	// A copy that is on loan cannot be removed — that would strand the loan and
	// lose the record of who has the book.
	for (const prior of existing) {
		if (keptIds.has(String(prior.id))) continue;
		if (prior.status === 'borrowed') {
			throw new HTTPException(409, { message: 'Cannot remove a copy that is on loan. Return it first.' });
		}
		statements.push(
			c.env.DB.prepare('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?')
				.bind(now, now, prior.id)
		);
	}

	payload.items.forEach((item, index) => {
		// Renumbered by position, always. This is a whole-array replace, so the
		// order the librarian arranged IS the numbering — honouring a client-sent
		// copyNumber instead let a kept copy and a new one both claim "copy 2".
		const copyNumber = index + 1;
		const shelfCode = item.shelfCode ? normalizeCode(item.shelfCode) || null : null;
		const roomCode = item.roomCode ? normalizeCode(item.roomCode) || null : null;
		const barcode = item.barcode?.trim() || null;
		if (item.id && existingById.has(item.id)) {
			statements.push(
				c.env.DB.prepare(
					`UPDATE items SET copy_number = ?, volume_num = ?, volume_label = ?, room_code = ?,
					        shelf_code = ?, call_number = ?, item_type = ?, condition = ?,
					        acquisition_date = ?, notes = ?, barcode = ?, updated_at = ?, version = version + 1
					  WHERE id = ?`
				).bind(
					copyNumber, item.volumeNum ?? null, item.volumeLabel ?? null, roomCode,
					shelfCode, item.callNumber ?? null, item.itemType, item.condition ?? null,
					item.acquisitionDate ?? null, item.notes ?? null, barcode, now, item.id
				)
			);
		} else {
			statements.push(
				c.env.DB.prepare(
					`INSERT INTO items (id, book_id, barcode, copy_number, volume_num, volume_label,
					                    room_code, shelf_code, call_number, item_type, status, condition,
					                    acquisition_date, notes, created_at, updated_at, version)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, 0)`
				).bind(
					newId('itm'), id, barcode, copyNumber, item.volumeNum ?? null, item.volumeLabel ?? null,
					roomCode, shelfCode, item.callNumber ?? null, item.itemType,
					item.condition ?? null, item.acquisitionDate ?? null, item.notes ?? null, now, now
				)
			);
		}
	});

	statements.push(
		c.env.DB.prepare('UPDATE books SET updated_at = ?, version = version + 1 WHERE id = ?').bind(now, id)
	);
	await runAtomic(c.env, statements);
	// The record's own shelf/room/status are derived from its copies.
	await syncBookFromItems(c.env, id);
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.items.replace', 'book', id, {
		count: payload.items.length
	});

	return c.json({ bookId: id, items: await loadBookItems(c.env, id) });
});

// Add copies to many records at once.
//
// This is request #7: the librarian catalogued 29 "Φιλοσοφία" volumes twice
// because each also sits on "19-000 ΠΙΣΩ". With holdings, that is one action —
// 29 records with two copies each, instead of 58 records.
app.post('/api/items/add-copies', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = AddCopiesSchema.parse(await c.req.json());
	const ids = payload.bookIds.filter((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id));
	if (ids.length === 0) throw new HTTPException(400, { message: 'No valid book ids' });

	const placeholders = ids.map(() => '?').join(',');
	const books = await c.env.DB.prepare(
		`SELECT id FROM books WHERE deleted_at IS NULL AND id IN (${placeholders})`
	).bind(...ids).all<{ id: string }>();
	const found = (books.results ?? []).map((b) => b.id);
	if (found.length === 0) throw new HTTPException(404, { message: 'No matching books' });

	const existingItems = await loadItemsForBooks(c.env, found);
	const now = nowIso();
	const shelfCode = payload.shelfCode ? normalizeCode(payload.shelfCode) || null : null;
	const roomCode = payload.roomCode ? normalizeCode(payload.roomCode) || null : null;

	const statements: D1PreparedStatement[] = [];
	let created = 0;
	for (const bookId of found) {
		const copies = existingItems.get(bookId) ?? [];
		// Continue the record's own numbering rather than restarting at 1.
		const highest = copies.reduce((max, i) => Math.max(max, Number(i.copyNumber ?? 0)), 0);
		// A new copy inherits its location from the first existing one unless the
		// operator said otherwise — that is what makes "same shelf, one more
		// copy" a single click.
		const template = copies[0];
		for (let n = 1; n <= payload.copies; n += 1) {
			statements.push(
				c.env.DB.prepare(
					`INSERT INTO items (id, book_id, copy_number, volume_num, volume_label,
					                    room_code, shelf_code, item_type, status,
					                    created_at, updated_at, version)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, 0)`
				).bind(
					newId('itm'), bookId, highest + n,
					// A second exemplar of the same volume is not a new position in a
					// set. Carrying volume_num across would make a 29-volume set look
					// complete twice over to the gap report.
					payload.copyVolume ? (template?.volumeNum ?? null) : null,
					payload.copyVolume ? (template?.volumeLabel ?? null) : null,
					roomCode ?? (template?.roomCode ?? null),
					shelfCode ?? (template?.shelfCode ?? null),
					String(template?.itemType ?? 'book'),
					now, now
				)
			);
			created += 1;
		}
	}

	for (let i = 0; i < statements.length; i += D1_ADD_COPIES_BATCH) {
		await runAtomic(c.env, statements.slice(i, i + D1_ADD_COPIES_BATCH));
	}
	// Only the record's derived status/location can have moved, and only for
	// books that had no copies at all — but sync them anyway so the invariant
	// holds without depending on that reasoning.
	for (const bookId of found) await syncBookFromItems(c.env, bookId);
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'items.addCopies', 'book', null, {
		books: found.length, copiesEach: payload.copies, created, shelfCode
	});

	return c.json({ books: found.length, created, shelfCode, roomCode });
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
				bt.item_id,
				i.copy_number,
				i.shelf_code,
				i.barcode,
				CASE WHEN bt.due_at < ? THEN 1 ELSE 0 END AS is_overdue
			 FROM borrow_transactions bt
			 JOIN books b ON b.id = bt.book_id
			 LEFT JOIN items i ON i.id = bt.item_id
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
				// WHICH copy is out. A record can now have several on loan at
				// once, so the row has to say which one to hand back.
				itemId: r.item_id ?? null,
				copyNumber: r.copy_number ?? null,
				shelfCode: r.shelf_code ?? null,
				barcode: r.barcode ?? null,
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
	// Read SOFT-DELETED definitions too. Filtering them out made this endpoint
	// destructive on a second run: a field the librarian had deliberately
	// deleted looked absent, so the upsert below resurrected it — and, because
	// it also rewrote `required` and `enum_options`, it wiped the configuration
	// of whatever it touched. Setup is meant to be safe to re-run.
	const existingCustomFieldsResult = await c.env.DB.prepare(
		`SELECT field_key, label, deleted_at FROM custom_field_definitions`
	).all<ExistingCustomFieldRef & { deleted_at: string | null }>();
	const allExistingCustomFields = [...(existingCustomFieldsResult.results ?? [])];
	const existingKeys = new Set(allExistingCustomFields.map((f) => f.field_key));
	const liveCustomFields: ExistingCustomFieldRef[] = allExistingCustomFields.filter((f) => !f.deleted_at);

	let configuredCustomColumns = 0;
	const skippedAsSimilar: string[] = [];
	const skippedAsDeleted: string[] = [];

	for (const column of customColumns) {
		// An exact key hit wins regardless of state — never re-create or revive it.
		if (column.customKey && existingKeys.has(column.customKey)) {
			const row = allExistingCustomFields.find((f) => f.field_key === column.customKey);
			if (row?.deleted_at) skippedAsDeleted.push(column.label);
			else skippedAsSimilar.push(column.label);
			continue;
		}
		// Otherwise fall back to the fuzzy label match against LIVE fields, so a
		// differently-keyed equivalent ("Sub Title" vs "subtitle") isn't doubled.
		const similar = findSimilarCustomField(liveCustomFields, column);
		if (similar) {
			skippedAsSimilar.push(column.label);
			continue;
		}

		await c.env.DB.prepare(
			`INSERT INTO custom_field_definitions
				(id, field_key, label, field_type, required, enum_options, created_at, updated_at, deleted_at)
			 VALUES (?, ?, ?, ?, 0, '[]', ?, ?, NULL)
			 ON CONFLICT(field_key) DO NOTHING`
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

		if (column.customKey) existingKeys.add(column.customKey);
		liveCustomFields.push({ field_key: column.customKey ?? '', label: column.label });
		configuredCustomColumns += 1;
	}

	await insertAuditLog(c.env, c.get('user').sub, 'setup.defaultBookStructure', 'custom_field', null, {
		count: configuredCustomColumns,
		skippedAsSimilar,
		skippedAsDeleted
	});

	return c.json({ ok: true, configuredCustomColumns, skippedAsSimilar, skippedAsDeleted });
});

app.get('/api/rooms/summary', async (c) => {
	// Version-keyed KV cache: this endpoint aggregates the WHOLE books table
	// twice (~25k D1 rows read) and is called on every login + after every book
	// write, so caching it saves a large share of the D1 read budget. Any book
	// or room write bumps the version and invalidates it, so it never drifts.
	const cacheVersion = await getBooksCacheVersion(c.env);
	const cacheKey = `rooms:summary:${cacheVersion}`;
	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) return c.json(cached);
		} catch (error) {
			console.warn('rooms/summary cache read failed, falling back to DB', error);
		}
	}
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
		const payload = {
			items: rows.results ?? [],
			unassigned: {
				totalBooks: Number(ua.total_books ?? 0),
				availableBooks: Number(ua.available_books ?? 0),
				borrowedBooks: Number(ua.borrowed_books ?? 0),
				lostBooks: Number(ua.lost_books ?? 0),
				maintenanceBooks: Number(ua.maintenance_books ?? 0)
			}
		};
		if (c.env.CACHE) {
			try {
				await c.env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 });
			} catch (error) {
				console.warn('rooms/summary cache write failed, continuing', error);
			}
		}
		return c.json(payload);
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

	await bumpBooksCacheVersion(c.env); // invalidate the version-keyed rooms/summary cache
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

	await bumpBooksCacheVersion(c.env); // rooms/summary + list cache invalidation
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

	await bumpBooksCacheVersion(c.env); // rooms/summary + list cache invalidation
	await insertAuditLog(c.env, c.get('user').sub, 'room.delete', 'room', id ?? null, {});
	return c.body(null, 204);
});

app.get('/api/custom-fields', async (c) => {
	try {
		// Pinned fields first, then each group by its explicit order, then label.
		// Alphabetical-by-key alone buried the handful of attributes the librarian
		// fills on nearly every book among two dozen they rarely open. Every
		// consumer renders in the order this endpoint returns, so ordering here
		// keeps the book form, the settings list and the bulk editor consistent.
		const rows = await c.env.DB.prepare(
			`SELECT id, field_key, label, field_type, required, enum_options, created_at, updated_at,
			        pinned, sort_order
			 FROM custom_field_definitions WHERE deleted_at IS NULL
			 ORDER BY pinned DESC, sort_order ASC, label ASC, field_key ASC`
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
					pinned: r.pinned === 1,
					sortOrder: Number(r.sort_order ?? 0),
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
					pinned: (row as Record<string, unknown>).pinned === 1,
					sortOrder: Number((row as Record<string, unknown>).sort_order ?? 0),
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
			(id, field_key, label, field_type, required, enum_options, created_at, updated_at, deleted_at,
			 pinned, sort_order)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
	)
		.bind(
			id, payload.key, payload.label, payload.type, payload.required ? 1 : 0,
			JSON.stringify(payload.enumOptions), now, now,
			payload.pinned ? 1 : 0, payload.sortOrder ?? 0
		)
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
		'SELECT id, field_key, field_type, enum_options, pinned, sort_order FROM custom_field_definitions WHERE id = ? AND deleted_at IS NULL LIMIT 1'
	)
		.bind(id)
		.first<{
			id: string; field_key: string; field_type: string; enum_options: string | null;
			pinned: number; sort_order: number;
		}>();

	if (!existing) {
		throw new HTTPException(404, { message: 'Custom field not found' });
	}

	// A definition edit can invalidate values already stored on books:
	//   * renaming the key leaves every book holding the OLD key,
	//   * changing the type leaves values of the old type,
	//   * removing enum options leaves books holding a now-illegal choice.
	// Any of these makes a book fail validation on its next save — the book
	// becomes un-editable while the UI still shows a plausible value. So the
	// books are migrated here, in ONE pass over the table rather than the two
	// full scans this used to do.
	const D1_BATCH_LIMIT = 50;
	const oldKey = existing.field_key;
	const newKey = payload.key;
	const typeChanged = existing.field_type !== payload.type;
	const oldEnumOptions = existing.field_type === 'enum'
		? safeJsonParse<string[]>(existing.enum_options ?? '[]', [])
		: [];
	const removedEnumOptions = payload.type === 'enum'
		? oldEnumOptions.filter((o) => !payload.enumOptions.includes(o))
		: [];
	const needsBookSweep = oldKey !== newKey || typeChanged || removedEnumOptions.length > 0;

	// Convert a stored value to the field's new type. Returns `undefined` when
	// the value cannot be represented at all — better to drop one cell than to
	// leave the whole book unsaveable.
	const coerceToType = (value: unknown): unknown => {
		if (value === null || value === undefined) return value;
		switch (payload.type) {
			case 'text':
				return typeof value === 'string' ? value : String(value);
			case 'number': {
				if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
				const n = Number(String(value).trim().replace(',', '.'));
				return Number.isFinite(n) ? n : undefined;
			}
			case 'boolean': {
				if (typeof value === 'boolean') return value;
				const t = String(value).trim().toLowerCase();
				if (['true', '1', 'yes', 'y', 'on', 'ναι'].includes(t)) return true;
				if (['false', '0', 'no', 'n', 'off', 'οχι', 'όχι'].includes(t)) return false;
				return undefined;
			}
			case 'date': {
				const t = String(value).trim();
				return t && !Number.isNaN(Date.parse(t)) ? t : undefined;
			}
			case 'enum': {
				const t = String(value);
				return payload.enumOptions.includes(t) ? t : undefined;
			}
			default:
				return value;
		}
	};

	let renamedBooks = 0;
	let clearedEnumBooks = 0;
	let retypedBooks = 0;
	const bookUpdates: D1PreparedStatement[] = [];

	// The sweep is PAGED, like POST /api/admin/normalize-books and
	// POST /api/admin/rebuild-search-index.
	//
	// It used to load every non-deleted row and emit the rewrites in one
	// invocation. On this catalogue (~12.5K books) a type change is ~232 batched
	// statements in a single request — well past the Workers subrequest budget —
	// so retyping an attribute was simply impossible once the collection grew.
	//
	// What is paged is the WRITES, not the reads. Scanning rows costs one
	// subrequest per page no matter how many rows come back, while every 50
	// rewrites costs another. So the scan window is deliberately large and the
	// stop condition is the write cap: a change that touches a handful of books
	// finishes in 3 calls instead of 13, and one that touches all of them still
	// stays inside the budget. That matters beyond tidiness — mutations are rate
	// limited (180/min), so a chattier sweep can throttle itself mid-migration.
	//
	// Resumability was already the design here: the definition row is written
	// LAST (see below), so a page that hasn't finished leaves the OLD definition
	// in place and the next call recomputes oldKey/newKey identically.
	const SWEEP_WRITE_CAP = 500; // 10 D1 batches
	const sweepLimit = Math.min(20000, Math.max(1, Number(c.req.query('sweepLimit') ?? 5000)));
	const sweepOffset = Math.max(0, Number(c.req.query('sweepOffset') ?? 0));
	let sweepScanned = 0;
	let sweepComplete = true;

	if (needsBookSweep) {
		const books = await c.env.DB.prepare(
			'SELECT id, custom_fields FROM books WHERE deleted_at IS NULL ORDER BY id LIMIT ? OFFSET ?'
		).bind(sweepLimit, sweepOffset).all<{
			id: string;
			custom_fields: string;
		}>();

		const fetched = books.results ?? [];
		// A full page means there may be more. Ordering is by primary key and the
		// sweep only ever rewrites rows (never inserts or deletes), so the offset
		// window stays stable across calls and an already-migrated row re-scanned
		// on a retry is simply a no-op.
		sweepComplete = fetched.length < sweepLimit;

		for (const row of fetched) {
			// Stop at the write cap and report where we got to, so the next call
			// resumes from this exact row rather than redoing the page.
			if (bookUpdates.length >= SWEEP_WRITE_CAP) {
				sweepComplete = false;
				break;
			}
			sweepScanned += 1;
			const values = safeJsonParse<Record<string, unknown>>(row.custom_fields ?? '{}', {});
			let changed = false;
			let renamedThisRow = false;

			if (oldKey !== newKey && Object.prototype.hasOwnProperty.call(values, oldKey)) {
				const oldValue = values[oldKey];
				if (!Object.prototype.hasOwnProperty.call(values, newKey)) {
					values[newKey] = oldValue;
				}
				delete values[oldKey];
				changed = true;
				renamedThisRow = true;
			}

			if (Object.prototype.hasOwnProperty.call(values, newKey)) {
				const current = values[newKey];
				const coerced = coerceToType(current);
				if (coerced === undefined) {
					delete values[newKey];
					changed = true;
					// Losing an out-of-range enum choice and losing an un-convertible
					// value are reported separately so the operator can tell which
					// part of their edit cost them data.
					if (
						payload.type === 'enum' &&
						typeof current === 'string' &&
						removedEnumOptions.includes(current)
					) {
						clearedEnumBooks += 1;
					} else {
						retypedBooks += 1;
					}
				} else if (coerced !== current) {
					values[newKey] = coerced as string | number | boolean | null;
					changed = true;
					retypedBooks += 1;
				}
			}

			if (!changed) continue;
			if (renamedThisRow) renamedBooks += 1;

			const valuesJson = JSON.stringify(values);
			const valuesFold = computeBookFolds({ customFieldsJson: valuesJson }).custom_fields_fold;
			bookUpdates.push(
				c.env.DB.prepare('UPDATE books SET custom_fields = ?, custom_fields_fold = ?, updated_at = ?, version = version + 1 WHERE id = ?')
					.bind(valuesJson, valuesFold, nowIso(), row.id)
			);
		}

		for (let i = 0; i < bookUpdates.length; i += D1_BATCH_LIMIT) {
			await runAtomic(c.env, bookUpdates.slice(i, i + D1_BATCH_LIMIT));
		}
	}

	// More pages to go: leave the definition untouched so the next call derives
	// the same oldKey/newKey, and hand the caller the offset to resume from.
	if (!sweepComplete) {
		if (bookUpdates.length > 0) {
			await bumpBooksCacheVersion(c.env);
		}
		return c.json({
			id,
			sweepComplete: false,
			nextSweepOffset: sweepOffset + sweepScanned,
			scanned: sweepScanned,
			renamedBooks,
			clearedEnumBooks,
			retypedBooks
		});
	}

	// The definition is updated LAST, deliberately.
	//
	// It used to go first (batched with the opening slice of book rewrites).
	// If a later batch then failed, the definition already carried the NEW key,
	// so re-running the rename saw old === new, skipped the sweep entirely, and
	// the un-migrated books kept the old key forever with no way to finish the
	// job. Writing the definition only after every book is migrated makes the
	// operation resumable: a failed run leaves the old definition in place and
	// simply retrying completes it (already-migrated books are no-ops).
	await c.env.DB.prepare(
		`UPDATE custom_field_definitions
			 SET field_key = ?, label = ?, field_type = ?, required = ?, enum_options = ?, updated_at = ?,
			     pinned = ?, sort_order = ?
		 WHERE id = ? AND deleted_at IS NULL`
	)
		.bind(
			payload.key, payload.label, payload.type, payload.required ? 1 : 0,
			JSON.stringify(payload.enumOptions), now,
			// Omitted => keep the placement the librarian already chose. A client
			// that predates pinning (or a tab left open across the deploy) would
			// otherwise unpin an attribute as a side effect of renaming its label.
			(payload.pinned ?? existing.pinned === 1) ? 1 : 0,
			payload.sortOrder ?? existing.sort_order,
			id
		)
		.run();

	// Rewriting many books' custom_fields without bumping the cache version
	// leaves the books-list cache serving the old key/value shape.
	if (bookUpdates.length > 0) {
		await bumpBooksCacheVersion(c.env);
	}

	await insertAuditLog(c.env, c.get('user').sub, 'customField.update', 'custom_field', id, {
		oldKey: existing.field_key,
		key: payload.key,
		renamedBooks,
		clearedEnumBooks,
		retypedBooks
	});

	// Counters are per-page; a caller that looped accumulates its own totals.
	return c.json({ id, sweepComplete: true, renamedBooks, clearedEnumBooks, retypedBooks });
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

/**
 * Load a MARCXML file.
 *
 * How a donated collection's records normally arrive, and the lossless
 * counterpart to the MARCXML export. Everything Phase B added has somewhere to
 * land: 880s become the parallel script fields, 300$a the extent, 082 the
 * Dewey, 490 the series, 260/264$c an EDTF date.
 *
 * Matched on ISBN so re-loading the same file UPDATES rather than duplicating —
 * the same contract the XLSX import has via `legacy_id`. A record with no ISBN
 * always inserts, because there is nothing to match it on.
 */
app.post('/api/import/marcxml', requirePermission('import'), async (c) => {
	const dryRun = c.req.query('dryRun') === '1';
	const xml = await c.req.text();
	if (!xml.trim()) throw new HTTPException(400, { message: 'Empty request body' });
	// 4 MB of MARCXML is roughly 4,000 records; past that the parse alone will
	// outrun the invocation, so the file has to be split.
	if (xml.length > 4_000_000) {
		throw new HTTPException(413, { message: 'MARCXML file too large — split it into chunks of a few thousand records.' });
	}

	let records: ParsedMarcRecord[];
	try {
		records = await parseMarcXml(xml);
	} catch (error) {
		throw new HTTPException(400, { message: `Could not parse MARCXML: ${(error as Error).message}` });
	}
	if (records.length === 0) throw new HTTPException(400, { message: 'No <record> elements found' });

	const now = nowIso();
	const actor = c.get('user').sub;
	let created = 0, updated = 0, skipped = 0;
	const problems: string[] = [];

	for (const rec of records) {
		const f = marcToBookFields(rec);
		if (!f.title) { skipped += 1; problems.push('a record has no 245$a title'); continue; }

		// An imprint date is transcribed as printed. Keep it only if it is EDTF
		// we understand; otherwise fall back to the bare year the regex found, so
		// a date like "[1955?]" still sorts instead of being dropped.
		const edtf = f.dateEdtf && parseEdtf(f.dateEdtf) ? f.dateEdtf
			: (f.publicationYear ? String(f.publicationYear) : null);

		const payload = normalizeBookData({
			title: f.title,
			author: f.author ?? '',
			titleRomanized: f.titleRomanized ?? null,
			authorRomanized: f.authorRomanized ?? null,
			publisherRomanized: f.publisherRomanized ?? null,
			isbn: f.isbn ?? null,
			publisher: f.publisher ?? null,
			language: f.language ?? null,
			description: f.description ?? null,
			ddc: f.ddc ?? null,
			dateEdtf: edtf,
			// Derived from dateEdtf by normalizeBookData; declared so the shape
			// carries them.
			publicationYear: null as number | null,
			publicationYearEnd: null as number | null,
			customFields: {
				...(f.extent ? { pages: f.extent } : {}),
				...(f.placeOfPublication ? { place_of_publication: f.placeOfPublication } : {}),
				...(f.edition ? { edition: f.edition } : {}),
				...(f.seriesTitle ? { series: f.seriesTitle } : {}),
				...(f.volumeDesignation ? { volume_num: f.volumeDesignation } : {}),
				...(f.issn ? { issn: f.issn } : {}),
				...(f.subtitle ? { subTitle: f.subtitle } : {})
			}
		});

		if (dryRun) { created += 1; continue; }

		const existing = payload.isbn
			? await c.env.DB.prepare('SELECT id, version FROM books WHERE isbn = ? AND deleted_at IS NULL LIMIT 1')
				.bind(payload.isbn).first<{ id: string; version: number }>()
			: null;

		try {
			if (existing) {
				// Re-import updates in place. Only fields the record actually
				// carries are written — a MARC record that omits a field must not
				// blank what the librarian already catalogued by hand.
				const cf = await validateCustomFields(c.env, payload.customFields as Record<string, unknown>);
				await c.env.DB.prepare(
					`UPDATE books SET title = ?, author = ?, publisher = ?, language = ?, description = ?,
					        ddc = COALESCE(?, ddc), date_edtf = COALESCE(?, date_edtf),
					        publication_year = COALESCE(?, publication_year),
					        publication_year_end = COALESCE(?, publication_year_end),
					        title_romanized = COALESCE(?, title_romanized),
					        author_romanized = COALESCE(?, author_romanized),
					        publisher_romanized = COALESCE(?, publisher_romanized),
					        custom_fields = json_patch(custom_fields, ?),
					        updated_at = ?, version = version + 1
					  WHERE id = ?`
				).bind(
					payload.title, payload.author, payload.publisher ?? null, payload.language ?? null,
					payload.description ?? null, payload.ddc ?? null, payload.dateEdtf ?? null,
					payload.publicationYear ?? null, payload.publicationYearEnd ?? null,
					payload.titleRomanized ?? null, payload.authorRomanized ?? null, payload.publisherRomanized ?? null,
					JSON.stringify(cf), now, existing.id
				).run();
				// Deliberately NOT ensurePrimaryItem here: it writes the passed
				// location onto the primary copy, and this payload carries none —
				// re-importing would blank the shelf the librarian assigned. MARC
				// 852 holdings import is its own job.
				updated += 1;
			} else {
				const id = crypto.randomUUID();
				const cf = await validateCustomFields(c.env, payload.customFields as Record<string, unknown>);
				const cfJson = JSON.stringify(cf);
				const folds = computeBookFolds({
					title: payload.title, author: payload.author, isbn: payload.isbn ?? null,
					publisher: payload.publisher ?? null, description: payload.description ?? null,
					tagsJson: '[]', customFieldsJson: cfJson,
					titleRomanized: payload.titleRomanized ?? null,
					authorRomanized: payload.authorRomanized ?? null,
					publisherRomanized: payload.publisherRomanized ?? null
				});
				await c.env.DB.prepare(
					`INSERT INTO books (id, title, author, isbn, publication_year, publication_year_end, date_edtf,
					                    publisher, language, description, ddc,
					                    title_romanized, author_romanized, publisher_romanized,
					                    tags, custom_fields, status, version, created_at, updated_at,
					                    title_fold, author_fold, isbn_fold, publisher_fold, description_fold,
					                    tags_fold, custom_fields_fold,
					                    title_romanized_fold, author_romanized_fold, publisher_romanized_fold)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'available', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				).bind(
					id, payload.title, payload.author, payload.isbn ?? null,
					payload.publicationYear ?? null, payload.publicationYearEnd ?? null, payload.dateEdtf ?? null,
					payload.publisher ?? null, payload.language ?? null, payload.description ?? null, payload.ddc ?? null,
					payload.titleRomanized ?? null, payload.authorRomanized ?? null, payload.publisherRomanized ?? null,
					cfJson, now, now,
					folds.title_fold, folds.author_fold, folds.isbn_fold, folds.publisher_fold,
					folds.description_fold, folds.tags_fold, folds.custom_fields_fold,
					folds.title_romanized_fold, folds.author_romanized_fold, folds.publisher_romanized_fold
				).run();
				// A new record needs a copy to exist at all, or it is invisible to
				// every location filter. Unshelved until someone places it.
				await ensurePrimaryItem(c.env, id, {});
				created += 1;
			}
		} catch (error) {
			skipped += 1;
			problems.push(`${f.title.slice(0, 50)}: ${(error as Error).message}`);
		}
	}

	if (!dryRun && (created > 0 || updated > 0)) await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, actor, 'import.marcxml', 'book', null, {
		records: records.length, created, updated, skipped, dryRun
	});

	return c.json({
		records: records.length, created, updated, skipped, dryRun,
		// Capped: a bad file can produce one problem per record and the operator
		// only needs enough to see the pattern.
		problems: problems.slice(0, 20)
	});
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
	let updatedRows = 0;
	for (const item of readyRows) {
		const { index, customFields } = item;
		const row = normalizeBookData(item.row);
		// A newly-imported book can't already be on loan — never create it 'borrowed'.
		if (row.status === 'borrowed') row.status = 'available';
		try {
			// Re-running an import is a normal thing to do: the librarian fixes a
			// few cells and uploads the corrected sheet. When the sheet carries a
			// stable id, match on it and UPDATE — otherwise every re-run silently
			// doubled the catalogue and there was no way to undo it in bulk.
			const legacyId = (item.row as { legacyId?: string | null }).legacyId?.trim() || null;
			let existing: { id: string; deleted_at: string | null } | null = null;
			if (legacyId) {
				existing = await c.env.DB.prepare(
					'SELECT id, deleted_at FROM books WHERE legacy_id = ? LIMIT 1'
				)
					.bind(legacyId)
					.first<{ id: string; deleted_at: string | null } | null>();
			}
			// A book the librarian deliberately trashed must not come back to life
			// because it is still sitting in the source sheet.
			if (existing?.deleted_at) {
				skippedRows.push({ index, reason: 'matching book is in the trash — restore it first' });
				continue;
			}

			const bookId = existing?.id ?? crypto.randomUUID();
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
			if (existing) {
				// Status is deliberately NOT updated: the book's circulation state is
				// owned by the borrow/return flow, and a sheet saying 'available'
				// must not wipe out an open loan.
				await c.env.DB.prepare(
					`UPDATE books SET
						title = ?, author = ?, isbn = ?, publication_year = ?, publisher = ?, language = ?,
						description = ?, room_code = ?, shelf_code = ?, acquisition_date = ?,
						tags = ?, custom_fields = ?, updated_at = ?, version = version + 1,
						title_fold = ?, author_fold = ?, isbn_fold = ?, publisher_fold = ?,
						description_fold = ?, tags_fold = ?, custom_fields_fold = ?
					 WHERE id = ? AND deleted_at IS NULL`
				)
					.bind(
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
						now,
						importFolds.title_fold,
						importFolds.author_fold,
						importFolds.isbn_fold,
						importFolds.publisher_fold,
						importFolds.description_fold,
						importFolds.tags_fold,
						importFolds.custom_fields_fold,
						bookId
					)
					.run();
			} else {
				await c.env.DB.prepare(
					`INSERT INTO books (
						id, title, author, isbn, publication_year, publisher, language, description,
						room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
						legacy_id, created_at, updated_at, deleted_at,
						title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
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
						// Persist the source key so the NEXT re-import can find this row.
						// It was dropped before, which is why re-imports duplicated.
						legacyId,
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
			}

			await replaceBookAttributeValues(c.env, bookId, customFields);
			if (existing) updatedRows += 1;
			else importedRows += 1;
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'insert failed';
			skippedRows.push({ index, reason });
		}
	}

	if (importedRows > 0 || updatedRows > 0) {
		await bumpBooksCacheVersion(c.env);
	}

	try {
		await insertAuditLog(c.env, c.get('user').sub, 'book.import', 'book', null, {
			rows: importedRows,
			updatedRows,
			skippedRows
		});
	} catch (error) {
		console.warn('Audit log failed for book.import, continuing', error);
	}

	return c.json({ importedRows, updatedRows, skippedRows }, 201);
});

// ─── Standard-format export ───────────────────────────────────────────────
//
// MARC 21 (as MARCXML or MARC-in-JSON) and Dublin Core, so this catalogue can
// be handed to another library, a union catalogue, or a migration.
//
// The XLSX and CSV routes are untouched and remain the everyday export — this
// is added alongside, for exchange. Streamed page by page rather than built in
// memory: 12.5K MARCXML records is several megabytes, and a Worker that
// assembles the whole string first will run out of room long before it finishes.
// ─── SRU and OAI-PMH ───────────────────────────────────────────────────────
//
// The two protocols another library reads a catalogue with. Both public, both
// read-only, both bibliographic records only — never borrowers, loans, staff,
// or item barcodes.
//
// OFF until `publicSharing` is turned on in Settings. Publishing a catalogue is
// outward-facing and effectively irreversible once harvesters have cached it,
// so it is the librarian's decision to make, not a default.
const HARVEST_PAGE_SIZE = 100;

async function sharingEnabled(env: Env): Promise<{ on: boolean; settings: Record<string, string | null> }> {
  const settings = await getLibrarySettings(env);
  return { on: (settings.publicSharing ?? '').toLowerCase() === 'on', settings };
}

/** Assemble the standard-format view of a page of books in one go. */
async function marcInputsForRows(
  env: Env, rows: Array<Record<string, unknown>>, isil: string | null
) {
  const ids = rows.map((r) => String(r.id));
  const [itemsByBook, extras] = await Promise.all([
    loadItemsForBooks(env, ids),
    loadMarcExtrasForBooks(env, ids)
  ]);
  return rows.map((row) => {
    const id = String(row.id);
    const extra = extras.get(id);
    return {
      row,
      input: bookRowToMarcInput(row, {
        items: itemsByBook.get(id) ?? [],
        contributors: extra?.contributors,
        subjects: extra?.subjects,
        seriesTitle: extra?.seriesTitle,
        isil
      })
    };
  });
}

app.get('/api/sru', async (c) => {
	const { on, settings } = await sharingEnabled(c.env);
	const url = new URL(c.req.url);
	const q = (name: string) => url.searchParams.get(name) ?? '';

	if (!on) {
		return c.body(
			sruDiagnostic('1', 'public sharing is disabled', 'This catalogue is not published'),
			503, { 'Content-Type': 'application/xml; charset=utf-8' }
		);
	}

	const operation = q('operation') || 'explain';
	const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').first<{ n: number }>();

	if (operation === 'explain') {
		return c.body(
			sruExplain(url.origin + url.pathname, settings.libraryName ?? 'OK Library', Number(total?.n ?? 0)),
			200, { 'Content-Type': 'application/xml; charset=utf-8' }
		);
	}
	if (operation !== 'searchRetrieve') {
		return c.body(sruDiagnostic('4', operation, 'Unsupported operation'), 200,
			{ 'Content-Type': 'application/xml; charset=utf-8' });
	}

	const schema = (q('recordSchema') || 'marcxml').toLowerCase();
	if (!['marcxml', 'dc', 'info:srw/schema/1/marcxml-v1.1', 'info:srw/schema/1/dc-v1.1'].includes(schema)) {
		return c.body(sruDiagnostic('66', schema, 'Unknown record schema'), 200,
			{ 'Content-Type': 'application/xml; charset=utf-8' });
	}
	const asDc = schema.includes('dc');

	const parsed = parseCql(q('query'));
	if (!parsed.ok) {
		return c.body(sruDiagnostic(parsed.diagnostic, parsed.detail, 'Query not supported'), 200,
			{ 'Content-Type': 'application/xml; charset=utf-8' });
	}

	// CQL indexes map onto the search the catalogue already has, rather than a
	// second query path that could disagree with it.
	const searchFields = new Set<string>();
	const words: string[] = [];
	let year: number | undefined;
	let language: string | undefined;
	for (const term of parsed.terms) {
		if (term.index === 'date') { const n = Number(term.value); if (Number.isInteger(n)) year = n; continue; }
		if (term.index === 'language') { language = term.value; continue; }
		words.push(term.value);
		if (term.index !== 'any') searchFields.add(term.index);
	}

	const startRecord = Math.max(1, Number(q('startRecord') || '1'));
	const maximumRecords = Math.min(100, Math.max(0, Number(q('maximumRecords') || '10')));

	const result = await queryBooksWithFilters(c.env, {
		q: words.join(' '),
		qMode: 'all',
		partialWords: true,
		// Deterministic for a protocol client: an SRU caller paging through
		// results must get a stable set, not fuzzy near-misses that shift.
		fuzzyTypos: false,
		searchFields: searchFields.size ? [...searchFields].join(',') : undefined,
		year,
		language,
		customFilters: [],
		sortBy: 'title', sortDir: 'asc',
		page: Math.floor((startRecord - 1) / Math.max(1, maximumRecords)) + 1,
		pageSize: Math.max(1, maximumRecords)
	});

	const rendered = maximumRecords === 0 ? [] : await marcInputsForRows(c.env, result.rows, settings.isil ?? null);
	const records = rendered.map(({ input }, i) => [
		'    <record>',
		`      <recordSchema>${asDc ? 'info:srw/schema/1/dc-v1.1' : 'info:srw/schema/1/marcxml-v1.1'}</recordSchema>`,
		'      <recordPacking>xml</recordPacking>',
		'      <recordData>',
		asDc ? toDublinCoreXml(input) : toMarcXml(input),
		'      </recordData>',
		`      <recordPosition>${startRecord + i}</recordPosition>`,
		'    </record>'
	].join('\n'));

	const nextPosition = startRecord + rendered.length;
	const body = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">',
		'  <version>1.2</version>',
		`  <numberOfRecords>${result.total}</numberOfRecords>`,
		records.length ? '  <records>' : '',
		...records,
		records.length ? '  </records>' : '',
		nextPosition <= result.total ? `  <nextRecordPosition>${nextPosition}</nextRecordPosition>` : '',
		'</searchRetrieveResponse>'
	].filter(Boolean).join('\n');

	return c.body(body, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
});

app.get('/api/oai', async (c) => {
	const url = new URL(c.req.url);
	const requestUrl = url.origin + url.pathname;
	const responseDate = oaiDatestamp(new Date().toISOString());
	const q = (name: string) => url.searchParams.get(name) ?? '';
	const xml = (body: string) => c.body(body, 200, { 'Content-Type': 'text/xml; charset=utf-8' });

	const { on, settings } = await sharingEnabled(c.env);
	if (!on) {
		return c.body(
			oaiError(requestUrl, 'badArgument', 'This catalogue is not published', responseDate),
			503, { 'Content-Type': 'text/xml; charset=utf-8' }
		);
	}
	const isil = settings.isil ?? null;
	const host = url.host;
	const verb = q('verb');

	if (verb === 'Identify') {
		const earliest = await c.env.DB.prepare('SELECT MIN(updated_at) AS d FROM books').first<{ d: string | null }>();
		return xml(oaiIdentify(requestUrl, {
			repositoryName: settings.libraryName ?? 'OK Library',
			baseUrl: requestUrl,
			adminEmail: settings.adminEmail ?? `admin@${host}`,
			earliestDatestamp: oaiDatestamp(earliest?.d),
			responseDate, isil
		}));
	}

	if (verb === 'ListMetadataFormats') {
		return xml(oaiResponse(requestUrl, verb, {}, [
			'  <ListMetadataFormats>',
			'    <metadataFormat>',
			'      <metadataPrefix>oai_dc</metadataPrefix>',
			'      <schema>http://www.openarchives.org/OAI/2.0/oai_dc.xsd</schema>',
			'      <metadataNamespace>http://www.openarchives.org/OAI/2.0/oai_dc/</metadataNamespace>',
			'    </metadataFormat>',
			'    <metadataFormat>',
			'      <metadataPrefix>marcxml</metadataPrefix>',
			'      <schema>http://www.loc.gov/standards/marcxml/schema/MARC21slim.xsd</schema>',
			'      <metadataNamespace>http://www.loc.gov/MARC21/slim</metadataNamespace>',
			'    </metadataFormat>',
			'  </ListMetadataFormats>'
		].join('\n'), responseDate));
	}

	if (verb === 'ListSets') {
		// No set hierarchy: sets would have to mean something stable to a
		// harvester, and this catalogue's categories are still being reorganised.
		return xml(oaiError(requestUrl, 'noSetHierarchy', 'This repository has no sets', responseDate));
	}

	if (verb === 'GetRecord') {
		const prefix = q('metadataPrefix');
		if (!['oai_dc', 'marcxml'].includes(prefix)) {
			return xml(oaiError(requestUrl, 'cannotDisseminateFormat', `Unknown metadataPrefix "${prefix}"`, responseDate));
		}
		const bookId = parseOaiIdentifier(q('identifier'));
		if (!bookId) return xml(oaiError(requestUrl, 'idDoesNotExist', 'Malformed identifier', responseDate));
		const row = await c.env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(bookId).first();
		if (!row) return xml(oaiError(requestUrl, 'idDoesNotExist', 'No such record', responseDate));

		const parsedRow = parseBook(row as Record<string, unknown>);
		const identifier = oaiIdentifier(isil, host, bookId);
		const datestamp = oaiDatestamp(String(parsedRow.updatedAt ?? ''));
		if (parsedRow.deletedAt) {
			return xml(oaiResponse(requestUrl, verb, { identifier: q('identifier'), metadataPrefix: prefix }, [
				'  <GetRecord>', '    <record>',
				`      <header status="deleted"><identifier>${xmlEscape(identifier)}</identifier><datestamp>${datestamp}</datestamp></header>`,
				'    </record>', '  </GetRecord>'
			].join('\n'), responseDate));
		}
		const [{ input }] = await marcInputsForRows(c.env, [parsedRow], isil);
		return xml(oaiResponse(requestUrl, verb, { identifier: q('identifier'), metadataPrefix: prefix }, [
			'  <GetRecord>', '    <record>',
			`      <header><identifier>${xmlEscape(identifier)}</identifier><datestamp>${datestamp}</datestamp></header>`,
			'      <metadata>',
			prefix === 'marcxml' ? toMarcXml(input) : toDublinCoreXml(input),
			'      </metadata>',
			'    </record>', '  </GetRecord>'
		].join('\n'), responseDate));
	}

	if (verb === 'ListRecords' || verb === 'ListIdentifiers') {
		const token = q('resumptionToken');
		let offset = 0;
		let prefix = q('metadataPrefix');
		let from = q('from') || undefined;
		let until = q('until') || undefined;

		if (token) {
			// The spec forbids combining a resumption token with other arguments —
			// the token already carries them, and honouring both would silently
			// change the harvest mid-run.
			for (const other of ['metadataPrefix', 'from', 'until', 'set']) {
				if (url.searchParams.get(other)) {
					return xml(oaiError(requestUrl, 'badArgument', `"${other}" cannot be combined with resumptionToken`, responseDate));
				}
			}
			const state = decodeResumptionToken(token);
			if (!state) return xml(oaiError(requestUrl, 'badResumptionToken', 'Token is not valid', responseDate));
			({ offset, prefix } = state);
			from = state.from; until = state.until;
		} else if (!['oai_dc', 'marcxml'].includes(prefix)) {
			return xml(oaiError(requestUrl, 'cannotDisseminateFormat', `Unknown metadataPrefix "${prefix}"`, responseDate));
		}

		const page = await loadOaiPage(c.env, { from, until, offset, limit: HARVEST_PAGE_SIZE });
		if (page.rows.length === 0) {
			return xml(oaiError(requestUrl, 'noRecordsMatch', 'No records in that range', responseDate));
		}

		const wantMetadata = verb === 'ListRecords';
		// A deleted record has no metadata to render, only a tombstone header —
		// so only the live ones need the expensive assembly.
		const live = page.rows.filter((r) => !r.deletedAt);
		const rendered = wantMetadata ? await marcInputsForRows(c.env, live, isil) : [];
		const byId = new Map(rendered.map(({ row, input }) => [String(row.id), input]));

		const entries = page.rows.map((row) => {
			const id = String(row.id);
			const identifier = oaiIdentifier(isil, host, id);
			const datestamp = oaiDatestamp(String(row.updatedAt ?? ''));
			const header = row.deletedAt
				? `      <header status="deleted"><identifier>${xmlEscape(identifier)}</identifier><datestamp>${datestamp}</datestamp></header>`
				: `      <header><identifier>${xmlEscape(identifier)}</identifier><datestamp>${datestamp}</datestamp></header>`;
			if (!wantMetadata) return header.replace(/^ {6}/, '    ');
			if (row.deletedAt) return ['    <record>', header, '    </record>'].join('\n');
			const input = byId.get(id);
			return [
				'    <record>', header, '      <metadata>',
				prefix === 'marcxml' ? toMarcXml(input!) : toDublinCoreXml(input!),
				'      </metadata>', '    </record>'
			].join('\n');
		});

		const nextOffset = offset + page.rows.length;
		const more = nextOffset < page.total;
		const resumption = more
			? `  <resumptionToken completeListSize="${page.total}" cursor="${offset}">`
				+ xmlEscape(encodeResumptionToken({ offset: nextOffset, from, until, prefix }))
				+ '</resumptionToken>'
			// An empty token signals "this was the last page" per the spec.
			: `  <resumptionToken completeListSize="${page.total}" cursor="${offset}"></resumptionToken>`;

		return xml(oaiResponse(requestUrl, verb,
			token ? { resumptionToken: token } : { metadataPrefix: prefix, from: from ?? '', until: until ?? '' },
			[`  <${verb}>`, ...entries, resumption, `  </${verb}>`].join('\n'), responseDate));
	}

	return xml(oaiError(requestUrl, 'badVerb', verb ? `Unknown verb "${verb}"` : 'No verb supplied', responseDate));
});

app.get('/api/export/books.marcxml', requirePermission('export.csv', { librarian: true }), async (c) => {
	const format = c.req.query('format') === 'json' ? 'json' : 'marcxml';
	const settings = await getLibrarySettings(c.env);
	const isil = settings.isil ?? null;
	const pageSize = 200;

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			const write = (s: string) => controller.enqueue(enc.encode(s));
			write(format === 'json' ? '[\n' : MARCXML_COLLECTION_OPEN + '\n');
			let page = 1;
			let first = true;
			try {
				for (;;) {
					const result = await queryBooksWithFilters(c.env, {
						sortBy: 'updatedAt', sortDir: 'desc', page, pageSize,
						customFilters: [],
						// The total is discarded on every page, so don't pay for the
						// COUNT(*) scan 63 times over.
						skipCount: true
					});
					if (result.rows.length === 0) break;
					const ids = result.rows.map((r) => String((r as { id: unknown }).id));
					const [itemsByBook, extras] = await Promise.all([
						loadItemsForBooks(c.env, ids),
						loadMarcExtrasForBooks(c.env, ids)
					]);
					for (const row of result.rows) {
						const id = String((row as { id: unknown }).id);
						const extra = extras.get(id);
						const input = bookRowToMarcInput(row as Record<string, unknown>, {
							items: itemsByBook.get(id) ?? [],
							contributors: extra?.contributors,
							subjects: extra?.subjects,
							seriesTitle: extra?.seriesTitle,
							isil
						});
						if (format === 'json') {
							write((first ? '' : ',\n') + JSON.stringify(toMarcJson(input)));
						} else {
							write(toMarcXml(input) + '\n');
						}
						first = false;
					}
					if (result.rows.length < pageSize) break;
					page += 1;
				}
				write(format === 'json' ? '\n]\n' : MARCXML_COLLECTION_CLOSE + '\n');
			} catch (error) {
				console.warn('MARC export failed mid-stream', error);
				// The response has already begun, so the only honest signal left is
				// an unterminated document — better than a truncated one that looks
				// complete and silently loses the tail of the catalogue.
				controller.error(error);
				return;
			}
			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'application/xml; charset=utf-8',
			'Content-Disposition': `attachment; filename="books.${format === 'json' ? 'marc.json' : 'marcxml'}"`
		}
	});
});

// One record, in whichever standard format the caller asks for. This is also
// what SRU and OAI-PMH render through.
app.get('/api/books/:id/marc', async (c) => {
	const id = c.req.param('id') ?? '';
	const row = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').bind(id).first();
	if (!row) throw new HTTPException(404, { message: 'Book not found' });
	const settings = await getLibrarySettings(c.env);
	const [items, extras] = await Promise.all([
		loadBookItems(c.env, id),
		loadMarcExtrasForBooks(c.env, [id])
	]);
	const extra = extras.get(id);
	const input = bookRowToMarcInput(parseBook(row as Record<string, unknown>), {
		items, contributors: extra?.contributors, subjects: extra?.subjects,
		seriesTitle: extra?.seriesTitle, isil: settings.isil ?? null
	});

	const format = c.req.query('format') ?? 'marcxml';
	if (format === 'json') return c.json(toMarcJson(input));
	if (format === 'dc') {
		return c.body(
			`<?xml version="1.0" encoding="UTF-8"?>\n${toDublinCoreXml(input)}\n`,
			200, { 'Content-Type': 'application/xml; charset=utf-8' }
		);
	}
	return c.body(
		`${MARCXML_COLLECTION_OPEN}\n${toMarcXml(input)}\n${MARCXML_COLLECTION_CLOSE}\n`,
		200, { 'Content-Type': 'application/xml; charset=utf-8' }
	);
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

	// Resolve the matching ids in ONE query, then read the rows by id.
	//
	// This used to walk `page=1,2,3…` with pageSize 100. OFFSET paging makes
	// SQLite re-scan and discard every row before the offset, so exporting a
	// 12.5K catalogue cost ~800K row reads — a single export could eat a
	// sixth of the daily D1 read budget, and it grew with the SQUARE of the
	// catalogue. Fetching by id is linear: one id scan plus one read per row.
	// 20,000 is the ids-only query's own hard cap (see queryBooksWithFilters).
	const EXPORT_ROW_LIMIT = 20_000;
	const idResult = await queryBooksWithFilters(c.env, {
		...query,
		customFilters,
		includeDeleted: false,
		idsOnly: true,
		idsLimit: EXPORT_ROW_LIMIT,
		skipCount: true
	});
	// Ids-only returns `ids`; the fuzzy-search path can't and returns whole rows
	// instead, so accept either shape.
	const exportIds = (
		idResult.ids ?? (idResult.rows as Array<Record<string, unknown>>).map((r) => String(r.id ?? ''))
	).filter(Boolean);

	const aggregatedRows: Array<Record<string, unknown>> = [];
	// D1 allows at most 100 bound parameters per statement, so each SELECT takes
	// 90 ids; several statements are then sent in one batch() so a full-catalogue
	// export is a handful of round-trips rather than a hundred and forty.
	const IDS_PER_STATEMENT = 90;
	const STATEMENTS_PER_BATCH = 20;
	const idStatements: D1PreparedStatement[] = [];
	for (let i = 0; i < exportIds.length; i += IDS_PER_STATEMENT) {
		const batch = exportIds.slice(i, i + IDS_PER_STATEMENT);
		const placeholders = batch.map(() => '?').join(',');
		idStatements.push(
			c.env.DB.prepare(`SELECT * FROM books WHERE id IN (${placeholders}) AND deleted_at IS NULL`).bind(...batch)
		);
	}
	for (let i = 0; i < idStatements.length; i += STATEMENTS_PER_BATCH) {
		const results = await c.env.DB.batch<Record<string, unknown>>(
			idStatements.slice(i, i + STATEMENTS_PER_BATCH)
		);
		for (const res of results) {
			for (const row of res.results ?? []) {
				aggregatedRows.push(parseBook(row) as unknown as Record<string, unknown>);
			}
		}
	}
	// `IN (...)` does not preserve the requested order, so restore the sort the
	// caller asked for — an export whose rows are in arbitrary order is much
	// harder to diff against the previous one.
	const idOrder = new Map(exportIds.map((exportId, position) => [exportId, position]));
	aggregatedRows.sort(
		(a, b) => (idOrder.get(String(a.id)) ?? 0) - (idOrder.get(String(b.id)) ?? 0)
	);

	// The CSV doubles as this library's off-site backup, so it must carry every
	// field — not just the twenty columns of the original catalogue sheet.
	// Previously tags, status, room code, publication year, acquisition date,
	// the legacy id, and ANY custom field the librarian added later were all
	// absent, so a restore from this file would have quietly lost them.
	const extraCoreColumns: DefaultBookStructureColumn[] = [
		{ label: 'Publication Year', coreKey: 'publicationYear' },
		{ label: 'Room Code', coreKey: 'roomCode' },
		{ label: 'Acquisition Date', coreKey: 'acquisitionDate' },
		{ label: 'Status', coreKey: 'status' },
		{ label: 'Legacy ID', coreKey: 'legacyId' },
		{ label: 'Created At', coreKey: 'createdAt' },
		{ label: 'Updated At', coreKey: 'updatedAt' }
	];
	const knownCustomKeys = new Set(
		DEFAULT_BOOK_STRUCTURE.filter((column) => column.customKey).map((column) => column.customKey as string)
	);
	const extraCustomColumns: DefaultBookStructureColumn[] = (await loadCustomFieldDefs(c.env))
		.filter((def) => !knownCustomKeys.has(def.field_key))
		.map((def) => ({ label: def.field_key, customKey: def.field_key }));

	const exportColumns: DefaultBookStructureColumn[] = [
		...DEFAULT_BOOK_STRUCTURE,
		...extraCoreColumns,
		...extraCustomColumns
	];
	// 'Tags' is handled separately: it is an array on the row and needs joining.
	const TAGS_LABEL = 'Tags';

	const exportRows = aggregatedRows.map((row) => {
		const customFields = (row.customFields as Record<string, unknown> | undefined) ?? {};
		const shaped: Record<string, unknown> = {};

		for (const column of exportColumns) {
			if (column.coreKey) {
				shaped[column.label] = row[column.coreKey];
			} else if (column.customKey) {
				shaped[column.label] = customFields[column.customKey] ?? null;
			}
		}
		const tags = row.tags;
		shaped[TAGS_LABEL] = Array.isArray(tags) ? tags.join('; ') : (tags ?? null);

		return shaped;
	});

	const csv = toCsv(exportRows, [...exportColumns.map((column) => column.label), TAGS_LABEL]);

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

	const embedUpsertIds = new Set<string>();
	const embedDeleteIds = new Set<string>();

	for (const mutation of payload.mutations) {
		let status: 'success' | 'error' = 'success';
		let resultData: Record<string, unknown> = {};

		// Idempotency: replay a prior SUCCESS for this clientMutationId+actor
		// instead of re-executing. The mobile client sends no
		// X-Client-Mutation-Id header, so the whole-request mutation-log
		// middleware never dedups it; without this a mutation that committed but
		// whose HTTP response was lost gets re-run on the next push and silently
		// duplicates (a second borrow, a second created book, …).
		const prior = await c.env.DB.prepare(
			`SELECT result_data FROM sync_mutations
			  WHERE client_mutation_id = ? AND actor_id = ? AND result_status = 'success' LIMIT 1`
		).bind(mutation.clientMutationId, actor.sub).first<{ result_data: string | null }>();
		if (prior) {
			results.push({
				clientMutationId: mutation.clientMutationId,
				operation: mutation.operation,
				status: 'success',
				result: safeJsonParse<Record<string, unknown>>(prior.result_data ?? '{}', {})
			});
			continue;
		}

		try {
			if (mutation.operation === 'create_book') {
				const row = normalizeBookData(CreateBookSchema.parse(mutation.payload));
				// A newly-created book can't be on loan yet — never create it 'borrowed'.
				if (row.status === 'borrowed') row.status = 'available';
				const customFields = await validateCustomFields(c.env, row.customFields);
				const now = nowIso();
				// Deterministic id from the client mutation id: if a prior attempt
				// committed the INSERT but its response (or the sync_mutations log)
				// was lost, the retry lands on the SAME id and the INSERT OR IGNORE
				// below no-ops instead of creating a duplicate book. Belt-and-braces
				// on top of the sync_mutations replay above (which only fires when the
				// log itself was written).
				const id = await deterministicUuid(`create_book:${mutation.clientMutationId}`);
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
					customFieldsJson,
					titleRomanized: row.titleRomanized ?? null,
					authorRomanized: row.authorRomanized ?? null,
					publisherRomanized: row.publisherRomanized ?? null
				});
				await c.env.DB.prepare(
					`INSERT OR IGNORE INTO books (
						id, title, author, isbn, publication_year, publication_year_end, date_edtf,
						publisher, language, description, ddc,
						title_romanized, author_romanized, publisher_romanized,
						room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
						created_at, updated_at, deleted_at,
						title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold,
						title_romanized_fold, author_romanized_fold, publisher_romanized_fold
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
					.bind(
						id,
						row.title,
						row.author,
						row.isbn ?? null,
						row.publicationYear ?? null,
						row.publicationYearEnd ?? row.publicationYear ?? null,
						row.dateEdtf ?? null,
						row.publisher ?? null,
						row.language ?? null,
						row.description ?? null,
						row.ddc ?? null,
						row.titleRomanized ?? null,
						row.authorRomanized ?? null,
						row.publisherRomanized ?? null,
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
						folds.custom_fields_fold,
						folds.title_romanized_fold,
						folds.author_romanized_fold,
						folds.publisher_romanized_fold
					)
					.run();
				await replaceBookAttributeValues(c.env, id, customFields);
				await ensurePrimaryItem(c.env, id, row);
				resultData = { id };
			} else if (mutation.operation === 'delete_book') {
				// Deletion needs its OWN permission. The route is gated only on the
				// coarse books.write, so without this a librarian whose admin turned
				// "Delete books" OFF could still soft-delete the whole catalogue
				// through the bulk Delete button (same reasoning as the circulation
				// re-check below). No `librarian: true` default — books.delete is
				// deny-by-default for librarian and viewer, matching DELETE /api/books/:id.
				if (!(await userHasPermission(c, 'books.delete'))) {
					throw new HTTPException(403, { message: 'Permission denied: books.delete' });
				}
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
				} else {
					// Mirror the direct DELETE: the copies go with the record.
					await setItemsDeleted(c.env, row.id, now);
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

				// Match the direct PUT exactly. Strict validation here meant a queued
				// edit failed forever if an attribute had since been made required
				// or deleted — the mutation could never drain, and a bulk edit that
				// touched only the shelf code was rejected over an unrelated field.
				await assertPatchKeepsRequiredFields(c.env, incoming);
				const syncCustomFields = await validateCustomFields(
					c.env,
					// Patch before validating — see the direct PUT for why.
					applyBookPatchFields(
						{
							customFields: (incoming.customFields ??
								JSON.parse(((current as Record<string, unknown>).custom_fields as string) ?? '{}')) as Record<string, unknown>,
							tags: []
						},
						incoming
					).customFields,
					{ requireAllRequired: incoming.customFields !== undefined, rejectUnknownKeys: false }
				);
				// Keep values whose DEFINITION was soft-deleted: validate… drops
				// them, which would quietly erase the book's stored value.
				{
					const existingCustom = JSON.parse(
						((current as Record<string, unknown>).custom_fields as string) ?? '{}'
					) as Record<string, unknown>;
					const liveKeys = new Set((await loadCustomFieldDefs(c.env)).map((d) => d.field_key));
					// …but never resurrect a key the patch just cleared (see the PUT).
					const syncCleared = new Set(
						Object.entries(incoming.customFieldsPatch ?? {})
							.filter(([, value]) => value === null || (typeof value === 'string' && value.trim() === ''))
							.map(([key]) => key)
					);
					for (const [k, v] of Object.entries(existingCustom)) {
						if (!liveKeys.has(k) && !(k in syncCustomFields) && !syncCleared.has(k)) syncCustomFields[k] = v;
					}
				}

				const syncBase = parseBook(current as Record<string, unknown>);
				const syncPatched = applyBookPatchFields(
					{
						customFields: syncCustomFields,
						tags: (incoming.tags ?? syncBase.tags ?? []) as string[]
					},
					{ tagsAdd: incoming.tagsAdd, tagsRemove: incoming.tagsRemove }
				);

				const merged = {
					...syncBase,
					...incoming,
					tags: syncPatched.tags,
					customFields: syncPatched.customFields,
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
					customFieldsJson: mergedCustomFieldsJson,
					titleRomanized: (merged.titleRomanized as string | null) ?? null,
					authorRomanized: (merged.authorRomanized as string | null) ?? null,
					publisherRomanized: (merged.publisherRomanized as string | null) ?? null
				});

				const syncUpd = await c.env.DB.prepare(
					`UPDATE books SET
						 title = ?, author = ?, isbn = ?, publication_year = ?, publication_year_end = ?, date_edtf = ?,
						 publisher = ?, language = ?, description = ?, ddc = ?,
						 title_romanized = ?, author_romanized = ?, publisher_romanized = ?,
						 room_code = ?, shelf_code = ?, acquisition_date = ?, tags = ?, custom_fields = ?, status = ?,
						 version = ?, updated_at = ?,
						 title_fold = ?, author_fold = ?, isbn_fold = ?, publisher_fold = ?, description_fold = ?, tags_fold = ?, custom_fields_fold = ?,
						 title_romanized_fold = ?, author_romanized_fold = ?, publisher_romanized_fold = ?
					 WHERE id = ? AND deleted_at IS NULL AND version = ?`
				)
					.bind(
						merged.title,
						merged.author,
						merged.isbn ?? null,
						merged.publicationYear ?? null,
						merged.publicationYearEnd ?? merged.publicationYear ?? null,
						merged.dateEdtf ?? null,
						merged.publisher ?? null,
						merged.language ?? null,
						merged.description ?? null,
						merged.ddc ?? null,
						merged.titleRomanized ?? null,
						merged.authorRomanized ?? null,
						merged.publisherRomanized ?? null,
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
						mergedFolds.title_romanized_fold,
						mergedFolds.author_romanized_fold,
						mergedFolds.publisher_romanized_fold,
						row.id,
						// Same check-then-act guard as the direct PUT: the write only
						// lands if the row is still at the version we read.
						currentVersion
					)
					.run();
				if ((syncUpd.meta?.changes ?? 0) === 0) {
					throw new HTTPException(409, { message: 'Version conflict' });
				}

				await replaceBookAttributeValues(c.env, row.id, merged.customFields as Record<string, unknown>);
				await ensurePrimaryItem(c.env, row.id, merged as { shelfCode?: string | null; roomCode?: string | null });
				resultData = { id: row.id, version: merged.version };
			} else if (mutation.operation === 'borrow_book') {
				// Lending is a 'circulation' action — enforce it here too, otherwise
				// /api/sync/push (gated only by the coarse books.write) would bypass
				// the circulation gate the direct borrow endpoint requires.
				if (!(await userHasPermission(c, 'circulation', { librarian: true }))) {
					throw new HTTPException(403, { message: 'Permission denied: circulation' });
				}
				const row = z.object({ id: z.string().min(1), data: BorrowBookSchema }).parse(mutation.payload);
				if (row.data.dueAt && Date.parse(row.data.dueAt) <= Date.now()) {
					throw new HTTPException(400, { message: 'dueAt must be in the future.' });
				}
				const { borrowerId, borrowerName, borrowerContact } = await resolveBorrower(c.env, row.data);
				const txId = crypto.randomUUID();
				const now = nowIso();
				const syncItem = await pickLendableItem(c.env, row.id, row.data.itemId ?? null, borrowerId);
				if (!syncItem) {
					throw new HTTPException(409, { message: 'No copy of this book is available' });
				}
				// Same rule as the direct endpoint. A mutation queued offline may
				// arrive days later, so the policy is applied when it LANDS — which
				// is also when the due date starts being meaningful to the reader.
				const syncCategory = borrowerId
					? (await c.env.DB.prepare('SELECT category FROM borrowers WHERE id = ?').bind(borrowerId)
						.first<{ category: string }>())?.category ?? 'standard'
					: 'standard';
				const syncPolicy = await resolveLoanPolicy(c.env, syncCategory, syncItem.itemType);
				if (!syncPolicy.lendable) {
					throw new HTTPException(409, { message: 'This is a consultation-only copy and cannot be lent.' });
				}
				const syncDueAt = row.data.dueAt ?? dueDateFromPolicy(syncPolicy.loanDays);
				// One atomic batch, exactly like the direct endpoint. This branch
				// used to flip the book first and INSERT afterwards inside a
				// try/catch with a compensating revert — a crash between the two
				// left a book borrowed with no ledger row, and the revert could
				// itself fail. A queued offline borrow may arrive hours late, which
				// is precisely when that window matters.
				const syncGuard = `(SELECT 1 FROM items i
					 WHERE i.id = ? AND i.deleted_at IS NULL AND i.status = 'available'
					   AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
					                    WHERE t.item_id = i.id AND t.returned_at IS NULL))`;
				const syncBorrow = await runAtomic(c.env, [
					c.env.DB.prepare(
						`INSERT INTO borrow_transactions (
							 id, book_id, item_id, borrower_id, borrower_name, borrower_contact, borrowed_at, due_at, returned_at, notes, created_by, updated_at
						 )
						 SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
						 WHERE EXISTS ${syncGuard}`
					).bind(
						txId, row.id, syncItem.id, borrowerId, borrowerName, borrowerContact,
						now, syncDueAt, row.data.notes ?? null, actor.sub, now, syncItem.id
					),
					c.env.DB.prepare(
						`UPDATE items SET status = 'borrowed', version = version + 1, updated_at = ?
						 WHERE id = ? AND deleted_at IS NULL AND status = 'available'`
					).bind(now, syncItem.id),
					c.env.DB.prepare(
						`UPDATE books SET status = CASE
						   WHEN EXISTS (SELECT 1 FROM items i WHERE i.book_id = books.id AND i.deleted_at IS NULL
						                  AND i.status = 'available'
						                  AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
						                                   WHERE t.item_id = i.id AND t.returned_at IS NULL))
						     THEN 'available' ELSE 'borrowed' END,
						     version = version + 1, updated_at = ?
						 WHERE id = ? AND deleted_at IS NULL`
					).bind(now, row.id)
				]);
				if ((syncBorrow[1]?.meta?.changes ?? 0) === 0) {
					throw new HTTPException(409, { message: 'That copy is not available' });
				}

				resultData = { transactionId: txId, borrowerId, itemId: syncItem.id };
			} else if (mutation.operation === 'return_book') {
				if (!(await userHasPermission(c, 'circulation', { librarian: true }))) {
					throw new HTTPException(403, { message: 'Permission denied: circulation' });
				}
				const row = z.object({ id: z.string().min(1), data: ReturnBookSchema }).parse(mutation.payload);
				// A queued offline return names the loan it saw. Replaying it against
				// a different open loan would close the wrong borrower's record —
				// exactly the risk offline queues create, since the mutation may be
				// hours old by the time it reaches us. Without a named loan the
				// oldest open one comes back, matching the direct endpoint.
				const tx = row.data.transactionId
					? await c.env.DB.prepare(
						`SELECT id, borrower_name, item_id FROM borrow_transactions
						  WHERE id = ? AND book_id = ? AND returned_at IS NULL`
					).bind(row.data.transactionId, row.id).first<{ id: string; borrower_name: string | null; item_id: string | null }>()
					: await c.env.DB.prepare(
						`SELECT id, borrower_name, item_id FROM borrow_transactions
						  WHERE book_id = ? AND returned_at IS NULL ORDER BY borrowed_at ASC LIMIT 1`
					).bind(row.id).first<{ id: string; borrower_name: string | null; item_id: string | null }>();

				if (!tx) {
					const stillOut = await c.env.DB.prepare(
						`SELECT borrower_name FROM borrow_transactions
						  WHERE book_id = ? AND returned_at IS NULL ORDER BY borrowed_at ASC LIMIT 1`
					).bind(row.id).first<{ borrower_name: string | null }>();
					if (row.data.transactionId && stillOut) {
						throw new HTTPException(409, {
							message: `This copy has since been lent to ${stillOut.borrower_name || 'someone else'}. Refresh and check before returning.`
						});
					}
					throw new HTTPException(409, { message: 'No active borrow transaction found' });
				}

				const now = nowIso();
				// Atomic: close the loan AND bring the copy back AND re-derive the
				// record together, so a mid-request failure can't leave a copy stuck
				// 'borrowed' with no open loan (mirrors /return, guards included).
				const syncReturn = await runAtomic(c.env, [
					c.env.DB.prepare(
						`UPDATE borrow_transactions SET returned_at = ?, return_notes = COALESCE(?, return_notes), updated_at = ?
						 WHERE id = ? AND returned_at IS NULL`
					).bind(now, row.data.notes ?? null, now, tx.id),
					c.env.DB.prepare(
						`UPDATE items SET status = 'available', version = version + 1, updated_at = ?
						 WHERE id = ? AND deleted_at IS NULL AND status = 'borrowed'
						   AND EXISTS (SELECT 1 FROM borrow_transactions WHERE id = ? AND returned_at = ?)`
					).bind(now, tx.item_id ?? '', tx.id, now),
					c.env.DB.prepare(
						`UPDATE books SET status = CASE
						   WHEN EXISTS (SELECT 1 FROM items i WHERE i.book_id = books.id AND i.deleted_at IS NULL
						                  AND i.status = 'available'
						                  AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
						                                   WHERE t.item_id = i.id AND t.returned_at IS NULL))
						     THEN 'available' ELSE books.status END,
						     version = version + 1, updated_at = ?
						 WHERE id = ? AND deleted_at IS NULL
						   AND EXISTS (SELECT 1 FROM borrow_transactions WHERE id = ? AND returned_at = ?)`
					).bind(now, row.id, tx.id, now)
				]);
				if ((syncReturn[0]?.meta?.changes ?? 0) === 0) {
					throw new HTTPException(409, { message: 'This loan was already closed.' });
				}

				resultData = { transactionId: tx.id, itemId: tx.item_id };
			}
		} catch (error) {
			status = 'error';
			resultData = {
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}

		// Track affected book ids so semantic-search embeddings can be refreshed
		// once after the whole batch (re-reading from the DB), rather than per
		// mutation with a stale in-memory snapshot.
		if (status === 'success' && typeof resultData.id === 'string') {
			if (mutation.operation === 'delete_book') embedDeleteIds.add(resultData.id);
			else if (mutation.operation === 'create_book' || mutation.operation === 'update_book') embedUpsertIds.add(resultData.id);
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

	// Refresh semantic-search embeddings for books touched by this sync so
	// offline-synced creates/edits don't leave Vectorize permanently stale
	// (the direct endpoints already do this; the sync path previously skipped
	// it). Re-read each book from the DB so we embed the final committed state,
	// and delete embeddings for removed books. No-op when semantic search is off.
	if (semanticSearchEnabled(c.env) && (embedUpsertIds.size > 0 || embedDeleteIds.size > 0)) {
		runAfterResponse(c, async () => {
			for (const bookId of embedDeleteIds) {
				try { await unvectorizeBook(c.env, bookId); } catch { /* best-effort */ }
			}
			for (const bookId of embedUpsertIds) {
				if (embedDeleteIds.has(bookId)) continue;
				try {
					const row = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').bind(bookId).first();
					if (!row) continue;
					const b = parseBook(row as Record<string, unknown>);
					await vectorizeBook(c.env, bookId, {
						title: b.title as string | null,
						author: b.author as string | null,
						description: (b.description as string | null) ?? null,
						publisher: (b.publisher as string | null) ?? null,
						language: (b.language as string | null) ?? null,
						publicationYear: (b.publicationYear as number | null) ?? null,
						tags: (b.tags as string[] | null) ?? [],
						customFields: (b.customFields as Record<string, unknown>) ?? {}
					});
				} catch { /* best-effort */ }
			}
		});
	}

	await insertAuditLog(c.env, actor.sub, 'sync.push', 'sync', null, {
		mutations: payload.mutations.length
	});

	return c.json({ results });
});


// ─── Semantic search ─────────────────────────────────────────────────────
// Free-text → embedding → Vectorize ANN lookup → hydrate book rows.
// Falls back to a 503 when either binding is missing so the frontend can
// gracefully fall back to FTS without speculating about whether the feature
// is wired up.


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
		        room_code, shelf_code, acquisition_date, tags, custom_fields,
		        title_fold, author_fold, isbn_fold, publisher_fold,
		        description_fold, tags_fold, custom_fields_fold
		 FROM books WHERE deleted_at IS NULL ORDER BY id LIMIT ? OFFSET ?`
	).bind(limit, offset).all<Record<string, unknown>>();

	let updated = 0;
	let foldsBackfilled = 0;
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

		const textChanged =
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

		// Migration 0012 added the *_fold columns but deliberately skipped the
		// backfill, relying on the books_fts triggers' COALESCE(fold, raw). That
		// keeps FTS correct, but every query that reads a fold column DIRECTLY is
		// blind to an un-backfilled row — including the duplicate warning shown
		// after each book is added, which probes `title_fold IS ?`. `NULL IS
		// 'κλημης'` is false, so the warning currently cannot see a single
		// imported book. A row can be textually clean and still need this, so it
		// has to be its own trigger rather than part of `textChanged`.
		const needsFoldBackfill =
			(row.title_fold == null && (n.title ?? '') !== '') ||
			(row.author_fold == null && (n.author ?? '') !== '') ||
			(row.isbn_fold == null && (n.isbn ?? '') !== '') ||
			(row.publisher_fold == null && (n.publisher ?? '') !== '') ||
			(row.description_fold == null && (n.description ?? '') !== '') ||
			(row.tags_fold == null && (n.tags ?? []).length > 0) ||
			(row.custom_fields_fold == null && Object.keys(n.customFields ?? {}).length > 0);

		if (!textChanged && !needsFoldBackfill) continue;
		if (needsFoldBackfill) foldsBackfilled++;

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

	// Heal the location codes on the COPIES too.
	//
	// The loop above only rewrites `books`, but location filters and the shelf
	// facet read `items` — so without this a healed record said "19-000 ΠΙΣΩ"
	// while the shelf browser still listed "19-000 ΠΊΣΩ", and the two disagreed
	// permanently. Introduced by the holdings layer; the healing pass had to
	// learn about it.
	//
	// Done by DISTINCT VALUE, not per row: there are ~249 shelf codes against
	// 12.5K copies, only a handful of them Greek, so this is a few reads and at
	// most a few writes instead of a second full sweep. Runs on the first page
	// only — it is set-based and repeating it 26 times would be pure waste.
	let itemCodesHealed = 0;
	if (offset === 0) {
		const codes = await c.env.DB.prepare(
			`SELECT DISTINCT shelf_code AS code, 'shelf_code' AS col FROM items
			  WHERE shelf_code IS NOT NULL AND TRIM(shelf_code) <> ''
			 UNION
			 SELECT DISTINCT room_code, 'room_code' FROM items
			  WHERE room_code IS NOT NULL AND TRIM(room_code) <> ''`
		).all<{ code: string; col: string }>();

		const codeFixes: D1PreparedStatement[] = [];
		for (const row of codes.results ?? []) {
			const normalized = normalizeCode(row.code);
			if (normalized === row.code) continue;
			// Column name comes from this query's own literals, never user input.
			const column = row.col === 'room_code' ? 'room_code' : 'shelf_code';
			codeFixes.push(
				c.env.DB.prepare(
					`UPDATE items SET ${column} = ?, updated_at = ? WHERE ${column} = ?`
				).bind(normalized, now, row.code)
			);
			itemCodesHealed += 1;
		}
		for (let i = 0; i < codeFixes.length; i += BATCH_SIZE) {
			await c.env.DB.batch(codeFixes.slice(i, i + BATCH_SIZE));
		}
	}

	if (updated > 0 || itemCodesHealed > 0) {
		await bumpBooksCacheVersion(c.env);
	}

	const countResult = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').first<{ n: number }>();
	const totalBooks = countResult?.n ?? 0;

	await insertAuditLog(c.env, c.get('user').sub, 'admin.normalizeBooks', 'book', null, {
		processed, updated, foldsBackfilled, itemCodesHealed, offset, limit
	});

	return c.json({
		processed, updated, foldsBackfilled, itemCodesHealed,
		unchanged: processed - updated, offset, nextOffset: offset + processed, totalBooks
	});
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

app.get('/api/facets', async (c) => {
	const field = c.req.query('field') ?? 'custom:category_code';
	// No table alias here: this query has a single unaliased FROM.
	const resolved = resolveEmptyFieldExpr(field, '');
	if (!resolved) {
		// A typo must fail loudly rather than return a plausible empty facet.
		throw new HTTPException(400, { message: `Unknown facet field: ${field}` });
	}
	const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? 600)));

	const cacheVersion = await getBooksCacheVersion(c.env);
	const cacheKey = `facet:${field}:${limit}:${cacheVersion}`;
	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) return c.json(cached);
		} catch (error) {
			console.warn('Facet cache read failed', error);
		}
	}

	// `is_empty` is its own bucket rather than a magic value, so a real value of
	// "" can never be confused with "no value recorded".
	//
	// Sorted is_empty DESC so the gap bucket is row one. That is not cosmetic:
	// with 629 distinct category labels against a 600 limit, sorting it last
	// truncated it away entirely — the rail silently lost the single row the
	// librarian most needs, and the counts stopped summing to the catalogue.
	const itemColumn = ITEM_BACKED_FACETS[field];
	let rows: { results?: Array<{ is_empty: number; value: string | null; count: number }> };

	if (itemColumn) {
		// Location facets count BOOKS PER PLACE, over the copies.
		//
		// Two queries rather than one GROUP BY, because the buckets ask different
		// questions and a single grouping cannot express both: a populated bucket
		// is "records with a copy HERE", while the empty bucket is "records with
		// no copy anywhere" — a book with one shelved and one unplaced copy
		// belongs in the first, not the second. Both match the list filter exactly.
		//
		// Note the counts can sum to MORE than the catalogue: a record held on two
		// shelves genuinely appears at both. That is the answer the librarian is
		// after when reconciling a shelf, so the response reports it rather than
		// pretending the numbers partition.
		const valued = await c.env.DB.prepare(
			`SELECT 0 AS is_empty, TRIM(i.${itemColumn}) AS value, COUNT(DISTINCT i.book_id) AS count
			   FROM items i JOIN books b ON b.id = i.book_id
			  WHERE i.deleted_at IS NULL AND b.deleted_at IS NULL
			    AND TRIM(COALESCE(i.${itemColumn}, '')) <> ''
			  GROUP BY value
			  ORDER BY count DESC, value ASC
			  LIMIT ?`
		).bind(limit).all<{ is_empty: number; value: string | null; count: number }>();
		const none = await c.env.DB.prepare(
			`SELECT COUNT(*) AS n FROM books b
			  WHERE b.deleted_at IS NULL
			    AND NOT EXISTS (SELECT 1 FROM items i WHERE i.book_id = b.id AND i.deleted_at IS NULL
			                     AND TRIM(COALESCE(i.${itemColumn}, '')) <> '')`
		).first<{ n: number }>();
		const emptyCount = Number(none?.n ?? 0);
		rows = {
			results: [
				...(emptyCount > 0 ? [{ is_empty: 1, value: '', count: emptyCount }] : []),
				...(valued.results ?? [])
			]
		};
	} else {
		const emptyExpr = `CASE WHEN TRIM(COALESCE(CAST(${resolved.expr} AS TEXT), '')) = '' THEN 1 ELSE 0 END`;
		const valueExpr = `CASE WHEN TRIM(COALESCE(CAST(${resolved.expr} AS TEXT), '')) = '' THEN '' ELSE CAST(${resolved.expr} AS TEXT) END`;
		rows = await c.env.DB.prepare(
			`SELECT ${emptyExpr} AS is_empty, ${valueExpr} AS value, COUNT(*) AS count
			   FROM books
			  WHERE deleted_at IS NULL
			  GROUP BY is_empty, value
			  ORDER BY is_empty DESC, count DESC, value ASC
			  LIMIT ?`
		).bind(...resolved.bind, ...resolved.bind, ...resolved.bind, limit).all<{
			is_empty: number; value: string | null; count: number;
		}>();
	}

	// The library total comes from the key the list handler already memoizes, so
	// the rail's "All" row can never disagree with the unfiltered list.
	let totalBooks: number | null = null;
	const totalKey = `books:total:${cacheVersion}`;
	if (c.env.CACHE) {
		try {
			const t = await c.env.CACHE.get(totalKey);
			if (t !== null && t !== undefined) totalBooks = Number(t);
		} catch { /* fall through to counting */ }
	}
	if (totalBooks === null) {
		const t = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').first<{ n: number }>();
		totalBooks = Number(t?.n ?? 0);
		if (c.env.CACHE) {
			try { await c.env.CACHE.put(totalKey, String(totalBooks), { expirationTtl: 3600 }); } catch { /* best effort */ }
		}
	}

	const items = (rows.results ?? []).map((r) => ({
		value: r.value ?? '',
		isEmpty: Number(r.is_empty) === 1,
		count: Number(r.count ?? 0)
	}));
	// A high-cardinality field (3,827 publishers) will hit the limit. Say so
	// rather than let the rail imply its counts add up to the whole catalogue —
	// the librarian is using these numbers to check a shelf against reality.
	const response = {
		field,
		totalBooks,
		truncated: items.length >= limit,
		shownCount: items.reduce((sum, i) => sum + i.count, 0),
		// A location facet counts records per place, and a record held in two
		// places is genuinely in both buckets — so these counts overlap and do
		// NOT partition the catalogue. Flagged so the UI never claims they add up.
		overlapping: Boolean(itemColumn),
		items
	};
	if (c.env.CACHE) {
		try {
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 86400 });
		} catch (error) {
			console.warn('Facet cache write failed', error);
		}
	}
	return c.json(response);
});

// Category browser: aggregates books by their `category_code` custom field.
// Kept as its own route because CACHE_BUST_FAMILIES and the desktop shell name
// it, and because it still owns the code+label shape the rail's chips expect.
//
// The label column is deliberately gone. It used to be
// MAX(json_extract(custom_fields, '$.category_label')), which is always NULL in
// this catalogue: `category_code` and `category_label` have ZERO overlap
// (8,117 books carry only a code, 4,099 only a label — they arrived from
// different import sheets). So the join could never produce a name, and the
// 4,099 label-only books were invisible in the rail entirely. They are two
// independent facets, and /api/facets now exposes both.
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
			COUNT(*) AS count
		 FROM books
		 WHERE deleted_at IS NULL
			 AND json_extract(custom_fields, '$.category_code') IS NOT NULL
			 AND json_extract(custom_fields, '$.category_code') != ''
		 GROUP BY code
		 ORDER BY count DESC, code ASC
		 LIMIT 500`
	).all<{ code: string | null; count: number }>();

	const items = (rows.results ?? []).map((r) => ({
		code: r.code ?? '',
		label: null,
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

// `pinnedOrder` mirrors what migrations 0019 and 0020 did to the live
// catalogue, so a fresh install opens with the same everyday group the
// librarian already works in. It is applied ONLY when the definition is
// created — see the seed loop below for why.
const CATALOG_CUSTOM_FIELDS: Array<{
	key: string;
	label: string;
	type: 'text' | 'number' | 'boolean' | 'date';
	pinnedOrder?: number;
}> = [
	{ key: 'series', label: 'Series', type: 'text' },
	{ key: 'volume_label', label: 'Volume Label', type: 'text' },
	{ key: 'volume_num', label: 'Volume Number', type: 'text', pinnedOrder: 8 },
	{ key: 'editor', label: 'Editor', type: 'text', pinnedOrder: 4 },
	{ key: 'translator', label: 'Translator', type: 'text' },
	{ key: 'place_of_publication', label: 'Place of Publication', type: 'text', pinnedOrder: 7 },
	{ key: 'edition', label: 'Edition', type: 'text', pinnedOrder: 3 },
	{ key: 'category_code', label: 'Category Code', type: 'text' },
	{ key: 'category_label', label: 'Category Label', type: 'text', pinnedOrder: 9 },
	{ key: 'cover_type', label: 'Cover Type', type: 'text', pinnedOrder: 2 },
	// Extent, not a page count: ISBD area 5 / MARC 300$a is free text, so a
	// volume continuing the previous one's pagination reads "σ. 351-700".
	{ key: 'pages', label: 'Pages', type: 'text', pinnedOrder: 6 },
	{ key: 'condition', label: 'Condition', type: 'text', pinnedOrder: 1 },
	{ key: 'isbn_10', label: 'ISBN-10', type: 'text' },
	{ key: 'issn', label: 'ISSN', type: 'text' },
	{ key: 'additional_isbns', label: 'Additional ISBNs', type: 'text' },
	{ key: 'has_illustrations', label: 'Has Illustrations', type: 'boolean' },
	{ key: 'illustration_type', label: 'Illustration Type', type: 'text', pinnedOrder: 5 },
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
			// Deliberately does NOT touch pinned/sort_order. Placement is the
			// librarian's, rearranged from Settings; re-running setup on a live
			// install must not silently shuffle their everyday group back to the
			// seed order.
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
					(id, field_key, label, field_type, required, enum_options, created_at, updated_at, deleted_at, pinned, sort_order)
				 VALUES (?, ?, ?, ?, 0, '[]', ?, ?, NULL, ?, ?)`
			)
				.bind(
					crypto.randomUUID(), field.key, field.label, field.type, now, now,
					field.pinnedOrder ? 1 : 0, field.pinnedOrder ?? 0
				)
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
		// The row's position in the uploaded sheet, so a failure late in the
		// write loop can name the offending row instead of reporting index -1.
		sourceIndex: number;
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

	// The columns we need from a book that already exists under this legacy id:
	// its trash state, its custom fields, and every core column — because a
	// re-import must MERGE with what is on file rather than overwrite it.
	type ExistingImportRow = {
		id: string;
		deleted_at: string | null;
		custom_fields: string | null;
		title: string | null;
		author: string | null;
		isbn: string | null;
		publication_year: number | null;
		publisher: string | null;
		language: string | null;
		description: string | null;
		shelf_code: string | null;
	};

	// A source sheet is rarely the whole truth: catalogue exports routinely omit
	// columns, and a partial sheet used to blank publisher/ISBN/description/shelf
	// on every book it touched — deleting work a librarian had typed in by hand.
	// A blank cell now means "nothing to say about this field", not "erase it".
	// (To actually clear a field, edit the book — import is additive.)
	const keepIfBlank = <T,>(incoming: T | null, existing: T | null): T | null => {
		if (incoming === null || incoming === undefined) return existing;
		if (typeof incoming === 'string' && incoming.trim() === '') return existing;
		return incoming;
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
				sourceIndex: index,
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
			let existingRow: ExistingImportRow | null = null;

			if (p.legacyId) {
				existingRow = await c.env.DB.prepare(
					`SELECT id, deleted_at, custom_fields, title, author, isbn, publication_year,
					        publisher, language, description, shelf_code
					 FROM books WHERE legacy_id = ? LIMIT 1`
				)
					.bind(p.legacyId)
					.first<ExistingImportRow | null>();
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
				// Merge in JS rather than with SQL COALESCE so the *_fold search
				// columns are derived from the values we are actually storing. Folds
				// computed from the raw source row would leave a book findable only
				// under text it no longer has.
				const mergedTitle = keepIfBlank(p.title, existingRow.title) ?? '';
				const mergedAuthor = keepIfBlank(p.author, existingRow.author) ?? '';
				const mergedIsbn = keepIfBlank(p.isbn, existingRow.isbn);
				const mergedYear = keepIfBlank(p.publicationYear, existingRow.publication_year);
				const mergedPublisher = keepIfBlank(p.publisher, existingRow.publisher);
				const mergedLanguage = keepIfBlank(p.language, existingRow.language);
				const mergedDescription = keepIfBlank(p.description, existingRow.description);
				const mergedShelf = keepIfBlank(p.shelfCode, existingRow.shelf_code);
				const folds = computeBookFolds({
					title: mergedTitle, author: mergedAuthor, isbn: mergedIsbn, publisher: mergedPublisher,
					description: mergedDescription, tagsJson: tags, customFieldsJson: mergedCustomJson
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
						mergedTitle,
						mergedAuthor,
						mergedIsbn,
						mergedYear,
						mergedPublisher,
						mergedLanguage,
						mergedDescription,
						mergedShelf,
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
			skippedRows.push({ index: p.sourceIndex, reason });
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
		`SELECT b.id, b.name, b.contact, b.notes, b.category, b.created_at, b.updated_at,
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
		id: string; name: string; contact: string | null; notes: string | null; category: string | null;
		created_at: string; updated_at: string;
		total_loans: number; open_loans: number; overdue_loans: number;
	}>();

	return c.json({
		items: (rows.results ?? []).map((r) => ({
			id: r.id,
			name: r.name,
			contact: r.contact,
			notes: r.notes,
			category: r.category ?? 'standard',
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
		`INSERT INTO borrowers (id, name, contact, notes, category, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).bind(id, payload.name, payload.contact ?? null, payload.notes ?? null,
		payload.category ?? 'standard', now, now).run();
	await insertAuditLog(c.env, c.get('user').sub, 'borrower.create', 'borrower', id, { name: payload.name });
	return c.json({ id }, 201);
});

app.put('/api/borrowers/:id', requirePermission('circulation', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const payload = UpsertBorrowerSchema.parse(await c.req.json());
	// COALESCE, not a plain assignment: this is a full replace and an older
	// client that has never heard of a category must not blank one. Same
	// preserve-when-absent rule the book schemas document for title and tags.
	const result = await c.env.DB.prepare(
		`UPDATE borrowers SET name = ?, contact = ?, notes = ?, category = COALESCE(?, category), updated_at = ?
		  WHERE id = ?`
	).bind(payload.name, payload.contact ?? null, payload.notes ?? null,
		payload.category ?? null, nowIso(), id).run();
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
	// Every loan row keeps a denormalized SNAPSHOT of the borrower's name and
	// contact (so history survives a borrower being deleted). Erasing only the
	// `borrowers` row therefore erased nothing that mattered — the name and
	// phone number stayed readable in loan history, exports, and the overdue
	// list. Anonymize the snapshots and the free-text notes on both sides.
	await c.env.DB.prepare(
		`UPDATE borrow_transactions
		 SET borrower_name = ?, borrower_contact = NULL, notes = NULL, return_notes = NULL, updated_at = ?
		 WHERE borrower_id = ?`
	).bind(sentinel, nowIso(), id).run();
	await insertAuditLog(c.env, c.get('user').sub, 'borrower.erase', 'borrower', id, {});
	return c.json({ id, anonymizedName: sentinel });
});

app.get('/api/borrowers/export.csv', requirePermission('circulation', { librarian: true }), async (c) => {
	const rows = await c.env.DB.prepare(
		`SELECT b.id, b.name, b.contact, b.notes, b.category, b.created_at, b.updated_at,
		        COUNT(bt.id) AS total_loans,
		        SUM(CASE WHEN bt.returned_at IS NULL THEN 1 ELSE 0 END) AS open_loans,
		        SUM(CASE WHEN bt.returned_at IS NULL AND bt.due_at < ? THEN 1 ELSE 0 END) AS overdue_loans
		   FROM borrowers b
		   LEFT JOIN borrow_transactions bt ON bt.borrower_id = b.id
		  GROUP BY b.id
		  ORDER BY total_loans DESC, LOWER(b.name) ASC`
	).bind(nowIso()).all<{
		id: string; name: string; contact: string | null; notes: string | null; category: string | null;
		created_at: string; updated_at: string;
		total_loans: number; open_loans: number; overdue_loans: number;
	}>();

	const csv = toCsv(
		(rows.results ?? []).map((r) => ({
			ID: r.id,
			Name: r.name,
			Contact: r.contact ?? '',
			Notes: r.notes ?? '',
			Category: r.category ?? 'standard',
			'Total loans': Number(r.total_loans ?? 0),
			'Open loans': Number(r.open_loans ?? 0),
			'Overdue loans': Number(r.overdue_loans ?? 0),
			'Created at': r.created_at,
			'Updated at': r.updated_at
		})),
		['ID', 'Name', 'Contact', 'Notes', 'Category', 'Total loans', 'Open loans', 'Overdue loans', 'Created at', 'Updated at']
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

	// R2 orphan-cover sweep: reclaim covers/<id>.<ext> objects whose book row no
	// longer exists at all (a purge whose best-effort cover delete failed on a
	// transient R2 error). Soft-deleted books are KEPT in `books`, so their
	// restorable covers are never swept. Best-effort in its own try/catch — a
	// sweep failure must never turn this admin endpoint into a 500.
	let orphanCovers = 0;
	try {
		const surviving = new Set<string>();
		const bookRows = await c.env.DB.prepare('SELECT id FROM books').all<{ id: string }>();
		for (const r of bookRows.results ?? []) surviving.add(r.id);
		let cursor: string | undefined;
		do {
			const listed = await c.env.ASSETS.list({ prefix: 'covers/', cursor });
			for (const obj of listed.objects) {
				const m = obj.key.match(/^covers\/(.+)\.(?:jpg|png|webp|gif)$/);
				const bookId = m?.[1];
				if (bookId && !surviving.has(bookId)) {
					try { await c.env.ASSETS.delete(obj.key); orphanCovers += 1; } catch { /* ignore one */ }
				}
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	} catch {
		/* best-effort — leave orphanCovers at whatever we managed to reclaim */
	}

	const fullSummary = { ...summary, purgedMutationLog, orphanCovers };
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
	/** ISBD area 5 as transcribed by the source — MARC 300$a, free text. */
	extent?: string | null;
	ddc?: string | null;
	titleRomanized?: string | null;
	authorRomanized?: string | null;
	publisherRomanized?: string | null;
	coverUrl?: string | null;
	source: 'openlibrary' | 'googlebooks' | 'nlg' | 'both' | 'none';
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

// ─── Which reading of a field to trust ────────────────────────────────────
//
// The old merge hard-wired Open Library as primary, so its ALA-LC romanization
// beat Google Books' native-script title whenever it existed — which is what
// filled the librarian's form with "Epiphanios Salaminos Kyprou". Choosing per
// field, by script, is the fix.

// ISBN registration groups that say "published in Greece". 960 and 618 are the
// Greek group identifiers; 978/979 are the EAN prefixes in front of them.
const GREEK_ISBN_GROUPS = [/^97[89]960/, /^97[89]618/, /^960/, /^618/];
const NON_LATIN_SCRIPT_RE = /[Ͱ-Ͽἀ-῿Ѐ-ӿ가-힯぀-ヿ一-鿿]/;
const LATIN_LETTER_RE = /[A-Za-z]/;

function isGreekIsbn(isbn: string): boolean {
	return GREEK_ISBN_GROUPS.some((re) => re.test(isbn));
}

/**
 * Score one candidate value for a field.
 *
 * +2 the value is in the script the work is expected to be in
 * -2 the work is expected to be non-Latin and this is pure Latin — i.e. a
 *    romanization, which belongs in the parallel field, not this one
 * +1 tie-break toward the source that is native for this work
 */
function scoreCandidate(value: string, expectNonLatin: boolean, nativeSource: boolean): number {
	let score = 0;
	const hasNonLatin = NON_LATIN_SCRIPT_RE.test(value);
	if (expectNonLatin) {
		if (hasNonLatin) score += 2;
		else if (LATIN_LETTER_RE.test(value)) score -= 2;
	} else if (!hasNonLatin) score += 2;
	if (nativeSource) score += 1;
	return score;
}

type Candidate = { source: string; fields: Partial<EnrichedBookFields>; nativeFor: 'greek' | null };

/**
 * Merge by choosing the best-scoring reading of each field, and keep the
 * romanized alternative rather than discarding it.
 */
function mergeByScript(
	candidates: Candidate[],
	isbn: string
): { merged: Partial<EnrichedBookFields>; alternates: Record<string, Array<{ value: string; source: string }>> } {
	const expectNonLatin = isGreekIsbn(isbn);
	const merged: Partial<EnrichedBookFields> = {};
	const alternates: Record<string, Array<{ value: string; source: string }>> = {};

	const textKeys = ['title', 'subTitle', 'author', 'publisher'] as const;
	for (const key of textKeys) {
		const options = candidates
			.map((cand) => ({ source: cand.source, value: cand.fields[key], native: cand.nativeFor === 'greek' && expectNonLatin }))
			.filter((o): o is { source: string; value: string; native: boolean } =>
				typeof o.value === 'string' && o.value.trim() !== '');
		if (options.length === 0) continue;
		const ranked = options
			.map((o) => ({ ...o, score: scoreCandidate(o.value, expectNonLatin, o.native) }))
			.sort((a, b) => b.score - a.score);
		const best = ranked[0] as { source: string; value: string; score: number };
		const romanizedTarget = key === 'title' ? 'titleRomanized'
			: key === 'author' ? 'authorRomanized'
				: key === 'publisher' ? 'publisherRomanized' : null;

		// The case that produced the original complaint: for a Greek-group ISBN
		// the ONLY reading available is a Latin one, i.e. a romanization. Putting
		// it in the vernacular field is exactly what filled the form with
		// "Epiphanios Salaminos Kyprou". It belongs in the parallel field, and the
		// vernacular is left empty for the librarian to type from the book — which
		// is the only place the Greek actually exists.
		if (best.score < 0 && romanizedTarget) {
			(merged as Record<string, unknown>)[romanizedTarget] = best.value;
			const rest = ranked.slice(1).filter((o) => o.value !== best.value);
			if (rest.length) alternates[key] = rest.map((o) => ({ value: o.value, source: o.source }));
			continue;
		}

		(merged as Record<string, unknown>)[key] = best.value;
		// Everything not chosen is offered to the librarian rather than dropped —
		// a romanization is useful in the parallel field, and a second opinion on
		// a title is worth seeing.
		const rest = ranked.slice(1).filter((o) => o.value !== best.value);
		if (rest.length) alternates[key] = rest.map((o) => ({ value: o.value, source: o.source }));
		// When the winner is native script and a Latin reading also exists, that
		// Latin reading IS the romanization — hand it over pre-labelled.
		if (expectNonLatin && romanizedTarget && NON_LATIN_SCRIPT_RE.test(best.value)) {
			const roman = ranked.find((o) => !NON_LATIN_SCRIPT_RE.test(o.value) && LATIN_LETTER_RE.test(o.value));
			if (roman) (merged as Record<string, unknown>)[romanizedTarget] = roman.value;
		}
	}

	// Non-textual fields have no script question; first non-empty wins.
	for (const key of ['publicationYear', 'language', 'description', 'pages', 'coverUrl', 'extent', 'ddc'] as const) {
		for (const cand of candidates) {
			const v = (cand.fields as Record<string, unknown>)[key];
			if (v !== undefined && v !== null && v !== '') { (merged as Record<string, unknown>)[key] = v; break; }
		}
	}
	return { merged, alternates };
}

/**
 * The National Library of Greece, via its Koha OPAC.
 *
 * Added because Open Library serves ALA-LC romanization for Greek books while
 * NLG serves the vernacular. Measured on 25 random Greek-titled ISBNs from this
 * catalogue: NLG resolved 15 (60%), Open Library ~28% and always romanized.
 *
 * Two subrequests — search by ISBN for the biblionumber, then export the record
 * as MARCXML — so it is gated to Greek ISBN groups. A non-Greek lookup stays at
 * the previous two subrequests total.
 */
async function fetchNlg(isbn: string, signal: AbortSignal): Promise<Partial<EnrichedBookFields> | null> {
	const base = 'https://catalogue.nlg.gr/cgi-bin/koha';
	const searchUrl = `${base}/opac-search.pl?idx=nb&q=${encodeURIComponent(isbn)}&format=rss2`;
	const res = await fetch(searchUrl, {
		signal,
		headers: { 'User-Agent': NLG_USER_AGENT },
		cf: { cacheEverything: true, cacheTtl: 86400 }
	} as RequestInit);
	if (!res.ok) throw new Error(`NLG search HTTP ${res.status}`);
	const rss = await res.text();
	// The OPAC sits behind a proof-of-work bot challenge (Anubis) that answers
	// 200 with an HTML interstitial. Verified: it fires for requests from
	// Cloudflare's egress but not from an ordinary desktop, so this is about
	// where the request comes from, not what it claims to be. Reported as an
	// error rather than silently looking like "no such book" — and NOT worked
	// around: the library has decided automated access goes through a gate, and
	// the right response is to ask them for machine access, not to defeat it.
	// Their OAI-PMH endpoint (oai.pl) IS reachable, which suggests they would.
	if (rss.includes('not to be a robot') || rss.includes('within.website')) {
		throw new Error('NLG OPAC is behind a bot challenge for automated clients — machine access must be arranged with the library');
	}
	const bib = rss.match(/biblionumber=(\d+)/)?.[1];
	if (!bib) return null;

	const xmlRes = await fetch(`${base}/opac-export.pl?op=export&bib=${bib}&format=marcxml`, {
		signal,
		headers: { 'User-Agent': NLG_USER_AGENT },
		cf: { cacheEverything: true, cacheTtl: 86400 }
	} as RequestInit);
	if (!xmlRes.ok) throw new Error(`NLG export HTTP ${xmlRes.status}`);
	const records = await parseMarcXml(await xmlRes.text());
	if (records.length === 0) return null;
	const f = marcToBookFields(records[0] as ParsedMarcRecord);
	return {
		title: f.title ?? null,
		subTitle: f.subtitle ?? null,
		author: f.author ?? null,
		publisher: f.publisher ?? null,
		publicationYear: f.publicationYear ?? null,
		language: f.language ?? null,
		// 300$a — free text, which is exactly the shape the extent field wants.
		extent: f.extent ?? null,
		ddc: f.ddc ?? null
	} as Partial<EnrichedBookFields>;
}

// Both Open Library and a small self-hosted Koha ask to be told who is calling.
const NLG_USER_AGENT = 'OK-Library/1.0 (library catalogue; +https://github.com/CyberSystema/ok-library)';

/**
 * Run a provider with a deadline and turn a failure into a REPORTED status.
 *
 * The old code swallowed every error into `null`, which is how Google Books
 * quietly returning HTTP 429 "quota exceeded" went unnoticed — leaving Open
 * Library as the only source and every lookup romanized. Workers' fetch has no
 * default timeout either, so one slow provider hung the whole request.
 */
async function runProvider<T>(
	name: string,
	fn: (signal: AbortSignal) => Promise<T | null>
): Promise<{ name: string; ok: boolean; value: T | null; error?: string; ms: number }> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	try {
		const value = await fn(controller.signal);
		return { name, ok: true, value, ms: Date.now() - started };
	} catch (error) {
		return {
			name, ok: false, value: null,
			error: error instanceof Error ? error.message : String(error),
			ms: Date.now() - started
		};
	} finally {
		clearTimeout(timer);
	}
}

app.get('/api/lookup/isbn/:isbn', async (c) => {
	const sourceParam = (c.req.query('source') ?? 'both').toLowerCase();
	if (!['openlibrary', 'googlebooks', 'nlg', 'both'].includes(sourceParam)) {
		throw new HTTPException(400, { message: 'source must be openlibrary, googlebooks, nlg, or both' });
	}
	const isbn = sanitizeIsbn(c.req.param('isbn') ?? '');
	if (!isValidIsbn(isbn)) {
		throw new HTTPException(400, { message: 'Invalid ISBN (need 10 or 13 digits).' });
	}

	// v2: the v1 entries hold the old romanization-wins merge, and they live for
	// a week — without a new prefix the fix would be invisible until they aged out.
	const cacheKey = `enrich:isbn:v2:${sourceParam}:${isbn}`;
	if (c.env.CACHE) {
		try {
			const cached = await c.env.CACHE.get(cacheKey, 'json');
			if (cached) return c.json(cached);
		} catch (error) {
			console.warn('ISBN enrichment cache read failed', error);
		}
	}

	// NLG is deliberately NOT in the default set. Its OPAC is bot-challenged for
	// automated clients (see fetchNlg), so including it would spend two
	// subrequests per Greek lookup to always fail. Left addressable via
	// ?source=nlg so it starts working the moment access is arranged.
	const wanted = sourceParam === 'both' ? ['googlebooks', 'openlibrary'] : [sourceParam];

	const results = await Promise.all(wanted.map((name) => {
		if (name === 'nlg') return runProvider('nlg', (signal) => fetchNlg(isbn, signal));
		if (name === 'googlebooks') return runProvider('googlebooks', () => fetchGoogleBooks(isbn));
		return runProvider('openlibrary', () => fetchOpenLibrary(isbn));
	}));

	const candidates: Candidate[] = results
		.filter((r) => r.ok && r.value)
		.map((r) => ({
			source: r.name,
			fields: r.value as Partial<EnrichedBookFields>,
			nativeFor: r.name === 'nlg' ? 'greek' as const : null
		}));

	const { merged, alternates } = mergeByScript(candidates, isbn);
	const hits = candidates.map((cand) => cand.source);
	const source: EnrichedBookFields['source'] =
		hits.length === 0 ? 'none' : hits.length > 1 ? 'both' : (hits[0] as EnrichedBookFields['source']);

	const response = {
		isbn,
		source,
		...merged,
		// Everything not chosen, so the librarian can take a different reading
		// per field instead of accepting or discarding the whole lookup.
		alternates,
		// Reported rather than swallowed: a quota-exceeded provider is something
		// the operator needs to see, not a silently emptier result.
		providers: results.map((r) => ({ name: r.name, ok: r.ok, found: Boolean(r.value), error: r.error, ms: r.ms }))
	};

	if (c.env.CACHE && source !== 'none') {
		try {
			// 7 days. Positive hits are effectively static; negative hits are NOT
			// cached so a typo'd ISBN self-corrects as soon as it is fixed.
			await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 7 * 24 * 60 * 60 });
		} catch (error) {
			console.warn('ISBN enrichment cache write failed', error);
		}
	}

	return c.json(response);
});

export default app;
