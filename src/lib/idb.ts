/**
 * On-device storage for the sample library and the current patch.
 *
 * Audio never leaves the browser. Voice notes and found recordings are personal
 * enough that shipping them to a server would need a reason, and there isn't
 * one — everything the app does runs client-side.
 */

const DB_NAME = 'sloppy-knobs';
const DB_VERSION = 1;
const SAMPLES = 'samples';
const STATE = 'state';

export interface StoredSample {
  name: string;
  /** Original encoded file bytes, so the sample survives a reload. */
  data: ArrayBuffer;
  type: string;
  addedAt: number;
  /** Cached so the library can show durations without decoding everything. */
  duration?: number;
  origin: 'upload' | 'recording';
}

export interface SampleMeta extends Omit<StoredSample, 'data'> {}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('This browser has no IndexedDB, so nothing can be saved.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAMPLES)) db.createObjectStore(SAMPLES, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the local database.'));
  });
}

function run<T>(store: string, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = body(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error('Storage request failed.'));
        tx.oncomplete = () => db.close();
      }),
  );
}

// -------------------------------------------------------------- samples

export function putSample(sample: StoredSample): Promise<void> {
  return run<void>(SAMPLES, 'readwrite', (s) => s.put(sample));
}

export function getSample(name: string): Promise<StoredSample | undefined> {
  return run<StoredSample | undefined>(SAMPLES, 'readonly', (s) => s.get(name));
}

export function deleteSample(name: string): Promise<void> {
  return run<void>(SAMPLES, 'readwrite', (s) => s.delete(name));
}

export function allSamples(): Promise<StoredSample[]> {
  return run<StoredSample[]>(SAMPLES, 'readonly', (s) => s.getAll());
}

// ---------------------------------------------------------------- state

export function savePatch(source: string): Promise<void> {
  return run<void>(STATE, 'readwrite', (s) => s.put(source, 'patch'));
}

export function loadPatch(): Promise<string | undefined> {
  return run<string | undefined>(STATE, 'readonly', (s) => s.get('patch'));
}

/**
 * Turn a filename into something quotable in a patch.
 *
 * The name is what `src grain "..."` refers to, so it has to survive being
 * written between quotes: no path, no extension, no spaces.
 */
export function toSampleName(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const slug = base
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'sample';
}

/** Append a counter until the name is free. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
