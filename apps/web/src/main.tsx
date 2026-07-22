import React, { Fragment, FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  BookCardSkeleton,
  ConfirmProvider,
  MiniBar,
  ToastProvider,
  fmt,
  highlight,
  normalizeForCompare,
  useConfirm,
  useToast
} from './ui';
import { I18nProvider, LanguageSwitcher, useI18n, useT, type Lang } from './i18n';
import { cacheGet, cacheSet, cacheBustPrefixes, cacheClear } from './cache';
import { OnboardingCourse } from './onboarding';
import './styles.css';

// Lazy-loaded only when the user opens the Import tab — saves ~1MB from the initial bundle.
async function loadXlsx() {
  return await import('xlsx');
}

type BookStatus = 'available' | 'borrowed' | 'lost' | 'maintenance';

type Book = {
  id: string;
  title: string;
  author: string;
  status: BookStatus;
  roomCode?: string | null;
  shelfCode?: string | null;
  isbn?: string | null;
  publicationYear?: number | null;
  customFields?: Record<string, string | number | boolean | null>;
  version: number;
  publisher?: string | null;
  language?: string | null;
  description?: string | null;
  legacyId?: string | null;
  coverUrl?: string | null;
};

type Borrower = {
  id: string;
  name: string;
  contact?: string | null;
  totalLoans: number;
  openLoans: number;
  overdueLoans: number;
};

// Smart lists are pre-saved filter combinations the user can apply with one click.
// Each entry maps to query-string params understood by /api/books.
type SmartList = {
  key: string;
  icon: string;
  label: string;
  // Returns the filter params; the caller spreads these into the URLSearchParams.
  params: Record<string, string>;
};

type CatalogRow = {
  legacyId?: string | null;
  title?: string | null;
  author?: string | null;
  isbn?: string | null;
  publicationYear?: number | null;
  publisher?: string | null;
  language?: string | null;
  description?: string | null;
  shelfCode?: string | null;
  needsReview?: boolean;
  customFields: Record<string, string | number | boolean | null>;
};

type CustomField = {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'enum';
  required: boolean;
  // Pinned attributes lead every attribute list, ordered by sortOrder. Optional
  // so a client running against an API that predates the columns still parses.
  pinned?: boolean;
  sortOrder?: number;
  enumOptions: string[];
};

type SessionUser = { id: string; username: string; role: string; needsOnboarding?: boolean };

type LoginResponse = {
  user: SessionUser;
  // Present so clients on browsers that block the cross-site auth cookie
  // (Safari/WebKit ITP) can authenticate via an Authorization: Bearer header.
  token?: string;
};

type SessionResponse = {
  user: SessionUser;
};

type ActiveBorrow = {
  id: string;
  bookId: string;
  title: string;
  author: string;
  borrowerName: string;
  borrowerContact?: string | null;
  borrowedAt: string;
  dueAt: string;
  isOverdue: boolean;
};

type AuditLogItem = {
  id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  created_at: string;
};

type StaffRole = 'admin' | 'librarian' | 'viewer';

type StaffUser = {
  id: string;
  username: string;
  role: StaffRole;
  active: number;
  created_at: string;
  updated_at: string;
};

type BorrowHistoryItem = {
  id: string;
  borrowerName: string;
  borrowerContact?: string | null;
  borrowedAt: string;
  dueAt: string;
  returnedAt?: string | null;
  notes?: string | null;
  wasOverdue: boolean;
};

type RoomSummaryItem = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  total_books: number;
  available_books: number;
  borrowed_books: number;
  lost_books: number;
  maintenance_books: number;
};

type CategoryItem = {
  code: string;
  label: string | null;
  count: number;
};

type AppSection = 'dashboard' | 'books' | 'circulation' | 'import' | 'settings';

type StatsResponse = {
  byStatus: Array<{ status: string; count: number }>;
  byLanguage: Array<{ language: string; count: number }>;
  byYear: Array<{ bucket: string; count: number }>;
  completeness: {
    total: number;
    withIsbn: number;
    withShelf: number;
    withPublisher: number;
    withYear: number;
    untitled: number;
    unknownAuthor: number;
  };
  recentlyUpdated: Array<{
    id: string;
    title: string;
    author: string;
    legacyId: string | null;
    updatedAt: string;
  }>;
  topShelves: Array<{ shelfCode: string; count: number }>;
};

type Theme = 'light' | 'dark';

// Saved smart lists rendered as one-click filter chips. The keys must be stable
// because they're used to highlight the active chip. The label is resolved at
// render time via the i18n translator using `labelKey`.
const SMART_LISTS: Array<SmartList & { labelKey: string }> = [
  { key: 'missing-isbn',     icon: '🔢', labelKey: 'library.smart.missingIsbn',    label: 'Missing ISBN',     params: { missingIsbn: '1' } },
  { key: 'missing-shelf',    icon: '📍', labelKey: 'library.smart.missingShelf',   label: 'Missing shelf',    params: { missingShelf: '1' } },
  { key: 'untitled',         icon: '⊘',  labelKey: 'library.smart.untitled',       label: 'Untitled',         params: { untitled: '1' } },
  { key: 'unknown-author',   icon: '?',  labelKey: 'library.smart.unknownAuthor',  label: 'Unknown author',   params: { unknownAuthor: '1' } },
  { key: 'pre-1900',         icon: '🏛', labelKey: 'library.smart.pre1900',        label: 'Before 1900',      params: { yearMax: '1899' } },
  { key: 'post-2000',        icon: '🆕', labelKey: 'library.smart.post2000',       label: 'From 2000+',       params: { yearMin: '2000' } },
  { key: 'borrowed',         icon: '🔁', labelKey: 'library.smart.borrowed',       label: 'Currently borrowed', params: { status: 'borrowed' } },
  { key: 'recently-added',   icon: '🕒', labelKey: 'library.smart.recent',         label: 'Recently added',   params: { sortBy: 'updatedAt', sortDir: 'desc' } }
];

type DuplicateEntry = { id: string; title: string; author: string; isbn: string | null };
type DuplicateGroup = DuplicateEntry[];
type CatalogFacets = {
  // No `titles`: title is intentionally excluded from autocomplete (unique-ish
  // values, and suggesting them risks picking an existing book's title).
  authors: string[];
  publishers: string[];
  languages: string[];
  shelfCodes: string[];
  // Per-custom-field distinct values (text fields only), keyed by field key.
  customFields: Record<string, string[]>;
};
type SearchMode = 'all' | 'any' | 'exact';
type SearchField = 'title' | 'author' | 'isbn' | 'publisher' | 'language' | 'description' | 'roomCode' | 'shelfCode' | 'tags' | 'custom';

const RAW_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8787';
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');
const IMPORT_CHUNK_SIZE = 500;
const IMPORT_MIN_CHUNK_SIZE = 1;
const PAGE_SIZE = 50;
const DEBOUNCE_MS = 350;
// The book-list filter params, built in ONE place so the grid query and the
// "select all matching" query can never drift apart — if they did, the librarian
// would select a different set than the one they are looking at. Pure (takes the
// values, reads no state) so callers can't capture a stale closure.
function buildBookFilterParams(f: {
  q: string;
  qExclude: string;
  qMode: string;
  partialWords: boolean;
  fuzzyTypos: boolean;
  searchFields: string[];
  status: string;
  filterLanguage: string;
  filterYear: string;
  categoryFilter: string;
  needsReviewFilter: boolean;
  shelfFilter: string;
  smartListKey: string;
  smartLists: ReadonlyArray<{ key: string; params: Record<string, string> }>;
}): URLSearchParams {
  const query = new URLSearchParams();
  if (f.q) query.set('q', f.q);
  if (f.qExclude) query.set('qExclude', f.qExclude);
  query.set('qMode', f.qMode);
  query.set('partialWords', String(f.partialWords));
  query.set('fuzzyTypos', String(f.fuzzyTypos));
  query.set('searchFields', f.searchFields.join(','));
  if (f.status) query.set('status', f.status);
  if (f.filterLanguage) query.set('language', f.filterLanguage);
  // Only send a complete, in-range year — otherwise every keystroke ("1", "19",
  // "190") would post a year the schema rejects (1000–3000) and pop a 400 toast
  // mid-typing. Partial input simply doesn't filter yet.
  if (f.filterYear) {
    const yr = Number(f.filterYear);
    if (Number.isInteger(yr) && yr >= 1000 && yr <= 3000) query.set('year', f.filterYear);
  }
  if (f.categoryFilter) query.set('custom_category_code', f.categoryFilter);
  if (f.needsReviewFilter) query.set('custom_needs_review', '1');
  if (f.shelfFilter) query.set('shelfCode', f.shelfFilter);
  // Apply the active smart-list's filters last so it composes with the rest.
  if (f.smartListKey) {
    const list = f.smartLists.find((l) => l.key === f.smartListKey);
    if (list) for (const [k, v] of Object.entries(list.params)) query.set(k, v);
  }
  return query;
}

const PREFS_STORAGE_KEY = 'ok-library-prefs-v1';
// Bulk-selection ids, kept in sessionStorage (per tab, cleared when the tab
// closes) so paging/searching/reloading never loses a selection in progress.
const SELECTION_STORAGE_KEY = 'ok-library-selection-v1';

type SortBy = 'updatedAt' | 'title' | 'author' | 'publicationYear' | 'status';
type SortDir = 'asc' | 'desc';
type Density = 'comfortable' | 'compact';

// Kept in sync with CATALOG_CUSTOM_FIELDS in apps/api-worker/src/index.ts.
const CATALOG_FIELD_COUNT = 25;
// Legacy English sentinels historically minted by catalog imports. New writes
// store '' instead (see normalizeBookData), but existing rows may still hold
// these until re-normalized, so the UI must treat both as "no value".
const TITLE_PLACEHOLDER = '(Untitled)';
const AUTHOR_PLACEHOLDER = '(Unknown)';

// A book field is "empty" if it's blank OR holds the legacy sentinel.
function isPlaceholder(value: string | null | undefined, kind: 'title' | 'author'): boolean {
  const text = (value ?? '').trim();
  const sentinel = kind === 'title' ? TITLE_PLACEHOLDER : AUTHOR_PLACEHOLDER;
  return text === '' || text === sentinel;
}

// Render the title/author, substituting a caller-supplied (localized) placeholder
// for empty or legacy-sentinel values. The placeholder defaults to the English
// sentinel so non-React callers keep working, but every UI call passes t(...).
function displayTitle(book: { title: string }, placeholder: string = TITLE_PLACEHOLDER): string {
  const trimmed = book.title?.trim() ?? '';
  return trimmed === '' || trimmed === TITLE_PLACEHOLDER ? placeholder : trimmed;
}

function displayAuthor(book: { author: string }, placeholder: string = AUTHOR_PLACEHOLDER): string {
  const trimmed = book.author?.trim() ?? '';
  return trimmed === '' || trimmed === AUTHOR_PLACEHOLDER ? placeholder : trimmed;
}

