import { bunzip2Headerless } from './bzip2.ts';
import { Packet } from './packet.ts';
import { isZeroKey, xteaDecrypt, type XteaKey } from './xtea.ts';

export const Compression = {
  None: 0,
  Bzip2: 1,
  Gzip: 2,
} as const;
export type Compression = (typeof Compression)[keyof typeof Compression];

/** Decompresses with the platform's streaming decompressor (Chrome 80+, Firefox 113+, Node 18+). */
export async function inflateStream(data: Uint8Array, format: 'gzip' | 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return inflateStream(data, 'gzip');
}

/**
 * Decodes a JS5 container: [compression u8][length i32]([uncompressed length i32])[payload][version u16?].
 * The bytes after the 5-byte header are XTEA-encrypted when a non-zero key is given.
 */
export async function decodeContainer(raw: Uint8Array, key?: XteaKey | null): Promise<Uint8Array> {
  const header = new Packet(raw);
  const compression = header.u8();
  const length = header.i32();
  if (length < 0 || length > raw.length) throw new Error(`container: bad length ${length}`);

  let data = raw;
  if (!isZeroKey(key)) {
    data = raw.slice();
    const encryptedEnd = 5 + length + (compression === Compression.None ? 0 : 4);
    xteaDecrypt(data, 5, Math.min(encryptedEnd, data.length), key!);
  }
  const p = new Packet(data, 5);

  if (compression === Compression.None) return p.bytes(length).slice();

  const uncompressedLength = p.i32();
  if (uncompressedLength < 0 || uncompressedLength > 64 * 1024 * 1024) {
    throw new Error(`container: bad uncompressed length ${uncompressedLength} (wrong XTEA key?)`);
  }
  const payload = p.bytes(length);
  let out: Uint8Array;
  if (compression === Compression.Bzip2) {
    out = bunzip2Headerless(payload, uncompressedLength);
  } else if (compression === Compression.Gzip) {
    out = await gunzip(payload);
  } else {
    throw new Error(`container: unsupported compression ${compression}`);
  }
  if (out.length !== uncompressedLength) {
    throw new Error(`container: expected ${uncompressedLength} bytes, got ${out.length}`);
  }
  return out;
}

/** Wraps data in an uncompressed or gzip container. Used for fixtures and for re-encoding. */
export async function encodeContainer(data: Uint8Array, compression: typeof Compression.None | typeof Compression.Gzip): Promise<Uint8Array> {
  if (compression === Compression.None) {
    const out = new Uint8Array(5 + data.length);
    out[0] = 0;
    new DataView(out.buffer).setInt32(1, data.length);
    out.set(data, 5);
    return out;
  }
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  const out = new Uint8Array(9 + gz.length);
  const view = new DataView(out.buffer);
  out[0] = Compression.Gzip;
  view.setInt32(1, gz.length);
  view.setInt32(5, data.length);
  out.set(gz, 9);
  return out;
}
