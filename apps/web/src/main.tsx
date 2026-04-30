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
// because they're used to highlight the active chip.
const SMART_LISTS: SmartList[] = [
  { key: 'missing-isbn',     icon: '🔢', label: 'Missing ISBN',     params: { missingIsbn: '1' } },
  { key: 'missing-shelf',    icon: '📍', label: 'Missing shelf',    params: { missingShelf: '1' } },
  { key: 'untitled',         icon: '⊘',  label: 'Untitled',         params: { untitled: '1' } },
  { key: 'unknown-author',   icon: '?',  label: 'Unknown author',   params: { unknownAuthor: '1' } },
  { key: 'pre-1900',         icon: '🏛', label: 'Before 1900',      params: { yearMax: '1899' } },
  { key: 'post-2000',        icon: '🆕', label: 'From 2000+',       params: { yearMin: '2000' } },
  { key: 'borrowed',         icon: '🔁', label: 'Currently borrowed', params: { status: 'borrowed' } },
  { key: 'recently-added',   icon: '🕒', label: 'Recently added',   params: { sortBy: 'updatedAt', sortDir: 'desc' } }
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
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string; role: string } | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [currentSection, setCurrentSection] = useState<AppSection>('dashboard');
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
  const [filterCategory, setFilterCategory] = useState('');
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
  const [bulkRoomCode, setBulkRoomCode] = useState('');
  const [bulkShelfCode, setBulkShelfCode] = useState('');
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [showDuplicatesPanel, setShowDuplicatesPanel] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateEntry[]>([]);

  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [didBootstrapData, setDidBootstrapData] = useState(false);
  const [isLoadingBooks, setIsLoadingBooks] = useState(false);

  // Bridge legacy message/error state to the toast stack so we don't have to
  // rewrite every set{Message,Error} call site. Effects fire when those states
  // become non-empty, then immediately clear them.
  useEffect(() => {
    if (!message) return;
    toast.push('success', message);
    setMessage('');
  }, [message, toast]);
  useEffect(() => {
    if (!error) return;
    toast.push('error', error);
    setError('');
  }, [error, toast]);

  const loggedIn = Boolean(currentUser);

  // Restore session from HttpOnly cookie on first load
  useEffect(() => {
    apiRequest<SessionResponse>('/api/auth/session')
      .then((res) => setCurrentUser(res.user))
      .catch(() => { /* no session */ })
      .finally(() => setSessionLoading(false));
  }, []);

  // Load app data once an authenticated session is available (fresh login or restored cookie session).
  useEffect(() => {
    if (!loggedIn || didBootstrapData) {
      return;
    }

    void refreshEverything().then(() => {
      setDidBootstrapData(true);
    });
  }, [loggedIn, didBootstrapData]);

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

  const sectionMeta: Array<{ key: AppSection; label: string; icon: string }> = [
    { key: 'dashboard', label: 'Dashboard', icon: '📊' },
    { key: 'books', label: 'Library', icon: '📚' },
    { key: 'circulation', label: 'Loans', icon: '🔁' },
    { key: 'import', label: 'Import/Export', icon: '⇅' },
    { key: 'settings', label: 'Settings', icon: '⚙️' }
  ];

  function clearStatus() {
    setError('');
    setMessage('');
  }

  async function runAction<T>(operation: () => Promise<T>): Promise<T> {
    setIsWorking(true);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setCurrentUser(null);
        setDidBootstrapData(false);
        setError('Session expired. Please sign in again.');
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
      throw new Error(`Please fill required attributes: ${requiredMissing.join(', ')}`);
    }
    return out;
  }

  function parsePublicationYear(raw: string): number | null {
    if (!raw.trim()) {
      return null;
    }

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 3000) {
      throw new Error('Publication year must be an integer between 1000 and 3000.');
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
          throw new Error('customFields column must contain valid JSON object text.');
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
      throw new Error(`Row ${index + 2}: title and writer/author are required.`);
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
      loadCategories(),
      loadNeedsReviewCount(),
      loadStats()
    ]);
  }

  // Borrower autocomplete: debounced server search; result rows let the user pick
  // an existing borrower instead of typing a duplicate name.
  async function searchBorrowers(query: string): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      params.set('limit', '8');
      const response = await apiRequest<{ items: Borrower[] }>(`/api/borrowers?${params.toString()}`);
      setBorrowerSuggestions(response.items ?? []);
    } catch {
      setBorrowerSuggestions([]);
    }
  }

  async function uploadBookCover(book: Book, file: File): Promise<void> {
    clearStatus();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setError('Cover must be JPEG, PNG, WebP, or GIF.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError('Cover image too large (max 4 MB).');
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
      setMessage(`Cover updated for "${book.title}".`);
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
      title: 'Remove cover image?',
      body: 'The book stays — only the photo is deleted.',
      confirmLabel: 'Remove cover',
      danger: true
    });
    if (!ok) return;
    clearStatus();
    try {
      await runAction(() => apiRequest<void>(`/api/books/${book.id}/cover`, { method: 'DELETE' }));
      setMessage('Cover removed.');
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
      await labels.openPrintLabels(targets, API_BASE);
      setMessage(`Opened print preview for ${targets.length} label${targets.length === 1 ? '' : 's'}.`);
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
      setCurrentUser(response.user);
      setDidBootstrapData(false);
      setMessage(`Welcome ${response.user.username}. You're signed in.`);
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
    setBooks([]);
    setCustomFields([]);
    setActiveBorrows([]);
    setAuditItems([]);
    setBookHistory([]);
    setCategories([]);
    setMessage('Signed out.');
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
          `Default structure configured. Added ${result.configuredCustomColumns} columns and skipped ${skippedCount} similar existing columns to avoid duplicates.`
        );
      } else {
        setMessage(`Default structure configured. Added ${result.configuredCustomColumns} columns.`);
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
      if (filterCategory) query.set('custom_category', filterCategory);
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
    status, filterLanguage, filterYear, filterCategory, categoryFilter, needsReviewFilter,
    shelfFilter, sortBy, sortDir, smartListKey
  ]);

  // Debounced auto-search: any change to query/filters/sort re-fetches books on page 1.
  useEffect(() => {
    if (!loggedIn || !didBootstrapData) return;
    const signature = JSON.stringify({
      q, qExclude, qMode, partialWords, fuzzyTypos, searchFields,
      status, filterLanguage, filterYear, filterCategory, categoryFilter, needsReviewFilter,
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
    status, filterLanguage, filterYear, filterCategory, categoryFilter, needsReviewFilter,
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
        setMessage('Book added. ⚠️ Possible duplicates detected — see warning below.');
      } else {
        setMessage('Book added successfully.');
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
        setMessage('No duplicate books found.');
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

      setMessage(`Normalization complete. ${totalUpdated} of ${totalBooks} books were updated.`);
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

    try {
      const response = await apiRequest<{ bookId: string; items: BorrowHistoryItem[] }>(
        `/api/books/${bookId}/history?limit=20`
      );
      setBookHistory(response.items ?? []);
    } catch {
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
      setMessage('Book updated successfully.');
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
      title: `Delete "${book.title}"?`,
      body: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(`/api/books/${book.id}`, { method: 'DELETE' }));
      setSelectedBookIds((prev) => prev.filter((id) => id !== book.id));
      setMessage(`Removed book: ${book.title}`);
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
      setError('Please enter borrower name and due date.');
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

      setMessage(`Book borrowed: ${book.title}`);
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

      setMessage(`Book returned: ${book.title}`);
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
      setMessage(`Book returned: ${title}`);
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
        setMessage('No overdue loans to return.');
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
        setMessage(`Returned ${success} overdue books, ${failed} failed.`);
      } else {
        setMessage(`Returned all overdue books (${success}).`);
      }

      await Promise.all([loadBooks(), loadActiveBorrows(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function setDueInDays(days: number) {
    const due = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    setDueAt(due);
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
        setMessage(`${type.toUpperCase()} code created and copied: ${response.value}`);
      } catch {
        setMessage(`${type.toUpperCase()} code created: ${response.value}`);
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
        throw new Error('Select at least one book for bulk update.');
      }

      const updates: Record<string, unknown> = {};
      if (bulkStatus) {
        updates.status = bulkStatus;
      }
      if (bulkRoomCode.trim()) {
        updates.roomCode = bulkRoomCode.trim();
      }
      if (bulkShelfCode.trim()) {
        updates.shelfCode = bulkShelfCode.trim();
      }

      if (Object.keys(updates).length === 0) {
        throw new Error('Set at least one bulk value (status, room, or shelf).');
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
        setMessage(`Bulk update done: ${success} updated, ${failed} failed (likely version conflicts).`);
      } else {
        setMessage(`Bulk update complete for ${success} books.`);
      }

      setBulkStatus('');
      setBulkRoomCode('');
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
        throw new Error('No visible books to export.');
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
      setMessage(`Filtered CSV downloaded (${books.length} books).`);
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
        throw new Error('Please enter a QR or barcode value.');
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
      setMessage('CSV downloaded.');
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
        throw new Error('This key is already used by a standard book field. Please choose another key.');
      }

      if (!/^[a-zA-Z0-9_]+$/.test(normalizedKey)) {
        throw new Error('Field key can use only letters, numbers, and underscore.');
      }

      const enumOptions = fieldForm.enumOptionsCsv
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

      const normalizedOptions = Array.from(new Set(enumOptions));

      if (fieldForm.type === 'enum' && normalizedOptions.length === 0) {
        throw new Error('Enum attributes require at least one option.');
      }

      if (fieldForm.type !== 'enum' && normalizedOptions.length > 0) {
        throw new Error('Enum options are only allowed when field type is Enum.');
      }

      const keyConflict = customFields.some((field) => {
        if (editingCustomFieldId && field.id === editingCustomFieldId) {
          return false;
        }
        return field.key.toLowerCase() === normalizedKey.toLowerCase();
      });

      if (keyConflict) {
        throw new Error('A custom attribute with this key already exists.');
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
      setMessage(editingCustomFieldId ? 'Custom attribute updated.' : 'Custom attribute added.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteCustomField(field: CustomField) {
    const ok = await confirm({
      title: `Delete custom field "${field.key}"?`,
      body: 'Books that previously had this attribute will keep the data in their custom_fields JSON, but the field will no longer be editable in the form.',
      confirmLabel: 'Delete field',
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
      setMessage(`Custom field removed: ${field.key}`);
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
        throw new Error('Rows JSON must be an array of objects.');
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
        setMessage(`Dry run complete. Accepted rows: ${result.acceptedRows ?? 0}`);
      } else {
        setMessage(`Import complete. Imported rows: ${result.importedRows ?? 0}`);
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
        `Library catalog ready. ${result.created} new fields added, ${result.updated} kept current (total ${result.total}).`
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
        `${dryRun ? 'Previewing' : 'Importing'} chunk ${chunkNum}/${chunkTotal}: rows ${cursor + 1}–${end} of ${rows.length}…`
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
      setError('Select an .xlsx file first.');
      return;
    }

    setImportFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const XLSX = await loadXlsx();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new Error('The XLSX file does not contain any sheet.');
      }

      const sheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: null,
        raw: false
      });

      if (rawRows.length === 0) {
        throw new Error('The XLSX file has no data rows.');
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
          throw new Error('No catalog rows found in the file.');
        }

        const reviewMatched = catalogRows.filter((r) => r.needsReview).length;
        const noTitle = catalogRows.filter((r) => !r.title).length;
        const noAuthor = catalogRows.filter((r) => !r.author).length;

        if (importDryRun) {
          const result = await importCatalogRows(catalogRows, true);
          setMessage(
            `Catalog dry run complete. ${result.totalAccepted} accepted (` +
            `${result.totalInsert} new, ${result.totalUpdate} would update). ` +
            `Review-flagged: ${reviewMatched}. Empty title: ${noTitle}, empty author: ${noAuthor}. ` +
            `Skipped blank rows: ${blankSkipped}.`
          );
        } else {
          const result = await importCatalogRows(catalogRows, false);
          setMessage(
            `Catalog import complete. ${result.totalInsert} added, ${result.totalUpdate} updated. ` +
            `Review-flagged: ${reviewMatched}. Skipped: ${result.allSkipped.length}.`
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
          title: 'Unmapped columns detected',
          body: `Columns not mapped to the database: ${listed}${extra}. Continue importing without them, or cancel to add the matching custom attributes first?`,
          confirmLabel: 'Continue without those columns',
          cancelLabel: 'Cancel import'
        });

        if (!proceed) {
          setError(
            'Import canceled. Create matching custom attributes in Settings, or remove unsupported columns, then try again.'
          );
          return;
        }

        setMessage(`Continuing import and excluding unsupported columns: ${listed}${extra}`);
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
        throw new Error('No valid rows found to import. Please ensure rows include both Title and Writer/Author.');
      }

      const skippedCount = skippedBlankRows.length + skippedInvalidRows.length;
      const skippedInvalidPreview = skippedInvalidRows.slice(0, 8).join(', ');
      const skippedNote =
        skippedCount > 0
          ? ` Skipped ${skippedCount} row(s) (${skippedBlankRows.length} blank, ${skippedInvalidRows.length} missing title/author${
              skippedInvalidRows.length > 0 ? `; examples: ${skippedInvalidPreview}` : ''
            }).`
          : '';

      if (importDryRun) {
        let chunkSize = IMPORT_CHUNK_SIZE;
        let cursor = 0;
        let totalAccepted = 0;

        while (cursor < rows.length) {
          const end = Math.min(cursor + chunkSize, rows.length);
          const chunk = rows.slice(cursor, end);
          const chunkProgress = `Chunk ${Math.floor(cursor / chunkSize) + 1}`;
          setMessage(`Dry run ${chunkProgress}: rows ${cursor + 1}–${end} of ${rows.length}...`);

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

        setMessage(`XLSX dry run complete. Accepted rows: ${totalAccepted}.${skippedNote}`);
      } else {
        let chunkSize = IMPORT_CHUNK_SIZE;
        let cursor = 0;
        let totalImported = 0;
        const uploadSkippedRows: number[] = [];

        while (cursor < rows.length) {
          const end = Math.min(cursor + chunkSize, rows.length);
          const chunk = rows.slice(cursor, end);
          const chunkProgress = `Chunk ${Math.floor(cursor / chunkSize) + 1}`;
          setMessage(`Importing ${chunkProgress}: rows ${cursor + 1}–${end} of ${rows.length}...`);

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
            ? ` Skipped ${uploadSkippedRows.length} oversized row(s) during upload.`
            : '';

        setMessage(
          `XLSX import complete. Imported ${totalImported} rows.${skippedNote}${uploadSkippedNote}`
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
                    <span className="legacy-id-pill" title="Catalog ID — used to upsert on re-import">{detailBook.legacyId}</span>
                  ) : null}
                </div>
              </div>
              <div className="modal-shelf-block" aria-label={detailBook.shelfCode ? `Shelf ${detailBook.shelfCode}` : 'No shelf assigned'}>
                <span className="modal-shelf-label">SHELF</span>
                <span className={`modal-shelf-value${detailBook.shelfCode ? '' : ' is-empty'}`}>
                  {detailBook.shelfCode || '—'}
                </span>
              </div>
              <button className="modal-close" onClick={closeDetail} title="Close">✕</button>
            </div>

            {/* Action bar */}
            <div className="modal-actions">
              {detailMode === 'view' ? (
                <>
                  <button className="secondary small" onClick={startEditFromDetail}>✏️ Edit</button>
                  {detailBook.status === 'available' && (
                    <button className="primary small" onClick={() => {
                      setSelectedBook(detailBook);
                      setCurrentSection('circulation');
                      closeDetail();
                    }}>📤 Borrow</button>
                  )}
                  {detailBook.status === 'borrowed' && (
                    <button className="secondary small" onClick={() => { void returnBook(detailBook); closeDetail(); }}>
                      📥 Return
                    </button>
                  )}
                  <button className="secondary small" onClick={() => void printLabels([detailBook])}>🖨 Label</button>
                  <button className="danger small" onClick={() => void deleteBook(detailBook)}>🗑 Delete</button>
                </>
              ) : (
                <button className="secondary small" onClick={() => setDetailMode('view')}>← Back to details</button>
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
                        alt={`Cover of ${displayTitle(detailBook)}`}
                        loading="lazy"
                      />
                    ) : (
                      <div className="detail-cover detail-cover-placeholder">
                        <span>No cover</span>
                      </div>
                    )}
                    <div className="cover-actions">
                      <label className="secondary small button-like">
                        {detailBook.coverUrl ? 'Replace cover' : 'Upload cover'}
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
                        <button className="danger small" onClick={() => void deleteBookCover(detailBook)}>Remove</button>
                      )}
                      <span className="muted small">JPEG/PNG/WebP/GIF · max 4 MB</span>
                    </div>
                  </div>

                  {/* Core Info */}
                  <div className="detail-section">
                    <div className="detail-section-title">Book Information</div>
                    <div className="detail-grid">
                      {detailBook.isbn && (
                        <div className="detail-item">
                          <span className="di-label">ISBN</span>
                          <span className="di-value">{detailBook.isbn}</span>
                        </div>
                      )}
                      {detailBook.publicationYear && (
                        <div className="detail-item">
                          <span className="di-label">Year Published</span>
                          <span className="di-value">{detailBook.publicationYear}</span>
                        </div>
                      )}
                      {detailBook.publisher && (
                        <div className="detail-item">
                          <span className="di-label">Publisher</span>
                          <span className="di-value">{detailBook.publisher}</span>
                        </div>
                      )}
                      {detailBook.language && (
                        <div className="detail-item">
                          <span className="di-label">Language</span>
                          <span className="di-value">{detailBook.language}</span>
                        </div>
                      )}
                      {detailBook.roomCode && (
                        <div className="detail-item">
                          <span className="di-label">Room</span>
                          <span className="di-value">{detailBook.roomCode}</span>
                        </div>
                      )}
                      {detailBook.shelfCode && (
                        <div className="detail-item">
                          <span className="di-label">Shelf</span>
                          <span className="di-value">{detailBook.shelfCode}</span>
                        </div>
                      )}
                      <div className="detail-item">
                        <span className="di-label">Status</span>
                        <span className="di-value">
                          <span className={`status-badge status-${detailBook.status}`}>{detailBook.status}</span>
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
                      <div className="detail-section-title">Attributes</div>
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
                    <div className="detail-section-title">Borrow History</div>
                    {bookHistory.length === 0 ? (
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>No borrowing history for this book.</p>
                    ) : (
                      <div className="history-list">
                        {bookHistory.map((h) => (
                          <div key={h.id} className="history-item">
                            <div className="history-item-info">
                              <strong>{h.borrowerName}</strong>
                              <span>
                                {new Date(h.borrowedAt).toLocaleDateString()} →{' '}
                                {h.returnedAt ? new Date(h.returnedAt).toLocaleDateString() : 'Currently active'}
                              </span>
                            </div>
                            {h.wasOverdue && <span className="history-overdue-badge">Overdue</span>}
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
                      <label>Title *</label>
                      <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required />
                    </div>
                    <div>
                      <label>Author *</label>
                      <input value={editForm.author} onChange={(e) => setEditForm({ ...editForm, author: e.target.value })} required />
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>ISBN</label>
                      <input value={editForm.isbn} onChange={(e) => setEditForm({ ...editForm, isbn: e.target.value })} placeholder="e.g. 978-..." />
                    </div>
                    <div>
                      <label>Publication Year</label>
                      <input type="number" value={editForm.publicationYear} onChange={(e) => setEditForm({ ...editForm, publicationYear: e.target.value })} placeholder="e.g. 2020" />
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>Shelf Code</label>
                      <input value={editForm.shelfCode} onChange={(e) => setEditForm({ ...editForm, shelfCode: e.target.value })} placeholder="e.g. 06-005" />
                    </div>
                    <div>
                      <label>Status</label>
                      <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value as BookStatus })}>
                        <option value="available">Available</option>
                        <option value="borrowed">Borrowed</option>
                        <option value="lost">Lost</option>
                        <option value="maintenance">Maintenance</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <div>
                      <label>Publisher</label>
                      <input value={editForm.publisher} onChange={(e) => setEditForm({ ...editForm, publisher: e.target.value })} placeholder="Publisher name" />
                    </div>
                    <div>
                      <label>Language</label>
                      <input value={editForm.language} onChange={(e) => setEditForm({ ...editForm, language: e.target.value })} placeholder="e.g. EL or EL,EN,FR" />
                    </div>
                  </div>
                  <div className="form-field">
                    <label>Description</label>
                    <textarea
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      rows={3}
                    />
                  </div>

                  <details className="custom-fields-section" open>
                    <summary>Catalog attributes ({customFields.length})</summary>
                    {renderCustomFieldsForm(attributeEditorValues, (key, value) =>
                      setAttributeEditorValues((prev) => ({ ...prev, [key]: value }))
                    )}
                  </details>

                  <div className="button-group">
                    <button type="submit" className="primary">Save Changes</button>
                    <button type="button" className="secondary" onClick={() => setDetailMode('view')}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ LOGIN ═══ */}
      {sessionLoading ? (
        <div className="simple-center">
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '1rem' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📚</div>
            <p>Loading…</p>
          </div>
        </div>
      ) : !loggedIn ? (
        <div className="simple-center">
          <div className="simple-card">
            <div className="login-logo">📚</div>
            <h2>OK Library</h2>
            <p className="login-subtitle">Sign in to manage your collection</p>
            <form onSubmit={login} className="simple-form">
              <div>
                <label>Username</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
              </div>
              <div>
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <button type="submit" className="primary">{isWorking ? 'Signing in…' : 'Sign In'}</button>
            </form>
          </div>
        </div>
      ) : (
        <>
          {/* ─── Navbar ─── */}
          <div className="simple-navbar">
            <div className="navbar-brand">
              <div className="navbar-icon">📚</div>
              <h1>OK Library</h1>
            </div>
            <div className="navbar-right">
              <button
                className="theme-toggle"
                onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label="Toggle dark mode"
              >
                {theme === 'dark' ? '☀' : '🌙'}
              </button>
              {currentUser && <span className="navbar-user">{currentUser.username}</span>}
              <button className="secondary small" onClick={logout}>Sign out</button>
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
                    <h2>Dashboard</h2>
                    <p>At-a-glance health of your collection</p>
                  </div>
                  <div className="section-header-actions">
                    <button className="secondary small" onClick={() => void loadStats()}>↻ Refresh</button>
                  </div>
                </div>

                {!stats ? (
                  <div className="card empty-state"><p style={{ fontSize: '2rem' }}>📊</p><p>Loading statistics…</p></div>
                ) : (
                  <>
                    {/* KPI tiles */}
                    <div className="stats-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                      <div className="stat-box accent">
                        <span className="stat-box-label">Total Books</span>
                        <span className="stat-box-value">{fmt(stats.completeness.total)}</span>
                      </div>
                      <div className="stat-box success">
                        <span className="stat-box-label">Available</span>
                        <span className="stat-box-value">
                          {fmt(stats.byStatus.find((s) => s.status === 'available')?.count ?? 0)}
                        </span>
                      </div>
                      <div className="stat-box warning">
                        <span className="stat-box-label">Borrowed</span>
                        <span className="stat-box-value">
                          {fmt(stats.byStatus.find((s) => s.status === 'borrowed')?.count ?? 0)}
                        </span>
                      </div>
                      <div className="stat-box danger">
                        <span className="stat-box-label">Lost / Maint.</span>
                        <span className="stat-box-value">
                          {fmt((stats.byStatus.find((s) => s.status === 'lost')?.count ?? 0)
                            + (stats.byStatus.find((s) => s.status === 'maintenance')?.count ?? 0))}
                        </span>
                      </div>
                    </div>

                    <div className="dashboard-grid">
                      {/* Completeness */}
                      <div className="card">
                        <h3>Catalog Completeness</h3>
                        <div className="completeness-list">
                          {([
                            ['ISBN', stats.completeness.withIsbn],
                            ['Shelf code', stats.completeness.withShelf],
                            ['Publisher', stats.completeness.withPublisher],
                            ['Publication year', stats.completeness.withYear]
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
                            {fmt(stats.completeness.untitled)} untitled · {fmt(stats.completeness.unknownAuthor)} with unknown author
                          </p>
                        )}
                      </div>

                      {/* Languages */}
                      <div className="card">
                        <h3>Top Languages</h3>
                        {stats.byLanguage.length === 0 ? (
                          <p className="muted small">No language data.</p>
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
                        <h3>Publication Year</h3>
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
                        <h3>Top Shelves</h3>
                        {stats.topShelves.length === 0 ? (
                          <p className="muted small">No shelf assignments yet.</p>
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
                        <h3>Recently Updated</h3>
                        {stats.recentlyUpdated.length === 0 ? (
                          <p className="muted small">No recent edits.</p>
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
                                  <strong>{b.title || '(Untitled)'}</strong>
                                  <span className="muted small"> · {b.author || '(Unknown)'}</span>
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
                    <h2>Library</h2>
                    <p>Browse and manage your book collection</p>
                  </div>
                  <div className="section-header-actions">
                    <button className="primary small" onClick={() => setShowAddBook((v) => !v)}>
                      {showAddBook ? '✕ Cancel' : '+ Add Book'}
                    </button>
                    <button className="secondary small" onClick={exportFilteredBooksCsv}>Export CSV</button>
                  </div>
                </div>

                {/* Stats */}
                <div className="stats-row">
                  <div className="stat-box accent">
                    <span className="stat-box-label">Total Books</span>
                    <span className="stat-box-value">{fmt(totalBooksCount)}</span>
                  </div>
                  <div className="stat-box success">
                    <span className="stat-box-label">Available</span>
                    <span className="stat-box-value">{availableBooksDisplay}</span>
                  </div>
                  <div className="stat-box warning">
                    <span className="stat-box-label">Borrowed</span>
                    <span className="stat-box-value">{borrowedBooksDisplay}</span>
                  </div>
                  <div className="stat-box danger">
                    <span className="stat-box-label">Overdue</span>
                    <span className="stat-box-value">{overdueCount}</span>
                  </div>
                </div>

                {/* Quick filter chips: pinned shortcuts that toggle filters without opening Advanced. */}
                <div className="filter-chips">
                  <button
                    type="button"
                    className={`chip${needsReviewFilter ? ' is-active' : ''}`}
                    onClick={() => setNeedsReviewFilter((v) => !v)}
                    title="Books flagged during catalog cleanup"
                  >
                    ⚑ Needs review
                    {needsReviewCount > 0 && <span className="chip-count">{fmt(needsReviewCount)}</span>}
                  </button>
                  {SMART_LISTS.map((list) => {
                    const active = smartListKey === list.key;
                    return (
                      <button
                        key={list.key}
                        type="button"
                        className={`chip${active ? ' is-active' : ''}`}
                        onClick={() => setSmartListKey(active ? '' : list.key)}
                        title={`Smart list: ${list.label}`}
                      >
                        <span className="chip-icon">{list.icon}</span> {list.label}
                        {active && <span className="chip-x">✕</span>}
                      </button>
                    );
                  })}
                  {categoryFilter && (
                    <button
                      type="button"
                      className="chip is-active"
                      onClick={() => setCategoryFilter('')}
                      title="Clear category filter"
                    >
                      📚 Category: {categoryFilter}
                      <span className="chip-x">✕</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="chip ghost"
                    onClick={() => setShowCategoryRail((v) => !v)}
                    title={showCategoryRail ? 'Hide category browser' : 'Show category browser'}
                  >
                    {showCategoryRail ? '◀ Hide categories' : '▶ Show categories'}
                  </button>
                </div>

                <div className={`library-layout${showCategoryRail ? '' : ' no-rail'}`}>
                  {showCategoryRail && (
                    <aside className="category-rail">
                      <div className="category-rail-head">
                        <h3>Categories</h3>
                        <span className="muted small">{categories.length} total</span>
                      </div>
                      <input
                        className="category-rail-search"
                        placeholder="Filter categories…"
                        value={categoryRailQuery}
                        onChange={(e) => setCategoryRailQuery(e.target.value)}
                      />
                      <ul className="category-rail-list">
                        <li
                          className={!categoryFilter ? 'is-active' : ''}
                          onClick={() => setCategoryFilter('')}
                        >
                          <span className="cat-label">All categories</span>
                          <span className="cat-count">{fmt(totalBooksCount)}</span>
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
                            <li
                              key={c.code}
                              className={categoryFilter === c.code ? 'is-active' : ''}
                              onClick={() => setCategoryFilter(c.code)}
                              title={c.label ?? c.code}
                            >
                              <span className="cat-label">
                                <span className="cat-code">{c.code}</span>
                                {c.label ? <span className="cat-text"> {c.label}</span> : null}
                              </span>
                              <span className="cat-count">{fmt(c.count)}</span>
                            </li>
                          ))}
                      </ul>
                    </aside>
                  )}
                  <div className="library-main">

                {/* Add Book (collapsible) */}
                {showAddBook && (
                  <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
                    <h3>Add New Book</h3>
                    <form onSubmit={createBook} className="simple-form">
                      <div className="form-row">
                        <div>
                          <label>Title *</label>
                          <input value={createForm.title} onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })} placeholder="Book title" required />
                        </div>
                        <div>
                          <label>Author *</label>
                          <input value={createForm.author} onChange={(e) => setCreateForm({ ...createForm, author: e.target.value })} placeholder="Author name" required />
                        </div>
                      </div>
                      <div className="form-row">
                        <div>
                          <label>ISBN</label>
                          <input value={createForm.isbn} onChange={(e) => setCreateForm({ ...createForm, isbn: e.target.value })} placeholder="e.g. 978-..." />
                        </div>
                        <div>
                          <label>Publication Year</label>
                          <input type="number" value={createForm.publicationYear} onChange={(e) => setCreateForm({ ...createForm, publicationYear: e.target.value })} placeholder="e.g. 2020" />
                        </div>
                        <div>
                          <label>Shelf Code</label>
                          <input value={createForm.shelfCode} onChange={(e) => setCreateForm({ ...createForm, shelfCode: e.target.value })} placeholder="e.g. 06-005" />
                        </div>
                      </div>
                      <div className="form-row">
                        <div>
                          <label>Publisher</label>
                          <input value={createForm.publisher} onChange={(e) => setCreateForm({ ...createForm, publisher: e.target.value })} placeholder="Publisher name" />
                        </div>
                        <div>
                          <label>Language</label>
                          <input value={createForm.language} onChange={(e) => setCreateForm({ ...createForm, language: e.target.value })} placeholder="e.g. EL or EL,EN,FR" />
                        </div>
                      </div>
                      <div className="form-field">
                        <label>Description</label>
                        <textarea
                          value={createForm.description}
                          onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                          rows={2}
                          placeholder="Optional notes about this book"
                        />
                      </div>

                      <details className="custom-fields-section" open={customFields.length > 0 && customFields.length <= 6}>
                        <summary>Catalog attributes ({customFields.length})</summary>
                        {renderCustomFieldsForm(createAttrValues, (key, value) =>
                          setCreateAttrValues((prev) => ({ ...prev, [key]: value }))
                        )}
                      </details>

                      <div className="button-group">
                        <button type="submit" className="primary">Add Book</button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setShowAddBook(false);
                            setCreateAttrValues({});
                          }}
                        >Cancel</button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Duplicate warning after creating a book */}
                {duplicateWarning.length > 0 && (
                  <div className="card" style={{ borderLeft: '3px solid var(--warning, #f59e0b)', background: 'var(--bg-warning, #fffbeb)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <strong>⚠️ Possible Duplicate Detected</strong>
                        <p style={{ marginTop: '0.4rem', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                          The book you just added matches existing entries:
                        </p>
                        <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.875rem' }}>
                          {duplicateWarning.map((d) => (
                            <li key={d.id}><em>{d.title}</em> — {d.author}{d.isbn ? ` (ISBN: ${d.isbn})` : ''}</li>
                          ))}
                        </ul>
                      </div>
                      <button className="secondary small" onClick={() => setDuplicateWarning([])}>Dismiss</button>
                    </div>
                  </div>
                )}

                {/* Search & Filter */}
                <div className="card">
                  <div className="search-bar">
                    <div className="search-field">
                      <label>
                        Search <span className="kbd-hint">press <kbd>/</kbd></span>
                      </label>
                      <input
                        ref={searchInputRef}
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Smart search · forgives typos & accents — try Greek, English, ISBN…"
                      />
                    </div>
                    <div className="filter-field">
                      <label>Status</label>
                      <select value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">All statuses</option>
                        <option value="available">Available</option>
                        <option value="borrowed">Borrowed</option>
                        <option value="lost">Lost</option>
                        <option value="maintenance">Maintenance</option>
                      </select>
                    </div>
                    <div className="filter-field">
                      <label>Shelf</label>
                      <input value={shelfFilter} onChange={(e) => setShelfFilter(e.target.value)} placeholder="Shelf code" />
                    </div>
                    <div className="filter-field">
                      <label>Language</label>
                      <input value={filterLanguage} onChange={(e) => setFilterLanguage(e.target.value)} placeholder="e.g. English" />
                    </div>
                    <div className="filter-field">
                      <label>Category</label>
                      <input value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} placeholder="e.g. Theology" />
                    </div>
                    <div className="filter-field">
                      <label>Year</label>
                      <input type="number" value={filterYear} onChange={(e) => setFilterYear(e.target.value)} placeholder="e.g. 2024" />
                    </div>
                    <div className="filter-field">
                      <label>Sort</label>
                      <div className="sort-row">
                        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                          <option value="updatedAt">Last updated</option>
                          <option value="title">Title</option>
                          <option value="author">Author</option>
                          <option value="publicationYear">Year</option>
                          <option value="status">Status</option>
                        </select>
                        <button
                          type="button"
                          className="secondary small sort-dir-btn"
                          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                          title={sortDir === 'asc' ? 'Ascending — click to toggle' : 'Descending — click to toggle'}
                          aria-label="Toggle sort direction"
                        >
                          {sortDir === 'asc' ? '↑' : '↓'}
                        </button>
                      </div>
                    </div>
                    <div className="search-actions">
                      <label>.</label>
                      <button className="secondary" onClick={() => { setShowAdvancedSearch((v) => !v); }}>
                        {showAdvancedSearch ? 'Hide Advanced' : 'Advanced'}
                      </button>
                      <button
                        className="secondary"
                        onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
                        title="Toggle layout density"
                      >
                        {density === 'compact' ? '⊞ Cards' : '☰ List'}
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
                        setFilterCategory('');
                        setFilterYear('');
                        setShelfFilter('');
                        setCategoryFilter('');
                        setNeedsReviewFilter(false);
                        setSmartListKey('');
                        setCurrentPage(1);
                      }}>Reset</button>
                    </div>
                  </div>

                  {showAdvancedSearch && (
                    <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                      <div className="form-row">
                        <div>
                          <label>Exclude Terms</label>
                          <input
                            value={qExclude}
                            onChange={(e) => setQExclude(e.target.value)}
                            placeholder="Words/phrases to exclude"
                          />
                        </div>
                        <div>
                          <label>Match Mode</label>
                          <select value={qMode} onChange={(e) => setQMode(e.target.value as SearchMode)}>
                            <option value="all">All terms (AND)</option>
                            <option value="any">Any term (OR)</option>
                            <option value="exact">Exact phrase</option>
                          </select>
                        </div>
                        <div>
                          <label>Partial Word Matching</label>
                          <select value={partialWords ? 'yes' : 'no'} onChange={(e) => setPartialWords(e.target.value === 'yes')}>
                            <option value="yes">Yes (contains text)</option>
                            <option value="no">No (exact token)</option>
                          </select>
                        </div>
                        <div>
                          <label>Fuzzy Typos</label>
                          <select value={fuzzyTypos ? 'on' : 'off'} onChange={(e) => setFuzzyTypos(e.target.value === 'on')}>
                            <option value="on">On (tolerate typos)</option>
                            <option value="off">Off (strict matching)</option>
                          </select>
                        </div>
                      </div>

                      <label style={{ marginTop: '0.5rem' }}>Search In Fields</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.35rem' }}>
                        {([
                          ['title', 'Title'],
                          ['author', 'Author'],
                          ['isbn', 'ISBN'],
                          ['publisher', 'Publisher'],
                          ['language', 'Language'],
                          ['description', 'Description'],
                          ['shelfCode', 'Shelf'],
                          ['tags', 'Tags'],
                          ['custom', 'Custom Fields']
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
                {selectedBookIds.length > 0 && (
                  <div className="bulk-bar" role="region" aria-label="Bulk actions">
                    <div className="bulk-bar-info">
                      <strong>{selectedBookIds.length}</strong>
                      <span className="muted small">selected on this page</span>
                      <button className="link-btn" onClick={selectAllOnPage}>Select all visible ({books.length})</button>
                      <button className="link-btn" onClick={clearSelectedBooks}>Clear</button>
                    </div>
                    <div className="bulk-bar-actions">
                      <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} aria-label="Set status">
                        <option value="">Set status…</option>
                        <option value="available">Available</option>
                        <option value="borrowed">Borrowed</option>
                        <option value="lost">Lost</option>
                        <option value="maintenance">Maintenance</option>
                      </select>
                      <input
                        value={bulkShelfCode}
                        onChange={(e) => setBulkShelfCode(e.target.value)}
                        placeholder="Set shelf"
                        aria-label="Set shelf code"
                      />
                      <button
                        className="primary small"
                        onClick={() => void applyBulkBookChanges()}
                        disabled={!bulkStatus && !bulkShelfCode.trim() && !bulkRoomCode.trim()}
                      >Apply</button>
                      <button
                        className="secondary small"
                        onClick={() => {
                          const targets = books.filter((b) => selectedBookIds.includes(b.id));
                          void printLabels(targets);
                        }}
                      >🖨 Labels</button>
                      <button
                        className="danger small"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Delete ${selectedBookIds.length} book${selectedBookIds.length === 1 ? '' : 's'}?`,
                            body: 'This soft-deletes them; admins can restore by direct DB edit. Loan history stays.',
                            confirmLabel: 'Delete selected',
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
                              ? `Deleted ${success} book${success === 1 ? '' : 's'}.`
                              : `Deleted ${success}, ${failed} failed.`);
                            setSelectedBookIds([]);
                            await Promise.all([loadBooks(), loadRoomSummary(), loadCategories(), loadStats()]);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >Delete</button>
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
                      <p style={{ fontWeight: 600 }}>No books found</p>
                      <p className="muted small">
                        {q || categoryFilter || needsReviewFilter || status || filterLanguage || filterYear || shelfFilter
                          ? 'No matches for your filters. Try clearing them or broadening the search.'
                          : 'Add a book above, or import a catalog from the Import/Export tab.'}
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
                                aria-label={`Select ${displayTitle(book)}`}
                              />
                              {book.coverUrl ? (
                                <img
                                  className="book-avatar book-cover"
                                  src={joinApiUrl(book.coverUrl)}
                                  alt=""
                                  loading="lazy"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                                />
                              ) : (
                                <div className="book-avatar">{(displayTitle(book).charAt(0) || '?').toUpperCase()}</div>
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
                                  title={book.shelfCode ? `Shelf ${book.shelfCode}` : 'No shelf assigned — click the book to set one'}
                                  aria-label={book.shelfCode ? `Shelf ${book.shelfCode}` : 'No shelf assigned'}
                                >
                                  <span className="shelf-icon" aria-hidden="true">📍</span>
                                  <span className="shelf-value">{book.shelfCode || 'No shelf'}</span>
                                </span>
                                <span className={`status-badge status-${book.status}`}>{book.status}</span>
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
                          title="First page"
                        >« First</button>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(currentPage - 1)}
                          disabled={currentPage === 1}
                        >← Previous</button>
                        <span className="pagination-info">
                          Page <strong>{currentPage}</strong> of <strong>{Math.max(1, Math.ceil(totalBooksCount / PAGE_SIZE))}</strong>
                          <span className="muted small"> · {fmt(totalBooksCount)} books</span>
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
                            placeholder="Jump to…"
                            aria-label="Jump to page"
                          />
                          <button type="submit" className="secondary small">Go</button>
                        </form>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(currentPage + 1)}
                          disabled={currentPage >= Math.ceil(totalBooksCount / PAGE_SIZE)}
                        >Next →</button>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks(Math.max(1, Math.ceil(totalBooksCount / PAGE_SIZE)))}
                          disabled={currentPage >= Math.ceil(totalBooksCount / PAGE_SIZE)}
                          title="Last page"
                        >Last »</button>
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
                    <h2>Loans</h2>
                    <p>Track active borrowing and returns</p>
                  </div>
                </div>

                {/* Loan stats */}
                <div className="stats-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  <div className="stat-box accent">
                    <span className="stat-box-label">Active Loans</span>
                    <span className="stat-box-value">{activeBorrows.length}</span>
                  </div>
                  <div className="stat-box danger">
                    <span className="stat-box-label">Overdue</span>
                    <span className="stat-box-value">{overdueCount}</span>
                  </div>
                  <div className="stat-box warning">
                    <span className="stat-box-label">Due Soon (48h)</span>
                    <span className="stat-box-value">{dueSoonCount}</span>
                  </div>
                </div>

                {/* Active Loans list */}
                <div className="card">
                  <h3>Active Loans ({activeBorrows.length})</h3>
                  {activeBorrows.length === 0 ? (
                    <div className="empty-state" style={{ padding: '1.5rem 0 0.5rem' }}>
                      <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>✅</p>
                      <p style={{ fontWeight: 600 }}>All clear — no active loans</p>
                      <p className="muted small">All books are currently in the library.</p>
                    </div>
                  ) : (
                    <div className="loan-list">
                      {activeBorrows.map((loan) => (
                        <div key={loan.id} className={`loan-item${loan.isOverdue ? ' overdue' : ''}`}>
                          <div className="loan-item-info">
                            <strong>{loan.title}</strong>
                            <p className="meta">
                              Borrowed by <strong>{loan.borrowerName}</strong>
                              {loan.borrowerContact ? ` · ${loan.borrowerContact}` : ''}
                            </p>
                            <p className="meta">
                              Due: {new Date(loan.dueAt).toLocaleDateString()}
                              {loan.isOverdue && <span className="overdue-tag"> · OVERDUE</span>}
                            </p>
                          </div>
                          <button className="secondary small" onClick={() => void quickReturnByBookId(loan.bookId, loan.title)}>
                            Return
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Borrow Form */}
                <div className="card">
                  <h3>Borrow a Book</h3>
                  {selectedBook ? (
                    <form onSubmit={(e) => { e.preventDefault(); void borrowBook(selectedBook); }} className="simple-form">
                      <div style={{ padding: '0.875rem 1rem', background: 'var(--accent-light)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--accent)', marginBottom: '0.25rem' }}>
                        <p style={{ fontWeight: 600 }}>{selectedBook.title}</p>
                        <p className="muted small">{selectedBook.author}</p>
                      </div>
                      <div className="form-row">
                        <div className="combobox">
                          <label>Borrower *</label>
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
                            placeholder="Type to search existing borrowers, or enter a new name"
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
                                    {fmt(b.totalLoans)} loan{b.totalLoans === 1 ? '' : 's'}
                                    {b.overdueLoans > 0 && <span className="overdue-tag"> · {fmt(b.overdueLoans)} overdue</span>}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {selectedBorrowerId && (
                            <p className="muted small">
                              ✓ Using existing borrower profile.{' '}
                              <button
                                type="button"
                                className="link-btn"
                                style={{ color: 'var(--accent)' }}
                                onClick={() => { setSelectedBorrowerId(''); setBorrowerName(''); setBorrowerContact(''); }}
                              >Change</button>
                            </p>
                          )}
                        </div>
                        <div>
                          <label>Contact (optional)</label>
                          <input
                            value={borrowerContact}
                            onChange={(e) => setBorrowerContact(e.target.value)}
                            placeholder="Phone or email"
                            disabled={Boolean(selectedBorrowerId)}
                          />
                        </div>
                      </div>
                      <div className="form-field">
                        <label>Due Date *</label>
                        <input type="date" value={dueAt.split('T')[0]} onChange={(e) => setDueAt(e.target.value + 'T00:00:00.000Z')} required />
                        <div className="button-group" style={{ marginTop: '0.5rem' }}>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(7)}>7 days</button>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(14)}>14 days</button>
                          <button type="button" className="secondary small" onClick={() => setDueInDays(30)}>30 days</button>
                        </div>
                      </div>
                      <div className="button-group">
                        <button type="submit" className="primary">Confirm Borrow</button>
                        <button type="button" className="secondary" onClick={() => setSelectedBook(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <div className="empty-state" style={{ padding: '1.5rem 0 0.5rem' }}>
                      <p style={{ fontSize: '1.75rem', marginBottom: '0.375rem' }}>📖</p>
                      <p style={{ fontWeight: 600 }}>No book selected</p>
                      <p className="muted small">Go to the Library tab, open any available book, and click <strong>Borrow</strong>.</p>
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
                    <h2>Import & Export</h2>
                    <p>Add books from a spreadsheet or download your collection</p>
                  </div>
                </div>

                <div className="card">
                  <h3>📥 Import from Excel (.xlsx)</h3>
                  <p className="muted" style={{ marginBottom: '1.25rem', fontSize: '0.875rem' }}>
                    Drop in your <strong>LIBRARY_normalized.xlsx</strong> (or any compatible catalog file).
                    Catalog-format files are auto-detected and imported via the upsert path — re-running
                    the same file updates existing books in place. Legacy <em>Title/Author</em> spreadsheets are
                    still supported.
                  </p>
                  <form onSubmit={importFromXlsx} className="simple-form">
                    <div className="import-dropzone">
                      <p style={{ fontSize: '2.25rem', marginBottom: '0.5rem' }}>📂</p>
                      <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Choose an Excel file</p>
                      <p className="muted small" style={{ marginBottom: '1rem' }}>Supports .xlsx format</p>
                      <input name="xlsxFile" type="file" accept=".xlsx" required style={{ width: 'auto', display: 'block', margin: '0 auto' }} />
                    </div>
                    {importFileName && (
                      <p className="muted small">📄 Selected: <strong>{importFileName}</strong></p>
                    )}
                    <label className="checkbox-label">
                      <input type="checkbox" checked={importDryRun} onChange={(e) => setImportDryRun(e.target.checked)} />
                      Test only (dry run) — preview results without saving
                    </label>
                    <button type="submit" className="primary">
                      {importDryRun ? '🔍 Test Import' : '📥 Import Books'}
                    </button>
                  </form>
                </div>

                <div className="card">
                  <h3>📤 Export Collection</h3>
                  <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
                    Download your entire library as a CSV file for use in Excel or other tools.
                  </p>
                  <button className="secondary" onClick={exportCsv}>Download Full CSV</button>
                </div>

                <div className="card">
                  <h3>⚙️ Setup</h3>
                  <p className="muted" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
                    Run once before your first import — these create the custom attributes that
                    receive every column in the spreadsheet.
                  </p>
                  <div className="button-group" style={{ marginTop: 0 }}>
                    <button className="primary" onClick={() => void setupLibraryCatalog()}>
                      Set up for LIBRARY_normalized.xlsx
                    </button>
                    <button className="secondary" onClick={applyDefaultBookStructure}>
                      Apply legacy Title/Author preset
                    </button>
                  </div>
                  <p className="muted small" style={{ marginTop: '0.75rem' }}>
                    The catalog preset adds <strong>{CATALOG_FIELD_COUNT}</strong> attributes (series,
                    editor, place_of_publication, category_code, cover_type, copies_count, etc.) so every
                    column from the file lands somewhere safe and searchable.
                  </p>
                </div>
              </>
            )}

            {/* ═══ MAINTAINANCE TAB ═══ */}
            {currentSection === 'settings' && (
              <>
                <div className="section-header">
                  <div className="section-header-text">
                    <h2>Settings</h2>
                    <p>Custom attributes, audit log, and database hygiene tools</p>
                  </div>
                </div>

                {/* Custom field manager */}
                <div className="card">
                  <h3>Custom Attributes ({customFields.length})</h3>
                  <p className="muted small" style={{ marginBottom: '1rem' }}>
                    Fields shown in every book's detail. Editable by admins.
                  </p>

                  {customFields.length > 0 && (
                    <div className="cf-list">
                      {customFields.map((f) => (
                        <div key={f.id} className="cf-row">
                          <div className="cf-row-text">
                            <strong>{f.label}</strong>
                            <span className="muted small">
                              <code>{f.key}</code> · {f.type}{f.required ? ' · required' : ''}
                              {f.type === 'enum' && f.enumOptions.length > 0 ? ` · ${f.enumOptions.length} options` : ''}
                            </span>
                          </div>
                          {currentUser?.role === 'admin' && (
                            <div className="cf-row-actions">
                              <button className="secondary small" onClick={() => beginCustomFieldEdit(f)}>Edit</button>
                              <button className="danger small" onClick={() => void deleteCustomField(f)}>Delete</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {currentUser?.role === 'admin' && (
                    <details className="custom-fields-section" open={Boolean(editingCustomFieldId)} style={{ marginTop: '1rem' }}>
                      <summary>{editingCustomFieldId ? 'Edit attribute' : '+ Add new attribute'}</summary>
                      <form onSubmit={saveCustomField} className="simple-form" style={{ marginTop: '0.75rem' }}>
                        <div className="form-row">
                          <div>
                            <label>Key (snake_case)</label>
                            <input
                              value={fieldForm.key}
                              onChange={(e) => setFieldForm({ ...fieldForm, key: e.target.value })}
                              placeholder="e.g. donor_name"
                              required
                            />
                          </div>
                          <div>
                            <label>Label</label>
                            <input
                              value={fieldForm.label}
                              onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })}
                              placeholder="e.g. Donor name"
                              required
                            />
                          </div>
                        </div>
                        <div className="form-row">
                          <div>
                            <label>Type</label>
                            <select
                              value={fieldForm.type}
                              onChange={(e) => setFieldForm({ ...fieldForm, type: e.target.value as CustomField['type'] })}
                            >
                              <option value="text">Text</option>
                              <option value="number">Number</option>
                              <option value="boolean">Yes/No</option>
                              <option value="date">Date</option>
                              <option value="enum">Enum (dropdown)</option>
                            </select>
                          </div>
                          <div>
                            <label>Required?</label>
                            <select
                              value={fieldForm.required ? 'yes' : 'no'}
                              onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.value === 'yes' })}
                            >
                              <option value="no">No</option>
                              <option value="yes">Yes</option>
                            </select>
                          </div>
                        </div>
                        {fieldForm.type === 'enum' && (
                          <div className="form-field">
                            <label>Enum options (comma-separated)</label>
                            <input
                              value={fieldForm.enumOptionsCsv}
                              onChange={(e) => setFieldForm({ ...fieldForm, enumOptionsCsv: e.target.value })}
                              placeholder="Excellent, Good, Fair, Poor"
                            />
                          </div>
                        )}
                        <div className="button-group">
                          <button type="submit" className="primary">{editingCustomFieldId ? 'Save changes' : 'Add attribute'}</button>
                          {editingCustomFieldId && (
                            <button type="button" className="secondary" onClick={resetCustomFieldForm}>Cancel</button>
                          )}
                        </div>
                      </form>
                    </details>
                  )}
                </div>

                {/* Duplicate checker */}
                <div className="card">
                  <h3>🔎 Duplicate Checker</h3>
                  <p className="muted small" style={{ marginBottom: '1rem' }}>
                    Find books that share the same title + author.
                  </p>
                  <button className="secondary" onClick={() => void checkDuplicates()}>Scan for duplicates</button>
                </div>

                {showDuplicatesPanel && duplicateGroups.length > 0 && (
                  <div className="card" style={{ borderLeft: '3px solid var(--warning)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <strong>⚠️ {duplicateGroups.length} duplicate group{duplicateGroups.length !== 1 ? 's' : ''} found</strong>
                      <button className="secondary small" onClick={() => setShowDuplicatesPanel(false)}>Close</button>
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
                                ID: {entry.id.slice(0, 8)}…{entry.isbn ? ` | ISBN: ${entry.isbn}` : ''}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Audit log */}
                {currentUser?.role === 'admin' && (
                  <div className="card">
                    <h3>📜 Recent Activity (audit log)</h3>
                    {auditItems.length === 0 ? (
                      <p className="muted small">No recent activity yet.</p>
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
                    <h3>🧹 Normalize entries</h3>
                    <p className="muted small" style={{ marginBottom: '1rem' }}>
                      Trim, collapse spaces, and uppercase ISBNs/shelf codes across the entire catalog.
                    </p>
                    <button className="secondary" onClick={() => void normalizeAllBooks()}>Run normalization</button>
                  </div>
                )}

                {/* System info */}
                <div className="card">
                  <h3>System</h3>
                  <ul className="system-info">
                    <li><span>API endpoint</span><code>{API_BASE}</code></li>
                    <li><span>Signed in as</span><code>{currentUser?.username} ({currentUser?.role})</code></li>
                    <li><span>Books loaded</span><code>{fmt(totalBooksCount)}</code></li>
                    <li><span>Catalog field defs</span><code>{customFields.length}</code></li>
                    <li><span>Theme</span><code>{theme}</code></li>
                  </ul>
                </div>
              </>
            )}

          </div>
        </>
      )}

      {isWorking && (
        <div className="working-pill" role="status" aria-live="polite">
          <span className="spinner" /> Working…
        </div>
      )}
    </div>
  );
}

function Root() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
