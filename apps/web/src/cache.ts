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
// v2 adds the `cachedAt` index used for LRU-style eviction. The store
// reads it via `IDBObjectStore.index('cachedAt')`; v1 stores survive the
// upgrade (no data loss) because we add the index in onupgradeneeded.
const DB_VERSION = 2;
const STORE = 'responses';
const CACHED_AT_INDEX = 'cachedAt';
// Hard cap on cached entries. The cache is fail-soft, but allowing it to
// grow forever turns "first load is instant" into "first load is a 50 MB
// IndexedDB query." Eviction kicks in once we cross the threshold and
// drops the oldest entries until we're back under the cap.
const MAX_ENTRIES = 500;
const EVICTION_BATCH = 50;

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
      // Use the upgrade transaction so we can add an index on an already-
      // existing v1 store without dropping it.
      const txn = req.transaction;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE);
        store.createIndex(CACHED_AT_INDEX, 'cachedAt', { unique: false });
      } else if (txn) {
        const store = txn.objectStore(STORE);
        if (!store.indexNames.contains(CACHED_AT_INDEX)) {
          store.createIndex(CACHED_AT_INDEX, 'cachedAt', { unique: false });
        }
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
    // After every write, kick a fire-and-forget eviction pass. This keeps
    // the store bounded without blocking the caller — if multiple writes
    // race, the worst that happens is two passes both delete the same
    // oldest entries (idempotent), not a runaway loop.
    void evictIfNeeded();
  } catch {
    // Quota errors etc. are non-fatal — the cache is best-effort.
  }
}

// LRU-ish eviction. We count the entries cheaply via `count()`; if we're
// over the cap we delete the oldest `EVICTION_BATCH + overflow` rows in
// `cachedAt` order. Sweeping in batches amortizes the cost so writes don't
// pay for a one-row-at-a-time deletion loop.
async function evictIfNeeded(): Promise<void> {
  try {
    const total = await tx<number>('readonly', (s) => asPromise(s.count()));
    if (total <= MAX_ENTRIES) return;
    const overflow = total - MAX_ENTRIES;
    const toDrop = overflow + EVICTION_BATCH;
    await tx<unknown>('readwrite', (s) =>
      new Promise<void>((resolve, reject) => {
        const idx = s.index(CACHED_AT_INDEX);
        // Open an oldest-first cursor and delete the first `toDrop` rows.
        const req = idx.openCursor(undefined, 'next');
        let dropped = 0;
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || dropped >= toDrop) { resolve(); return; }
          cursor.delete();
          dropped += 1;
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
    );
  } catch {
    // Eviction is best-effort. If it fails the next write triggers another
    // pass, and the store eventually catches up.
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
