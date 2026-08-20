import {
	AddCopiesSchema,
	checkIsbn,
	parseEdtf,
	BookFilterQuerySchema,
	BorrowBookSchema,
	CreateBookSchema,
	GenerateCodeSchema,
	ReplaceItemsSchema,
	ReplaceSerialHoldingsSchema,
	SeedSubjectsSchema,
	formatHoldingStatement,
	computeSetGaps,
	LinkAuthoritiesSchema,
	MergeBooksSchema,
	PlaceHoldSchema,
	RenewLoanSchema,
	ReplaceLoanPoliciesSchema,
	UpsertAuthoritySchema,
	ImportBooksSchema,
	ITEM_TYPES,
	code128Svg,
	formatItemBarcode,
	toIso639_2,
	ImportCatalogSchema,
	ReturnBookSchema,
	SyncPushSchema,
	UpdateBookSchema,
	UpsertBorrowerSchema,
	UpsertCustomFieldSchema,
	UpsertRoomSchema,
	fromIso639_2
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
	browseCacheKey,
	versionTooFreshToCache,
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
	loadSerialHoldings,
	loadSerialHoldingsForBooks,
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
	xmlEscape,
	normalizeOaiBound,
	oaiGranularity
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

/**
 * Per-isolate request counts, for the buckets that must not spend KV writes.
 *
 * Cleared when the isolate is recycled and not shared between colos, so this is a
 * floor on protection rather than a guarantee — but what it exists to stop is a
 * harvester or a script in a tight loop, and a tight loop keeps arriving at the same
 * isolate. Bounded, so a flood of distinct keys cannot grow it without limit.
 */
const memoryRateLimits = new Map<string, number>();

function enforceInMemoryLimit(key: string, perMinuteLimit: number): void {
	if (memoryRateLimits.size > 5000) memoryRateLimits.clear();
	const count = (memoryRateLimits.get(key) ?? 0) + 1;
	memoryRateLimits.set(key, count);
	if (count > perMinuteLimit) {
		throw new HTTPException(429, { message: 'Rate limit exceeded. Please retry shortly.' });
	}
}

/**
 * `kvBacked: false` for anything an anonymous caller can reach.
 *
 * This spent one KV WRITE on every permitted request. The free tier allows 1,000 KV
 * writes a day and the two public protocol endpoints are configured at 60 requests a
 * minute — 86,400 permitted requests a day, one write each. The limiter therefore ran
 * out of its own storage after about 1.6% of the traffic it was configured to allow,
 * and the comment above the middleware reasoned about that bucket purely as request
 * isolation, never noticing that the one bucket reachable by anyone on the internet
 * is the one paying out of the librarian's budget.
 *
 * The damage does not stop at the limiter. Those same 1,000 writes back the
 * read-through caches — which the middleware's own comment says are what make normal
 * browsing "effectively free" — so an anonymous flood degrades the LIBRARIAN's app.
 * That is a better denial of service than the one the limiter was written to prevent.
 *
 * Authenticated buckets keep the KV counter: they need a session, so the volume is a
 * working day's clicks, and there the write is both affordable and exact.
 */
async function enforceRateLimit(
	c: AppContext, bucket: string, perMinuteLimit: number,
	opts: { kvBacked?: boolean } = {}
): Promise<void> {
	const key = `rl:${bucket}:${clientIp(c)}:${Math.floor(Date.now() / 60000)}`;

	if (opts.kvBacked === false) {
		enforceInMemoryLimit(key, perMinuteLimit);
		return;
	}

	if (!c.env.CACHE) {
		return;
	}

	try {
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
  // The comment above lists "full-table CSV export" among the expensive GETs, and
  // the predicate did not match one. The routes are `/api/export/books.csv` and
  // `/api/export/books.marcxml`; `endsWith('/export.csv')` matches neither (it was
  // written for `/api/borrowers/export.csv`), so the two heaviest reads in the
  // system — a 12,800-row CSV and a 21 MB MARCXML stream — sat in no bucket at all
  // while the comment said otherwise.
  //
  // Matched by PREFIX now, so a new export route cannot silently opt out by being
  // named something the suffix test does not expect.
  const isExpensiveGet = method === 'GET' && (
    path === '/api/books/semantic'
    || path.startsWith('/api/lookup/isbn/')
    || path.startsWith('/api/export/')
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
    // No KV write: see enforceRateLimit. An anonymous caller must not be able to
    // spend the librarian's daily write budget, least of all on the counter that
    // exists to restrain them.
    await enforceRateLimit(c, 'harvest', 60, { kvBacked: false });
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
		/*
		 * A route may attach a machine-readable `code` through `cause`, and it is carried into
		 * the body here.
		 *
		 * Some routes answer the same status for several unrelated reasons — the two replace
		 * endpoints return 409 for a stale version, a duplicate barcode, a copy on loan, a copy
		 * on the hold shelf and the last remaining copy — and a client that must act
		 * differently for one of them has otherwise only the English sentence to go on, in an
		 * app whose interface runs in four languages. The message stays exactly as it was, so
		 * nothing that reads it is affected.
		 */
		const cause = error.cause as { code?: string; details?: Record<string, unknown> } | undefined;
		const code = cause && typeof cause.code === 'string' ? cause.code : undefined;
		// Some refusals name a record or a value the client must repeat back in the librarian's
		// own language; the code alone would force it to drop exactly the useful half.
		const details = cause && cause.details && typeof cause.details === 'object' ? cause.details : undefined;
		if (!code) return c.json({ error: error.message }, error.status);
		return c.json(details ? { error: error.message, code, details } : { error: error.message, code }, error.status);
	}

	// Input validation failures are CLIENT errors (400), not server errors.
	// Without this they fall through to the generic 500 below, which (a) reports
	// a bogus "Internal server error" for what is really a bad field, and (b)
	// trips the web client's transient-error retry (it retries 5xx writes up to
	// 4×), so e.g. a too-long title is retried repeatedly and then surfaced as an
	// opaque server error instead of an actionable "title too long" message.
	// An unparseable request body throws SyntaxError out of `c.req.json()`, and it
	// escaped straight past the ZodError branch below into the generic 500 — which is
	// precisely the outcome that branch exists to avoid: the web client treats a 5xx
	// write as transient and retries it four times, so a single malformed body became
	// four identical failures and an opaque requestId. Handled here rather than at
	// every call site, so no route has to remember to wrap its own parse.
	if (error instanceof SyntaxError
		|| (error instanceof Error && /JSON|Unexpected token/i.test(error.message))) {
		return c.json({ error: 'Malformed JSON body' }, 400);
	}
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
// Bumped to 2 when the course was rewritten. Version 1 taught, among other
// things, re-cataloguing a duplicate as a new record — so a librarian who
// completed it needs to see the new one, and `needsOnboarding` becomes true again
// for everyone who acknowledged only version 1.
const ONBOARDING_VERSION = 2;

/**
 * The account's current token epoch.
 *
 * Read back rather than remembered, because a request may bump it (a password
 * change) before reissuing a token in the same handler — stamping the value read at
 * the top would mint a token that fails on its very next use.
 */
async function currentTokenEpoch(env: Env, userId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT token_epoch FROM staff_users WHERE id = ? LIMIT 1')
		.bind(userId).first<{ token_epoch: number }>();
	return Number(row?.token_epoch ?? 0);
}

app.post('/api/auth/login', async (c) => {
	await ensureBootstrapAdmin(c.env);

	const body = await c.req.json();
	const schema = z.object({ username: z.string().min(1), password: z.string().min(1) });
	const parsed = schema.parse(body);

	const user = await c.env.DB.prepare(
		`SELECT id, username, role, password_hash, password_salt, password_iterations, active,
		        onboarding_completed_version, token_epoch
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
		role: user.role,
		// Stamped so a later password change can invalidate exactly the tokens
		// issued before it — see authMiddleware and migration 0033.
		epoch: Number((user as { token_epoch?: number }).token_epoch ?? 0)
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
		// Ends every session the OLD password opened. Without this a token taken from
		// a shared machine kept full write access for the rest of its 12-hour life
		// after the librarian changed the password precisely to stop it.
		updates.push('token_epoch = token_epoch + 1');
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
			role: me.role,
			// The CURRENT epoch, read back after any password change in this same
			// request — a reissued token stamped with the old one would fail the very
			// next request, locking the user out of the change they just made.
			epoch: await currentTokenEpoch(c.env, me.id)
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

	// Computed BEFORE the cache lookup now, because it decides whether there is a
	// cache key at all. `includeDeleted` is part of it, which also settles the role
	// collision the old key handled by hand: a trash-visible list is never
	// unfiltered, so it is never cached, so two roles cannot share a bucket.
	const isFullyUnfiltered = !(query.q ?? '').trim() && !(query.qExclude ?? '').trim()
		&& !query.status && !query.language && !query.year
		&& query.yearMin === undefined && query.yearMax === undefined
		&& !query.roomCode && !query.shelfCode && !query.missingIsbn && !query.missingShelf
		&& !query.untitled && !query.unknownAuthor && !query.invalidIsbn
		&& !query.emptyField && !query.facetField
		&& customFilters.length === 0 && !includeDeleted;

	const cacheVersion = await getBooksCacheVersion(c.env);
	// null for every query outside the canonical browse — see `browseCacheKey`. The
	// old key embedded JSON.stringify of the whole query, so the caller owned the
	// key space and each distinct search spent one of the day's 1,000 KV writes.
	const cacheKey = browseCacheKey(cacheVersion, {
		isFullyUnfiltered,
		page: query.page,
		pageSize: query.pageSize,
		sortBy: query.sortBy,
		sortDir: query.sortDir
	});

	if (cacheKey && c.env.CACHE) {
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
		invalidIsbn: query.invalidIsbn,
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

	// `versionTooFreshToCache`: during a cataloguing session every save bumps the
	// version, and the client immediately re-requests this list — so the entry
	// written here would be invalidated seconds later, having been read never. The
	// list is served from D1 instead, whose daily budget is 5,000,000 rows and not
	// the thing running out.
	if (c.env.CACHE && !versionTooFreshToCache(cacheVersion)) {
		try {
			if (cacheKey) {
				await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 });
			}
			// Store the freshly-computed unfiltered total for the pages/sorts that
			// follow (skip if we already had it, to avoid a redundant KV write).
			// ONE key per version, so this is worth its write even when the list
			// itself is not: it saves a 12,500-row COUNT on every page and re-sort.
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
	// Copies, like the list route and GET /api/books/:id already do. This route
	// is the ONLY source for a bulk label print, and a label is now per copy —
	// without them the whole-shelf reprint would silently emit QR-only tiles
	// while the single-book paths worked fine.
	const itemsByBook = await loadItemsForBooks(c.env, ids);
	return c.json({
		items: (res.results ?? []).map((row) => {
			const book = parseBook(row);
			return { ...book, items: itemsByBook.get(String(book.id)) ?? [] };
		})
	});
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
		invalidIsbn: query.invalidIsbn,
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

	if (c.env.CACHE && !versionTooFreshToCache(cacheVersion)) {
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

/**
 * Refuse a `legacyId` that is already on another record, by name.
 *
 * `idx_books_legacy_id` is UNIQUE on the bare column (migration 0005 widened it
 * from the partial index deliberately), and neither POST /api/books nor PUT
 * /api/books/:id checked it — so typing an accession number a second time came
 * back as `{"error":"Internal server error"}`, a 5xx, which `apps/web/src/api.ts`
 * retries up to four times before giving up. The librarian saw a slow failure
 * with nothing to act on, for the single most likely typo in retrospective
 * cataloguing: entering the number of the book they catalogued a minute ago.
 *
 * The index covers SOFT-DELETED rows too, so a number can be held by a book in
 * the trash — invisible in every list, and the refusal has to say so or it is
 * unactionable. That is the whole point of naming the holder.
 */
async function assertLegacyIdFree(
	env: Env,
	legacyId: string | null | undefined,
	excludeBookId: string | null
): Promise<void> {
	const value = (legacyId ?? '').trim();
	if (!value) return;
	const holder = await env.DB.prepare(
		'SELECT id, title, deleted_at FROM books WHERE legacy_id = ? AND id IS NOT ? LIMIT 1'
	)
		.bind(value, excludeBookId)
		.first<{ id: string; title: string; deleted_at: string | null }>();
	if (!holder) return;
	// The accession number is now typed on a form that runs in four languages, so this refusal
	// carries a code and the two facts its sentence names. The English message is unchanged for
	// anything that still reads it; a client that knows the code says the same thing in Greek.
	throw new HTTPException(409, {
		message: holder.deleted_at
			? `Accession number ${value} is already on "${holder.title}", which is in the trash. Restore or purge that record first, or use another number.`
			: `Accession number ${value} is already on "${holder.title}". Every record needs its own number.`,
		cause: {
			code: holder.deleted_at ? 'accession_taken_trashed' : 'accession_taken',
			details: { accession: value, title: holder.title }
		}
	});
}


app.get('/api/books/duplicates', requirePermission('books.write', { librarian: true }), async (c) => {
	// Step 1: aggregate to find duplicate keys directly in SQL — never loads the full table.
	const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') ?? 50)));
	const offset = Math.max(0, Number(c.req.query('offset') ?? 0));

	// Canonical grouping keys: fold the legacy '(Unknown)'/'(Untitled)' sentinels
	// to '' so a re-catalogued blank-author book and its legacy '(Unknown)' twin
	// land in the SAME duplicate group. Must be identical in the GROUP BY, the
	// match predicates, and the details projection or the buckets won't line up.
	// KEYED ON THE FOLD COLUMNS, not on LOWER() of the raw text.
	//
	// SQLite's LOWER() is ASCII-only — `LOWER('ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ')` returns the string
	// unchanged — which is why migration 0012 exists and why migration 0018 added
	// idx_books_title_author_fold "so the duplicate check could stop using a function
	// of the column". The post-create duplicate WARNING was moved to the folds; this
	// report, the one that drives the merge tool, was not. So the two detectors
	// answered different questions about the same catalogue: 373 groups here against
	// 374 by the fold, and every accent or case difference in a Greek title was
	// invisible to the tool built to find exactly that.
	//
	// The sentinels still fold to '': `fold('')` is NULL (author-less records) and
	// '(Unknown)' folds to '(unknown)', so both spellings of "no author" group
	// together, which is what the CASE was always for.
	const TITLE_KEY = "CASE WHEN TRIM(COALESCE(title_fold, '')) = '(untitled)' THEN '' ELSE TRIM(COALESCE(title_fold, '')) END";
	const AUTHOR_KEY = "CASE WHEN TRIM(COALESCE(author_fold, '')) = '(unknown)' THEN '' ELSE TRIM(COALESCE(author_fold, '')) END";

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
	//
	// CHUNKED, because each group costs TWO bound parameters and D1 accepts at most
	// 100 per statement. `limit` is clamped to 200, so the query blew the ceiling at
	// any limit above 50 — 500, unconditionally, from the endpoint the merge tool
	// calls. It was invisible because the default limit is exactly 50, which binds
	// exactly 100: the one value in the accepted range that happens to fit.
	const GROUPS_PER_QUERY = 45; // 90 parameters, comfortably under the ceiling
	type DetailRow = {
		id: string; title: string; author: string; isbn: string | null;
		title_key: string; author_key: string;
	};
	const detailRows: DetailRow[] = [];
	for (let i = 0; i < groups.length; i += GROUPS_PER_QUERY) {
		const slice = groups.slice(i, i + GROUPS_PER_QUERY);
		const orClauses = slice
			.map(() => `(${TITLE_KEY} = ? AND ${AUTHOR_KEY} = ?)`)
			.join(' OR ');
		const params: unknown[] = [];
		for (const g of slice) {
			params.push(g.title_key, g.author_key);
		}
		const res = await c.env.DB.prepare(
			`SELECT id, title, author, isbn,
					${TITLE_KEY} AS title_key, ${AUTHOR_KEY} AS author_key
			 FROM books
			 WHERE deleted_at IS NULL AND (${orClauses})
			 ORDER BY title_key ASC, author_key ASC, id ASC`
		).bind(...params).all<DetailRow>();
		detailRows.push(...(res.results ?? []));
	}

	const groupMap = new Map<string, Array<{ id: string; title: string; author: string; isbn: string | null }>>();
	for (const row of detailRows) {
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
		// The COUNT must exclude links from TRASHED records, as the detail endpoint and
		// subject-candidates both already do. Without the join a heading linked to ten
		// deleted books reported ten uses — and the retire confirmation states that
		// number to the librarian immediately before an irreversible unlink, so the
		// figure they weigh the decision on was the one number that had to be right.
		`SELECT a.*, (SELECT COUNT(*) FROM book_authorities ba
		               JOIN books b ON b.id = ba.book_id
		              WHERE ba.authority_id = a.id AND b.deleted_at IS NULL) AS use_count
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

	/*
	 * Read the headings this record holds now — needed for three things: the conflict check, the
	 * audit entry, and knowing what is actually being removed.
	 *
	 * The names come along because the DELETE below is a HARD delete. `book_authorities` has no
	 * deleted_at, and the audit entry recorded `{count}` and nothing else, so a replace that
	 * dropped the wrong heading left no record anywhere of what it had been. A count cannot
	 * answer "which heading did I just lose".
	 */
	const beforeRows = await c.env.DB.prepare(
		`SELECT ba.authority_id, ba.role, a.preferred_form
		   FROM book_authorities ba
		   LEFT JOIN authorities a ON a.id = ba.authority_id
		  WHERE ba.book_id = ?
		  ORDER BY ba.seq ASC`
	).bind(id).all<{ authority_id: string; role: string; preferred_form: string | null }>();
	const before = beforeRows.results ?? [];
	const keyOf = (authorityId: string, role: string) => `${authorityId}|${role}`;
	const beforeKeys = new Set(before.map((r) => keyOf(r.authority_id, r.role)));

	// The conflict check. A set comparison, so the order the client happens to hold them in is
	// not a conflict — only a heading appearing or disappearing is.
	if (payload.expectedLinks) {
		const expectedKeys = new Set(payload.expectedLinks.map((l) => keyOf(l.authorityId, l.role)));
		const same = expectedKeys.size === beforeKeys.size
			&& [...expectedKeys].every((k) => beforeKeys.has(k));
		if (!same) {
			throw new HTTPException(409, {
				message: 'The headings on this record changed since you loaded them.',
				cause: { code: 'version_conflict' }
			});
		}
	}

	const afterKeys = new Set(payload.links.map((l) => keyOf(l.authorityId, l.role)));
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
	/*
	 * The record's timestamp moves, in the same batch — or a failure could leave the headings
	 * changed and the record claiming it had not been touched.
	 *
	 * This is for OAI-PMH, which harvests incrementally on `(updated_at, id)`. MARC 1xx, 6xx and
	 * 7xx are built from exactly these links, so with the timestamp standing still a partner
	 * library that had already harvested this record would NEVER receive its corrected subject
	 * headings — the cursor would step straight past it forever. The offline sync cursor is the
	 * same column.
	 *
	 * `version` is deliberately NOT bumped. It guards the record editor and the copies editor,
	 * and neither of them writes a heading — `PUT /api/books/:id` never touches
	 * book_authorities, and nothing anywhere compares books.version before writing one. The
	 * concurrency check for THIS route is the heading set above. Bumping version would buy no
	 * protection at all and would cost a librarian who is correcting a title a conflict dialog
	 * because a colleague tagged a subject, which is how a guard earns the reputation of being
	 * noise to click through.
	 */
	statements.push(
		c.env.DB.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, id)
	);
	await runAtomic(c.env, statements);
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.authorities.replace', 'book', id, {
		count: payload.links.length,
		// What went, by name, so a mistaken replace can be undone by hand. Headings are
		// bibliographic vocabulary, not personal data about a reader.
		removed: before
			.filter((r) => !afterKeys.has(keyOf(r.authority_id, r.role)))
			.map((r) => ({ authorityId: r.authority_id, role: r.role, form: r.preferred_form })),
		added: payload.links
			.filter((l) => !beforeKeys.has(keyOf(l.authorityId, l.role)))
			.map((l) => ({ authorityId: l.authorityId, role: l.role }))
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

// Accept the candidates the librarian approved.
//
// The preview above is deliberately read-only, because which labels are real
// headings is a judgement call. What was missing was any way to act on that
// judgement short of 628 separate creates. Existing headings are skipped rather
// than duplicated, and — since the label is already on the books — each new
// heading is linked to every book carrying it, which is the whole reason the
// category labels are a good seed in the first place.
app.post('/api/authorities/seed-subjects', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = SeedSubjectsSchema.parse(await c.req.json());
	const now = nowIso();

	const existing = await c.env.DB.prepare(
		"SELECT preferred_form_fold AS f, id FROM authorities WHERE kind = 'subject' AND deleted_at IS NULL"
	).all<{ f: string; id: string }>();
	const known = new Map((existing.results ?? []).map((r) => [r.f, r.id]));

	let created = 0;
	let skipped = 0;
	let linked = 0;
	const statements: D1PreparedStatement[] = [];

	for (const raw of payload.labels) {
		const label = raw.trim();
		if (!label) { skipped += 1; continue; }
		const fold = foldDiacritics(label);
		if (known.has(fold)) { skipped += 1; continue; }
		const id = newId('auth');
		known.set(fold, id);
		created += 1;
		statements.push(
			c.env.DB.prepare(
				`INSERT INTO authorities (id, kind, preferred_form, preferred_form_romanized, preferred_form_fold,
				                          source, viaf_id, lc_id, isni, dates, notes, created_at, updated_at)
				 VALUES (?, 'subject', ?, NULL, ?, 'local', NULL, NULL, NULL, NULL, ?, ?, ?)`
			).bind(id, label, fold, 'Seeded from the catalogue’s own category labels.', now, now)
		);
		if (payload.link) {
			// 'sub' is this catalogue's marker for a subject heading in the relator
			// list, and 650 is what it exports as.
			statements.push(
				c.env.DB.prepare(
					`INSERT OR IGNORE INTO book_authorities (book_id, authority_id, role, seq, created_at)
					 SELECT id, ?, 'sub', 0, ?
					   FROM books
					  WHERE deleted_at IS NULL
					    AND TRIM(COALESCE(CAST(json_extract(custom_fields, '$.category_label') AS TEXT), '')) = ?`
				).bind(id, now, label)
			);
			linked += 1;
		}
	}

	if (statements.length > 0) await runAtomic(c.env, statements);
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'authority.seedSubjects', 'authority', null, {
		requested: payload.labels.length, created, skipped, linked
	});
	return c.json({ created, skipped, linked });
});

// Registered AFTER /api/authorities/subject-candidates on purpose. Hono matches
// in registration order, so a `:id` route declared first swallows every literal
// path under the same prefix — the same fault that made
// /api/books/merge-candidates and /api/borrowers/export.csv unreachable.
// One heading, with its variants and what points at it.
//
// The list endpoint's `q` is a PREFIX match and returns no variants, so there
// was no way to fetch a known heading at all — which is also why there was no
// way to edit one.
app.get('/api/authorities/:id', async (c) => {
	const id = c.req.param('id') ?? '';
	const row = await c.env.DB.prepare(
		'SELECT * FROM authorities WHERE id = ? AND deleted_at IS NULL'
	).bind(id).first<Record<string, unknown>>();
	if (!row) throw new HTTPException(404, { message: 'Authority not found' });

	const [variants, links, useCountRow] = await Promise.all([
		c.env.DB.prepare('SELECT id, form FROM authority_variants WHERE authority_id = ? ORDER BY form ASC')
			.bind(id).all<{ id: string; form: string }>(),
		c.env.DB.prepare(
			`SELECT ba.role, b.id, b.title, b.author
			   FROM book_authorities ba JOIN books b ON b.id = ba.book_id
			  WHERE ba.authority_id = ? AND b.deleted_at IS NULL
			  ORDER BY b.title ASC LIMIT 100`
		).bind(id).all<Record<string, unknown>>(),
		// Counted SEPARATELY and uncapped. `useCount` was the LENGTH of the sample
		// above, and that query ends in LIMIT 100 — so every heading on more than a
		// hundred records reported exactly 100, and the editor printed it as
		// "On 100 record(s)" beside a retire button that would unlink all of them.
		// The sample stays capped because it is a sample; the number must not be.
		c.env.DB.prepare(
			`SELECT COUNT(*) AS n FROM book_authorities ba JOIN books b ON b.id = ba.book_id
			  WHERE ba.authority_id = ? AND b.deleted_at IS NULL`
		).bind(id).first<{ n: number }>()
	]);

	return c.json({
		id: row.id,
		kind: row.kind,
		preferredForm: row.preferred_form,
		preferredFormRomanized: row.preferred_form_romanized,
		source: row.source,
		viafId: row.viaf_id,
		lcId: row.lc_id,
		isni: row.isni,
		dates: row.dates,
		notes: row.notes,
		variants: (variants.results ?? []).map((v) => v.form),
		// Capped at 100: this is "what would I break by editing this?", not a
		// browse. Subject browse is a separate, unbuilt thing.
		usedBy: (links.results ?? []).map((r) => ({ id: r.id, title: r.title, author: r.author, role: r.role })),
		useCount: Number(useCountRow?.n ?? 0)
	});
});

// Correct a heading in place.
//
// There was no update path of any kind: the only UPDATE on the table was the
// soft-delete, and DELETE hard-deletes every link. So fixing one typo in a
// preferred form meant destroying the heading and every book that pointed at it,
// then re-linking each by hand. For a controlled vocabulary — whose entire value
// is that the record is long-lived and pointed at — that made the feature
// unusable past the first mistake.
app.put('/api/authorities/:id', requirePermission('books.write', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const existing = await c.env.DB.prepare(
		'SELECT id, kind FROM authorities WHERE id = ? AND deleted_at IS NULL'
	).bind(id).first<{ id: string; kind: string }>();
	if (!existing) throw new HTTPException(404, { message: 'Authority not found' });

	const payload = UpsertAuthoritySchema.parse(await c.req.json());
	const preferred = payload.preferredForm.trim();
	if (!preferred) throw new HTTPException(400, { message: 'A preferred form is required' });

	// Same uniqueness rule the create path enforces, minus this row: two headings
	// for one person is the problem the table exists to solve.
	const clash = await c.env.DB.prepare(
		`SELECT id FROM authorities
		  WHERE kind = ? AND preferred_form_fold = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`
	).bind(payload.kind, foldDiacritics(preferred), id).first<{ id: string }>();
	if (clash) throw new HTTPException(409, { message: 'Another authority already has that preferred form' });

	const now = nowIso();
	const statements: D1PreparedStatement[] = [
		c.env.DB.prepare(
			`UPDATE authorities SET kind = ?, preferred_form = ?, preferred_form_romanized = ?,
			        preferred_form_fold = ?, source = ?, viaf_id = ?, lc_id = ?, isni = ?,
			        dates = ?, notes = ?, updated_at = ?
			  WHERE id = ?`
		).bind(
			payload.kind, preferred, payload.preferredFormRomanized ?? null, foldDiacritics(preferred),
			payload.source, payload.viafId ?? null, payload.lcId ?? null, payload.isni ?? null,
			payload.dates ?? null, payload.notes ?? null, now, id
		),
		// Variants are a set, not a history, so replace them wholesale. The links
		// in `book_authorities` are untouched — that is the whole point of being
		// able to edit rather than delete and recreate.
		c.env.DB.prepare('DELETE FROM authority_variants WHERE authority_id = ?').bind(id)
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
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'authority.update', 'authority', id, {
		kind: payload.kind, preferredForm: preferred, variants: payload.variants.length
	});
	return c.json({ id });
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
	// minBooks (1-50) x withGapsOnly (2) x limit (1-500) is 50,000 possible keys,
	// each one a KV write on first sight; 1,010 of them are already in the
	// development store. The interface asks for exactly one parameterisation, so
	// that is the one with any reuse and the only one cached.
	const cacheKey = minBooks === 2 && limit === 300
		? `sets:${withGapsOnly}:${cacheVersion}`
		: null;
	if (cacheKey && c.env.CACHE) {
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
		/** Members whose own title IS the series name. */
		titleEqualsSeries: number;
		/** Members carrying a volume designation. */
		numbered: number;
	};
	const clusters = new Map<string, Cluster>();

	for (const row of rows.results ?? []) {
		const cf = safeJsonParse<Record<string, unknown>>(row.custom_fields ?? '{}', {});
		const series = String(row.set_title ?? cf.series ?? '').trim();
		if (!series) continue;

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
				labels: new Map(), author: row.author ?? '', volumes: [], bookCount: 0,
				titleEqualsSeries: 0, numbered: 0
			};
			clusters.set(key, cluster);
		}
		// Display the most frequent original spelling, the way the value facets do.
		cluster.labels.set(series, (cluster.labels.get(series) ?? 0) + 1);
		const volume = row.volume_designation ?? (cf.volume_num as string | null) ?? null;
		cluster.volumes.push(volume);
		cluster.bookCount += 1;
		if (foldDiacritics(series) === foldDiacritics(row.title ?? '')) cluster.titleEqualsSeries += 1;
		if (String(volume ?? '').trim()) cluster.numbered += 1;
	}

	// A cluster is suppressed, never a member.
	//
	// 7,144 rows have `series` equal to their own title, because the import
	// auto-filled the field, and this used to drop those rows one by one. Two
	// things were wrong with that. It broke the rule the rail is built on — a
	// count in the rail opens a list of the same size — because the click-through
	// filters on `custom:series = <label>` and applies no such drop: measured on
	// this catalogue, 54 clusters advertised a count 96 books short of what they
	// opened ("ΤΑ ΠΟΙΗΜΑΤΑ" showed 2 and opened 13).
	//
	// And it hid the two largest genuine sets in the library. A book whose series
	// equals its title AND carries a volume number is not an artefact: it is
	// volume N of a work where every volume shares one title, which is the
	// commonest shape of a multi-part work here. ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ is 47 such
	// rows, all 47 numbered, and ΜΕΓΑΛΗ ΕΛΛΗΝΙΚΗ ΕΓΚΥΚΛΟΠΑΙΔΕΙΑ is 24 — neither
	// appeared in the rail at all.
	//
	// The evidence that a cluster is NOT a set is therefore: every member is titled
	// the same as the series, and not one carries a volume number. Applied per
	// cluster, it cannot change a count.
	const isEvidenceOfASet = (cluster: Cluster): boolean =>
		Boolean(cluster.setId) || cluster.titleEqualsSeries < cluster.bookCount || cluster.numbered > 0;
	const eligible = [...clusters.values()].filter((cluster) => cluster.bookCount >= minBooks);
	// Reported rather than dropped quietly: a rail that silently omits 357 groups
	// reads as "there are 573 sets", which is not what it means.
	const suppressed = eligible.filter((cluster) => !isEvidenceOfASet(cluster)).length;

	const items = eligible
		.filter(isEvidenceOfASet)
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
		.sort((a, b) => b.missingCount - a.missingCount || b.bookCount - a.bookCount);

	// `total` is how many rows this response carries; `matched` is how many there
	// were before the limit. Reporting only the first would tell the librarian the
	// library has 500 sets when it has 573.
	const response = {
		items: items.slice(0, limit),
		total: Math.min(items.length, limit),
		matched: items.length,
		suppressed
	};
	if (cacheKey && c.env.CACHE && !versionTooFreshToCache(cacheVersion)) {
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

	// CHUNKED. D1 accepts at most 100 bound parameters per statement, and this
	// flattened EVERY id in every returned group into one `IN (…)`. Two records per
	// group is the common case, so the ceiling was crossed at about fifty groups —
	// but measured, this route 500s from limit=5 upward, which is every call the
	// merge screen makes. Only `?limit=1` ever worked, and that is the value the
	// gate happened to probe.
	const chunked = async <T>(ids: string[], run: (slice: string[], ph: string) => Promise<T[]>): Promise<T[]> => {
		const out: T[] = [];
		for (let i = 0; i < ids.length; i += 90) {
			const slice = ids.slice(i, i + 90);
			out.push(...await run(slice, slice.map(() => '?').join(',')));
		}
		return out;
	};

	const [bookRows, itemsByBook] = await Promise.all([
		chunked(allIds, async (slice, ph) =>
			(await c.env.DB.prepare(`SELECT * FROM books WHERE id IN (${ph})`)
				.bind(...slice).all<Record<string, unknown>>()).results ?? []),
		loadItemsForBooks(c.env, allIds)
	]);
	const byId = new Map(bookRows.map((r) => [String(r.id), parseBook(r)]));

	// Open loans block a merge, so surface them here rather than letting the
	// operator pick a group and only then discover it cannot proceed.
	const loanRows = await chunked(allIds, async (slice, ph) =>
		(await c.env.DB.prepare(
			`SELECT book_id, COUNT(*) AS n FROM borrow_transactions
			  WHERE returned_at IS NULL AND book_id IN (${ph}) GROUP BY book_id`
		).bind(...slice).all<{ book_id: string; n: number }>()).results ?? []);
	const openLoans = new Map(loanRows.map((r) => [r.book_id, Number(r.n)]));

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
	/*
	 * DEDUPED. The list was filtered against keepId and nothing else, so the same loser passed
	 * twenty times — the schema's cap — walked the copy loop twenty times and emitted twenty
	 * statements for the SAME copy. That is not merely waste: the cascade is chunked at 40
	 * statements per D1 batch and batches are separate transactions, so the amplification is what
	 * makes a torn merge reachable from a payload that looks entirely ordinary. It also handed one
	 * copy twenty different copy numbers, and told the librarian 20 records had been removed when
	 * there was one.
	 */
	const mergeIds = [...new Set(payload.mergeIds.filter((id) => id !== payload.keepId))];
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

	// Committing a merge REMOVES records, so it needs the delete permission — the
	// same re-check `sync/push`'s `delete_book` already carries, for the same
	// reason. The route is gated on the coarse books.write, and `books.delete` is
	// false for librarians BY DEFAULT (see DEFAULT_PERMS), so without this a
	// librarian who is refused DELETE /api/books/:id, the trash and restore could
	// still clear the catalogue twenty records at a time by merging unrelated books
	// into one — and could not undo it, because seeing the trash needs the
	// permission they do not have. Verified reachable from the interface too: the
	// duplicate-merge card renders under `canWrite` alone.
	//
	// The dry run deliberately stays on books.write, so a librarian can still review
	// candidate duplicates and hand the decision to someone who can commit it.
	if (!(await userHasPermission(c, 'books.delete'))) {
		throw new HTTPException(403, { message: 'Permission denied: books.delete' });
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
		// The hold queue moves too, and did not.
		//
		// A reader waiting for the merged-away record was left holding a place in a
		// queue on a tombstone: the copies moved to the keeper, so returns were
		// processed against the keeper and the hold was never filled — the reader
		// waited forever, and the queue was invisible from the surviving record. It
		// also made the keeper unpurgeable, because the orphaned row still pointed at
		// `item_id` through a foreign key that the purge's delete-by-book could not
		// see.
		//
		// `placed_at` is carried across unchanged, so a reader who waited longer keeps
		// their precedence in the keeper's queue.
		//
		// Cancel first, move second. `idx_holds_one_per_borrower` is UNIQUE over
		// (book_id, borrower_id) for live holds, so a reader queued on BOTH records
		// would otherwise collide on the way in and fail the whole merge. Their place
		// on the keeper is the one that survives — they are already in that queue and
		// two places in it were never what they asked for.
		c.env.DB.prepare(
			`UPDATE holds SET status = 'cancelled', closed_at = ?, updated_at = ?
			  WHERE book_id IN (${mergePh})
			    AND status IN ('waiting', 'ready')
			    AND borrower_id IS NOT NULL
			    AND EXISTS (SELECT 1 FROM holds keep
			                 WHERE keep.book_id = ? AND keep.borrower_id = holds.borrower_id
			                   AND keep.status IN ('waiting', 'ready'))`
		).bind(now, now, ...mergeIds, payload.keepId),
		c.env.DB.prepare(
			`UPDATE holds SET book_id = ?, updated_at = ? WHERE book_id IN (${mergePh})`
		).bind(payload.keepId, now, ...mergeIds),
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
			        title_romanized_fold = ?, author_romanized_fold = ?, publisher_romanized_fold = ?,
			        isbn_valid = ?
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
			folds.isbn_valid,
			payload.keepId
		),
		// The tombstone. `merged_into` is the forwarding address for an old label,
		// a bookmarked URL, or an OAI-PMH harvester holding the identifier.
		c.env.DB.prepare(
			`UPDATE books SET deleted_at = ?, merged_into = ?, updated_at = ?, version = version + 1
			  WHERE id IN (${mergePh})`
		).bind(now, payload.keepId, now, ...mergeIds)
	);

	/*
	 * THE PROVENANCE IS WRITTEN FIRST, before any copy moves.
	 *
	 * `movedItems` in the log below — item id → the record it came from — is the ONLY record of
	 * which copy belonged to which record before the merge, and the restore path says so in as
	 * many words: a merged copy is re-parented, not deleted, so nothing about the copy itself
	 * remembers where it was. That log used to be written after every batch. This cascade is
	 * chunked at 40 statements and each chunk is its own transaction, so a failure part way
	 * through committed the copy moves and then never wrote the provenance — and a re-run, which
	 * is the obvious and correct response, sees only the copies still on the losers, so the ones
	 * the committed chunk already moved lose their origin permanently.
	 *
	 * Writing it first inverts the failure: at worst there is an entry for a merge that did not
	 * happen, which is a puzzle rather than a loss, and the re-run records the rest. insertAuditLog
	 * is best-effort and swallows its own errors, so it cannot break the merge to save the log.
	 */
	await insertAuditLog(c.env, c.get('user').sub, 'book.merge.intent', 'book', payload.keepId, {
		mergedIds: mergeIds,
		copiesToMove: movingItems.length,
		movedItems: movingItems.map((i) => ({ itemId: i.id, from: i.bookId }))
	});

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
	await assertLegacyIdFree(c.env, payload.legacyId, null);

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
			publisher, language, description, ddc, bib_level,
			title_romanized, author_romanized, publisher_romanized,
			room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
			legacy_id, created_at, updated_at, deleted_at,
			title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold,
			title_romanized_fold, author_romanized_fold, publisher_romanized_fold, isbn_valid
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
			payload.bibLevel ?? 'monograph',
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
			folds.publisher_romanized_fold,
			folds.isbn_valid
		)
		.run();

	// NOT `isNewBook` — the id here is derived from the client mutation id and the
	// INSERT is OR IGNORE, precisely so a retry lands on the same row. On that retry
	// the first attempt's attribute values are already there and the DELETE is what
	// clears them, so skipping it would leave a stale value behind.
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
		// Coded, because this route now answers 409 for a SECOND reason: an accession number
		// already held by another record. Without the code the client cannot tell "reload,
		// somebody edited this" from "that number is taken", and it answered the first for both —
		// reloading the record and throwing the librarian's edit away over a collision they could
		// have fixed by typing another number. This is the check that fires in practice; the one
		// after the UPDATE below catches the narrower read-then-write race.
		throw new HTTPException(409, {
			message: 'Version conflict. Refresh and retry.',
			cause: { code: 'version_conflict' }
		});
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

	// Same UNIQUE index, same retried 500 — reachable here by editing the
	// accession number of an existing record onto one already taken. Excludes
	// this record so re-saving a book that already holds its own number passes.
	await assertLegacyIdFree(c.env, (merged as { legacyId?: string | null }).legacyId, id);

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
			publisher = ?, language = ?, description = ?, ddc = ?, bib_level = ?,
			title_romanized = ?, author_romanized = ?, publisher_romanized = ?,
			room_code = ?, shelf_code = ?, acquisition_date = ?, tags = ?, custom_fields = ?, status = ?,
			legacy_id = ?, version = ?, updated_at = ?,
			title_fold = ?, author_fold = ?, isbn_fold = ?, publisher_fold = ?, description_fold = ?, tags_fold = ?, custom_fields_fold = ?,
			title_romanized_fold = ?, author_romanized_fold = ?, publisher_romanized_fold = ?, isbn_valid = ?
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
			// `merged` is the stored row overlaid with the payload, so an omitted
			// bibLevel keeps what is there rather than resetting to monograph.
			(merged as { bibLevel?: string | null }).bibLevel ?? (existingMap.bib_level as string | null) ?? 'monograph',
			merged.titleRomanized ?? null,
			merged.authorRomanized ?? null,
			merged.publisherRomanized ?? null,
			merged.roomCode ?? null,
			merged.shelfCode ?? null,
			merged.acquisitionDate ?? null,
			mergedTagsJson,
			mergedCustomFieldsJson,
			merged.status,
			/*
			 * NO `?? existingMap.legacy_id` HERE.
			 *
			 * `merged` spreads parseBook(existingMap) before the payload, so an ABSENT legacyId
			 * already carries the stored value. The old fallback therefore fired on exactly one
			 * input — an EXPLICIT null — which is the librarian clearing a number they put on the
			 * wrong record. It wrote the number straight back and answered 200, so the pill
			 * returned on the next refresh and the number stayed stuck on the wrong book while
			 * the right one could never be given it (the UNIQUE index spans the whole table).
			 * Absent still means "leave alone"; null now means "clear".
			 */
			(merged as { legacyId?: string | null }).legacyId ?? null,
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
			mergedFolds.isbn_valid,
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
			// Someone else committed between our read and this write. Coded for the same reason
			// as the precondition check above.
			throw new HTTPException(409, {
				message: 'Version conflict. Refresh and retry.',
				cause: { code: 'version_conflict' }
			});
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
		// The authority links. This route names every child table explicitly
		// rather than trusting a declared cascade, and this one was missed — so a
		// purged record left rows in `book_authorities` pointing at an id that no
		// longer exists, which then inflated every heading's use count.
		c.env.DB.prepare('DELETE FROM book_authorities WHERE book_id = ?').bind(id),
		// The hold queue. Missed the same way `book_authorities` was, and with a
		// harsher symptom: `holds.book_id` is `NOT NULL REFERENCES books(id)` with no
		// cascade (migration 0029) and `holds.item_id REFERENCES items(id)`, so a
		// record that had EVER been held — including holds long since fulfilled or
		// cancelled — tripped the foreign key on the items delete below and again on
		// the book delete. Purge answered 500 every time, for good: the record could
		// not be removed from the trash by any route, while the Trash screen kept
		// offering a button that could only fail. Must precede `items`.
		// By ITEM as well as by book. Merge now carries holds across, so the
		// by-book clause should be sufficient — but `holds.item_id` is its own
		// foreign key, and any row that names one of this record's copies while
		// naming a different book blocks the delete below in a way delete-by-book
		// cannot see. Belt and braces on the statement that has already been
		// wrong twice.
		c.env.DB.prepare(
			`DELETE FROM holds
			  WHERE book_id = ?
			     OR item_id IN (SELECT id FROM items WHERE book_id = ?)`
		).bind(id, id),
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
	// The copy UPDATE fires only if the INSERT actually landed, so a refused borrow
	// makes both no-ops rather than marking a copy borrowed with no ledger row
	// behind it. The INSERT runs first for exactly that reason — after the UPDATE
	// the copy is no longer 'available' and its own guard would never match.
	// `idx_borrow_active_item` is the backstop.
	//
	// The UPDATE tests for the inserted row by id rather than repeating the
	// INSERT's guard. That used to be a copy of the availability conditions, and
	// when the loan cap was added to the INSERT's guard and not to the UPDATE's the
	// two silently disagreed: a borrow over the cap inserted nothing, marked the
	// copy 'borrowed' anyway, and returned 201 with a transaction id that did not
	// exist. The copy was then unlendable AND unreturnable, in no loan report, with
	// no path in the interface to repair it. Deriving the UPDATE from the INSERT's
	// OUTCOME instead of from a duplicate of its reasoning is what makes that class
	// of divergence impossible — statements in a D1 batch run in order, in one
	// transaction, so the inserted row is visible here.
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
			 WHERE id = ? AND deleted_at IS NULL AND status = 'available'
			   AND EXISTS (SELECT 1 FROM borrow_transactions WHERE id = ?)`
		).bind(now, item.id, txId),
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

	// Read the INSERT, not the UPDATE. The INSERT carries the authoritative guard —
	// availability, the ready-hold check AND the loan cap — so it is the statement
	// that knows whether a loan happened. Checking the UPDATE instead is what let a
	// cap refusal report success.
	if ((borrowResults[0]?.meta?.changes ?? 0) === 0) {
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

// ─── ISO 2789 — international library statistics ───────────────────────────
//
// The standard asks for stock AND flow: how much is held, and how much was
// added, withdrawn and lent in a reporting period. Every existing count in this
// system is over `books` at a single instant, so the flow half is new.
//
// The report is deliberately honest about what it cannot know. This catalogue
// arrived as one import: `books.created_at` is the same timestamp for all
// 12,528 records and `items.acquisition_date` is NULL on every copy. Reporting
// that as 12,528 acquisitions on one day would be a fabrication, so stock held
// at the baseline is reported as a baseline and additions are counted only
// after it. `caveats` carries the reasons to the reader of the report rather
// than leaving them to be discovered.
//
// Gated on 'dashboard' — the first server-side use of that permission, which
// until now only hid a tab. A report aggregating circulation and borrower
// activity is a materially more sensitive surface than a shelf count.

/**
 * Split a free-text language field into ISO 639-2/B codes.
 *
 * `toIso639_2` already splits and folds — it shipped with the standards work
 * and has had no caller until now, which is why MARC 041 still emits the raw
 * two-letter value. This is its first real use.
 */
function explodeLanguages(raw: string | null | undefined): string[] {
	const codes = toIso639_2(raw);
	// One bucket for "not recorded" rather than dropping the record: 231 books
	// have no language, and a breakdown that silently omits them does not add up
	// to the collection size. 'und' is the ISO 639-2 code for exactly this.
	return codes.length > 0 ? codes : ['und'];
}

app.get('/api/reports/iso2789', requirePermission('dashboard', { librarian: true }), async (c) => {
	// Default to the calendar year so the common case needs no parameters.
	const now = new Date();
	const from = c.req.query('from') || `${now.getUTCFullYear()}-01-01T00:00:00.000Z`;
	const to = c.req.query('to') || now.toISOString();
	if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
		throw new HTTPException(400, { message: 'from and to must be ISO dates' });
	}
	if (from >= to) throw new HTTPException(400, { message: 'from must be before to' });

	const settings = await getLibrarySettings(c.env);
	const baseline = settings.stockBaselineDate ?? null;

	const [stock, byType, byLang, serials, additions, withdrawals, loansAgg, borrowers, quality] = await Promise.all([
		// B.2.1 / B.2.2 — titles and physical items. Every existing count in this
		// system is over records; a two-copy record understates holdings by one.
		c.env.DB.prepare(
			`SELECT (SELECT COUNT(*) FROM books WHERE deleted_at IS NULL) AS titles,
			        (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL) AS items`
		).first<{ titles: number; items: number }>(),

		// Collection by document category.
		c.env.DB.prepare(
			`SELECT COALESCE(NULLIF(TRIM(item_type), ''), 'other') AS k, COUNT(*) AS n
			   FROM items WHERE deleted_at IS NULL GROUP BY k ORDER BY n DESC`
		).all<{ k: string; n: number }>(),

		// Language is free text and legitimately multi-valued ("EL,EN"), so the
		// raw GROUP BY the dashboard uses puts a bilingual book in its own bucket.
		// Exploded and folded to ISO 639-2/B in the Worker.
		c.env.DB.prepare(
			`SELECT language AS k, COUNT(*) AS n FROM books WHERE deleted_at IS NULL GROUP BY language`
		).all<{ k: string | null; n: number }>(),

		c.env.DB.prepare(
			`SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL AND bib_level = 'serial'`
		).first<{ n: number }>(),

		// B.2.3 additions. Only copies with a real acquisition date count; the
		// legacy import has none and is reported as the baseline instead.
		c.env.DB.prepare(
			`SELECT COUNT(*) AS n FROM items
			  WHERE deleted_at IS NULL AND acquisition_date IS NOT NULL
			    AND acquisition_date >= ? AND acquisition_date < ?`
		).bind(from, to).first<{ n: number }>(),

		// B.2.4 withdrawals, excluding merge tombstones — but only the ones that ARE
		// merge tombstones.
		//
		// The predicate was `b.merged_into IS NULL`, which excluded every withdrawal
		// belonging to a record that had ever been merged away. It cannot do the job
		// it was written for: a merge RE-PARENTS live copies to the keeper and
		// soft-deletes the BOOK, so it never tombstones an item at all. Measured on
		// this catalogue: zero deleted items across every merged record.
		//
		// What it did instead was silently drop real withdrawals. A copy withdrawn in
		// March, on a record folded into its twin in April, left the March return —
		// and a withdrawn copy is not re-parented by the merge (the mover reads only
		// live copies), so it stays attached to the tombstone and stays excluded. The
		// figure is filed with a national library; a withdrawal that disappears
		// because of unrelated housekeeping months later is the worst kind of wrong.
		//
		// Narrowed rather than dropped, so it still excludes an item deletion stamped
		// at the same instant as its book's — which is what a merge WOULD look like if
		// it ever did tombstone copies.
		c.env.DB.prepare(
			`SELECT COALESCE(i.withdrawal_reason, 'unrecorded') AS k, COUNT(*) AS n
			   FROM items i JOIN books b ON b.id = i.book_id
			  WHERE i.deleted_at IS NOT NULL AND i.deleted_at >= ? AND i.deleted_at < ?
			    AND NOT (b.merged_into IS NOT NULL AND i.deleted_at = b.deleted_at)
			  GROUP BY k`
		).bind(from, to).all<{ k: string; n: number }>(),

		// B.4 loans. Counted per COPY, which is what the standard means and what
		// migration 0028 finally made possible.
		c.env.DB.prepare(
			`SELECT COUNT(*) AS loans,
			        COUNT(DISTINCT item_id) AS itemsLent,
			        COUNT(DISTINCT borrower_id) AS activeBorrowers,
			        SUM(CASE WHEN renewal_count > 0 THEN 1 ELSE 0 END) AS renewed
			   FROM borrow_transactions WHERE borrowed_at >= ? AND borrowed_at < ?`
		).bind(from, to).first<{ loans: number; itemsLent: number; activeBorrowers: number; renewed: number }>(),

		// B.1 registered users by category.
		c.env.DB.prepare(
			`SELECT COALESCE(NULLIF(TRIM(category), ''), 'standard') AS k, COUNT(*) AS n
			   FROM borrowers GROUP BY k ORDER BY n DESC`
		).all<{ k: string; n: number }>(),

		// What the figures above cannot see. Reported, not hidden.
		c.env.DB.prepare(
			`SELECT (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND acquisition_date IS NULL) AS noAcquisitionDate,
			        (SELECT COUNT(*) FROM books WHERE deleted_at IS NULL AND TRIM(COALESCE(language,'')) = '') AS noLanguage,
			        (SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND TRIM(COALESCE(item_type,'')) IN ('', 'book')) AS untypedCopies,
			        (SELECT COUNT(*) FROM books WHERE deleted_at IS NULL AND bib_level <> 'serial'
			           AND TRIM(COALESCE(json_extract(custom_fields,'$.issn'),'')) <> '') AS issnNotSerial,
			        (SELECT COUNT(*) FROM borrow_transactions WHERE borrowed_at >= ?1 AND borrowed_at < ?2 AND borrower_id IS NULL) AS anonymousLoans,
			        (SELECT COUNT(*) FROM books WHERE merged_into IS NOT NULL AND deleted_at >= ?1 AND deleted_at < ?2) AS mergeTombstones`
		).bind(from, to).first<{
			noAcquisitionDate: number; noLanguage: number; untypedCopies: number; issnNotSerial: number;
			anonymousLoans: number; mergeTombstones: number;
		}>()
	]);

	// Fold the exploded language buckets together.
	const langTotals = new Map<string, number>();
	for (const row of byLang.results ?? []) {
		for (const code of explodeLanguages(row.k)) {
			langTotals.set(code, (langTotals.get(code) ?? 0) + Number(row.n));
		}
	}

	const caveats: string[] = [];
	// THE STOCK HALF IS AS-OF NOW, NOT AS-OF THE PERIOD. The report takes from/to,
	// echoes them as `period`, and applies them to the FLOW measures — additions,
	// withdrawals, loans, active borrowers. The STOCK measures (titles, items, serial
	// titles, the category and language breakdowns) and the registered-user count
	// carry no date predicate at all. ISO 2789 defines both as at the end of the
	// reporting period, so asking for last year returns last year's flows beside
	// today's holdings, and nothing said so.
	//
	// Stated rather than silently bounded, deliberately. `created_at` for the legacy
	// catalogue is one import timestamp, so a `created_at < to` filter would report
	// zero holdings for every period before that import — replacing a knowable
	// imprecision with a confident falsehood. The whole point of this array is that a
	// figure the report cannot produce is named instead of guessed at.
	caveats.push(
		'Holdings and registered readers are counted as they stand today, not as they '
		+ 'stood at the end of the period. Only additions, withdrawals and loans are '
		+ 'bounded by the dates above.'
	);
	const noAcq = Number(quality?.noAcquisitionDate ?? 0);
	if (noAcq > 0) {
		caveats.push(
			`${noAcq} copies have no acquisition date. They are stock held at the baseline`
			+ `${baseline ? ` (${baseline.slice(0, 10)})` : ''}, not additions in any period.`
		);
	}
	if (Number(quality?.untypedCopies ?? 0) > 0) {
		caveats.push(
			`${quality?.untypedCopies} copies are recorded as the default document category 'book'. `
			+ 'The breakdown by category is only as good as that field.'
		);
	}
	// A serial count of zero is a claim, not an absence of one — the librarian
	// signs a statutory return with it. Until this release nothing could set
	// bib_level, so the figure was structurally zero and said so nowhere, while
	// records carrying an ISSN sat on the shelf. Every other blind spot in this
	// report earns a caveat; this one had none.
	if (Number(quality?.issnNotSerial ?? 0) > 0) {
		caveats.push(
			`${quality?.issnNotSerial} records carry an ISSN but are catalogued as monographs, so they are `
			+ 'not in the serial-title count. Set "Kind of publication" to periodical on each one.'
		);
	}
	if (Number(quality?.noLanguage ?? 0) > 0) {
		caveats.push(`${quality?.noLanguage} records have no language; they are counted under 'und'.`);
	}
	// The language breakdown legitimately sums to MORE than the title count: a
	// bilingual record is held in both languages. Said out loud, because a
	// column that does not add up looks like an error otherwise.
	const langSum = [...langTotals.values()].reduce((a, b) => a + b, 0);
	if (langSum > Number(stock?.titles ?? 0)) {
		caveats.push(
			`The language breakdown totals ${langSum} against ${stock?.titles} titles: a record in `
			+ 'more than one language is counted under each.'
		);
	}
	if (Number(quality?.anonymousLoans ?? 0) > 0) {
		caveats.push(
			`${quality?.anonymousLoans} loans in this period have no borrower attached, so the `
			+ 'active-borrower figure understates them.'
		);
	}
	if (Number(quality?.mergeTombstones ?? 0) > 0) {
		caveats.push(
			`${quality?.mergeTombstones} records were withdrawn by the duplicate-merge tool in this `
			+ 'period. They are duplicate records folded together, not stock withdrawn, and are excluded.'
		);
	}

	return c.json({
		period: { from, to },
		library: { isil: settings.isil ?? null, name: settings.libraryName ?? null, place: settings.libraryPlace ?? null },
		stockBaselineDate: baseline,
		collection: {
			// The instant the stock was measured, stated as a field rather than left
			// to the prose caveat below. A consumer reading `collection` beside
			// `period` would otherwise have no machine-readable way to know the two
			// are about different moments, and this return gets filed with a
			// national library — a spreadsheet formula does not read caveats.
			asOf: nowIso(),
			titles: Number(stock?.titles ?? 0),
			items: Number(stock?.items ?? 0),
			serialTitles: Number(serials?.n ?? 0),
			byDocumentCategory: (byType.results ?? []).map((r) => ({ category: r.k, items: Number(r.n) })),
			byLanguage: [...langTotals.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([language, titles]) => ({ language, titles }))
		},
		flow: {
			additions: Number(additions?.n ?? 0),
			withdrawals: {
				total: (withdrawals.results ?? []).reduce((n, r) => n + Number(r.n), 0),
				byReason: (withdrawals.results ?? []).map((r) => ({ reason: r.k, items: Number(r.n) }))
			},
			loans: Number(loansAgg?.loans ?? 0),
			itemsLent: Number(loansAgg?.itemsLent ?? 0),
			renewedLoans: Number(loansAgg?.renewed ?? 0),
			activeBorrowers: Number(loansAgg?.activeBorrowers ?? 0)
		},
		users: {
			registered: (borrowers.results ?? []).reduce((n, r) => n + Number(r.n), 0),
			byCategory: (borrowers.results ?? []).map((r) => ({ category: r.k, borrowers: Number(r.n) }))
		},
		caveats
	});
});

app.get('/api/reports/iso2789.csv', requirePermission('dashboard', { librarian: true }), async (c) => {
	const url = new URL(c.req.url);
	url.pathname = '/api/reports/iso2789';
	// Re-enter the JSON handler rather than duplicating the twelve queries; the
	// two must never be able to disagree about a figure.
	const res = await app.fetch(new Request(url.toString(), { headers: c.req.raw.headers }), c.env, c.executionCtx);
	const data = await res.json() as Record<string, any>;

	const rows: Array<{ Section: string; Measure: string; Value: string | number }> = [
		{ Section: 'Period', Measure: 'From', Value: data.period.from },
		{ Section: 'Period', Measure: 'To', Value: data.period.to },
		// Named in the sheet for the same reason it is named in the JSON: the
		// holdings figures below are as at this instant, not as at 'To'.
		{ Section: 'Period', Measure: 'Holdings counted as at', Value: data.collection.asOf },
		{ Section: 'Library', Measure: 'ISIL', Value: data.library.isil ?? '' },
		{ Section: 'Library', Measure: 'Name', Value: data.library.name ?? '' },
		{ Section: 'Collection', Measure: 'Titles held', Value: data.collection.titles },
		{ Section: 'Collection', Measure: 'Physical items held', Value: data.collection.items },
		{ Section: 'Collection', Measure: 'Serial titles held', Value: data.collection.serialTitles },
		...data.collection.byDocumentCategory.map((r: any) => ({
			Section: 'Collection by document category', Measure: r.category, Value: r.items
		})),
		...data.collection.byLanguage.map((r: any) => ({
			Section: 'Collection by language', Measure: r.language, Value: r.titles
		})),
		{ Section: 'Flow', Measure: 'Additions', Value: data.flow.additions },
		{ Section: 'Flow', Measure: 'Withdrawals', Value: data.flow.withdrawals.total },
		...data.flow.withdrawals.byReason.map((r: any) => ({
			Section: 'Withdrawals by reason', Measure: r.reason, Value: r.items
		})),
		{ Section: 'Flow', Measure: 'Loans', Value: data.flow.loans },
		{ Section: 'Flow', Measure: 'Distinct items lent', Value: data.flow.itemsLent },
		{ Section: 'Flow', Measure: 'Loans renewed', Value: data.flow.renewedLoans },
		{ Section: 'Flow', Measure: 'Active borrowers', Value: data.flow.activeBorrowers },
		{ Section: 'Users', Measure: 'Registered borrowers', Value: data.users.registered },
		...data.users.byCategory.map((r: any) => ({
			Section: 'Users by category', Measure: r.category, Value: r.borrowers
		})),
		// The caveats travel WITH the numbers. A spreadsheet that leaves them
		// behind is how a figure gets quoted without its qualification.
		...data.caveats.map((text: string, i: number) => ({
			Section: 'Caveats', Measure: `Note ${i + 1}`, Value: text
		}))
	];

	c.header('Content-Type', 'text/csv; charset=utf-8');
	c.header('Content-Disposition', `attachment; filename="iso2789-${String(data.period.from).slice(0, 10)}.csv"`);
	return c.body(toCsv(rows, ['Section', 'Measure', 'Value']));
});

// ─── Item barcodes ─────────────────────────────────────────────────────────
//
// `items.barcode` has been in the schema since migration 0021, documented as
// the "Code 128 payload once labels are reprinted", and has been NULL on every
// one of the 12,528 copies ever since — nothing minted a value and no screen
// could enter one.
//
// The payload is an 8-digit zero-padded sequence, chosen so Code 128 subset C
// applies: 8 digits pack into 4 symbols, 79 modules, about 26mm at a scannable
// module width. The label tile has roughly 35mm free beside the QR. The
// alphanumeric values `generateCodeValue` mints are ~24 characters and would
// need ~75mm, which is why they are not reused here.

/** The next free number in the sequence. One indexed read; not a stored counter. */
async function nextBarcodeSequence(env: Env): Promise<number> {
	const row = await env.DB.prepare(
		// GLOB rather than a CAST over everything: a barcode a librarian typed by
		// hand ('REF-12') must not be read as a number and collapse the sequence.
		//
		// EIGHT explicit digit classes, not `'[0-9]*'`. A GLOB pattern of
		// `[0-9]*` constrains only the FIRST character — the `*` matches anything —
		// so every value merely BEGINNING with a digit was read as a number. One
		// EAN or ISBN typed into the barcode box ('9789601234567') therefore became
		// the sequence maximum, and every barcode minted afterwards was thirteen
		// digits: twice the width of the label, and outside the 8-digit subset-C
		// invariant the label sheet is built around. Measured on this catalogue: the
		// next value would have jumped from 99888558 to 9789601234568.
		//
		// Scoped to exactly what this system MINTS, so a hand-typed value of any
		// shape — long, short, prefixed — can never move the sequence.
		`SELECT MAX(CAST(barcode AS INTEGER)) AS n FROM items
		  WHERE barcode IS NOT NULL
		    AND LENGTH(barcode) = 8
		    AND barcode GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'`
	).first<{ n: number | null }>();
	const next = Number(row?.n ?? 0) + 1;
	// Refuse to overflow rather than silently widening the label. 99,999,999 copies
	// is not a number this library will reach, but a corrupted sequence could get
	// here, and a barcode that does not fit its label is worse than an error.
	if (next > 99999999) {
		throw new HTTPException(409, {
			message: 'The 8-digit barcode sequence is exhausted. Check for a mistyped barcode holding the top of the range.'
		});
	}
	return next;
}

