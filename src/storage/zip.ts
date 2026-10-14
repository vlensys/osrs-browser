/** A file inside a zip archive, extracted lazily. */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
  extract(): Promise<Blob>;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

async function readBytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/**
 * Reads a zip's central directory from a Blob (only the tail is loaded). Supports stored and
 * deflated entries plus Zip64, which is enough for OpenRS2's "disk.zip" downloads.
 */
export async function readZip(blob: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await readBytes(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end of central directory)');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== ZIP64_LOCATOR_SIG) throw new Error('Zip64 locator missing');
    const z64Off = Number(tail.getBigUint64(loc + 8, true));
    const z64 = await readBytes(blob, z64Off, z64Off + 56);
    if (z64.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new Error('Zip64 end record missing');
    count = Number(z64.getBigUint64(32, true));
    cdSize = Number(z64.getBigUint64(40, true));
    cdOffset = Number(z64.getBigUint64(48, true));
  }

  const cd = await readBytes(blob, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== CENTRAL_SIG) throw new Error('Corrupt zip central directory');
    const method = cd.getUint16(p + 10, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localOffset = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // Zip64 extended information extra field.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = Number(cd.getBigUint64(q, true))), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = Number(cd.getBigUint64(q, true))), (q += 8);
        if (localOffset === 0xffffffff) localOffset = Number(cd.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    p = extraEnd + commentLen;
    if (name.endsWith('/')) continue;

    const entryCompressed = compressedSize;
    const entryOffset = localOffset;
    entries.push({
      name,
      compressedSize,
      size,
      async extract(): Promise<Blob> {
        const local = await readBytes(blob, entryOffset, entryOffset + 30);
        if (local.getUint32(0, true) !== LOCAL_SIG) throw new Error(`Corrupt zip entry ${name}`);
        const dataStart = entryOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        const raw = blob.slice(dataStart, dataStart + entryCompressed);
        if (method === 0) return raw;
        if (method !== 8) throw new Error(`Unsupported zip compression method ${method} for ${name}`);
        // Stream-inflate straight into a Blob so large entries never need to fit in one ArrayBuffer.
        const out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        if (out.size !== size) throw new Error(`Zip entry ${name}: expected ${size} bytes, got ${out.size}`);
        return out;
      },
    });
  }
  return entries;
}

