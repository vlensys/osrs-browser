/** Minimal zip writer (stored or deflated entries) for fixtures; the reader under test lives in src/storage. */
import { Writer } from './writer.ts';

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function buildZip(entries: { name: string; data: Uint8Array; deflate: boolean }[]): Promise<Blob> {
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