app.post('/api/items/assign-barcodes', requirePermission('books.write', { librarian: true }), async (c) => {
	const body = z.object({
		bookIds: z.array(z.string().min(1)).max(500).optional(),
		// Paged like every other catalogue-wide sweep in this codebase: 12.5K
		// writes do not fit in one Workers invocation, and the caller loops on
		// `remaining` the way the attribute retype and normalize passes are driven.
		limit: z.number().int().min(1).max(500).default(200)
	}).parse(await c.req.json().catch(() => ({})));

	// The scope ids are INTERPOLATED after a strict shape check rather than bound,
	// because D1 accepts at most 100 bound parameters and this schema permits 500 —
	// so a scoped sweep of more than ~99 books 500'd. The regex is the same one the
	// other id-interpolating readers use (`loadSerialHoldingsForBooks`,
	// `/api/books/by-ids`): anything that is not [A-Za-z0-9_-] never reaches the SQL,
	// which is what makes interpolation safe here. `limit` stays bound.
	const scopeIds = (body.bookIds ?? []).filter((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id));
	if (body.bookIds?.length && scopeIds.length === 0) {
		throw new HTTPException(400, { message: 'No valid book ids' });
	}
	const scope = scopeIds.length
		? `AND book_id IN (${scopeIds.map((id) => `'${id}'`).join(',')})`
		: '';
	const rows = await c.env.DB.prepare(
		`SELECT id FROM items
		  WHERE deleted_at IS NULL AND (barcode IS NULL OR TRIM(barcode) = '') ${scope}
		  ORDER BY created_at ASC, id ASC LIMIT ?`
	).bind(body.limit).all<{ id: string }>();

	const todo = rows.results ?? [];
	let seq = await nextBarcodeSequence(c.env);
	const now = nowIso();
	const statements = todo.map((r) => {
		const value = formatItemBarcode(seq++);
		return c.env.DB.prepare(
			// The guard makes a retried page a no-op instead of burning numbers on
			// copies a previous attempt already labelled.
			`UPDATE items SET barcode = ?, updated_at = ? WHERE id = ? AND (barcode IS NULL OR TRIM(barcode) = '')`
		).bind(value, now, r.id);
	});
	for (let i = 0; i < statements.length; i += 40) {
		await runAtomic(c.env, statements.slice(i, i + 40));
	}

	// `scope` interpolates its ids, so this statement binds nothing.
	const left = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM items
		  WHERE deleted_at IS NULL AND (barcode IS NULL OR TRIM(barcode) = '') ${scope}`
	).first<{ n: number }>();

	if (todo.length > 0) {
		await bumpBooksCacheVersion(c.env);
		await insertAuditLog(c.env, c.get('user').sub, 'items.assignBarcodes', 'system', null, {
			assigned: todo.length, remaining: Number(left?.n ?? 0)
		});
	}
	return c.json({
		assigned: todo.length,
		remaining: Number(left?.n ?? 0),
		// The caller keeps POSTing while this is false, exactly like the attribute
		// retype sweep.
		complete: Number(left?.n ?? 0) === 0
	});
});

// The symbol itself. Served rather than only rendered client-side so the
// encoder has one implementation and the regression gate can assert its module
// pattern against known vectors — an encoder nobody tests prints unscannable
// labels.
app.get('/api/items/:id/barcode.svg', async (c) => {
	const id = c.req.param('id') ?? '';
	const row = await c.env.DB.prepare(
		'SELECT barcode FROM items WHERE id = ? AND deleted_at IS NULL'
	).bind(id).first<{ barcode: string | null }>();
	if (!row) throw new HTTPException(404, { message: 'Copy not found' });
	if (!row.barcode) throw new HTTPException(409, { message: 'This copy has no barcode yet' });

	const svg = code128Svg(row.barcode, {
		moduleWidth: Number(c.req.query('mw') ?? 1),
		height: Number(c.req.query('h') ?? 40),
		showText: c.req.query('text') !== 'false'
	});
	c.header('Content-Type', 'image/svg+xml; charset=utf-8');
	// Immutable for a given copy: the payload only changes if the copy is
	// relabelled, which changes the barcode and therefore the meaning anyway.
	c.header('Cache-Control', 'private, max-age=86400');
	return c.body(svg);
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
	await expireStaleHolds(c.env, now, dueDateFromPolicy(HOLD_SHELF_DAYS, new Date(now)));

	const next = await c.env.DB.prepare(
		`SELECT id, borrower_name FROM holds
		  WHERE book_id = ? AND status = 'waiting'
		  ORDER BY placed_at ASC, rowid ASC LIMIT 1`
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
	const _hnow = nowIso();
	await expireStaleHolds(c.env, _hnow, dueDateFromPolicy(HOLD_SHELF_DAYS, new Date(_hnow)));
	const rows = await c.env.DB.prepare(
		`SELECT h.*, i.copy_number, i.shelf_code FROM holds h
		   LEFT JOIN items i ON i.id = h.item_id
		  WHERE h.book_id = ? AND h.status IN ('waiting', 'ready')
		  -- rowid, not id, as the tiebreak. Hold ids are random UUIDs, so two
		  -- holds placed in the same millisecond would queue in an order decided
		  -- by a coin flip. SQLite's rowid is insertion order, which is exactly
		  -- what first-come-first-served means.
		  ORDER BY h.placed_at ASC, h.rowid ASC`
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
	await expireStaleHolds(c.env, now, dueDateFromPolicy(HOLD_SHELF_DAYS, new Date(now)));

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

	// Rank, not a count of everything before "now": placed_at has millisecond
	// resolution and two holds taken in the same click land on the same value.
	// The tiebreak must match the queue's own ORDER BY or the number shown to
	// the reader is not the position they will actually be served in.
	const position = await c.env.DB.prepare(
		`SELECT COUNT(*) + 1 AS n FROM holds
		  WHERE book_id = ? AND status IN ('waiting','ready')
		    AND (placed_at < ? OR (placed_at = ? AND rowid < (SELECT rowid FROM holds WHERE id = ?)))`
	).bind(bookId, now, now, id).first<{ n: number }>();

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
	const _shelfNow = nowIso();
	await expireStaleHolds(c.env, _shelfNow, dueDateFromPolicy(HOLD_SHELF_DAYS, new Date(_shelfNow)));
	const rows = await c.env.DB.prepare(
		`SELECT h.id, h.book_id, h.borrower_name, h.borrower_contact, h.status,
		        h.placed_at, h.ready_at, h.expires_at, h.item_id,
		        b.title, b.author, i.copy_number, i.shelf_code
		   FROM holds h
		   JOIN books b ON b.id = h.book_id AND b.deleted_at IS NULL
		   LEFT JOIN items i ON i.id = h.item_id
		  WHERE h.status IN ('waiting', 'ready')
		  ORDER BY (h.status = 'ready') DESC, h.placed_at ASC, h.rowid ASC
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
	// Compared as INSTANTS, not as strings.
	//
	// `expectedDueAt` is canonicalised to `toISOString()` by ISODateTimeSchema on the
	// way in, while a row written before that normalisation holds whatever the caller
	// sent — three loans in this catalogue do. A raw string comparison therefore
	// never matched for them: the client read the stored value, sent it straight
	// back, and the precondition rejected its own echo. Renewal impossible, forever,
	// with a message telling the librarian to refresh and try again.
	//
	// An unparseable stored value falls back to the string compare, which fails
	// closed — the safe direction for a precondition whose job is to stop a retried
	// write from double-extending a loan.
	if (payload.expectedDueAt) {
		const asInstant = (v: string | null): string | null => {
			if (!v) return null;
			const t = Date.parse(v);
			return Number.isNaN(t) ? null : new Date(t).toISOString();
		};
		const sent = asInstant(payload.expectedDueAt);
		const stored = asInstant(loan.due_at);
		const same = sent && stored ? sent === stored : payload.expectedDueAt === loan.due_at;
		if (!same) {
			throw new HTTPException(409, {
				message: 'This loan has already been renewed. Refresh to see the current due date.'
			});
		}
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
	/*
	 * `?withdrawn=1` also returns the copies that were taken off the shelf.
	 *
	 * Withdrawing a copy in the editor sets items.deleted_at, and nothing anywhere cleared it
	 * again. restoreItemsDeletedAt looks deliberately narrow — it matches the BOOK's own deletion
	 * timestamp, so restoring a record brings back exactly the copies that record's deletion took
	 * down — which means a copy withdrawn on its own, by a slip in the editor, was gone from the
	 * app permanently. Records have a trash and a restore; copies had neither.
	 */
	const withWithdrawn = c.req.query('withdrawn') === '1';
	const items = await loadBookItems(c.env, id);
	if (!withWithdrawn) return c.json({ bookId: id, items });
	const gone = await c.env.DB.prepare(
		`SELECT * FROM items WHERE book_id = ? AND deleted_at IS NOT NULL
		  ORDER BY deleted_at DESC, copy_number ASC, id ASC LIMIT 200`
	).bind(id).all<Record<string, unknown>>();
	return c.json({ bookId: id, items, withdrawn: (gone.results ?? []).map(parseItem) });
});

/**
 * Put a withdrawn copy back on the shelf.
 *
 * The copy number is REASSIGNED rather than restored. The number that copy held has very likely
 * been taken since — the editor renumbers what is left when a copy goes — so writing the old one
 * back would give a record two copy 2s, and the numbering is what the label on the spine says.
 * It comes back at the end, which is also where an operator would expect a returning volume.
 *
 * The barcode returns untouched: `items.barcode` is UNIQUE across the whole table with no
 * deleted_at predicate, so a withdrawn copy never released it and nothing else can be holding it.
 */
app.post('/api/books/:id/items/:itemId/restore', requirePermission('books.write', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const itemId = c.req.param('itemId') ?? '';
	const book = await c.env.DB.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL')
		.bind(id).first();
	if (!book) throw new HTTPException(404, { message: 'Book not found' });

	const item = await c.env.DB.prepare(
		'SELECT id, copy_number, deleted_at FROM items WHERE id = ? AND book_id = ? LIMIT 1'
	).bind(itemId, id).first<{ id: string; copy_number: number; deleted_at: string | null }>();
	if (!item) throw new HTTPException(404, { message: 'Copy not found on this record' });
	if (!item.deleted_at) {
		throw new HTTPException(409, { message: 'That copy is already on the shelf.' });
	}

	const highest = await c.env.DB.prepare(
		'SELECT COALESCE(MAX(copy_number), 0) AS n FROM items WHERE book_id = ? AND deleted_at IS NULL'
	).bind(id).first<{ n: number }>();
	const now = nowIso();
	await c.env.DB.prepare(
		`UPDATE items SET deleted_at = NULL, withdrawal_reason = NULL, copy_number = ?,
		        status = CASE WHEN status = 'borrowed' THEN 'available' ELSE status END,
		        updated_at = ?, version = version + 1
		  WHERE id = ?`
	).bind(Number(highest?.n ?? 0) + 1, now, itemId).run();

	// Moves books.version and updated_at, so an editor holding the old list is told.
	await syncBookFromItems(c.env, id);
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.items.restore', 'book', id, {
		itemId, wasCopyNumber: item.copy_number, withdrawnAt: item.deleted_at
	});
	return c.json({ bookId: id, items: await loadBookItems(c.env, id) });
});

