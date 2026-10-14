import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cache } from '../../src/cache/cache.ts';
import { BufferSource, DiskStore } from '../../src/cache/disk-store.ts';
import { parseKeys } from '../../src/storage/cache-import.ts';

/** Directory containing main_file_cache.dat2/idx*, from OSRS_CACHE_DIR. Never committed. */
export const REAL_CACHE_DIR = process.env.OSRS_CACHE_DIR ?? '';
export const hasRealCache = REAL_CACHE_DIR !== '' && existsSync(join(REAL_CACHE_DIR, 'main_file_cache.dat2'));

export function openNodeCache(dir: string): Cache {
  const dat2 = readFileSync(join(dir, 'main_file_cache.dat2'));
  const indexes = new Map<number, Uint8Array>();
  for (const name of readdirSync(dir)) {
    const m = /^main_file_cache\.idx(\d+)$/.exec(name);
    if (m) indexes.set(Number(m[1]), new Uint8Array(readFileSync(join(dir, name))));
  }
  const cache = new Cache(new DiskStore(new BufferSource(new Uint8Array(dat2)), indexes));
  // XTEA keys for pre-2025 caches: OSRS_KEYS, or keys.json in the cache dir or its parent (OpenRS2 layout).
  const keyFile = [process.env.OSRS_KEYS ?? '', join(dir, 'keys.json'), join(dir, '..', 'keys.json')].find((f) => f && existsSync(f));
  if (keyFile) {
    for (const [region, key] of Object.entries(parseKeys(JSON.parse(readFileSync(keyFile, 'utf8'))))) cache.keys.set(Number(region), key);
  }
  return cache;
}
