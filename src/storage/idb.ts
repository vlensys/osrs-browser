/** Tiny promise wrapper over IndexedDB, usable from the main thread and from workers. */

const DB_NAME = 'osrs-browser';
const DB_VERSION = 1;
export const STORE_CACHE = 'cache'; // key: file name (e.g. "main_file_cache.dat2"), value: Blob
export const STORE_META = 'meta'; // key: string, value: any structured-cloneable
export const STORE_SAVES = 'saves'; // key: profile name, value: SaveGame

let dbPromise: Promise<IDBDatabase> | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of [STORE_CACHE, STORE_META, STORE_SAVES]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another tab upgrading the schema: close so it isn't blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return req(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbKeys(store: string): Promise<string[]> {
  const db = await openDb();
  return (await req(db.transaction(store, 'readonly').objectStore(store).getAllKeys())) as string[];
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await txDone(tx);
}

export async function idbClear(store: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await txDone(tx);
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}