// ─── Serial holdings: the run of a periodical ─────────────────────────────
//
// Migration 0026 built `serial_holdings` for exactly one purpose — so that
// ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ can be ONE record saying "τόμος 1-10 (1975-1984), λείπει
// ο τ. 12" instead of the 47 separate book rows it is today — and then nothing
// in the system could read or write the table. The only statement that named it
// was a merge re-parent, which could never match a row.

app.get('/api/books/:id/serial-holdings', async (c) => {
	const id = c.req.param('id') ?? '';
	const book = await c.env.DB.prepare(
		'SELECT id, bib_level FROM books WHERE id = ? AND deleted_at IS NULL'
	).bind(id).first<{ id: string; bib_level: string }>();
	if (!book) throw new HTTPException(404, { message: 'Book not found' });
	// Returned for any record, not just serials: a title can be marked a serial
	// after its run was typed, and refusing to show what is stored would look
	// like data loss.
	return c.json({ bookId: id, bibLevel: book.bib_level ?? 'monograph', holdings: await loadSerialHoldings(c.env, id) });
});

app.put('/api/books/:id/serial-holdings', requirePermission('books.write', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	const book = await c.env.DB.prepare(
		'SELECT id, version FROM books WHERE id = ? AND deleted_at IS NULL'
	).bind(id).first<{ id: string; version: number }>();
	if (!book) throw new HTTPException(404, { message: 'Book not found' });

	const payload = ReplaceSerialHoldingsSchema.parse(await c.req.json());
	if (payload.expectedVersion !== undefined && payload.expectedVersion !== book.version) {
		/*
		 * A machine-readable code, not just a sentence. A replace route answers 409 for several
		 * different reasons — a stale version, a barcode already in use, a copy on loan, a copy
		 * on the hold shelf, the last remaining copy — and only ONE of them means "reload and
		 * try again". The client has to tell them apart to know whether reloading is the right
		 * response, and matching the server's English prose from a UI that runs in four
		 * languages is how that kind of check quietly stops working.
		 */
		throw new HTTPException(409, {
			message: 'Book was modified by someone else',
			cause: { code: 'version_conflict' }
		});
	}

	const existing = await loadSerialHoldings(c.env, id);
	const existingIds = new Set(existing.map((h) => String(h.id)));
	const keptIds = new Set(payload.holdings.map((h) => h.id).filter(Boolean) as string[]);
	const now = nowIso();
	const statements: D1PreparedStatement[] = [];

	// A holdings statement is a description, not a physical object: removing one
	// is a correction, so it is a hard delete rather than a withdrawal.
	for (const gone of existing) {
		if (!keptIds.has(String(gone.id))) {
			statements.push(c.env.DB.prepare('DELETE FROM serial_holdings WHERE id = ?').bind(gone.id));
		}
	}

	payload.holdings.forEach((h, index) => {
		// `seq` is list position, for the same reason copy numbers are: the order
		// the librarian arranged IS the order the run reads in.
		if (h.id && existingIds.has(h.id)) {
			statements.push(
				c.env.DB.prepare(
					`UPDATE serial_holdings SET caption = ?, from_volume = ?, to_volume = ?,
					        from_year = ?, to_year = ?, gaps = ?, note = ?, seq = ?, updated_at = ?
					  WHERE id = ?`
				).bind(
					h.caption ?? null, h.fromVolume ?? null, h.toVolume ?? null,
					h.fromYear ?? null, h.toYear ?? null, h.gaps ?? null, h.note ?? null,
					index, now, h.id
				)
			);
		} else {
			statements.push(
				c.env.DB.prepare(
					`INSERT INTO serial_holdings (id, book_id, caption, from_volume, to_volume,
					                              from_year, to_year, gaps, note, seq, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				).bind(
					newId('shd'), id, h.caption ?? null, h.fromVolume ?? null, h.toVolume ?? null,
					h.fromYear ?? null, h.toYear ?? null, h.gaps ?? null, h.note ?? null,
					index, now, now
				)
			);
		}
	});

	statements.push(
		c.env.DB.prepare('UPDATE books SET updated_at = ?, version = version + 1 WHERE id = ?').bind(now, id)
	);
	await runAtomic(c.env, statements);
	await bumpBooksCacheVersion(c.env);
	await insertAuditLog(c.env, c.get('user').sub, 'book.serialHoldings.replace', 'book', id, {
		count: payload.holdings.length
	});
	return c.json({ bookId: id, holdings: await loadSerialHoldings(c.env, id) });
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
		/*
		 * A machine-readable code, not just a sentence. A replace route answers 409 for several
		 * different reasons — a stale version, a barcode already in use, a copy on loan, a copy
		 * on the hold shelf, the last remaining copy — and only ONE of them means "reload and
		 * try again". The client has to tell them apart to know whether reloading is the right
		 * response, and matching the server's English prose from a UI that runs in four
		 * languages is how that kind of check quietly stops working.
		 */
		throw new HTTPException(409, {
			message: 'Book was modified by someone else',
			cause: { code: 'version_conflict' }
		});
	}

	const existing = await loadBookItems(c.env, id);
	const existingById = new Map(existing.map((i) => [String(i.id), i]));
	const keptIds = new Set(payload.items.map((i) => i.id).filter(Boolean) as string[]);
	const now = nowIso();
	const statements: D1PreparedStatement[] = [];

	// A copy that is on loan cannot be removed — that would strand the loan and
	// lose the record of who has the book. A copy waiting on the hold shelf is
	// equally pinned: `ITEM_IS_FREE`, which every other path uses, treats a ready
	// hold as making a copy unavailable, and this guard used to look only at
	// `status === 'borrowed'` — so a replace that omitted it soft-deleted the copy
	// out from under the reader it was being held for.
	const removing = existing.filter((prior) => !keptIds.has(String(prior.id)));
	if (removing.length > 0) {
		const onHold = await c.env.DB.prepare(
			`SELECT item_id FROM holds WHERE status = 'ready' AND item_id IS NOT NULL
			   AND item_id IN (${removing.map(() => '?').join(', ')})`
		).bind(...removing.map((r) => String(r.id))).all<{ item_id: string }>();
		const pinned = new Set((onHold.results ?? []).map((r) => r.item_id));
		for (const prior of removing) {
			if (prior.status === 'borrowed') {
				throw new HTTPException(409, { message: 'Cannot remove a copy that is on loan. Return it first.' });
			}
			if (pinned.has(String(prior.id))) {
				throw new HTTPException(409, {
					message: 'Cannot remove a copy that is waiting on the hold shelf. Cancel the hold first.'
				});
			}
		}
		// Removing a copy is a WITHDRAWAL — ISO 2789 B.2.4 counts them, and the
		// column to say why has existed since 0030 with no way to write it. The
		// version bump matters too: the copy changed, and an unversioned change is
		// invisible to any client holding the old row.
		const reason = payload.withdrawalReason?.trim() || null;
		for (const prior of removing) {
			statements.push(
				c.env.DB.prepare(
					`UPDATE items SET deleted_at = ?, updated_at = ?, withdrawal_reason = ?,
					        version = version + 1 WHERE id = ?`
				).bind(now, now, reason, prior.id)
			);
		}
	}

	// A room must exist before a copy can be filed in it, and this was checked
	// nowhere — with a worse outcome than a plain error. The items batch commits,
	// and only THEN does `syncBookFromItems` copy the room onto `books.room_code`,
	// which carries `FOREIGN KEY (room_code) REFERENCES rooms(code)`. An unknown
	// room therefore threw AFTER the copy was already durable: the librarian saw a
	// 500 and the copy had moved. A torn write reported as a failure is worse than
	// either outcome alone, because the obvious response — try again — is wrong.
	//
	// Checked here, before anything is written, and named in the message so the
	// answer is "create the room first" rather than "something went wrong".
	const wantedRooms = [...new Set(
		payload.items
			.map((i) => (i.roomCode ? normalizeCode(i.roomCode) : null))
			.filter((v): v is string => Boolean(v))
	)];
	if (wantedRooms.length > 0) {
		const known = await c.env.DB.prepare(
			`SELECT code FROM rooms WHERE code IN (${wantedRooms.map(() => '?').join(', ')})`
		).bind(...wantedRooms).all<{ code: string }>();
		const have = new Set((known.results ?? []).map((r) => r.code));
		const missing = wantedRooms.filter((r) => !have.has(r));
		if (missing.length > 0) {
			throw new HTTPException(409, {
				message: `No room with the code ${missing.join(', ')}. Create the room first, in Settings → Rooms.`
			});
		}
	}

	// items.barcode is UNIQUE across the whole catalogue, and neither branch below
	// pre-checked it: a barcode already on another copy came back out of the D1
	// batch as a raw constraint error, i.e. a 500 the client retried four times
	// rather than "that barcode is already on another copy".
	const typedBarcodes = payload.items
		.map((i) => i.barcode?.trim())
		.filter((b): b is string => Boolean(b));
	const dupInPayload = typedBarcodes.find((b, i) => typedBarcodes.indexOf(b) !== i);
	if (dupInPayload) {
		throw new HTTPException(409, { message: `Barcode ${dupInPayload} is on two copies in this list.` });
	}
	if (typedBarcodes.length > 0) {
		// The pre-check has to cover EXACTLY what the constraint covers, and it did
		// not. `items.barcode` is declared `TEXT UNIQUE` at the table level, with no
		// `deleted_at` predicate, so it binds every row ever written — including
		// withdrawn copies and copies of this very record. The check looked only at
		// `deleted_at IS NULL AND book_id <> ?`, so two ordinary cases slipped past it
		// into the raw constraint and came back as the bare 500 the comment above
		// says was fixed:
		//
		//   · a barcode still held by a WITHDRAWN copy anywhere; and
		//   · a barcode kept while its copy is removed from this record's list and
		//     re-added as a new one — the tombstone keeps the value, so the insert
		//     collides, and every later save of that record collides again. Forever.
		//
		// Rows the payload updates IN PLACE are excluded: keeping your own barcode is
		// not a clash. Everything else is fair game, and the message says whether the
		// holder is withdrawn, because "it is on a withdrawn copy" is the difference
		// between a typo and a label the librarian may legitimately want to re-use.
		const keptIds = payload.items.map((i) => i.id).filter((v): v is string => Boolean(v));
		const clash = await c.env.DB.prepare(
			`SELECT barcode, book_id, (deleted_at IS NOT NULL) AS withdrawn FROM items
			  WHERE barcode IN (${typedBarcodes.map(() => '?').join(', ')})
			    ${keptIds.length ? `AND id NOT IN (${keptIds.map(() => '?').join(', ')})` : ''}
			  LIMIT 1`
		).bind(...typedBarcodes, ...keptIds).first<{ barcode: string; book_id: string; withdrawn: number }>();
		if (clash) {
			const where = Number(clash.withdrawn) === 1
				? 'a withdrawn copy'
				: (clash.book_id === id ? 'another copy of this record' : 'a copy of another record');
			throw new HTTPException(409, {
				message: `Barcode ${clash.barcode} is already on ${where}.`
			});
		}
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
					        shelf_code = ?, call_number = ?, item_type = COALESCE(?, item_type), condition = ?,
					        acquisition_date = ?, notes = ?, barcode = ?, updated_at = ?, version = version + 1
					  WHERE id = ?`
				).bind(
					copyNumber, item.volumeNum ?? null, item.volumeLabel ?? null, roomCode,
					// COALESCE: itemType is optional on this schema now, and an edit that
					// does not mention the type must not reclassify the copy.
					shelfCode, item.callNumber ?? null, item.itemType ?? null, item.condition ?? null,
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
					// A NEW copy still gets a type; the default moved here from the schema
					// so it applies where it is meaningful and not to an omitted edit.
					roomCode, shelfCode, item.callNumber ?? null, item.itemType ?? 'book',
					item.condition ?? null, item.acquisitionDate ?? null, item.notes ?? null, now, now
				)
			);
		}
	});

	await runAtomic(c.env, statements);
	// The record's own shelf/room/status are derived from its copies — and syncBookFromItems
	// moves updated_at and version, which is why this route no longer bumps them itself. It
	// did, and add-copies did not; centralising it there is what closed that gap.
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

	// CHUNKED at 90. AddCopiesSchema permits 500 ids and the web client submits in
	// batches of 200, but D1 accepts at most 100 bound parameters per statement — so
	// the bulk action this endpoint exists for failed with a 500 the moment more
	// than a hundred books were selected, which is the case it was built for.
	const found: string[] = [];
	for (let i = 0; i < ids.length; i += 90) {
		const slice = ids.slice(i, i + 90);
		const placeholders = slice.map(() => '?').join(',');
		const books = await c.env.DB.prepare(
			`SELECT id FROM books WHERE deleted_at IS NULL AND id IN (${placeholders})`
		).bind(...slice).all<{ id: string }>();
		found.push(...(books.results ?? []).map((b) => b.id));
	}
	if (found.length === 0) throw new HTTPException(404, { message: 'No matching books' });

	const existingItems = await loadItemsForBooks(c.env, found);
	const now = nowIso();
	const shelfCode = payload.shelfCode ? normalizeCode(payload.shelfCode) || null : null;
	const roomCode = payload.roomCode ? normalizeCode(payload.roomCode) || null : null;

	const statements: D1PreparedStatement[] = [];
	let created = 0;
	// A new copy is born labelled. The alternative is a shelf where some copies
	// scan and some do not, which is worse than none scanning: the operator
	// cannot tell which case they are in without trying.
	let barcodeSeq = await nextBarcodeSequence(c.env);

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
					                    room_code, shelf_code, item_type, status, barcode,
					                    created_at, updated_at, version)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, 0)`
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
					formatItemBarcode(barcodeSeq++),
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

// `labels.print`, not `books.write`. This is the only server-side operation in the
// scope the permission matrix advertises for that toggle — its description is
// literally "Generate and print spine / shelf labels and QR codes" — and it was
// gated on a different permission, which broke the toggle in both directions:
// turning labels.print OFF hid the menu item while the endpoint kept accepting the
// call, and turning it ON for a role without books.write showed the librarian a menu
// item that answered 403. A permission that changes only which buttons are drawn is
// not a permission.
//
// Still `librarian: true`: it writes a row, so the librarian-or-above floor every
// other write carries stays. The default matrix gives librarians both, so no role
// changes behaviour on deploy.
app.post('/api/books/:id/codes', requirePermission('labels.print', { librarian: true }), async (c) => {
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

	// An ITEM barcode comes first, because it is the only one of the four that
	// answers the question a scan is actually asking: not "which book is this?"
	// but "which of the copies on 19-000 ΠΙΣΩ am I holding?". Returning the
	// record alone was fine while a record had one copy.
	const itemRow = await c.env.DB.prepare(
		`SELECT i.* FROM items i
		  WHERE i.barcode = ? AND i.deleted_at IS NULL LIMIT 1`
	).bind(codeValue).first<Record<string, unknown>>();

	let row: Record<string, unknown> | null = null;
	if (itemRow) {
		row = await c.env.DB.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL')
			.bind(String(itemRow.book_id)).first<Record<string, unknown>>();
	}

	if (!row) {
		row = await c.env.DB.prepare(
			`SELECT b.*, ca.code_type, ca.code_value
			 FROM code_assignments ca
			 JOIN books b ON b.id = ca.book_id
			 WHERE ca.code_value = ? AND ca.active = 1 AND b.deleted_at IS NULL
			 LIMIT 1`
		).bind(codeValue).first<Record<string, unknown>>();
	}

	// Fallback: printed labels (labels.ts) encode /api/scan/<legacy_id | book id>,
	// NOT a generated code_value, so scanning a printed label would otherwise
	// always 404. If no code assignment matches, resolve the value directly
	// against the book's legacy_id or id. Generated codes still take priority.
	if (!row) {
		row = await c.env.DB.prepare(
			`SELECT b.* FROM books b
			 WHERE (b.legacy_id = ? OR b.id = ?) AND b.deleted_at IS NULL
			 LIMIT 1`
		).bind(codeValue, codeValue).first<Record<string, unknown>>();
	}

	if (!row) {
		throw new HTTPException(404, { message: 'No book found for this code' });
	}

	const book = parseBook(row);
	const bookId = String(book.id);
	return c.json({
		book,
		// Which copy was scanned, when the value identified one. Null for the
		// three book-level fallbacks — the caller then has to ask.
		item: itemRow ? parseItem(itemRow) : null,
		// Every copy, so a scan of a book-level label can still offer a choice
		// rather than guessing.
		items: await loadBookItems(c.env, bookId),
		// What a scan is usually a prelude to. Saves the desk a second request.
		//
		// But it names the READER, and that is circulation data: `/api/borrow/active`,
		// `/api/borrowers`, `/api/holds` and `/api/books/:id/history` all require the
		// `circulation` permission for the same fact. This route needs no permission —
		// identifying a book from a spine label is what a viewer is for — so the gate
		// belongs on the FIELD, not the route. Without it a viewer, who is refused all
		// four of those routes, could walk `/api/books/ids` and rebuild the whole
		// active-loan roster name by name.
		openLoan: (await userHasPermission(c, 'circulation', { librarian: true }))
			? await c.env.DB.prepare(
				`SELECT t.id, t.borrower_name, t.due_at, t.item_id, t.renewal_count
				   FROM borrow_transactions t
				  WHERE t.returned_at IS NULL AND ${itemRow ? 't.item_id = ?' : 't.book_id = ?'}
				  ORDER BY t.borrowed_at ASC LIMIT 1`
			).bind(itemRow ? String(itemRow.id) : bookId).first()
			: null
	});
});

app.get('/api/rooms', async (c) => {
	// camelCase, like every other endpoint. This returned raw `SELECT *` rows —
	// map_metadata, created_at — which nothing consumed, so it was a trap waiting
	// for the first caller rather than a live bug. Book counts come along because
	// every caller wants them and the join is the same cost as the bare list.
	const rows = await c.env.DB.prepare(
		`SELECT r.id, r.code, r.name, r.description, r.map_metadata, r.created_at, r.updated_at,
		        COUNT(b.id) AS book_count
		   FROM rooms r
		   LEFT JOIN books b ON b.room_code = r.code AND b.deleted_at IS NULL
		  GROUP BY r.id, r.code, r.name, r.description, r.map_metadata, r.created_at, r.updated_at
		  ORDER BY r.code ASC`
	).all<Record<string, unknown>>();
	return c.json({
		items: (rows.results ?? []).map((r) => ({
			id: r.id,
			code: r.code,
			name: r.name,
			description: r.description,
			mapMetadata: safeJsonParse<Record<string, unknown>>((r.map_metadata as string) ?? '{}', {}),
			bookCount: Number(r.book_count ?? 0),
			createdAt: r.created_at,
			updatedAt: r.updated_at
		}))
	});
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

		// The residual bucket is "belongs to no room", NOT "room_code is blank".
		// A book whose room_code matches no rooms row used to fall into neither
		// this nor the per-room join, so the Library tab's tiles would silently
		// under-count. The foreign key makes that unreachable today — but FK
		// enforcement is a per-connection PRAGMA, so the two buckets should be a
		// true partition on their own terms rather than by relying on it.
		const unassigned = await c.env.DB.prepare(
			`SELECT
				COUNT(*) AS total_books,
				SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_books,
				SUM(CASE WHEN status = 'borrowed' THEN 1 ELSE 0 END) AS borrowed_books,
				SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS lost_books,
				SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) AS maintenance_books
			 FROM books b
			 WHERE b.deleted_at IS NULL
			   AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.code = b.room_code)`
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
		// The post-save refresh asks for this alongside the list and a facet, so it is
		// one of the writes a cataloguing session was spending per saved book.
		if (c.env.CACHE && !versionTooFreshToCache(cacheVersion)) {
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

	// Normalise EXACTLY as the book and item writers do. `normalizeBookData`
	// upper-cases every incoming roomCode, so a room stored verbatim as "a1"
	// could never be filed in: the book arrived as "A1", matched no rooms row,
	// and the foreign key threw a 500 — which the client retried four times.
	// The room was creatable, visible, and unusable.
	const code = normalizeCode(payload.code.trim());
	if (!code) throw new HTTPException(400, { message: 'Room code is required' });
	// The UNIQUE index would otherwise throw the same retried 500.
	const clash = await c.env.DB.prepare('SELECT id FROM rooms WHERE code = ?').bind(code).first();
	if (clash) throw new HTTPException(409, { message: `A room with code ${code} already exists.` });

	await c.env.DB.prepare(
		`INSERT INTO rooms (id, code, name, description, map_metadata, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(id, code, payload.name, payload.description ?? null, JSON.stringify(payload.mapMetadata), now, now)
		.run();

	await bumpBooksCacheVersion(c.env); // invalidate the version-keyed rooms/summary cache
	await insertAuditLog(c.env, c.get('user').sub, 'room.create', 'room', id, { code });

	return c.json({ id }, 201);
});

