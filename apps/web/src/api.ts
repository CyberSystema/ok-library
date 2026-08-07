// The network layer, lifted out of main.tsx.
//
// main.tsx is a leaf entry point that exports nothing, so until this move no
// other file could reach `apiRequest` — which is why every screen had to live
// inside App(). This is the seam: everything here is module-scope with no React
// state, and nothing in it may ever import from main.tsx.
//
// A PURE MOVE. Not one line of logic changed; only `export` was added.
import { cacheGet, cacheSet, cacheBustPrefixes } from './cache';

const RAW_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8787';
export const API_BASE = RAW_API_BASE.replace(/\/+$/, '');
export const IMPORT_CHUNK_SIZE = 500;
export const IMPORT_MIN_CHUNK_SIZE = 1;
export const PAGE_SIZE = 50;
export const DEBOUNCE_MS = 350;
export function joinApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

// ─── Bearer-token auth (Safari/cross-site-cookie fallback) ────────────────────
// The API issues an HttpOnly session cookie, but it is a *cross-site* cookie
// (the web app and API are on different registrable sites — pages.dev vs
// workers.dev). Safari/WebKit ITP blocks/purges cross-site cookies, so the
// cookie never rides along and every request comes back 401 → "no books".
// The API also accepts `Authorization: Bearer <token>` and returns the token in
// the login body, so we persist it and send it on every request. This works in
// every browser (and inside the Electron desktop shell) regardless of cookies.
const AUTH_TOKEN_KEY = 'ok-library-token-v1';

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    // Safari Private Browsing / disabled storage — degrade to in-memory only.
    return null;
  }
}

let authToken: string | null = readStoredToken();

export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // In-memory `authToken` still works for the rest of the session.
  }
}

// Invoked by apiRequest whenever the server rejects auth (401). The App wires
// this to drop back to the login screen. Guarded by the App so the first-load
// session probe (which 401s for anonymous visitors) doesn't show a spurious
// "session expired" message.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

// ─── Desktop app downloads ────────────────────────────────────────────────────
// Installers are published to GitHub Releases; `latest/download/<asset>` always
// resolves to the newest release's asset, so the button never needs updating.
export class ApiRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Thrown by `normalizeSpreadsheetRow` when a row has no title/author. The
 * import loop catches it by class — we used to match the localized error
 * message via `String.includes(...)`, which silently broke for non-English
 * UI languages (Korean/Greek/Russian) and let the whole import die on the
 * first missing-title row instead of skipping that row.
 */
export class SpreadsheetRowMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetRowMissingError';
  }
}

/**
 * Thrown synchronously (before fetch) when the user attempts a write
 * (POST/PUT/PATCH/DELETE) while the browser reports it is offline. We refuse
 * to even attempt the request because queuing offline writes would risk
 * silent conflicts and data loss in the remote D1 — the source of truth.
 */
export class OfflineWriteBlockedError extends Error {
  constructor(message = 'You are offline. Please reconnect before saving changes.') {
    super(message);
    this.name = 'OfflineWriteBlockedError';
  }
}

export function isOfflineWriteBlockedError(err: unknown): err is OfflineWriteBlockedError {
  return err instanceof OfflineWriteBlockedError;
}

/** Generate a v4-ish UUID without crypto.randomUUID (Safari < 15.4 fallback). */
export function newMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC4122 v4 fallback
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isPayloadTooLargeError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }

  if (error.status === 413) {
    return true;
  }

  // A 400 is the server REJECTING the rows (bad custom field, missing title) —
  // never a size complaint. Matching the bare word "payload" used to catch the
  // server's own "Invalid import payload." message, so a validation error was
  // mistaken for an oversized request: the importer kept halving the chunk and,
  // once it hit the minimum, silently dropped rows one at a time.
  if (error.status === 400) {
    return false;
  }

  return /too big|too large|entity too large|request too large/i.test(error.message);
}

// Cache-bust families: keys whose paths start with any of these are
// invalidated after a mutation succeeds. We list both the singular and
// related collection paths so e.g. POSTing /api/borrow/return also clears
const CACHE_BUST_FAMILIES = [
  'GET /api/books',
  'GET /api/custom-fields',
  'GET /api/rooms',
  'GET /api/categories',
  'GET /api/facets',
  'GET /api/stats',
  'GET /api/borrow',
  'GET /api/borrowers',
  'GET /api/needs-review-count',
  'GET /api/audit-logs',
  'GET /api/users',
  // The session response carries `needsOnboarding` and the current role. Left
  // out, a cached copy kept re-launching the finished onboarding course, and a
  // role change stayed invisible until the cache expired.
  'GET /api/auth/session',
  'GET /api/me'
];

// Simple network-status signal so the UI can surface a banner when we're
// serving cached data instead of a fresh response. Updated whenever a GET
// either uses the cache as a fallback or successfully revalidates.
export type NetStatus = 'online' | 'offline';
let lastNetStatus: NetStatus = 'online';
const netListeners = new Set<(s: NetStatus) => void>();
function setNetStatus(next: NetStatus) {
  if (next === lastNetStatus) return;
  lastNetStatus = next;
  for (const fn of netListeners) {
    try { fn(next); } catch { /* ignore listener errors */ }
  }
}
export function subscribeNetStatus(fn: (s: NetStatus) => void): () => void {
  netListeners.add(fn);
  fn(lastNetStatus);
  return () => netListeners.delete(fn);
}

