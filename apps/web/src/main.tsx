import React, { FormEvent, useMemo, useState } from 'react';
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

const RAW_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8787';
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');

function joinApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

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

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
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

  const [importJson, setImportJson] = useState('[]');
  const [importDryRun, setImportDryRun] = useState(true);

  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [borrowerName, setBorrowerName] = useState('');
  const [borrowerContact, setBorrowerContact] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [scanCode, setScanCode] = useState('');
  const [scanResult, setScanResult] = useState<string>('');

  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loggedIn = useMemo(() => Boolean(token), [token]);

  function clearStatus() {
    setError('');
    setMessage('');
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    clearStatus();

    try {
      const response = await apiRequest<LoginResponse>(null, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      setToken(response.token);
      setMessage(`Signed in as ${response.user.username} (${response.user.role})`);
      await Promise.all([
        loadBooks(response.token),
        loadRooms(response.token),
        loadCustomFields(response.token)
      ]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadBooks(tokenOverride?: string) {
    const currentToken = tokenOverride ?? token;
    if (!currentToken) return;

    clearStatus();

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
      setMessage(`Loaded ${response.items.length} books`);
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

  async function createBook(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    clearStatus();

    try {
      const customFieldsValue = JSON.parse(createForm.customFieldsJson || '{}') as Record<string, unknown>;
      await apiRequest<{ id: string }>(token, '/api/books', {
        method: 'POST',
        body: JSON.stringify({
          title: createForm.title,
          author: createForm.author,
          isbn: createForm.isbn || null,
          roomCode: createForm.roomCode || null,
          shelfCode: createForm.shelfCode || null,
          publicationYear: createForm.publicationYear ? Number(createForm.publicationYear) : null,
          tags: [],
          customFields: customFieldsValue,
          status: 'available'
        })
      });

      setMessage('Book created');
      await loadBooks();
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
  }

  async function saveBookEdit(event: FormEvent) {
    event.preventDefault();
    if (!token || !editForm.id) return;
    clearStatus();

    try {
      const customFieldsValue = JSON.parse(editForm.customFieldsJson || '{}') as Record<string, unknown>;
      const result = await apiRequest<{ id: string; version: number }>(token, `/api/books/${editForm.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: editForm.title,
          author: editForm.author,
          isbn: editForm.isbn || null,
          roomCode: editForm.roomCode || null,
          shelfCode: editForm.shelfCode || null,
          publicationYear: editForm.publicationYear ? Number(editForm.publicationYear) : null,
          customFields: customFieldsValue,
          status: editForm.status,
          version: editForm.version
        })
      });

      setEditForm((prev) => ({ ...prev, version: result.version }));
      setMessage('Book updated');
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteBook(book: Book) {
    if (!token) return;
    clearStatus();

    try {
      await apiRequest<void>(token, `/api/books/${book.id}`, { method: 'DELETE' });
      setMessage(`Deleted: ${book.title}`);
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function borrowBook(book: Book) {
    if (!token) return;
    clearStatus();

    if (!borrowerName || !dueAt) {
      setError('Borrower name and due date/time are required.');
      return;
    }

    try {
      await apiRequest(token, `/api/books/${book.id}/borrow`, {
        method: 'POST',
        body: JSON.stringify({
          borrowerName,
          borrowerContact: borrowerContact || null,
          dueAt,
          notes: null
        })
      });

      setMessage(`Borrowed: ${book.title}`);
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function returnBook(book: Book) {
    if (!token) return;
    clearStatus();

    try {
      await apiRequest(token, `/api/books/${book.id}/return`, {
        method: 'POST',
        body: JSON.stringify({ notes: null })
      });

      setMessage(`Returned: ${book.title}`);
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function generateCode(book: Book, type: 'qr' | 'barcode') {
    if (!token) return;
    clearStatus();

    try {
      const response = await apiRequest<{ value: string }>(token, `/api/books/${book.id}/codes`, {
        method: 'POST',
        body: JSON.stringify({ type, label: `auto-${type}` })
      });
      setMessage(`${type.toUpperCase()} generated: ${response.value}`);
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
      const response = await apiRequest<{ book: Book }>(token, `/api/scan/${encodeURIComponent(scanCode)}`);
      setScanResult(`${response.book.title} by ${response.book.author} (${response.book.status})`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function exportCsv() {
    if (!token) return;
    clearStatus();

    try {
      const csv = await apiRequest<string>(token, '/api/export/books.csv', undefined, true);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'books.csv';
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage('CSV export downloaded');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    clearStatus();

    try {
      await apiRequest<{ id: string }>(token, '/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          code: roomForm.code,
          name: roomForm.name,
          description: roomForm.description || null,
          mapMetadata: {}
        })
      });
      setRoomForm({ code: '', name: '', description: '' });
      await loadRooms();
      setMessage('Room created');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteRoom(room: Room) {
    if (!token) return;
    clearStatus();

    try {
      await apiRequest<void>(token, `/api/rooms/${room.id}`, { method: 'DELETE' });
      await loadRooms();
      setMessage(`Room deleted: ${room.code}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createCustomField(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    clearStatus();

    try {
      const enumOptions = fieldForm.enumOptionsCsv
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

      await apiRequest<{ id: string }>(token, '/api/custom-fields', {
        method: 'POST',
        body: JSON.stringify({
          key: fieldForm.key,
          label: fieldForm.label,
          type: fieldForm.type,
          required: fieldForm.required,
          enumOptions
        })
      });

      setFieldForm({ key: '', label: '', type: 'text', required: false, enumOptionsCsv: '' });
      await loadCustomFields();
      setMessage('Custom field created');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteCustomField(field: CustomField) {
    if (!token) return;
    clearStatus();

    try {
      await apiRequest<void>(token, `/api/custom-fields/${field.id}`, { method: 'DELETE' });
      await loadCustomFields();
      setMessage(`Custom field deleted: ${field.key}`);
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

      const result = await apiRequest<{ dryRun?: boolean; acceptedRows?: number; importedRows?: number }>(
        token,
        '/api/import/books',
        {
          method: 'POST',
          body: JSON.stringify({ dryRun: importDryRun, rows })
        }
      );

      if (result.dryRun) {
        setMessage(`Import dry-run accepted rows: ${result.acceptedRows ?? 0}`);
      } else {
        setMessage(`Imported rows: ${result.importedRows ?? 0}`);
      }
      await loadBooks();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="app-shell">
      <section className="hero">
        <h1>OK Library Organizer</h1>
        <p>Staff-only control center for inventory, circulation, scanning, rooms, and schema management.</p>
      </section>

      {!loggedIn ? (
        <section className="panel">
          <h2>Sign In</h2>
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
                Sign In
              </button>
            </div>
          </form>
        </section>
      ) : (
        <>
          <section className="panel">
            <h2>Book Search</h2>
            <div className="row">
              <div>
                <label>Keyword</label>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="title / author / isbn" />
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
                <label>Room Code</label>
                <input value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="A-ROOM" />
              </div>
            </div>
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="primary" onClick={() => loadBooks()}>
                Search
              </button>
              <button className="accent" onClick={exportCsv}>
                Export CSV
              </button>
              <button className="secondary" onClick={() => Promise.all([loadRooms(), loadCustomFields()])}>
                Refresh Metadata
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>Create Book Entry</h2>
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
                <div>
                  <label>ISBN</label>
                  <input value={createForm.isbn} onChange={(e) => setCreateForm({ ...createForm, isbn: e.target.value })} />
                </div>
              </div>

              <div className="row">
                <div>
                  <label>Room Code</label>
                  <input
                    value={createForm.roomCode}
                    onChange={(e) => setCreateForm({ ...createForm, roomCode: e.target.value })}
                  />
                </div>
                <div>
                  <label>Shelf Code</label>
                  <input
                    value={createForm.shelfCode}
                    onChange={(e) => setCreateForm({ ...createForm, shelfCode: e.target.value })}
                  />
                </div>
                <div>
                  <label>Publication Year</label>
                  <input
                    type="number"
                    value={createForm.publicationYear}
                    onChange={(e) => setCreateForm({ ...createForm, publicationYear: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label>Custom Fields JSON</label>
                <textarea
                  value={createForm.customFieldsJson}
                  onChange={(e) => setCreateForm({ ...createForm, customFieldsJson: e.target.value })}
                />
              </div>

              <div className="actions">
                <button className="primary" type="submit">
                  Create
                </button>
              </div>
            </form>
          </section>

          <section className="panel grid two">
            <div>
              <h2>Book Edit</h2>
              <form onSubmit={saveBookEdit} className="grid">
                <div>
                  <label>Selected Book ID</label>
                  <input value={editForm.id} readOnly placeholder="Select a book below" />
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
                    <label>Room Code</label>
                    <input
                      value={editForm.roomCode}
                      onChange={(e) => setEditForm({ ...editForm, roomCode: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>Shelf Code</label>
                    <input
                      value={editForm.shelfCode}
                      onChange={(e) => setEditForm({ ...editForm, shelfCode: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <label>Custom Fields JSON</label>
                  <textarea
                    value={editForm.customFieldsJson}
                    onChange={(e) => setEditForm({ ...editForm, customFieldsJson: e.target.value })}
                  />
                </div>
                <div className="actions">
                  <button className="primary" type="submit" disabled={!editForm.id}>
                    Save Edit
                  </button>
                </div>
              </form>
            </div>

            <div>
              <h2>Scan Resolve / Borrow</h2>
              <form onSubmit={resolveScanCode} className="grid">
                <div>
                  <label>Scanned Code Value</label>
                  <input value={scanCode} onChange={(e) => setScanCode(e.target.value)} placeholder="QR-... or BC-..." />
                </div>
                <button className="primary" type="submit">
                  Resolve Code
                </button>
              </form>
              {scanResult ? <p className="success">{scanResult}</p> : null}

              <div className="grid">
                <div>
                  <label>Borrower Name</label>
                  <input value={borrowerName} onChange={(e) => setBorrowerName(e.target.value)} />
                </div>
                <div>
                  <label>Borrower Contact</label>
                  <input value={borrowerContact} onChange={(e) => setBorrowerContact(e.target.value)} />
                </div>
                <div>
                  <label>Due At (ISO)</label>
                  <input
                    type="datetime-local"
                    value={dueAt}
                    onChange={(e) => {
                      const parsed = e.target.value ? new Date(e.target.value).toISOString() : '';
                      setDueAt(parsed);
                    }}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="panel grid two">
            <div>
              <h2>Rooms</h2>
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
                <button className="primary" type="submit">
                  Create Room
                </button>
              </form>

              <div className="list" style={{ marginTop: 10 }}>
                {rooms.map((room) => (
                  <div className="list-item" key={room.id}>
                    <strong>{room.code}</strong> - {room.name}
                    <div className="actions" style={{ marginTop: 8 }}>
                      <button className="danger" onClick={() => deleteRoom(room)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h2>Custom Fields</h2>
              <form className="grid" onSubmit={createCustomField}>
                <div className="row">
                  <div>
                    <label>Key</label>
                    <input value={fieldForm.key} onChange={(e) => setFieldForm({ ...fieldForm, key: e.target.value })} required />
                  </div>
                  <div>
                    <label>Label</label>
                    <input
                      value={fieldForm.label}
                      onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })}
                      required
                    />
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
                    <label>Enum Options (CSV)</label>
                    <input
                      value={fieldForm.enumOptionsCsv}
                      onChange={(e) => setFieldForm({ ...fieldForm, enumOptionsCsv: e.target.value })}
                    />
                  </div>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={fieldForm.required}
                    onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.checked })}
                  />{' '}
                  Required
                </label>
                <button className="primary" type="submit">
                  Create Field
                </button>
              </form>

              <div className="list" style={{ marginTop: 10 }}>
                {customFields.map((field) => (
                  <div className="list-item" key={field.id}>
                    <strong>{field.key}</strong> <span className="code">{field.type}</span>
                    <p className="muted">{field.label}</p>
                    <div className="actions">
                      <button className="danger" onClick={() => deleteCustomField(field)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Bulk Import (JSON Rows)</h2>
            <form onSubmit={runImport} className="grid">
              <div>
                <label>Rows JSON Array</label>
                <textarea value={importJson} onChange={(e) => setImportJson(e.target.value)} style={{ minHeight: 180 }} />
              </div>
              <label>
                <input type="checkbox" checked={importDryRun} onChange={(e) => setImportDryRun(e.target.checked)} /> Dry run
              </label>
              <div className="actions">
                <button className="primary" type="submit">
                  Run Import
                </button>
              </div>
            </form>
          </section>

          <section className="panel">
            <h2>Books ({books.length})</h2>
            <div className="list">
              {books.map((book) => (
                <article className="list-item" key={book.id}>
                  <h3>
                    {book.title} <span className="code">{book.status}</span>
                  </h3>
                  <p className="muted">
                    {book.author} {book.isbn ? `- ${book.isbn}` : ''}
                  </p>
                  <p className="muted">
                    Location: {book.roomCode ?? '-'} / {book.shelfCode ?? '-'}
                  </p>
                  <div className="actions">
                    <button className="secondary" onClick={() => beginEdit(book)}>
                      Select/Edit
                    </button>
                    <button className="accent" onClick={() => generateCode(book, 'qr')}>
                      Generate QR
                    </button>
                    <button className="accent" onClick={() => generateCode(book, 'barcode')}>
                      Generate Barcode
                    </button>
                    <button className="primary" onClick={() => borrowBook(book)}>
                      Borrow
                    </button>
                    <button className="secondary" onClick={() => returnBook(book)}>
                      Return
                    </button>
                    <button className="danger" onClick={() => deleteBook(book)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {selectedBook ? <p className="muted">Selected book ID: {selectedBook.id}</p> : null}
          </section>
        </>
      )}

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="success">{message}</p> : null}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
