import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
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
  token: string;
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

type AppSection = 'dashboard' | 'books' | 'circulation' | 'locations' | 'settings';

const RAW_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8787';
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');
const LOCAL_STORAGE_KEY = 'ok-library-web-state-v1';

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

async function apiRequest<T>(
  token: string | null,
  path: string,
  init?: RequestInit,
  raw = false
): Promise<T> {
  const response = await fetch(joinApiUrl(path), {
    ...init,
    headers: {
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(errorBody.error ?? `Request failed with status ${response.status}`);
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

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [currentSection, setCurrentSection] = useState<AppSection>('dashboard');

  const [books, setBooks] = useState<Book[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);

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
  const [bulkStatus, setBulkStatus] = useState<string>('');
  const [bulkRoomCode, setBulkRoomCode] = useState('');
  const [bulkShelfCode, setBulkShelfCode] = useState('');
  const [bookQuickFilter, setBookQuickFilter] = useState<'all' | 'available' | 'borrowed' | 'overdue' | 'missingLocation'>('all');
  const [loanFilter, setLoanFilter] = useState<'all' | 'overdue' | 'dueSoon'>('all');

  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isWorking, setIsWorking] = useState(false);

  const loggedIn = useMemo(() => Boolean(token), [token]);

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

  useEffect(() => {
    if (!message) {
      return;
    }

    const timer = window.setTimeout(() => setMessage(''), 4500);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        q?: string;
        status?: string;
        roomCode?: string;
        borrowerName?: string;
        borrowerContact?: string;
        dueAt?: string;
      };

      if (typeof parsed.q === 'string') setQ(parsed.q);
      if (typeof parsed.status === 'string') setStatus(parsed.status);
      if (typeof parsed.roomCode === 'string') setRoomCode(parsed.roomCode);
      if (typeof parsed.borrowerName === 'string') setBorrowerName(parsed.borrowerName);
      if (typeof parsed.borrowerContact === 'string') setBorrowerContact(parsed.borrowerContact);
      if (typeof parsed.dueAt === 'string') setDueAt(parsed.dueAt);
    } catch {
      // ignore storage parse errors
    }
  }, []);

  useEffect(() => {
    const payload = {
      q,
      status,
      roomCode,
      borrowerName,
      borrowerContact,
      dueAt
    };
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
  }, [q, status, roomCode, borrowerName, borrowerContact, dueAt]);

  async function runAction<T>(operation: () => Promise<T>): Promise<T> {
    setIsWorking(true);
    try {
      return await operation();
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

  async function refreshEverything(tokenOverride?: string) {
    const currentToken = tokenOverride ?? token;
    if (!currentToken) return;
    await Promise.all([
      loadBooks(currentToken),
      loadRooms(currentToken),
      loadRoomSummary(currentToken),
      loadCustomFields(currentToken),
      loadActiveBorrows(currentToken),
      loadAuditLogs(currentToken)
    ]);
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    try {
      const response = await runAction(() => apiRequest<LoginResponse>(null, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      }));
      setToken(response.token);
      setMessage(`Welcome ${response.user.username}. You're signed in.`);
      await runAction(() => refreshEverything(response.token));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadBooks(tokenOverride?: string) {
    const currentToken = tokenOverride ?? token;
    if (!currentToken) return;

    try {
      const query = new URLSearchParams();
      if (q) query.set('q', q);
      if (status) query.set('status', status);
      if (roomCode) query.set('roomCode', roomCode);
      query.set('sortBy', 'updatedAt');
      query.set('sortDir', 'desc');
      query.set('page', '1');
      query.set('pageSize', '100');

      const response = await apiRequest<{ items: Book[] }>(currentToken, `/api/books?${query.toString()}`);
      setBooks(response.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadRooms(tokenOverride?: string) {
    const currentToken = tokenOverride ?? token;
    if (!currentToken) return;

    try {
      const response = await apiRequest<{ items: Room[] }>(currentToken, '/api/rooms');
      setRooms(response.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadCustomFields(tokenOverride?: string) {
    const currentToken = tokenOverride ?? token;
    if (!currentToken) return;

    try {
      const response = await apiRequest<{ items: CustomField[] }>(currentToken, '/api/custom-fields');
      setCustomFields(response.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadRoomSummary(tokenOverride?: string) {
    const currentToken = tokenOverride ?? token;
    if (!currentToken) return;

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
      }>(currentToken, '/api/rooms/summary');
      setRoomSummary(response.items ?? []);
      setUnassignedSummary(response.unassigned);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadActiveBorrows(tokenOverride?: string) {
    const currentToken = tokenOverride ?? token;
    if (!currentToken) return;

    try {
      const response = await apiRequest<{ items: ActiveBorrow[] }>(currentToken, '/api/borrow/active');
      setActiveBorrows(response.items ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadAuditLogs(tokenOverride?: string) {
    const currentToken = tokenOverride ?? token;
    if (!currentToken) return;

    try {
      const response = await apiRequest<{ items: AuditLogItem[] }>(currentToken, '/api/audit-logs?page=1&pageSize=8');
      setAuditItems(response.items ?? []);
    } catch {
      // Non-admin users may not have access to audit logs; keep UI silent.
      setAuditItems([]);
    }
  }

  async function createBook(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    clearStatus();

    try {
      const customFieldsValue = parseJsonObject(createForm.customFieldsJson, 'Advanced custom fields');
      const publicationYear = parsePublicationYear(createForm.publicationYear);
      await runAction(() => apiRequest<{ id: string }>(token, '/api/books', {
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
      setMessage('Book added successfully.');
      await Promise.all([loadBooks(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function beginEdit(book: Book) {
    setSelectedBook(book);
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
    if (!token || !bookId) {
      return;
    }

    try {
      const response = await apiRequest<{ bookId: string; items: BorrowHistoryItem[] }>(
        token,
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
    if (!token || !editForm.id) return;
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

      await runAction(() => apiRequest<{ bookId: string }>(token, `/api/books/${editForm.id}/attributes`, {
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
    if (!token || !editForm.id) return;
    clearStatus();

    try {
      const customFieldsValue = parseJsonObject(editForm.customFieldsJson, 'Advanced custom fields');
      const publicationYear = parsePublicationYear(editForm.publicationYear);
      const result = await runAction(() => apiRequest<{ id: string; version: number }>(token, `/api/books/${editForm.id}`, {
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
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteBook(book: Book) {
    if (!token) return;

    if (!window.confirm(`Delete "${book.title}"? This action cannot be undone.`)) {
      return;
    }

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(token, `/api/books/${book.id}`, { method: 'DELETE' }));
      setSelectedBookIds((prev) => prev.filter((id) => id !== book.id));
      setMessage(`Removed book: ${book.title}`);
      await Promise.all([loadBooks(), loadRoomSummary()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function borrowBook(book: Book) {
    if (!token) return;
    clearStatus();

    if (!borrowerName || !dueAt) {
      setError('Please enter borrower name and due date.');
      return;
    }

    try {
      await runAction(() => apiRequest(token, `/api/books/${book.id}/borrow`, {
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
    if (!token) return;
    clearStatus();

    try {
      await runAction(() => apiRequest(token, `/api/books/${book.id}/return`, {
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
    if (!token) return;
    clearStatus();

    try {
      await runAction(() => apiRequest(token, `/api/books/${bookId}/return`, {
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
    if (!token) return;
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
            apiRequest(token, `/api/books/${item.bookId}/return`, {
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
    if (!token) return;
    clearStatus();

    try {
      const response = await runAction(() => apiRequest<{ value: string }>(token, `/api/books/${book.id}/codes`, {
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
    if (!token) return;
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
            apiRequest<{ id: string; version: number }>(token, `/api/books/${book.id}`, {
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
    if (!token) return;
    clearStatus();
    setScanResult('');

    try {
      const value = scanCode.trim();
      if (!value) {
        throw new Error('Please enter a QR or barcode value.');
      }

      const response = await runAction(() => apiRequest<{ book: Book }>(token, `/api/scan/${encodeURIComponent(value)}`));
      setScanResult(`${response.book.title} by ${response.book.author}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function exportCsv() {
    if (!token) return;
    clearStatus();

    try {
      const csv = await runAction(() => apiRequest<string>(token, '/api/export/books.csv', undefined, true));
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
    if (!token) return;
    clearStatus();

    try {
      await runAction(() => apiRequest<{ id: string }>(token, '/api/rooms', {
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
    if (!token) return;

    if (!window.confirm(`Delete room "${room.code}"?`)) {
      return;
    }

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(token, `/api/rooms/${room.id}`, { method: 'DELETE' }));
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
    if (!token) return;
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

      await runAction(() => apiRequest<{ id: string }>(token, path, {
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
    if (!token) return;

    if (!window.confirm(`Delete custom field "${field.key}"?`)) {
      return;
    }

    clearStatus();

    try {
      await runAction(() => apiRequest<void>(token, `/api/custom-fields/${field.id}`, { method: 'DELETE' }));
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
    if (!token) return;
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
        token,
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

  const emptyState = books.length === 0 ? (
    <div className="empty-state">
      <p>No books yet.</p>
      <p className="muted">Add your first book in the Books section.</p>
    </div>
  ) : null;

  return (
    <div className="app-shell" aria-busy={isWorking}>
      <section className="hero">
        <p className="hero-kicker">Library Assistant</p>
        <h1>Friendly Library Organizer</h1>
        <p>Simple workflows for everyday staff: add books, borrow and return, find locations, and export records.</p>
      </section>

      {!loggedIn ? (
        <section className="panel auth-panel">
          <h2>Sign in</h2>
          <p className="panel-help">Use your staff account to continue.</p>
          <form onSubmit={login} className="grid two">
            <div>
              <label htmlFor="username">Username</label>
              <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div>
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="actions">
              <button className="primary" type="submit">
                {isWorking ? 'Signing In...' : 'Sign In'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <>
          <nav className="tabs" aria-label="Main sections">
            <button
              className={currentSection === 'dashboard' ? 'tab active' : 'tab'}
              onClick={() => setCurrentSection('dashboard')}
            >
              Dashboard
            </button>
            <button className={currentSection === 'books' ? 'tab active' : 'tab'} onClick={() => setCurrentSection('books')}>
              Books
            </button>
            <button
              className={currentSection === 'circulation' ? 'tab active' : 'tab'}
              onClick={() => setCurrentSection('circulation')}
            >
              Borrow & Return
            </button>
            <button
              className={currentSection === 'locations' ? 'tab active' : 'tab'}
              onClick={() => setCurrentSection('locations')}
            >
              Rooms & Fields
            </button>
            <button
              className={currentSection === 'settings' ? 'tab active' : 'tab'}
              onClick={() => setCurrentSection('settings')}
            >
              Import & Export
            </button>
          </nav>

          {currentSection === 'dashboard' ? (
            <section className="panel">
              <h2>Today at a glance</h2>
              <p className="panel-help">Use quick actions to keep the library updated.</p>
              <div className="stat-grid">
                <StatCard title="Total books" value={totalBooks} subtitle="All records currently visible" />
                <StatCard title="Available" value={availableBooks} subtitle="Ready to borrow" />
                <StatCard title="Borrowed" value={borrowedBooks} subtitle="Currently checked out" />
                <StatCard title="Rooms" value={rooms.length} subtitle="Mapped physical spaces" />
                <StatCard title="Overdue" value={overdueCount} subtitle="Need attention today" />
                <StatCard title="Due in 48h" value={dueSoonCount} subtitle="Loans nearing deadline" />
              </div>
              <div className="actions" style={{ marginTop: 16 }}>
                <button className="primary" onClick={() => loadBooks()}>
                  Refresh Book List
                </button>
                <button className="secondary" onClick={() => refreshEverything()}>
                  Refresh Everything
                </button>
                <button className="accent" onClick={() => setCurrentSection('books')}>
                  Add New Book
                </button>
              </div>

              <div className="grid two" style={{ marginTop: 16 }}>
                <div className="mini-panel">
                  <h3>Recent activity</h3>
                  {auditItems.length === 0 ? <p className="muted">No recent events to show.</p> : null}
                  <div className="list compact">
                    {auditItems.map((item) => (
                      <div className="list-item" key={item.id}>
                        <strong>{item.action}</strong>
                        <p className="muted">{new Date(item.created_at).toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mini-panel">
                  <h3>Overdue loans</h3>
                  {overdueCount === 0 ? <p className="muted">No overdue books right now.</p> : null}
                  <div className="list compact">
                    {activeBorrows
                      .filter((item) => item.isOverdue)
                      .slice(0, 5)
                      .map((item) => (
                        <div className="list-item" key={item.id}>
                          <strong>{item.title}</strong>
                          <p className="muted">
                            Due {new Date(item.dueAt).toLocaleString()} · {item.borrowerName}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>

                  <div className="mini-panel">
                    <h3>Room occupancy</h3>
                    {roomSummary.length === 0 ? <p className="muted">No room summary yet.</p> : null}
                    <div className="list compact">
                      {roomSummary.slice(0, 6).map((room) => (
                        <div className="list-item" key={room.id}>
                          <strong>{room.code}</strong>
                          <p className="muted">{room.name}</p>
                          <p className="muted">
                            Total: {room.total_books} · Available: {room.available_books} · Borrowed: {room.borrowed_books}
                          </p>
                        </div>
                      ))}
                      {unassignedSummary.totalBooks > 0 ? (
                        <div className="list-item">
                          <strong>Unassigned room</strong>
                          <p className="muted">Books without room code</p>
                          <p className="muted">Total: {unassignedSummary.totalBooks}</p>
                        </div>
                      ) : null}
                    </div>
                  </div>
              </div>
            </section>
          ) : null}

          {currentSection === 'books' ? (
            <>
              <section className="panel">
                <h2>Search books</h2>
                <p className="panel-help">Filter by name, status, and room.</p>
                <div className="row">
                  <div>
                    <label>Search text</label>
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, author, or ISBN" />
                  </div>
                  <div>
                    <label>Status</label>
                    <select value={status} onChange={(e) => setStatus(e.target.value)}>
                      <option value="">All</option>
                      <option value="available">Available</option>
                      <option value="borrowed">Borrowed</option>
                      <option value="lost">Lost</option>
                      <option value="maintenance">Maintenance</option>
                    </select>
                  </div>
                  <div>
                    <label>Room code</label>
                    <input value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="Example: A1" />
                  </div>
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <button className="primary" onClick={() => loadBooks()}>
                    Apply Search
                  </button>
                  <button className="secondary" onClick={() => setQ('')}>
                    Clear Text
                  </button>
                  <button className="secondary" onClick={() => exportFilteredBooksCsv()}>
                    Export Visible CSV
                  </button>
                </div>
                <div className="actions" style={{ marginTop: 10 }}>
                  <button className="secondary" onClick={() => setBookQuickFilter('all')}>All Visible</button>
                  <button className="secondary" onClick={() => setBookQuickFilter('available')}>Available</button>
                  <button className="secondary" onClick={() => setBookQuickFilter('borrowed')}>Borrowed</button>
                  <button className="secondary" onClick={() => setBookQuickFilter('overdue')}>Overdue</button>
                  <button className="secondary" onClick={() => setBookQuickFilter('missingLocation')}>Missing Location</button>
                </div>
              </section>

              <section className="panel grid two">
                <div>
                  <h2>Add new book</h2>
                  <p className="panel-help">Fill the basic fields first. Advanced fields are optional.</p>
                  <form onSubmit={createBook} className="grid">
                    <div className="row">
                      <div>
                        <label>Title</label>
                        <input
                          value={createForm.title}
                          onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
                          required
                        />
                      </div>
                      <div>
                        <label>Author</label>
                        <input
                          value={createForm.author}
                          onChange={(e) => setCreateForm({ ...createForm, author: e.target.value })}
                          required
                        />
                      </div>
                    </div>
                    <div className="row">
                      <div>
                        <label>ISBN</label>
                        <input value={createForm.isbn} onChange={(e) => setCreateForm({ ...createForm, isbn: e.target.value })} />
                      </div>
                      <div>
                        <label>Publication year</label>
                        <input
                          type="number"
                          value={createForm.publicationYear}
                          onChange={(e) => setCreateForm({ ...createForm, publicationYear: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="row">
                      <div>
                        <label>Room code</label>
                        <input
                          value={createForm.roomCode}
                          onChange={(e) => setCreateForm({ ...createForm, roomCode: e.target.value })}
                        />
                      </div>
                      <div>
                        <label>Shelf code</label>
                        <input
                          value={createForm.shelfCode}
                          onChange={(e) => setCreateForm({ ...createForm, shelfCode: e.target.value })}
                        />
                      </div>
                    </div>
                    <div>
                      <label>Advanced custom fields (JSON)</label>
                      <textarea
                        value={createForm.customFieldsJson}
                        onChange={(e) => setCreateForm({ ...createForm, customFieldsJson: e.target.value })}
                      />
                    </div>
                    <div className="actions">
                      <button className="primary" type="submit">
                        Add Book
                      </button>
                    </div>
                  </form>
                </div>

                <div>
                  <h2>Edit selected book</h2>
                  <p className="panel-help">Select a book from the list below, then update fields here.</p>
                  <form onSubmit={saveBookEdit} className="grid">
                    <div>
                      <label>Selected ID</label>
                      <input value={editForm.id} readOnly placeholder="Select a book first" />
                    </div>
                    <div className="row">
                      <div>
                        <label>Title</label>
                        <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} />
                      </div>
                      <div>
                        <label>Author</label>
                        <input value={editForm.author} onChange={(e) => setEditForm({ ...editForm, author: e.target.value })} />
                      </div>
                    </div>
                    <div className="row">
                      <div>
                        <label>Status</label>
                        <select
                          value={editForm.status}
                          onChange={(e) => setEditForm({ ...editForm, status: e.target.value as BookStatus })}
                        >
                          <option value="available">Available</option>
                          <option value="borrowed">Borrowed</option>
                          <option value="lost">Lost</option>
                          <option value="maintenance">Maintenance</option>
                        </select>
                      </div>
                      <div>
                        <label>Room code</label>
                        <input value={editForm.roomCode} onChange={(e) => setEditForm({ ...editForm, roomCode: e.target.value })} />
                      </div>
                      <div>
                        <label>Shelf code</label>
                        <input value={editForm.shelfCode} onChange={(e) => setEditForm({ ...editForm, shelfCode: e.target.value })} />
                      </div>
                    </div>
                    <div>
                      <label>Advanced custom fields (JSON)</label>
                      <textarea
                        value={editForm.customFieldsJson}
                        onChange={(e) => setEditForm({ ...editForm, customFieldsJson: e.target.value })}
                      />
                    </div>
                    <div className="actions">
                      <button className="primary" type="submit" disabled={!editForm.id}>
                        Save Changes
                      </button>
                    </div>
                  </form>

                  <div className="panel-divider" />
                  <h3>Book attributes form</h3>
                  <p className="panel-help">Friendly input fields based on your custom attribute definitions.</p>
                  {customFields.length === 0 ? <p className="muted">No custom attributes defined yet.</p> : null}
                  <div className="grid">
                    {customFields.map((field) => (
                      <div key={field.id}>
                        <label>{field.label}</label>
                        {field.type === 'boolean' ? (
                          <select
                            value={String(attributeEditorValues[field.key] ?? '')}
                            onChange={(e) => updateAttributeEditorValue(field.key, e.target.value)}
                          >
                            <option value="">Not set</option>
                            <option value="true">True</option>
                            <option value="false">False</option>
                          </select>
                        ) : field.type === 'enum' ? (
                          <select
                            value={String(attributeEditorValues[field.key] ?? '')}
                            onChange={(e) => updateAttributeEditorValue(field.key, e.target.value)}
                          >
                            <option value="">Select</option>
                            {field.enumOptions.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : field.type === 'number' ? (
                          <input
                            type="number"
                            value={String(attributeEditorValues[field.key] ?? '')}
                            onChange={(e) => updateAttributeEditorValue(field.key, e.target.value)}
                          />
                        ) : field.type === 'date' ? (
                          <input
                            type="datetime-local"
                            value={
                              attributeEditorValues[field.key]
                                ? new Date(String(attributeEditorValues[field.key])).toISOString().slice(0, 16)
                                : ''
                            }
                            onChange={(e) => updateAttributeEditorValue(field.key, e.target.value)}
                          />
                        ) : (
                          <input
                            value={String(attributeEditorValues[field.key] ?? '')}
                            onChange={(e) => updateAttributeEditorValue(field.key, e.target.value)}
                          />
                        )}
                      </div>
                    ))}
                    <div className="actions">
                      <button className="secondary" onClick={saveBookAttributes} disabled={!editForm.id}>
                        Save Attributes
                      </button>
                    </div>

                    <div className="panel-divider" />
                    <h3>Borrow history</h3>
                    <p className="panel-help">Timeline for the selected book.</p>
                    {bookHistory.length === 0 ? <p className="muted">No borrow history yet.</p> : null}
                    <div className="list compact">
                      {bookHistory.map((item) => (
                        <div className="list-item" key={item.id}>
                          <strong>{item.borrowerName}</strong>
                          <p className="muted">
                            Borrowed: {new Date(item.borrowedAt).toLocaleString()} · Due: {new Date(item.dueAt).toLocaleString()}
                          </p>
                          <p className="muted">
                            {item.returnedAt ? `Returned: ${new Date(item.returnedAt).toLocaleString()}` : 'Still borrowed'}
                            {item.wasOverdue ? ' · Overdue' : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="panel">
                <h2>Book list ({visibleBooks.length}/{books.length})</h2>
                <p className="panel-help">Use Select to edit, Borrow/Return for circulation, and code buttons for labels.</p>
                <div className="grid" style={{ marginBottom: 12 }}>
                  <h3>Bulk actions</h3>
                  <p className="panel-help">Selected: {selectedBookIds.length}. Update multiple books in one action.</p>
                  <div className="row">
                    <div>
                      <label>Bulk status</label>
                      <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                        <option value="">No change</option>
                        <option value="available">Available</option>
                        <option value="borrowed">Borrowed</option>
                        <option value="lost">Lost</option>
                        <option value="maintenance">Maintenance</option>
                      </select>
                    </div>
                    <div>
                      <label>Bulk room code</label>
                      <input value={bulkRoomCode} onChange={(e) => setBulkRoomCode(e.target.value)} placeholder="A1" />
                    </div>
                    <div>
                      <label>Bulk shelf code</label>
                      <input value={bulkShelfCode} onChange={(e) => setBulkShelfCode(e.target.value)} placeholder="S-02" />
                    </div>
                  </div>
                  <div className="actions">
                    <button className="secondary" onClick={selectVisibleBooks}>Select Visible</button>
                    <button className="secondary" onClick={clearSelectedBooks}>Clear Selection</button>
                    <button className="primary" onClick={applyBulkBookChanges}>Apply Bulk Update</button>
                  </div>
                </div>
                {emptyState}
                <div className="list">
                  {visibleBooks.map((book) => (
                    <article className="list-item" key={book.id}>
                      <h3>
                        <label className="inline-check" style={{ display: 'inline-flex', marginRight: 8 }}>
                          <input
                            type="checkbox"
                            checked={selectedBookIds.includes(book.id)}
                            onChange={() => toggleBookSelection(book.id)}
                          />
                        </label>
                        {book.title} <span className="code">{book.status}</span>
                      </h3>
                      <p className="muted">{book.author} {book.isbn ? `- ${book.isbn}` : ''}</p>
                      <p className="muted">Location: {book.roomCode ?? '-'} / {book.shelfCode ?? '-'}</p>
                      <div className="actions">
                        <button className="secondary" onClick={() => beginEdit(book)}>Select</button>
                        <button
                          className="secondary"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(book.id);
                              setMessage(`Book ID copied: ${book.id}`);
                            } catch {
                              setMessage(`Book ID: ${book.id}`);
                            }
                          }}
                        >
                          Copy ID
                        </button>
                        <button className="accent" onClick={() => generateCode(book, 'qr')}>Create QR</button>
                        <button className="accent" onClick={() => generateCode(book, 'barcode')}>Create Barcode</button>
                        <button className="primary" onClick={() => borrowBook(book)}>Borrow</button>
                        <button className="secondary" onClick={() => returnBook(book)}>Return</button>
                        <button className="danger" onClick={() => deleteBook(book)}>Delete</button>
                      </div>
                    </article>
                  ))}
                </div>
                {selectedBook ? <p className="muted">Selected: {selectedBook.title}</p> : null}
              </section>
            </>
          ) : null}

          {currentSection === 'circulation' ? (
            <section className="panel grid two">
              <div>
                <h2>Scan to find a book</h2>
                <p className="panel-help">Paste or type a QR/barcode value to locate the matching book.</p>
                <form onSubmit={resolveScanCode} className="grid">
                  <div>
                    <label>Code value</label>
                    <input value={scanCode} onChange={(e) => setScanCode(e.target.value)} placeholder="QR-... or BC-..." />
                  </div>
                  <button className="primary" type="submit">Find Book</button>
                </form>
                {scanResult ? <p className="success">Found: {scanResult}</p> : null}
              </div>

              <div>
                <h2>Borrow details</h2>
                <p className="panel-help">These details are used when you click Borrow on a book card.</p>
                <div className="grid">
                  <div>
                    <label>Borrower name</label>
                    <input value={borrowerName} onChange={(e) => setBorrowerName(e.target.value)} />
                  </div>
                  <div>
                    <label>Borrower contact</label>
                    <input value={borrowerContact} onChange={(e) => setBorrowerContact(e.target.value)} />
                  </div>
                  <div>
                    <label>Due date</label>
                    <input
                      type="datetime-local"
                      value={dueAt}
                      onChange={(e) => {
                        const parsed = e.target.value ? new Date(e.target.value).toISOString() : '';
                        setDueAt(parsed);
                      }}
                    />
                  </div>
                  <div className="actions">
                    <button className="secondary" onClick={() => setDueInDays(7)}>+7 days</button>
                    <button className="secondary" onClick={() => setDueInDays(14)}>+14 days</button>
                    <button className="secondary" onClick={() => setDueInDays(30)}>+30 days</button>
                  </div>
                </div>
              </div>

              <div className="full-row">
                <h2>Active loans</h2>
                <p className="panel-help">Track open loans and quickly process returns.</p>
                <div className="actions" style={{ marginBottom: 10 }}>
                  <button className="secondary" onClick={() => setLoanFilter('all')}>All</button>
                  <button className="secondary" onClick={() => setLoanFilter('overdue')}>Overdue</button>
                  <button className="secondary" onClick={() => setLoanFilter('dueSoon')}>Due in 48h</button>
                  <button className="danger" onClick={() => returnAllOverdue()}>Return All Overdue</button>
                </div>
                {visibleActiveBorrows.length === 0 ? <p className="muted">No active loans in this filter.</p> : null}
                <div className="list">
                  {visibleActiveBorrows.map((item) => (
                    <div className="list-item" key={item.id}>
                      <h3>
                        {item.title} {item.isOverdue ? <span className="code overdue">Overdue</span> : null}
                      </h3>
                      <p className="muted">
                        Borrower: {item.borrowerName} · Due: {new Date(item.dueAt).toLocaleString()}
                      </p>
                      <div className="actions">
                        <button className="secondary" onClick={() => quickReturnByBookId(item.bookId, item.title)}>
                          Quick Return
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {currentSection === 'locations' ? (
            <section className="panel grid two">
              <div>
                <h2>Rooms</h2>
                <p className="panel-help">Define real physical spaces so staff can find books quickly.</p>
                <form className="grid" onSubmit={createRoom}>
                  <div className="row">
                    <div>
                      <label>Code</label>
                      <input value={roomForm.code} onChange={(e) => setRoomForm({ ...roomForm, code: e.target.value })} required />
                    </div>
                    <div>
                      <label>Name</label>
                      <input value={roomForm.name} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })} required />
                    </div>
                  </div>
                  <div>
                    <label>Description</label>
                    <input
                      value={roomForm.description}
                      onChange={(e) => setRoomForm({ ...roomForm, description: e.target.value })}
                    />
                  </div>
                  <button className="primary" type="submit">Add Room</button>
                </form>

                <div className="list" style={{ marginTop: 10 }}>
                  {rooms.map((room) => (
                    <div className="list-item" key={room.id}>
                      <strong>{room.code}</strong> - {room.name}
                      {room.description ? <p className="muted">{room.description}</p> : null}
                      <div className="actions" style={{ marginTop: 8 }}>
                        <button className="danger" onClick={() => deleteRoom(room)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="panel-divider" />
                <h3>Occupancy snapshot</h3>
                <p className="panel-help">See book distribution in each room.</p>
                <div className="list compact">
                  {roomSummary.map((room) => (
                    <div className="list-item" key={`summary-${room.id}`}>
                      <strong>{room.code} · {room.name}</strong>
                      <p className="muted">
                        Total: {room.total_books} · Available: {room.available_books} · Borrowed: {room.borrowed_books}
                      </p>
                    </div>
                  ))}
                  {unassignedSummary.totalBooks > 0 ? (
                    <div className="list-item">
                      <strong>Unassigned room code</strong>
                      <p className="muted">Books without location: {unassignedSummary.totalBooks}</p>
                    </div>
                  ) : null}
                </div>
              </div>

              <div>
                <h2>Custom attributes</h2>
                <p className="panel-help">Create extra attributes beyond standard book fields like title/author/isbn.</p>
                <form className="grid" onSubmit={saveCustomField}>
                  <div className="row">
                    <div>
                      <label>Field key</label>
                      <input value={fieldForm.key} onChange={(e) => setFieldForm({ ...fieldForm, key: e.target.value })} required />
                    </div>
                    <div>
                      <label>Label</label>
                      <input value={fieldForm.label} onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })} required />
                    </div>
                  </div>
                  <div className="row">
                    <div>
                      <label>Type</label>
                      <select
                        value={fieldForm.type}
                        onChange={(e) =>
                          setFieldForm({ ...fieldForm, type: e.target.value as 'text' | 'number' | 'boolean' | 'date' | 'enum' })
                        }
                      >
                        <option value="text">Text</option>
                        <option value="number">Number</option>
                        <option value="boolean">Boolean</option>
                        <option value="date">Date</option>
                        <option value="enum">Enum</option>
                      </select>
                    </div>
                    <div>
                      <label>Enum options (comma separated)</label>
                      <input value={fieldForm.enumOptionsCsv} onChange={(e) => setFieldForm({ ...fieldForm, enumOptionsCsv: e.target.value })} />
                    </div>
                  </div>
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={fieldForm.required}
                      onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.checked })}
                    />
                    This field is required
                  </label>
                  <div className="actions">
                    <button className="primary" type="submit">{editingCustomFieldId ? 'Save Field' : 'Add Field'}</button>
                    {editingCustomFieldId ? (
                      <button className="secondary" type="button" onClick={resetCustomFieldForm}>Cancel Edit</button>
                    ) : null}
                  </div>
                </form>
                <p className="muted" style={{ marginTop: 8 }}>
                  Reserved keys: title, author, isbn, publicationYear, publisher, language, description, status, and other built-in fields.
                </p>

                <div className="list" style={{ marginTop: 10 }}>
                  {customFields.map((field) => (
                    <div className="list-item" key={field.id}>
                      <strong>{field.key}</strong> <span className="code">{field.type}</span>
                      <p className="muted">{field.label}</p>
                      <div className="actions">
                        <button className="secondary" onClick={() => beginCustomFieldEdit(field)}>Edit</button>
                        <button className="danger" onClick={() => deleteCustomField(field)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          {currentSection === 'settings' ? (
            <>
              <section className="panel">
                <h2>Export records</h2>
                <p className="panel-help">Download the current book list as a CSV file.</p>
                <div className="actions">
                  <button className="accent" onClick={exportCsv}>Download CSV</button>
                </div>
              </section>

              <section className="panel">
                <h2>Bulk import</h2>
                <p className="panel-help">Paste a JSON array of book rows. Use dry run first to validate.</p>
                <form onSubmit={runImport} className="grid">
                  <div>
                    <label>Rows JSON</label>
                    <textarea value={importJson} onChange={(e) => setImportJson(e.target.value)} style={{ minHeight: 180 }} />
                  </div>
                  <label className="inline-check">
                    <input type="checkbox" checked={importDryRun} onChange={(e) => setImportDryRun(e.target.checked)} />
                    Dry run (check only, no changes saved)
                  </label>
                  <div className="actions">
                    <button className="primary" type="submit">Run Import</button>
                  </div>
                </form>
              </section>
            </>
          ) : null}
        </>
      )}

      {isWorking ? <p className="banner muted">Working on your request...</p> : null}
      {error ? <p className="error banner">{error}</p> : null}
      {message ? <p className="success banner">{message}</p> : null}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
