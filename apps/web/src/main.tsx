import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import * as XLSX from 'xlsx';
import './styles.css';

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
};

type Room = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
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

type AppSection = 'books' | 'circulation' | 'import';

type DuplicateEntry = { id: string; title: string; author: string; isbn: string | null };
type DuplicateGroup = DuplicateEntry[];

const RAW_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8787';
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');
const LOCAL_STORAGE_KEY = 'ok-library-web-state-v1';
const IMPORT_CHUNK_SIZE = 500;
const IMPORT_MIN_CHUNK_SIZE = 1;

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
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string; role: string } | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [currentSection, setCurrentSection] = useState<AppSection>('books');

  const [books, setBooks] = useState<Book[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalBooksCount, setTotalBooksCount] = useState(0);

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [roomCode, setRoomCode] = useState('');

  const [createForm, setCreateForm] = useState({
    title: '',
    author: '',
    isbn: '',
    roomCode: '',
    shelfCode: '',
    publicationYear: '',
    customFieldsJson: '{}'
  });

  const [editForm, setEditForm] = useState({
    id: '',
    title: '',
    author: '',
    isbn: '',
    roomCode: '',
    shelfCode: '',
    publicationYear: '',
    status: 'available' as BookStatus,
    version: 0,
    customFieldsJson: '{}'
  });

  const [roomForm, setRoomForm] = useState({ code: '', name: '', description: '' });
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
  const [bookQuickFilter, setBookQuickFilter] = useState<'all' | 'available' | 'borrowed' | 'overdue' | 'missingLocation'>('all');
  const [loanFilter, setLoanFilter] = useState<'all' | 'overdue' | 'dueSoon'>('all');
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [showDuplicatesPanel, setShowDuplicatesPanel] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateEntry[]>([]);

  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [didBootstrapData, setDidBootstrapData] = useState(false);

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

  const totalBooks = books.length;
  const availableBooks = books.filter((book) => book.status === 'available').length;
  const borrowedBooks = books.filter((book) => book.status === 'borrowed').length;
  const overdueCount = activeBorrows.filter((item) => item.isOverdue).length;
  const dueSoonCount = activeBorrows.filter((item) => {
    if (item.isOverdue) {
      return false;
    }
    const diffMs = new Date(item.dueAt).getTime() - Date.now();
    return diffMs > 0 && diffMs <= 48 * 60 * 60 * 1000;
  }).length;
  const booksWithShelf = books.filter((book) => Boolean(book.roomCode && book.shelfCode)).length;
  const booksWithIsbn = books.filter((book) => Boolean(book.isbn && String(book.isbn).trim())).length;
  const catalogCompleteness = totalBooks > 0 ? Math.round((booksWithIsbn / totalBooks) * 100) : 0;
  const locationCompleteness = totalBooks > 0 ? Math.round((booksWithShelf / totalBooks) * 100) : 0;

  const sectionMeta: Array<{ key: AppSection; label: string }> = [
    { key: 'books', label: 'Library' },
    { key: 'circulation', label: 'Loans' },
    { key: 'import', label: 'Import' }
  ];

  const overdueBorrowedBookIds = useMemo(
    () => new Set(activeBorrows.filter((item) => item.isOverdue).map((item) => item.bookId)),
    [activeBorrows]
  );

  const dueSoonBorrowBookIds = useMemo(
    () =>
      new Set(
        activeBorrows
          .filter((item) => {
            if (item.isOverdue) {
              return false;
            }
            const diffMs = new Date(item.dueAt).getTime() - Date.now();
            return diffMs > 0 && diffMs <= 48 * 60 * 60 * 1000;
          })
          .map((item) => item.bookId)
      ),
    [activeBorrows]
  );

  const visibleBooks = useMemo(() => {
    if (bookQuickFilter === 'all') {
      return books;
    }

    if (bookQuickFilter === 'available') {
      return books.filter((book) => book.status === 'available');
    }

    if (bookQuickFilter === 'borrowed') {
      return books.filter((book) => book.status === 'borrowed');
    }

    if (bookQuickFilter === 'overdue') {
      return books.filter((book) => overdueBorrowedBookIds.has(book.id));
    }

    return books.filter((book) => !book.roomCode || !book.shelfCode);
  }, [bookQuickFilter, books, overdueBorrowedBookIds]);

  const visibleActiveBorrows = useMemo(() => {
    if (loanFilter === 'all') {
      return activeBorrows;
    }

    if (loanFilter === 'overdue') {
      return activeBorrows.filter((item) => item.isOverdue);
    }

    return activeBorrows.filter((item) => dueSoonBorrowBookIds.has(item.bookId));
  }, [activeBorrows, dueSoonBorrowBookIds, loanFilter]);

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

  function parseJsonObject(text: string, fieldLabel: string): Record<string, unknown> {
    const value = JSON.parse(text || '{}') as unknown;
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error(`${fieldLabel} must be a JSON object (example: {}).`);
    }

    return value as Record<string, unknown>;
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
      loadRooms(),
      loadRoomSummary(),
      loadCustomFields(),
      loadActiveBorrows(),
      loadAuditLogs()
    ]);
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
    setRooms([]);
    setCustomFields([]);
    setActiveBorrows([]);
    setAuditItems([]);
    setBookHistory([]);
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

  async function loadBooks(pageOverride?: number) {
    try {
      const page = pageOverride ?? currentPage;
      const query = new URLSearchParams();
      if (q) query.set('q', q);
      if (status) query.set('status', status);
      if (roomCode) query.set('roomCode', roomCode);
      query.set('sortBy', 'updatedAt');
      query.set('sortDir', 'desc');
      query.set('page', page.toString());
      query.set('pageSize', '50');

      const response = await apiRequest<{ items: Book[]; total: number }>(`/api/books?${query.toString()}`);
      setBooks(response.items);
      setTotalBooksCount(response.total);
      setCurrentPage(page);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadRooms() {
    try {
      const response = await apiRequest<{ items: Room[] }>('/api/rooms');
      setRooms(response.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }

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
      const customFieldsValue = parseJsonObject(createForm.customFieldsJson, 'Advanced custom fields');
      const publicationYear = parsePublicationYear(createForm.publicationYear);
      const result = await runAction(() => apiRequest<{ id: string; duplicateOf?: DuplicateEntry[] }>('/api/books', {
        method: 'POST',
        body: JSON.stringify({
          title: createForm.title.trim(),
          author: createForm.author.trim(),
          isbn: createForm.isbn.trim() || null,
          roomCode: createForm.roomCode.trim() || null,
          shelfCode: createForm.shelfCode.trim() || null,
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
        roomCode: '',
        shelfCode: '',
        publicationYear: '',
        customFieldsJson: '{}'
      });
      setShowAddBook(false);

      if (result.duplicateOf && result.duplicateOf.length > 0) {
        setDuplicateWarning(result.duplicateOf);
        setMessage('Book added. ⚠️ Possible duplicates detected — see warning below.');
      } else {
        setMessage('Book added successfully.');
      }

      await Promise.all([loadBooks(), loadRoomSummary()]);
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
      roomCode: book.roomCode ?? '',
      shelfCode: book.shelfCode ?? '',
      publicationYear: book.publicationYear?.toString() ?? '',
      status: book.status,
      version: book.version,
      customFieldsJson: JSON.stringify(book.customFields ?? {}, null, 2)
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

  function updateAttributeEditorValue(key: string, value: unknown) {
    setAttributeEditorValues((prev) => ({ ...prev, [key]: value }));
  }

  async function saveBookAttributes() {
    if (!editForm.id) return;
    clearStatus();

    try {
      const typedValues: Record<string, unknown> = {};
      const requiredMissing: string[] = [];
      for (const field of customFields) {
        const raw = attributeEditorValues[field.key];
        const missing = raw === undefined || raw === null || raw === '';
        if (missing) {
          if (field.required) {
            requiredMissing.push(field.label);
          }
          continue;
        }

        if (field.type === 'number') {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) {
            throw new Error(`${field.label} must be a valid number.`);
          }
          typedValues[field.key] = parsed;
          continue;
        }

        if (field.type === 'boolean') {
          typedValues[field.key] = raw === true || raw === 'true';
          continue;
        }

        if (field.type === 'date') {
          const parsedDate = new Date(String(raw));
          if (Number.isNaN(parsedDate.getTime())) {
            throw new Error(`${field.label} must be a valid date.`);
          }
          typedValues[field.key] = parsedDate.toISOString();
          continue;
        }

        typedValues[field.key] = String(raw);
      }

      if (requiredMissing.length > 0) {
        throw new Error(`Please fill required attributes: ${requiredMissing.join(', ')}`);
      }

      await runAction(() => apiRequest<{ bookId: string }>(`/api/books/${editForm.id}/attributes`, {
        method: 'PUT',
        body: JSON.stringify({ values: typedValues })
      }));

      setMessage('Book attributes saved.');
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveBookEdit(event: FormEvent) {
    event.preventDefault();
    if (!editForm.id) return;
    clearStatus();

    try {
      const customFieldsValue = parseJsonObject(editForm.customFieldsJson, 'Advanced custom fields');
      const publicationYear = parsePublicationYear(editForm.publicationYear);
      const result = await runAction(() => apiRequest<{ id: string; version: number }>(`/api/books/${editForm.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: editForm.title.trim(),
          author: editForm.author.trim(),
          isbn: editForm.isbn.trim() || null,
          roomCode: editForm.roomCode.trim() || null,
          shelfCode: editForm.shelfCode.trim() || null,
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
              roomCode: editForm.roomCode.trim() || null,
              shelfCode: editForm.shelfCode.trim() || null,
              status: editForm.status,
              version: result.version,
            }
          : prev
      );
      setDetailMode('view');
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteBook(book: Book) {
    if (!window.confirm(`Delete "${book.title}"? This action cannot be undone.`)) {
      return;
    }

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
      await runAction(() => apiRequest(`/api/books/${book.id}/borrow`, {
        method: 'POST',
        body: JSON.stringify({
          borrowerName,
          borrowerContact: borrowerContact || null,
          dueAt,
          notes: null
        })
      }));

      setMessage(`Book borrowed: ${book.title}`);
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

  function selectVisibleBooks() {
    setSelectedBookIds(visibleBooks.map((book) => book.id));
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
      if (visibleBooks.length === 0) {
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
      for (const book of visibleBooks) {
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
      setMessage(`Filtered CSV downloaded (${visibleBooks.length} books).`);
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

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    try {
      await runAction(() => apiRequest<{ id: string }>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          code: roomForm.code.trim(),
          name: roomForm.name.trim(),
          description: roomForm.description.trim() || null,
          mapMetadata: {}
        })
      }));
      setRoomForm({ code: '', name: '', description: '' });
      await Promise.all([loadRooms(), loadRoomSummary()]);
      setMessage('Room added.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteRoom(room: Room) {
    if (!window.confirm(`Delete room "${room.code}"?`)) {
      return;
    }

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(`/api/rooms/${room.id}`, { method: 'DELETE' }));
      await Promise.all([loadRooms(), loadRoomSummary()]);
      setMessage(`Room deleted: ${room.code}`);
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
    if (!window.confirm(`Delete custom field "${field.key}"?`)) {
      return;
    }

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

      const unknownColumns = findUnknownSpreadsheetColumns(rawRows);
      if (unknownColumns.length > 0) {
        const listed = unknownColumns.slice(0, 12).join(', ');
        const extra = unknownColumns.length > 12 ? `, and ${unknownColumns.length - 12} more` : '';
        const proceed = window.confirm(
          `Your file has columns not mapped to the current database: ${listed}${extra}.\n\n` +
            'Click OK to exclude these columns and continue import.\n' +
            'Click Cancel to stop and create matching custom attributes first (or remove those columns from the file).'
        );

        if (!proceed) {
          setError(
            'Import canceled. Create matching custom attributes in Rooms & Fields, or remove unsupported columns, then try again.'
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

  function startEditFromDetail() {
    if (!detailBook) return;
    setDetailMode('edit');
    setEditForm({
      id: detailBook.id,
      title: detailBook.title,
      author: detailBook.author,
      isbn: detailBook.isbn ?? '',
      roomCode: detailBook.roomCode ?? '',
      shelfCode: detailBook.shelfCode ?? '',
      publicationYear: detailBook.publicationYear?.toString() ?? '',
      status: detailBook.status,
      version: detailBook.version,
      customFieldsJson: JSON.stringify(detailBook.customFields ?? {}, null, 2)
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
              <div className="modal-avatar">{detailBook.title.charAt(0).toUpperCase()}</div>
              <div className="modal-title-block">
                <h2>{detailBook.title}</h2>
                <p className="modal-author">{detailBook.author}</p>
                <span className={`status-badge status-${detailBook.status}`}>{detailBook.status}</span>
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
                      <label>Room Code</label>
                      <input value={editForm.roomCode} onChange={(e) => setEditForm({ ...editForm, roomCode: e.target.value })} placeholder="e.g. A1" />
                    </div>
                    <div>
                      <label>Shelf Code</label>
                      <input value={editForm.shelfCode} onChange={(e) => setEditForm({ ...editForm, shelfCode: e.target.value })} placeholder="e.g. Shelf-3" />
                    </div>
                  </div>
                  <div className="form-field">
                    <label>Status</label>
                    <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value as BookStatus })}>
                      <option value="available">Available</option>
                      <option value="borrowed">Borrowed</option>
                      <option value="lost">Lost</option>
                      <option value="maintenance">Maintenance</option>
                    </select>
                  </div>
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
                {section.label}
              </button>
            ))}
          </div>

          <div className="simple-content">

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
                    <button className="secondary small" onClick={() => void checkDuplicates()}>Check Duplicates</button>
                    {currentUser?.role === 'admin' && (
                      <button className="secondary small" onClick={() => void normalizeAllBooks()}>Normalize All</button>
                    )}
                    <button className="secondary small" onClick={exportFilteredBooksCsv}>Export CSV</button>
                  </div>
                </div>

                {/* Stats */}
                <div className="stats-row">
                  <div className="stat-box accent">
                    <span className="stat-box-label">Total Books</span>
                    <span className="stat-box-value">{totalBooksCount.toLocaleString()}</span>
                  </div>
                  <div className="stat-box success">
                    <span className="stat-box-label">Available</span>
                    <span className="stat-box-value">{availableBooks}</span>
                  </div>
                  <div className="stat-box warning">
                    <span className="stat-box-label">Borrowed</span>
                    <span className="stat-box-value">{borrowedBooks}</span>
                  </div>
                  <div className="stat-box danger">
                    <span className="stat-box-label">Overdue</span>
                    <span className="stat-box-value">{overdueCount}</span>
                  </div>
                </div>

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
                          <label>Room Code</label>
                          <input value={createForm.roomCode} onChange={(e) => setCreateForm({ ...createForm, roomCode: e.target.value })} placeholder="e.g. A1" />
                        </div>
                        <div>
                          <label>Shelf Code</label>
                          <input value={createForm.shelfCode} onChange={(e) => setCreateForm({ ...createForm, shelfCode: e.target.value })} placeholder="e.g. Shelf-3" />
                        </div>
                      </div>
                      <div className="button-group">
                        <button type="submit" className="primary">Add Book</button>
                        <button type="button" className="secondary" onClick={() => setShowAddBook(false)}>Cancel</button>
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

                {/* Duplicates panel */}
                {showDuplicatesPanel && duplicateGroups.length > 0 && (
                  <div className="card" style={{ borderLeft: '3px solid var(--warning, #f59e0b)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <strong>⚠️ Duplicate Books Found ({duplicateGroups.length} group{duplicateGroups.length !== 1 ? 's' : ''})</strong>
                      <button className="secondary small" onClick={() => setShowDuplicatesPanel(false)}>Close</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {duplicateGroups.map((group, i) => (
                        <div key={i} style={{ background: 'var(--bg-muted, #f9fafb)', borderRadius: '6px', padding: '0.75rem' }}>
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

                {/* Search & Filter */}
                <div className="card">
                  <div className="search-bar">
                    <div className="search-field">
                      <label>Search</label>
                      <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Title, author, or ISBN…"
                        onKeyDown={(e) => { if (e.key === 'Enter') { setCurrentPage(1); void loadBooks(1); } }}
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
                      <label>Room</label>
                      <input value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="Room code" />
                    </div>
                    <div className="search-actions">
                      <label>.</label>
                      <button className="primary" onClick={() => { setCurrentPage(1); void loadBooks(1); }}>Search</button>
                      <button className="secondary" onClick={() => { setQ(''); setStatus(''); setRoomCode(''); setCurrentPage(1); void loadBooks(1); }}>Reset</button>
                    </div>
                  </div>
                </div>

                {/* Book Grid */}
                <div className="card">
                  {books.length === 0 ? (
                    <div className="empty-state">
                      <p style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📚</p>
                      <p style={{ fontWeight: 600 }}>No books found</p>
                      <p className="muted small">Try adjusting your search filters, or add a new book above.</p>
                    </div>
                  ) : (
                    <>
                      <div className="book-grid">
                        {books.map((book) => (
                          <div
                            key={book.id}
                            className="book-card"
                            onClick={() => openBookDetail(book)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && openBookDetail(book)}
                          >
                            <div className="book-avatar">{book.title.charAt(0).toUpperCase()}</div>
                            <div className="book-card-body">
                              <span className="book-card-title">{book.title}</span>
                              <p className="book-card-author">{book.author}</p>
                              <div className="book-card-meta">
                                {book.roomCode && <span className="meta-chip">📍 {book.roomCode}</span>}
                                {book.shelfCode && <span className="meta-chip">{book.shelfCode}</span>}
                                {book.publicationYear && <span className="meta-chip">{book.publicationYear}</span>}
                                {book.isbn && <span className="meta-chip">ISBN</span>}
                              </div>
                            </div>
                            <div className="book-card-status">
                              <span className={`status-badge status-${book.status}`}>{book.status}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="pagination">
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks( currentPage - 1)}
                          disabled={currentPage === 1}
                        >← Previous</button>
                        <span className="pagination-info">
                          Page {currentPage} of {Math.max(1, Math.ceil(totalBooksCount / 50))}
                          {' · '}{totalBooksCount.toLocaleString()} books
                        </span>
                        <button
                          className="secondary small"
                          onClick={() => void loadBooks( currentPage + 1)}
                          disabled={currentPage >= Math.ceil(totalBooksCount / 50)}
                        >Next →</button>
                      </div>
                    </>
                  )}
                </div>
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
                        <div>
                          <label>Borrower Name *</label>
                          <input value={borrowerName} onChange={(e) => setBorrowerName(e.target.value)} placeholder="Full name" required />
                        </div>
                        <div>
                          <label>Contact (optional)</label>
                          <input value={borrowerContact} onChange={(e) => setBorrowerContact(e.target.value)} placeholder="Phone or email" />
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
                    Your file must have <strong>Title</strong> and <strong>Author/Writer</strong> columns.
                    All other columns (color, cover type, category, etc.) are automatically imported as book attributes.
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
                    Apply the default book attribute structure to set up your database for imports.
                    This only needs to be done once.
                  </p>
                  <button className="secondary" onClick={applyDefaultBookStructure}>Apply Default Structure</button>
                </div>
              </>
            )}

          </div>
        </>
      )}

      {isWorking && <p className="banner muted">⏳ Working…</p>}
      {error && <p className="banner error">⚠️ {error}</p>}
      {message && <p className="banner success">✓ {message}</p>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
