import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  enumOptions: string[];
};

type LoginResponse = {
  user: { id: string; username: string; role: string };
};

type SessionResponse = {
  user: { id: string; username: string; role: string };
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
type SearchMode = 'all' | 'any' | 'exact';
type SearchField = 'title' | 'author' | 'isbn' | 'publisher' | 'language' | 'description' | 'roomCode' | 'shelfCode' | 'tags' | 'custom';

const RAW_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8787';
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');
const IMPORT_CHUNK_SIZE = 500;
const IMPORT_MIN_CHUNK_SIZE = 1;
const PAGE_SIZE = 50;
const DEBOUNCE_MS = 350;
const PREFS_STORAGE_KEY = 'ok-library-prefs-v1';

type SortBy = 'updatedAt' | 'title' | 'author' | 'publicationYear' | 'status';
type SortDir = 'asc' | 'desc';
type Density = 'comfortable' | 'compact';

// Kept in sync with CATALOG_CUSTOM_FIELDS in apps/api-worker/src/index.ts.
const CATALOG_FIELD_COUNT = 25;
const TITLE_PLACEHOLDER = '(Untitled)';
const AUTHOR_PLACEHOLDER = '(Unknown)';

function isPlaceholder(value: string | null | undefined, kind: 'title' | 'author'): boolean {
  const text = (value ?? '').trim();
  return kind === 'title' ? text === TITLE_PLACEHOLDER : text === AUTHOR_PLACEHOLDER;
}

function displayTitle(book: { title: string }): string {
  const trimmed = book.title?.trim() ?? '';
  return trimmed === '' ? TITLE_PLACEHOLDER : trimmed;
}

function displayAuthor(book: { author: string }): string {
  const trimmed = book.author?.trim() ?? '';
  return trimmed === '' ? AUTHOR_PLACEHOLDER : trimmed;
}

function joinApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
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

function isPayloadTooLargeError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }

  if (error.status === 413) {
    return true;
  }

  return /too big|payload|entity too large|request too large/i.test(error.message);
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
  raw = false
): Promise<T> {
  const response = await fetch(joinApiUrl(path), {
    ...init,
    credentials: 'include',
    headers: {
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const responseText = await response.text();
    const errorBody = (() => {
      try {
        return JSON.parse(responseText) as { error?: string; requestId?: string };
      } catch {
        return { error: response.statusText };
      }
    })();

    if (response.status === 401) {
      throw new ApiRequestError(401, 'Session expired. Please sign in again.');
    }

    const message = errorBody.requestId
      ? `${errorBody.error ?? `Request failed with status ${response.status}`} (ref: ${errorBody.requestId})`
      : (errorBody.error ?? `Request failed with status ${response.status}`);
    throw new ApiRequestError(response.status, message);
  }

  if (raw) {
    return (await response.text()) as T;
  }

  return (await response.json()) as T;
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

function App() {
  const toast = useToast();
  const confirm = useConfirm();
  const { t, lang } = useI18n();
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string; role: string } | null>(null);
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
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalBooksCount, setTotalBooksCount] = useState(0);

  const [q, setQ] = useState('');
  const [qExclude, setQExclude] = useState('');
  const [qMode, setQMode] = useState<SearchMode>('all');
  const [partialWords, setPartialWords] = useState(true);
  const [fuzzyTypos, setFuzzyTypos] = useState(true);
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
  const bookHistorySeqRef = useRef(0);
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

  const [fieldForm, setFieldForm] = useState({
    key: '',
    label: '',
    type: 'text' as 'text' | 'number' | 'boolean' | 'date' | 'enum',
    required: false,
    enumOptionsCsv: ''
  });
  const [editingCustomFieldId, setEditingCustomFieldId] = useState<string | null>(null);

  const [importJson, setImportJson] = useState('[]');
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
  const [roomSummary, setRoomSummary] = useState<RoomSummaryItem[]>([]);
  const [unassignedSummary, setUnassignedSummary] = useState({
    totalBooks: 0,
    availableBooks: 0,
    borrowedBooks: 0,
    lostBooks: 0,
    maintenanceBooks: 0
  });
  const [attributeEditorValues, setAttributeEditorValues] = useState<Record<string, unknown>>({});
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>([]);
  const [detailBook, setDetailBook] = useState<Book | null>(null);
  const [detailMode, setDetailMode] = useState<'view' | 'edit'>('view');
  const [showAddBook, setShowAddBook] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<string>('');
  const [bulkShelfCode, setBulkShelfCode] = useState('');
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [showDuplicatesPanel, setShowDuplicatesPanel] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateEntry[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [didBootstrapData, setDidBootstrapData] = useState(false);
  const [isLoadingBooks, setIsLoadingBooks] = useState(false);

  const splashStartRef = useRef(0);
  const splashActiveRef = useRef(false);
  const [showSplash, setShowSplash] = useState(false);
  const [splashHiding, setSplashHiding] = useState(false);
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

  // Restore session from HttpOnly cookie on first load
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
      if (event.key === 'Escape' && detailBook) {
        setDetailBook(null);
        setDetailMode('view');
        setBookHistory([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loggedIn, detailBook]);

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

  const role = currentUser?.role ?? null;
  const isAdmin = role === 'admin';
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
      'customfields'
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

    const similar = customFields.find(
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
    const author = toNullableText(firstSpreadsheetValue(row, ['author', 'writer', 'writers']));
    if (!title || !author) {
      throw new Error(t('toast.rowMissing', { row: index + 2 }));
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
      author,
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
    await Promise.all([
      loadBooks(),
      loadRoomSummary(),
      loadCustomFields(),
      loadActiveBorrows(),
      loadAuditLogs(),
      loadStaffUsers(),
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
    } catch {
      if (seq !== borrowerSearchSeqRef.current) return;
      setBorrowerSuggestions([]);
    }
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
      await runAction(() =>
        apiRequest<{ ok: boolean; coverUrl: string }>(`/api/books/${book.id}/cover`, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file
        }, false)
      );
      setMessage(t('toast.coverUpdated', { title: book.title }));
      setDetailBook((prev) =>
        prev && prev.id === book.id
          ? { ...prev, coverUrl: `/api/books/${book.id}/cover?v=${Date.now()}` }
          : prev
      );
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
      await runAction(() => apiRequest<void>(`/api/books/${book.id}/cover`, { method: 'DELETE' }));
      setMessage(t('toast.coverRemoved'));
      setDetailBook((prev) => (prev && prev.id === book.id ? { ...prev, coverUrl: null } : prev));
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
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
    try {
      const response = await apiRequest<StatsResponse>('/api/stats');
      setStats(response);
    } catch {
      setStats(null);
    }
  }

  async function loadCategories() {
    try {
      const response = await apiRequest<{ items: CategoryItem[] }>('/api/categories');
      setCategories(response.items ?? []);
    } catch {
      // Best-effort: a stale category rail isn't worth blocking the UI for.
      setCategories([]);
    }
  }

  async function loadNeedsReviewCount() {
    try {
      const response = await apiRequest<{ count: number }>('/api/needs-review-count');
      setNeedsReviewCount(response.count ?? 0);
    } catch {
      setNeedsReviewCount(0);
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
    setMessage(t('login.signedOut'));
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
    setIsLoadingBooks(true);
    try {
      const page = pageOverride ?? currentPage;
      const query = new URLSearchParams();
      if (q) query.set('q', q);
      if (qExclude) query.set('qExclude', qExclude);
      query.set('qMode', qMode);
      query.set('partialWords', String(partialWords));
      query.set('fuzzyTypos', String(fuzzyTypos));
      query.set('searchFields', searchFields.join(','));
      if (status) query.set('status', status);
      if (filterLanguage) query.set('language', filterLanguage);
      if (filterYear) query.set('year', filterYear);
      if (categoryFilter) query.set('custom_category_code', categoryFilter);
      if (needsReviewFilter) query.set('custom_needs_review', '1');
      if (shelfFilter) query.set('shelfCode', shelfFilter);
      // Apply the active smart-list's filters last so it composes with the rest.
      if (smartListKey) {
        const list = SMART_LISTS.find((l) => l.key === smartListKey);
        if (list) {
          for (const [k, v] of Object.entries(list.params)) {
            query.set(k, v);
          }
        }
      }
      query.set('sortBy', sortBy);
      query.set('sortDir', sortDir);
      query.set('page', page.toString());
      query.set('pageSize', String(PAGE_SIZE));

      const response = await apiRequest<{ items: Book[]; total: number }>(`/api/books?${query.toString()}`);
      setBooks(response.items);
      setTotalBooksCount(response.total);
      setCurrentPage(page);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsLoadingBooks(false);
    }
  }, [
    currentPage, q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
    status, filterLanguage, filterYear, categoryFilter, needsReviewFilter,
    shelfFilter, sortBy, sortDir, smartListKey
  ]);

  // Debounced auto-search: any change to query/filters/sort re-fetches books on page 1.
  useEffect(() => {
    if (!loggedIn || !didBootstrapData) return;
    const signature = JSON.stringify({
      q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
      status, filterLanguage, filterYear, categoryFilter, needsReviewFilter,
      shelfFilter, sortBy, sortDir, smartListKey
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
    shelfFilter, sortBy, sortDir, smartListKey,
    loadBooks
  ]);

  async function loadCustomFields() {
    try {
      const response = await apiRequest<{ items: CustomField[] }>('/api/custom-fields');
      setCustomFields(response.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadRoomSummary() {
    try {
      const response = await apiRequest<{
        items: RoomSummaryItem[];
        unassigned: {
          totalBooks: number;
          availableBooks: number;
          borrowedBooks: number;
          lostBooks: number;
          maintenanceBooks: number;
        };
      }>('/api/rooms/summary');
      setRoomSummary(response.items ?? []);
      setUnassignedSummary(response.unassigned);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadActiveBorrows() {
    try {
      const response = await apiRequest<{ items: ActiveBorrow[] }>('/api/borrow/active');
      setActiveBorrows(response.items ?? []);
    } catch (e) {
      setError((e as Error).message);
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

  async function createBook(event: FormEvent) {
    event.preventDefault();
    clearStatus();
    setDuplicateWarning([]);

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
      setCreateAttrValues({});
      setShowAddBook(false);

      if (result.duplicateOf && result.duplicateOf.length > 0) {
        setDuplicateWarning(result.duplicateOf);
        setMessage(t('toast.bookAddedDuplicate'));
      } else {
        setMessage(t('toast.bookAdded'));
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

  async function loadBookHistory(bookId: string) {
    if (!bookId) {
      return;
    }

    // Drop responses for books the user has already navigated away from.
    // Without this guard, switching detail panes quickly can leave the wrong
    // book's history rendered against a different book's data.
    const seq = ++bookHistorySeqRef.current;
    try {
      const response = await apiRequest<{ bookId: string; items: BorrowHistoryItem[] }>(
        `/api/books/${bookId}/history?limit=20`
      );
      if (seq !== bookHistorySeqRef.current) return;
      setBookHistory(response.items ?? []);
    } catch {
      if (seq !== bookHistorySeqRef.current) return;
      setBookHistory([]);
    }
  }

  async function saveBookEdit(event: FormEvent) {
    event.preventDefault();
    if (!editForm.id) return;
    clearStatus();

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
      await Promise.all([loadBooks(), loadCategories(), loadNeedsReviewCount()]);
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

    if (!borrowerName || !dueAt) {
      setError(t('toast.borrowerRequired'));
      return;
    }

    try {
      const body: Record<string, unknown> = { dueAt, notes: null };
      if (selectedBorrowerId) {
        body.borrowerId = selectedBorrowerId;
      } else {
        body.borrowerName = borrowerName;
        body.borrowerContact = borrowerContact || null;
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

  async function quickReturnByBookId(bookId: string, title: string) {
    clearStatus();

    try {
      await runAction(() => apiRequest(`/api/books/${bookId}/return`, {
        method: 'POST',
        body: JSON.stringify({ notes: 'Returned from active loans list' })
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
              body: JSON.stringify({ notes: 'Bulk returned from overdue list' })
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

  function selectAllOnPage() {
    setSelectedBookIds(books.map((book) => book.id));
  }

  function clearSelectedBooks() {
    setSelectedBookIds([]);
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
      if (bulkShelfCode.trim()) {
        updates.shelfCode = bulkShelfCode.trim();
      }

      if (Object.keys(updates).length === 0) {
        throw new Error(t('toast.bulkRequireValue'));
      }

      const selectedBooks = books.filter((book) => selectedBookIds.includes(book.id));
      const results = await runAction(() =>
        Promise.allSettled(
          selectedBooks.map((book) =>
            apiRequest<{ id: string; version: number }>(`/api/books/${book.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                ...updates,
                version: book.version
              })
            })
          )
        )
      );

      const failed = results.filter((result) => result.status === 'rejected').length;
      const success = results.length - failed;

      if (failed > 0) {
        setMessage(t('toast.bulkPartial', { success, failed }));
      } else {
        setMessage(t('toast.bulkAll', { n: success }));
      }

      setBulkStatus('');
      setBulkShelfCode('');
      setSelectedBookIds([]);
      await Promise.all([loadBooks(), loadRoomSummary()]);
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
      setScanResult(`${response.book.title} by ${response.book.author}`);
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

  function resetCustomFieldForm() {
    setFieldForm({ key: '', label: '', type: 'text', required: false, enumOptionsCsv: '' });
    setEditingCustomFieldId(null);
  }

  function beginCustomFieldEdit(field: CustomField) {
    setEditingCustomFieldId(field.id);
    setFieldForm({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
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

  async function runImport(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    try {
      const parsedRows = JSON.parse(importJson) as Array<Record<string, unknown>>;
      if (!Array.isArray(parsedRows)) {
        throw new Error(t('toast.xlsxRowsRequired'));
      }
      const rows = parsedRows.map((row) => ({
        title: String(row.title ?? ''),
        author: String(row.author ?? ''),
        isbn: row.isbn ? String(row.isbn) : null,
        publicationYear: row.publicationYear ? Number(row.publicationYear) : null,
        publisher: row.publisher ? String(row.publisher) : null,
        language: row.language ? String(row.language) : null,
        description: row.description ? String(row.description) : null,
        roomCode: row.roomCode ? String(row.roomCode) : null,
        shelfCode: row.shelfCode ? String(row.shelfCode) : null,
        acquisitionDate: row.acquisitionDate ? String(row.acquisitionDate) : null,
        tags: Array.isArray(row.tags) ? row.tags.map((x) => String(x)) : [],
        customFields: (row.customFields as Record<string, unknown> | undefined) ?? {},
        status: (row.status as BookStatus | undefined) ?? 'available'
      }));

      const result = await runAction(() => apiRequest<{ dryRun?: boolean; acceptedRows?: number; importedRows?: number }>(
        '/api/import/books',
        {
          method: 'POST',
          body: JSON.stringify({ dryRun: importDryRun, rows })
        }
      ));

      if (result.dryRun) {
        setMessage(t('toast.dryRunDone', { n: result.acceptedRows ?? 0 }));
      } else {
        setMessage(t('toast.importDone', { n: result.importedRows ?? 0 }));
      }
      await loadBooks();
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
          const message = (error as Error).message;
          if (message.includes('title and writer/author are required')) {
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

        while (cursor < rows.length) {
          const end = Math.min(cursor + chunkSize, rows.length);
          const chunk = rows.slice(cursor, end);
          const chunkProgress = t('toast.chunkLabel', { n: Math.floor(cursor / chunkSize) + 1 });
          setMessage(t('toast.dryRunChunk', { progress: chunkProgress, from: cursor + 1, to: end, n: rows.length }));

          try {
            const result = await runAction(() =>
              apiRequest<{ dryRun?: boolean; acceptedRows?: number; importedRows?: number }>('/api/import/books', {
                method: 'POST',
                body: JSON.stringify({ dryRun: true, rows: chunk })
              })
            );

            totalAccepted += result.acceptedRows ?? chunk.length;
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
      } else {
        let chunkSize = IMPORT_CHUNK_SIZE;
        let cursor = 0;
        let totalImported = 0;
        const uploadSkippedRows: number[] = [];

        while (cursor < rows.length) {
          const end = Math.min(cursor + chunkSize, rows.length);
          const chunk = rows.slice(cursor, end);
          const chunkProgress = t('toast.chunkLabel', { n: Math.floor(cursor / chunkSize) + 1 });
          setMessage(t('toast.importingChunk', { progress: chunkProgress, from: cursor + 1, to: end, n: rows.length }));

          try {
            const result = await runAction(() =>
              apiRequest<{ dryRun?: boolean; acceptedRows?: number; importedRows?: number }>('/api/import/books', {
                method: 'POST',
                body: JSON.stringify({ dryRun: false, rows: chunk })
              })
            );

            totalImported += result.importedRows ?? 0;
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

            throw error;
          }
        }

        const uploadSkippedNote =
          uploadSkippedRows.length > 0
            ? t('toast.uploadSkipped', { n: uploadSkippedRows.length })
            : '';

        setMessage(
          t('toast.xlsxImportDone', { n: totalImported, skippedNote, uploadSkippedNote })
        );
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
  }

  function renderCustomFieldsForm(
    values: Record<string, unknown>,
    setValue: (key: string, value: unknown) => void
  ): React.ReactNode {
    if (customFields.length === 0) {
      return (
        <p className="muted small">
          No custom attributes defined yet. Open <strong>Import & Export → Setup</strong> to add the catalog preset.
        </p>
      );
    }
    return (
      <div className="custom-fields-grid">
        {customFields.map((field) => {
          const v = values[field.key];
          const idAttr = `cf-${field.key}`;
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
                <span>{field.label}{field.required && <span className="required-mark"> *</span>}</span>
              </label>
            );
          }
          if (field.type === 'enum') {
            return (
              <div key={field.key} className="form-field">
                <label htmlFor={idAttr}>{field.label}{field.required && <span className="required-mark"> *</span>}</label>
                <select
                  id={idAttr}
                  value={(v as string) ?? ''}
                  onChange={(e) => setValue(field.key, e.target.value || null)}
                >
                  <option value="">— none —</option>
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
              <label htmlFor={idAttr}>{field.label}{field.required && <span className="required-mark"> *</span>}</label>
              <input
                id={idAttr}
                type={inputType}
                value={displayValue === null || displayValue === undefined ? '' : String(displayValue)}
                onChange={(e) => setValue(field.key, e.target.value)}
                placeholder={field.key}
              />
            </div>
          );
        })}
      </div>
    );
  }

  function startEditFromDetail() {
    if (!detailBook) return;
    setDetailMode('edit');
    setEditForm({
      id: detailBook.id,
      title: detailBook.title,
      author: detailBook.author,
      isbn: detailBook.isbn ?? '',
      shelfCode: detailBook.shelfCode ?? '',
      publicationYear: detailBook.publicationYear?.toString() ?? '',
      status: detailBook.status,
      version: detailBook.version,
      publisher: detailBook.publisher ?? '',
      language: detailBook.language ?? '',
      description: detailBook.description ?? ''
    });
    setAttributeEditorValues(detailBook.customFields ?? {});
  }

  return (
    <div className="app-shell" aria-busy={isWorking}>

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
          <div className="modal" onClick={(e) => e.stopPropagation()}>

            {/* Header */}
            <div className="modal-header">
              <div className="modal-avatar">{(displayTitle(detailBook).charAt(0) || '?').toUpperCase()}</div>
              <div className="modal-title-block">
                <h2 className={isPlaceholder(detailBook.title, 'title') || !detailBook.title ? 'is-placeholder' : ''}>
                  {displayTitle(detailBook)}
                </h2>
                <p className={`modal-author${isPlaceholder(detailBook.author, 'author') || !detailBook.author ? ' is-placeholder' : ''}`}>
                  {displayAuthor(detailBook)}
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
                    <button className="secondary small" onClick={startEditFromDetail}>✏️ {t('detail.editBtn')}</button>
                  )}
                  {canWrite && detailBook.status === 'available' && (
                    <button className="primary small" onClick={() => {
                      setSelectedBook(detailBook);
                      setCurrentSection('circulation');
                      closeDetail();
                    }}>📤 {t('detail.borrowBtn')}</button>
                  )}
                  {canWrite && detailBook.status === 'borrowed' && (
                    <button className="secondary small" onClick={() => { void returnBook(detailBook); closeDetail(); }}>
                      📥 {t('detail.returnBtn')}
                    </button>
                  )}
                  <button className="secondary small" onClick={() => void printLabels([detailBook])}>🖨 {t('detail.labelBtn')}</button>
                  {canDelete && (
                    <button className="danger small" onClick={() => void deleteBook(detailBook)}>🗑 {t('detail.deleteBtn')}</button>
                  )}
                </>
              ) : (
                <button className="secondary small" onClick={() => setDetailMode('view')}>← {t('detail.backBtn')}</button>
              )}
            </div>

            {/* Body */}
            <div className="modal-body">
              {detailMode === 'view' ? (
                <>
                  {/* Cover image */}
                  <div className="detail-section cover-section">
                    {detailBook.coverUrl ? (
                      <img
                        className="detail-cover"
                        src={joinApiUrl(detailBook.coverUrl)}
                        alt={t('detail.coverAlt', { title: displayTitle(detailBook) })}
                        loading="lazy"
                      />
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
                      </div>
                    )}
                  </div>
                </>
              ) : (
                /* ── Edit Mode ── */
                <form onSubmit={saveBookEdit} className="simple-form">
                  <div className="form-row">
                    <div>
                      <label>{t('detail.title')} *</label>
                      <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required />
                    </div>
                    <div>
                      <label>{t('detail.author')} *</label>
                      <input value={editForm.author} onChange={(e) => setEditForm({ ...editForm, author: e.target.value })} required />
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>{t('detail.isbn')}</label>
                      <input value={editForm.isbn} onChange={(e) => setEditForm({ ...editForm, isbn: e.target.value })} placeholder={t('detail.isbnPh')} />
                    </div>
                    <div>
                      <label>{t('detail.yearPublished')}</label>
                      <input type="number" value={editForm.publicationYear} onChange={(e) => setEditForm({ ...editForm, publicationYear: e.target.value })} placeholder={t('detail.yearPh')} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>{t('detail.shelfRow')}</label>
                      <input value={editForm.shelfCode} onChange={(e) => setEditForm({ ...editForm, shelfCode: e.target.value })} placeholder={t('detail.shelfPh')} />
                    </div>
                    <div>
                      <label>{t('detail.statusRow')}</label>
                      <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value as BookStatus })}>
                        <option value="available">{t('status.available')}</option>
                        <option value="borrowed">{t('status.borrowed')}</option>
                        <option value="lost">{t('status.lost')}</option>
                        <option value="maintenance">{t('status.maintenance')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>{t('detail.publisher')}</label>
                      <input value={editForm.publisher} onChange={(e) => setEditForm({ ...editForm, publisher: e.target.value })} placeholder={t('detail.publisherPh')} />
                    </div>
                    <div>
                      <label>{t('detail.language')}</label>
                      <input value={editForm.language} onChange={(e) => setEditForm({ ...editForm, language: e.target.value })} placeholder={t('detail.languagePh')} />
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
                    {renderCustomFieldsForm(attributeEditorValues, (key, value) =>
                      setAttributeEditorValues((prev) => ({ ...prev, [key]: value }))
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
      ) : (
        <>
          {/* ─── Navbar ─── */}
          <div className="simple-navbar">
            <div className="navbar-brand">
              <div className="navbar-icon">📚</div>
              <h1>{t('app.brand')}</h1>
            </div>
            <div className="navbar-right">
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
                    <button className="secondary small" onClick={exportFilteredBooksCsv}>{t('library.exportCsv')}</button>
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
                  <div className="stat-box danger">
                    <span className="stat-box-label">{t('library.overdue')}</span>
                    <span className="stat-box-value">{overdueCount}</span>
                  </div>
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
                        onClick={() => setSmartListKey(active ? '' : list.key)}
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
                          <label>{t('library.add.bookTitle')} *</label>
                          <input value={createForm.title} onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })} placeholder={t('library.add.titlePh')} required />
                        </div>
                        <div>
                          <label>{t('library.add.author')} *</label>
                          <input value={createForm.author} onChange={(e) => setCreateForm({ ...createForm, author: e.target.value })} placeholder={t('library.add.authorPh')} required />
                        </div>
                      </div>
                      <div className="form-row">
                        <div>
                          <label>{t('library.add.isbn')}</label>
                          <input value={createForm.isbn} onChange={(e) => setCreateForm({ ...createForm, isbn: e.target.value })} placeholder={t('library.add.isbnPh')} />
                        </div>
                        <div>
                          <label>{t('library.add.year')}</label>
                          <input type="number" value={createForm.publicationYear} onChange={(e) => setCreateForm({ ...createForm, publicationYear: e.target.value })} placeholder={t('library.add.yearPh')} />
                        </div>
                        <div>
                          <label>{t('library.add.shelf')}</label>
                          <input value={createForm.shelfCode} onChange={(e) => setCreateForm({ ...createForm, shelfCode: e.target.value })} placeholder={t('library.add.shelfPh')} />
                        </div>
                      </div>
                      <div className="form-row">
                        <div>
                          <label>{t('library.add.publisher')}</label>
                          <input value={createForm.publisher} onChange={(e) => setCreateForm({ ...createForm, publisher: e.target.value })} placeholder={t('library.add.publisherPh')} />
                        </div>
                        <div>
                          <label>{t('library.add.language')}</label>
                          <input value={createForm.language} onChange={(e) => setCreateForm({ ...createForm, language: e.target.value })} placeholder={t('library.add.languagePh')} />
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

                      <details className="custom-fields-section" open={customFields.length > 0 && customFields.length <= 6}>
                        <summary>{t('library.add.attributes', { n: customFields.length })}</summary>
                        {renderCustomFieldsForm(createAttrValues, (key, value) =>
                          setCreateAttrValues((prev) => ({ ...prev, [key]: value }))
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
                            <li key={d.id}><em>{d.title}</em> — {d.author}{d.isbn ? ` (${t('library.add.isbn')}: ${d.isbn})` : ''}</li>
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
                      <input type="number" value={filterYear} onChange={(e) => setFilterYear(e.target.value)} placeholder={t('library.search.yearPh')} />
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
                          <label>{t('library.adv.exclude')}</label>
                          <input
                            value={qExclude}
                            onChange={(e) => setQExclude(e.target.value)}
                            placeholder={t('library.adv.excludePh')}
                          />
                        </div>
                        <div>
                          <label>{t('library.adv.matchMode')}</label>
                          <select value={qMode} onChange={(e) => setQMode(e.target.value as SearchMode)}>
                            <option value="all">{t('library.adv.modeAll')}</option>
                            <option value="any">{t('library.adv.modeAny')}</option>
                            <option value="exact">{t('library.adv.modeExact')}</option>
                          </select>
                        </div>
                        <div>
                          <label>{t('library.adv.partialWords')}</label>
                          <select value={partialWords ? 'yes' : 'no'} onChange={(e) => setPartialWords(e.target.value === 'yes')}>
                            <option value="yes">{t('library.adv.partialYes')}</option>
                            <option value="no">{t('library.adv.partialNo')}</option>
                          </select>
                        </div>
                        <div>
                          <label>{t('library.adv.fuzzy')}</label>
                          <select value={fuzzyTypos ? 'on' : 'off'} onChange={(e) => setFuzzyTypos(e.target.value === 'on')}>
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
                {canWrite && selectedBookIds.length > 0 && (
                  <div className="bulk-bar" role="region" aria-label={t('library.bulk.aria')}>
                    <div className="bulk-bar-info">
                      <strong>{selectedBookIds.length} </strong>
                      <span className="muted small">{t('library.bulk.selectedSuffix')}</span>
                      <button className="link-btn" onClick={selectAllOnPage}>{t('library.bulk.selectAll', { n: books.length })}</button>
                      <button className="link-btn" onClick={clearSelectedBooks}>{t('library.bulk.clear')}</button>
                    </div>
                    <div className="bulk-bar-actions">
                      <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} aria-label={t('library.bulk.setStatusAria')}>
                        <option value="">{t('library.bulk.setStatus')}</option>
                        <option value="available">{t('status.available')}</option>
                        <option value="borrowed">{t('status.borrowed')}</option>
                        <option value="lost">{t('status.lost')}</option>
                        <option value="maintenance">{t('status.maintenance')}</option>
                      </select>
                      <input
                        value={bulkShelfCode}
                        onChange={(e) => setBulkShelfCode(e.target.value)}
                        placeholder={t('library.bulk.setShelf')}
                        aria-label={t('library.bulk.setShelfAria')}
                      />
                      <button
                        className="primary small"
                        onClick={() => void applyBulkBookChanges()}
                        disabled={!bulkStatus && !bulkShelfCode.trim()}
                      >{t('common.apply')}</button>
                      <button
                        className="secondary small"
                        onClick={() => {
                          const targets = books.filter((b) => selectedBookIds.includes(b.id));
                          void printLabels(targets);
                        }}
                      >{t('library.bulk.labels')}</button>
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
                            const results = await runAction(() =>
                              Promise.allSettled(ids.map((id) => apiRequest<void>(`/api/books/${id}`, { method: 'DELETE' })))
                            );
                            const failed = results.filter((r) => r.status === 'rejected').length;
                            const success = results.length - failed;
                            setMessage(failed === 0
                              ? t('toast.deletedAll', { n: success, s: success === 1 ? '' : 's' })
                              : t('toast.deletedMixed', { success, failed }));
                            setSelectedBookIds([]);
                            await Promise.all([loadBooks(), loadRoomSummary(), loadCategories(), loadStats()]);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >{t('common.delete')}</button>
                    </div>
                  </div>
                )}

                {/* Book Grid */}
                <div className="card">
                  {isLoadingBooks && books.length === 0 ? (
                    <BookCardSkeleton count={6} />
                  ) : books.length === 0 ? (
                    <div className="empty-state">
                      <p style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📚</p>
                      <p style={{ fontWeight: 600 }}>{t('library.empty.title')}</p>
                      <p className="muted small">
                        {q || categoryFilter || needsReviewFilter || status || filterLanguage || filterYear || shelfFilter
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
                              className={`${density === 'compact' ? 'book-row' : 'book-card'}${isSelected ? ' is-selected' : ''}`}
                              onClick={() => openBookDetail(book)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => e.key === 'Enter' && openBookDetail(book)}
                            >
                              <input
                                type="checkbox"
                                className="book-select"
                                checked={isSelected}
                                onChange={(e) => { e.stopPropagation(); toggleBookSelection(book.id); }}
                                onClick={(e) => e.stopPropagation()}
                                aria-label={t('library.book.selectAria', { title: displayTitle(book) })}
                                style={canWrite ? undefined : { display: 'none' }}
                              />
                              {book.coverUrl ? (
                                <img
                                  className="book-avatar book-cover"
                                  src={joinApiUrl(book.coverUrl)}
                                  alt={`Cover of ${displayTitle(book)}`}
                                  loading="lazy"
                                  decoding="async"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                />
                              ) : (
                                <div className="book-avatar" aria-hidden="true">
                                  {(displayTitle(book).charAt(0) || '?').toUpperCase()}
                                </div>
                              )}
                              <div className="book-card-body">
                                <span className={`book-card-title${isPlaceholder(book.title, 'title') || !book.title ? ' is-placeholder' : ''}`}>
                                  {q ? highlight(displayTitle(book), q) : displayTitle(book)}
                                </span>
                                <p className={`book-card-author${isPlaceholder(book.author, 'author') || !book.author ? ' is-placeholder' : ''}`}>
                                  {q ? highlight(displayAuthor(book), q) : displayAuthor(book)}
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
                        <div key={loan.id} className={`loan-item${loan.isOverdue ? ' overdue' : ''}`}>
                          <div className="loan-item-info">
                            <strong>{loan.title}</strong>
                            <p className="meta">
                              {t('loans.borrowedBy', { name: loan.borrowerName })}
                              {loan.borrowerContact ? ` · ${loan.borrowerContact}` : ''}
                            </p>
                            <p className="meta">
                              {t('loans.due', { date: new Date(loan.dueAt).toLocaleDateString() })}
                              {loan.isOverdue && <span className="overdue-tag"> · {t('loans.overdueTag')}</span>}
                            </p>
                          </div>
                          <button className="secondary small" onClick={() => void quickReturnByBookId(loan.bookId, loan.title)}>
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
                        <p style={{ fontWeight: 600 }}>{selectedBook.title}</p>
                        <p className="muted small">{selectedBook.author}</p>
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
                              if (v.trim().length >= 2) void searchBorrowers(v);
                              else setBorrowerSuggestions([]);
                            }}
                            onFocus={() => { if (!borrowerSuggestions.length) void searchBorrowers(borrowerQuery); }}
                            placeholder={t('loans.borrowerPh')}
                            required
                            autoComplete="off"
                          />
                          {borrowerSuggestions.length > 0 && !selectedBorrowerId && (
                            <ul className="combobox-list" role="listbox">
                              {borrowerSuggestions.map((b) => (
                                <li
                                  key={b.id}
                                  role="option"
                                  aria-selected={selectedBorrowerId === b.id}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setSelectedBorrowerId(b.id);
                                    setBorrowerName(b.name);
                                    setBorrowerContact(b.contact ?? '');
                                    setBorrowerQuery('');
                                    setBorrowerSuggestions([]);
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
                          value={dueAt ? new Date(dueAt).toISOString().slice(0, 10) : ''}
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

                <div className="card">
                  <h3>{t('import.exportHeading')}</h3>
                  <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
                    {t('import.exportIntro')}
                  </p>
                  <button className="secondary" onClick={exportCsv}>{t('import.downloadCsv')}</button>
                </div>

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

                {/* Custom field manager */}
                <div className="card">
                  <h3>{t('settings.customAttrs', { n: customFields.length })}</h3>
                  <p className="muted small" style={{ marginBottom: '1rem' }}>
                    {t('settings.customIntro')}
                  </p>

                  {customFields.length > 0 && (
                    <div className="cf-list">
                      {customFields.map((f) => (
                        <div key={f.id} className="cf-row">
                          <div className="cf-row-text">
                            <strong>{f.label}</strong>
                            <span className="muted small">
                              <code>{f.key}</code> · {f.type}{f.required ? ` ${t('settings.requiredSuffix')}` : ''}
                              {f.type === 'enum' && f.enumOptions.length > 0 ? ` ${t('settings.optionsSuffix', { n: f.enumOptions.length })}` : ''}
                            </span>
                          </div>
                          {currentUser?.role === 'admin' && (
                            <div className="cf-row-actions">
                              <button className="secondary small" onClick={() => beginCustomFieldEdit(f)}>{t('common.edit')}</button>
                              <button className="danger small" onClick={() => void deleteCustomField(f)}>{t('common.delete')}</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {currentUser?.role === 'admin' && (
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
                            "{group[0].title}" — {group[0].author}
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
