// Tiny IndexedDB-backed key/value cache used for stale-while-revalidate
// responses from the API. The intent is twofold: (1) reduce remote D1 load
// by serving repeated GETs from local storage between network round-trips
// and (2) make the UI render instantly on app boot using the previous
// session's data. Mutations bust the cache so the next read re-fetches.
//
// Failsafe rules:
//  - Every operation swallows IndexedDB errors and degrades to "no cache".
//    Quota exceeded, private-mode failures, or schema upgrades must never
//    crash the app.
//  - The version is bumped whenever the schema changes; on upgrade the old
//    store is dropped to avoid stale shape mismatches.
//  - All values are JSON-cloned by IDB's structured clone, so non-cloneable
//    values (functions, DOM nodes) will throw at write time and be ignored.

const DB_NAME = 'ok_library_cache';
const DB_VERSION = 1;
const STORE = 'responses';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.reject(new Error('IndexedDB unavailable'));
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // If the connection fails once, allow a fresh attempt on the next call.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result: T | undefined;
    Promise.resolve(fn(store)).then(
      (value) => { result = value; },
      (error) => { try { t.abort(); } catch { /* noop */ } reject(error); }
    );
    t.oncomplete = () => resolve(result as T);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Transaction aborted'));
  });
}

export type CacheEntry<T> = { value: T; cachedAt: number };

export async function cacheGet<T>(key: string): Promise<CacheEntry<T> | undefined> {
  try {
    return await tx<CacheEntry<T> | undefined>('readonly', (s) =>
      asPromise(s.get(key) as IDBRequest<CacheEntry<T> | undefined>)
    );
  } catch {
    return undefined;
  }
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  try {
    const entry: CacheEntry<T> = { value, cachedAt: Date.now() };
    await tx<unknown>('readwrite', (s) => asPromise(s.put(entry, key)));
  } catch {
    // Quota errors etc. are non-fatal — the cache is best-effort.
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    await tx<unknown>('readwrite', (s) => asPromise(s.delete(key)));
  } catch {
    // ignore
  }
}

export async function cacheClear(): Promise<void> {
  try {
    await tx<unknown>('readwrite', (s) => asPromise(s.clear()));
  } catch {
    // ignore
  }
}

async function cacheKeys(): Promise<string[]> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) =>
      asPromise(s.getAllKeys() as IDBRequest<IDBValidKey[]>)
    );
    return (keys ?? []).map((k) => String(k));
  } catch {
    return [];
  }
}

// Delete every cache entry whose key starts with one of the given prefixes.
// Used after mutations to invalidate any GET responses that might be stale.
export async function cacheBustPrefixes(prefixes: string[]): Promise<void> {
  if (prefixes.length === 0) return;
  try {
    const keys = await cacheKeys();
    const matches = keys.filter((k) => prefixes.some((p) => k.startsWith(p)));
    if (matches.length === 0) return;
    await tx<unknown>('readwrite', async (s) => {
      for (const k of matches) {
        await asPromise(s.delete(k));
      }
    });
  } catch {
    // ignore
  }
}

// Last-write-wins merge: when both `local` (cached) and `remote` (just fetched)
// contain the same id, prefer whichever has the newer `updatedAt`. Items
// missing on the remote side are dropped — for collection endpoints the
// server is authoritative on membership.
export function mergeByUpdatedAt<T extends { id: string; updatedAt?: string }>(
  local: T[],
  remote: T[]
): T[] {
  const byId = new Map<string, T>();
  for (const item of remote) byId.set(item.id, item);
  for (const item of local) {
    const remoteItem = byId.get(item.id);
    if (!remoteItem) continue; // dropped on server → don't resurrect
    const lTs = Date.parse(item.updatedAt ?? '') || 0;
    const rTs = Date.parse(remoteItem.updatedAt ?? '') || 0;
    if (lTs > rTs) byId.set(item.id, item);
  }
  // Preserve remote order so server-side sorting is respected.
  return remote.map((r) => byId.get(r.id) ?? r);
}