function isLikelyNetworkError(err: unknown): boolean {
  // `fetch` throws a TypeError when the connection itself fails (DNS, CORS
  // preflight blocked, offline, server unreachable). HTTP error responses
  // come back as our `ApiRequestError` and must NOT trigger cache fallback.
  return err instanceof TypeError;
}
export async function apiRequest<T>(
  path: string,
  init?: RequestInit,
  raw = false
): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const cacheKey = method === 'GET' && !raw ? `GET ${path}` : null;

  // Hard-block writes while offline. We refuse to even attempt the fetch so
  // the user sees an immediate, explicit error instead of a confusing
  // "TypeError" mid-save and never has the impression a write succeeded
  // when it did not. This is intentional: writes go to the remote D1 only.
  if (isWrite && typeof navigator !== 'undefined' && navigator.onLine === false) {
    setNetStatus('offline');
    throw new OfflineWriteBlockedError();
  }

  // Idempotency: every write gets a stable client-generated id. The server
  // stores `(id -> response)` in `mutation_log` so retries after a lost
  // response (network drop between server commit and client ACK) return
  // the original result instead of double-applying the mutation.
  const mutationId = isWrite ? newMutationId() : null;

  // Retry policy for writes only. GETs are handled by the cache fallback.
  // We retry on connection failures (TypeError) and transient server states
  // (408/425/429/5xx). We do NOT retry on 4xx (except 408/425/429) because
  // those are deterministic client errors — retrying would just fail again.
  const maxAttempts = isWrite ? 4 : 1;
  const baseDelayMs = 400;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(joinApiUrl(path), {
        ...init,
        // Keep sending the cookie for browsers that accept it; the API prefers
        // the bearer token when both are present, so this is a harmless dual path.
        credentials: 'include',
        headers: {
          ...(raw ? {} : { 'Content-Type': 'application/json' }),
          ...(mutationId ? { 'X-Client-Mutation-Id': mutationId } : {}),
          // Bearer fallback — the only auth that survives Safari's cross-site
          // cookie blocking. No-op until we have a token (i.e. before login).
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(init?.headers ?? {})
        }
      });
    } catch (err) {
      lastErr = err;
      // Connection-level failure. For cached GETs we degrade gracefully and
      // return the last successful response so the UI can keep working.
      if (cacheKey && isLikelyNetworkError(err)) {
        const cached = await cacheGet<T>(cacheKey);
        if (cached) {
          setNetStatus('offline');
          return cached.value;
        }
      }
      // For writes, retry transient connection failures with backoff.
      if (isWrite && isLikelyNetworkError(err) && attempt < maxAttempts) {
        await sleep(backoffDelay(baseDelayMs, attempt));
        continue;
      }
      // Surface as offline before bubbling so the UI flips its banner.
      if (isLikelyNetworkError(err)) setNetStatus('offline');
      throw err;
    }

    if (!response.ok) {
      // Retry transient server errors for writes only.
      const transient = response.status === 408 || response.status === 425
        || response.status === 429 || response.status >= 500;
      if (isWrite && transient && attempt < maxAttempts) {
        // Drain body so the connection can be reused.
        try { await response.text(); } catch { /* ignore */ }
        await sleep(backoffDelay(baseDelayMs, attempt, response.headers.get('retry-after')));
        continue;
      }

      const responseText = await response.text();
      const errorBody = (() => {
        try {
          return JSON.parse(responseText) as { error?: string; requestId?: string };
        } catch {
          return { error: response.statusText };
        }
      })();

      if (response.status === 401) {
        // The stored bearer token (if any) is no longer valid — drop it so we
        // don't keep overriding a possibly-valid cookie with a dead token, and
        // notify the app so it can return to the login screen instead of leaving
        // the user on a stale "logged-in" shell with no data.
        setAuthToken(null);
        if (onUnauthorized) {
          try { onUnauthorized(); } catch { /* ignore handler errors */ }
        }
        throw new ApiRequestError(401, 'Session expired. Please sign in again.');
      }

      const message = errorBody.requestId
        ? `${errorBody.error ?? `Request failed with status ${response.status}`} (ref: ${errorBody.requestId})`
        : (errorBody.error ?? `Request failed with status ${response.status}`);
      throw new ApiRequestError(response.status, message);
    }

    if (raw) {
      setNetStatus('online');
      return (await response.text()) as T;
    }

    // A 204 No Content (and any other empty body) has nothing to parse — DELETE
    // endpoints return this. Calling response.json() on an empty body throws
    // "JSON.parse: unexpected end of data", so read the text first and only
    // parse when there is something there.
    const bodyText = await response.text();
    const payload = (bodyText ? JSON.parse(bodyText) : undefined) as T;
    setNetStatus('online');

    // Persist successful GETs to cache (fire-and-forget) and invalidate
    // cached entries after any successful mutation. Both run after the value
    // is parsed so failures here can't fail the request itself.
    if (cacheKey) {
      void cacheSet(cacheKey, payload);
    } else if (isWrite) {
      void cacheBustPrefixes(CACHE_BUST_FAMILIES);
    }

    return payload;
  }

  // All retries exhausted.
  throw lastErr instanceof Error ? lastErr : new Error('Request failed');
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter and respect for an HTTP `Retry-After`
 * header (seconds). attempt is 1-based.
 */
function backoffDelay(baseMs: number, attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10_000);
  }
  const exp = baseMs * Math.pow(3, attempt - 1); // 400, 1200, 3600, 10800
  const jitter = Math.random() * baseMs;
  return Math.min(exp + jitter, 10_000);
}