function joinApiUrl(path: string): string {
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

function setAuthToken(token: string | null): void {
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
function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

// ─── Desktop app downloads ────────────────────────────────────────────────────
// Installers are published to GitHub Releases; `latest/download/<asset>` always
// resolves to the newest release's asset, so the button never needs updating.
// Override the base via VITE_DESKTOP_DL_BASE if you host the installers elsewhere.
const DESKTOP_DL_BASE = (import.meta.env.VITE_DESKTOP_DL_BASE as string | undefined)
  ?? 'https://github.com/CyberSystema/ok-library/releases/latest/download';
const DESKTOP_RELEASES_URL = (import.meta.env.VITE_DESKTOP_RELEASES_URL as string | undefined)
  ?? 'https://github.com/CyberSystema/ok-library/releases/latest';
const DESKTOP_DOWNLOADS = {
  mac: `${DESKTOP_DL_BASE}/OK-Library-macOS.dmg`,
  windows: `${DESKTOP_DL_BASE}/OK-Library-Windows-x64.zip`,
  windowsArm: `${DESKTOP_DL_BASE}/OK-Library-Windows-arm64.zip`
};

type DesktopOS = 'mac' | 'windows' | 'other';

/** Best-effort OS detection for picking the right installer. */
function detectDesktopOS(): DesktopOS {
  if (typeof navigator === 'undefined') return 'other';
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = (uaData?.platform || navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();
  const hay = `${platform} ${ua}`;
  // Note: iPadOS reports as "Mac"; harmless here since the link still points at
  // the releases page fallback only for the 'other' bucket.
  if (hay.includes('mac')) return 'mac';
  if (hay.includes('win')) return 'windows';
  return 'other';
}

/** True when running inside the Electron desktop shell (preload sets this). */
function isDesktopShell(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { okDesktop?: { isDesktop?: boolean } }).okDesktop?.isDesktop);
}

/**
 * Auto-detecting "Download desktop app" button. Picks the installer for the
 * visitor's OS; on an unrecognized OS it links to the releases page (all
 * platforms). The small "other platforms" link is always available so e.g. a
 * Mac user can still grab the Windows build.
 *
 * Hidden inside the desktop app itself — only the web app offers the download.
 */
function DownloadDesktopButton() {
  const t = useT();
  const os = useMemo(detectDesktopOS, []);

  if (isDesktopShell()) return null;

  const target =
    os === 'mac'
      ? { href: DESKTOP_DOWNLOADS.mac, label: t('desktop.downloadMac') }
      : os === 'windows'
        ? { href: DESKTOP_DOWNLOADS.windows, label: t('desktop.downloadWin') }
        : { href: DESKTOP_RELEASES_URL, label: t('desktop.downloadApp') };

  return (
    <span className="desktop-download">
      <a className="btn-download" href={target.href} title={t('desktop.tooltip')}>
        <svg
          className="btn-download-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v12" />
          <path d="m7 11 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
        <span>{target.label}</span>
      </a>
      {os !== 'other' && (
        <a
          className="desktop-download-other"
          href={DESKTOP_RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t('desktop.otherTooltip')}
        >
          {t('desktop.other')}
        </a>
      )}
    </span>
  );
}

const RESERVED_ATTRIBUTE_KEYS = new Set([
  'title',
  'subtitle',
  'author',
  'isbn',
  'publicationYear',
  'publisher',
  'language',
  'description',
  'roomCode',
  'shelfCode',
  'acquisitionDate',
  'status',
  'tags',
  'customFields',
  'version',
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt'
]);

class ApiRequestError extends Error {
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
class SpreadsheetRowMissingError extends Error {
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
class OfflineWriteBlockedError extends Error {
  constructor(message = 'You are offline. Please reconnect before saving changes.') {
    super(message);
    this.name = 'OfflineWriteBlockedError';
  }
}

function isOfflineWriteBlockedError(err: unknown): err is OfflineWriteBlockedError {
  return err instanceof OfflineWriteBlockedError;
}

/** Generate a v4-ish UUID without crypto.randomUUID (Safari < 15.4 fallback). */
function newMutationId(): string {
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

function isPayloadTooLargeError(error: unknown): boolean {
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
// /api/books and /api/stats which depend on borrow state.
const CACHE_BUST_FAMILIES = [
  'GET /api/books',
  'GET /api/custom-fields',
  'GET /api/rooms',
  'GET /api/categories',
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
type NetStatus = 'online' | 'offline';
let lastNetStatus: NetStatus = 'online';
const netListeners = new Set<(s: NetStatus) => void>();
function setNetStatus(next: NetStatus) {
  if (next === lastNetStatus) return;
  lastNetStatus = next;
  for (const fn of netListeners) {
    try { fn(next); } catch { /* ignore listener errors */ }
  }
}
function subscribeNetStatus(fn: (s: NetStatus) => void): () => void {
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

async function apiRequest<T>(
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

function sleep(ms: number): Promise<void> {
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

function StatCard({ title, value, subtitle }: { title: string; value: string | number; subtitle: string }) {
  return (
    <article className="stat-card">
      <p className="stat-title">{title}</p>
      <p className="stat-value">{value}</p>
      <p className="stat-subtitle">{subtitle}</p>
    </article>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  aside
}: {
  eyebrow: string;
  title: string;
  description: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <p className="section-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p className="panel-help">{description}</p>
      </div>
      {aside ? <div className="section-header-aside">{aside}</div> : null}
    </div>
  );
}

// Autocomplete option lists for the add/edit book forms. Memoized on `facets`
// so the ~4000 <option> nodes are only rebuilt when the catalog values change —
// never on every keystroke in the (frequently re-rendering) parent form.
const CatalogDatalists = React.memo(function CatalogDatalists({ facets }: { facets: CatalogFacets }) {
  return (
    <>
      <datalist id="suggest-author">{(facets.authors ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="suggest-publisher">{(facets.publishers ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="suggest-language">{(facets.languages ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="suggest-shelf">{(facets.shelfCodes ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      {/* One datalist per free-text custom field, referenced by suggest-cf-<key>.
          Guard against a stale cached facets shape that predates customFields. */}
      {Object.entries(facets.customFields ?? {}).map(([key, values]) => (
        <datalist id={`suggest-cf-${key}`} key={key}>{(values ?? []).map((v) => <option key={v} value={v} />)}</datalist>
      ))}
    </>
  );
});

type ValueVariantGroup = { canonical: string; total: number; variants: Array<{ value: string; count: number }> };

// One row of the "value consistency" tool: shows the fold-equivalent spellings
// of a value with their book counts, lets the librarian pick (or type) the
// canonical form, and merge the rest into it.
function VariantGroupCard({ group, mergeLabel, keepLabel, onMerge }: {
  group: ValueVariantGroup;
  mergeLabel: string;
  keepLabel: string;
  onMerge: (canonical: string) => void;
}) {
  const [canonical, setCanonical] = useState(group.canonical);
  return (
    <div className="variant-group">
      <div className="variant-chips">
        {group.variants.map((v) => (
          <button
            type="button"
            key={v.value}
            className={`variant-chip${v.value === canonical ? ' is-canonical' : ''}`}
            title={keepLabel}
            onClick={() => setCanonical(v.value)}
          >
            <span className="variant-chip-value">{v.value}</span>
            <span className="variant-chip-count">{v.count}</span>
          </button>
        ))}
      </div>
      <div className="variant-merge-row">
        <input value={canonical} onChange={(e) => setCanonical(e.target.value)} />
        <button
          type="button"
          className="primary small"
          disabled={!canonical.trim() || group.variants.every((v) => v.value === canonical)}
          onClick={() => onMerge(canonical.trim())}
        >{mergeLabel}</button>
      </div>
    </div>
  );
}

// ── Custom right-click context menu ─────────────────────────────────────────
// A single app-owned menu that replaces the browser's native one on the app's
// own surfaces. Menu items are built in App scope (so they can call the app's
// handlers + read the permission gates) and handed to this pure renderer, which
// only positions the menu, clamps it to the viewport, and handles dismissal +
// keyboard navigation.
type CtxItem =
  | { sep: true }
  | { header: string }
  | { label: string; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean };

interface CtxMenuState {
  x: number;
  y: number;
  items: CtxItem[];
  title?: string;
}

// Drop empty groups: leading/trailing/duplicate separators and headers that end
// up with no actionable item beneath them, so a permission-filtered menu never
// shows a stray divider or an empty section.
function pruneCtxItems(items: CtxItem[]): CtxItem[] {
  const out: CtxItem[] = [];
  for (const it of items) {
    if ('sep' in it) {
      if (out.length === 0) continue;
      const prev = out[out.length - 1];
      if ('sep' in prev || 'header' in prev) continue;
      out.push(it);
    } else if ('header' in it) {
      // Collapse a header that immediately follows another header/sep-less start.
      if (out.length > 0 && 'header' in out[out.length - 1]) out.pop();
      out.push(it);
    } else {
      out.push(it);
    }
  }
  // Trim trailing separators / dangling headers.
  while (out.length > 0) {
    const last = out[out.length - 1];
    if ('sep' in last || 'header' in last) out.pop();
    else break;
  }
  // Drop any header not immediately followed by an actionable item — otherwise a
  // header whose whole section was permission-filtered would mislabel whatever
  // section comes next.
  return out.filter((it, i) => {
    if (!('header' in it)) return true;
    const next = out[i + 1];
    return next !== undefined && !('sep' in next) && !('header' in next);
  });
}

function ContextMenuView({ state, onClose }: { state: CtxMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // The element focused when the menu opened, so focus can return there on close.
  const triggerRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; ready: boolean }>({ x: state.x, y: state.y, ready: false });

  // Measure then clamp inside the viewport (shift so the menu never spills
  // off-screen). Runs before paint. Also remember the trigger element (still
  // focused at this point) so we can restore focus when the menu closes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!triggerRef.current) triggerRef.current = (document.activeElement as HTMLElement) ?? null;
    const pad = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = state.x;
    let y = state.y;
    if (x + w + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - w - pad);
    if (y + h + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - h - pad);
    setPos({ x, y, ready: true });
  }, [state.x, state.y, state.items]);

  // Focus the first item only AFTER the menu is visible — a visibility:hidden
  // element cannot receive focus, so focusing inside the clamp effect (while
  // still hidden) would silently no-op.
  useEffect(() => {
    if (pos.ready) ref.current?.querySelector<HTMLButtonElement>('button.ctx-item:not([disabled])')?.focus();
  }, [pos.ready]);

  // Return focus to the trigger when the menu unmounts (any close path), so
  // keyboard users don't get dumped at the top of the document.
  useEffect(() => () => {
    const el = triggerRef.current;
    if (el && document.body.contains(el)) el.focus?.();
  }, []);

  // Dismiss on any outside press, page scroll, resize, or window blur. Wheel and
  // mousedown are guarded so scrolling/clicking INSIDE the menu doesn't close it
  // (the menu can scroll when it is taller than the viewport). Escape is handled
  // by the App-level key handler so it takes priority over the modals.
  useEffect(() => {
    const isOutside = (t: EventTarget | null) => !ref.current || !ref.current.contains(t as Node);
    const onDown = (e: MouseEvent) => { if (isOutside(e.target)) onClose(); };
    const onWheel = (e: WheelEvent) => { if (isOutside(e.target)) onClose(); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') { e.preventDefault(); onClose(); return; }
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button.ctx-item:not([disabled])') ?? []);
    if (btns.length === 0) return;
    const idx = btns.findIndex((b) => b === document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(idx + 1) % btns.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(idx - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={state.title}
      style={{ left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={onKeyDown}
    >
      {state.title ? <div className="ctx-menu-title" title={state.title}>{state.title}</div> : null}
      {state.items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="ctx-sep" role="separator" />;
        if ('header' in it) return <div key={i} className="ctx-menu-header">{it.header}</div>;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`ctx-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            title={it.label}
            onClick={() => { onClose(); it.onClick(); }}
          >
            <span className="ctx-icon" aria-hidden="true">{it.icon ?? ''}</span>
            <span className="ctx-label">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function App() {
  const toast = useToast();
  const confirm = useConfirm();
  const { t, lang } = useI18n();
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  // Onboarding course: `showOnboarding` opens it as a replay overlay (from
  // Settings); the mandatory first-run gate is derived from currentUser below.
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileUsername, setProfileUsername] = useState('');
  const [profileNewPassword, setProfileNewPassword] = useState('');
  const [profileCurrentPassword, setProfileCurrentPassword] = useState('');
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [myPermissions, setMyPermissions] = useState<Record<string, boolean> | null>(null);
  const [permissionMatrix, setPermissionMatrix] = useState<{
    catalog: string[];
    matrix: Record<'admin' | 'librarian' | 'viewer', Record<string, boolean>>;
  } | null>(null);
  const [permissionMatrixLoading, setPermissionMatrixLoading] = useState(false);
  const [permissionMatrixSaving, setPermissionMatrixSaving] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [currentSection, setCurrentSection] = useState<AppSection>('books');
  const [theme, setTheme] = useState<Theme>('light');
  const [stats, setStats] = useState<StatsResponse | null>(null);

  const [books, setBooks] = useState<Book[]>([]);
  // Distinguishes a failed books fetch from a genuinely empty library so the UI
  // can show a real error + retry instead of a misleading "no books" panel.
  const [booksError, setBooksError] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  // Distinct catalog values that feed the add/edit form autocomplete so a
  // librarian rarely retypes a repeated title, author, publisher, language, or
  // shelf code. Loaded from GET /api/books/facets and refreshed after writes.
  const [facets, setFacets] = useState<CatalogFacets>({
    authors: [], publishers: [], languages: [], shelfCodes: [], customFields: {}
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [totalBooksCount, setTotalBooksCount] = useState(0);

  const [q, setQ] = useState('');
  const [qExclude, setQExclude] = useState('');
  const [qMode, setQMode] = useState<SearchMode>('all');
  const [partialWords, setPartialWords] = useState(true);
  const [fuzzyTypos, setFuzzyTypos] = useState(true);
  // Lexical = the existing FTS + fuzzy stack. Semantic = ANN over book
  // embeddings (Workers AI + Vectorize). The toggle is in advanced search;
  // when semantic mode is on we bypass the filter chips/sort UI and send
  // only `q` to the dedicated `/api/books/semantic` endpoint.
  const [searchEngine, setSearchEngine] = useState<'lexical' | 'semantic'>('lexical');
  // Health probe tells us whether the deployment has Vectorize+AI bound,
  // so we can disable the semantic option in the UI rather than offer a
  // mode that would only ever return 503.
  const [semanticAvailable, setSemanticAvailable] = useState<boolean | null>(null);
  const [searchFields, setSearchFields] = useState<SearchField[]>(['title', 'author', 'isbn']);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [status, setStatus] = useState('');
  const [filterLanguage, setFilterLanguage] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [shelfFilter, setShelfFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('updatedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [density, setDensity] = useState<Density>('comfortable');
  const [jumpPage, setJumpPage] = useState('');
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [needsReviewFilter, setNeedsReviewFilter] = useState(false);
  const [smartListKey, setSmartListKey] = useState<string>('');
  const [borrowerSuggestions, setBorrowerSuggestions] = useState<Borrower[]>([]);
  // Sequence number for borrower-autocomplete: every keystroke bumps the
  // counter and only the most recent in-flight request is allowed to
  // commit results. Prevents stale responses from overwriting a newer
  // search when responses arrive out of order on slow networks.
  const borrowerSearchSeqRef = useRef(0);
  // Debounce handle for borrower search. We still fire only the latest
  // request via the sequence counter, but coalescing keystrokes into a
  // single network call lowers the cost per typed name and reduces backend
  // pressure on the API + KV rate limiter.
  const borrowerDebounceRef = useRef<number | null>(null);
  // Keyboard-navigation cursor inside the suggestion dropdown. -1 means
  // "no selection yet" — Enter on -1 doesn't pick anything (preserves the
  // existing "submit the typed value" behavior).
  const [borrowerHighlight, setBorrowerHighlight] = useState(-1);
  const bookHistorySeqRef = useRef(0);
  // Drops results from an earlier loadBooks() call that resolves after a newer
  // one (fast typing / rapid filter changes) so a slow response can't clobber
  // the current results, total, and page.
  const loadBooksSeqRef = useRef(0);
  const [borrowerQuery, setBorrowerQuery] = useState('');
  const [selectedBorrowerId, setSelectedBorrowerId] = useState<string>('');
  const [needsReviewCount, setNeedsReviewCount] = useState(0);
  const [showCategoryRail, setShowCategoryRail] = useState(true);
  const [categoryRailQuery, setCategoryRailQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastSearchSignatureRef = useRef<string>('');

  const [createForm, setCreateForm] = useState({
    title: '',
    author: '',
    isbn: '',
    shelfCode: '',
    publicationYear: '',
    publisher: '',
    language: '',
    description: ''
  });
  const [createAttrValues, setCreateAttrValues] = useState<Record<string, unknown>>({});
  // Field keys (core: 'title'; custom: 'cf:<key>') flagged as missing-required on
  // the last add-book submit attempt, so they can be visually highlighted.
  const [createFieldErrors, setCreateFieldErrors] = useState<Set<string>>(new Set());
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  // Cover image chosen in the add-book form. It can only be uploaded once the
  // book row exists (the cover endpoint keys on the book id), so we hold the
  // File here and PUT it right after the book is created. The object-URL
  // preview is revoked by an effect when it changes / on unmount.
  const [createCoverFile, setCreateCoverFile] = useState<File | null>(null);
  const [createCoverPreview, setCreateCoverPreview] = useState<string | null>(null);

  const [editForm, setEditForm] = useState({
    id: '',
    title: '',
    author: '',
    isbn: '',
    shelfCode: '',
    publicationYear: '',
    status: 'available' as BookStatus,
    version: 0,
    publisher: '',
    language: '',
    description: ''
  });
  // Missing-required field keys flagged on the last edit-save attempt (mirrors
  // createFieldErrors), so an existing book can't be saved with its title blanked.
  const [editFieldErrors, setEditFieldErrors] = useState<Set<string>>(new Set());
  const editTitleInputRef = useRef<HTMLInputElement | null>(null);

  const [fieldForm, setFieldForm] = useState({
    key: '',
    label: '',
    type: 'text' as 'text' | 'number' | 'boolean' | 'date' | 'enum',
    required: false,
    // Pinned attributes lead every attribute list. `sortOrder` positions the
    // field within its group; ties fall back to the label.
    pinned: false,
    sortOrder: 0,
    enumOptionsCsv: ''
  });
  const [editingCustomFieldId, setEditingCustomFieldId] = useState<string | null>(null);

  const [importDryRun, setImportDryRun] = useState(true);
  const [importFileName, setImportFileName] = useState('');

  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [borrowerName, setBorrowerName] = useState('');
  const [borrowerContact, setBorrowerContact] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [scanCode, setScanCode] = useState('');
  const [scanResult, setScanResult] = useState<string>('');
  const [activeBorrows, setActiveBorrows] = useState<ActiveBorrow[]>([]);
  const [auditItems, setAuditItems] = useState<AuditLogItem[]>([]);
  const [staffUsers, setStaffUsers] = useState<StaffUser[]>([]);
  const [staffUsersLoading, setStaffUsersLoading] = useState(false);
  const [newUserUsername, setNewUserUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<StaffRole>('viewer');
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editUserPassword, setEditUserPassword] = useState('');
  const [bookHistory, setBookHistory] = useState<BorrowHistoryItem[]>([]);
  const [bookHistoryHasMore, setBookHistoryHasMore] = useState(false);
  const [roomSummary, setRoomSummary] = useState<RoomSummaryItem[]>([]);
  const [unassignedSummary, setUnassignedSummary] = useState({
    totalBooks: 0,
    availableBooks: 0,
    borrowedBooks: 0,
    lostBooks: 0,
    maintenanceBooks: 0
  });
  const [attributeEditorValues, setAttributeEditorValues] = useState<Record<string, unknown>>({});
  // Book selection for bulk actions. Persisted per-tab so a reload (or an
  // accidental navigation) doesn't silently throw away a long selection the
  // librarian built up across several pages.
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem(SELECTION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  });
  // When false, per-row checkboxes are hidden. The user must click "Select"
  // in the section header to enter selection mode. This keeps the default
  // browsing surface uncluttered — nothing is selectable until requested.
  const [selectionMode, setSelectionMode] = useState(false);
  const [detailBook, setDetailBook] = useState<Book | null>(null);
  const [detailMode, setDetailMode] = useState<'view' | 'edit'>('view');
  // Full-screen cover zoom (lightbox). Holds the resolved cover URL while open,
  // null while closed. Opened by clicking the large cover in the detail view.
  const [coverZoom, setCoverZoom] = useState<string | null>(null);
  // Custom right-click menu: null when closed, else its screen position + items.
  const [contextMenu, setContextMenu] = useState<CtxMenuState | null>(null);
  // A hidden file input reused by the "Replace/Add cover" menu item — the book
  // to attach the chosen file to is stashed in a ref while the picker is open.
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const coverUploadBookRef = useRef<Book | null>(null);
  const [showAddBook, setShowAddBook] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string>('');
  // Full bulk editor. Values are keyed 'core:<bookKey>' or 'cf:<attributeKey>';
  // a key is only written if it appears in `bulkEditValues` (set it) or in
  // `bulkEditClears` (blank it). Anything absent from BOTH is left untouched —
  // an empty text box must never mean "erase this on 300 books".
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditValues, setBulkEditValues] = useState<Record<string, string>>({});
  const [bulkEditClears, setBulkEditClears] = useState<Set<string>>(new Set());
  const [bulkTagsAdd, setBulkTagsAdd] = useState('');
  const [bulkTagsRemove, setBulkTagsRemove] = useState('');
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  // Value-consistency tool: fold-equivalent spelling variants of a field.
  type VariantField = 'author' | 'publisher' | 'language' | 'shelfCode' | 'title';
  const [variantField, setVariantField] = useState<VariantField>('publisher');
  const [valueVariants, setValueVariants] = useState<ValueVariantGroup[]>([]);
  const [variantsScanned, setVariantsScanned] = useState(false);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [showDuplicatesPanel, setShowDuplicatesPanel] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateEntry[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [didBootstrapData, setDidBootstrapData] = useState(false);
  const [isLoadingBooks, setIsLoadingBooks] = useState(false);

  const splashStartRef = useRef(0);
  const splashActiveRef = useRef(false);
  const [showSplash, setShowSplash] = useState(false);
  const [splashHiding, setSplashHiding] = useState(false);
  // Reflects whether the most-recent network call hit the server (`online`)
  // or had to fall back to the IndexedDB cache (`offline`). Drives the
  // banner that informs librarians they're working with stale data.
  const [netStatus, setNetStatusUI] = useState<NetStatus>('online');
  useEffect(() => subscribeNetStatus(setNetStatusUI), []);
  // Release the add-book cover preview's object URL when it is replaced or the
  // component unmounts, so staging several covers doesn't leak blobs.
  useEffect(() => {
    if (!createCoverPreview) return;
    return () => URL.revokeObjectURL(createCoverPreview);
  }, [createCoverPreview]);
  // NOTE: the selection deliberately SURVIVES paging, searching, filtering and
  // sorting. It is a set of book ids, and every bulk action resolves those ids
  // to their live rows via GET /api/books/by-ids (which supplies each book's
  // current `version`), so an action always applies to the whole selection —
  // not just the page that happens to be loaded. Only the user clears it, via
  // "Clear selection" (or sign-out); the app never drops it behind their back.
  // Selection is mirrored into sessionStorage so an accidental reload keeps it.
  useEffect(() => {
    try {
      if (selectedBookIds.length === 0) sessionStorage.removeItem(SELECTION_STORAGE_KEY);
      else sessionStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selectedBookIds));
    } catch { /* private mode / quota — selection still works in memory */ }
  }, [selectedBookIds]);
  // Browser-level offline events flip us back to "offline" immediately so
  // we don't have to wait for the next failing fetch to update the UI.
  useEffect(() => {
    const onOffline = () => setNetStatusUI('offline');
    const onOnline = () => setNetStatusUI('online');
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);
  const queuedToastsRef = useRef<Array<{ type: 'success' | 'error'; text: string }>>([]);

  const pushAppToast = useCallback((type: 'success' | 'error', text: string) => {
    if (!text) return;
    if (splashActiveRef.current) {
      queuedToastsRef.current.push({ type, text });
      return;
    }
    toast.push(type, text);
  }, [toast]);

  // Bridge legacy message/error calls to the toast stack while holding
  // notifications until the splash screen is fully gone.
  const setMessage = useCallback((m: string) => {
    pushAppToast('success', m);
  }, [pushAppToast]);
  const setError = useCallback((e: string) => {
    pushAppToast('error', e);
  }, [pushAppToast]);

  const beginSplash = useCallback(() => {
    splashActiveRef.current = true;
    splashStartRef.current = Date.now();
    setSplashHiding(false);
    setShowSplash(true);
  }, []);

  useEffect(() => {
    if (showSplash || queuedToastsRef.current.length === 0) {
      return;
    }
    const queued = queuedToastsRef.current;
    queuedToastsRef.current = [];
    for (const item of queued) {
      toast.push(item.type, item.text);
    }
  }, [showSplash, toast]);

  const loggedIn = Boolean(currentUser);

  // Mirror `loggedIn` into a ref so the module-level 401 handler can tell a real
  // session expiry from the anonymous first-load probe without re-subscribing.
  const loggedInRef = useRef(false);
  useEffect(() => { loggedInRef.current = loggedIn; }, [loggedIn]);

  // Centralized 401 handling: when the server rejects auth after we believed we
  // were signed in (expired token/cookie), drop to the login screen with a clear
  // message instead of leaving the user on a stale shell showing "no books".
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!loggedInRef.current) return; // ignore the anonymous session probe
      setCurrentUser(null);
      setDidBootstrapData(false);
      setMessage(t('login.sessionExpired'));
    });
    return () => setUnauthorizedHandler(null);
  }, [t]);

  // Restore session on first load. Uses the stored bearer token (Safari) or the
  // session cookie (other browsers), whichever is available.
  useEffect(() => {
    apiRequest<SessionResponse>('/api/auth/session')
      .then((res) => {
        beginSplash();
        setCurrentUser(res.user);
      })
      .catch(() => { /* no session */ })
      .finally(() => setSessionLoading(false));
  }, [beginSplash]);

  // Load app data once an authenticated session is available (fresh login or restored cookie session).
  useEffect(() => {
    if (!loggedIn || didBootstrapData) {
      return;
    }

    void refreshEverything().then(() => {
      setDidBootstrapData(true);
    });
  }, [loggedIn, didBootstrapData]);

  // Dismiss the splash screen after 3 seconds minimum AND once data is ready.
  useEffect(() => {
    if (!showSplash) return;
    const dataReady = !sessionLoading && loggedIn && didBootstrapData;
    if (!dataReady) return;
    const elapsed = Date.now() - splashStartRef.current;
    const remaining = Math.max(0, 3000 - elapsed);
    const timer = setTimeout(() => {
      setSplashHiding(true);
      setTimeout(() => {
        splashActiveRef.current = false;
        setShowSplash(false);
      }, 400);
    }, remaining);
    return () => clearTimeout(timer);
  }, [showSplash, sessionLoading, loggedIn, didBootstrapData]);

  // Restore UI preferences (sort, density, theme) from localStorage so the app feels personal across sessions.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw) as { sortBy?: SortBy; sortDir?: SortDir; density?: Density; theme?: Theme };
      if (prefs.sortBy) setSortBy(prefs.sortBy);
      if (prefs.sortDir) setSortDir(prefs.sortDir);
      if (prefs.density) setDensity(prefs.density);
      if (prefs.theme) setTheme(prefs.theme);
      else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) setTheme('dark');
    } catch {
      // Ignore — corrupted prefs shouldn't break the app.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ sortBy, sortDir, density, theme }));
    } catch {
      // Storage may be disabled (private mode); ignore.
    }
  }, [sortBy, sortDir, density, theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Power-user shortcuts: "/" focuses search, "Esc" closes the open detail modal.
  useEffect(() => {
    if (!loggedIn) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (event.key === 'Escape') {
        // Layered dismissal, top-most first: context menu → cover lightbox →
        // detail modal. Each returns so Escape only peels off one layer.
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        // The cover lightbox sits on top of the detail modal, so Escape must
        // close the lightbox FIRST and leave the detail modal open.
        if (coverZoom) {
          setCoverZoom(null);
          return;
        }
        if (detailBook) {
          setDetailBook(null);
          setDetailMode('view');
          setBookHistory([]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loggedIn, detailBook, coverZoom, contextMenu]);

  // Lock the body scroll while any full-screen modal is open. Without this a
  // long detail/profile modal lets the underlying list scroll on touch+wheel,
  // which is jarring on mobile and noticeable on desktops with momentum.
  useEffect(() => {
    const anyOpen = Boolean(detailBook) || profileOpen;
    if (!anyOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [detailBook, profileOpen]);

  const availableBooksFromSummary =
    roomSummary.reduce((sum, room) => sum + Number(room.available_books ?? 0), 0) + Number(unassignedSummary.availableBooks ?? 0);
  const borrowedBooksFromSummary =
    roomSummary.reduce((sum, room) => sum + Number(room.borrowed_books ?? 0), 0) + Number(unassignedSummary.borrowedBooks ?? 0);
  const availableBooksDisplay = fmt(availableBooksFromSummary);
  const borrowedBooksDisplay = fmt(borrowedBooksFromSummary);
  const overdueCount = activeBorrows.filter((item) => item.isOverdue).length;
  const dueSoonCount = activeBorrows.filter((item) => {
    if (item.isOverdue) {
      return false;
    }
    const diffMs = new Date(item.dueAt).getTime() - Date.now();
    return diffMs > 0 && diffMs <= 48 * 60 * 60 * 1000;
  }).length;

  // How many of the currently-visible books are part of the (possibly much
  // larger, cross-page) selection — drives the "select all / deselect" links.
  const selectedOnPageCount = books.reduce((n, b) => (selectedBookIds.includes(b.id) ? n + 1 : n), 0);

  const role = currentUser?.role ?? null;
  const isAdmin = role === 'admin';
  // The onboarding course is MANDATORY (no bypass) on first sign-in for the
  // librarian role — the people who catalogue. Gate on `role` (synchronous from
  // currentUser) rather than a permission so it can't flicker while the
  // permission matrix is still loading. Everyone can replay it from Settings.
  const mustOnboard = role === 'librarian' && Boolean(currentUser?.needsOnboarding);
  // Permission helper: admins always have everything; for other roles consult
  // the matrix fetched from /api/me/permissions. Falls back to `false` until
  // the permissions are loaded.
  const can = (perm: string): boolean => {
    if (isAdmin) return true;
    return Boolean(myPermissions?.[perm]);
  };
  const canWrite = can('books.write');
  const canDelete = can('books.delete');
  const canImport = can('import');
  const canPrintLabels = can('labels.print');
  const canExportCsv = can('export.csv');
  const canManageCustomFields = isAdmin || can('customFields.manage');
  const canSeeSettings = isAdmin || can('settings');
  const canSeeDashboard = isAdmin || can('dashboard');
  const canSeeCirculation = isAdmin || can('circulation');

  const sectionMeta: Array<{ key: AppSection; label: string; icon: string }> = [
    { key: 'books', label: t('tab.books'), icon: '📚' },
    ...(canSeeCirculation ? [{ key: 'circulation' as AppSection, label: t('tab.circulation'), icon: '🔁' }] : []),
    ...(canImport ? [{ key: 'import' as AppSection, label: t('tab.import'), icon: '⇅' }] : []),
    ...(canSeeDashboard ? [{ key: 'dashboard' as AppSection, label: t('tab.dashboard'), icon: '📊' }] : []),
    ...(canSeeSettings ? [{ key: 'settings' as AppSection, label: t('tab.settings'), icon: '⚙️' }] : [])
  ];

  // If the user lands on a section they no longer have access to (after role
  // change or first login as a non-admin), bounce them to the always-visible
  // Library tab so they don't see a blank screen.
  useEffect(() => {
    if (!currentUser) return;
    const allowed = new Set<AppSection>(['books']);
    if (canSeeCirculation) allowed.add('circulation');
    if (canImport) allowed.add('import');
    if (canSeeDashboard) allowed.add('dashboard');
    if (canSeeSettings) allowed.add('settings');
    if (!allowed.has(currentSection)) {
      setCurrentSection('books');
    }
  }, [currentUser, currentSection, canSeeCirculation, canImport, canSeeDashboard, canSeeSettings]);

  // Kept as a no-op for back-compat with call sites; the toast layer auto-
  // dismisses now so we no longer need to wipe state on every action.
  function clearStatus() {
    /* intentional: toasts manage their own lifecycle */
  }

  async function runAction<T>(operation: () => Promise<T>): Promise<T> {
    setIsWorking(true);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setCurrentUser(null);
        setDidBootstrapData(false);
        setError(t('login.sessionExpired'));
      }
      throw error;
    } finally {
      setIsWorking(false);
    }
  }

  // Convert one form-input value into the type the server expects for that
  // custom-field definition. Empty/missing → null (skip from payload).
  function coerceCustomFieldValue(field: CustomField, raw: unknown): unknown {
    if (raw === '' || raw === undefined || raw === null) return null;
    if (field.type === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    if (field.type === 'boolean') {
      if (typeof raw === 'boolean') return raw;
      const t = String(raw).toLowerCase();
      return t === 'true' || t === 'yes' || t === '1' || t === 'on';
    }
    if (field.type === 'date') {
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return String(raw);
  }

  // Walk the form values once and build the {key: value} object the API accepts.
  // Throws when a required field is missing so callers can surface a single
  // error instead of letting the server reject after a round-trip.
  function buildCustomFieldsPayload(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const requiredMissing: string[] = [];
    for (const field of customFields) {
      const raw = values[field.key];
      const empty = raw === undefined || raw === null || raw === '';
      if (field.required && empty) {
        requiredMissing.push(field.label);
        continue;
      }
      if (empty) continue;
      const v = coerceCustomFieldValue(field, raw);
      if (v === null || v === undefined) {
        if (field.required) requiredMissing.push(field.label);
        continue;
      }
      out[field.key] = v;
    }
    if (requiredMissing.length > 0) {
      throw new Error(t('toast.requiredAttrs', { list: requiredMissing.join(', ') }));
    }
    return out;
  }

  function parsePublicationYear(raw: string): number | null {
    if (!raw.trim()) {
      return null;
    }

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 3000) {
      throw new Error(t('toast.invalidYear'));
    }

    return parsed;
  }

  function toNullableText(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const text = String(value).trim();
    return text ? text : null;
  }

  function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }

      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item).trim()).filter(Boolean);
          }
        } catch {
          // Fall back to comma-split.
        }
      }

      return trimmed
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  function parseSpreadsheetCustomFields(row: Record<string, unknown>): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    const explicit = row.customfields;
    if (explicit && typeof explicit === 'string') {
      const trimmed = explicit.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(fields, parsed as Record<string, unknown>);
          }
        } catch {
          throw new Error(t('toast.xlsxCustomFieldsJson'));
        }
      }
    }

    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith('custom.') || key.startsWith('custom_')) {
        const fieldKey = key.replace(/^custom[._]/, '').trim();
        if (!fieldKey) {
          continue;
        }

        if (value === null || value === undefined || String(value).trim() === '') {
          continue;
        }

        fields[fieldKey] = value;
      }
    }

    return fields;
  }

  function findUnknownSpreadsheetColumns(rows: Array<Record<string, unknown>>): string[] {
    const allowedColumns = new Set([
      'title',
      'author',
      'writer',
      'id',
      'item',
      'sub title',
      'subtitle',
      'editor',
      'isbn',
      'publicationyear',
      'published date',
      'place of publication',
      'edition #',
      'edition',
      'category',
      'publisher',
      'language',
      'translator',
      'cover type',
      'pages',
      'condition',
      'shelf location',
      'description',
      'roomcode',
      'shelfcode',
      'acquisitiondate',
      'num. volume',
      'num volume',
      'color',
      'signature',
      'more copies',
      'tags',
      'status',
      'customfields',
      // Stable source key — see LEGACY_ID_ALIASES.
      'legacyid',
      'legacy id',
      'legacy_id',
      'accession',
      'accession number',
      'accessionnumber',
      'catalog id',
      'catalogue id',
      'record id'
    ]);

    const seen = new Set<string>();
    const unknown: string[] = [];

    for (const row of rows) {
      for (const originalKey of Object.keys(row)) {
        const key = originalKey.trim().toLowerCase();
        if (!key) {
          continue;
        }

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        if (allowedColumns.has(key) || key.startsWith('custom.') || key.startsWith('custom_')) {
          continue;
        }

        unknown.push(originalKey);
      }
    }

    return unknown;
  }

  // Column headings that mean "this row's permanent id in the source system".
  // Ordered most-specific first so a sheet with both `accession number` and a
  // generic `id` uses the accession number.
  const LEGACY_ID_ALIASES = [
    'legacyid',
    'legacy id',
    'legacy_id',
    'accession number',
    'accessionnumber',
    'accession',
    'catalogue id',
    'catalog id',
    'record id',
    'id'
  ];

  function firstSpreadsheetValue(row: Record<string, unknown>, aliases: string[]): unknown {
    for (const alias of aliases) {
      const key = alias.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        return row[key];
      }
    }

    return null;
  }

  function parseNullableNumber(value: unknown): number | null {
    const text = toNullableText(value);
    if (!text) {
      return null;
    }

    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeColumnName(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function canonicalColumnName(input: string): string {
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

  function resolveImportCustomKey(preferredKey: string, labelHint: string): string {
    const exact = customFields.find((field) => field.key === preferredKey);
    if (exact) {
      return exact.key;
    }

    // The fuzzy fallback takes the FIRST match, so it must not depend on the
    // order `customFields` happens to be in — that order is a DISPLAY concern
    // (pinned attributes lead the list) and changing it must never silently
    // re-point a spreadsheet column at a different attribute. Scan a copy
    // sorted by key so the mapping is stable whatever the display order is.
    const byKey = [...customFields].sort((a, b) => a.key.localeCompare(b.key));
    const similar = byKey.find(
      (field) => columnsAreSimilar(field.key, preferredKey) || columnsAreSimilar(field.label, labelHint)
    );
    return similar?.key ?? preferredKey;
  }

  function normalizeSpreadsheetRow(raw: Record<string, unknown>, index: number): Record<string, unknown> | null {
    const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.trim().toLowerCase(), value]));

    const isEmptyRow = Object.values(row).every((value) => toNullableText(value) === null);
    if (isEmptyRow) {
      return null;
    }

    const title = toNullableText(firstSpreadsheetValue(row, ['title']));
    // Author is optional (anonymous / liturgical editions). Only the title is
    // required. A blank author is sent as '' so the server schema accepts it
    // (it rejects null) and the row imports instead of being skipped.
    const author = toNullableText(firstSpreadsheetValue(row, ['author', 'writer', 'writers']));
    if (!title) {
      throw new SpreadsheetRowMissingError(t('toast.rowMissing', { row: index + 2 }));
    }

    const statusInput = toNullableText(firstSpreadsheetValue(row, ['status']))?.toLowerCase();
    const status: BookStatus =
      statusInput === 'available' || statusInput === 'borrowed' || statusInput === 'lost' || statusInput === 'maintenance'
        ? statusInput
        : 'available';

    const publicationYearInput = toNullableText(firstSpreadsheetValue(row, ['publicationyear']));
    let publicationYear: number | null = null;
    if (publicationYearInput) {
      publicationYear = parsePublicationYear(publicationYearInput);
    }

    const customFields = parseSpreadsheetCustomFields(row);

    const mappedCustomTextFields: Array<{ key: string; label: string; aliases: string[] }> = [
      { key: 'item', label: 'Item', aliases: ['item'] },
      { key: 'subTitle', label: 'Sub Title', aliases: ['sub title', 'subtitle'] },
      { key: 'editor', label: 'Editor', aliases: ['editor'] },
      { key: 'placeOfPublication', label: 'Place of Publication', aliases: ['place of publication'] },
      { key: 'publishedDate', label: 'Published Date', aliases: ['published date'] },
      { key: 'editionNumber', label: 'Edition #', aliases: ['edition #', 'edition'] },
      { key: 'category', label: 'Category', aliases: ['category'] },
      { key: 'translator', label: 'Translator', aliases: ['translator'] },
      { key: 'coverType', label: 'Cover Type', aliases: ['cover type'] },
      { key: 'condition', label: 'Condition', aliases: ['condition'] },
      { key: 'numVolume', label: 'Num. Volume', aliases: ['num. volume', 'num volume'] },
      { key: 'color', label: 'Color', aliases: ['color'] },
      { key: 'signature', label: 'Signature', aliases: ['signature'] },
      { key: 'moreCopies', label: 'More copies', aliases: ['more copies'] }
    ];

    for (const field of mappedCustomTextFields) {
      const resolvedKey = resolveImportCustomKey(field.key, field.label);
      if (customFields[resolvedKey] !== undefined) {
        continue;
      }

      const value = toNullableText(firstSpreadsheetValue(row, field.aliases));
      if (value !== null) {
        customFields[resolvedKey] = value;
      }
    }

    const pagesValue = parseNullableNumber(firstSpreadsheetValue(row, ['pages']));
    const pagesKey = resolveImportCustomKey('pages', 'Pages');
    if (pagesValue !== null && customFields[pagesKey] === undefined) {
      customFields[pagesKey] = pagesValue;
    }

    const numVolumeValue = parseNullableNumber(firstSpreadsheetValue(row, ['num. volume', 'num volume']));
    const numVolumeKey = resolveImportCustomKey('numVolume', 'Num. Volume');
    if (numVolumeValue !== null && customFields[numVolumeKey] === undefined) {
      customFields[numVolumeKey] = numVolumeValue;
    }

    const moreCopiesValue = parseNullableNumber(firstSpreadsheetValue(row, ['more copies']));
    const moreCopiesKey = resolveImportCustomKey('moreCopies', 'More copies');
    if (moreCopiesValue !== null && customFields[moreCopiesKey] === undefined) {
      customFields[moreCopiesKey] = moreCopiesValue;
    }

    return {
      title,
      author: author ?? '',
      // The sheet's own identifier for the record. Sending it lets a corrected
      // re-upload UPDATE the books it already created instead of adding a
      // second copy of each one.
      legacyId: toNullableText(firstSpreadsheetValue(row, LEGACY_ID_ALIASES)),
      isbn: toNullableText(firstSpreadsheetValue(row, ['isbn'])),
      publicationYear,
      publisher: toNullableText(firstSpreadsheetValue(row, ['publisher'])),
      language: toNullableText(firstSpreadsheetValue(row, ['language'])),
      description: toNullableText(firstSpreadsheetValue(row, ['description'])),
      roomCode: toNullableText(firstSpreadsheetValue(row, ['roomcode'])),
      shelfCode: toNullableText(firstSpreadsheetValue(row, ['shelfcode', 'shelf location'])),
      acquisitionDate: toNullableText(firstSpreadsheetValue(row, ['acquisitiondate'])),
      tags: parseStringArray(firstSpreadsheetValue(row, ['tags'])),
      customFields,
      status
    };
  }

  async function refreshEverything() {
    const isAdminUser = currentUser?.role === 'admin';
    await Promise.all([
      loadBooks(),
      loadRoomSummary(),
      loadCustomFields(),
      loadFacets(),
      loadActiveBorrows(),
      // audit logs + staff users are admin-only endpoints — loading them for a
      // librarian/viewer is a guaranteed 403 + a wasted Workers request each.
      ...(isAdminUser ? [loadAuditLogs(), loadStaffUsers()] : []),
      loadCategories(),
      loadNeedsReviewCount(),
      loadStats(),
      loadMyPermissions()
    ]);
  }

  // Borrower autocomplete: debounced server search; result rows let the user pick
  // an existing borrower instead of typing a duplicate name. We use a sequence
  // counter to drop stale responses (a slow earlier request returning after a
  // newer one would otherwise clobber the suggestions list).
  async function searchBorrowers(query: string): Promise<void> {
    const seq = ++borrowerSearchSeqRef.current;
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      params.set('limit', '8');
      const response = await apiRequest<{ items: Borrower[] }>(`/api/borrowers?${params.toString()}`);
      if (seq !== borrowerSearchSeqRef.current) return;
      setBorrowerSuggestions(response.items ?? []);
      setBorrowerHighlight(-1);
    } catch {
      if (seq !== borrowerSearchSeqRef.current) return;
      setBorrowerSuggestions([]);
      setBorrowerHighlight(-1);
    }
  }

  // Debounced wrapper. Coalesces a burst of keystrokes into a single
  // request while the sequence counter inside `searchBorrowers` still
  // guards against out-of-order responses. 180 ms is short enough to feel
  // instant while collapsing typical fast-typing bursts.
  function scheduleBorrowerSearch(query: string): void {
    if (borrowerDebounceRef.current !== null) {
      window.clearTimeout(borrowerDebounceRef.current);
    }
    borrowerDebounceRef.current = window.setTimeout(() => {
      borrowerDebounceRef.current = null;
      void searchBorrowers(query);
    }, 180);
  }

  // Apply a suggestion picked via keyboard or pointer. Shared between the
  // dropdown's onMouseDown and the input's keyboard handler so Enter and
  // click do exactly the same thing.
  function applyBorrowerSuggestion(b: Borrower) {
    setSelectedBorrowerId(b.id);
    setBorrowerName(b.name);
    setBorrowerContact(b.contact ?? '');
    setBorrowerQuery('');
    setBorrowerSuggestions([]);
    setBorrowerHighlight(-1);
  }

  async function uploadBookCover(book: Book, file: File): Promise<void> {
    clearStatus();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setError(t('toast.coverInvalidType'));
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError(t('toast.coverTooLarge'));
      return;
    }
    try {
      const res = await runAction(() =>
        apiRequest<{ ok: boolean; coverUrl: string; version: number }>(`/api/books/${book.id}/cover`, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file
        }, false)
      );
      setMessage(t('toast.coverUpdated', { title: book.title }));
      // Keep the in-memory book's version in step with the server bump so a
      // subsequent metadata edit doesn't send a stale version and 409.
      setDetailBook((prev) =>
        prev && prev.id === book.id
          ? { ...prev, coverUrl: `/api/books/${book.id}/cover?v=${Date.now()}`, version: res.version ?? prev.version }
          : prev
      );
      setEditForm((prev) => (prev.id === book.id && res.version !== undefined ? { ...prev, version: res.version } : prev));
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteBookCover(book: Book): Promise<void> {
    const ok = await confirm({
      title: t('confirm.removeCoverTitle'),
      body: t('confirm.removeCoverBody'),
      confirmLabel: t('confirm.removeCoverAction'),
      danger: true
    });
    if (!ok) return;
    clearStatus();
    try {
      const res = await runAction(() => apiRequest<{ ok: boolean; version: number }>(`/api/books/${book.id}/cover`, { method: 'DELETE' }));
      setMessage(t('toast.coverRemoved'));
      setDetailBook((prev) => (prev && prev.id === book.id ? { ...prev, coverUrl: null, version: res?.version ?? prev.version } : prev));
      setEditForm((prev) => (prev.id === book.id && res?.version !== undefined ? { ...prev, version: res.version } : prev));
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Validate + stage a cover chosen in the add-book form. The same JPEG/PNG/
  // WebP/GIF + 4 MB limits as the server (and the detail-view uploader) are
  // enforced up front so the librarian gets immediate feedback.
  function selectCreateCover(file: File): void {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setError(t('toast.coverInvalidType'));
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError(t('toast.coverTooLarge'));
      return;
    }
    setCreateCoverFile(file);
    // Effect below revokes the previous object URL when this value changes.
    setCreateCoverPreview(URL.createObjectURL(file));
  }

  function clearCreateCover(): void {
    setCreateCoverFile(null);
    setCreateCoverPreview(null);
  }

  async function printLabels(targets: Book[]): Promise<void> {
    if (targets.length === 0) return;
    clearStatus();
    try {
      // Lazy-load the QR generator only when the user actually needs it.
      const labels = await import('./labels');
      await labels.openPrintLabels(targets, API_BASE, {
        docTitle: t('labels.docTitle', { n: targets.length }),
        ready: t('labels.ready', { n: targets.length, s: targets.length === 1 ? '' : 's' }),
        print: t('labels.print'),
        close: t('labels.close'),
        toolbarHint: t('labels.toolbarHint'),
        popupBlocked: t('labels.popupBlocked'),
        untitled: t('common.untitled'),
        unknown: t('common.unknown'),
        htmlLang: lang
      });
      setMessage(t('toast.printOpened', { n: targets.length, s: targets.length === 1 ? '' : 's' }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadStats() {
    const cached = await cacheGet<StatsResponse>('GET /api/stats');
    if (cached) setStats(cached.value);
    try {
      const response = await apiRequest<StatsResponse>('/api/stats');
      setStats(response);
    } catch {
      if (!cached) setStats(null);
    }
  }

  async function loadCategories() {
    const cached = await cacheGet<{ items: CategoryItem[] }>('GET /api/categories');
    if (cached) setCategories(cached.value.items ?? []);
    try {
      const response = await apiRequest<{ items: CategoryItem[] }>('/api/categories');
      setCategories(response.items ?? []);
    } catch {
      if (!cached) setCategories([]);
    }
  }

  async function loadNeedsReviewCount() {
    const cached = await cacheGet<{ count: number }>('GET /api/needs-review-count');
    if (cached) setNeedsReviewCount(cached.value.count ?? 0);
    try {
      const response = await apiRequest<{ count: number }>('/api/needs-review-count');
      setNeedsReviewCount(response.count ?? 0);
    } catch {
      if (!cached) setNeedsReviewCount(0);
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    try {
      const response = await runAction(() => apiRequest<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      }));
      // Persist the bearer token so authenticated requests work even when the
      // cross-site session cookie is blocked (Safari/WebKit).
      if (response.token) setAuthToken(response.token);
      beginSplash();
      setCurrentUser(response.user);
      setDidBootstrapData(false);
      setMessage(t('login.welcome', { username: response.user.username }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function logout() {
    clearStatus();
    try {
      await runAction(() => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }));
    } catch {
      // Keep sign-out resilient even if network request fails.
    }

    // Drop the bearer token and wipe the local response cache so the next user
    // (or re-login) cannot see another account's data even briefly.
    setAuthToken(null);
    void cacheClear();

    setCurrentUser(null);
    setDidBootstrapData(false);
    splashActiveRef.current = false;
    setShowSplash(false);
    setSplashHiding(false);
    setBooks([]);
    setCustomFields([]);
    setActiveBorrows([]);
    setAuditItems([]);
    setStaffUsers([]);
    setBookHistory([]);
    setCategories([]);
    setMyPermissions(null);
    setPermissionMatrix(null);
    setShowOnboarding(false);
    // Drop the bulk selection too. It is persisted in sessionStorage, so without
    // this the NEXT librarian to sign in on the same tab would inherit the
    // previous one's selection — and a bulk action would silently hit books
    // they never chose and cannot see.
    setSelectedBookIds([]);
    setSelectionMode(false);
    setMessage(t('login.signedOut'));
  }

  // Mark the onboarding course complete server-side and clear the mandatory
  // gate locally so the librarian lands in the app. Best-effort: even if the
  // POST fails we let them through (they can replay from Settings), but we keep
  // needsOnboarding true so it retries next login rather than silently skipping.
  async function completeOnboarding() {
    try {
      await apiRequest<{ ok: boolean }>('/api/me/onboarding-complete', { method: 'POST' });
    } catch (e) {
      // Never trap a librarian behind the mandatory course. If the server call
      // fails (offline, 500, quota) we still let them into the app — the flag
      // stays set server-side, so the course simply reappears next sign-in.
      setError((e as Error).message);
    } finally {
      setCurrentUser((prev) => (prev ? { ...prev, needsOnboarding: false } : prev));
      setShowOnboarding(false);
    }
  }

  function openProfile() {
    if (!currentUser) return;
    setProfileUsername(currentUser.username);
    setProfileNewPassword('');
    setProfileCurrentPassword('');
    setProfileOpen(true);
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!currentUser) return;
    if (!profileCurrentPassword) {
      toast.push('error', t('profile.errCurrent'));
      return;
    }
    const usernameChanged = profileUsername.trim() && profileUsername.trim() !== currentUser.username;
    const passwordChanged = Boolean(profileNewPassword);
    if (!usernameChanged && !passwordChanged) {
      toast.push('error', t('profile.errNoChange'));
      return;
    }
    if (passwordChanged && profileNewPassword.length < 8) {
      toast.push('error', t('users.errPasswordShort'));
      return;
    }
    setProfileSubmitting(true);
    try {
      const body: Record<string, string> = { currentPassword: profileCurrentPassword };
      if (usernameChanged) body.username = profileUsername.trim();
      if (passwordChanged) body.newPassword = profileNewPassword;
      const res = await apiRequest<{ user: { id: string; username: string; role: string } }>(
        '/api/me',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      setCurrentUser(res.user);
      toast.push('success', t('profile.saved'));
      setProfileOpen(false);
      setProfileNewPassword('');
      setProfileCurrentPassword('');
    } catch (err) {
      toast.push('error', (err as Error).message);
    } finally {
      setProfileSubmitting(false);
    }
  }

  async function applyDefaultBookStructure() {
    clearStatus();
    try {
      const result = await runAction(() =>
        apiRequest<{ ok: boolean; configuredCustomColumns: number; skippedAsSimilar?: string[] }>(
          '/api/setup/default-book-structure',
          {
            method: 'POST'
          }
        )
      );
      await loadCustomFields();
      const skippedCount = result.skippedAsSimilar?.length ?? 0;
      if (skippedCount > 0) {
        setMessage(
          t('toast.defaultStructureSkipped', { added: result.configuredCustomColumns, skipped: skippedCount })
        );
      } else {
        setMessage(t('toast.defaultStructureAdded', { added: result.configuredCustomColumns }));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const loadBooks = useCallback(async (pageOverride?: number) => {
    const seq = ++loadBooksSeqRef.current;
    const isStale = () => seq !== loadBooksSeqRef.current;
    setIsLoadingBooks(true);
    setBooksError(null);
    try {
      const page = pageOverride ?? currentPage;

      // ── Semantic mode ─────────────────────────────────────────────────
      // Vectorize doesn't speak filters/sort/pagination the same way SQL
      // does, so when the user is in semantic mode we send only `q` and
      // render the ANN-ranked result list. Filters/sort still apply
      // client-side once we have the rows. Empty query short-circuits.
      if (searchEngine === 'semantic') {
        if (!q.trim()) {
          setBooks([]);
          setTotalBooksCount(0);
          setCurrentPage(1);
          return;
        }
        const semanticParams = new URLSearchParams({ q, topK: '50' });
        const cacheKey = `GET /api/books/semantic?${semanticParams.toString()}`;
        const cached = await cacheGet<{ items: Book[]; total: number }>(cacheKey);
        if (cached && !isStale()) {
          setBooks(cached.value.items);
          setTotalBooksCount(cached.value.total);
          setCurrentPage(1);
        }
        try {
          const response = await apiRequest<{ items: Book[]; total: number }>(
            `/api/books/semantic?${semanticParams.toString()}`
          );
          if (isStale()) return;
          setBooks(response.items);
          setTotalBooksCount(response.total);
          setCurrentPage(1);
        } catch (e) {
          // 503 indicates the server doesn't have Vectorize+AI bound; flip
          // the availability flag and fall back to lexical so the user
          // isn't stuck on a broken mode.
          const err = e as Error & { status?: number };
          if (err.status === 503) {
            setSemanticAvailable(false);
            setSearchEngine('lexical');
            setError(t('library.adv.semanticOff'));
          } else if (!cached) {
            setBooksError(err.message);
            setError(err.message);
          }
        }
        return;
      }

      const query = buildBookFilterParams({
        q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
        status, filterLanguage, filterYear, categoryFilter,
        needsReviewFilter, shelfFilter, smartListKey, smartLists: SMART_LISTS
      });
      query.set('sortBy', sortBy);
      query.set('sortDir', sortDir);
      query.set('page', page.toString());
      query.set('pageSize', String(PAGE_SIZE));

      const cacheKey = `GET /api/books?${query.toString()}`;
      const cached = await cacheGet<{ items: Book[]; total: number }>(cacheKey);
      if (cached && !isStale()) {
        setBooks(cached.value.items);
        setTotalBooksCount(cached.value.total);
        setCurrentPage(page);
      }
      try {
        const response = await apiRequest<{ items: Book[]; total: number }>(`/api/books?${query.toString()}`);
        if (isStale()) return;
        // Clamp: if deleting the last row(s) on the last page left `page` beyond
        // the end, re-fetch the now-last page instead of showing an empty grid
        // with a "Page N of N-1" footer.
        const lastPage = Math.max(1, Math.ceil(response.total / PAGE_SIZE));
        if (page > lastPage && response.total > 0) {
          void loadBooks(lastPage);
          return;
        }
        setBooks(response.items);
        setTotalBooksCount(response.total);
        setCurrentPage(page);
      } catch (e) {
        // Don't let a failed fetch masquerade as an empty library: record a
        // dedicated error so the list area can render a retry affordance. The
        // cache fallback (if any) still populated `books` above.
        if (!cached) setBooksError((e as Error).message);
        setError((e as Error).message);
      }
    } finally {
      setIsLoadingBooks(false);
    }
  }, [
    currentPage, q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
    status, filterLanguage, filterYear, categoryFilter, needsReviewFilter,
    shelfFilter, sortBy, sortDir, smartListKey, searchEngine, t, setError
  ]);

  // Debounced auto-search: any change to query/filters/sort re-fetches books on page 1.
  useEffect(() => {
    if (!loggedIn || !didBootstrapData) return;
    const signature = JSON.stringify({
      q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
      status, filterLanguage, filterYear, categoryFilter, needsReviewFilter,
      shelfFilter, sortBy, sortDir, smartListKey, searchEngine
    });
    if (signature === lastSearchSignatureRef.current) return;
    lastSearchSignatureRef.current = signature;
    const handle = window.setTimeout(() => {
      void loadBooks(1);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    loggedIn, didBootstrapData,
    q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
    status, filterLanguage, filterYear, categoryFilter, needsReviewFilter,
    shelfFilter, sortBy, sortDir, smartListKey, searchEngine,
    loadBooks
  ]);

  // Probe the server's /api/health on first login to learn whether the
  // optional Vectorize + AI bindings are configured. We don't have a
  // dedicated capability endpoint, but health already reports DB/KV/R2 and
  // adding a hint keeps the network surface small.
  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest<{ ok: boolean; semantic?: boolean }>('/api/health');
        if (cancelled) return;
        // The server tells us via an explicit flag (added below). Until the
        // flag rolls out we leave the toggle enabled and let the loadBooks
        // 503 handler flip it off after the first attempt.
        setSemanticAvailable(res.semantic ?? null);
      } catch {
        if (!cancelled) setSemanticAvailable(null);
      }
    })();
    return () => { cancelled = true; };
  }, [loggedIn]);

  async function loadCustomFields() {
    const cached = await cacheGet<{ items: CustomField[] }>('GET /api/custom-fields');
    if (cached) setCustomFields(cached.value.items);
    try {
      const response = await apiRequest<{ items: CustomField[] }>('/api/custom-fields');
      setCustomFields(response.items);
    } catch (e) {
      if (!cached) setError((e as Error).message);
    }
  }

  // Load the distinct catalog values that power predictive autocomplete on the
  // cataloguing forms AND the search filters. Read-economical: cached server-side
  // (KV, version-keyed) and client-side (IndexedDB), so it's ~one request per
  // session and zero requests per keystroke (the datalist filters client-side).
  // Available to all roles now (search helps viewers too). A fetch failure is
  // swallowed — autocomplete just degrades to no suggestions.
  const loadFacets = useCallback(async () => {
    const cached = await cacheGet<CatalogFacets>('GET /api/books/facets');
    if (cached) setFacets(cached.value);
    try {
      const response = await apiRequest<CatalogFacets>('/api/books/facets');
      setFacets(response);
    } catch {
      /* ignore — autocomplete degrades gracefully to no suggestions */
    }
  }, []);

  // Refresh autocomplete suggestions whenever a book form opens (the add panel
  // or the detail editor). Re-opening after an import or bulk edit re-fetches,
  // so new values show up without a page reload.
  useEffect(() => {
    if (showAddBook || detailMode === 'edit') void loadFacets();
  }, [showAddBook, detailMode, loadFacets]);

  async function loadRoomSummary() {
    type RoomSummaryResponse = {
      items: RoomSummaryItem[];
      unassigned: {
        totalBooks: number;
        availableBooks: number;
        borrowedBooks: number;
        lostBooks: number;
        maintenanceBooks: number;
      };
    };
    const cached = await cacheGet<RoomSummaryResponse>('GET /api/rooms/summary');
    if (cached) {
      setRoomSummary(cached.value.items ?? []);
      setUnassignedSummary(cached.value.unassigned);
    }
    try {
      const response = await apiRequest<RoomSummaryResponse>('/api/rooms/summary');
      setRoomSummary(response.items ?? []);
      setUnassignedSummary(response.unassigned);
    } catch (e) {
      if (!cached) setError((e as Error).message);
    }
  }

  async function loadActiveBorrows() {
    // Active-loan data is patron PII and the endpoint is now circulation-gated;
    // viewers (no circulation) would get a 403. Skip the fetch for them so login
    // doesn't surface a spurious error and we don't hammer a forbidden endpoint.
    if (!canSeeCirculation) {
      setActiveBorrows([]);
      return;
    }
    const cached = await cacheGet<{ items: ActiveBorrow[] }>('GET /api/borrow/active');
    if (cached) setActiveBorrows(cached.value.items ?? []);
    try {
      const response = await apiRequest<{ items: ActiveBorrow[] }>('/api/borrow/active');
      setActiveBorrows(response.items ?? []);
    } catch (e) {
      if (!cached) setError((e as Error).message);
    }
  }

  async function loadAuditLogs() {
    try {
      const response = await apiRequest<{ items: AuditLogItem[] }>('/api/audit-logs?page=1&pageSize=8');
      setAuditItems(response.items ?? []);
    } catch {
      // Non-admin users may not have access to audit logs; keep UI silent.
      setAuditItems([]);
    }
  }

  async function loadStaffUsers() {
    setStaffUsersLoading(true);
    try {
      const response = await apiRequest<{ items: StaffUser[] }>('/api/users');
      setStaffUsers(response.items ?? []);
    } catch {
      // Non-admin users can't list users; clear and stay silent.
      setStaffUsers([]);
    } finally {
      setStaffUsersLoading(false);
    }
  }

  async function loadMyPermissions() {
    try {
      const res = await apiRequest<{ catalog: string[]; permissions: Record<string, boolean> }>('/api/me/permissions');
      setMyPermissions(res.permissions);
    } catch {
      setMyPermissions(null);
    }
  }

  async function loadPermissionMatrix() {
    setPermissionMatrixLoading(true);
    try {
      const res = await apiRequest<{
        catalog: string[];
        matrix: Record<'admin' | 'librarian' | 'viewer', Record<string, boolean>>;
      }>('/api/role-permissions');
      setPermissionMatrix(res);
    } catch {
      setPermissionMatrix(null);
    } finally {
      setPermissionMatrixLoading(false);
    }
  }

  function togglePermissionCell(role: 'librarian' | 'viewer', perm: string) {
    setPermissionMatrix((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        matrix: {
          ...prev.matrix,
          [role]: { ...prev.matrix[role], [perm]: !prev.matrix[role][perm] }
        }
      };
    });
  }

  async function savePermissionMatrix() {
    if (!permissionMatrix) return;
    setPermissionMatrixSaving(true);
    try {
      const res = await apiRequest<{
        catalog: string[];
        matrix: Record<'admin' | 'librarian' | 'viewer', Record<string, boolean>>;
      }>('/api/role-permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matrix: {
            librarian: permissionMatrix.matrix.librarian,
            viewer: permissionMatrix.matrix.viewer
          }
        })
      });
      setPermissionMatrix(res);
      // The current user might be affected; refresh their effective perms.
      await loadMyPermissions();
      toast.push('success', t('roles.saved'));
    } catch (err) {
      toast.push('error', (err as Error).message);
    } finally {
      setPermissionMatrixSaving(false);
    }
  }

  async function createStaffUser(event: FormEvent) {
    event.preventDefault();
    const username = newUserUsername.trim();
    const password = newUserPassword;
    if (!username || !password) {
      toast.push('error', t('users.errMissing'));
      return;
    }
    try {
      await runAction(() => apiRequest<{ user: StaffUser }>('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, role: newUserRole })
      }));
      setNewUserUsername('');
      setNewUserPassword('');
      setNewUserRole('viewer');
      toast.push('success', t('users.created', { username }));
      await loadStaffUsers();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function updateStaffUserRole(user: StaffUser, role: StaffRole) {
    if (user.role === role) return;
    try {
      await runAction(() => apiRequest<{ user: StaffUser }>(`/api/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ role })
      }));
      toast.push('success', t('users.roleUpdated', { username: user.username }));
      await loadStaffUsers();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function toggleStaffUserActive(user: StaffUser) {
    const nextActive = user.active === 1 ? false : true;
    try {
      await runAction(() => apiRequest<{ user: StaffUser }>(`/api/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: nextActive })
      }));
      toast.push('success', nextActive
        ? t('users.activated', { username: user.username })
        : t('users.deactivated', { username: user.username }));
      await loadStaffUsers();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function resetStaffUserPassword(user: StaffUser) {
    const password = editUserPassword;
    if (!password || password.length < 8) {
      toast.push('error', t('users.errPasswordShort'));
      return;
    }
    try {
      await runAction(() => apiRequest<{ user: StaffUser }>(`/api/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password })
      }));
      setEditingUserId(null);
      setEditUserPassword('');
      toast.push('success', t('users.passwordReset', { username: user.username }));
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  async function deleteStaffUser(user: StaffUser) {
    const ok = await confirm({
      title: t('users.confirmDeleteTitle', { username: user.username }),
      body: t('users.confirmDeleteBody'),
      confirmLabel: t('common.delete'),
      danger: true
    });
    if (!ok) return;
    try {
      await runAction(() => apiRequest<{ ok: boolean }>(`/api/users/${user.id}`, { method: 'DELETE' }));
      toast.push('success', t('users.deleted', { username: user.username }));
      await loadStaffUsers();
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  // ── ISBN enrichment ─────────────────────────────────────────────────────
  // Pulls metadata from OpenLibrary + Google Books via the worker proxy and
  // fills any EMPTY fields in the Add Book form. We never overwrite a field
  // the librarian has already filled in — the lookup is a convenience, not a
  // policy enforcer.
  const [isbnLookupBusy, setIsbnLookupBusy] = useState(false);

  type IsbnLookupResult = {
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

  async function enrichFromIsbn(): Promise<void> {
    const isbnRaw = createForm.isbn.trim();
    if (!isbnRaw) {
      pushAppToast('error', t('library.add.lookupNoIsbn'));
      return;
    }
    setIsbnLookupBusy(true);
    try {
      // Strip everything but digits/X — same sanitization the server does,
      // but doing it on the client too means the URL is clean and the
      // browser cache key stable for repeat lookups.
      const clean = isbnRaw.replace(/[^0-9Xx]/g, '');
      const res = await apiRequest<IsbnLookupResult>(`/api/lookup/isbn/${encodeURIComponent(clean)}?source=both`);
      if (res.source === 'none') {
        pushAppToast('error', t('library.add.lookupNone'));
        return;
      }
      let filled = 0;
      setCreateForm((prev) => {
        const next = { ...prev };
        const set = (k: keyof typeof prev, v: string | null | undefined) => {
          if (!v) return;
          if (prev[k] && prev[k].toString().trim().length > 0) return; // don't overwrite
          (next as Record<string, string>)[k] = String(v);
          filled += 1;
        };
        set('title', res.title);
        set('author', res.author);
        set('publisher', res.publisher);
        set('language', res.language);
        set('description', res.description);
        if (res.publicationYear) {
          if (!prev.publicationYear || prev.publicationYear.trim() === '') {
            next.publicationYear = String(res.publicationYear);
            filled += 1;
          }
        }
        return next;
      });
      // Bonus: if there's a `pages` custom field defined and it's currently
      // blank, prefill it too. Keeps the catalog UX consistent with the
      // existing pages field used by the LIBRARY catalogue import.
      if (res.pages !== null && res.pages !== undefined) {
        const pagesField = customFields.find((f) => f.key === 'pages' && f.type === 'number');
        if (pagesField && (createAttrValues[pagesField.key] === undefined || createAttrValues[pagesField.key] === '')) {
          setCreateAttrValues((prev) => ({ ...prev, [pagesField.key]: res.pages as number }));
          filled += 1;
        }
      }
      if (filled === 0) {
        // Found a record but every field was already filled in.
        pushAppToast('success', t('library.add.lookupOk', { n: 0, source: res.source }));
      } else {
        pushAppToast('success', t('library.add.lookupOk', { n: filled, source: res.source }));
      }
    } catch (e) {
      pushAppToast('error', t('library.add.lookupError', { message: (e as Error).message }));
    } finally {
      setIsbnLookupBusy(false);
    }
  }

  async function createBook(event: FormEvent) {
    event.preventDefault();
    clearStatus();
    setDuplicateWarning([]);

    // Required-field gate (client side). A book must have a title, and every
    // admin-marked-required custom field must be filled. Block the submit,
    // highlight the offending fields, and focus the first one — instead of
    // creating a junk "(Untitled)" record or bouncing off the server.
    const errorKeys = new Set<string>();
    const missingLabels: string[] = [];
    if (!createForm.title.trim()) {
      errorKeys.add('title');
      missingLabels.push(t('library.add.bookTitle'));
    }
    for (const field of customFields) {
      if (!field.required) continue;
      const raw = createAttrValues[field.key];
      if (raw === undefined || raw === null || raw === '') {
        errorKeys.add(`cf:${field.key}`);
        missingLabels.push(field.label);
      }
    }
    setCreateFieldErrors(errorKeys);
    if (missingLabels.length > 0) {
      setError(t('toast.requiredFields', { list: missingLabels.join(', ') }));
      if (errorKeys.has('title')) titleInputRef.current?.focus();
      return;
    }

    try {
      const customFieldsValue = buildCustomFieldsPayload(createAttrValues);
      const publicationYear = parsePublicationYear(createForm.publicationYear);
      const result = await runAction(() => apiRequest<{ id: string; duplicateOf?: DuplicateEntry[] }>('/api/books', {
        method: 'POST',
        body: JSON.stringify({
          title: createForm.title.trim(),
          author: createForm.author.trim(),
          isbn: createForm.isbn.trim() || null,
          shelfCode: createForm.shelfCode.trim() || null,
          publisher: createForm.publisher.trim() || null,
          language: createForm.language.trim() || null,
          description: createForm.description.trim() || null,
          publicationYear,
          tags: [],
          customFields: customFieldsValue,
          status: 'available'
        })
      }));

      // Grab the staged cover before we reset the form state below.
      const coverFile = createCoverFile;

      setCreateForm({
        title: '',
        author: '',
        isbn: '',
        shelfCode: '',
        publicationYear: '',
        publisher: '',
        language: '',
        description: ''
      });
      setCreateFieldErrors(new Set());
      setCreateAttrValues({});
      clearCreateCover();
      setShowAddBook(false);

      if (result.duplicateOf && result.duplicateOf.length > 0) {
        setDuplicateWarning(result.duplicateOf);
        setMessage(t('toast.bookAddedDuplicate'));
      } else {
        setMessage(t('toast.bookAdded'));
      }

      // Upload the cover now that the book row exists. Failure here is
      // non-fatal — the book was created — so we keep the success message and
      // add a soft warning toast instead of throwing the whole flow away.
      if (coverFile) {
        try {
          await apiRequest<{ ok: boolean; coverUrl: string }>(`/api/books/${result.id}/cover`, {
            method: 'PUT',
            headers: { 'Content-Type': coverFile.type },
            body: coverFile
          }, false);
        } catch (e) {
          pushAppToast('error', t('toast.bookAddedCoverFailed', { message: (e as Error).message }));
        }
      }

      await Promise.all([loadBooks(), loadRoomSummary(), loadCategories(), loadNeedsReviewCount()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function checkDuplicates() {
    clearStatus();
    try {
      const result = await runAction(() =>
        apiRequest<{ total: number; groups: DuplicateGroup[] }>('/api/books/duplicates')
      );
      setDuplicateGroups(result.groups ?? []);
      setShowDuplicatesPanel(true);
      if (result.total === 0) {
        setMessage(t('toast.noDuplicates'));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Scan a field for spelling variants that fold to the same value (the
  // librarians' natural casing/accent inconsistencies).
  async function loadValueVariants(field: VariantField) {
    clearStatus();
    setVariantField(field);
    setVariantsLoading(true);
    try {
      const res = await apiRequest<{ field: string; groups: ValueVariantGroup[] }>(
        `/api/books/value-variants?field=${encodeURIComponent(field)}`
      );
      setValueVariants(res.groups ?? []);
      setVariantsScanned(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVariantsLoading(false);
    }
  }

  // Merge every spelling in a group into the chosen canonical form.
  async function consolidateVariantGroup(field: VariantField, group: ValueVariantGroup, canonical: string) {
    const to = canonical.trim();
    const from = group.variants.map((v) => v.value).filter((v) => v !== to);
    if (!to || from.length === 0) return;
    const affected = group.variants.filter((v) => v.value !== to).reduce((sum, v) => sum + v.count, 0);
    const ok = await confirm({
      title: t('settings.vc.confirmTitle'),
      body: t('settings.vc.confirmBody', { n: affected, to }),
      confirmLabel: t('settings.vc.merge')
    });
    if (!ok) return;
    clearStatus();
    try {
      const res = await runAction(() => apiRequest<{ updated: number }>('/api/admin/consolidate-value', {
        method: 'POST',
        body: JSON.stringify({ field, from, to })
      }));
      setMessage(t('settings.vc.merged', { n: res.updated, to }));
      await Promise.all([loadValueVariants(field), loadBooks(), loadFacets()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function normalizeAllBooks() {
    clearStatus();
    try {
      let offset = 0;
      let totalUpdated = 0;
      let totalBooks = 0;

      while (true) {
        const result = await apiRequest<{
          processed: number; updated: number; offset: number; nextOffset: number; totalBooks: number;
        }>(`/api/admin/normalize-books?limit=500&offset=${offset}`, { method: 'POST' });

        totalUpdated += result.updated;
        totalBooks = result.totalBooks;

        if (result.processed < 500) break;
        offset = result.nextOffset;
      }

      setMessage(t('toast.normalizedAll', { updated: totalUpdated, total: totalBooks }));
      if (totalUpdated > 0) await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Rebuild the full-text search index. Recomputes the diacritic folds for every
  // book so accent-insensitive search is correct again after a catalog import.
  // Loops the paginated endpoint until the server reports `done`.
  async function rebuildSearchIndex() {
    clearStatus();
    try {
      let offset = 0;
      let totalRebuilt = 0;
      let totalBooks = 0;

      while (true) {
        const result = await apiRequest<{
          processed: number; rebuilt: number; offset: number; nextOffset: number | null; totalBooks: number; done: boolean;
        }>(`/api/admin/rebuild-search-index?limit=500&offset=${offset}`, { method: 'POST' });

        totalRebuilt += result.rebuilt;
        totalBooks = result.totalBooks;

        if (result.done || result.nextOffset === null) break;
        offset = result.nextOffset;
      }

      setMessage(t('toast.rebuiltSearchIndex', { rebuilt: totalRebuilt, total: totalBooks }));
      if (totalRebuilt > 0) await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function beginEdit(book: Book) {
    setEditForm({
      id: book.id,
      title: book.title,
      author: book.author,
      isbn: book.isbn ?? '',
      shelfCode: book.shelfCode ?? '',
      publicationYear: book.publicationYear?.toString() ?? '',
      status: book.status,
      version: book.version,
      publisher: book.publisher ?? '',
      language: book.language ?? '',
      description: book.description ?? ''
    });
    setCurrentSection('books');
    setAttributeEditorValues(book.customFields ?? {});
    void loadBookHistory(book.id);
  }

  async function loadBookHistory(bookId: string, offset = 0) {
    if (!bookId) {
      return;
    }
    // Viewers don't have circulation access; skip the fetch (also avoids
    // surfacing a 403 toast when opening a book detail).
    if (!canSeeCirculation) {
      setBookHistory([]);
      setBookHistoryHasMore(false);
      return;
    }

    // Drop responses for books the user has already navigated away from.
    // Without this guard, switching detail panes quickly can leave the wrong
    // book's history rendered against a different book's data.
    const seq = ++bookHistorySeqRef.current;
    try {
      const response = await apiRequest<{ bookId: string; items: BorrowHistoryItem[]; hasMore?: boolean }>(
        `/api/books/${bookId}/history?limit=20&offset=${offset}`
      );
      if (seq !== bookHistorySeqRef.current) return;
      // offset 0 replaces (fresh open); a later offset appends (load more).
      setBookHistory((prev) => (offset > 0 ? [...prev, ...(response.items ?? [])] : (response.items ?? [])));
      setBookHistoryHasMore(Boolean(response.hasMore));
    } catch {
      if (seq !== bookHistorySeqRef.current) return;
      if (offset === 0) setBookHistory([]);
      setBookHistoryHasMore(false);
    }
  }

  async function saveBookEdit(event: FormEvent) {
    event.preventDefault();
    if (!editForm.id) return;
    clearStatus();

    // Same required-field gate as the add form: never let an edit blank out the
    // title or clear a required custom field.
    const errorKeys = new Set<string>();
    const missingLabels: string[] = [];
    if (!editForm.title.trim()) {
      errorKeys.add('title');
      missingLabels.push(t('detail.title'));
    }
    for (const field of customFields) {
      if (!field.required) continue;
      const raw = attributeEditorValues[field.key];
      if (raw === undefined || raw === null || raw === '') {
        errorKeys.add(`cf:${field.key}`);
        missingLabels.push(field.label);
      }
    }
    setEditFieldErrors(errorKeys);
    if (missingLabels.length > 0) {
      setError(t('toast.requiredFields', { list: missingLabels.join(', ') }));
      if (errorKeys.has('title')) editTitleInputRef.current?.focus();
      return;
    }

    try {
      const customFieldsValue = buildCustomFieldsPayload(attributeEditorValues);
      const publicationYear = parsePublicationYear(editForm.publicationYear);
      const result = await runAction(() => apiRequest<{ id: string; version: number }>(`/api/books/${editForm.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: editForm.title.trim(),
          author: editForm.author.trim(),
          isbn: editForm.isbn.trim() || null,
          shelfCode: editForm.shelfCode.trim() || null,
          publisher: editForm.publisher.trim() || null,
          language: editForm.language.trim() || null,
          description: editForm.description.trim() || null,
          publicationYear,
          customFields: customFieldsValue,
          status: editForm.status,
          version: editForm.version
        })
      }));

      setEditForm((prev) => ({ ...prev, version: result.version }));
      setEditFieldErrors(new Set());
      setMessage(t('toast.bookUpdated'));
      setDetailBook((prev) =>
        prev && prev.id === editForm.id
          ? {
              ...prev,
              title: editForm.title.trim(),
              author: editForm.author.trim(),
              isbn: editForm.isbn.trim() || null,
              shelfCode: editForm.shelfCode.trim() || null,
              publisher: editForm.publisher.trim() || null,
              language: editForm.language.trim() || null,
              description: editForm.description.trim() || null,
              publicationYear: publicationYear ?? null,
              customFields: customFieldsValue as Record<string, string | number | boolean | null>,
              status: editForm.status,
              version: result.version,
            }
          : prev
      );
      setDetailMode('view');
      await Promise.all([loadBooks(), loadCategories(), loadNeedsReviewCount(), loadRoomSummary()]);
    } catch (e) {
      // Version conflict: the book changed since it was opened. Re-fetch the
      // latest and refresh the form's version + baseline so a second save
      // succeeds, instead of dead-ending on a stale version that loops forever.
      if (e instanceof ApiRequestError && e.status === 409 && editForm.id) {
        try {
          const fresh = await apiRequest<Book>(`/api/books/${editForm.id}`);
          setDetailBook((prev) => (prev && prev.id === fresh.id ? { ...prev, ...fresh } : prev));
          setEditForm((prev) => (prev.id === fresh.id ? { ...prev, version: fresh.version } : prev));
          setError(t('toast.versionConflictReloaded'));
          await loadBooks();
          return;
        } catch {
          /* fall through to the generic error below */
        }
      }
      setError((e as Error).message);
    }
  }

  // One-click resolve for the needs-review queue: strip the needs_review flag
  // from the book's stored custom fields and PUT the book. We send the book's
  // persisted customFields as-is (not buildCustomFieldsPayload, so we don't
  // invent values). NOTE: because the server enforces required custom fields
  // whenever a customFields payload is present, resolving is blocked if the book
  // is missing an admin-added required field — the user then gets the server's
  // actionable "Required custom field missing" error and fills it via Edit
  // first. This is rare (the default catalog fields are all optional).
  async function markReviewed(book: Book) {
    clearStatus();
    const cf: Record<string, unknown> = { ...(book.customFields ?? {}) };
    delete cf.needs_review;
    try {
      const result = await runAction(() => apiRequest<{ id: string; version: number }>(`/api/books/${book.id}`, {
        method: 'PUT',
        body: JSON.stringify({ customFields: cf, version: book.version })
      }));
      setMessage(t('toast.markedReviewed'));
      setDetailBook((prev) => (prev && prev.id === book.id
        ? { ...prev, customFields: cf as Record<string, string | number | boolean | null>, version: result.version }
        : prev));
      await Promise.all([loadBooks(), loadNeedsReviewCount()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteBook(book: Book) {
    const ok = await confirm({
      title: t('confirm.deleteBookTitle', { title: book.title }),
      body: t('confirm.deleteBookBody'),
      confirmLabel: t('common.delete'),
      danger: true
    });
    if (!ok) return;

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(`/api/books/${book.id}`, { method: 'DELETE' }));
      setSelectedBookIds((prev) => prev.filter((id) => id !== book.id));
      setMessage(t('toast.bookRemoved', { title: book.title }));
      if (detailBook?.id === book.id) {
        setDetailBook(null);
        setDetailMode('view');
      }
      await Promise.all([loadBooks(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function borrowBook(book: Book) {
    clearStatus();

    // Trim so a whitespace-only name can't create an anonymous loan (the server
    // schema's min(1) would otherwise accept "   ").
    const trimmedBorrowerName = borrowerName.trim();
    if ((!selectedBorrowerId && !trimmedBorrowerName) || !dueAt) {
      setError(t('toast.borrowerRequired'));
      return;
    }

    try {
      const body: Record<string, unknown> = { dueAt, notes: null };
      if (selectedBorrowerId) {
        body.borrowerId = selectedBorrowerId;
      } else {
        body.borrowerName = trimmedBorrowerName;
        body.borrowerContact = borrowerContact.trim() || null;
      }
      await runAction(() => apiRequest(`/api/books/${book.id}/borrow`, {
        method: 'POST',
        body: JSON.stringify(body)
      }));

      setMessage(t('toast.bookBorrowed', { title: book.title }));
      // Reset borrower form so the next borrow starts fresh.
      setBorrowerName('');
      setBorrowerContact('');
      setSelectedBorrowerId('');
      setBorrowerQuery('');
      setBorrowerSuggestions([]);
      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function returnBook(book: Book) {
    clearStatus();

    try {
      await runAction(() => apiRequest(`/api/books/${book.id}/return`, {
        method: 'POST',
        body: JSON.stringify({ notes: null })
      }));

      setMessage(t('toast.bookReturned', { title: book.title }));
      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // `transactionId` is the loan this screen was showing. The server refuses the
  // return if a different loan is open now, so a list left open while someone
  // else returned and re-lent the book can't close the new borrower's loan.
  async function quickReturnByBookId(bookId: string, title: string, transactionId?: string) {
    clearStatus();

    try {
      await runAction(() => apiRequest(`/api/books/${bookId}/return`, {
        method: 'POST',
        body: JSON.stringify({ notes: 'Returned from active loans list', transactionId: transactionId ?? null })
      }));
      setMessage(t('toast.bookReturned', { title }));
      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function returnAllOverdue() {
    clearStatus();

    try {
      const overdueItems = activeBorrows.filter((item) => item.isOverdue);
      if (overdueItems.length === 0) {
        setMessage(t('toast.noOverdue'));
        return;
      }

      const results = await runAction(() =>
        Promise.allSettled(
          overdueItems.map((item) =>
            apiRequest(`/api/books/${item.bookId}/return`, {
              method: 'POST',
              body: JSON.stringify({ notes: 'Bulk returned from overdue list', transactionId: item.id })
            })
          )
        )
      );

      const failed = results.filter((entry) => entry.status === 'rejected').length;
      const success = results.length - failed;
      if (failed > 0) {
        setMessage(t('toast.returnedOverdueMixed', { success, failed }));
      } else {
        setMessage(t('toast.returnedOverdueAll', { n: success }));
      }

      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Build an end-of-day ISO datetime in the user's local timezone. The date
  // input only gives us YYYY-MM-DD, and naïvely appending "T00:00:00.000Z"
  // shifts the date by up to a day in non-UTC zones. Anchoring to local 23:59
  // means a "due Friday" loan stays due on the librarian's Friday wherever
  // they are.
  function endOfLocalDayIso(yyyymmdd: string): string {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    if (!y || !m || !d) return '';
    return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
  }

  // Inverse of endOfLocalDayIso for the <input type="date"> value. We must NOT
  // use `toISOString().slice(0,10)` here — that converts to UTC first, so a
  // local end-of-day stored as `2026-05-31T06:59:59Z` (UTC-7 user picked
  // May 30) would render back as May 31. Use the *local* Y-M-D so the date
  // shown in the input is the same date the user originally chose.
  function isoToLocalDateInput(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function setDueInDays(days: number) {
    const target = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    target.setHours(23, 59, 59, 999);
    setDueAt(target.toISOString());
  }

  async function generateCode(book: Book, type: 'qr' | 'barcode') {
    clearStatus();

    try {
      const response = await runAction(() => apiRequest<{ value: string }>(`/api/books/${book.id}/codes`, {
        method: 'POST',
        body: JSON.stringify({ type, label: `auto-${type}` })
      }));
      try {
        await navigator.clipboard.writeText(response.value);
        setMessage(t('toast.codeCreatedCopied', { type: type.toUpperCase(), value: response.value }));
      } catch {
        setMessage(t('toast.codeCreated', { type: type.toUpperCase(), value: response.value }));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function toggleBookSelection(bookId: string) {
    setSelectedBookIds((prev) => {
      if (prev.includes(bookId)) {
        return prev.filter((id) => id !== bookId);
      }

      return [...prev, bookId];
    });
  }

  // ADD every book on the current page to the selection (never replace it) — a
  // selection is cumulative across pages and searches.
  function selectAllOnPage() {
    setSelectedBookIds((prev) => {
      const next = new Set(prev);
      for (const book of books) next.add(book.id);
      return [...next];
    });
  }

  // Remove just the current page's books, leaving the rest of the selection.
  function deselectAllOnPage() {
    setSelectedBookIds((prev) => {
      const onPage = new Set(books.map((b) => b.id));
      return prev.filter((id) => !onPage.has(id));
    });
  }

  // The ONLY thing that empties the selection (besides sign-out).
  function clearSelectedBooks() {
    setSelectedBookIds([]);
  }

  // ── Criteria-based selection ──────────────────────────────────────────────
  // Add every book matching a server-side query to the selection. Union, never
  // replace, and report how many were newly added so the librarian can see the
  // effect even when most were already selected.
  async function addMatchingToSelection(query: URLSearchParams, what: string) {
    try {
      const res = await runAction(() => apiRequest<{ ids: string[]; total: number }>(`/api/books/ids?${query.toString()}`));
      const ids = res.ids ?? [];
      let added = 0;
      setSelectedBookIds((prev) => {
        const next = new Set(prev);
        const before = next.size;
        for (const id of ids) next.add(id);
        added = next.size - before;
        return [...next];
      });
      // setState is async; recompute for the message from the same data.
      const alreadyHad = ids.filter((id) => selectedBookIds.includes(id)).length;
      setMessage(t('toast.selectedMatching', { n: ids.length - alreadyHad, what }));
      if (ids.length > 0 && !selectionMode) setSelectionMode(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // "Select everything matching what I'm looking at" — reuses the exact filter
  // params the grid is showing, so the selection is always what's on screen.
  function selectAllMatchingFilters() {
    const query = buildBookFilterParams({
      q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
      status, filterLanguage, filterYear, categoryFilter,
      needsReviewFilter, shelfFilter, smartListKey, smartLists: SMART_LISTS
    });
    void addMatchingToSelection(query, t('library.bulk.criteria.currentView'));
  }

  // "Select every book by this author / on this shelf / from this publisher."
  function selectByCriterion(kind: 'authorExact' | 'shelfExact' | 'publisherExact', value: string, what: string) {
    const query = new URLSearchParams();
    query.set(kind, value);
    void addMatchingToSelection(query, what);
  }

  // Resolve the selected ids to their live rows so a bulk action can span pages.
  // Always fetched fresh (never from the loaded page) so each book carries its
  // CURRENT version for the per-row concurrency check. Chunked to keep the query
  // string short. Ids that no longer exist (deleted elsewhere) simply drop out,
  // and the caller reports them.
  async function resolveSelectedBooks(ids: string[]): Promise<Book[]> {
    const found = new Map<string, Book>();
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const res = await apiRequest<{ items: Book[] }>(`/api/books/by-ids?ids=${chunk.map(encodeURIComponent).join(',')}`);
      for (const b of res.items ?? []) found.set(b.id, b);
    }
    // Preserve the order the librarian selected in.
    return ids.map((id) => found.get(id)).filter((b): b is Book => Boolean(b));
  }

  // Batch a set of book mutations into ONE /api/sync/push request instead of
  // firing N separate PUT/DELETE calls. On the free Cloudflare tier the tightest
  // limit is KV writes (1,000/day) and every book write bumps the cache version
  // = 1 KV write; N direct calls = N KV writes, whereas the whole sync batch
  // bumps the version exactly once. Each mutation carries a FRESH clientMutationId
  // so the server dedups per-row on retry (the body is built once, so ids stay
  // stable across apiRequest's internal retries). Returns per-row success/fail.
  async function pushBulkMutations(
    mutations: Array<{ operation: 'update_book' | 'delete_book'; payload: Record<string, unknown> }>
  ): Promise<{ success: number; failed: number; okIds: string[] }> {
    const clientTimestamp = new Date().toISOString();
    let success = 0;
    let failed = 0;
    const okIds: string[] = [];
    // Batch size is bounded by the Workers FREE plan's 1,000-subrequest limit
    // per invocation, not by the endpoint's 200-mutation schema cap: each
    // mutation costs several D1 calls, so a 200-mutation request dies partway
    // through with a 500 *after* writing some books. 40 keeps a request well
    // inside the budget.
    const BATCH = 40;
    for (let i = 0; i < mutations.length; i += BATCH) {
      const batch = mutations.slice(i, i + BATCH);
      try {
        const res = await runAction(() =>
          apiRequest<{ results: Array<{ status: string; result?: { id?: string } }> }>(`/api/sync/push`, {
            method: 'POST',
            body: JSON.stringify({
              mutations: batch.map((m) => ({
                operation: m.operation,
                payload: m.payload,
                clientMutationId: newMutationId(),
                clientTimestamp
              }))
            })
          })
        );
        res.results.forEach((r, idx) => {
          if (r.status === 'success') {
            success += 1;
            const id = (r.result?.id ?? (batch[idx].payload as { id?: string }).id);
            if (id) okIds.push(id);
          } else {
            failed += 1;
          }
        });
      } catch {
        // A transport failure on ONE batch must not discard the batches that
        // already succeeded — otherwise the caller reports total failure, never
        // prunes the selection, and the librarian re-runs an action that has
        // partly landed. Count this batch as failed and carry on.
        failed += batch.length;
      }
    }
    return { success, failed, okIds };
  }

  // The core book columns a bulk edit may set. Deliberately excludes title,
  // author, ISBN and description: those identify a specific book, and setting
  // them across a selection is never what the librarian meant. Status is handled
  // separately (it has a fixed option list and a circulation guard).
  const BULK_CORE_FIELDS: Array<{
    key: 'shelfCode' | 'roomCode' | 'publisher' | 'language' | 'publicationYear';
    labelKey: string;
    type: 'text' | 'number';
    listId?: string;
  }> = [
    { key: 'shelfCode', labelKey: 'library.bulk.field.shelfCode', type: 'text', listId: 'suggest-shelf' },
    // No listId: there is no room-code facet, so there is no datalist to point at.
    { key: 'roomCode', labelKey: 'library.bulk.field.roomCode', type: 'text' },
    { key: 'publisher', labelKey: 'library.bulk.field.publisher', type: 'text', listId: 'suggest-publisher' },
    { key: 'language', labelKey: 'library.bulk.field.language', type: 'text', listId: 'suggest-language' },
    { key: 'publicationYear', labelKey: 'library.bulk.field.publicationYear', type: 'number' }
  ];

  function resetBulkEditor() {
    setBulkEditValues({});
    setBulkEditClears(new Set());
    setBulkTagsAdd('');
    setBulkTagsRemove('');
    setBulkStatus('');
  }

  // Dismissing the panel DISCARDS what was typed in it. Merely hiding it left
  // the values armed while the bar showed only status + shelf, so the next
  // click of the bar's Apply silently wrote fields the librarian had backed out
  // of — to every selected book. "Cancel" has to mean cancel.
  function closeBulkEditor() {
    setBulkEditOpen(false);
    resetBulkEditor();
  }

  function setBulkEditValue(fieldId: string, value: string) {
    setBulkEditValues((prev) => {
      const next = { ...prev };
      if (value === '') delete next[fieldId];
      else next[fieldId] = value;
      return next;
    });
    // Typing a value and asking to clear the same field are contradictory;
    // the last action wins.
    if (value !== '') {
      setBulkEditClears((prev) => {
        if (!prev.has(fieldId)) return prev;
        const next = new Set(prev);
        next.delete(fieldId);
        return next;
      });
    }
  }

  function toggleBulkEditClear(fieldId: string) {
    const willClear = !bulkEditClears.has(fieldId);
    setBulkEditClears((prev) => {
      const next = new Set(prev);
      if (willClear) next.add(fieldId);
      else next.delete(fieldId);
      return next;
    });
    // Separate call, not nested inside the updater above: React may invoke an
    // updater more than once, and queueing a second setState from inside one is
    // not guaranteed to run.
    if (willClear) {
      setBulkEditValues((vals) => {
        if (!(fieldId in vals)) return vals;
        const next = { ...vals };
        delete next[fieldId];
        return next;
      });
    }
  }

  // How many distinct fields the current bulk edit would write. Drives the
  // confirmation copy and disables Apply when nothing is pending.
  const bulkEditPendingCount =
    Object.keys(bulkEditValues).length +
    bulkEditClears.size +
    (bulkStatus ? 1 : 0) +
    (bulkTagsAdd.trim() ? 1 : 0) +
    (bulkTagsRemove.trim() ? 1 : 0);

  // One custom attribute inside the bulk editor. Mirrors the book form's input
  // types so a value set in bulk is the same shape as one typed on a book — but
  // every control additionally supports "leave unchanged", which the single-book
  // form has no need for.
  function renderBulkCustomField(field: CustomField): React.ReactNode {
    const fieldId = `cf:${field.key}`;
    const cleared = bulkEditClears.has(fieldId);
    const raw = bulkEditValues[fieldId] ?? '';
    const inputId = `bulk-${fieldId}`;

    // A required attribute cannot be cleared — the server refuses it, because
    // the book form enforces required and those books would stop saving. Don't
    // offer a control that can only fail; mark the field instead.
    const clearToggle = field.required ? null : (
      <label className="checkbox-label bulk-clear">
        <input type="checkbox" checked={cleared} onChange={() => toggleBulkEditClear(fieldId)} />
        <span className="muted small">{t('library.bulk.clear2')}</span>
      </label>
    );
    const requiredMark = field.required ? <span className="required-mark"> *</span> : null;

    // Booleans need a third state the book form doesn't: "don't touch this".
    // A plain checkbox can only say true/false, and defaulting to false would
    // silently set the attribute on every selected book.
    if (field.type === 'boolean') {
      return (
        <div key={fieldId} className="form-field bulk-field">
          <label htmlFor={inputId}>{field.label}{requiredMark}</label>
          <select
            id={inputId}
            value={raw}
            disabled={cleared}
            onChange={(e) => setBulkEditValue(fieldId, e.target.value)}
          >
            <option value="">{t('library.bulk.unchanged')}</option>
            <option value="true">{t('common.yes')}</option>
            <option value="false">{t('common.no')}</option>
          </select>
          {clearToggle}
        </div>
      );
    }

    if (field.type === 'enum') {
      return (
        <div key={fieldId} className="form-field bulk-field">
          <label htmlFor={inputId}>{field.label}{requiredMark}</label>
          <select
            id={inputId}
            value={raw}
            disabled={cleared}
            onChange={(e) => setBulkEditValue(fieldId, e.target.value)}
          >
            <option value="">{t('library.bulk.unchanged')}</option>
            {field.enumOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
          {clearToggle}
        </div>
      );
    }

    return (
      <div key={fieldId} className="form-field bulk-field">
        <label htmlFor={inputId}>{field.label}{requiredMark}</label>
        <input
          id={inputId}
          type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
          value={raw}
          disabled={cleared}
          onChange={(e) => setBulkEditValue(fieldId, e.target.value)}
          placeholder={cleared ? t('library.bulk.willClear') : t('library.bulk.unchanged')}
          list={field.type === 'text' ? `suggest-cf-${field.key}` : undefined}
        />
        {clearToggle}
      </div>
    );
  }

  async function applyBulkBookChanges() {
    clearStatus();

    try {
      if (selectedBookIds.length === 0) {
        throw new Error(t('toast.bulkSelectAtLeastOne'));
      }

      const updates: Record<string, unknown> = {};
      if (bulkStatus) {
        updates.status = bulkStatus;
      }
      // Core columns from the full editor. A field is written only if the
      // librarian typed a value or explicitly asked to blank it.
      for (const field of BULK_CORE_FIELDS) {
        const fieldId = `core:${field.key}`;
        if (bulkEditClears.has(fieldId)) {
          updates[field.key] = null;
          continue;
        }
        const raw = bulkEditValues[fieldId];
        if (raw === undefined || raw.trim() === '') continue;
        if (field.type === 'number') {
          const n = Number(raw.trim());
          if (!Number.isFinite(n)) {
            throw new Error(t('toast.bulkBadNumber', { label: t(field.labelKey) }));
          }
          updates[field.key] = n;
        } else {
          updates[field.key] = raw.trim();
        }
      }

      // Custom attributes go through customFieldsPatch, NOT customFields: the
      // latter replaces the whole attribute map, so setting one attribute would
      // erase every other attribute on every selected book. `null` in the patch
      // clears exactly that one key.
      const customFieldsPatch: Record<string, string | number | boolean | null> = {};
      for (const field of customFields) {
        const fieldId = `cf:${field.key}`;
        if (bulkEditClears.has(fieldId)) {
          customFieldsPatch[field.key] = null;
          continue;
        }
        const raw = bulkEditValues[fieldId];
        // `.trim()` like the core columns above: a box holding only spaces is
        // an untouched box, not an instruction to write blanks (and not a
        // clear either — that is the explicit tick).
        if (raw === undefined || raw.trim() === '') continue;
        if (field.type === 'number') {
          const n = Number(raw.trim());
          if (!Number.isFinite(n)) {
            throw new Error(t('toast.bulkBadNumber', { label: field.label }));
          }
          customFieldsPatch[field.key] = n;
        } else if (field.type === 'boolean') {
          customFieldsPatch[field.key] = raw === 'true';
        } else {
          customFieldsPatch[field.key] = raw.trim();
        }
      }
      if (Object.keys(customFieldsPatch).length > 0) {
        updates.customFieldsPatch = customFieldsPatch;
      }

      // Tags are added/removed rather than replaced, so bulk-tagging a
      // selection never strips the tags each book already carries.
      const tagsAdd = parseStringArray(bulkTagsAdd);
      const tagsRemove = parseStringArray(bulkTagsRemove);
      if (tagsAdd.length > 0) updates.tagsAdd = tagsAdd;
      if (tagsRemove.length > 0) updates.tagsRemove = tagsRemove;

      if (Object.keys(updates).length === 0) {
        throw new Error(t('toast.bulkRequireValue'));
      }

      // Resolve the WHOLE selection (not just the loaded page) to live rows so
      // every selected book is edited and carries its current version.
      const selectedBooks = await resolveSelectedBooks(selectedBookIds);
      const vanished = selectedBookIds.length - selectedBooks.length;
      const { success, failed } = await pushBulkMutations(
        selectedBooks.map((book) => ({
          operation: 'update_book',
          // sync update_book expects { id, data } and enforces the same version
          // check + borrowed-status guard as the direct PUT.
          payload: { id: book.id, data: { ...updates, version: book.version } }
        }))
      );

      if (failed + vanished > 0) {
        setMessage(t('toast.bulkPartial', { success, failed: failed + vanished }));
      } else {
        setMessage(t('toast.bulkAll', { n: success }));
      }

      resetBulkEditor();
      setBulkEditOpen(false);
      // The selection deliberately survives the action — only the user clears it.
      await Promise.all([loadBooks(), loadRoomSummary(), loadFacets()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function exportFilteredBooksCsv() {
    clearStatus();
    try {
      if (books.length === 0) {
        throw new Error(t('toast.noBooksToExport'));
      }

      const escape = (value: unknown): string => {
        if (value === null || value === undefined) {
          return '';
        }
        const text = String(value);
        if (text.includes(',') || text.includes('"') || text.includes('\n')) {
          return `"${text.replaceAll('"', '""')}"`;
        }
        return text;
      };

      const columns = ['id', 'title', 'author', 'isbn', 'status', 'roomCode', 'shelfCode', 'publicationYear'];
      const lines = [columns.join(',')];
      for (const book of books) {
        lines.push(
          [
            book.id,
            book.title,
            book.author,
            book.isbn ?? '',
            book.status,
            book.roomCode ?? '',
            book.shelfCode ?? '',
            book.publicationYear ?? ''
          ]
            .map(escape)
            .join(',')
        );
      }

      const csv = lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'books-filtered.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(t('toast.csvFiltered', { n: books.length }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function resolveScanCode(event: FormEvent) {
    event.preventDefault();
    clearStatus();
    setScanResult('');

    try {
      const value = scanCode.trim();
      if (!value) {
        throw new Error(t('toast.scanRequired'));
      }

      const response = await runAction(() => apiRequest<{ book: Book }>(`/api/scan/${encodeURIComponent(value)}`));
      // Localized, blank-safe: show the title and append the author only when
      // there is a real one (no hardcoded English "by", no dangling separator).
      const scanTitle = displayTitle(response.book, t('common.untitled'));
      const scanAuthor = displayAuthor(response.book, '');
      setScanResult(scanAuthor ? `${scanTitle} — ${scanAuthor}` : scanTitle);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function exportCsv() {
    clearStatus();

    try {
      const csv = await runAction(() => apiRequest<string>('/api/export/books.csv', undefined, true));
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'books.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(t('toast.csvDownloaded'));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // The server already returns pinned-first; splitting the list here lets the
  // UI show the two groups distinctly without re-sorting (and therefore without
  // any risk of the settings list and the book form disagreeing on order).
  const pinnedCustomFields = useMemo(() => customFields.filter((f) => f.pinned), [customFields]);
  const unpinnedCustomFields = useMemo(() => customFields.filter((f) => !f.pinned), [customFields]);

  // Pin/unpin in one click. A newly pinned field goes to the END of the pinned
  // group rather than the top, so pinning one attribute never reshuffles the
  // ones the librarian has already arranged.
  async function toggleCustomFieldPin(field: CustomField) {
    clearStatus();
    try {
      const nextPinned = !field.pinned;
      const nextOrder = nextPinned
        ? Math.max(0, ...pinnedCustomFields.map((f) => f.sortOrder ?? 0)) + 1
        : 0;
      await runAction(() => apiRequest(`/api/custom-fields/${field.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          pinned: nextPinned,
          sortOrder: nextOrder,
          enumOptions: field.enumOptions
        })
      }));
      await loadCustomFields();
      setMessage(nextPinned
        ? t('toast.customFieldPinned', { label: field.label })
        : t('toast.customFieldUnpinned', { label: field.label }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Move a pinned field one place up or down by SWAPPING sort orders with its
  // neighbour. Swapping (rather than renumbering the whole group) keeps this to
  // two writes no matter how many attributes are pinned.
  async function moveCustomField(field: CustomField, direction: -1 | 1) {
    clearStatus();
    try {
      const group = pinnedCustomFields;
      const index = group.findIndex((f) => f.id === field.id);
      const swapWith = group[index + direction];
      if (index < 0 || !swapWith) return;

      const save = (f: CustomField, sortOrder: number) =>
        apiRequest(`/api/custom-fields/${f.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            pinned: f.pinned,
            sortOrder,
            enumOptions: f.enumOptions
          })
        });

      // If two fields share a sort order (e.g. both freshly pinned) a naive swap
      // is a no-op, so fall back to explicit consecutive positions.
      const a = field.sortOrder ?? 0;
      const b = swapWith.sortOrder ?? 0;
      // Clamp: the schema's minimum is 0, so moving the first field up from a
      // tied order would otherwise send -1 and 400.
      const [nextA, nextB] = a === b ? [Math.max(0, b + direction), b] : [b, a];

      await runAction(async () => {
        await save(field, nextA);
        await save(swapWith, nextB);
      });
      await loadCustomFields();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function resetCustomFieldForm() {
    setFieldForm({ key: '', label: '', type: 'text', required: false, pinned: false, sortOrder: 0, enumOptionsCsv: '' });
    setEditingCustomFieldId(null);
  }

  function beginCustomFieldEdit(field: CustomField) {
    setEditingCustomFieldId(field.id);
    setFieldForm({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      pinned: field.pinned ?? false,
      sortOrder: field.sortOrder ?? 0,
      enumOptionsCsv: field.enumOptions.join(', ')
    });
  }

  async function saveCustomField(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    try {
      const normalizedKey = fieldForm.key.trim();
      if (RESERVED_ATTRIBUTE_KEYS.has(normalizedKey)) {
        throw new Error(t('toast.customFieldKeyReserved'));
      }

      if (!/^[a-zA-Z0-9_]+$/.test(normalizedKey)) {
        throw new Error(t('toast.customFieldKeyInvalid'));
      }

      const enumOptions = fieldForm.enumOptionsCsv
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

      const normalizedOptions = Array.from(new Set(enumOptions));

      if (fieldForm.type === 'enum' && normalizedOptions.length === 0) {
        throw new Error(t('toast.customFieldEnumRequired'));
      }

      if (fieldForm.type !== 'enum' && normalizedOptions.length > 0) {
        throw new Error(t('toast.customFieldEnumOnly'));
      }

      const keyConflict = customFields.some((field) => {
        if (editingCustomFieldId && field.id === editingCustomFieldId) {
          return false;
        }
        return field.key.toLowerCase() === normalizedKey.toLowerCase();
      });

      if (keyConflict) {
        throw new Error(t('toast.customFieldKeyConflict'));
      }

      const path = editingCustomFieldId ? `/api/custom-fields/${editingCustomFieldId}` : '/api/custom-fields';
      const method = editingCustomFieldId ? 'PUT' : 'POST';

      await runAction(() => apiRequest<{ id: string }>(path, {
        method,
        body: JSON.stringify({
          key: normalizedKey,
          label: fieldForm.label.trim(),
          type: fieldForm.type,
          required: fieldForm.required,
          pinned: fieldForm.pinned,
          sortOrder: fieldForm.sortOrder,
          enumOptions: normalizedOptions
        })
      }));

      resetCustomFieldForm();
      await loadCustomFields();
      await loadBooks();
      setMessage(editingCustomFieldId ? t('toast.customFieldUpdated') : t('toast.customFieldAdded'));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteCustomField(field: CustomField) {
    const ok = await confirm({
      title: t('confirm.deleteFieldTitle', { key: field.key }),
      body: t('confirm.deleteFieldBody'),
      confirmLabel: t('confirm.deleteFieldAction'),
      danger: true
    });
    if (!ok) return;

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(`/api/custom-fields/${field.id}`, { method: 'DELETE' }));
      if (editingCustomFieldId === field.id) {
        resetCustomFieldForm();
      }
      await loadCustomFields();
      setMessage(t('toast.customFieldRemoved', { key: field.key }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function isCatalogFormat(headers: string[]): boolean {
    // Catalogue exports use snake_case columns. Detection is conservative: we
    // require `id` plus at least one other catalog-distinct field so we don't
    // mistakenly route a legacy mixed-case file through this path.
    const set = new Set(headers.map((h) => h.trim().toLowerCase()));
    if (!set.has('id')) return false;
    const catalogMarkers = [
      'authors', 'place_of_publication', 'category_code', 'source_sheet',
      'isbn_13', 'shelf_location', 'cover_type', 'has_illustrations'
    ];
    return catalogMarkers.some((m) => set.has(m));
  }

  function toCatalogText(value: unknown, max = 1000): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max) : text;
  }

  function toCatalogBoolean(value: unknown): boolean | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim().toLowerCase();
    if (!text) return null;
    if (['true', 'yes', '1', 'y'].includes(text)) return true;
    if (['false', 'no', '0', 'n'].includes(text)) return false;
    return null;
  }

  function toCatalogNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/[^0-9.\-]/g, '');
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  function pickIsbn(row: Record<string, unknown>): string | null {
    const isbn13 = toCatalogText(row.isbn_13, 32);
    if (isbn13) return isbn13;
    const isbn10 = toCatalogText(row.isbn_10, 32);
    if (isbn10) return isbn10;
    return null;
  }

  function buildCatalogRow(raw: Record<string, unknown>, reviewIds: Set<string>): CatalogRow | null {
    // Lowercase-key the row so column casing doesn't matter.
    const row = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), v])
    ) as Record<string, unknown>;

    // Skip fully-empty rows.
    if (Object.values(row).every((v) => toCatalogText(v) === null)) {
      return null;
    }

    const legacyId = toCatalogText(row.id, 64);
    const title = toCatalogText(row.title, 300);
    const author = toCatalogText(row.authors, 300);
    const yearRaw = toCatalogNumber(row.published_year);
    const publicationYear = yearRaw && yearRaw >= 1000 && yearRaw <= 3000 ? yearRaw : null;

    const customFields: Record<string, string | number | boolean | null> = {};
    const setField = (key: string, value: string | number | boolean | null) => {
      if (value === null || value === undefined || value === '') return;
      customFields[key] = value;
    };
    setField('series', toCatalogText(row.series, 300));
    setField('volume_label', toCatalogText(row.volume_label, 300));
    setField('volume_num', toCatalogText(row.volume_num, 50));
    setField('editor', toCatalogText(row.editor, 300));
    setField('translator', toCatalogText(row.translator, 300));
    setField('place_of_publication', toCatalogText(row.place_of_publication, 200));
    setField('edition', toCatalogText(row.edition, 50));
    setField('category_code', toCatalogText(row.category_code, 32));
    setField('category_label', toCatalogText(row.category_label, 200));
    setField('cover_type', toCatalogText(row.cover_type, 50));
    const pages = toCatalogNumber(row.pages);
    if (pages !== null) setField('pages', pages);
    setField('condition', toCatalogText(row.condition, 200));
    setField('isbn_10', toCatalogText(row.isbn_10, 32));
    setField('issn', toCatalogText(row.issn, 32));
    setField('additional_isbns', toCatalogText(row.additional_isbns, 500));
    const hasIllus = toCatalogBoolean(row.has_illustrations);
    if (hasIllus !== null) setField('has_illustrations', hasIllus);
    setField('illustration_type', toCatalogText(row.illustration_type, 200));
    const signed = toCatalogBoolean(row.signed_copy);
    if (signed !== null) setField('signed_copy', signed);
    setField('signature_notes', toCatalogText(row.signature_notes, 500));
    const copies = toCatalogNumber(row.copies_count);
    if (copies !== null) setField('copies_count', copies);
    setField('source_sheet', toCatalogText(row.source_sheet, 50));
    setField('original_id', toCatalogText(row.original_id, 64));
    setField('transformations_applied', toCatalogText(row.transformations_applied, 1000));
    setField('cleanup_notes', toCatalogText(row.cleanup_notes, 1000));

    const needsReview = legacyId ? reviewIds.has(legacyId) : false;

    return {
      legacyId,
      title,
      author,
      isbn: pickIsbn(row),
      publicationYear,
      publisher: toCatalogText(row.publisher, 200),
      language: toCatalogText(row.language, 120),
      description: toCatalogText(row.description, 4000),
      shelfCode: toCatalogText(row.shelf_location, 64),
      needsReview,
      customFields
    };
  }

  async function setupLibraryCatalog() {
    clearStatus();
    try {
      const result = await runAction(() =>
        apiRequest<{ ok: boolean; created: number; updated: number; total: number }>(
          '/api/setup/library-catalog',
          { method: 'POST' }
        )
      );
      await loadCustomFields();
      setMessage(
        t('toast.libraryCatalogReady', { created: result.created, updated: result.updated, total: result.total })
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function importCatalogRows(rows: CatalogRow[], dryRun: boolean) {
    const CHUNK = 500;
    let cursor = 0;
    let totalInsert = 0;
    let totalUpdate = 0;
    let totalAccepted = 0;
    const allSkipped: Array<{ index: number; reason: string }> = [];

    while (cursor < rows.length) {
      const end = Math.min(cursor + CHUNK, rows.length);
      const chunk = rows.slice(cursor, end);
      const chunkNum = Math.floor(cursor / CHUNK) + 1;
      const chunkTotal = Math.ceil(rows.length / CHUNK);
      setMessage(
        t(dryRun ? 'toast.catalogPreviewing' : 'toast.catalogImportingChunk', { chunk: chunkNum, total: chunkTotal, from: cursor + 1, to: end, n: rows.length })
      );

      const result = await runAction(() =>
        apiRequest<{
          dryRun: boolean;
          acceptedRows?: number;
          willInsert?: number;
          willUpdate?: number;
          inserted?: number;
          updated?: number;
          skippedRows?: Array<{ index: number; reason: string }>;
        }>('/api/import/books-catalog', {
          method: 'POST',
          body: JSON.stringify({ dryRun, rows: chunk })
        })
      );

      if (dryRun) {
        totalAccepted += result.acceptedRows ?? 0;
        totalInsert += result.willInsert ?? 0;
        totalUpdate += result.willUpdate ?? 0;
      } else {
        totalInsert += result.inserted ?? 0;
        totalUpdate += result.updated ?? 0;
      }
      if (result.skippedRows) allSkipped.push(...result.skippedRows);
      cursor = end;
    }

    return { totalInsert, totalUpdate, totalAccepted, allSkipped };
  }

  async function importFromXlsx(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    const form = event.target as HTMLFormElement;
    const fileInput = form.elements.namedItem('xlsxFile') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];

    if (!file) {
      setError(t('toast.xlsxSelectFile'));
      return;
    }

    setImportFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const XLSX = await loadXlsx();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new Error(t('toast.xlsxNoSheet'));
      }

      const sheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: null,
        raw: false
      });

      if (rawRows.length === 0) {
        throw new Error(t('toast.xlsxEmpty'));
      }

      // ── Catalog-format fast path ─────────────────────────────────────────
      // Detect the LIBRARY_normalized.xlsx-style snake_case schema and use
      // the upsert endpoint, which is idempotent on `id` (legacy_id).
      const headers = Object.keys(rawRows[0] ?? {});
      if (isCatalogFormat(headers)) {
        // Build the "needs review" overlay from the optional `review` sheet.
        const reviewIds = new Set<string>();
        const reviewSheetName = workbook.SheetNames.find((n) => n.trim().toLowerCase() === 'review');
        if (reviewSheetName) {
          const reviewRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[reviewSheetName], {
            defval: null,
            raw: false
          });
          for (const r of reviewRows) {
            const idVal = r.id ?? r.ID ?? null;
            if (idVal) reviewIds.add(String(idVal).trim());
          }
        }

        // Use the FIRST sheet as canonical (typically named "library").
        const catalogRows: CatalogRow[] = [];
        let blankSkipped = 0;
        for (const raw of rawRows) {
          const row = buildCatalogRow(raw, reviewIds);
          if (!row) { blankSkipped += 1; continue; }
          catalogRows.push(row);
        }
        if (catalogRows.length === 0) {
          throw new Error(t('toast.xlsxNoCatalog'));
        }

        const reviewMatched = catalogRows.filter((r) => r.needsReview).length;
        const noTitle = catalogRows.filter((r) => !r.title).length;
        const noAuthor = catalogRows.filter((r) => !r.author).length;

        if (importDryRun) {
          const result = await importCatalogRows(catalogRows, true);
          setMessage(
            t('toast.catalogDryRun', {
              accepted: result.totalAccepted,
              insert: result.totalInsert,
              update: result.totalUpdate,
              review: reviewMatched,
              noTitle,
              noAuthor,
              blank: blankSkipped
            })
          );
          // The dry-run is a safety check — don't hide the rows the server would
          // reject. Surface the count so it's visible before the real import.
          if (result.allSkipped.length > 0) pushAppToast('error', t('toast.importServerSkipped', { n: result.allSkipped.length }));
        } else {
          const result = await importCatalogRows(catalogRows, false);
          setMessage(
            t('toast.catalogImport', {
              insert: result.totalInsert,
              update: result.totalUpdate,
              review: reviewMatched,
              skipped: result.allSkipped.length
            })
          );
        }

        await Promise.all([loadBooks(1), loadRoomSummary()]);
        return;
      }
      // ── End catalog fast path ────────────────────────────────────────────

      const unknownColumns = findUnknownSpreadsheetColumns(rawRows);
      if (unknownColumns.length > 0) {
        const listed = unknownColumns.slice(0, 12).join(', ');
        const extra = unknownColumns.length > 12 ? `, and ${unknownColumns.length - 12} more` : '';
        const proceed = await confirm({
          title: t('toast.unmappedTitle'),
          body: t('toast.unmappedBody', { listed, extra }),
          confirmLabel: t('toast.unmappedConfirm'),
          cancelLabel: t('toast.unmappedCancel')
        });

        if (!proceed) {
          setError(
            t('toast.unmappedCanceled')
          );
          return;
        }

        setMessage(t('toast.unmappedContinuing', { listed, extra }));
      }

      const rows: Record<string, unknown>[] = [];
      const skippedBlankRows: number[] = [];
      const skippedInvalidRows: number[] = [];

      for (let index = 0; index < rawRows.length; index += 1) {
        try {
          const normalized = normalizeSpreadsheetRow(rawRows[index], index);
          if (!normalized) {
            skippedBlankRows.push(index + 2);
            continue;
          }

          rows.push(normalized);
        } catch (error) {
          // Locale-safe: detect the row-missing case by class, not by
          // matching a translated string.
          if (error instanceof SpreadsheetRowMissingError) {
            skippedInvalidRows.push(index + 2);
            continue;
          }
          throw error;
        }
      }

      if (rows.length === 0) {
        throw new Error(t('toast.xlsxNoValid'));
      }

      const skippedCount = skippedBlankRows.length + skippedInvalidRows.length;
      const skippedInvalidPreview = skippedInvalidRows.slice(0, 8).join(', ');
      const examples = skippedInvalidRows.length > 0 ? t('toast.skippedExamples', { list: skippedInvalidPreview }) : '';
      const skippedNote =
        skippedCount > 0
          ? t('toast.skippedNote', { count: skippedCount, blank: skippedBlankRows.length, invalid: skippedInvalidRows.length, examples })
          : '';

      if (importDryRun) {
        let chunkSize = IMPORT_CHUNK_SIZE;
        let cursor = 0;
        let totalAccepted = 0;
        let serverSkipped = 0;

        while (cursor < rows.length) {
          const end = Math.min(cursor + chunkSize, rows.length);
          const chunk = rows.slice(cursor, end);
          const chunkProgress = t('toast.chunkLabel', { n: Math.floor(cursor / chunkSize) + 1 });
          setMessage(t('toast.dryRunChunk', { progress: chunkProgress, from: cursor + 1, to: end, n: rows.length }));

          try {
            const result = await runAction(() =>
              apiRequest<{ dryRun?: boolean; acceptedRows?: number; importedRows?: number; skippedRows?: Array<{ index: number; reason: string }> }>('/api/import/books', {
                method: 'POST',
                body: JSON.stringify({ dryRun: true, rows: chunk })
              })
            );

            totalAccepted += result.acceptedRows ?? chunk.length;
            serverSkipped += result.skippedRows?.length ?? 0;
            cursor = end;
          } catch (error) {
            if (isPayloadTooLargeError(error) && chunkSize > IMPORT_MIN_CHUNK_SIZE) {
              chunkSize = Math.max(IMPORT_MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
              continue;
            }
            throw error;
          }
        }

        setMessage(t('toast.xlsxDryRunDone', { n: totalAccepted, skippedNote }));
        // Rows the SERVER rejected (missing title, bad custom field) are separate
        // from client-side parse skips — surface them so the count isn't silently
        // inflated.
        if (serverSkipped > 0) pushAppToast('error', t('toast.importServerSkipped', { n: serverSkipped }));
      } else {
        let chunkSize = IMPORT_CHUNK_SIZE;
        let cursor = 0;
        let totalImported = 0;
        let serverSkipped = 0;
        const uploadSkippedRows: number[] = [];

        while (cursor < rows.length) {
          const end = Math.min(cursor + chunkSize, rows.length);
          const chunk = rows.slice(cursor, end);
          const chunkProgress = t('toast.chunkLabel', { n: Math.floor(cursor / chunkSize) + 1 });
          setMessage(t('toast.importingChunk', { progress: chunkProgress, from: cursor + 1, to: end, n: rows.length }));

          try {
            const result = await runAction(() =>
              apiRequest<{ dryRun?: boolean; acceptedRows?: number; importedRows?: number; skippedRows?: Array<{ index: number; reason: string }> }>('/api/import/books', {
                method: 'POST',
                body: JSON.stringify({ dryRun: false, rows: chunk })
              })
            );

            totalImported += result.importedRows ?? 0;
            serverSkipped += result.skippedRows?.length ?? 0;
            cursor = end;
          } catch (error) {
            if (isPayloadTooLargeError(error)) {
              if (chunkSize > IMPORT_MIN_CHUNK_SIZE) {
                chunkSize = Math.max(IMPORT_MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
                continue;
              }

              uploadSkippedRows.push(cursor + 2);
              cursor += 1;
              continue;
            }

            // Anything else is fatal for this run, but rows already written are
            // IN the database. Saying only "request failed" invites the
            // librarian to re-upload the whole sheet on top of a partial one.
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
              t('toast.importPartialFailure', { imported: totalImported, row: cursor + 2, detail })
            );
          }
        }

        const uploadSkippedNote =
          uploadSkippedRows.length > 0
            ? t('toast.uploadSkipped', { n: uploadSkippedRows.length })
            : '';

        setMessage(
          t('toast.xlsxImportDone', { n: totalImported, skippedNote, uploadSkippedNote })
        );
        if (serverSkipped > 0) pushAppToast('error', t('toast.importServerSkipped', { n: serverSkipped }));
      }

      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }


  // ─── helper functions for the detail modal ──────────────────────────────
  function openBookDetail(book: Book) {
    setDetailBook(book);
    setDetailMode('view');
    setBookHistory([]);
    void loadBookHistory(book.id);
  }

  function closeDetail() {
    setDetailBook(null);
    setDetailMode('view');
    setBookHistory([]);
    setCoverZoom(null); // never leave the cover lightbox open without its book
  }

  function renderCustomFieldsForm(
    values: Record<string, unknown>,
    setValue: (key: string, value: unknown) => void,
    errorKeys?: Set<string>
  ): React.ReactNode {
    if (customFields.length === 0) {
      return (
        <p className="muted small">{t('settings.customFieldsEmpty')}</p>
      );
    }
    // Render one field. Shared by the pinned group and the rest so the two
    // groups can never drift apart in behaviour — only in presentation.
    const renderField = (field: CustomField) => {
      const v = values[field.key];
      const idAttr = `cf-${field.key}`;
      const hasError = errorKeys?.has(`cf:${field.key}`) ?? false;
      const mark = field.required ? <span className="required-mark"> *</span> : null;
      if (field.type === 'boolean') {
        const checked = v === true || v === 'true';
        return (
          <label key={field.key} className="checkbox-label cf-bool">
            <input
              id={idAttr}
              type="checkbox"
              checked={checked}
              onChange={(e) => setValue(field.key, e.target.checked)}
            />
            <span>{field.label}{mark}</span>
          </label>
        );
      }
      if (field.type === 'enum') {
        return (
          <div key={field.key} className="form-field">
            <label htmlFor={idAttr}>{field.label}{mark}</label>
            <select
              id={idAttr}
              className={hasError ? 'input-error' : undefined}
              aria-required={field.required || undefined}
              aria-invalid={hasError || undefined}
              value={(v as string) ?? ''}
              onChange={(e) => setValue(field.key, e.target.value || null)}
            >
              <option value="">{t('common.none')}</option>
              {field.enumOptions.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>
        );
      }
      const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
      // Date inputs need YYYY-MM-DD; truncate any ISO timestamp before binding.
      const displayValue =
        field.type === 'date' && typeof v === 'string' && v.length >= 10
          ? v.slice(0, 10)
          : (v as string | number | null | undefined) ?? '';
      return (
        <div key={field.key} className="form-field">
          <label htmlFor={idAttr}>{field.label}{mark}</label>
          <input
            id={idAttr}
            type={inputType}
            className={hasError ? 'input-error' : undefined}
            aria-required={field.required || undefined}
            aria-invalid={hasError || undefined}
            value={displayValue === null || displayValue === undefined ? '' : String(displayValue)}
            onChange={(e) => setValue(field.key, e.target.value)}
            placeholder={field.key}
            // Predictive autocomplete for free-text custom fields, drawn from
            // existing values for this field (title-like uniqueness aside).
            list={field.type === 'text' ? `suggest-cf-${field.key}` : undefined}
          />
        </div>
      );
    };

    // The everyday attributes get their own boxed group at the top. The
    // librarian fills these on nearly every book; alphabetical ordering used to
    // scatter them through two dozen fields they rarely touch.
    return (
      <>
        {pinnedCustomFields.length > 0 && (
          <div className="cf-pinned-group">
            <p className="cf-group-heading">★ {t('settings.pinnedGroup', { n: pinnedCustomFields.length })}</p>
            <div className="custom-fields-grid">{pinnedCustomFields.map(renderField)}</div>
          </div>
        )}
        {unpinnedCustomFields.length > 0 && (
          <>
            {pinnedCustomFields.length > 0 && (
              <p className="cf-group-heading">{t('settings.otherGroup', { n: unpinnedCustomFields.length })}</p>
            )}
            <div className="custom-fields-grid">{unpinnedCustomFields.map(renderField)}</div>
          </>
        )}
      </>
    );
  }

  // Enter edit mode for a book. With no argument it edits the book already open
  // in the detail modal (the modal's Edit button); passing a book (e.g. from the
  // right-click menu on a card) opens that book straight into edit mode.
  function startEditFromDetail(src: Book | null = detailBook) {
    const b = src ?? detailBook;
    if (!b) return;
    if (!detailBook || detailBook.id !== b.id) {
      setDetailBook(b);
      setBookHistory([]);
      void loadBookHistory(b.id);
    }
    setDetailMode('edit');
    setEditForm({
      id: b.id,
      title: b.title,
      author: b.author,
      isbn: b.isbn ?? '',
      shelfCode: b.shelfCode ?? '',
      publicationYear: b.publicationYear?.toString() ?? '',
      status: b.status,
      version: b.version,
      publisher: b.publisher ?? '',
      language: b.language ?? '',
      description: b.description ?? ''
    });
    setAttributeEditorValues(b.customFields ?? {});
  }

  // ── Context-menu plumbing ─────────────────────────────────────────────────
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Open the custom menu at the cursor, suppressing the native one. Items are
  // pruned first so a permission-filtered menu never shows an empty section; if
  // nothing survives we let the native menu through (no preventDefault).
  function openContextMenu(e: React.MouseEvent, items: CtxItem[], title?: string) {
    const cleaned = pruneCtxItems(items);
    if (cleaned.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, items: cleaned, title });
  }

  function copyText(text: string, whatLabel: string) {
    if (!text) return;
    // Only claim success once the write actually resolves; in an insecure
    // context navigator.clipboard is undefined, so don't show a false "copied".
    const p = navigator.clipboard?.writeText(text);
    if (p) p.then(() => pushAppToast('success', t('ctx.copied', { what: whatLabel }))).catch(() => setError(t('toast.copyFailed')));
    else setError(t('toast.copyFailed'));
  }

  // Fire the hidden cover picker for a specific book (used by the menu item).
  function triggerCoverUpload(book: Book) {
    coverUploadBookRef.current = book;
    coverInputRef.current?.click();
  }

  // A loan row only carries a bookId; the current page of `books` may not hold
  // it, so fetch the full record before opening the detail modal.
  async function openBookById(bookId: string) {
    try {
      const book = await apiRequest<Book>(`/api/books/${bookId}`);
      setCurrentSection('books');
      openBookDetail(book);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function buildBookMenu(book: Book): CtxItem[] {
    const items: CtxItem[] = [];
    items.push({ label: t('ctx.view'), icon: '📖', onClick: () => openBookDetail(book) });
    if (canWrite) items.push({ label: t('ctx.edit'), icon: '✏️', onClick: () => startEditFromDetail(book) });
    if (canSeeCirculation && book.status === 'available') {
      // Mirror the detail-modal Borrow button, including closing the modal so the
      // circulation borrow form isn't hidden behind it.
      items.push({ label: t('ctx.borrow'), icon: '📤', onClick: () => { setSelectedBook(book); setCurrentSection('circulation'); if (detailBook) closeDetail(); } });
    }
    if (canSeeCirculation && book.status === 'borrowed') {
      items.push({ label: t('ctx.return'), icon: '📥', onClick: () => { void returnBook(book); if (detailBook) closeDetail(); } });
    }

    // Cover group.
    const cover: CtxItem[] = [];
    if (book.coverUrl) cover.push({ label: t('ctx.zoomCover'), icon: '🔍', onClick: () => setCoverZoom(joinApiUrl(book.coverUrl!)) });
    if (canWrite) cover.push({ label: book.coverUrl ? t('ctx.replaceCover') : t('ctx.addCover'), icon: '🖼️', onClick: () => triggerCoverUpload(book) });
    if (canWrite && book.coverUrl) cover.push({ label: t('ctx.removeCover'), icon: '🗑️', onClick: () => void deleteBookCover(book) });
    if (cover.length) { items.push({ sep: true }); items.push(...cover); }

    // Labels / codes group.
    if (canPrintLabels) {
      items.push({ sep: true });
      items.push({ label: t('ctx.printLabel'), icon: '🏷️', onClick: () => void printLabels([book]) });
      items.push({ label: t('ctx.genQr'), icon: '🔳', onClick: () => void generateCode(book, 'qr') });
      items.push({ label: t('ctx.genBarcode'), icon: '📊', onClick: () => void generateCode(book, 'barcode') });
    }

    // Copy group — only offer fields that actually have a value (so a menu item
    // never silently no-ops), and only show the group when something is copyable.
    const copy: CtxItem[] = [];
    if (book.title && !isPlaceholder(book.title, 'title')) copy.push({ label: t('ctx.copyTitle'), onClick: () => copyText(book.title, t('ctx.copyTitle')) });
    if (book.author && !isPlaceholder(book.author, 'author')) copy.push({ label: t('ctx.copyAuthor'), onClick: () => copyText(book.author, t('ctx.copyAuthor')) });
    if (book.isbn) copy.push({ label: t('ctx.copyIsbn'), onClick: () => copyText(book.isbn!, t('ctx.copyIsbn')) });
    if (book.shelfCode) copy.push({ label: t('ctx.copyShelf'), onClick: () => copyText(book.shelfCode!, t('ctx.copyShelf')) });
    if (book.legacyId) copy.push({ label: t('ctx.copyLegacy'), onClick: () => copyText(book.legacyId!, t('ctx.copyLegacy')) });
    if (copy.length) {
      items.push({ sep: true });
      items.push({ header: t('ctx.copyHeader') });
      items.push(...copy);
    }

    // Selection.
    if (canWrite) {
      const isSel = selectedBookIds.includes(book.id);
      items.push({ sep: true });
      items.push({
        label: isSel ? t('ctx.deselect') : t('ctx.select'),
        icon: isSel ? '☑️' : '⬜',
        onClick: () => { if (!selectionMode) setSelectionMode(true); toggleBookSelection(book.id); }
      });
      // Criteria-based selection: pick up every book sharing this book's author,
      // shelf or publisher — in one click, across the whole catalogue.
      const sameAuthor = book.author && !isPlaceholder(book.author, 'author') ? book.author : '';
      if (sameAuthor) {
        items.push({
          label: t('ctx.selectSameAuthor'),
          icon: '👤',
          onClick: () => selectByCriterion('authorExact', sameAuthor, t('ctx.selectSameAuthorWhat'))
        });
      }
      if (book.shelfCode) {
        items.push({
          label: t('ctx.selectSameShelf', { code: book.shelfCode }),
          icon: '🗄️',
          onClick: () => selectByCriterion('shelfExact', book.shelfCode!, t('ctx.selectSameShelfWhat'))
        });
      }
      if (book.publisher) {
        items.push({
          label: t('ctx.selectSamePublisher'),
          icon: '🏢',
          onClick: () => selectByCriterion('publisherExact', book.publisher!, t('ctx.selectSamePublisherWhat'))
        });
      }
    }

    // Delete (destructive, last).
    if (canDelete) {
      items.push({ sep: true });
      items.push({ label: t('ctx.delete'), icon: '🗑️', danger: true, onClick: () => void deleteBook(book) });
    }
    return items;
  }

  function buildCategoryMenu(cat: CategoryItem): CtxItem[] {
    const items: CtxItem[] = [];
    const active = categoryFilter === cat.code;
    items.push({ label: t('ctx.filterCategory'), icon: '📂', disabled: active, onClick: () => { setCategoryFilter(cat.code); setCurrentPage(1); } });
    if (categoryFilter) items.push({ label: t('ctx.clearCategoryFilter'), icon: '✖️', onClick: () => { setCategoryFilter(''); setCurrentPage(1); } });
    items.push({ sep: true });
    items.push({ label: t('ctx.copyName'), onClick: () => copyText(cat.label ? `${cat.code} ${cat.label}` : cat.code, t('ctx.copyName')) });
    return items;
  }

  function buildLoanMenu(loan: ActiveBorrow): CtxItem[] {
    const items: CtxItem[] = [];
    const title = displayTitle({ title: loan.title }, t('common.untitled'));
    if (canSeeCirculation) items.push({ label: t('ctx.returnLoan'), icon: '📥', onClick: () => void quickReturnByBookId(loan.bookId, title, loan.id) });
    items.push({ label: t('ctx.openBook'), icon: '📖', onClick: () => void openBookById(loan.bookId) });
    if (canSeeCirculation && activeBorrows.some((l) => l.isOverdue)) {
      items.push({ label: t('ctx.returnAllOverdue'), icon: '⏰', onClick: () => void returnAllOverdue() });
    }
    items.push({ sep: true });
    items.push({ label: t('ctx.copyBorrower'), onClick: () => copyText(loan.borrowerContact ? `${loan.borrowerName} · ${loan.borrowerContact}` : loan.borrowerName, t('ctx.copyBorrower')) });
    return items;
  }

  // The fallback menu for empty space / general areas, plus copy+search when
  // there is a text selection.
  function buildDefaultMenu(selection: string): CtxItem[] {
    const items: CtxItem[] = [];
    const sel = selection.trim();
    if (sel) {
      const short = sel.length > 30 ? `${sel.slice(0, 30)}…` : sel;
      items.push({ label: t('ctx.copySelection'), icon: '📋', onClick: () => copyText(sel, t('ctx.copySelectionWhat')) });
      items.push({ label: t('ctx.searchSelection', { q: short }), icon: '🔎', onClick: () => { setQ(sel); setCurrentSection('books'); setCurrentPage(1); } });
      items.push({ sep: true });
    }
    if (canWrite) items.push({ label: t('ctx.addBook'), icon: '➕', onClick: () => { setCurrentSection('books'); setShowAddBook(true); } });
    items.push({ label: t('ctx.refresh'), icon: '🔄', onClick: () => void refreshEverything() });
    if (canExportCsv) items.push({ label: t('ctx.exportCsv'), icon: '⬇️', onClick: () => void exportFilteredBooksCsv() });
    items.push({ sep: true });
    items.push({ label: t('ctx.toggleTheme'), icon: theme === 'dark' ? '☀️' : '🌙', onClick: () => setTheme((c) => (c === 'dark' ? 'light' : 'dark')) });
    return items;
  }

  // Root-level right-click: default menu for empty space, but never hijack the
  // native menu on editable fields (a librarian needs cut/copy/paste there).
  function handleRootContextMenu(e: React.MouseEvent) {
    if (!loggedIn) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const selection = window.getSelection()?.toString() ?? '';
    openContextMenu(e, buildDefaultMenu(selection));
  }

  return (
    <div className="app-shell" aria-busy={isWorking} onContextMenu={handleRootContextMenu}>

      {/* Autocomplete suggestions for the add/edit book forms, sourced from the
          catalog's existing values so a librarian rarely retypes a repeated
          title, author, publisher, language, or shelf code. Datalists render
          nothing themselves; inputs opt in via a matching `list` attribute.
          Memoized so keystrokes don't rebuild the option lists. */}
      <CatalogDatalists facets={facets} />

      {/* ═══ OFFLINE BANNER ═══ */}
      {netStatus === 'offline' && (
        <div className="offline-banner" role="status" aria-live="polite">
          {t('app.offlineBanner')}
        </div>
      )}

      {/* ═══ SPLASH SCREEN ═══ */}
      {showSplash && (
        <div className={`splash-overlay${splashHiding ? ' splash-hiding' : ''}`}>
          <div className="splash-content">
            <div className="splash-logo">📚</div>
            <h1 className="splash-title">{t('app.brand')}</h1>
            <div className="splash-spinner" />
          </div>
        </div>
      )}

      {/* ═══ BULK EDIT MODAL ═══ */}
      {/* Reaches every field a bulk edit may touch. The rule the whole panel is
          built around: a control the librarian did not touch writes NOTHING.
          An empty box means "leave it alone" — blanking a field across a
          selection is a separate, explicit "Clear" toggle. */}
      {bulkEditOpen && canWrite && (
        <div className="modal-overlay" onClick={closeBulkEditor} role="dialog" aria-modal="true">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '46rem' }}>
            <div className="modal-header">
              <div className="modal-title-block">
                <h2>{t('library.bulk.editTitle')}</h2>
                <p className="muted small">
                  {t('library.bulk.editSubtitle', { n: selectedBookIds.length })}
                </p>
              </div>
            </div>

            <div style={{ padding: '1rem 1.5rem 1.5rem' }}>
              <p className="muted small" style={{ marginBottom: '1rem' }}>
                {t('library.bulk.editHint')}
              </p>

              <h4 className="bulk-section-heading">{t('library.bulk.sectionCore')}</h4>
              <div className="custom-fields-grid">
                {/* Bound to the same state as the quick selector in the bar. */}
                <div className="form-field bulk-field">
                  <label htmlFor="bulk-status">{t('library.bulk.setStatusAria')}</label>
                  <select id="bulk-status" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                    <option value="">{t('library.bulk.unchanged')}</option>
                    <option value="available">{t('status.available')}</option>
                    {/* No 'borrowed' — lending goes through the borrow action. */}
                    <option value="lost">{t('status.lost')}</option>
                    <option value="maintenance">{t('status.maintenance')}</option>
                  </select>
                </div>
                {BULK_CORE_FIELDS.map((field) => {
                  const fieldId = `core:${field.key}`;
                  const cleared = bulkEditClears.has(fieldId);
                  return (
                    <div key={fieldId} className="form-field bulk-field">
                      <label htmlFor={`bulk-${fieldId}`}>{t(field.labelKey)}</label>
                      <input
                        id={`bulk-${fieldId}`}
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={bulkEditValues[fieldId] ?? ''}
                        disabled={cleared}
                        onChange={(e) => setBulkEditValue(fieldId, e.target.value)}
                        placeholder={cleared ? t('library.bulk.willClear') : t('library.bulk.unchanged')}
                        list={field.listId}
                      />
                      <label className="checkbox-label bulk-clear">
                        <input
                          type="checkbox"
                          checked={cleared}
                          onChange={() => toggleBulkEditClear(fieldId)}
                        />
                        <span className="muted small">{t('library.bulk.clear2')}</span>
                      </label>
                    </div>
                  );
                })}
              </div>

              <h4 className="bulk-section-heading">{t('library.bulk.sectionTags')}</h4>
              <div className="custom-fields-grid">
                <div className="form-field">
                  <label htmlFor="bulk-tags-add">{t('library.bulk.tagsAdd')}</label>
                  <input
                    id="bulk-tags-add"
                    value={bulkTagsAdd}
                    onChange={(e) => setBulkTagsAdd(e.target.value)}
                    placeholder={t('library.bulk.tagsPh')}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="bulk-tags-remove">{t('library.bulk.tagsRemove')}</label>
                  <input
                    id="bulk-tags-remove"
                    value={bulkTagsRemove}
                    onChange={(e) => setBulkTagsRemove(e.target.value)}
                    placeholder={t('library.bulk.tagsPh')}
                  />
                </div>
              </div>

              {customFields.length > 0 && (
                <>
                  <h4 className="bulk-section-heading">{t('library.bulk.sectionAttrs')}</h4>
                  {pinnedCustomFields.length > 0 && (
                    <div className="cf-pinned-group">
                      <p className="cf-group-heading">★ {t('settings.pinnedGroup', { n: pinnedCustomFields.length })}</p>
                      <div className="custom-fields-grid">
                        {pinnedCustomFields.map(renderBulkCustomField)}
                      </div>
                    </div>
                  )}
                  {unpinnedCustomFields.length > 0 && (
                    <>
                      {pinnedCustomFields.length > 0 && (
                        <p className="cf-group-heading">{t('settings.otherGroup', { n: unpinnedCustomFields.length })}</p>
                      )}
                      <div className="custom-fields-grid">
                        {unpinnedCustomFields.map(renderBulkCustomField)}
                      </div>
                    </>
                  )}
                </>
              )}

              <div className="modal-actions" style={{ marginTop: '1.25rem' }}>
                <button className="secondary" onClick={resetBulkEditor}>
                  {t('library.bulk.resetFields')}
                </button>
                <button className="secondary" onClick={closeBulkEditor}>
                  {t('common.cancel')}
                </button>
                <button
                  className="primary"
                  disabled={bulkEditPendingCount === 0 || selectedBookIds.length === 0}
                  onClick={() => void applyBulkBookChanges()}
                >
                  {t('library.bulk.applyN', { fields: bulkEditPendingCount, books: selectedBookIds.length })}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ PROFILE MODAL ═══ */}
      {profileOpen && currentUser && (
        <div className="modal-overlay" onClick={() => setProfileOpen(false)} role="dialog" aria-modal="true">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '32rem' }}>
            <div className="modal-header">
              <div className="modal-title-block">
                <h2>{t('profile.title')}</h2>
                <p className="muted small">{t('profile.subtitle')}</p>
              </div>
            </div>
            <div style={{ padding: '1rem 1.5rem 1.5rem' }}>
              <div style={{ marginBottom: '1rem' }}>
                <label className="muted small">{t('users.uuid')}</label>
                <div
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    background: 'rgba(127,127,127,0.1)',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    wordBreak: 'break-all',
                    marginTop: '0.25rem'
                  }}
                  title={t('users.uuidCopy')}
                  onClick={() => {
                    void navigator.clipboard?.writeText(currentUser.id);
                    toast.push('success', t('users.uuidCopied'));
                  }}
                >
                  {currentUser.id}
                </div>
                <p className="muted small" style={{ marginTop: '0.35rem' }}>{t('profile.uuidHint')}</p>
              </div>
              <div style={{ marginBottom: '1rem' }}>
                <label className="muted small">{t('users.role')}</label>
                <div><code>{t(`users.role.${currentUser.role}` as never)}</code></div>
              </div>
              <form onSubmit={saveProfile} className="simple-form">
                <div>
                  <label>{t('users.username')}</label>
                  <input
                    value={profileUsername}
                    onChange={(e) => setProfileUsername(e.target.value)}
                    minLength={3}
                    autoComplete="username"
                  />
                </div>
                <div>
                  <label>{t('profile.newPassword')}</label>
                  <input
                    type="password"
                    value={profileNewPassword}
                    onChange={(e) => setProfileNewPassword(e.target.value)}
                    placeholder={t('profile.newPasswordPh')}
                    autoComplete="new-password"
                    minLength={8}
                  />
                  <p className="muted small">{t('users.passwordHint')}</p>
                </div>
                <div>
                  <label>{t('profile.currentPassword')} *</label>
                  <input
                    type="password"
                    value={profileCurrentPassword}
                    onChange={(e) => setProfileCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <p className="muted small">{t('profile.currentHint')}</p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
                  <button type="button" className="secondary" onClick={() => setProfileOpen(false)} disabled={profileSubmitting}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="primary" disabled={profileSubmitting}>
                    {profileSubmitting ? t('common.loading') : t('profile.save')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ═══ BOOK DETAIL MODAL ═══ */}
      {detailBook && (
        <div className="modal-overlay" onClick={closeDetail} role="dialog" aria-modal="true">
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              // Keep the native menu on the edit form's text fields.
              if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
              openContextMenu(e, buildBookMenu(detailBook), displayTitle(detailBook, t('common.untitled')));
            }}
          >

            {/* Header */}
            <div className="modal-header">
              <div className="modal-avatar">{(displayTitle(detailBook, t('common.untitled')).charAt(0) || '?').toUpperCase()}</div>
              <div className="modal-title-block">
                <h2 className={isPlaceholder(detailBook.title, 'title') || !detailBook.title ? 'is-placeholder' : ''}>
                  {displayTitle(detailBook, t('common.untitled'))}
                </h2>
                <p className={`modal-author${isPlaceholder(detailBook.author, 'author') || !detailBook.author ? ' is-placeholder' : ''}`}>
                  {displayAuthor(detailBook, t('common.unknownAuthor'))}
                </p>
                <div className="modal-pills">
                  <span className={`status-badge status-${detailBook.status}`}>{detailBook.status}</span>
                  {detailBook.legacyId ? (
                    <span className="legacy-id-pill" title={t('detail.legacyTitle')}>{detailBook.legacyId}</span>
                  ) : null}
                </div>
              </div>
              <div className="modal-shelf-block" aria-label={detailBook.shelfCode ? t('detail.shelfAria', { code: detailBook.shelfCode }) : t('detail.shelfNoneAria')}>
                <span className="modal-shelf-label">{t('detail.shelf')}</span>
                <span className={`modal-shelf-value${detailBook.shelfCode ? '' : ' is-empty'}`}>
                  {detailBook.shelfCode || '—'}
                </span>
              </div>
              <button className="modal-close" onClick={closeDetail} title={t('common.close')}>✕</button>
            </div>

            {/* Action bar */}
            <div className="modal-actions">
              {detailMode === 'view' ? (
                <>
                  {canWrite && (
                    <button className="secondary small" onClick={() => startEditFromDetail()}>{t('detail.editBtn')}</button>
                  )}
                  {canWrite && Boolean((detailBook.customFields as Record<string, unknown> | undefined)?.needs_review) && (
                    <button className="primary small" onClick={() => void markReviewed(detailBook)}>{t('detail.markReviewed')}</button>
                  )}
                  {canSeeCirculation && detailBook.status === 'available' && (
                    <button className="primary small" onClick={() => {
                      setSelectedBook(detailBook);
                      setCurrentSection('circulation');
                      closeDetail();
                    }}>{t('detail.borrowBtn')}</button>
                  )}
                  {canSeeCirculation && detailBook.status === 'borrowed' && (
                    <button className="secondary small" onClick={() => { void returnBook(detailBook); closeDetail(); }}>
                      {t('detail.returnBtn')}
                    </button>
                  )}
                  {canPrintLabels && (
                    <button className="secondary small" onClick={() => void printLabels([detailBook])}>{t('detail.labelBtn')}</button>
                  )}
                  {canDelete && (
                    <button className="danger small" onClick={() => void deleteBook(detailBook)}>{t('detail.deleteBtn')}</button>
                  )}
                </>
              ) : (
                <button className="secondary small" onClick={() => setDetailMode('view')}>{t('detail.backBtn')}</button>
              )}
            </div>

            {/* Body */}
            <div className="modal-body">
              {detailMode === 'view' ? (
                <>
                  {/* Cover image */}
                  <div className="detail-section cover-section">
                    {detailBook.coverUrl ? (
                      <button
                        type="button"
                        className="detail-cover-zoom"
                        onClick={() => setCoverZoom(joinApiUrl(detailBook.coverUrl!))}
                        title={t('detail.coverZoomHint')}
                        aria-label={t('detail.coverZoomHint')}
                      >
                        <img
                          className="detail-cover"
                          src={joinApiUrl(detailBook.coverUrl)}
                          alt={t('detail.coverAlt', { title: displayTitle(detailBook, t('common.untitled')) })}
                          loading="lazy"
                        />
                        <span className="cover-zoom-hint" aria-hidden="true">
                          <span className="cover-zoom-icon">🔍</span>
                          {t('detail.coverZoomHint')}
                        </span>
                      </button>
                    ) : (
                      <div className="detail-cover detail-cover-placeholder">
                        <span>{t('detail.noCover')}</span>
                      </div>
                    )}
                    {canWrite && (
                      <div className="cover-actions">
                        <label className="secondary small button-like">
                          {detailBook.coverUrl ? t('detail.replaceCover') : t('detail.uploadCover')}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              e.target.value = '';
                              if (f) void uploadBookCover(detailBook, f);
                            }}
                          />
                        </label>
                        {detailBook.coverUrl && (
                          <button className="danger small" onClick={() => void deleteBookCover(detailBook)}>{t('detail.removeCover')}</button>
                        )}
                        <span className="muted small">{t('detail.coverHint')}</span>
                      </div>
                    )}
                  </div>

                  {/* Core Info */}
                  <div className="detail-section">
                    <div className="detail-section-title">{t('detail.bookInfo')}</div>
                    <div className="detail-grid">
                      {detailBook.isbn && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.isbn')}</span>
                          <span className="di-value">{detailBook.isbn}</span>
                        </div>
                      )}
                      {detailBook.publicationYear && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.yearPublished')}</span>
                          <span className="di-value">{detailBook.publicationYear}</span>
                        </div>
                      )}
                      {detailBook.publisher && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.publisher')}</span>
                          <span className="di-value">{detailBook.publisher}</span>
                        </div>
                      )}
                      {detailBook.language && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.language')}</span>
                          <span className="di-value">{detailBook.language}</span>
                        </div>
                      )}
                      {detailBook.roomCode && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.room')}</span>
                          <span className="di-value">{detailBook.roomCode}</span>
                        </div>
                      )}
                      {detailBook.shelfCode && (
                        <div className="detail-item">
                          <span className="di-label">{t('detail.shelfRow')}</span>
                          <span className="di-value">{detailBook.shelfCode}</span>
                        </div>
                      )}
                      <div className="detail-item">
                        <span className="di-label">{t('detail.statusRow')}</span>
                        <span className="di-value">
                          <span className={`status-badge status-${detailBook.status}`}>{t(`status.${detailBook.status}`)}</span>
                        </span>
                      </div>
                    </div>
                    {detailBook.description && (
                      <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.6' }}>
                        {detailBook.description}
                      </p>
                    )}
                  </div>

                  {/* Custom field attributes */}
                  {detailBook.customFields &&
                    Object.entries(detailBook.customFields).filter(([, v]) => v !== null && v !== undefined && v !== '').length > 0 && (
                    <div className="detail-section">
                      <div className="detail-section-title">{t('detail.attributes')}</div>
                      <div className="attr-grid">
                        {Object.entries(detailBook.customFields).map(([key, value]) =>
                          value !== null && value !== undefined && value !== '' ? (
                            <div key={key} className="attr-tile">
                              <span className="attr-key">{key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}</span>
                              <span className="attr-value">{String(value)}</span>
                            </div>
                          ) : null
                        )}
                      </div>
                    </div>
                  )}

                  {/* Borrow History */}
                  {canSeeCirculation && (
                  <div className="detail-section">
                    <div className="detail-section-title">{t('detail.history')}</div>
                    {bookHistory.length === 0 ? (
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>{t('detail.noHistory')}</p>
                    ) : (
                      <div className="history-list">
                        {bookHistory.map((h) => (
                          <div key={h.id} className="history-item">
                            <div className="history-item-info">
                              <strong>{h.borrowerName}</strong>
                              <span>
                                {new Date(h.borrowedAt).toLocaleDateString()} →{' '}
                                {h.returnedAt ? new Date(h.returnedAt).toLocaleDateString() : t('detail.currentlyActive')}
                              </span>
                            </div>
                            {h.wasOverdue && <span className="history-overdue-badge">{t('detail.overdueBadge')}</span>}
                          </div>
                        ))}
                        {bookHistoryHasMore && detailBook && (
                          <button
                            type="button"
                            className="secondary small"
                            style={{ alignSelf: 'flex-start' }}
                            onClick={() => void loadBookHistory(detailBook.id, bookHistory.length)}
                          >{t('detail.loadMoreHistory')}</button>
                        )}
                      </div>
                    )}
                  </div>
                  )}
                </>
              ) : (
                /* ── Edit Mode ── */
                <form onSubmit={saveBookEdit} className="simple-form">
                  <div className="form-row">
                    <div>
                      <label>{t('detail.title')}<span className="required-mark"> *</span></label>
                      <input
                        ref={editTitleInputRef}
                        className={editFieldErrors.has('title') ? 'input-error' : undefined}
                        aria-required="true"
                        aria-invalid={editFieldErrors.has('title') || undefined}
                        value={editForm.title}
                        onChange={(e) => {
                          setEditForm({ ...editForm, title: e.target.value });
                          if (editFieldErrors.has('title')) {
                            setEditFieldErrors((prev) => {
                              const next = new Set(prev);
                              next.delete('title');
                              return next;
                            });
                          }
                        }}
                      />
                    </div>
                    <div>
                      <label>{t('detail.author')}</label>
                      <input list="suggest-author" value={editForm.author} onChange={(e) => setEditForm({ ...editForm, author: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>{t('detail.isbn')}</label>
                      <input className="isbn-input" value={editForm.isbn} onChange={(e) => setEditForm({ ...editForm, isbn: e.target.value })} placeholder={t('detail.isbnPh')} inputMode="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
                    </div>
                    <div>
                      <label>{t('detail.yearPublished')}</label>
                      <input type="number" min={1000} max={3000} value={editForm.publicationYear} onChange={(e) => setEditForm({ ...editForm, publicationYear: e.target.value })} placeholder={t('detail.yearPh')} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>{t('detail.shelfRow')}</label>
                      <input list="suggest-shelf" value={editForm.shelfCode} onChange={(e) => setEditForm({ ...editForm, shelfCode: e.target.value })} placeholder={t('detail.shelfPh')} />
                    </div>
                    <div>
                      <label>{t('detail.statusRow')}</label>
                      <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value as BookStatus })}>
                        {/* 'borrowed' is owned by the borrow/return actions — the
                            server rejects setting it manually (or clearing it to
                            available). Offer only the transitions the edit path is
                            allowed to make from the book's real current state. */}
                        {detailBook?.status === 'borrowed'
                          ? <option value="borrowed">{t('status.borrowed')}</option>
                          : <option value="available">{t('status.available')}</option>}
                        <option value="lost">{t('status.lost')}</option>
                        <option value="maintenance">{t('status.maintenance')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>{t('detail.publisher')}</label>
                      <input list="suggest-publisher" value={editForm.publisher} onChange={(e) => setEditForm({ ...editForm, publisher: e.target.value })} placeholder={t('detail.publisherPh')} />
                    </div>
                    <div>
                      <label>{t('detail.language')}</label>
                      <input list="suggest-language" value={editForm.language} onChange={(e) => setEditForm({ ...editForm, language: e.target.value })} placeholder={t('detail.languagePh')} />
                    </div>
                  </div>
                  <div className="form-field">
                    <label>{t('library.add.description')}</label>
                    <textarea
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      rows={3}
                    />
                  </div>

                  <details className="custom-fields-section" open>
                    <summary>{t('library.add.attributes', { n: customFields.length })}</summary>
                    {renderCustomFieldsForm(
                      attributeEditorValues,
                      (key, value) => {
                        setAttributeEditorValues((prev) => ({ ...prev, [key]: value }));
                        const empty = value === undefined || value === null || value === '';
                        if (!empty && editFieldErrors.has(`cf:${key}`)) {
                          setEditFieldErrors((prev) => {
                            const next = new Set(prev);
                            next.delete(`cf:${key}`);
                            return next;
                          });
                        }
                      },
                      editFieldErrors
                    )}
                  </details>

                  <div className="button-group">
                    <button type="submit" className="primary">{t('detail.saveChanges')}</button>
                    <button type="button" className="secondary" onClick={() => setDetailMode('view')}>{t('common.cancel')}</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ COVER ZOOM LIGHTBOX ═══ */}
      {coverZoom && (
        <div
          className="lightbox-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('detail.coverZoomAria')}
          onClick={() => setCoverZoom(null)}
        >
          <button
            type="button"
            className="lightbox-close"
            onClick={() => setCoverZoom(null)}
            title={t('common.close')}
            aria-label={t('common.close')}
          >✕</button>
          {/* Clicking anywhere (backdrop or the image) closes — matches the hint. */}
          <img className="lightbox-img" src={coverZoom} alt={t('detail.coverZoomAria')} />
        </div>
      )}

      {/* ═══ CUSTOM CONTEXT MENU ═══ */}
      {contextMenu && <ContextMenuView state={contextMenu} onClose={closeContextMenu} />}
      {/* Hidden picker reused by the "Replace/Add cover" menu item. */}
      <input
        ref={coverInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          const b = coverUploadBookRef.current;
          coverUploadBookRef.current = null;
          if (f && b) void uploadBookCover(b, f);
        }}
      />

      {/* ═══ ONBOARDING COURSE (replay from Settings — closable) ═══ */}
      {showOnboarding && !mustOnboard && (
        <OnboardingCourse onFinish={() => void completeOnboarding()} onClose={() => setShowOnboarding(false)} />
      )}

      {/* ═══ LOGIN ═══ */}
      {sessionLoading ? null : !loggedIn ? (
        <div className="simple-center">
          <div className="simple-card">
            <div className="login-logo">📚</div>
            <h2>{t('app.brand')}</h2>
            <p className="login-subtitle">{t('app.subtitle')}</p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.75rem' }}>
              <LanguageSwitcher />
            </div>
            <form onSubmit={login} className="simple-form">
              <div>
                <label>{t('login.username')}</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
              </div>
              <div>
                <label>{t('login.password')}</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <button type="submit" className="primary">{isWorking ? t('login.signingIn') : t('login.signIn')}</button>
            </form>
          </div>
        </div>
      ) : mustOnboard ? (
        /* Mandatory first-run librarian course — no bypass; the app below is
           unreachable until it's finished (which flips needsOnboarding false). */
        <OnboardingCourse mandatory onFinish={() => void completeOnboarding()} />
      ) : (
        <>
          {/* ─── Navbar ─── */}
          <div className="simple-navbar">
            <div className="navbar-brand">
              <div className="navbar-icon">📚</div>
              <h1>{t('app.brand')}</h1>
            </div>
            <div className="navbar-right">
              <DownloadDesktopButton />
              <LanguageSwitcher />
              <button
                className="theme-toggle"
                onClick={() => setTheme((curr) => (curr === 'dark' ? 'light' : 'dark'))}
                title={theme === 'dark' ? t('app.switchToLight') : t('app.switchToDark')}
                aria-label={t('app.toggleDark')}
              >
                {theme === 'dark' ? '☀' : '🌙'}
              </button>
              {currentUser && (
                <button
                  type="button"
                  className="secondary small"
                  onClick={openProfile}
                  title={t('profile.open')}
                  aria-label={t('profile.open')}
                >
                  👤 {currentUser.username}
                </button>
              )}
              <button className="secondary small" onClick={logout}>{t('app.signOut')}</button>
            </div>
          </div>

          {/* ─── Tabs ─── */}
          <div className="simple-tabs">
            {sectionMeta.map((section) => (
              <button
                key={section.key}
                className={currentSection === section.key ? 'tab-btn active' : 'tab-btn'}
                onClick={() => setCurrentSection(section.key)}
              >
                <span className="tab-icon" aria-hidden="true">{section.icon}</span>
                <span className="tab-label">{section.label}</span>
              </button>
            ))}
          </div>

          <div className="simple-content">

            {/* ═══ DASHBOARD TAB ═══ */}
            {currentSection === 'dashboard' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('dashboard.title')}</h2>
                    <p>{t('dashboard.description')}</p>
                  </div>
                  <div className="section-header-actions">
                    <button className="secondary small" onClick={() => void loadStats()}>{t('common.refresh')}</button>
                  </div>
                </div>

                {!stats ? (
                  <div className="card empty-state"><p style={{ fontSize: '2rem' }}>📊</p><p>{t('dashboard.loading')}</p></div>
                ) : (
                  <>
                    {/* KPI tiles */}
                    <div className="stats-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                      <div className="stat-box accent">
                        <span className="stat-box-label">{t('dashboard.totalBooks')}</span>
                        <span className="stat-box-value">{fmt(stats.completeness.total)}</span>
                      </div>
                      <div className="stat-box success">
                        <span className="stat-box-label">{t('status.available')}</span>
                        <span className="stat-box-value">
                          {fmt(stats.byStatus.find((s) => s.status === 'available')?.count ?? 0)}
                        </span>
                      </div>
                      <div className="stat-box warning">
                        <span className="stat-box-label">{t('status.borrowed')}</span>
                        <span className="stat-box-value">
                          {fmt(stats.byStatus.find((s) => s.status === 'borrowed')?.count ?? 0)}
                        </span>
                      </div>
                      <div className="stat-box danger">
                        <span className="stat-box-label">{t('dashboard.lostMaint')}</span>
                        <span className="stat-box-value">
                          {fmt((stats.byStatus.find((s) => s.status === 'lost')?.count ?? 0)
                            + (stats.byStatus.find((s) => s.status === 'maintenance')?.count ?? 0))}
                        </span>
                      </div>
                    </div>

                    <div className="dashboard-grid">
                      {/* Completeness */}
                      <div className="card">
                        <h3>{t('dashboard.completeness')}</h3>
                        <div className="completeness-list">
                          {([
                            [t('dashboard.compl.isbn'), stats.completeness.withIsbn],
                            [t('dashboard.compl.shelf'), stats.completeness.withShelf],
                            [t('dashboard.compl.publisher'), stats.completeness.withPublisher],
                            [t('dashboard.compl.year'), stats.completeness.withYear]
                          ] as Array<[string, number]>).map(([label, n]) => {
                            const pct = stats.completeness.total > 0
                              ? Math.round((n / stats.completeness.total) * 100)
                              : 0;
                            return (
                              <div key={label} className="completeness-row">
                                <span className="completeness-label">{label}</span>
                                <div className="completeness-bar">
                                  <div className="completeness-fill" style={{ width: `${pct}%` }} />
                                </div>
                                <span className="completeness-pct">{pct}%</span>
                                <span className="completeness-count">{fmt(n)}</span>
                              </div>
                            );
                          })}
                        </div>
                        {(stats.completeness.untitled > 0 || stats.completeness.unknownAuthor > 0) && (
                          <p className="muted small" style={{ marginTop: '0.75rem' }}>
                            {t('dashboard.complNote', { untitled: fmt(stats.completeness.untitled), unknown: fmt(stats.completeness.unknownAuthor) })}
                          </p>
                        )}
                      </div>

                      {/* Languages */}
                      <div className="card">
                        <h3>{t('dashboard.languages')}</h3>
                        {stats.byLanguage.length === 0 ? (
                          <p className="muted small">{t('dashboard.noLangData')}</p>
                        ) : (
                          <div className="minibar-list">
                            {stats.byLanguage.map((l) => (
                              <MiniBar
                                key={l.language}
                                label={l.language}
                                value={l.count}
                                count={l.count}
                                max={stats.byLanguage[0].count}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Years */}
                      <div className="card">
                        <h3>{t('dashboard.publicationYear')}</h3>
                        <div className="minibar-list">
                          {stats.byYear.map((y) => (
                            <MiniBar
                              key={y.bucket}
                              label={y.bucket}
                              value={y.count}
                              count={y.count}
                              max={Math.max(...stats.byYear.map((b) => b.count))}
                            />
                          ))}
                        </div>
                      </div>

                      {/* Top Shelves */}
                      <div className="card">
                        <h3>{t('dashboard.topShelves')}</h3>
                        {stats.topShelves.length === 0 ? (
                          <p className="muted small">{t('dashboard.noShelves')}</p>
                        ) : (
                          <div className="minibar-list">
                            {stats.topShelves.map((s) => (
                              <MiniBar
                                key={s.shelfCode}
                                label={s.shelfCode}
                                value={s.count}
                                count={s.count}
                                max={stats.topShelves[0].count}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Recent activity */}
                      <div className="card" style={{ gridColumn: '1 / -1' }}>
                        <h3>{t('dashboard.recent')}</h3>
                        {stats.recentlyUpdated.length === 0 ? (
                          <p className="muted small">{t('dashboard.noRecent')}</p>
                        ) : (
                          <ul className="recent-list">
                            {stats.recentlyUpdated.map((b) => (
                              <li key={b.id}>
                                <button
                                  className="recent-link"
                                  onClick={() => {
                                    void apiRequest<{ id: string; title: string; author: string; status: BookStatus; version: number; customFields?: Record<string, string|number|boolean|null>; isbn?: string|null; shelfCode?: string|null; publicationYear?: number|null; publisher?: string|null; language?: string|null; description?: string|null; legacyId?: string|null; }>(`/api/books/${b.id}`)
                                      .then((book) => { setDetailBook(book as Book); setDetailMode('view'); setBookHistory([]); void loadBookHistory(book.id); setCurrentSection('books'); });
                                  }}
                                >
                                  <strong>{b.title || t('common.untitled')}</strong>
                                  <span className="muted small"> · {b.author || t('common.unknown')}</span>
                                  {b.legacyId && <span className="legacy-id-pill">{b.legacyId}</span>}
                                </button>
                                <span className="muted small">{new Date(b.updatedAt).toLocaleString()}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {/* ═══ LIBRARY TAB ═══ */}
            {currentSection === 'books' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('library.title')}</h2>
                    <p>{t('library.description')}</p>
                  </div>
                  <div className="section-header-actions">
                    {canWrite && (
                      <button className="primary small" onClick={() => setShowAddBook((v) => !v)}>
                        {showAddBook ? t('library.cancelAdd') : t('library.addBook')}
                      </button>
                    )}
                    {canWrite && (
                      <button
                        className={`small ${selectionMode ? 'primary' : 'secondary'}`}
                        onClick={() => {
                          // Toggling selection mode only shows/hides the row
                          // checkboxes — it never discards the selection. Only
                          // "Clear selection" does that (the bulk bar stays
                          // visible while a selection exists).
                          setSelectionMode((v) => !v);
                        }}
                        aria-pressed={selectionMode}
                        title={selectionMode ? t('library.select.exit') : t('library.select.enter')}
                      >
                        {selectionMode
                          ? t('library.select.done', { n: selectedBookIds.length })
                          : t('library.select.start')}
                      </button>
                    )}
                    {canExportCsv && (
                      <button className="secondary small" onClick={exportFilteredBooksCsv}>{t('library.exportCsv')}</button>
                    )}
                  </div>
                </div>

                {/* Stats */}
                <div className="stats-row">
                  <div className="stat-box accent">
                    <span className="stat-box-label">{t('library.totalBooks')}</span>
                    <span className="stat-box-value">{fmt(totalBooksCount)}</span>
                  </div>
                  <div className="stat-box success">
                    <span className="stat-box-label">{t('status.available')}</span>
                    <span className="stat-box-value">{availableBooksDisplay}</span>
                  </div>
                  <div className="stat-box warning">
                    <span className="stat-box-label">{t('status.borrowed')}</span>
                    <span className="stat-box-value">{borrowedBooksDisplay}</span>
                  </div>
                  {/* Overdue is derived from active-loan data, which only
                      circulation users can load — hide it for viewers rather
                      than show a misleading permanent 0. */}
                  {canSeeCirculation && (
                    <div className="stat-box danger">
                      <span className="stat-box-label">{t('library.overdue')}</span>
                      <span className="stat-box-value">{overdueCount}</span>
                    </div>
                  )}
                </div>

                {/* Quick filter chips: pinned shortcuts that toggle filters without opening Advanced. */}
                <div className="filter-chips">
                  <button
                    type="button"
                    className={`chip${needsReviewFilter ? ' is-active' : ''}`}
                    onClick={() => setNeedsReviewFilter((v) => !v)}
                    title={t('library.needsReviewTitle')}
                  >
                    {t('library.needsReview')}
                    {needsReviewCount > 0 && <span className="chip-count">{fmt(needsReviewCount)}</span>}
                  </button>
                  {SMART_LISTS.map((list) => {
                    const active = smartListKey === list.key;
                    const label = t(list.labelKey);
                    return (
                      <button
                        key={list.key}
                        type="button"
                        className={`chip${active ? ' is-active' : ''}`}
                        onClick={() => {
                          if (active) { setSmartListKey(''); return; }
                          setSmartListKey(list.key);
                          // Reflect any control-backed params into their bound
                          // state so the visible Status/Sort controls agree with
                          // what the chip actually queries (e.g. "Currently
                          // borrowed" sets Status, "Recently added" sets Sort).
                          const p = list.params as Record<string, string>;
                          if (p.status !== undefined) setStatus(p.status);
                          if (p.sortBy !== undefined) setSortBy(p.sortBy as SortBy);
                          if (p.sortDir !== undefined) setSortDir(p.sortDir as SortDir);
                        }}
                        title={t('library.smartListTitle', { label })}
                      >
                        <span className="chip-icon">{list.icon}</span> {label}
                        {active && <span className="chip-x">✕</span>}
                      </button>
                    );
                  })}
                  {categoryFilter && (
                    <button
                      type="button"
                      className="chip is-active"
                      onClick={() => setCategoryFilter('')}
                      title={t('library.categoryFilterTitle')}
                    >
                      {t('library.categoryChip', { code: categoryFilter })}
                      <span className="chip-x">✕</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="chip ghost"
                    onClick={() => setShowCategoryRail((v) => !v)}
                    title={showCategoryRail ? t('library.catBrowser.hide') : t('library.catBrowser.show')}
                  >
                    {showCategoryRail ? t('library.hideCats') : t('library.showCats')}
                  </button>
                </div>

                <div className={`library-layout${showCategoryRail ? '' : ' no-rail'}`}>
                  {showCategoryRail && (
                    <aside className="category-rail">
                      <div className="category-rail-head">
                        <h3>{t('library.cats.title')}</h3>
                        <span className="muted small">{t('library.cats.totalCount', { n: categories.length })}</span>
                      </div>
                      <input
                        className="category-rail-search"
                        placeholder={t('library.cats.filter')}
                        value={categoryRailQuery}
                        onChange={(e) => setCategoryRailQuery(e.target.value)}
                      />
                      <ul className="category-rail-list">
                        <li>
                          <button
                            type="button"
                            className={`category-rail-item${!categoryFilter ? ' is-active' : ''}`}
                            aria-pressed={!categoryFilter}
                            onClick={() => setCategoryFilter('')}
                          >
                            <span className="cat-label">{t('library.cats.all')}</span>
                            <span className="cat-count">{fmt(totalBooksCount)}</span>
                          </button>
                        </li>
                        {categories
                          .filter((c) => {
                            const q = categoryRailQuery.trim().toLowerCase();
                            if (!q) return true;
                            return (
                              c.code.toLowerCase().includes(q) ||
                              (c.label ?? '').toLowerCase().includes(q)
                            );
                          })
                          .map((c) => (
                            <li key={c.code}>
                              <button
                                type="button"
                                className={`category-rail-item${categoryFilter === c.code ? ' is-active' : ''}`}
                                aria-pressed={categoryFilter === c.code}
                                onClick={() => setCategoryFilter(c.code)}
                                onContextMenu={(e) => openContextMenu(e, buildCategoryMenu(c), c.label ? `${c.code} ${c.label}` : c.code)}
                                title={c.label ?? c.code}
                              >
                                <span className="cat-label">
                                  <span className="cat-code">{c.code}</span>
                                  {c.label ? <span className="cat-text"> {c.label}</span> : null}
                                </span>
                                <span className="cat-count">{fmt(c.count)}</span>
                              </button>
                            </li>
                          ))}
                      </ul>
                    </aside>
                  )}
                  <div className="library-main">

                {/* Add Book (collapsible) */}
                {canWrite && showAddBook && (
                  <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
                    <h3>{t('library.add.title')}</h3>
                    <form onSubmit={createBook} className="simple-form">
                      <div className="form-row">
                        <div>
                          <label>{t('library.add.bookTitle')}<span className="required-mark"> *</span></label>
                          <input
                            ref={titleInputRef}
                            className={createFieldErrors.has('title') ? 'input-error' : undefined}
                            aria-required="true"
                            aria-invalid={createFieldErrors.has('title') || undefined}
                            value={createForm.title}
                            onChange={(e) => {
                              setCreateForm({ ...createForm, title: e.target.value });
                              // Clear the title error as soon as the librarian starts typing.
                              if (createFieldErrors.has('title')) {
                                setCreateFieldErrors((prev) => {
                                  const next = new Set(prev);
                                  next.delete('title');
                                  return next;
                                });
                              }
                            }}
                            placeholder={t('library.add.titlePh')}
                          />
                        </div>
                        <div>
                          <label>{t('library.add.author')}</label>
                          <input list="suggest-author" value={createForm.author} onChange={(e) => setCreateForm({ ...createForm, author: e.target.value })} placeholder={t('library.add.authorPh')} />
                        </div>
                      </div>
                      {/* ISBN spans its own full-width row so the number stays fully
                          visible while typing and the lookup button sits beside it
                          without squeezing the field into a few characters. */}
                      <div className="form-field">
                        <label>{t('library.add.isbn')}</label>
                        <div className="isbn-row">
                          <input
                            className="isbn-input"
                            value={createForm.isbn}
                            onChange={(e) => setCreateForm({ ...createForm, isbn: e.target.value })}
                            placeholder={t('library.add.isbnPh')}
                            inputMode="text"
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            onKeyDown={(e) => {
                              // Enter inside the ISBN field triggers lookup rather than
                              // submitting the (likely incomplete) form. The librarian
                              // can still click "Add Book" once they're satisfied.
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (!isbnLookupBusy) void enrichFromIsbn();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="secondary small"
                            onClick={() => void enrichFromIsbn()}
                            disabled={isbnLookupBusy || !createForm.isbn.trim()}
                            title={t('library.add.lookupHint')}
                          >
                            {isbnLookupBusy ? t('library.add.lookupSearching') : t('library.add.lookupIsbn')}
                          </button>
                        </div>
                        <p className="muted small" style={{ marginTop: '0.25rem' }}>{t('library.add.lookupHint')}</p>
                      </div>
                      <div className="form-row">
                        <div>
                          <label>{t('library.add.year')}</label>
                          <input type="number" min={1000} max={3000} value={createForm.publicationYear} onChange={(e) => setCreateForm({ ...createForm, publicationYear: e.target.value })} placeholder={t('library.add.yearPh')} />
                        </div>
                        <div>
                          <label>{t('library.add.shelf')}</label>
                          <input list="suggest-shelf" value={createForm.shelfCode} onChange={(e) => setCreateForm({ ...createForm, shelfCode: e.target.value })} placeholder={t('library.add.shelfPh')} />
                        </div>
                      </div>
                      <div className="form-row">
                        <div>
                          <label>{t('library.add.publisher')}</label>
                          <input list="suggest-publisher" value={createForm.publisher} onChange={(e) => setCreateForm({ ...createForm, publisher: e.target.value })} placeholder={t('library.add.publisherPh')} />
                        </div>
                        <div>
                          <label>{t('library.add.language')}</label>
                          <input list="suggest-language" value={createForm.language} onChange={(e) => setCreateForm({ ...createForm, language: e.target.value })} placeholder={t('library.add.languagePh')} />
                        </div>
                      </div>
                      <div className="form-field">
                        <label>{t('library.add.description')}</label>
                        <textarea
                          value={createForm.description}
                          onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                          rows={2}
                          placeholder={t('library.add.descriptionPh')}
                        />
                      </div>

                      {/* Cover image — staged here, uploaded right after the book row
                          is created (the cover endpoint keys on the book id). */}
                      <div className="form-field">
                        <label>{t('library.add.cover')}</label>
                        <div className="cover-section">
                          {createCoverPreview ? (
                            <img className="detail-cover" src={createCoverPreview} alt={t('library.add.coverPreviewAlt')} />
                          ) : (
                            <div className="detail-cover detail-cover-placeholder">
                              <span>{t('detail.noCover')}</span>
                            </div>
                          )}
                          <div className="cover-actions">
                            <label className="secondary small button-like">
                              {createCoverFile ? t('detail.replaceCover') : t('detail.uploadCover')}
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/webp,image/gif"
                                style={{ display: 'none' }}
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  e.target.value = '';
                                  if (f) selectCreateCover(f);
                                }}
                              />
                            </label>
                            {createCoverFile && (
                              <button type="button" className="danger small" onClick={clearCreateCover}>{t('detail.removeCover')}</button>
                            )}
                            <span className="muted small">{t('detail.coverHint')}</span>
                          </div>
                        </div>
                      </div>

                      <details className="custom-fields-section" open={customFields.length > 0 && (customFields.length <= 6 || [...createFieldErrors].some((k) => k.startsWith('cf:')))}>
                        <summary>{t('library.add.attributes', { n: customFields.length })}</summary>
                        {renderCustomFieldsForm(
                          createAttrValues,
                          (key, value) => {
                            setCreateAttrValues((prev) => ({ ...prev, [key]: value }));
                            // Clear a required-field error once the field is given a value.
                            const empty = value === undefined || value === null || value === '';
                            if (!empty && createFieldErrors.has(`cf:${key}`)) {
                              setCreateFieldErrors((prev) => {
                                const next = new Set(prev);
                                next.delete(`cf:${key}`);
                                return next;
                              });
                            }
                          },
                          createFieldErrors
                        )}
                      </details>

                      <div className="button-group">
                        <button type="submit" className="primary">{t('library.add.submit')}</button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setShowAddBook(false);
                            setCreateAttrValues({});
                            clearCreateCover();
                          }}
                        >{t('common.cancel')}</button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Duplicate warning after creating a book */}
                {duplicateWarning.length > 0 && (
                  <div className="card" style={{ borderLeft: '3px solid var(--warning, #f59e0b)', background: 'var(--bg-warning, #fffbeb)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <strong>{t('library.dup.title')}</strong>
                        <p style={{ marginTop: '0.4rem', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                          {t('library.dup.body')}
                        </p>
                        <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.875rem' }}>
                          {duplicateWarning.map((d) => (
                            <li key={d.id}><em>{displayTitle(d, t('common.untitled'))}</em> — {displayAuthor(d, t('common.unknownAuthor'))}{d.isbn ? ` (${t('library.add.isbn')}: ${d.isbn})` : ''}</li>
                          ))}
                        </ul>
                      </div>
                      <button className="secondary small" onClick={() => setDuplicateWarning([])}>{t('common.dismiss')}</button>
                    </div>
                  </div>
                )}

                {/* Search & Filter */}
                <div className="card">
                  <div className="search-bar">
                    <div className="search-field">
                      <label>
                        {t('library.search.label')} <span className="kbd-hint">{t('library.search.kbdHint')} <kbd>/</kbd></span>
                      </label>
                      <input
                        ref={searchInputRef}
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder={t('library.search.placeholder')}
                        list="suggest-author"
                      />
                    </div>
                    <div className="filter-field">
                      <label>{t('library.search.status')}</label>
                      <select value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">{t('status.allStatuses')}</option>
                        <option value="available">{t('status.available')}</option>
                        <option value="borrowed">{t('status.borrowed')}</option>
                        <option value="lost">{t('status.lost')}</option>
                        <option value="maintenance">{t('status.maintenance')}</option>
                      </select>
                    </div>
                    <div className="filter-field">
                      <label>{t('library.search.shelf')}</label>
                      <input
                        value={shelfFilter}
                        onChange={(e) => setShelfFilter(e.target.value)}
                        placeholder={t('library.search.shelfPh')}
                        title={t('library.search.shelfTitle')}
                        list="suggest-shelf"
                      />
                    </div>
                    <div className="filter-field">
                      <label>{t('library.search.language')}</label>
                      <input
                        value={filterLanguage}
                        onChange={(e) => setFilterLanguage(e.target.value)}
                        placeholder={t('library.search.languagePh')}
                        list="lang-suggest"
                        title={t('library.search.languageTitle')}
                      />
                      <datalist id="lang-suggest">
                        {/*
                          Each language is listed in English / Greek / Korean / Russian
                          so a librarian can type their own and the server's synonym
                          map resolves it to the ISO code stored in the catalog.
                        */}
                        <option value="English" /><option value="Αγγλικά" /><option value="영어" /><option value="Английский" />
                        <option value="Greek" /><option value="Ελληνικά" /><option value="그리스어" /><option value="Греческий" />
                        <option value="German" /><option value="Γερμανικά" /><option value="독일어" /><option value="Немецкий" />
                        <option value="French" /><option value="Γαλλικά" /><option value="프랑스어" /><option value="Французский" />
                        <option value="Italian" /><option value="Ιταλικά" /><option value="이탈리아어" /><option value="Итальянский" />
                        <option value="Spanish" /><option value="Ισπανικά" /><option value="스페인어" /><option value="Испанский" />
                        <option value="Russian" /><option value="Ρωσικά" /><option value="러시아어" /><option value="Русский" />
                        <option value="Latin" /><option value="Λατινικά" /><option value="라틴어" /><option value="Латинский" />
                        <option value="Bulgarian" /><option value="Βουλγαρικά" /><option value="불가리아어" /><option value="Болгарский" />
                        <option value="Czech" /><option value="Τσεχικά" /><option value="체코어" /><option value="Чешский" />
                        <option value="Korean" /><option value="Κορεατικά" /><option value="한국어" /><option value="Корейский" />
                        <option value="Turkish" /><option value="Τουρκικά" /><option value="터키어" /><option value="Турецкий" />
                        <option value="Romanian" /><option value="Ρουμανικά" /><option value="루마니아어" /><option value="Румынский" />
                        <option value="Serbian" /><option value="Σερβικά" /><option value="세르비아어" /><option value="Сербский" />
                        <option value="Multilingual" /><option value="Πολύγλωσσο" /><option value="다국어" /><option value="Многоязычный" />
                      </datalist>
                    </div>
                    <div className="filter-field">
                      <label>{t('library.search.year')}</label>
                      <input type="number" min={1000} max={3000} value={filterYear} onChange={(e) => setFilterYear(e.target.value)} placeholder={t('library.search.yearPh')} />
                    </div>
                    <div className="filter-field">
                      <label>{t('library.search.sort')}</label>
                      <div className="sort-row">
                        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                          <option value="updatedAt">{t('library.search.sortUpdated')}</option>
                          <option value="title">{t('library.search.sortTitle')}</option>
                          <option value="author">{t('library.search.sortAuthor')}</option>
                          <option value="publicationYear">{t('library.search.sortYear')}</option>
                          <option value="status">{t('library.search.sortStatus')}</option>
                        </select>
                        <button
                          type="button"
                          className="secondary small sort-dir-btn"
                          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                          title={sortDir === 'asc' ? t('library.search.sortAsc') : t('library.search.sortDesc')}
                          aria-label={t('library.search.sortDirAria')}
                        >
                          {sortDir === 'asc' ? '↑' : '↓'}
                        </button>
                      </div>
                    </div>
                    <div className="search-actions">
                      <label>.</label>
                      <button className="secondary" onClick={() => { setShowAdvancedSearch((v) => !v); }}>
                        {showAdvancedSearch ? t('library.search.hideAdvanced') : t('library.search.advanced')}
                      </button>
                      <button
                        className="secondary"
                        onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
                        title={t('library.search.densityTitle')}
                      >
                        {density === 'compact' ? t('library.search.densityCards') : t('library.search.densityList')}
                      </button>
                      <button className="secondary" onClick={() => {
                        setQ('');
                        setQExclude('');
                        setQMode('all');
                        setPartialWords(true);
                        setFuzzyTypos(true);
                        setSearchFields(['title', 'author', 'isbn']);
                        setSearchEngine('lexical');
                        setStatus('');
                        setFilterLanguage('');
                        setFilterYear('');
                        setShelfFilter('');
                        setCategoryFilter('');
                        setNeedsReviewFilter(false);
                        setSmartListKey('');
                        setCurrentPage(1);
                      }}>{t('common.reset')}</button>
                    </div>
                  </div>

                  {showAdvancedSearch && (
                    <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                      <div className="form-row">
                        <div>
                          <label>{t('library.adv.engine')}</label>
                          <select
                            value={searchEngine}
                            onChange={(e) => setSearchEngine(e.target.value as 'lexical' | 'semantic')}
                            disabled={semanticAvailable === false}
                            title={semanticAvailable === false ? t('library.adv.semanticOff') : undefined}
                          >
                            <option value="lexical">{t('library.adv.engineLexical')}</option>
                            <option value="semantic" disabled={semanticAvailable === false}>
                              {t('library.adv.engineSemantic')}
                            </option>
                          </select>
                          {searchEngine === 'semantic' && (
                            <p className="muted small" style={{ marginTop: '0.25rem' }}>{t('library.adv.semanticHint')}</p>
                          )}
                          {semanticAvailable === false && (
                            <p className="muted small" style={{ marginTop: '0.25rem' }}>{t('library.adv.semanticOff')}</p>
                          )}
                        </div>
                        <div>
                          <label>{t('library.adv.exclude')}</label>
                          <input
                            value={qExclude}
                            onChange={(e) => setQExclude(e.target.value)}
                            placeholder={t('library.adv.excludePh')}
                            disabled={searchEngine === 'semantic'}
                          />
                        </div>
                        <div>
                          <label>{t('library.adv.matchMode')}</label>
                          <select
                            value={qMode}
                            onChange={(e) => setQMode(e.target.value as SearchMode)}
                            disabled={searchEngine === 'semantic'}
                          >
                            <option value="all">{t('library.adv.modeAll')}</option>
                            <option value="any">{t('library.adv.modeAny')}</option>
                            <option value="exact">{t('library.adv.modeExact')}</option>
                          </select>
                        </div>
                        <div>
                          <label>{t('library.adv.partialWords')}</label>
                          <select
                            value={partialWords ? 'yes' : 'no'}
                            onChange={(e) => setPartialWords(e.target.value === 'yes')}
                            disabled={searchEngine === 'semantic'}
                          >
                            <option value="yes">{t('library.adv.partialYes')}</option>
                            <option value="no">{t('library.adv.partialNo')}</option>
                          </select>
                        </div>
                        <div>
                          <label>{t('library.adv.fuzzy')}</label>
                          <select
                            value={fuzzyTypos ? 'on' : 'off'}
                            onChange={(e) => setFuzzyTypos(e.target.value === 'on')}
                            disabled={searchEngine === 'semantic'}
                          >
                            <option value="on">{t('library.adv.fuzzyOn')}</option>
                            <option value="off">{t('library.adv.fuzzyOff')}</option>
                          </select>
                        </div>
                      </div>

                      <label style={{ marginTop: '0.5rem' }}>{t('library.adv.searchIn')}</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.35rem' }}>
                        {([
                          ['title', t('library.adv.field.title')],
                          ['author', t('library.adv.field.author')],
                          ['isbn', t('library.adv.field.isbn')],
                          ['publisher', t('library.adv.field.publisher')],
                          ['language', t('library.adv.field.language')],
                          ['description', t('library.adv.field.description')],
                          ['shelfCode', t('library.adv.field.shelfCode')],
                          ['tags', t('library.adv.field.tags')],
                          ['custom', t('library.adv.field.custom')]
                        ] as Array<[SearchField, string]>).map(([field, label]) => (
                          <label key={field} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', margin: 0, fontSize: '0.82rem' }}>
                            <input
                              type="checkbox"
                              checked={searchFields.includes(field)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSearchFields((prev) => (prev.includes(field) ? prev : [...prev, field]));
                                } else {
                                  setSearchFields((prev) => {
                                    const next = prev.filter((value) => value !== field);
                                    return next.length > 0 ? next : ['title'];
                                  });
                                }
                              }}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Bulk action bar — only visible when at least one book is selected. */}
                {/* Shown whenever a selection exists — even after leaving selection
                    mode or paging away — so a selection is never invisible and the
                    user can always act on it or clear it. */}
                {canWrite && (selectionMode || selectedBookIds.length > 0) && (
                  <div className="bulk-bar" role="region" aria-label={t('library.bulk.aria')}>
                    <div className="bulk-bar-info">
                      <strong>{selectedBookIds.length} </strong>
                      <span className="muted small">{t('library.bulk.selectedSuffix')}</span>
                      {selectedOnPageCount < books.length && (
                        <button className="link-btn" onClick={selectAllOnPage}>{t('library.bulk.selectAll', { n: books.length })}</button>
                      )}
                      {selectedOnPageCount > 0 && (
                        <button className="link-btn" onClick={deselectAllOnPage}>{t('library.bulk.deselectPage', { n: selectedOnPageCount })}</button>
                      )}
                      {/* Criteria selection: everything matching the current
                          search/filters, across every page. */}
                      <button className="link-btn" onClick={selectAllMatchingFilters}>{t('library.bulk.selectMatching', { n: totalBooksCount })}</button>
                      <button className="link-btn" onClick={clearSelectedBooks}>{t('library.bulk.clear')}</button>
                    </div>
                    {/* Actions only make sense once something is selected; the
                        info row above still offers the criteria selectors. */}
                    <div className="bulk-bar-actions" style={selectedBookIds.length === 0 ? { display: 'none' } : undefined}>
                      <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} aria-label={t('library.bulk.setStatusAria')}>
                        <option value="">{t('library.bulk.setStatus')}</option>
                        <option value="available">{t('status.available')}</option>
                        {/* No 'borrowed' — lending goes through the borrow action so
                            book.status never desyncs from the loan record. */}
                        <option value="lost">{t('status.lost')}</option>
                        <option value="maintenance">{t('status.maintenance')}</option>
                      </select>
                      {/* Same state the modal's Shelf field edits — two inputs
                          writing one column independently would have let the
                          librarian set two different shelves and silently get
                          whichever one the apply order happened to prefer. */}
                      <input
                        value={bulkEditValues['core:shelfCode'] ?? ''}
                        onChange={(e) => setBulkEditValue('core:shelfCode', e.target.value)}
                        placeholder={t('library.bulk.setShelf')}
                        aria-label={t('library.bulk.setShelfAria')}
                        list="suggest-shelf"
                      />
                      <button
                        className="primary small"
                        onClick={() => void applyBulkBookChanges()}
                        disabled={bulkEditPendingCount === 0}
                      >{bulkEditPendingCount > 1
                        ? t('library.bulk.applyNShort', { fields: bulkEditPendingCount })
                        : t('common.apply')}</button>
                      {/* Everything beyond status + shelf lives in a panel, so
                          the bar stays usable while still reaching every field. */}
                      <button
                        className="secondary small"
                        onClick={() => setBulkEditOpen(true)}
                      >{t('library.bulk.moreFields')}</button>
                      {canPrintLabels && (
                        <button
                          className="secondary small"
                          onClick={() => {
                            // Resolve the whole selection so labels print for books
                            // on other pages too, not just the visible ones.
                            void (async () => {
                              try {
                                const targets = await resolveSelectedBooks(selectedBookIds);
                                await printLabels(targets);
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            })();
                          }}
                        >{t('library.bulk.labels')}</button>
                      )}
                      {/* Deletion needs books.delete, like every other delete
                          affordance (context menu, detail modal). Without this
                          gate the UI offered bulk delete to librarians whose
                          admin had turned deletion off. */}
                      {canDelete && (
                      <button
                        className="danger small"
                        onClick={async () => {
                          const ok = await confirm({
                            title: t('confirm.deleteBulkTitle', { n: selectedBookIds.length, s: selectedBookIds.length === 1 ? '' : 's' }),
                            body: t('confirm.deleteBulkBody'),
                            confirmLabel: t('confirm.deleteBulkAction'),
                            danger: true
                          });
                          if (!ok) return;
                          clearStatus();
                          try {
                            const ids = [...selectedBookIds];
                            // Batched sync pushes (1 KV write per batch) instead of N deletes.
                            const { success, failed, okIds } = await pushBulkMutations(
                              ids.map((id) => ({ operation: 'delete_book', payload: { id } }))
                            );
                            setMessage(failed === 0
                              ? t('toast.deletedAll', { n: success, s: success === 1 ? '' : 's' })
                              : t('toast.deletedMixed', { success, failed }));
                            // Drop only the books that were actually deleted — they no
                            // longer exist. Anything that failed stays selected so the
                            // librarian can see and retry it.
                            const deleted = new Set(okIds);
                            setSelectedBookIds((prev) => prev.filter((id) => !deleted.has(id)));
                            await Promise.all([loadBooks(), loadRoomSummary(), loadCategories(), loadStats()]);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >{t('common.delete')}</button>
                      )}
                    </div>
                  </div>
                )}

                {/* Book Grid */}
                <div className="card">
                  {isLoadingBooks && books.length === 0 ? (
                    <BookCardSkeleton count={6} />
                  ) : booksError && books.length === 0 ? (
                    <div className="empty-state">
                      <p style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>⚠️</p>
                      <p style={{ fontWeight: 600 }}>{t('library.error.title')}</p>
                      <p className="muted small">{booksError}</p>
                      <button
                        className="secondary"
                        style={{ marginTop: '0.75rem' }}
                        onClick={() => { void loadBooks(currentPage); }}
                      >{t('library.error.retry')}</button>
                    </div>
                  ) : books.length === 0 ? (
                    <div className="empty-state">
                      <p style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📚</p>
                      <p style={{ fontWeight: 600 }}>{t('library.empty.title')}</p>
                      <p className="muted small">
                        {q || categoryFilter || needsReviewFilter || status || filterLanguage || filterYear || shelfFilter || smartListKey
                          ? t('library.empty.filtered')
                          : t('library.empty.bare')}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className={density === 'compact' ? 'book-list' : 'book-grid'}>
                        {books.map((book) => {
                          const isSelected = selectedBookIds.includes(book.id);
                          return (
                            <div
                              key={book.id}
                              className={`${density === 'compact' ? 'book-row' : 'book-card'}${isSelected ? ' is-selected' : ''}${selectionMode ? ' is-selecting' : ''}`}
                              onClick={() => {
                                // In selection mode the whole row acts as the
                                // checkbox so users don't have to aim for a tiny target.
                                if (selectionMode && canWrite) {
                                  toggleBookSelection(book.id);
                                } else {
                                  openBookDetail(book);
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              onContextMenu={(e) => openContextMenu(e, buildBookMenu(book), displayTitle(book, t('common.untitled')))}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter' && e.key !== ' ') return;
                                e.preventDefault();
                                if (selectionMode && canWrite) {
                                  toggleBookSelection(book.id);
                                } else {
                                  openBookDetail(book);
                                }
                              }}
                            >
                              <input
                                type="checkbox"
                                className="book-select"
                                checked={isSelected}
                                onChange={(e) => { e.stopPropagation(); toggleBookSelection(book.id); }}
                                onClick={(e) => e.stopPropagation()}
                                aria-label={t('library.book.selectAria', { title: displayTitle(book, t('common.untitled')) })}
                                style={canWrite && selectionMode ? undefined : { display: 'none' }}
                              />
                              {book.coverUrl ? (
                                <img
                                  className="book-avatar book-cover"
                                  src={joinApiUrl(book.coverUrl)}
                                  alt={`Cover of ${displayTitle(book, t('common.untitled'))}`}
                                  loading="lazy"
                                  decoding="async"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                />
                              ) : (
                                <div className="book-avatar" aria-hidden="true">
                                  {(displayTitle(book, t('common.untitled')).charAt(0) || '?').toUpperCase()}
                                </div>
                              )}
                              <div className="book-card-body">
                                <span className={`book-card-title${isPlaceholder(book.title, 'title') || !book.title ? ' is-placeholder' : ''}`}>
                                  {q ? highlight(displayTitle(book, t('common.untitled')), q) : displayTitle(book, t('common.untitled'))}
                                </span>
                                <p className={`book-card-author${isPlaceholder(book.author, 'author') || !book.author ? ' is-placeholder' : ''}`}>
                                  {q ? highlight(displayAuthor(book, t('common.unknownAuthor')), q) : displayAuthor(book, t('common.unknownAuthor'))}
                                </p>
                                <div className="book-card-meta">
                                  {book.publicationYear && <span className="meta-chip">{book.publicationYear}</span>}
                                  {book.language && <span className="meta-chip">{book.language}</span>}
                                  {book.isbn && <span className="meta-chip">ISBN</span>}
                                  {book.legacyId && <span className="meta-chip mono">{book.legacyId}</span>}
                                </div>
                              </div>
                              <div className="book-card-side">
                                <span
                                  className={`shelf-badge${book.shelfCode ? '' : ' shelf-missing'}`}
                                  title={book.shelfCode ? t('library.book.shelfTitle', { code: book.shelfCode }) : t('library.book.noShelfTitle')}
                                  aria-label={book.shelfCode ? t('library.book.shelfTitle', { code: book.shelfCode }) : t('library.book.noShelfAria')}
                                >
                                  <span className="shelf-icon" aria-hidden="true">📍</span>
                                  <span className="shelf-value">{book.shelfCode || t('library.book.noShelf')}</span>
                                </span>
                                <span className={`status-badge status-${book.status}`}>{t(`status.${book.status}`)}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="pagination">
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(1)}
                          disabled={currentPage === 1}
                          title={t('library.page.firstTitle')}
                        >{t('library.page.first')}</button>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(currentPage - 1)}
                          disabled={currentPage === 1}
                        >{t('library.page.prev')}</button>
                        <span className="pagination-info">
                          {t('library.page.info')} <strong>{currentPage}</strong> {t('library.page.of')} <strong>{Math.max(1, Math.ceil(totalBooksCount / PAGE_SIZE))}</strong>
                          <span className="muted small"> · {t('library.page.booksSuffix', { n: fmt(totalBooksCount) })}</span>
                        </span>
                        <form
                          className="page-jump"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const parsed = Number(jumpPage);
                            const totalPages = Math.max(1, Math.ceil(totalBooksCount / PAGE_SIZE));
                            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= totalPages) {
                              void loadBooks(Math.floor(parsed));
                              setJumpPage('');
                            }
                          }}
                        >
                          <input
                            value={jumpPage}
                            onChange={(e) => setJumpPage(e.target.value.replace(/[^0-9]/g, ''))}
                            placeholder={t('library.page.jump')}
                            aria-label={t('library.page.jumpAria')}
                          />
                          <button type="submit" className="secondary small">{t('common.go')}</button>
                        </form>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(currentPage + 1)}
                          disabled={currentPage >= Math.ceil(totalBooksCount / PAGE_SIZE)}
                        >{t('library.page.next')}</button>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(Math.max(1, Math.ceil(totalBooksCount / PAGE_SIZE)))}
                          disabled={currentPage >= Math.ceil(totalBooksCount / PAGE_SIZE)}
                          title={t('library.page.lastTitle')}
                        >{t('library.page.last')}</button>
                      </div>
                    </>
                  )}
                </div>
                  </div> {/* /library-main */}
                </div> {/* /library-layout */}
              </>
            )}

            {/* ═══ LOANS TAB ═══ */}
            {currentSection === 'circulation' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('loans.title')}</h2>
                    <p>{t('loans.description')}</p>
                  </div>
                </div>

                {/* Loan stats */}
                <div className="stats-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  <div className="stat-box accent">
                    <span className="stat-box-label">{t('loans.activeKpi')}</span>
                    <span className="stat-box-value">{activeBorrows.length}</span>
                  </div>
                  <div className="stat-box danger">
                    <span className="stat-box-label">{t('library.overdue')}</span>
                    <span className="stat-box-value">{overdueCount}</span>
                  </div>
                  <div className="stat-box warning">
                    <span className="stat-box-label">{t('loans.dueSoon')}</span>
                    <span className="stat-box-value">{dueSoonCount}</span>
                  </div>
                </div>

                {/* Active Loans list */}
                <div className="card">
                  <h3>{t('loans.activeHeading', { n: activeBorrows.length })}</h3>
                  {activeBorrows.length === 0 ? (
                    <div className="empty-state" style={{ padding: '1.5rem 0 0.5rem' }}>
                      <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>✅</p>
                      <p style={{ fontWeight: 600 }}>{t('loans.allClear')}</p>
                      <p className="muted small">{t('loans.allClearBody')}</p>
                    </div>
                  ) : (
                    <div className="loan-list">
                      {activeBorrows.map((loan) => (
                        <div key={loan.id} className={`loan-item${loan.isOverdue ? ' overdue' : ''}`} onContextMenu={(e) => openContextMenu(e, buildLoanMenu(loan), displayTitle({ title: loan.title }, t('common.untitled')))}>
                          <div className="loan-item-info">
                            <strong>{displayTitle({ title: loan.title }, t('common.untitled'))}</strong>
                            <p className="meta">
                              {t('loans.borrowedBy', { name: loan.borrowerName })}
                              {loan.borrowerContact ? ` · ${loan.borrowerContact}` : ''}
                            </p>
                            <p className="meta">
                              {t('loans.due', { date: new Date(loan.dueAt).toLocaleDateString() })}
                              {loan.isOverdue && <span className="overdue-tag"> · {t('loans.overdueTag')}</span>}
                            </p>
                          </div>
                          <button className="secondary small" onClick={() => void quickReturnByBookId(loan.bookId, displayTitle({ title: loan.title }, t('common.untitled')), loan.id)}>
                            {t('loans.return')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Borrow Form */}
                <div className="card">
                  <h3>{t('loans.borrowHeading')}</h3>
                  {selectedBook ? (
                    <form onSubmit={(e) => { e.preventDefault(); void borrowBook(selectedBook); }} className="simple-form">
                      <div style={{ padding: '0.875rem 1rem', background: 'var(--accent-light)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--accent)', marginBottom: '0.25rem' }}>
                        <p style={{ fontWeight: 600 }}>{displayTitle(selectedBook, t('common.untitled'))}</p>
                        <p className="muted small">{displayAuthor(selectedBook, t('common.unknownAuthor'))}</p>
                      </div>
                      <div className="form-row">
                        <div className="combobox">
                          <label>{t('loans.borrower')} *</label>
                          <input
                            value={borrowerQuery || borrowerName}
                            onChange={(e) => {
                              const v = e.target.value;
                              setBorrowerQuery(v);
                              setBorrowerName(v);
                              setSelectedBorrowerId('');
                              if (v.trim().length >= 2) scheduleBorrowerSearch(v);
                              else { setBorrowerSuggestions([]); setBorrowerHighlight(-1); }
                            }}
                            onFocus={() => { if (!borrowerSuggestions.length) void searchBorrowers(borrowerQuery); }}
                            onKeyDown={(e) => {
                              // Arrow keys move through the suggestion list, Enter
                              // picks the highlighted row (or submits the form when
                              // nothing is highlighted), Escape closes the dropdown.
                              if (borrowerSuggestions.length === 0 || selectedBorrowerId) return;
                              if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                setBorrowerHighlight((i) => (i + 1) % borrowerSuggestions.length);
                              } else if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                setBorrowerHighlight((i) => (i <= 0 ? borrowerSuggestions.length - 1 : i - 1));
                              } else if (e.key === 'Enter' && borrowerHighlight >= 0) {
                                e.preventDefault();
                                const picked = borrowerSuggestions[borrowerHighlight];
                                if (picked) applyBorrowerSuggestion(picked);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setBorrowerSuggestions([]);
                                setBorrowerHighlight(-1);
                              }
                            }}
                            placeholder={t('loans.borrowerPh')}
                            required
                            autoComplete="off"
                            role="combobox"
                            aria-autocomplete="list"
                            aria-expanded={borrowerSuggestions.length > 0}
                            aria-controls="borrower-suggestion-list"
                            aria-activedescendant={borrowerHighlight >= 0 ? `borrower-opt-${borrowerSuggestions[borrowerHighlight]?.id}` : undefined}
                          />
                          {borrowerSuggestions.length > 0 && !selectedBorrowerId && (
                            <ul className="combobox-list" role="listbox" id="borrower-suggestion-list">
                              {borrowerSuggestions.map((b, i) => (
                                <li
                                  key={b.id}
                                  id={`borrower-opt-${b.id}`}
                                  role="option"
                                  aria-selected={borrowerHighlight === i}
                                  className={borrowerHighlight === i ? 'is-active' : undefined}
                                  onMouseEnter={() => setBorrowerHighlight(i)}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    applyBorrowerSuggestion(b);
                                  }}
                                >
                                  <span className="combo-name">{b.name}</span>
                                  {b.contact && <span className="combo-contact muted small">{b.contact}</span>}
                                  <span className="combo-stats muted small">
                                    {t(b.totalLoans === 1 ? 'loans.suggestionLoanCount' : 'loans.suggestionLoanCountPlural', { n: fmt(b.totalLoans) })}
                                    {b.overdueLoans > 0 && <span className="overdue-tag"> · {t('loans.suggestionOverdue', { n: fmt(b.overdueLoans) })}</span>}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {selectedBorrowerId && (
                            <p className="muted small">
                              {t('loans.borrowerProfile')}{' '}
                              <button
                                type="button"
                                className="link-btn"
                                style={{ color: 'var(--accent)' }}
                                onClick={() => { setSelectedBorrowerId(''); setBorrowerName(''); setBorrowerContact(''); }}
                              >{t('loans.change')}</button>
                            </p>
                          )}
                        </div>
                        <div>
                          <label>{t('loans.contact', { optional: t('common.optional') })}</label>
                          <input
                            value={borrowerContact}
                            onChange={(e) => setBorrowerContact(e.target.value)}
                            placeholder={t('loans.contactPh')}
                            disabled={Boolean(selectedBorrowerId)}
                          />
                        </div>
                      </div>
                      <div className="form-field">
                        <label>{t('loans.dueDate')} *</label>
                        <input
                          type="date"
                          value={isoToLocalDateInput(dueAt)}
                          onChange={(e) => setDueAt(endOfLocalDayIso(e.target.value))}
                          required
                        />
                        <div className="button-group" style={{ marginTop: '0.5rem' }}>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(7)}>{t('loans.in7')}</button>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(14)}>{t('loans.in14')}</button>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(30)}>{t('loans.in30')}</button>
                        </div>
                      </div>
                      <div className="button-group">
                        <button type="submit" className="primary">{t('loans.confirmBorrow')}</button>
                        <button type="button" className="secondary" onClick={() => setSelectedBook(null)}>{t('common.cancel')}</button>
                      </div>
                    </form>
                  ) : (
                    <div className="empty-state" style={{ padding: '1.5rem 0 0.5rem' }}>
                      <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>📖</p>
                      <p style={{ fontWeight: 600 }}>{t('loans.noBookSelected')}</p>
                      <p className="muted small">{t('loans.noBookBody')} <strong>{t('detail.borrowBtn')}</strong>.</p>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ═══ IMPORT TAB ═══ */}
            {currentSection === 'import' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('import.title')}</h2>
                    <p>{t('import.description')}</p>
                  </div>
                </div>

                <div className="card">
                  <h3>{t('import.heading')}</h3>
                  <p className="muted" style={{ marginBottom: '1.25rem', fontSize: '0.875rem' }}>
                    {t('import.intro')}
                  </p>
                  <form onSubmit={importFromXlsx} className="simple-form">
                    <div className="import-dropzone">
                      <p style={{ fontSize: '2.25rem', marginBottom: '0.5rem' }}>📂</p>
                      <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{t('import.choose')}</p>
                      <p className="muted small" style={{ marginBottom: '1rem' }}>{t('import.supports')}</p>
                      <input name="xlsxFile" type="file" accept=".xlsx" required style={{ width: 'auto', display: 'block', margin: '0 auto' }} />
                    </div>
                    {importFileName && (
                      <p className="muted small">{t('import.selected')} <strong>{importFileName}</strong></p>
                    )}
                    <label className="checkbox-label">
                      <input type="checkbox" checked={importDryRun} onChange={(e) => setImportDryRun(e.target.checked)} />
                      {t('import.dryRun')}
                    </label>
                    <button type="submit" className="primary">
                      {importDryRun ? t('import.testBtn') : t('import.importBtn')}
                    </button>
                  </form>
                </div>

                {canExportCsv && (
                  <div className="card">
                    <h3>{t('import.exportHeading')}</h3>
                    <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
                      {t('import.exportIntro')}
                    </p>
                    <button className="secondary" onClick={exportCsv}>{t('import.downloadCsv')}</button>
                  </div>
                )}

                <div className="card">
                  <h3>{t('import.setupHeading')}</h3>
                  <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
                    {t('import.setupIntro')}
                  </p>
                  <div className="button-group" style={{ marginTop: 0 }}>
                    <button className="primary" onClick={() => void setupLibraryCatalog()}>
                      {t('import.setupCatalog')}
                    </button>
                    <button className="secondary" onClick={applyDefaultBookStructure}>
                      {t('import.setupLegacy')}
                    </button>
                  </div>
                  <p className="muted small" style={{ marginTop: '0.75rem' }}>
                    {t('import.setupNote', { n: CATALOG_FIELD_COUNT })}
                  </p>
                </div>
              </>
            )}

            {/* ═══ MAINTAINANCE TAB ═══ */}
            {currentSection === 'settings' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>{t('settings.title')}</h2>
                    <p>{t('settings.description')}</p>
                  </div>
                </div>

                {/* Training / Start guide — replay the onboarding course anytime */}
                <div className="card">
                  <h3>🎓 {t('settings.training.heading')}</h3>
                  <p className="muted small" style={{ marginBottom: '1rem' }}>
                    {t('settings.training.intro')}
                  </p>
                  <button className="secondary" onClick={() => setShowOnboarding(true)}>{t('settings.training.start')}</button>
                </div>

                {/* Custom field manager */}
                <div className="card">
                  <h3>{t('settings.customAttrs', { n: customFields.length })}</h3>
                  <p className="muted small" style={{ marginBottom: '1rem' }}>
                    {t('settings.customIntro')}
                  </p>

                  {customFields.length > 0 && (
                    <div className="cf-list">
                      {/* Two groups, in the same order every attribute list uses:
                          the everyday fields first, then the rest. */}
                      {pinnedCustomFields.length > 0 && (
                        <p className="cf-group-heading">
                          ★ {t('settings.pinnedGroup', { n: pinnedCustomFields.length })}
                        </p>
                      )}
                      {[...pinnedCustomFields, ...unpinnedCustomFields].map((f, index) => {
                        const isFirstUnpinned =
                          !f.pinned && index === pinnedCustomFields.length && pinnedCustomFields.length > 0;
                        return (
                          <Fragment key={f.id}>
                            {isFirstUnpinned && (
                              <p className="cf-group-heading">{t('settings.otherGroup', { n: unpinnedCustomFields.length })}</p>
                            )}
                            <div className={f.pinned ? 'cf-row cf-row-pinned' : 'cf-row'}>
                              <div className="cf-row-text">
                                <strong>{f.pinned ? '★ ' : ''}{f.label}</strong>
                                <span className="muted small">
                                  <code>{f.key}</code> · {f.type}{f.required ? ` ${t('settings.requiredSuffix')}` : ''}
                                  {f.type === 'enum' && f.enumOptions.length > 0 ? ` ${t('settings.optionsSuffix', { n: f.enumOptions.length })}` : ''}
                                </span>
                              </div>
                              {canManageCustomFields && (
                                <div className="cf-row-actions">
                                  {/* One click to pin/unpin — editing the whole
                                      definition just to move a field to the top
                                      is more ceremony than the action deserves. */}
                                  <button
                                    className={f.pinned ? 'secondary small cf-pin-on' : 'secondary small'}
                                    onClick={() => void toggleCustomFieldPin(f)}
                                    title={f.pinned ? t('settings.unpinTitle') : t('settings.pinTitle')}
                                    aria-pressed={f.pinned}
                                  >{f.pinned ? '★' : '☆'}</button>
                                  {f.pinned && (
                                    <>
                                      <button
                                        className="secondary small"
                                        onClick={() => void moveCustomField(f, -1)}
                                        title={t('settings.moveUp')}
                                        aria-label={t('settings.moveUp')}
                                      >↑</button>
                                      <button
                                        className="secondary small"
                                        onClick={() => void moveCustomField(f, 1)}
                                        title={t('settings.moveDown')}
                                        aria-label={t('settings.moveDown')}
                                      >↓</button>
                                    </>
                                  )}
                                  <button className="secondary small" onClick={() => beginCustomFieldEdit(f)}>{t('common.edit')}</button>
                                  <button className="danger small" onClick={() => void deleteCustomField(f)}>{t('common.delete')}</button>
                                </div>
                              )}
                            </div>
                          </Fragment>
                        );
                      })}
                    </div>
                  )}

                  {canManageCustomFields && (
                    <details className="custom-fields-section" open={Boolean(editingCustomFieldId)} style={{ marginTop: '1rem' }}>
                      <summary>{editingCustomFieldId ? t('settings.editAttr') : t('settings.addAttr')}</summary>
                      <form onSubmit={saveCustomField} className="simple-form" style={{ marginTop: '0.75rem' }}>
                        <div className="form-row">
                          <div>
                            <label>{t('settings.attrKey')}</label>
                            <input
                              value={fieldForm.key}
                              onChange={(e) => setFieldForm({ ...fieldForm, key: e.target.value })}
                              placeholder={t('settings.attrKeyPh')}
                              required
                            />
                          </div>
                          <div>
                            <label>{t('settings.attrLabel')}</label>
                            <input
                              value={fieldForm.label}
                              onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })}
                              placeholder={t('settings.attrLabelPh')}
                              required
                            />
                          </div>
                        </div>
                        <div className="form-row">
                          <div>
                            <label>{t('settings.attrType')}</label>
                            <select
                              value={fieldForm.type}
                              onChange={(e) => setFieldForm({ ...fieldForm, type: e.target.value as CustomField['type'] })}
                            >
                              <option value="text">{t('settings.attrType.text')}</option>
                              <option value="number">{t('settings.attrType.number')}</option>
                              <option value="boolean">{t('settings.attrType.boolean')}</option>
                              <option value="date">{t('settings.attrType.date')}</option>
                              <option value="enum">{t('settings.attrType.enum')}</option>
                            </select>
                          </div>
                          <div>
                            <label>{t('settings.attrRequired')}</label>
                            <select
                              value={fieldForm.required ? 'yes' : 'no'}
                              onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.value === 'yes' })}
                            >
                              <option value="no">{t('common.no')}</option>
                              <option value="yes">{t('common.yes')}</option>
                            </select>
                          </div>
                        </div>
                        {fieldForm.type === 'enum' && (
                          <div className="form-field">
                            <label>{t('settings.attrEnumOptions')}</label>
                            <input
                              value={fieldForm.enumOptionsCsv}
                              onChange={(e) => setFieldForm({ ...fieldForm, enumOptionsCsv: e.target.value })}
                              placeholder={t('settings.attrEnumPh')}
                            />
                          </div>
                        )}
                        <div className="button-group">
                          <button type="submit" className="primary">{editingCustomFieldId ? t('settings.attrSave') : t('settings.attrAdd')}</button>
                          {editingCustomFieldId && (
                            <button type="button" className="secondary" onClick={resetCustomFieldForm}>{t('common.cancel')}</button>
                          )}
                        </div>
                      </form>
                    </details>
                  )}
                </div>

                {/* Duplicate checker */}
                <div className="card">
                  <h3>{t('settings.dupHeading')}</h3>
                  <p className="muted small" style={{ marginBottom: '1rem' }}>
                    {t('settings.dupIntro')}
                  </p>
                  <button className="secondary" onClick={() => void checkDuplicates()}>{t('settings.dupScan')}</button>
                </div>

                {showDuplicatesPanel && duplicateGroups.length > 0 && (
                  <div className="card" style={{ borderLeft: '3px solid var(--warning)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <strong>{t('settings.dupGroupsFound', { n: duplicateGroups.length, s: duplicateGroups.length !== 1 ? 's' : '' })}</strong>
                      <button className="secondary small" onClick={() => setShowDuplicatesPanel(false)}>{t('common.close')}</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {duplicateGroups.map((group, i) => (
                        <div key={i} style={{ background: 'var(--surface-2)', borderRadius: '6px', padding: '0.75rem' }}>
                          <p style={{ margin: '0 0 0.4rem', fontWeight: 600, fontSize: '0.875rem' }}>
                            "{displayTitle(group[0], t('common.untitled'))}" — {displayAuthor(group[0], t('common.unknownAuthor'))}
                          </p>
                          <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            {group.map((entry) => (
                              <li key={entry.id}>
                                {t('settings.dupId')} {entry.id.slice(0, 8)}…{entry.isbn ? ` | ${t('settings.dupIsbn')} ${entry.isbn}` : ''}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* User management (admin-only) */}
                {isAdmin && (
                  <div className="card">
                    <h3>{t('users.title')}</h3>
                    <p className="muted small" style={{ marginBottom: '0.75rem' }}>{t('users.description')}</p>

                    {staffUsersLoading && staffUsers.length === 0 ? (
                      <p className="muted small">{t('common.loading')}</p>
                    ) : staffUsers.length === 0 ? (
                      <p className="muted small">{t('users.empty')}</p>
                    ) : (
                      <div className="cf-list">
                        {staffUsers.map((u) => {
                          const isSelf = u.id === currentUser?.id;
                          const isEditing = editingUserId === u.id;
                          return (
                            <div key={u.id} className="cf-row" style={{ flexWrap: 'wrap' }}>
                              <div className="cf-row-text">
                                <strong>{u.username}{isSelf ? ` (${t('users.you')})` : ''}</strong>
                                <span className="muted small">
                                  {u.active === 1 ? t('users.active') : t('users.inactive')}
                                  {' · '}{new Date(u.created_at).toLocaleDateString()}
                                </span>
                                <span
                                  className="muted small"
                                  style={{ display: 'block', marginTop: '0.15rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', cursor: 'pointer' }}
                                  title={t('users.uuidCopy')}
                                  onClick={() => {
                                    void navigator.clipboard?.writeText(u.id);
                                    toast.push('success', t('users.uuidCopied'));
                                  }}
                                >
                                  {t('users.uuid')}: {u.id}
                                </span>
                              </div>
                              <div className="cf-row-actions" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <select
                                  value={u.role}
                                  onChange={(e) => void updateStaffUserRole(u, e.target.value as StaffRole)}
                                  disabled={isSelf}
                                  aria-label={t('users.role')}
                                >
                                  <option value="admin">{t('users.role.admin')}</option>
                                  <option value="librarian">{t('users.role.librarian')}</option>
                                  <option value="viewer">{t('users.role.viewer')}</option>
                                </select>
                                <button
                                  className="secondary small"
                                  onClick={() => void toggleStaffUserActive(u)}
                                  disabled={isSelf}
                                >
                                  {u.active === 1 ? t('users.deactivate') : t('users.activate')}
                                </button>
                                <button
                                  className="secondary small"
                                  onClick={() => {
                                    setEditingUserId(isEditing ? null : u.id);
                                    setEditUserPassword('');
                                  }}
                                >{isEditing ? t('common.cancel') : t('users.resetPassword')}</button>
                                <button
                                  className="danger small"
                                  onClick={() => void deleteStaffUser(u)}
                                  disabled={isSelf}
                                  title={isSelf ? t('users.cannotDeleteSelf') : undefined}
                                >{t('common.delete')}</button>
                              </div>
                              {isEditing && (
                                <form
                                  style={{ flex: '1 1 100%', display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}
                                  onSubmit={(e) => { e.preventDefault(); void resetStaffUserPassword(u); }}
                                >
                                  <input
                                    type="password"
                                    placeholder={t('users.newPasswordPh')}
                                    value={editUserPassword}
                                    onChange={(e) => setEditUserPassword(e.target.value)}
                                    autoComplete="new-password"
                                    minLength={8}
                                    required
                                    style={{ flex: 1 }}
                                  />
                                  <button type="submit" className="primary small">{t('users.savePassword')}</button>
                                </form>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <details className="custom-fields-section" style={{ marginTop: '1rem' }}>
                      <summary>{t('users.add')}</summary>
                      <form onSubmit={createStaffUser} className="simple-form" style={{ marginTop: '0.75rem' }}>
                        <div className="form-row">
                          <div>
                            <label>{t('users.username')} *</label>
                            <input
                              value={newUserUsername}
                              onChange={(e) => setNewUserUsername(e.target.value)}
                              autoComplete="off"
                              minLength={3}
                              required
                            />
                          </div>
                          <div>
                            <label>{t('users.password')} *</label>
                            <input
                              type="password"
                              value={newUserPassword}
                              onChange={(e) => setNewUserPassword(e.target.value)}
                              autoComplete="new-password"
                              minLength={8}
                              required
                            />
                          </div>
                          <div>
                            <label>{t('users.role')} *</label>
                            <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as StaffRole)}>
                              <option value="admin">{t('users.role.admin')}</option>
                              <option value="librarian">{t('users.role.librarian')}</option>
                              <option value="viewer">{t('users.role.viewer')}</option>
                            </select>
                          </div>
                        </div>
                        <p className="muted small" style={{ marginTop: '0.5rem' }}>{t('users.passwordHint')}</p>
                        <button type="submit" className="primary small" style={{ marginTop: '0.5rem' }}>{t('users.create')}</button>
                      </form>
                    </details>
                  </div>
                )}

                {/* Roles & permissions matrix (admin-only) */}
                {isAdmin && (
                  <div className="card">
                    <h3>{t('roles.title')}</h3>
                    <p className="muted small" style={{ marginBottom: '0.75rem' }}>{t('roles.description')}</p>
                    {!permissionMatrix ? (
                      <button
                        className="secondary small"
                        onClick={() => void loadPermissionMatrix()}
                        disabled={permissionMatrixLoading}
                      >
                        {permissionMatrixLoading ? t('common.loading') : t('roles.load')}
                      </button>
                    ) : (
                      <>
                        <div style={{ overflowX: 'auto' }}>
                          <table className="perm-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: 'left', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border, rgba(127,127,127,0.3))' }}>{t('roles.permission')}</th>
                                <th style={{ textAlign: 'center', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border, rgba(127,127,127,0.3))' }}>{t('users.role.admin')}</th>
                                <th style={{ textAlign: 'center', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border, rgba(127,127,127,0.3))' }}>{t('users.role.librarian')}</th>
                                <th style={{ textAlign: 'center', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border, rgba(127,127,127,0.3))' }}>{t('users.role.viewer')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {permissionMatrix.catalog.map((perm) => (
                                <tr key={perm}>
                                  <td style={{ padding: '0.35rem 0.5rem', borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
                                    <strong>{t(`perm.${perm}` as never)}</strong>
                                    <div className="muted small">{t(`perm.${perm}.desc` as never)}</div>
                                  </td>
                                  <td style={{ textAlign: 'center', padding: '0.35rem 0.5rem', borderBottom: '1px solid rgba(127,127,127,0.15)' }} title={t('roles.adminLocked')}>
                                    <input type="checkbox" checked disabled />
                                  </td>
                                  <td style={{ textAlign: 'center', padding: '0.35rem 0.5rem', borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(permissionMatrix.matrix.librarian[perm])}
                                      onChange={() => togglePermissionCell('librarian', perm)}
                                    />
                                  </td>
                                  <td style={{ textAlign: 'center', padding: '0.35rem 0.5rem', borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(permissionMatrix.matrix.viewer[perm])}
                                      onChange={() => togglePermissionCell('viewer', perm)}
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="muted small" style={{ marginTop: '0.5rem' }}>{t('roles.adminLocked')}</p>
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                          <button
                            className="primary small"
                            onClick={() => void savePermissionMatrix()}
                            disabled={permissionMatrixSaving}
                          >
                            {permissionMatrixSaving ? t('common.loading') : t('roles.save')}
                          </button>
                          <button
                            className="secondary small"
                            onClick={() => void loadPermissionMatrix()}
                            disabled={permissionMatrixSaving}
                          >
                            {t('roles.reload')}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Audit log */}
                {currentUser?.role === 'admin' && (
                  <div className="card">
                    <h3>{t('settings.auditHeading')}</h3>
                    {auditItems.length === 0 ? (
                      <p className="muted small">{t('settings.auditEmpty')}</p>
                    ) : (
                      <div className="audit-list">
                        {auditItems.map((entry) => (
                          <div key={entry.id} className="audit-row">
                            <code className="audit-action">{entry.action}</code>
                            <span className="muted small">{entry.entity_type}{entry.entity_id ? `:${String(entry.entity_id).slice(0, 8)}…` : ''}</span>
                            <span className="muted small audit-time">{new Date(entry.created_at).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Maintenance tools */}
                {currentUser?.role === 'admin' && (
                  <div className="card">
                    <h3>{t('settings.normHeading')}</h3>
                    <p className="muted small" style={{ marginBottom: '1rem' }}>
                      {t('settings.normIntro')}
                    </p>
                    <button className="secondary" onClick={() => void normalizeAllBooks()}>{t('settings.normRun')}</button>
                    <p className="muted small" style={{ margin: '1.25rem 0 1rem' }}>
                      {t('settings.searchIndexIntro')}
                    </p>
                    <button className="secondary" onClick={() => void rebuildSearchIndex()}>{t('settings.searchIndexRun')}</button>
                  </div>
                )}

                {/* Value consistency: consolidate the librarians' spelling variants */}
                {canWrite && (
                  <div className="card">
                    <h3>{t('settings.vc.heading')}</h3>
                    <p className="muted small" style={{ marginBottom: '1rem' }}>{t('settings.vc.intro')}</p>
                    <div className="search-bar" style={{ alignItems: 'flex-end' }}>
                      <div className="filter-field">
                        <label>{t('settings.vc.field')}</label>
                        <select
                          value={variantField}
                          onChange={(e) => { setVariantField(e.target.value as VariantField); setVariantsScanned(false); setValueVariants([]); }}
                        >
                          <option value="publisher">{t('library.add.publisher')}</option>
                          <option value="author">{t('library.add.author')}</option>
                          <option value="language">{t('library.add.language')}</option>
                          <option value="shelfCode">{t('library.add.shelf')}</option>
                          <option value="title">{t('library.add.bookTitle')}</option>
                        </select>
                      </div>
                      <div className="search-actions">
                        <label>.</label>
                        <button className="secondary" disabled={variantsLoading} onClick={() => void loadValueVariants(variantField)}>
                          {variantsLoading ? t('settings.vc.scanning') : t('settings.vc.scan')}
                        </button>
                      </div>
                    </div>
                    {variantsScanned && !variantsLoading && (
                      valueVariants.length === 0 ? (
                        <p className="muted small" style={{ marginTop: '0.75rem' }}>{t('settings.vc.none')}</p>
                      ) : (
                        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                          <p className="muted small">{t('settings.vc.foundNote', { n: valueVariants.length })}</p>
                          {valueVariants.map((g) => (
                            <VariantGroupCard
                              key={g.canonical + g.total}
                              group={g}
                              mergeLabel={t('settings.vc.merge')}
                              keepLabel={t('settings.vc.useAsCanonical')}
                              onMerge={(canon) => void consolidateVariantGroup(variantField, g, canon)}
                            />
                          ))}
                        </div>
                      )
                    )}
                  </div>
                )}

                {/* System info */}
                <div className="card">
                  <h3>{t('settings.system')}</h3>
                  <ul className="system-info">
                    <li><span>{t('settings.system.api')}</span><code>{API_BASE}</code></li>
                    <li><span>{t('settings.system.user')}</span><code>{currentUser?.username} ({currentUser?.role})</code></li>
                    <li><span>{t('settings.system.books')}</span><code>{fmt(totalBooksCount)}</code></li>
                    <li><span>{t('settings.system.fields')}</span><code>{customFields.length}</code></li>
                    <li><span>{t('settings.system.theme')}</span><code>{theme}</code></li>
                    <li><span>{t('settings.system.lang')}</span><code>{lang}</code></li>
                  </ul>
                </div>
              </>
            )}

          </div>
        </>
      )}

      {isWorking && (
        <div className="working-pill" role="status" aria-live="polite">
          <span className="spinner" /> {t('app.working')}
        </div>
      )}
    </div>
  );
}

function Root() {
  return (
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
