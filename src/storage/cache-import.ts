import { idbClear, idbGet, idbKeys, idbPut, STORE_CACHE, STORE_META } from './idb.ts';
import { readZip } from './zip.ts';

export const DAT2 = 'main_file_cache.dat2';
const IDX_RE = /^main_file_cache\.idx(\d+)$/;

export interface CacheMeta {
  importedAt: number;
  source: string;
  files: number;
  bytes: number;
  /** XTEA keys (only needed for pre-2025 caches), keyed by region id. */
  keys: Record<number, [number, number, number, number]>;
}

export type ImportProgress = (message: string, fraction: number) => void;

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** OpenRS2 keys.json: [{ mapsquare, key: [k0..k3] }] (also accepts { region/archive/group/name } variants). */
export function parseKeys(json: unknown): Record<number, [number, number, number, number]> {
  const out: Record<number, [number, number, number, number]> = {};
  if (!Array.isArray(json)) return out;
  for (const e of json) {
    const region = e?.mapsquare ?? e?.region;
    const key = e?.key ?? e?.keys;
    if (typeof region === 'number' && Array.isArray(key) && key.length === 4) out[region] = key.map((k: number) => k | 0) as [number, number, number, number];
  }
  return out;
}

/**
 * Imports cache files into IndexedDB from a picked folder/file list or an OpenRS2 disk.zip.
 * Only files named main_file_cache.* (and an optional keys.json) are stored.
 */
export async function importCache(files: File[], progress: ImportProgress): Promise<CacheMeta> {
  const wanted = new Map<string, Blob>();
  let keys: CacheMeta['keys'] = {};
  let source = files.length === 1 ? files[0].name : `${files.length} files`;

  for (const f of files) {
    const name = baseName((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    if (name === DAT2 || IDX_RE.test(name)) wanted.set(name, f);
    else if (name.toLowerCase().endsWith('.json') && /key|xtea/i.test(name)) keys = parseKeys(JSON.parse(await f.text()));
    else if (name.toLowerCase().endsWith('.zip')) {
      source = name;
      progress(`Reading ${name}…`, 0);
      const entries = await readZip(f);
      const relevant = entries.filter((e) => {
        const n = baseName(e.name);
        return n === DAT2 || IDX_RE.test(n) || (n.endsWith('.json') && /key|xtea/i.test(n));
      });
      const total = relevant.reduce((s, e) => s + e.compressedSize, 0) || 1;
      let done = 0;
      for (const e of relevant) {
        const n = baseName(e.name);
        progress(`Extracting ${n}…`, done / total);
        const blob = await e.extract();
        if (n.endsWith('.json')) keys = parseKeys(JSON.parse(await blob.text()));
        else wanted.set(n, blob);
        done += e.compressedSize;
      }
    }
  }

  if (!wanted.has(DAT2)) throw new Error(`No ${DAT2} found. Pick the cache folder, its files, or an OpenRS2 disk.zip.`);
  if (!wanted.has('main_file_cache.idx255')) throw new Error('No main_file_cache.idx255 found — the cache is incomplete.');

  progress('Saving cache to browser storage…', 0.95);
  await idbClear(STORE_CACHE);
  let bytes = 0;
  for (const [name, blob] of wanted) {
    // Store Blobs (not ArrayBuffers) so browsers can keep the large data file on disk.
    await idbPut(STORE_CACHE, name, blob);
    bytes += blob.size;
  }
  const meta: CacheMeta = { importedAt: Date.now(), source, files: wanted.size, bytes, keys };
  await idbPut(STORE_META, 'cache', meta);
  // Ask the browser not to evict ~200 MB of game data under storage pressure (best effort). Never await it:
  // Firefox answers only after the user responds to a permission prompt, which may never happen.
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* ignored */
  }
  progress('Done', 1);
  return meta;
}

export async function storedCacheMeta(): Promise<CacheMeta | undefined> {
  const meta = await idbGet<CacheMeta>(STORE_META, 'cache');
  if (!meta) return undefined;
  const keys = await idbKeys(STORE_CACHE);
  return keys.includes(DAT2) ? meta : undefined;
}

export async function loadStoredCacheFiles(): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  for (const name of await idbKeys(STORE_CACHE)) {
    const blob = await idbGet<Blob>(STORE_CACHE, name);
    if (blob) out.set(name, blob);
  }
  return out;
}

export async function forgetCache(): Promise<void> {
  await idbClear(STORE_CACHE);
  await idbPut(STORE_META, 'cache', undefined);
}

export function indexId(name: string): number {
  const m = IDX_RE.exec(name);
  return m ? Number(m[1]) : -1;
}
