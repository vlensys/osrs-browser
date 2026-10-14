/**
 * Reader for the on-disk JS5 store: main_file_cache.dat2 (520-byte sector chains) plus one
 * main_file_cache.idxN per archive (6-byte entries: u24 size, u24 first sector).
 */

export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** In-memory source (Node tests, small files). */
export class BufferSource implements ByteSource {
  constructor(private readonly buf: Uint8Array) {}
  get size(): number {
    return this.buf.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.buf.subarray(offset, Math.min(offset + length, this.buf.length));
  }
}

/** Lazily reads slices of a Blob/File so a ~200 MB dat2 never has to be held in memory. */
export class BlobSource implements ByteSource {
  constructor(private readonly blob: Blob) {}
  get size(): number {
    return this.blob.size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

const SECTOR_SIZE = 520;
const INDEX_ENTRY_SIZE = 6;

export class DiskStore {
  private readonly indexes = new Map<number, Uint8Array>();

  /**
   * @param dat2 the data file
   * @param indexFiles idx files keyed by archive id (255 = the master index)
   */
  constructor(
    private readonly dat2: ByteSource,
    indexFiles: Map<number, Uint8Array>,
  ) {
    for (const [archive, data] of indexFiles) this.indexes.set(archive, data);
  }

  archives(): number[] {
    return [...this.indexes.keys()].filter((a) => a !== 255).sort((a, b) => a - b);
  }

  hasArchive(archive: number): boolean {
    return this.indexes.has(archive);
  }

  groupCount(archive: number): number {
    const idx = this.indexes.get(archive);
    return idx ? Math.floor(idx.length / INDEX_ENTRY_SIZE) : 0;
  }

  /** Returns the raw (still containerised) group bytes, or null if absent. */
  async read(archive: number, group: number): Promise<Uint8Array | null> {
    const idx = this.indexes.get(archive);
    if (!idx) return null;
    const entry = group * INDEX_ENTRY_SIZE;
    if (entry + INDEX_ENTRY_SIZE > idx.length) return null;
    const size = (idx[entry] << 16) | (idx[entry + 1] << 8) | idx[entry + 2];
    let sector = (idx[entry + 3] << 16) | (idx[entry + 4] << 8) | idx[entry + 5];
    if (size === 0 || sector === 0) return null;

    const extended = group > 0xffff;
    const headerSize = extended ? 10 : 8;
    const dataPerSector = SECTOR_SIZE - headerSize;
    const out = new Uint8Array(size);
    let written = 0;
    let chunk = 0;

    // Sectors are usually contiguous, so read optimistically in one go and re-read only on a jump.
    let window: Uint8Array = new Uint8Array(0);
    let windowStart = -1;

    while (written < size) {
      if (sector <= 0 || sector * SECTOR_SIZE >= this.dat2.size) {
        throw new Error(`dat2: bad sector ${sector} for ${archive}/${group}`);
      }
      const offset = sector * SECTOR_SIZE;
      if (windowStart < 0 || offset < windowStart || offset + SECTOR_SIZE > windowStart + window.length) {
        const remainingSectors = Math.ceil((size - written) / dataPerSector);
        window = await this.dat2.read(offset, remainingSectors * SECTOR_SIZE);
        windowStart = offset;
      }
      const s = offset - windowStart;
      const h = window;
      let sGroup: number;
      let p = s;
      if (extended) {
        sGroup = ((h[p] << 24) | (h[p + 1] << 16) | (h[p + 2] << 8) | h[p + 3]) >>> 0;
        p += 4;
      } else {
        sGroup = (h[p] << 8) | h[p + 1];
        p += 2;
      }
      const sChunk = (h[p] << 8) | h[p + 1];
      const next = (h[p + 2] << 16) | (h[p + 3] << 8) | h[p + 4];
      const sArchive = h[p + 5];
      p += 6;
      if (sGroup !== group || sChunk !== chunk || sArchive !== archive) {
        throw new Error(`dat2: sector ${sector} mismatch for ${archive}/${group} chunk ${chunk}`);
      }
      const n = Math.min(dataPerSector, size - written);
      out.set(h.subarray(p, p + n), written);
      written += n;
      chunk++;
      sector = next;
    }
    return out;
  }
}
