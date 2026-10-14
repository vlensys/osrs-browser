import { describe, expect, it } from 'vitest';
import { parseKeys } from '../../src/storage/cache-import.ts';
import { pickLatestCache, type OpenRs2Cache } from '../../src/storage/openrs2.ts';
import { readZip } from '../../src/storage/zip.ts';
import { buildZip } from '../../tools/fixture/zip-writer.ts';

describe('zip reader', () => {
  it('lists and extracts stored and deflated entries', async () => {
    const big = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) & 255);
    const zip = await buildZip([
      { name: 'cache/', data: new Uint8Array(0), deflate: false },
      { name: 'cache/main_file_cache.dat2', data: big, deflate: true },
      { name: 'cache/main_file_cache.idx255', data: Uint8Array.of(1, 2, 3), deflate: false },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['cache/main_file_cache.dat2', 'cache/main_file_cache.idx255']);
    expect(new Uint8Array(await (await entries[0].extract()).arrayBuffer())).toEqual(big);
    expect(new Uint8Array(await (await entries[1].extract()).arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('rejects non-zip data', async () => {
    await expect(readZip(new Blob(['not a zip at all']))).rejects.toThrow(/Not a zip/);
  });
});

describe('XTEA key files', () => {
  it('parses OpenRS2 keys.json', () => {
    const keys = parseKeys([{ mapsquare: 12850, key: [1, -2, 3, 4] }, { archive: 5, group: 1 }]);
    expect(keys).toEqual({ 12850: [1, -2, 3, 4] });
  });
});

describe('OpenRS2 cache selection', () => {
  const base = {
    game: 'oldschool',
    environment: 'live',
    language: 'en',
    builds: [{ major: 241, minor: null }],
    indexes: 25,
    valid_indexes: 25,
    groups: 100,
    valid_groups: 100,
    keys: 0,
    valid_keys: 0,
    size: 1,
    disk_store_valid: true,
  };

  it('picks the newest complete live oldschool cache', () => {
    const list: OpenRs2Cache[] = [
      { ...base, id: 1, timestamp: '2026-10-01T00:00:00Z' },
      { ...base, id: 2, timestamp: '2026-10-14T00:00:00Z', valid_groups: 50 }, // incomplete
      { ...base, id: 3, timestamp: '2026-10-07T00:00:00Z' },
      { ...base, id: 4, timestamp: '2026-10-20T00:00:00Z', game: 'runescape' },
      { ...base, id: 5, timestamp: '2026-10-21T00:00:00Z', environment: 'beta' },
      { ...base, id: 6, timestamp: null },
      { ...base, id: 7, timestamp: '2026-10-22T00:00:00Z', keys: 100, valid_keys: 20 }, // missing map keys
    ];
    expect(pickLatestCache(list)?.id).toBe(3);
  });

  it('returns null when nothing is usable', () => {
    expect(pickLatestCache([])).toBeNull();
  });
});
