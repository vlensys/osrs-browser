import { describe, expect, it } from 'vitest';
import { parseKeys } from '../../src/storage/cache-import.ts';
import { readZip } from '../../src/storage/zip.ts';
import { Writer } from '../../tools/fixture/writer.ts';

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Minimal zip builder (little-endian helpers on top of the big-endian Writer). */
async function buildZip(entries: { name: string; data: Uint8Array; deflate: boolean }[]): Promise<Blob> {
  const le16 = (w: Writer, v: number) => w.u8(v).u8(v >> 8);
  const le32 = (w: Writer, v: number) => w.u8(v).u8(v >> 8).u8(v >> 16).u8(v >>> 24);
  const body = new Writer();
  const central = new Writer();
  for (const e of entries) {
    const payload = e.deflate ? await deflateRaw(e.data) : e.data;
    const offset = body.pos;
    const name = new TextEncoder().encode(e.name);
    le32(body, 0x04034b50);
    le16(body, 20);
    le16(body, 0);
    le16(body, e.deflate ? 8 : 0);
    le32(body, 0);
    le32(body, 0); // crc (not checked by the reader)
    le32(body, payload.length);
    le32(body, e.data.length);
    le16(body, name.length);
    le16(body, 0);
    body.bytes(name).bytes(payload);

    le32(central, 0x02014b50);
    le16(central, 20);
    le16(central, 20);
    le16(central, 0);
    le16(central, e.deflate ? 8 : 0);
    le32(central, 0);
    le32(central, 0);
    le32(central, payload.length);
    le32(central, e.data.length);
    le16(central, name.length);
    le16(central, 0);
    le16(central, 0);
    le16(central, 0);
    le16(central, 0);
    le32(central, 0);
    le32(central, offset);
    central.bytes(name);
  }
  const cd = central.finish();
  const end = new Writer();
  le32(end, 0x06054b50);
  le16(end, 0);
  le16(end, 0);
  le16(end, entries.length);
  le16(end, entries.length);
  le32(end, cd.length);
  le32(end, body.pos);
  le16(end, 0);
  return new Blob([body.finish() as Uint8Array<ArrayBuffer>, cd as Uint8Array<ArrayBuffer>, end.finish() as Uint8Array<ArrayBuffer>]);
}

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