app.put('/api/rooms/:id', requirePermission('rooms.write', { librarian: true }), async (c) => {
	const id = c.req.param('id');
	const payload = UpsertRoomSchema.parse(await c.req.json());
	const now = nowIso();

	const existing = await c.env.DB.prepare('SELECT code FROM rooms WHERE id = ?')
		.bind(id).first<{ code: string }>();
	if (!existing) throw new HTTPException(404, { message: 'Room not found' });

	// `books.room_code` is a foreign key onto `rooms.code`, so renaming a room
	// whose books still point at the old code failed the constraint and surfaced
	// as an opaque 500 — which the web client then RETRIED four times, because it
	// treats any 5xx as worth repeating.
	//
	// A room code is a label, and renaming it plainly means "these books are now
	// in the room called X", so the books have to come along. The obvious order
	// does not work: SQLite's foreign keys are IMMEDIATE, so books can never
	// point at a code that does not exist yet, and the room can never be renamed
	// while books still point at the old one. `PRAGMA defer_foreign_keys` would
	// solve it but its behaviour inside a D1 batch is undocumented, and a
	// constraint that silently stops being enforced is a bad thing to depend on.
	//
	// So: create the new code first, move everything onto it, then retire the old
	// one. Every step is legal on its own, in any SQLite, with the constraint
	// fully armed throughout. The original row id is restored at the end because
	// the audit log references it.
	const nextCode = normalizeCode(payload.code.trim());
	if (!nextCode) throw new HTTPException(400, { message: 'Room code is required' });
	const statements: D1PreparedStatement[] = [];
	if (nextCode !== existing.code) {
		// Renaming onto a code another room already holds hits the same UNIQUE
		// index, so refuse it here rather than 500 halfway through the batch.
		const clash = await c.env.DB.prepare('SELECT id FROM rooms WHERE code = ? AND id <> ?')
			.bind(nextCode, id).first();
		if (clash) throw new HTTPException(409, { message: `A room with code ${nextCode} already exists.` });
		const tempId = newId('room');
		statements.push(
			c.env.DB.prepare(
				`INSERT INTO rooms (id, code, name, description, map_metadata, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			).bind(tempId, nextCode, payload.name, payload.description ?? null,
				JSON.stringify(payload.mapMetadata), now, now),
			c.env.DB.prepare('UPDATE books SET room_code = ?, updated_at = ? WHERE room_code = ?')
				.bind(nextCode, now, existing.code),
			// items.room_code carries no FK, but it must follow or the shelf
			// browser and the record would disagree about where the book is.
			c.env.DB.prepare('UPDATE items SET room_code = ?, updated_at = ? WHERE room_code = ?')
				.bind(nextCode, now, existing.code),
			c.env.DB.prepare('DELETE FROM rooms WHERE id = ?').bind(id),
			c.env.DB.prepare('UPDATE rooms SET id = ? WHERE id = ?').bind(id, tempId)
		);
	} else {
		statements.push(
			c.env.DB.prepare(
				`UPDATE rooms SET name = ?, description = ?, map_metadata = ?, updated_at = ? WHERE id = ?`
			).bind(payload.name, payload.description ?? null, JSON.stringify(payload.mapMetadata), now, id)
		);
	}
	await runAtomic(c.env, statements);

	await bumpBooksCacheVersion(c.env); // rooms/summary + list cache invalidation
	await insertAuditLog(c.env, c.get('user').sub, 'room.update', 'room', id ?? null, {
		code: nextCode,
		...(nextCode !== existing.code ? { renamedFrom: existing.code } : {})
	});

	return c.json({ id, code: nextCode, renamedFrom: nextCode !== existing.code ? existing.code : null });
});

app.delete('/api/rooms/:id', requirePermission('rooms.delete'), async (c) => {
	const id = c.req.param('id');

	// Refuse with a COUNT rather than letting the foreign key throw a 500 the
	// client will retry. Same shape as DELETE /api/borrowers/:id, which already
	// refuses while loans reference the borrower: the operator is told what is
	// in the way and can go and move it.
	const room = await c.env.DB.prepare('SELECT code FROM rooms WHERE id = ?').bind(id).first<{ code: string }>();
	if (!room) throw new HTTPException(404, { message: 'Room not found' });
	// Counts SOFT-DELETED books too. The foreign key does not know about
	// `deleted_at`, so a room whose only remaining reference is a book in the
	// trash still cannot be dropped — filtering them out here produced a guard
	// that passed and then let the constraint throw the 500 it exists to prevent.
	// COPIES TOO, not just books.
	//
	// `books.room_code` has a foreign key to rooms(code), which is what this guard was
	// written for. But migration 0021 moved the physical location onto `items` and
	// declared `items.room_code` with NO foreign key — so a copy in this room does not
	// stop the DELETE, and the room code it carries becomes a dangling reference the
	// database will never complain about. `syncBookFromItems` derives books.room_code
	// from the PRIMARY copy only, so a second copy shelved in this room is invisible
	// to the books count entirely: the room vanishes and that copy keeps pointing at a
	// code the rooms table no longer has.
	//
	// Both counts include soft-deleted rows, for the same reason the books count
	// already did — a reference from the trash is still a reference.
	// Counted as DISTINCT RECORDS, not as references. A book and its own primary copy
	// both carry the room code, so adding the two counts told the librarian two books
	// were in the way when they could see one on the screen. The number in a refusal
	// has to be the number they will go and move.
	const inUse = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n,
		        SUM(CASE WHEN live_ref = 1 THEN 1 ELSE 0 END) AS live
		   FROM (
		     SELECT b.id AS book_id, MAX(CASE WHEN b.deleted_at IS NULL THEN 1 ELSE 0 END) AS live_ref
		       FROM books b
		      WHERE b.room_code = ?
		         OR EXISTS (SELECT 1 FROM items i WHERE i.book_id = b.id AND i.room_code = ?)
		      GROUP BY b.id
		   )`
	).bind(room.code, room.code).first<{ n: number; live: number }>();
	const total = Number(inUse?.n ?? 0);
	const live = Number(inUse?.live ?? 0);
	if (total > 0) {
		throw new HTTPException(409, {
			message: live > 0
				? `Cannot delete: ${live} book(s) have a copy in this room. Move them to another room first.`
				: `Cannot delete: ${total} deleted book(s) still reference this room. Purge them from the trash first.`
		});
	}

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

	// `custom_field_definitions.field_key` is UNIQUE, and this INSERT had no
	// pre-check — so a key already in use came back out of D1 as the generic
	// `Internal server error`, which api.ts treats as retryable and sends four
	// more times. Every sibling create pre-checks its unique index for exactly
	// this reason (POST /api/rooms: "The UNIQUE index would otherwise throw the
	// same retried 500").
	//
	// The UNIQUE is on the column, not on `(field_key, deleted_at)`, so the
	// SOFT-DELETED definitions collide too — and that is the case worth handling
	// carefully, because it is the one the librarian cannot see. GET
	// /api/custom-fields filters `deleted_at IS NULL`, so a deleted attribute is
	// absent from the only list they have; retyping the key is then the obvious
	// thing to do, and it failed with an unexplained 500 forever, with no restore
	// path anywhere in the API to get out of it.
	//
	// So a buried definition is REVIVED rather than refused. The delete is soft
	// precisely so the values stay on the books, and asking for the key back is
	// asking for those values back — the librarian gets the attribute and its
	// history, which is what deleting-then-recreating was always trying to mean.
	//
	// Only when the TYPE matches. Reviving a `text` definition as a `number`
	// would leave every stored value the wrong type, which is the exact damage
	// the retype sweep on PUT exists to prevent, and this handler has no sweep.
	// A mismatch is refused with the buried type named, so the librarian can
	// recreate it as it was and retype it through the editor that converts.
	const clash = await c.env.DB.prepare(
		'SELECT id, field_type, deleted_at FROM custom_field_definitions WHERE field_key = ? LIMIT 1'
	).bind(payload.key).first<{ id: string; field_type: string; deleted_at: string | null }>();
	if (clash && !clash.deleted_at) {
		throw new HTTPException(409, {
			message: `An attribute with the key "${payload.key}" already exists. Edit that one, or choose another key.`
		});
	}
	if (clash && clash.deleted_at) {
		if (clash.field_type !== payload.type) {
			throw new HTTPException(409, {
				message: `The key "${payload.key}" belongs to a deleted attribute of type "${clash.field_type}", and books still hold values of that type. Recreate it as "${clash.field_type}" and then change the type from the attribute editor, which converts the stored values.`
			});
		}
		await c.env.DB.prepare(
			`UPDATE custom_field_definitions
			    SET deleted_at = NULL, label = ?, required = ?, enum_options = ?,
			        pinned = ?, sort_order = ?, updated_at = ?
			  WHERE id = ?`
		)
			.bind(
				payload.label, payload.required ? 1 : 0, JSON.stringify(payload.enumOptions),
				payload.pinned ? 1 : 0, payload.sortOrder ?? 0, now, clash.id
			)
			.run();
		await insertAuditLog(c.env, c.get('user').sub, 'customField.restore', 'custom_field', clash.id, {
			key: payload.key
		});
		// `restored` so the client can say so: the values already on the books
		// reappearing is a surprise if the librarian thinks they made a new field.
		return c.json({ id: clash.id, restored: true }, 200);
	}

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

	/*
	 * `?dryRun=1` answers "what would this cost me" and writes nothing.
	 *
	 * Changing an attribute's type DESTROYS every stored value that cannot be converted — the
	 * sweep below does `delete values[newKey]` — and there was no warning of any kind, no
	 * preview, and no count until afterwards. A librarian changing "Σελίδες" from text to number
	 * to make it sortable silently loses every extent recorded the way ISBD asks for it:
	 * "σ. 351-700", "156,[3]σ.", "χ.α." Narrowing an enum's options does the same to every book
	 * holding an option that was removed.
	 *
	 * This runs the identical scan and coercion the real call runs, on the same page window and
	 * the same write cap, so the preview describes exactly what one real call would do rather
	 * than a different code path that happens to look similar — the import's dry run did diverge
	 * like that, and told a librarian they were adding 1,200 records when it was about to update
	 * them.
	 */
	const dryRun = c.req.query('dryRun') === '1' || c.req.query('dryRun') === 'true';
	// What a real run would delete: enough to put it back by hand afterwards, capped so a
	// catalogue-wide retype cannot write a megabyte into an audit row.
	const LOST_SAMPLE_CAP = 200;
	const lost: Array<{ bookId: string; value: unknown }> = [];

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
					// Recorded before it is deleted. This is the only trace the value ever existed
					// once the JSON is rewritten, and it is what makes a mistaken retype
					// recoverable by hand rather than a shrug.
					if (lost.length < LOST_SAMPLE_CAP) lost.push({ bookId: row.id, value: current });
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

		// A preview writes nothing at all — not the books, not the definition below.
		if (!dryRun) {
			for (let i = 0; i < bookUpdates.length; i += D1_BATCH_LIMIT) {
				await runAtomic(c.env, bookUpdates.slice(i, i + D1_BATCH_LIMIT));
			}
		}
	}

	/*
	 * The losses are logged PER PAGE, not with the summary at the end.
	 *
	 * This sweep is paged, and each page is a separate HTTP request with its own `lost` array.
	 * The summary entry is written only on the page that completes the sweep, so recording the
	 * destroyed values there captured the LAST page's losses and silently dropped every earlier
	 * page's. Measured: a three-page retype destroyed three values and logged one.
	 */
	if (!dryRun && lost.length > 0) {
		await insertAuditLog(c.env, c.get('user').sub, 'customField.valuesDestroyed', 'custom_field', id, {
			key: payload.key,
			oldType: existing.field_type,
			type: payload.type,
			sweepOffset,
			count: lost.length,
			values: lost,
			truncated: lost.length >= LOST_SAMPLE_CAP
		});
	}

	if (dryRun) {
		return c.json({
			id,
			dryRun: true,
			// Same page window and same write cap as a real call, so these numbers are that
			// call's numbers. A caller loops on nextSweepOffset exactly as it would for real.
			sweepComplete,
			nextSweepOffset: sweepComplete ? null : sweepOffset + sweepScanned,
			scanned: sweepScanned,
			wouldRename: renamedBooks,
			wouldClearEnum: clearedEnumBooks,
			wouldRetype: retypedBooks,
			// The values that would be destroyed, with the record each one is on.
			wouldLose: lost.length,
			wouldLoseSamples: lost.slice(0, 20),
			wouldLoseTruncated: lost.length >= LOST_SAMPLE_CAP
		});
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
		oldType: existing.field_type,
		type: payload.type,
		renamedBooks,
		clearedEnumBooks,
		retypedBooks,
		// The destroyed values themselves are in the per-page `customField.valuesDestroyed`
		// entries, not here: this summary is written only by the page that finishes the sweep,
		// so anything recorded here would cover that page alone.
		lostValuesThisPage: lost.length
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
/**
 * Attach the subject headings a MARC record carried.
 *
 * `marcToBookFields` has always parsed every 650$a, with the thesaurus correctly
 * derived from ind2, and the import loop then never looked at the result — so the
 * single richest source of subject headings available to this library, records
 * sent by another library that already carry LCSH, arrived with no subjects at
 * all and left 628 headings to be typed by hand.
 *
 * Headings are matched on the folded preferred form so a heading that differs
 * only in accents or case is reused rather than duplicated, and existing links
 * are left alone: this adds, never replaces, so a heading a librarian attached
 * by hand survives a re-import.
 */
async function linkImportedSubjects(
	env: Env,
	bookId: string,
	terms: Array<{ term: string; source: string }> | undefined
): Promise<void> {
	if (!terms || terms.length === 0) return;
	const now = nowIso();
	const statements: D1PreparedStatement[] = [];
	let seq = 0;
	for (const { term, source } of terms) {
		const form = term.trim();
		if (!form) continue;
		const fold = foldDiacritics(form);
		const existing = await env.DB.prepare(
			"SELECT id FROM authorities WHERE kind = 'subject' AND preferred_form_fold = ? AND deleted_at IS NULL LIMIT 1"
		).bind(fold).first<{ id: string }>();
		let authorityId = existing?.id;
		if (!authorityId) {
			authorityId = newId('auth');
			statements.push(
				env.DB.prepare(
					`INSERT INTO authorities (id, kind, preferred_form, preferred_form_romanized, preferred_form_fold,
					                          source, viaf_id, lc_id, isni, dates, notes, created_at, updated_at)
					 VALUES (?, 'subject', ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
				).bind(authorityId, form, fold, source === 'lcsh' ? 'lcsh' : 'imported', now, now)
			);
		}
		statements.push(
			env.DB.prepare(
				`INSERT OR IGNORE INTO book_authorities (book_id, authority_id, role, seq, created_at)
				 VALUES (?, ?, 'sub', ?, ?)`
			).bind(bookId, authorityId, seq, now)
		);
		seq += 1;
	}
	if (statements.length > 0) await runAtomic(env, statements);
}

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
			// Only ever set when leader/07 says serial, so an ordinary record
			// cannot demote a title the librarian has already marked as one.
			...(f.bibLevel ? { bibLevel: f.bibLevel } : {}),
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

		// The match is looked up BEFORE the dry-run guard. It used to come after,
		// so a test run counted every record as new — a librarian testing a
		// re-send from a partner library was told they were about to add 1,200
		// records when the real run would have updated 1,200. Predicting the
		// wrong thing is worse than not offering to predict.
		// Every column the merge below needs is selected. It used to be `id, version` only,
		// while the fold computation read existing.publisher, existing.description and the
		// three romanized columns off this same row — all `undefined`, always, so the folds
		// silently described the incoming MARC record rather than the merged row. On a record
		// where the column was preserved and the fold was not, the two disagree, and the
		// folded columns are what Greek search actually matches on.
		const existing = payload.isbn
			? await c.env.DB.prepare(
				`SELECT id, version, author, isbn, publisher, language, description,
				        title_romanized, author_romanized, publisher_romanized
				   FROM books WHERE isbn = ? AND deleted_at IS NULL LIMIT 1`)
				.bind(payload.isbn).first<{
					id: string; version: number; author: string | null; isbn: string | null;
					publisher: string | null; language: string | null; description: string | null;
					title_romanized: string | null; author_romanized: string | null;
					publisher_romanized: string | null;
				}>()
			: null;

		// Validate the custom fields BEFORE the dry-run guard, so the prediction is
		// the outcome.
		//
		// The guard used to return first, and `validateCustomFields` ran only on the
		// real pass — so a record the import would REFUSE was counted as `created` in
		// the preview. The comment a few lines above explains why the match lookup was
		// deliberately moved ahead of this same guard ("predicting the wrong thing is
		// worse than not offering to predict"); the argument applies here and had not
		// been applied. It is a pure read of the definition cache, so it costs the dry
		// run nothing.
		try {
			await validateCustomFields(c.env, payload.customFields as Record<string, unknown>);
		} catch (error) {
			skipped += 1;
			problems.push(error instanceof Error ? error.message : 'a record has a custom field the catalogue rejects');
			continue;
		}

		if (dryRun) { if (existing) updated += 1; else created += 1; continue; }

		try {
			if (existing) {
				// Re-import updates in place. Only fields the record actually
				// carries are written — a MARC record that omits a field must not
				// blank what the librarian already catalogued by hand.
				const cf = await validateCustomFields(c.env, payload.customFields as Record<string, unknown>);
				// THE FOLDS GO WITH THE TEXT. This was the only UPDATE in the worker
				// that wrote title, author, publisher and description without their
				// `*_fold` columns — a script over every `UPDATE books SET` template
				// flags this statement and no other.
				//
				// It is not cosmetic. The books_fts triggers index
				// `COALESCE(new.title_fold, new.title, '')`, and COALESCE only falls
				// through when the fold is NULL — so a pre-existing, now stale fold
				// WINS. A record re-imported with a corrected title kept answering
				// searches under its old one, in the accent-and-case-folded matching
				// that is how this catalogue is actually searched in Greek.
				//
				// Computed from the POST-MERGE values, because several columns above
				// are COALESCE(?, col): the fold has to describe what the row will
				// hold, not what the MARC record happened to carry.
				/*
				 * A MARC record carries only what the sending library chose to send. 245$a is
				 * required and checked above, so the title is always real; everything else can
				 * legitimately be absent, and absent must mean "keep what we have".
				 *
				 * It did not. publisher, language and description were written UNCONDITIONALLY
				 * beside ddc, bib_level and the romanized trio which were COALESCEd — the same
				 * split policy in one statement that destroyed seven fields per record on the
				 * XLSX re-import. The comment directly above this block already stated the
				 * correct rule ("a MARC record that omits a field must not blank what the
				 * librarian already catalogued by hand"); the SQL contradicted it.
				 *
				 * The author needed its own flag rather than COALESCE. marcToBookFields yields
				 * `f.author ?? ''` for a record with no 100/110/700, so what arrives is an empty
				 * string, not NULL, and COALESCE would cheerfully write it over a hand-catalogued
				 * name. An author-less book in this catalogue is stored as '' or '(Unknown)'
				 * deliberately, so '' is a value some records really hold — but a MARC record
				 * cannot tell us "this book has no author", only "this record does not say".
				 */
				const marcGaveAuthor = (payload.author ?? '').trim() !== '';
				const mergedForFold = {
					title: payload.title,
					author: marcGaveAuthor ? payload.author : (existing.author ?? ''),
					isbn: existing.isbn ?? null,
					publisher: payload.publisher ?? existing.publisher ?? null,
					description: payload.description ?? existing.description ?? null,
					titleRomanized: payload.titleRomanized ?? existing.title_romanized ?? null,
					authorRomanized: payload.authorRomanized ?? existing.author_romanized ?? null,
					publisherRomanized: payload.publisherRomanized ?? existing.publisher_romanized ?? null
				};
				const reFolds = computeBookFolds(mergedForFold);
				await c.env.DB.prepare(
					`UPDATE books SET title = ?,
					        author = CASE WHEN ? THEN ? ELSE author END,
					        publisher = COALESCE(?, publisher),
					        language = COALESCE(?, language),
					        description = COALESCE(?, description),
					        ddc = COALESCE(?, ddc), bib_level = COALESCE(?, bib_level),
					        date_edtf = COALESCE(?, date_edtf),
					        publication_year = COALESCE(?, publication_year),
					        publication_year_end = COALESCE(?, publication_year_end),
					        title_romanized = COALESCE(?, title_romanized),
					        author_romanized = COALESCE(?, author_romanized),
					        publisher_romanized = COALESCE(?, publisher_romanized),
					        custom_fields = json_patch(custom_fields, ?),
					        title_fold = ?, author_fold = ?, publisher_fold = ?, description_fold = ?,
					        title_romanized_fold = ?, author_romanized_fold = ?, publisher_romanized_fold = ?,
					        updated_at = ?, version = version + 1
					  WHERE id = ?`
				).bind(
					payload.title,
					marcGaveAuthor ? 1 : 0, payload.author,
					payload.publisher ?? null, payload.language ?? null,
					payload.description ?? null, payload.ddc ?? null,
					(payload as { bibLevel?: string }).bibLevel ?? null, payload.dateEdtf ?? null,
					payload.publicationYear ?? null, payload.publicationYearEnd ?? null,
					payload.titleRomanized ?? null, payload.authorRomanized ?? null, payload.publisherRomanized ?? null,
					JSON.stringify(cf),
					reFolds.title_fold, reFolds.author_fold, reFolds.publisher_fold, reFolds.description_fold,
					reFolds.title_romanized_fold, reFolds.author_romanized_fold, reFolds.publisher_romanized_fold,
					now, existing.id
				).run();
				// Deliberately NOT ensurePrimaryItem here: it writes the passed
				// location onto the primary copy, and this payload carries none —
				// re-importing would blank the shelf the librarian assigned. MARC
				// 852 holdings import is its own job.
				// Also on an update: a partner library that added headings since the
				// last send should have them land here too. Nothing is removed —
				// this ADDS, so a heading the librarian attached by hand survives.
				await linkImportedSubjects(c.env, existing.id, f.subjectTerms);
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
					                    publisher, language, description, ddc, bib_level,
					                    title_romanized, author_romanized, publisher_romanized,
					                    tags, custom_fields, status, version, created_at, updated_at,
					                    title_fold, author_fold, isbn_fold, publisher_fold, description_fold,
					                    tags_fold, custom_fields_fold,
					                    title_romanized_fold, author_romanized_fold, publisher_romanized_fold,
					                    isbn_valid)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'available', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				).bind(
					id, payload.title, payload.author, payload.isbn ?? null,
					payload.publicationYear ?? null, payload.publicationYearEnd ?? null, payload.dateEdtf ?? null,
					payload.publisher ?? null, payload.language ?? null, payload.description ?? null, payload.ddc ?? null,
					(payload as { bibLevel?: string }).bibLevel ?? 'monograph',
					payload.titleRomanized ?? null, payload.authorRomanized ?? null, payload.publisherRomanized ?? null,
					cfJson, now, now,
					folds.title_fold, folds.author_fold, folds.isbn_fold, folds.publisher_fold,
					folds.description_fold, folds.tags_fold, folds.custom_fields_fold,
					folds.title_romanized_fold, folds.author_romanized_fold, folds.publisher_romanized_fold,
					folds.isbn_valid
				).run();
				// A new record needs a copy to exist at all, or it is invisible to
				// every location filter. Unshelved until someone places it.
				await ensurePrimaryItem(c.env, id, {});
				await linkImportedSubjects(c.env, id, f.subjectTerms);
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
		/*
		 * THE PREVIEW HAS TO SAY WHICH ROWS OVERWRITE SOMETHING.
		 *
		 * It reported one number, `acceptedRows`, so "about to add 1,200 books" and "about to
		 * overwrite 1,200 books" looked identical — and those are the two most different things
		 * this endpoint can do. Re-uploading a corrected sheet is the ordinary way the import is
		 * used, and it was, until this pass, the operation that destroyed seven fields on every
		 * record it matched. A preview of a destructive operation that cannot say what it will
		 * overwrite is not a preview.
		 *
		 * The same lookup and the same trash rule as the real loop below, so the prediction is
		 * that loop's behaviour rather than a second implementation that resembles it. It costs
		 * one indexed read per row — exactly what the real run pays — which is the honest price
		 * of an answer that is true.
		 */
		let wouldCreate = 0;
		let wouldUpdate = 0;
		for (const item of readyRows) {
			const legacyId = (item.row as { legacyId?: string | null }).legacyId?.trim() || null;
			if (!legacyId) { wouldCreate += 1; continue; }
			const match = await c.env.DB.prepare(
				'SELECT id, deleted_at FROM books WHERE legacy_id = ? LIMIT 1'
			).bind(legacyId).first<{ id: string; deleted_at: string | null } | null>();
			if (match?.deleted_at) {
				// The real run refuses these; the preview said they were fine.
				skippedRows.push({ index: item.index, reason: 'matching book is in the trash — restore it first' });
				continue;
			}
			if (match) wouldUpdate += 1;
			else wouldCreate += 1;
		}
		return c.json({
			dryRun: true,
			acceptedRows: wouldCreate + wouldUpdate,
			wouldCreate,
			wouldUpdate,
			skippedRows
		});
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
			// Read from the RAW row, not the normalized one: `reconcileBookDates`
			// mirrors a bare year into `dateEdtf`, so asking the normalized row
			// whether the sheet mentioned a date answers a different question.
			//
			// NULL COUNTS AS "NOT MENTIONED" HERE, and the first version of this got
			// it exactly wrong. It tested `!== undefined`, reasoning that an absent
			// spreadsheet column leaves the key absent — but the client builds every
			// row through an object literal that ALWAYS carries `publicationYear`,
			// initialised to null when no `publicationyear` header was found
			// (apps/web/src/main.tsx:1776 and :1838), and `CreateBookSchema` declares
			// it `.optional().nullable()` with no default so the explicit null
			// survives the parse. `!== undefined` was therefore true for every row
			// from every shipped client, the "leave all three alone" branch was dead
			// code, and the statement wrote NULL into all three columns.
			//
			// That was strictly worse than the bug it was meant to fix. Before it,
			// only `publication_year` was blanked while `date_edtf` and
			// `publication_year_end` were COALESCEd and survived — so the year could
			// still be recovered from the EDTF value on the next save. After it, one
			// re-upload of a sheet without that exact lowercase header took all three
			// at once, unrecoverably, on any of the 12,528 live records that carry a
			// legacy_id, 10,917 of which hold a date.
			//
			// So absence cannot be the signal: it is unobservable through the clients
			// that exist. The cost is that a date cannot be CLEARED through the
			// import, which this endpoint has never supported — clearing a wrong year
			// is what the book edit form is for. If it is ever wanted here it needs an
			// explicit marker in the payload, not the absence of a key.
			const rawDates = item.row as { publicationYear?: number | null; dateEdtf?: string | null };
			const sheetGaveDates = (rawDates.publicationYear ?? null) !== null
				|| (rawDates.dateEdtf ?? null) !== null;
			/*
			 * tags and customFields cannot use COALESCE like the scalars, because the client sends
			 * [] and {} rather than null for a column the sheet does not have — the value arriving
			 * is not NULL, so COALESCE would write the empty collection over the real one. An
			 * explicit flag is the only way to tell "this book has no tags" from "this spreadsheet
			 * has no tags column": one is a fact about the book, the other about the file.
			 */
			const rawTags = (item.row as { tags?: unknown }).tags;
			const sheetGaveTags = Array.isArray(rawTags) && rawTags.length > 0;
			const sheetGaveCustomFields = Object.keys(customFields ?? {}).length > 0;
			const sheetGaveIsbn = ((item.row as { isbn?: string | null }).isbn ?? null) !== null;
			const importTagsJson = JSON.stringify(row.tags);
			const importCustomFieldsJson = JSON.stringify(customFields);
			const importFolds = computeBookFolds({
				title: row.title,
				author: row.author,
				isbn: row.isbn ?? null,
				publisher: row.publisher ?? null,
				description: row.description ?? null,
				tagsJson: importTagsJson,
				customFieldsJson: importCustomFieldsJson,
				// The romanized forms fold too, or a romanized title is stored and
				// then cannot be searched for.
				titleRomanized: row.titleRomanized ?? null,
				authorRomanized: row.authorRomanized ?? null,
				publisherRomanized: row.publisherRomanized ?? null
			});
			if (existing) {
				// Status is deliberately NOT updated: the book's circulation state is
				// owned by the borrow/return flow, and a sheet saying 'available'
				// must not wipe out an open loan.
				await c.env.DB.prepare(
					// THE THREE DATE COLUMNS MOVE TOGETHER OR NOT AT ALL.
					//
					// `publication_year` was written unconditionally while its two
					// companions were COALESCEd, so a re-import from a sheet with no
					// year column — a sheet correcting shelf marks, say — blanked the
					// year and left `date_edtf` and `publication_year_end` standing.
					// Measured: a record at (1955, 1957, '1955/1957') came back as
					// (NULL, 1957, '1955/1957'), which is silent loss of the start year
					// AND a direct breach of the invariant `reconcileBookDates` states
					// in so many words — "the two representations can never drift
					// apart". They drifted in the one place that never called it twice.
					//
					// `reconcileBookDates` has already made the incoming three
					// consistent with each other, so the only question left is whether
					// the sheet said anything about dates at all. `sheetGaveDates` is
					// bound three times to answer it once: absent means leave all three,
					// an explicit null clears all three. That is the same contract the
					// reconciler itself documents for a partial update.
					/*
					 * NULL MEANS "THE SHEET DID NOT MENTION IT" FOR EVERY COLUMN, not just the
					 * three date ones.
					 *
					 * The date columns were fixed earlier today and the rest of this statement was
					 * left as it was, which turns out to have been half a fix. The client builds
					 * every import row through one object literal that ALWAYS carries author, isbn,
					 * publisher, language, description, roomCode, shelfCode, acquisitionDate, tags
					 * and customFields (apps/web/src/main.tsx), filling in null or an empty
					 * collection for any column the spreadsheet does not have. Ten of those were
					 * written unconditionally here, so they were overwritten with nothing.
					 *
					 * Measured on a real record: a corrective sheet carrying only title, legacyId
					 * and a fixed author silently destroyed SEVEN fields — publisher, language,
					 * description, shelf mark, acquisition date, every tag and every custom
					 * attribute value — and the import reported "1 updated" with no warning. On
					 * production 12,528 of 12,675 records carry a legacy_id, which is what this
					 * statement matches on, so one partial re-upload could do that to the whole
					 * catalogue. Re-uploading a corrected sheet is the ordinary way this import is
					 * used; the comment above the match lookup says so.
					 *
					 * COALESCE for the scalars, which is what ddc, bib_level and the three
					 * romanized columns beside them already did — the inconsistency inside one
					 * statement is the whole bug. tags and custom_fields need a flag rather than
					 * COALESCE because the client sends [] and {}, not null, and an empty
					 * collection is indistinguishable from an absent column.
					 *
					 * The cost is that this import cannot CLEAR a field, which it has never been
					 * able to do usefully and which the edit form does properly. A fold is
					 * COALESCEd with its own text so the two can never disagree — §68 asserts that.
					 */
					`UPDATE books SET
						title = ?,
						author = COALESCE(?, author),
						isbn = COALESCE(?, isbn),
						publisher = COALESCE(?, publisher),
						language = COALESCE(?, language),
						description = COALESCE(?, description),
						room_code = COALESCE(?, room_code),
						shelf_code = COALESCE(?, shelf_code),
						acquisition_date = COALESCE(?, acquisition_date),
						publication_year     = CASE WHEN ? THEN ? ELSE publication_year END,
						publication_year_end = CASE WHEN ? THEN ? ELSE publication_year_end END,
						date_edtf            = CASE WHEN ? THEN ? ELSE date_edtf END,
						ddc = COALESCE(?, ddc),
						bib_level = COALESCE(?, bib_level),
						title_romanized = COALESCE(?, title_romanized),
						author_romanized = COALESCE(?, author_romanized),
						publisher_romanized = COALESCE(?, publisher_romanized),
						tags = COALESCE(?, tags),
						custom_fields = COALESCE(?, custom_fields),
						updated_at = ?, version = version + 1,
						title_fold = ?,
						author_fold = COALESCE(?, author_fold),
						isbn_fold = COALESCE(?, isbn_fold),
						publisher_fold = COALESCE(?, publisher_fold),
						description_fold = COALESCE(?, description_fold),
						tags_fold = COALESCE(?, tags_fold),
						custom_fields_fold = COALESCE(?, custom_fields_fold),
						title_romanized_fold = COALESCE(?, title_romanized_fold),
						author_romanized_fold = COALESCE(?, author_romanized_fold),
						publisher_romanized_fold = COALESCE(?, publisher_romanized_fold),
						/* Follows isbn: preserving the ISBN while recomputing its validity from a
						   null would mark every untouched ISBN as broken. */
						isbn_valid = CASE WHEN ? THEN ? ELSE isbn_valid END
					 WHERE id = ? AND deleted_at IS NULL`
				)
					.bind(
						row.title,
						row.author ?? null,
						row.isbn ?? null,
						row.publisher ?? null,
						row.language ?? null,
						row.description ?? null,
						row.roomCode ?? null,
						row.shelfCode ?? null,
						row.acquisitionDate ?? null,
						sheetGaveDates ? 1 : 0, row.publicationYear ?? null,
						sheetGaveDates ? 1 : 0, row.publicationYearEnd ?? null,
						sheetGaveDates ? 1 : 0, row.dateEdtf ?? null,
						row.ddc ?? null,
						row.bibLevel ?? null,
						row.titleRomanized ?? null,
						row.authorRomanized ?? null,
						row.publisherRomanized ?? null,
						sheetGaveTags ? importTagsJson : null,
						sheetGaveCustomFields ? importCustomFieldsJson : null,
						now,
						importFolds.title_fold,
						importFolds.author_fold,
						importFolds.isbn_fold,
						importFolds.publisher_fold,
						importFolds.description_fold,
						// Each fold rides with its own text, or the pair desyncs and FTS keeps
						// answering under a value the record no longer has.
						sheetGaveTags ? importFolds.tags_fold : null,
						sheetGaveCustomFields ? importFolds.custom_fields_fold : null,
						importFolds.title_romanized_fold,
						importFolds.author_romanized_fold,
						importFolds.publisher_romanized_fold,
						sheetGaveIsbn ? 1 : 0, importFolds.isbn_valid,
						bookId
					)
					.run();
			} else {
				await c.env.DB.prepare(
					// The seven columns after acquisition_date were validated by
					// CreateBookSchema, normalised by normalizeBookData, reported to the
					// librarian as imported — and then not written. A sheet carrying an
					// EDTF date, a Dewey number, a serial marking or a romanized title
					// lost all of it silently, and the import said it had succeeded.
					`INSERT INTO books (
						id, title, author, isbn, publication_year, publisher, language, description,
						room_code, shelf_code, acquisition_date,
						publication_year_end, date_edtf, ddc, bib_level,
						title_romanized, author_romanized, publisher_romanized,
						tags, custom_fields, status, version,
						legacy_id, created_at, updated_at, deleted_at,
						title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold,
						title_romanized_fold, author_romanized_fold, publisher_romanized_fold, isbn_valid
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
						row.publicationYearEnd ?? null,
						row.dateEdtf ?? null,
						row.ddc ?? null,
						// NOT NULL DEFAULT 'monograph' (migration 0024). Omitting the column
						// let the default apply; naming it and binding null does not.
						row.bibLevel ?? 'monograph',
						row.titleRomanized ?? null,
						row.authorRomanized ?? null,
						row.publisherRomanized ?? null,
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
						importFolds.custom_fields_fold,
						importFolds.title_romanized_fold,
						importFolds.author_romanized_fold,
						importFolds.publisher_romanized_fold,
						importFolds.isbn_valid
					)
					.run();
			}

			/*
			 * SKIPPED ENTIRELY when the sheet said nothing about attributes.
			 *
			 * Custom attributes live in two places: the `books.custom_fields` JSON column and
			 * the `book_attribute_values` mirror table that the facets and attribute filters
			 * read. COALESCEing the JSON column above protected one of them and left the other
			 * exposed — `replaceBookAttributeValues` runs its DELETE whenever the incoming map
			 * is empty and the book is not new, so a corrective sheet still emptied the mirror.
			 *
			 * That is WORSE than the original bug in one respect: the two representations then
			 * disagree. Measured: the JSON column kept {"condition":"good","pages":"420"} while
			 * the mirror table went to 0 rows, so the record still showed its attributes and
			 * every facet and filter had lost them.
			 *
			 * If the sheet carried no attribute columns there is nothing to write, so the right
			 * move is to touch neither place. `customDefs` is the list this handler already
			 * loaded before the row loop — passing it stops the writer re-reading the
			 * definitions once per row, which is what its own comment claimed it had stopped.
			 */
			if (sheetGaveCustomFields || !existing) {
				await replaceBookAttributeValues(c.env, bookId, customFields, {
					defs: customDefs,
					isNewBook: !existing
				});
			}
			// A NEW record needs a copy to exist at all.
			//
			// Every other creation path calls this — POST /api/books, the offline
			// sync's create_book, the MARCXML import, whose comment says it plainly:
			// "a new record needs a copy to exist at all, or it is invisible to every
			// location filter". The spreadsheet import did not, so it wrote
			// `books.shelf_code` from the sheet and created ZERO copies: the shelf was
			// recorded and unreachable, the record missing from every location facet,
			// from the room summary and from the copies layer that is supposed to be
			// the source of truth for where a volume is.
			//
			// INSERT ONLY. On a re-import `ensurePrimaryItem` would overwrite the
			// primary copy's shelf with the sheet's, discarding a location the
			// librarian may have corrected on the copy itself since.
			if (!existing) {
				await ensurePrimaryItem(c.env, bookId, {
					shelfCode: row.shelfCode ?? null,
					roomCode: row.roomCode ?? null
				});
			}
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
  const [itemsByBook, extras, holdingsByBook] = await Promise.all([
    loadItemsForBooks(env, ids),
    loadMarcExtrasForBooks(env, ids),
    loadSerialHoldingsForBooks(env, ids)
  ]);
  return rows.map((row) => {
    const id = String(row.id);
    const extra = extras.get(id);
    return {
      row,
      input: bookRowToMarcInput(row, {
        // BARCODES STRIPPED. Every caller of this function is one of the two PUBLIC
        // endpoints — SRU searchRetrieve, OAI-PMH GetRecord and ListRecords — and both
        // modules state in their own headers that they "expose bibliographic records
        // ONLY — never borrowers, loans, staff or holdings barcodes". They did expose
        // them: 852 $p carried every copy's barcode to any anonymous caller, and a
        // barcode is the token that identifies a physical volume at the desk. Every
        // other route in this worker requires a session to see one.
        //
        // The AUTHENTICATED exports do not come through here — /api/books/:id/marc and
        // /api/export/books.marcxml build their input directly — so a librarian
        // exporting for a partner library still gets $p, which is where a barcode
        // legitimately belongs.
        items: (itemsByBook.get(id) ?? []).map((it) => ({ ...it, barcode: null })),
        contributors: extra?.contributors,
        subjects: extra?.subjects,
        seriesTitle: extra?.seriesTitle,
        serialHoldings: holdingsByBook.get(id) ?? [],
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
	// A RELATION THIS SERVER DOES NOT IMPLEMENT IS REFUSED, not silently downgraded.
	//
	// parseCql accepts =, ==, any, all and exact and records `term.relation`, and the
	// handler never read it: every query ran as qMode 'all' with partial words. So
	// `dc.title exact "Η ΘΕΙΑ ΛΕΙΤΟΥΡΓΙΑ"` returned every partial match and called it
	// an exact search. protocols.ts states the governing rule — implementing a
	// fraction and ignoring the rest is worse than not accepting it, because the
	// caller gets results that do not answer their query and cannot tell. Diagnostic
	// 19 is "unsupported relation".
	const SUPPORTED_RELATIONS = new Set(['=', '==', 'all']);
	const badRelation = parsed.terms.find((t) => t.relation && !SUPPORTED_RELATIONS.has(t.relation));
	if (badRelation) {
		return c.body(
			sruDiagnostic('19', badRelation.relation ?? '', 'Unsupported relation'),
			200, { 'Content-Type': 'application/xml; charset=utf-8' });
	}
	// Same rule for recordPacking: the response hard-codes <recordPacking>xml</>, so
	// a caller asking for `string` was answered in a packing it did not request.
	const wantPacking = q('recordPacking');
	if (wantPacking && wantPacking !== 'xml') {
		return c.body(
			sruDiagnostic('71', wantPacking, 'Unsupported record packing'),
			200, { 'Content-Type': 'application/xml; charset=utf-8' });
	}

	for (const term of parsed.terms) {
		if (term.index === 'date') { const n = Number(term.value); if (Number.isInteger(n)) year = n; continue; }
		if (term.index === 'language') {
			// The explain record advertises dc.language, and the DC output maps the
			// stored value through toIso639_2 ("EL" -> "gre"). The filter matched the
			// raw stored column, so a caller searching for the value this server
			// PUBLISHED found nothing. Accept either vocabulary.
			language = fromIso639_2([term.value]) || term.value;
			continue;
		}
		if (term.index === 'identifier') {
			// Likewise: identifiers go out as urn:isbn:… / urn:issn:… / the record
			// UUID, and came in matched against the bare `isbn` field. Strip the URN
			// the server itself minted before searching for it.
			words.push(term.value.replace(/^urn:(isbn|issn):/i, ''));
			searchFields.add('isbn');
			continue;
		}
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
		// The ABSOLUTE offset SRU asked for. `startRecord` is a position in the result
		// set, not a page: converting it to a page number discarded the remainder, so
		// startRecord=7 with maximumRecords=10 returned records 1-10 while the
		// response's <recordPosition> elements counted 7, 8, 9… The window and its
		// labels disagreed, and a harvester paging by an arbitrary offset silently
		// re-read the same records.
		page: 1,
		offset: startRecord - 1,
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
		return xml(oaiError(requestUrl, 'noSetHierarchy', 'This repository has no sets', responseDate,
			{ verb }));
	}

	if (verb === 'GetRecord') {
		const prefix = q('metadataPrefix');
		const ident = q('identifier');
		if (!['oai_dc', 'marcxml'].includes(prefix)) {
			return xml(oaiError(requestUrl, 'cannotDisseminateFormat', `Unknown metadataPrefix "${prefix}"`, responseDate,
				{ verb, args: { metadataPrefix: prefix, identifier: ident } }));
		}
		const bookId = parseOaiIdentifier(ident);
		if (!bookId) return xml(oaiError(requestUrl, 'idDoesNotExist', 'Malformed identifier', responseDate,
			{ verb, args: { metadataPrefix: prefix, identifier: ident } }));
		const row = await c.env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(bookId).first();
		if (!row) return xml(oaiError(requestUrl, 'idDoesNotExist', 'No such record', responseDate,
			{ verb, args: { metadataPrefix: prefix, identifier: ident } }));

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
		// `offset` is now only the count of records already delivered, for the
		// spec's `cursor` attribute. Paging position lives in `resumeAfter`.
		let offset = 0;
		let resumeAfter: { updatedAt: string; id: string } | null = null;
		let legacyOffset: number | undefined;
		let knownTotal: number | undefined;
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
			if (!state) return xml(oaiError(requestUrl, 'badResumptionToken', 'Token is not valid', responseDate,
				{ verb, args: { resumptionToken: token } }));
			prefix = state.prefix;
			offset = state.delivered;
			resumeAfter = state.lastUpdatedAt
				? { updatedAt: state.lastUpdatedAt, id: state.lastId ?? '' }
				: null;
			legacyOffset = resumeAfter ? undefined : state.offset;
			knownTotal = state.total;
			from = state.from; until = state.until;
		} else if (!['oai_dc', 'marcxml'].includes(prefix)) {
			return xml(oaiError(requestUrl, 'cannotDisseminateFormat', `Unknown metadataPrefix "${prefix}"`, responseDate,
				{ verb, args: { metadataPrefix: prefix, from, until } }));
		}

		// `set` was read only as a forbidden companion to resumptionToken, and
		// otherwise ignored — so a harvester asking for one set received the whole
		// catalogue and had no way to tell. ListSets already answers noSetHierarchy;
		// the two halves of the repository disagreed. The spec requires this error
		// when a repository without sets is given a `set` argument.
		if (!token && url.searchParams.has('set')) {
			return xml(oaiError(requestUrl, 'noSetHierarchy', 'This repository has no set hierarchy', responseDate,
				{ verb, args: { metadataPrefix: prefix, set: url.searchParams.get('set') ?? undefined } }));
		}

		// Day granularity is REQUIRED by the spec and `until` is inclusive. Both
		// bounds went into a string comparison against a millisecond timestamp, so a
		// bare date in `until` excluded the whole day it named.
		let fromBound: string | undefined;
		let untilBound: string | undefined;
		if (from !== undefined) {
			const g = oaiGranularity(from);
			const n = g ? normalizeOaiBound(from, 'from') : null;
			if (!n) return xml(oaiError(requestUrl, 'badArgument', `"from" is not a valid UTCdatetime: ${from}`, responseDate));
			fromBound = n;
		}
		if (until !== undefined) {
			const g = oaiGranularity(until);
			const n = g ? normalizeOaiBound(until, 'until') : null;
			if (!n) return xml(oaiError(requestUrl, 'badArgument', `"until" is not a valid UTCdatetime: ${until}`, responseDate));
			untilBound = n;
		}
		// The spec: "Both arguments must have the same granularity."
		if (from !== undefined && until !== undefined && oaiGranularity(from) !== oaiGranularity(until)) {
			return xml(oaiError(requestUrl, 'badArgument', '"from" and "until" must have the same granularity', responseDate));
		}
		if (fromBound && untilBound && untilBound < fromBound) {
			return xml(oaiError(requestUrl, 'badArgument', '"until" must not precede "from"', responseDate));
		}

		const page = await loadOaiPage(c.env, {
			from: fromBound, until: untilBound, limit: HARVEST_PAGE_SIZE,
			after: resumeAfter, offset: legacyOffset,
			// Counted once per harvest, not once per page. completeListSize does not
			// change during a walk, and recomputing it on all ~199 pages read roughly
			// four million rows for one number — most of a day's free-tier allowance,
			// spent by an unauthenticated endpoint on its own bookkeeping.
			knownTotal: knownTotal
		});
		if (page.rows.length === 0) {
			return xml(oaiError(requestUrl, 'noRecordsMatch', 'No records in that range', responseDate,
				{ verb, args: { metadataPrefix: prefix, from, until } }));
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

		const delivered = offset + page.rows.length;
		const more = delivered < page.total;
		// The next token carries the LAST ROW HANDED OUT, so the following page
		// resumes strictly after it however much the catalogue changes in between.
		// `cursor` still counts delivered records, which is all the spec asks of it.
		const lastRow = page.rows[page.rows.length - 1];
		const resumption = more
			? `  <resumptionToken completeListSize="${page.total}" cursor="${offset}">`
				+ xmlEscape(encodeResumptionToken({
					delivered,
					lastUpdatedAt: String(lastRow?.updatedAt ?? ''),
					lastId: String(lastRow?.id ?? ''),
					total: page.total,
					from, until, prefix
				}))
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
	// Same ceiling as the CSV export, and reaching it is reported in-band rather
	// than silently — for the same reason a truncated exchange file that looks
	// complete is the worst kind of failure: the receiving library cannot tell.
	//
	// This export used to page with OFFSET, and got that wrong twice. It asked
	// for pages of 200 from a query builder that clamps at 100, so "a short page
	// means we are done" fired on the first page and the whole catalogue came out
	// as 100 records inside a properly-closed <collection>. Fixing the page size
	// then exposed the deeper problem, which is that OFFSET paging cannot be used
	// here at all — see the id resolution below.
	const EXPORT_ROW_LIMIT = 20_000;

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			const write = (s: string) => controller.enqueue(enc.encode(s));
			write(format === 'json' ? '[\n' : MARCXML_COLLECTION_OPEN + '\n');
			let first = true;
			let written = 0;
			try {
				// Resolve every id in ONE query, then read the rows BY ID — the same
				// change /api/export/books.csv already made, for the same two reasons.
				//
				// Correctness first: this used to walk page=1,2,3… ordered by
				// `updated_at DESC`, a value 2,357 groups of records in this catalogue
				// share. OFFSET paging over a sort key with ties gives no stable order
				// between statements, so the stream emitted some records twice and
				// dropped others — measured at three duplicates in 12,616 — and the
				// resulting file is the right length and looks complete. A peer library
				// importing it silently gets a duplicate and a hole.
				//
				// Cost second: OFFSET makes SQLite re-scan and discard every row before
				// the offset, so a 12.6K export cost ~800K row reads and grew with the
				// SQUARE of the catalogue. By id it is linear.
				const idResult = await queryBooksWithFilters(c.env, {
					sortBy: 'updatedAt', sortDir: 'desc',
					page: 1, pageSize: 1,
					customFilters: [],
					includeDeleted: false,
					idsOnly: true,
					idsLimit: EXPORT_ROW_LIMIT,
					skipCount: true
				});
				const exportIds = (
					idResult.ids ?? (idResult.rows as Array<Record<string, unknown>>).map((r) => String(r.id ?? ''))
				).filter(Boolean);
				if (exportIds.length >= EXPORT_ROW_LIMIT) {
					// Never drop records without saying so. A harvester ignores an XML
					// comment, but the librarian who opens the file can see it.
					if (format !== 'json') write(`  <!-- truncated at ${EXPORT_ROW_LIMIT} records -->\n`);
					console.warn(`MARC export truncated at ${EXPORT_ROW_LIMIT} records`);
				}

				// D1 allows 100 bound parameters per statement, so 90 ids each.
				const IDS_PER_STATEMENT = 90;
				for (let i = 0; i < exportIds.length; i += IDS_PER_STATEMENT) {
					const slice = exportIds.slice(i, i + IDS_PER_STATEMENT);
					const placeholders = slice.map(() => '?').join(',');
					const res = await c.env.DB.prepare(
						`SELECT * FROM books WHERE id IN (${placeholders}) AND deleted_at IS NULL`
					).bind(...slice).all<Record<string, unknown>>();
					const rows = (res.results ?? []).map((r) => parseBook(r));
					// `IN (...)` does not preserve the requested order.
					const order = new Map(slice.map((v, n) => [v, n]));
					rows.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));

					const ids = rows.map((r) => String(r.id));
					const [itemsByBook, extras, holdingsByBook] = await Promise.all([
						loadItemsForBooks(c.env, ids),
						loadMarcExtrasForBooks(c.env, ids),
						loadSerialHoldingsForBooks(c.env, ids)
					]);
					for (const row of rows) {
						const bookId = String(row.id);
						const extra = extras.get(bookId);
						const input = bookRowToMarcInput(row as Record<string, unknown>, {
							items: itemsByBook.get(bookId) ?? [],
							contributors: extra?.contributors,
							subjects: extra?.subjects,
							seriesTitle: extra?.seriesTitle,
							serialHoldings: holdingsByBook.get(bookId) ?? [],
							isil
						});
						if (format === 'json') {
							write((first ? '' : ',\n') + JSON.stringify(toMarcJson(input)));
						} else {
							write(toMarcXml(input) + '\n');
						}
						first = false;
						written += 1;
					}
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
	const [items, extras, holdings] = await Promise.all([
		loadBookItems(c.env, id),
		loadMarcExtrasForBooks(c.env, [id]),
		loadSerialHoldings(c.env, id)
	]);
	const extra = extras.get(id);
	const input = bookRowToMarcInput(parseBook(row as Record<string, unknown>), {
		items, contributors: extra?.contributors, subjects: extra?.subjects,
		seriesTitle: extra?.seriesTitle, serialHoldings: holdings, isil: settings.isil ?? null
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
	/*
	 * Each of the twenty default columns is resolved to the attribute it actually names.
	 *
	 * DEFAULT_BOOK_STRUCTURE spells its keys in camelCase ('coverType', 'placeOfPublication',
	 * 'numVolume') while the definitions this catalogue really holds are snake_case
	 * ('cover_type', 'place_of_publication', 'volume_num'). The old code compared the two
	 * directly, so every such attribute failed the "already known" test and was appended a
	 * SECOND time under its raw key — and the first column, reading customFields['coverType'],
	 * was empty on every row of the file. Six pairs of columns, one of each pair always blank,
	 * in the file this library keeps as its backup.
	 *
	 * findSimilarCustomField is the matching the import side already uses, so the header a
	 * record leaves under is the header it comes back through.
	 */
	const defs = await loadCustomFieldDefs(c.env);
	// Falling back to the key as the label matters: findSimilarCustomField skips any entry with
	// no label, so an unlabelled definition would match nothing and be duplicated again.
	const defRefs: ExistingCustomFieldRef[] = defs.map((def) => ({
		field_key: def.field_key,
		label: def.label || def.field_key
	}));
	const resolvedCustomKey = new Map<string, string>();
	for (const column of DEFAULT_BOOK_STRUCTURE) {
		if (!column.customKey) continue;
		const match = findSimilarCustomField(defRefs, column);
		resolvedCustomKey.set(column.customKey, match?.field_key ?? column.customKey);
	}
	const knownCustomKeys = new Set(resolvedCustomKey.values());
	const extraCustomColumns: DefaultBookStructureColumn[] = defs
		.filter((def) => !knownCustomKeys.has(def.field_key))
		.map((def) => ({ label: def.label || def.field_key, customKey: def.field_key }));

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
				// Read through the resolved key, so 'Cover Type' carries what cover_type holds.
				shaped[column.label] = customFields[resolvedCustomKey.get(column.customKey) ?? column.customKey] ?? null;
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

// The cursor is (updated_at, id), not updated_at alone.
//
// `updated_at` is NOT unique here and not nearly unique: the spreadsheet import
// wrote thousands of records inside the same millisecond, and 12,145 of the 12,555
// live records share their timestamp with at least one other — the largest tie
// group is 186. A cursor of `updated_at > last_seen` therefore steps over every
// remaining row that shares the last row's timestamp, and a full sync delivered
// 12,225 of 12,555 records: 330 books that no offline client could ever receive,
// with the sync reporting success. Measured, not theorised.
//
// Adding `id` as a tiebreak makes the sort key a total order, so the keyset
// comparison can express "strictly after this exact row" and no row can fall in a
// gap between pages. `since` stays accepted alone so an existing client keeps
// working; it simply starts from the beginning of that timestamp's group.
app.get('/api/sync/pull', async (c) => {
	const since = c.req.query('since') ?? '1970-01-01T00:00:00.000Z';
	const sinceId = c.req.query('sinceId') ?? '';
	const rows = await c.env.DB.prepare(
		`SELECT * FROM books
		  WHERE deleted_at IS NULL
		    AND (updated_at > ? OR (updated_at = ? AND id > ?))
		  ORDER BY updated_at ASC, id ASC
		  LIMIT 1000`
	)
		.bind(since, since, sinceId)
		.all();

	const items = (rows.results ?? []).map((row) => parseBook(row as Record<string, unknown>));
	const last = items[items.length - 1];
	const nextCursor = last ? (last.updatedAt as string) : since;
	const nextCursorId = last ? (last.id as string) : sinceId;

	// `nextCursor` keeps its meaning for an old client; `nextCursorId` is what makes
	// the next page exact. A client that ignores it re-reads at most one timestamp
	// group instead of skipping one.
	return c.json({ since, sinceId, nextCursor, nextCursorId, items });
});

app.post('/api/sync/push', requirePermission('books.write', { librarian: true }), async (c) => {
	const payload = SyncPushSchema.parse(await c.req.json());
	const actor = c.get('user');

	const results: Array<Record<string, unknown>> = [];

	const embedUpsertIds = new Set<string>();
	const embedDeleteIds = new Set<string>();

	// Once for up to 200 mutations, for the same reason both imports do it: the
	// attribute writer read this table per book, so a full offline queue spent 200
	// D1 subrequests re-answering one question.
	const syncCustomDefs = await loadCustomFieldDefs(c.env);

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
				const customFields = validateCustomFieldsAgainst(syncCustomDefs, row.customFields);
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
				/*
				 * The same collision guard the direct create runs. `legacy_id` carries a UNIQUE
				 * index (migration 0005), so a sync that pushed an accession number already in the
				 * catalogue would come back as a raw constraint error — a 500 the client treats as
				 * transient and retries four times — instead of a sentence naming the clash.
				 */
				await assertLegacyIdFree(c.env, (row as { legacyId?: string | null }).legacyId ?? null, null);
				await c.env.DB.prepare(
					/*
					 * COLUMN FOR COLUMN with POST /api/books. `bib_level` and `legacy_id` were
					 * missing from this list and only from this list — two statements that have
					 * to stay identical, drifting apart quietly, which is the shape behind every
					 * import bug fixed in this pass.
					 *
					 * Neither omission errors, which is why it went unnoticed: bib_level is NOT
					 * NULL DEFAULT 'monograph' so the row takes the default, and legacy_id is
					 * nullable. The loss is silent — a serial created offline came back a
					 * monograph, and a book carrying its accession number from the source
					 * spreadsheet arrived with none, so a later re-import of that spreadsheet
					 * could not match it and would add a second copy of the record.
					 *
					 * Not reachable today: nothing in the shipped clients enqueues a create
					 * (the mobile queueCreateBook has no caller; the web's bulk push is typed to
					 * update and delete). Fixed anyway, because the day an add-book screen lands
					 * on the mobile client this is a data-loss bug that nobody will think to look
					 * for — and a one-line divergence is cheaper to close than to diagnose.
					 */
					`INSERT OR IGNORE INTO books (
						id, title, author, isbn, publication_year, publication_year_end, date_edtf,
						publisher, language, description, ddc, bib_level,
						title_romanized, author_romanized, publisher_romanized,
						room_code, shelf_code, acquisition_date, tags, custom_fields, status, version,
						legacy_id, created_at, updated_at, deleted_at,
						title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold,
						title_romanized_fold, author_romanized_fold, publisher_romanized_fold, isbn_valid
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
						// Was omitted entirely, so an offline-created serial came back a monograph.
						(row as { bibLevel?: string }).bibLevel ?? 'monograph',
						row.titleRomanized ?? null,
						row.authorRomanized ?? null,
						row.publisherRomanized ?? null,
						row.roomCode ?? null,
						row.shelfCode ?? null,
						row.acquisitionDate ?? null,
						tagsJson,
						customFieldsJson,
						row.status,
						// Likewise: without it a book keeps no link to the row it came from in the
						// source spreadsheet, so a later re-import of that sheet cannot match it and
						// adds a second copy of the record instead of updating it.
						(row as { legacyId?: string | null }).legacyId ?? null,
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
						folds.publisher_romanized_fold,
						folds.isbn_valid
					)
					.run();
				// Definitions passed, but NOT `isNewBook`: the id is deterministic from
				// the client mutation id with an INSERT OR IGNORE behind it, so a
				// retry writes to a row that may already carry attribute values.
				await replaceBookAttributeValues(c.env, id, customFields, { defs: syncCustomDefs });
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
						 title_romanized_fold = ?, author_romanized_fold = ?, publisher_romanized_fold = ?, isbn_valid = ?
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
						mergedFolds.isbn_valid,
						row.id,
						// Same check-then-act guard as the direct PUT: the write only
						// lands if the row is still at the version we read.
						currentVersion
					)
					.run();
				if ((syncUpd.meta?.changes ?? 0) === 0) {
					throw new HTTPException(409, { message: 'Version conflict' });
				}

				await replaceBookAttributeValues(c.env, row.id, merged.customFields as Record<string, unknown>, {
					defs: syncCustomDefs
				});
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
				// The guard has to be the SAME guard the direct endpoint uses, and it
				// was not. The comment above says "same rule as the direct endpoint",
				// and `lendable` and `loanDays` are indeed applied — but this guard was
				// missing two of the three refusals, so a mutation queued offline
				// bypassed them entirely:
				//
				//   · the LOAN CAP. maxConcurrentLoans was resolved and never used, so
				//     an offline borrow lent past the reader's limit.
				//   · the READY-HOLD check. A copy set aside on the hold shelf for a
				//     named reader could be lent to whoever queued a borrow offline.
				//
				// And it read `syncBorrow[1]` — the copy UPDATE — to decide whether a
				// loan happened, while that UPDATE carried none of the guard. That is
				// the same half-apply the direct endpoint had: refused borrow, copy
				// marked 'borrowed', no ledger row, 201 to the client. Fixed the same
				// way: the UPDATE fires only if the INSERT landed, and the INSERT's own
				// row count is what decides.
				const syncCapClause = syncPolicy.maxConcurrentLoans != null && borrowerId
					? ` AND (SELECT COUNT(*) FROM borrow_transactions t2
					          WHERE t2.borrower_id = ? AND t2.returned_at IS NULL) < ?`
					: '';
				const syncGuard = `(SELECT 1 FROM items i
					 WHERE i.id = ? AND i.deleted_at IS NULL AND i.status = 'available'
					   AND NOT EXISTS (SELECT 1 FROM borrow_transactions t
					                    WHERE t.item_id = i.id AND t.returned_at IS NULL)
					   AND NOT EXISTS (SELECT 1 FROM holds h
					                    WHERE h.item_id = i.id AND h.status = 'ready'
					                      AND (h.borrower_id IS NULL OR h.borrower_id <> ?))${syncCapClause})`;
				const syncBorrow = await runAtomic(c.env, [
					c.env.DB.prepare(
						`INSERT INTO borrow_transactions (
							 id, book_id, item_id, borrower_id, borrower_name, borrower_contact, borrowed_at, due_at, returned_at, notes, created_by, updated_at
						 )
						 SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
						 WHERE EXISTS ${syncGuard}`
					).bind(
						txId, row.id, syncItem.id, borrowerId, borrowerName, borrowerContact,
						now, syncDueAt, row.data.notes ?? null, actor.sub, now,
						syncItem.id, borrowerId,
						...(syncCapClause ? [borrowerId, syncPolicy.maxConcurrentLoans] : [])
					),
					c.env.DB.prepare(
						`UPDATE items SET status = 'borrowed', version = version + 1, updated_at = ?
						 WHERE id = ? AND deleted_at IS NULL AND status = 'available'
						   AND EXISTS (SELECT 1 FROM borrow_transactions WHERE id = ?)`
					).bind(now, syncItem.id, txId),
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
				// The INSERT, not the UPDATE: it is the statement carrying the guard.
				if ((syncBorrow[0]?.meta?.changes ?? 0) === 0) {
					if (syncPolicy.maxConcurrentLoans != null && borrowerId) {
						const openNow = await countOpenLoansFor(c.env, borrowerId);
						if (openNow >= syncPolicy.maxConcurrentLoans) {
							throw new HTTPException(409, {
								message: `${borrowerName} already has ${openNow} item(s) on loan (limit ${syncPolicy.maxConcurrentLoans}).`
							});
						}
					}
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

	// The romanized columns are selected for TWO reasons, and both were missing:
	// `normalizeBookData` NFC-normalizes them (Open Library returns ALA-LC
	// DECOMPOSED — "ē" as e + U+0304 — which never compares equal to its
	// composed twin), and their folds have to be rebuilt in lock-step like every
	// other pair.
	/*
	 * KEYSET on id, not OFFSET, and `version` is selected because the UPDATE below matches on it.
	 *
	 * Ids are random UUIDs, so a book catalogued while this sweep is running lands at an arbitrary
	 * position in the id order — including before the current offset. Every row after it then
	 * shifts by one and the next page steps clean over a row that was never processed, while the
	 * response reports "processed 500" and the operator has no way to know. The same OFFSET-walk
	 * hazard was already fixed in the CSV export and the sync cursor here; the attribute sweep's
	 * comment still claims the window "stays stable across calls" because it considered only this
	 * sweep's own writes and not a concurrent insert.
	 *
	 * `offset` is still honoured when no cursor is given, so an operator loop already written
	 * against it keeps working; `nextAfterId` in the response is what a caller should follow.
	 */
	const afterId = c.req.query('afterId') ?? '';
	const rows = await c.env.DB.prepare(
		`SELECT id, version, title, author, isbn, publisher, language, description,
		        room_code, shelf_code, acquisition_date, tags, custom_fields,
		        title_romanized, author_romanized, publisher_romanized,
		        title_fold, author_fold, isbn_fold, publisher_fold,
		        description_fold, tags_fold, custom_fields_fold,
		        title_romanized_fold, author_romanized_fold, publisher_romanized_fold, isbn_valid
		 FROM books WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT ? OFFSET ?`
	).bind(afterId, limit, afterId ? 0 : offset).all<Record<string, unknown>>();

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
			customFields: safeJsonParse<Record<string, unknown>>((row.custom_fields as string) ?? '{}', {}),
			titleRomanized: row.title_romanized as string | null,
			authorRomanized: row.author_romanized as string | null,
			publisherRomanized: row.publisher_romanized as string | null
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
			JSON.stringify(n.customFields) !== JSON.stringify(original.customFields) ||
			// A decomposed romanized form differs from its composed twin byte-wise
			// but not visually, so this is the only thing that can detect it.
			n.titleRomanized !== original.titleRomanized ||
			n.authorRomanized !== original.authorRomanized ||
			n.publisherRomanized !== original.publisherRomanized;

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
			(row.custom_fields_fold == null && Object.keys(n.customFields ?? {}).length > 0) ||
			(row.title_romanized_fold == null && (n.titleRomanized ?? '') !== '') ||
			(row.author_romanized_fold == null && (n.authorRomanized ?? '') !== '') ||
			(row.publisher_romanized_fold == null && (n.publisherRomanized ?? '') !== '');

		// `isbn_valid` gets the same treatment, and needs it more: migration 0034
		// replaced a GENERATED column with a stored one and could not compute the
		// value in SQL — that impossibility is why the column changed — so it
		// marked every row that has an ISBN as 0 and left the answer to this pass.
		// Without its own trigger, a row whose text is already clean is never
		// rewritten, and 563 perfectly good ISBNs would sit in the broken-ISBN
		// list forever.
		//
		// Compared against the recomputed value rather than tested for NULL,
		// because the wrong answer here is 0, not absent.
		const isbnValidStale = row.isbn_valid !== (
			(n.isbn ?? '').trim() === '' ? null : (checkIsbn(n.isbn).valid ? 1 : 0)
		);

		if (!textChanged && !needsFoldBackfill && !isbnValidStale) continue;
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
			customFieldsJson,
			titleRomanized: n.titleRomanized ?? null,
			authorRomanized: n.authorRomanized ?? null,
			publisherRomanized: n.publisherRomanized ?? null
		});

		/*
		 * `AND version=?` — write the row back only if nobody has touched it since this page was
		 * read. A sweep that writes a row it no longer holds is a sweep that undoes a librarian.
		 *
		 * A refused row is simply not written. Safe, because both sweeps are idempotent and
		 * re-runnable by design, AND because the record's own save path already recomputes
		 * everything these passes compute — a librarian's edit went through normalizeBookData and
		 * computeBookFolds on its way in, so the row it leaves behind is already consistent.
		 * Counted as `skipped` rather than folded into the success count: a number that quietly
		 * means something else is how the import came to report "0 rows" after overwriting
		 * thousands.
		 */
		updates.push(
			c.env.DB.prepare(
				`UPDATE books SET
				   title=?, author=?, isbn=?, publisher=?, language=?, description=?,
				   room_code=?, shelf_code=?, acquisition_date=?, tags=?, custom_fields=?,
				   title_romanized=?, author_romanized=?, publisher_romanized=?,
				   updated_at=?, version=version+1,
				   title_fold=?, author_fold=?, isbn_fold=?, publisher_fold=?,
				   description_fold=?, tags_fold=?, custom_fields_fold=?,
				   title_romanized_fold=?, author_romanized_fold=?, publisher_romanized_fold=?, isbn_valid=?
				 WHERE id=? AND version=?`
			).bind(
				n.title, n.author, n.isbn ?? null, n.publisher ?? null, n.language ?? null, n.description ?? null,
				n.roomCode ?? null, n.shelfCode ?? null, n.acquisitionDate ?? null,
				tagsJson, customFieldsJson,
				n.titleRomanized ?? null, n.authorRomanized ?? null, n.publisherRomanized ?? null,
				now,
				folds.title_fold, folds.author_fold, folds.isbn_fold, folds.publisher_fold,
				folds.description_fold, folds.tags_fold, folds.custom_fields_fold,
				folds.title_romanized_fold, folds.author_romanized_fold, folds.publisher_romanized_fold,
				folds.isbn_valid,
				row.id as string,
				row.version as number
			)
		);

		updated++;
	}

	// D1 batch caps at 50 statements per call.
	const BATCH_SIZE = 50;
	let skipped = 0;
	for (let i = 0; i < updates.length; i += BATCH_SIZE) {
		const results = await c.env.DB.batch(updates.slice(i, i + BATCH_SIZE));
		// changes === 0 means the version guard refused it — somebody edited that record while
		// this page was in flight.
		for (const r of results) {
			if ((r as { meta?: { changes?: number } }).meta?.changes === 0) skipped += 1;
		}
	}
	updated -= skipped;

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

	/*
	 * `nextAfterId` is the cursor a caller should follow — the id of the last row this page saw.
	 * `nextOffset` stays for a loop already written against it. `skipped` is reported separately
	 * because those rows were deliberately not written: somebody edited them mid-sweep, and their
	 * own save already normalized them.
	 */
	const lastId = (rows.results ?? []).length > 0
		? String((rows.results ?? [])[(rows.results ?? []).length - 1].id)
		: null;
	return c.json({
		processed, updated, skipped, foldsBackfilled, itemCodesHealed,
		unchanged: processed - updated - skipped,
		offset, nextOffset: offset + processed,
		nextAfterId: processed < limit ? null : lastId,
		done: processed < limit,
		totalBooks
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
	// Keyset, for the reason normalize-books gives: ids are random UUIDs, so a book catalogued
	// mid-sweep can land before the current offset and shift a row out of every page.
	const afterId = c.req.query('afterId') ?? '';

	// ALL TEN fold columns, not the seven that existed before migration 0023.
	// This pass is the only thing that can repair a fold after the fact, so a
	// column it does not know about is a column that stays wrong forever — and
	// `title_romanized_fold` is what makes "Klemes Romes" find Κλήμης Ῥώμης.
	const rows = await c.env.DB.prepare(
		`SELECT id, version, title, author, isbn, publisher, description, tags, custom_fields,
		        title_romanized, author_romanized, publisher_romanized,
		        title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold,
		        title_romanized_fold, author_romanized_fold, publisher_romanized_fold, isbn_valid
		 FROM books WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT ? OFFSET ?`
	).bind(afterId, limit, afterId ? 0 : offset).all<Record<string, unknown>>();

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
			customFieldsJson: (row.custom_fields as string) ?? null,
			titleRomanized: (row.title_romanized as string) ?? null,
			authorRomanized: (row.author_romanized as string) ?? null,
			publisherRomanized: (row.publisher_romanized as string) ?? null
		});

		// Compared by walking the computed object rather than a hand-written list
		// of seven: the previous form silently ignored any column added later,
		// which is exactly how the romanized three went unnoticed.
		const changed = (Object.keys(folds) as Array<keyof typeof folds>)
			.some((k) => folds[k] !== ((row[k] as string | null) ?? null));

		if (!force && !changed) continue;

		updates.push(
			c.env.DB.prepare(
				`UPDATE books SET
				   title_fold=?, author_fold=?, isbn_fold=?, publisher_fold=?,
				   description_fold=?, tags_fold=?, custom_fields_fold=?,
				   title_romanized_fold=?, author_romanized_fold=?, publisher_romanized_fold=?, isbn_valid=?
				 WHERE id=? AND version=?`
			).bind(
				folds.title_fold, folds.author_fold, folds.isbn_fold, folds.publisher_fold,
				folds.description_fold, folds.tags_fold, folds.custom_fields_fold,
				folds.title_romanized_fold, folds.author_romanized_fold, folds.publisher_romanized_fold,
				folds.isbn_valid,
				row.id as string,
				row.version as number
			)
		);

		rebuilt++;
	}

	// D1 batch caps at 50 statements per call.
	const BATCH_SIZE = 50;
	let skipped = 0;
	for (let i = 0; i < updates.length; i += BATCH_SIZE) {
		const results = await c.env.DB.batch(updates.slice(i, i + BATCH_SIZE));
		// Refused by the version guard: the record was edited while this page was in flight, and
		// its own save writes the folds in lock-step with the new text — so the row it left behind
		// is already correct, and rewriting it from the stale copy is what would break it.
		for (const r of results) {
			if ((r as { meta?: { changes?: number } }).meta?.changes === 0) skipped += 1;
		}
	}
	rebuilt -= skipped;

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

	const lastRebuiltId = (rows.results ?? []).length > 0
		? String((rows.results ?? [])[(rows.results ?? []).length - 1].id)
		: null;
	return c.json({
		processed,
		rebuilt,
		skipped,
		unchanged: processed - rebuilt - skipped,
		offset,
		nextOffset: done ? null : nextOffset,
		// The cursor to follow. OFFSET cannot be trusted here: ids are random UUIDs, so a book
		// catalogued mid-sweep lands anywhere in the order and shifts a row out of a later page.
		nextAfterId: processed < limit ? null : lastRebuiltId,
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
	// `resolveEmptyFieldExpr` accepts ANY `custom:<key>` matching [a-zA-Z0-9_]+, so
	// the loud failure above only covered the column fields — a mistyped attribute
	// key returned exactly the plausible empty facet the comment says must not
	// happen. It also handed the caller the cache key space: `facet:custom:<junk>`
	// minted a new KV entry per spelling, and 719 of the development store's entries
	// are `facet:custom:` keys.
	if (field.startsWith('custom:')) {
		const key = field.slice('custom:'.length);
		const defs = await loadCustomFieldDefs(c.env);
		if (!defs.some((d) => d.field_key === key)) {
			throw new HTTPException(400, { message: `Unknown facet field: ${field}` });
		}
	}
	const DEFAULT_FACET_LIMIT = 600;
	const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit') ?? DEFAULT_FACET_LIMIT)));

	const cacheVersion = await getBooksCacheVersion(c.env);
	// Only the default limit is cached, so `limit` cannot multiply the key space by
	// the thousand values it accepts. The interface never asks for another one; a
	// caller that does gets a live answer rather than a cache entry of its own.
	const cacheKey = limit === DEFAULT_FACET_LIMIT ? `facet:${field}:${cacheVersion}` : null;
	if (cacheKey && c.env.CACHE) {
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
		// Skipped mid-burst like every other version-keyed write: each save mints a new
		// version, so an entry written now is read by roughly nothing before the next
		// save discards it. The COUNT still runs; D1 rows are the budget that is not
		// running out.
		if (c.env.CACHE && !versionTooFreshToCache(cacheVersion)) {
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
	if (cacheKey && c.env.CACHE && !versionTooFreshToCache(cacheVersion)) {
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
	if (c.env.CACHE && !versionTooFreshToCache(cacheVersion)) {
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

	if (c.env.CACHE && !versionTooFreshToCache(cacheVersion)) {
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
		// An admin resetting someone's password is usually a RESPONSE to that account
		// being compromised, so it is the case where a surviving session matters most.
		updates.push('token_epoch = token_epoch + 1');
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
	// camelCase, alone among its snake_case siblings, and deliberately: `marc.ts`
	// reads `cf.subTitle` for MARC 245 $b and the XLSX column map writes
	// `subTitle`, so this is the spelling the two ends already agree on.
	//
	// It was missing entirely, which made the Handbook's subtitle field
	// unfillable: 'subtitle' is in the reserved-attribute set, so the
	// attribute-create form refuses it, and nothing shipped declared it — the
	// exporter read a key no librarian could produce.
	{ key: 'subTitle', label: 'Sub Title', type: 'text' },
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
						description_fold = ?, custom_fields_fold = ?, isbn_valid = ?
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
						folds.isbn_valid,
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
						title_fold, author_fold, isbn_fold, publisher_fold, description_fold, tags_fold, custom_fields_fold,
						isbn_valid
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, 'available', 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
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
						folds.custom_fields_fold,
						folds.isbn_valid
					)
					.run();
			}

			try {
				// `defs` is loaded once above this loop for validation; passing it here
				// stops the writer reloading the same table per row.
				await replaceBookAttributeValues(c.env, bookId, effectiveCf, {
					defs,
					isNewBook: !didUpdate
				});
			} catch {
				attributeFailures += 1;
			}

			// Same as the spreadsheet import above: a new record with no copy is
			// invisible to every location facet and to the room summary, however
			// faithfully `books.shelf_code` was filled in from the sheet. Insert only —
			// on a re-import this would overwrite a shelf the librarian may since have
			// corrected on the copy itself.
			if (!didUpdate) {
				// This sheet carries no room column — Prepared has shelfCode only.
				await ensurePrimaryItem(c.env, bookId, { shelfCode: p.shelfCode ?? null });
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
	// `Number('abc')` is NaN and Math.min/max propagate it, so ?limit=abc bound
	// NaN as the SQL LIMIT and came back as a 500.
	const rawLimit = Number(c.req.query('limit') ?? 25);
	const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 25;
	const rawPage = Number(c.req.query('page') ?? 1);
	const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
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
		 LIMIT ? OFFSET ?`
	).bind(nowIso(), ...params, limit, (page - 1) * limit).all<{
		id: string; name: string; contact: string | null; notes: string | null; category: string | null;
		created_at: string; updated_at: string;
		total_loans: number; open_loans: number; overdue_loans: number;
	}>();

	// A total, so a screen can page. There was no offset and a hard cap of 50, so
	// a list built on this endpoint could not reach borrower 51 of 101.
	const counted = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM borrowers b ${where}`
	).bind(...params).first<{ n: number }>();

	return c.json({
		total: Number(counted?.n ?? 0),
		page,
		pageSize: limit,
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

// Registered BEFORE /api/borrowers/:id. Hono matches in registration order, so
// declaring the param route first swallows every literal path under the same
// prefix: this endpoint sat 167 lines further down and every request for it
// resolved to the by-id handler with id='export.csv', answering
// 404 "Borrower not found". It had no caller either, so nothing noticed.
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

app.get('/api/borrowers/:id', requirePermission('circulation', { librarian: true }), async (c) => {
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM borrowers WHERE id = ? LIMIT 1').bind(id).first<{
		id: string; name: string; contact: string | null; notes: string | null;
		category: string | null; created_at: string; updated_at: string;
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
		// The column the loan policy resolves on. `SELECT *` read it and the
		// response object then dropped it, so the natural backing for a profile
		// screen could not show — or round-trip — the one field that matters to
		// how long this reader may keep a book.
		category: row.category ?? 'standard',
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

// `{ librarian: true }` like the other seven borrower routes. Equivalent today
// only because role_permissions happens to grant librarian/circulation; an admin
// who revoked that would have made DELETING a borrower more permissive than
// reading one.
app.delete('/api/borrowers/:id', requirePermission('circulation', { librarian: true }), async (c) => {
	const id = c.req.param('id') ?? '';
	// Refuse if the borrower has any historical loans — better to mark inactive
	// than orphan transaction history. Frontend can suggest the rename flow.
	const inUse = await c.env.DB.prepare(
		'SELECT COUNT(*) AS n FROM borrow_transactions WHERE borrower_id = ?'
	).bind(id).first<{ n: number }>();
	if (inUse && inUse.n > 0) {
		throw new HTTPException(409, { message: `Cannot delete: borrower has ${inUse.n} loan(s) on record. Use /erase to anonymize.` });
	}
	// Holds need the same consideration, and did not get it. `holds.borrower_id`
	// references borrowers(id) with no cascade, so a reader who had ever placed a
	// hold could not be deleted at all: the DELETE tripped the foreign key and the
	// route answered an opaque 500 — no 409 explaining the problem, no way through.
	//
	// A LIVE hold is refused, like a loan, because it is a place in a queue that
	// someone is still waiting on. A CLOSED one is not history the way a loan is —
	// it records a wait that ended — so it goes with the reader.
	const liveHolds = await c.env.DB.prepare(
		`SELECT COUNT(*) AS n FROM holds WHERE borrower_id = ? AND status IN ('waiting', 'ready')`
	).bind(id).first<{ n: number }>();
	if (liveHolds && liveHolds.n > 0) {
		throw new HTTPException(409, {
			message: `Cannot delete: borrower has ${liveHolds.n} active hold(s). Cancel them first, or use /erase to anonymize.`
		});
	}
	const [, result] = await runAtomic(c.env, [
		c.env.DB.prepare('DELETE FROM holds WHERE borrower_id = ?').bind(id),
		c.env.DB.prepare('DELETE FROM borrowers WHERE id = ?').bind(id)
	]);
	if ((result?.meta?.changes ?? 0) === 0) {
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
	// `category` is personal data held about the subject and drives what they may
	// borrow, so a subject-access request that withheld it was incomplete.
	const borrower = await c.env.DB.prepare(
		'SELECT id, name, contact, notes, category, created_at, updated_at FROM borrowers WHERE id = ? LIMIT 1'
	).bind(id).first<{
		id: string; name: string; contact: string | null; notes: string | null;
		category: string | null; created_at: string; updated_at: string;
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

	// Holds are personal data too — a queue position is a record of what this
	// reader asked for — and they were absent from the export entirely.
	const holds = await c.env.DB.prepare(
		`SELECT h.id, h.book_id, b.title, h.status, h.placed_at, h.expires_at, h.closed_at, h.notes
		   FROM holds h LEFT JOIN books b ON b.id = h.book_id
		  WHERE h.borrower_id = ? ORDER BY h.placed_at ASC`
	).bind(id).all<Record<string, unknown>>();

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
			category: borrower.category ?? 'standard',
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
		})),
		holds: (holds.results ?? []).map((r) => ({
			id: r.id,
			bookId: r.book_id,
			title: r.title,
			status: r.status,
			placedAt: r.placed_at,
			expiresAt: r.expires_at,
			closedAt: r.closed_at,
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
	// Read the identifying values BEFORE overwriting them. Some rows carry a
	// denormalized name with no borrower_id at all — the mobile app and the
	// offline sync push both create them — so a sweep on the id alone cannot
	// reach every copy of the name.
	const subject = await c.env.DB.prepare('SELECT name, contact FROM borrowers WHERE id = ? LIMIT 1')
		.bind(id).first<{ name: string; contact: string | null }>();
	if (!subject) throw new HTTPException(404, { message: 'Borrower not found' });
	const priorName = subject.name;
	const priorContact = subject.contact;

	const result = await c.env.DB.prepare(
		`UPDATE borrowers SET name = ?, contact = NULL, notes = NULL, category = 'standard', updated_at = ? WHERE id = ?`
	).bind(sentinel, nowIso(), id).run();
	if ((result.meta?.changes ?? 0) === 0) {
		throw new HTTPException(404, { message: 'Borrower not found' });
	}
	// Every loan row keeps a denormalized SNAPSHOT of the borrower's name and
	// contact (so history survives a borrower being deleted). Erasing only the
	// `borrowers` row therefore erased nothing that mattered — the name and
	// phone number stayed readable in loan history, exports, and the overdue
	// list. Anonymize the snapshots and the free-text notes on both sides.
	const now = nowIso();
	const statements: D1PreparedStatement[] = [
		c.env.DB.prepare(
			`UPDATE borrow_transactions
			 SET borrower_name = ?, borrower_contact = NULL, notes = NULL, return_notes = NULL, updated_at = ?
			 WHERE borrower_id = ?`
		).bind(sentinel, now, id),
		// `holds` keeps the same denormalized snapshot, and migration 0029 says so
		// explicitly — the queue has to read correctly after an erase. The erase
		// then never touched the table, so a reader erased while a hold was still
		// waiting or ready kept their name AND phone number on public display in
		// the Circulation tab's hold list. The leak was by construction.
		c.env.DB.prepare(
			`UPDATE holds
			 SET borrower_name = ?, borrower_contact = NULL, notes = NULL, updated_at = ?
			 WHERE borrower_id = ?`
		).bind(sentinel, now, id),
		// And the rows that carry the name with no id.
		c.env.DB.prepare(
			`UPDATE borrow_transactions
			 SET borrower_name = ?, borrower_contact = NULL, notes = NULL, return_notes = NULL, updated_at = ?
			 WHERE borrower_id IS NULL AND borrower_name = ?`
		).bind(sentinel, now, priorName),
		c.env.DB.prepare(
			`UPDATE holds
			 SET borrower_name = ?, borrower_contact = NULL, notes = NULL, updated_at = ?
			 WHERE borrower_id IS NULL AND borrower_name = ?`
		).bind(sentinel, now, priorName),
		// The audit log is a record of what STAFF did, not of the data subject, but
		// four entries embed the reader's name in their metadata. An erasure that
		// leaves the name legible in a table the Settings tab renders has not erased
		// it.
		//
		// TARGETED BY KEY, not by substring. This used to be
		// `REPLACE(metadata, priorName, sentinel) WHERE metadata LIKE '%priorName%'`
		// over the whole table, which rewrote the name wherever it appeared in ANY
		// metadata — and 9,927 `book.create` entries carry `{"title","author"}`. In a
		// Greek library a reader and an author routinely share a surname, so erasing
		// a reader named ΠΑΠΑΔΟΠΟΥΛΟΣ silently rewrote the catalogue's own history of
		// every book by an author of that name. A short name made it worse: erasing
		// "Anna" would have edited every title containing those four letters.
		//
		// The four keys below are the complete inventory, taken from the
		// insertAuditLog call sites rather than from the old comment — which claimed
		// two, and named `book.borrow`, whose metadata contains no reader name at all.
		c.env.DB.prepare(
			`UPDATE audit_logs SET metadata = json_set(metadata, '$.holdFilledFor', ?)
			  WHERE action = 'book.return' AND json_extract(metadata, '$.holdFilledFor') = ?`
		).bind(sentinel, priorName),
		c.env.DB.prepare(
			`UPDATE audit_logs SET metadata = json_set(metadata, '$.borrowerName', ?)
			  WHERE action = 'hold.place' AND json_extract(metadata, '$.borrowerName') = ?`
		).bind(sentinel, priorName),
		c.env.DB.prepare(
			`UPDATE audit_logs SET metadata = json_set(metadata, '$.name', ?)
			  WHERE action IN ('borrower.create', 'borrower.update')
			    AND entity_id = ? AND json_extract(metadata, '$.name') = ?`
		).bind(sentinel, id, priorName)
	];
	// No audit metadata carries a borrower CONTACT — verified against every
	// insertAuditLog call site — so the blanket REPLACE that used to run for it
	// could only ever have damaged something else. A contact is often a phone number
	// or an email, and either as a bare substring across 10,000 JSON blobs is the
	// most destructive of the lot.
	void priorContact;
	await runAtomic(c.env, statements);
	await insertAuditLog(c.env, c.get('user').sub, 'borrower.erase', 'borrower', id, {});
	return c.json({ id, anonymizedName: sentinel });
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
