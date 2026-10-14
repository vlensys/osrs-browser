import { Packet } from './packet.ts';

export interface GroupEntry {
  id: number;
  nameHash: number;
  crc: number;
  version: number;
  fileIds: Int32Array;
  fileNameHashes: Int32Array | null;
}

/** The per-archive index (archive 255, group = archive id) listing groups and the files inside them. */
export class ReferenceTable {
  readonly groups = new Map<number, GroupEntry>();
  private readonly byName = new Map<number, number>();

  constructor(
    readonly protocol: number,
    readonly revision: number,
    readonly named: boolean,
  ) {}

  static decode(data: Uint8Array): ReferenceTable {
    const p = new Packet(data);
    const protocol = p.u8();
    if (protocol < 5 || protocol > 7) throw new Error(`reference table: unsupported protocol ${protocol}`);
    const revision = protocol >= 6 ? p.i32() : 0;
    const flags = p.u8();
    const named = (flags & 0x1) !== 0;
    const digests = (flags & 0x2) !== 0;
    const lengths = (flags & 0x4) !== 0;
    const uncompressedCrcs = (flags & 0x8) !== 0;
    const readCount = () => (protocol >= 7 ? p.bigSmart() : p.u16());

    const count = readCount();
    const ids = new Int32Array(count);
    for (let i = 0, acc = 0; i < count; i++) ids[i] = acc += readCount();

    const nameHashes = new Int32Array(count);
    if (named) for (let i = 0; i < count; i++) nameHashes[i] = p.i32();
    const crcs = new Int32Array(count);
    for (let i = 0; i < count; i++) crcs[i] = p.i32();
    if (uncompressedCrcs) p.skip(4 * count);
    if (digests) p.skip(64 * count);
    if (lengths) p.skip(8 * count);
    const versions = new Int32Array(count);
    for (let i = 0; i < count; i++) versions[i] = p.i32();
    const fileCounts = new Int32Array(count);
    for (let i = 0; i < count; i++) fileCounts[i] = readCount();

    const fileIds: Int32Array[] = [];
    for (let i = 0; i < count; i++) {
      const f = new Int32Array(fileCounts[i]);
      for (let j = 0, acc = 0; j < f.length; j++) f[j] = acc += readCount();
      fileIds.push(f);
    }
    const fileNames: (Int32Array | null)[] = [];
    for (let i = 0; i < count; i++) {
      if (!named) {
        fileNames.push(null);
        continue;
      }
      const f = new Int32Array(fileCounts[i]);
      for (let j = 0; j < f.length; j++) f[j] = p.i32();
      fileNames.push(f);
    }

    const table = new ReferenceTable(protocol, revision, named);
    for (let i = 0; i < count; i++) {
      const entry: GroupEntry = {
        id: ids[i],
        nameHash: nameHashes[i],
        crc: crcs[i],
        version: versions[i],
        fileIds: fileIds[i],
        fileNameHashes: fileNames[i],
      };
      table.groups.set(entry.id, entry);
      if (named) table.byName.set(entry.nameHash, entry.id);
    }
    return table;
  }

  groupIdByNameHash(hash: number): number {
    return this.byName.get(hash) ?? -1;
  }

  /** Highest file id + 1 in a group (config groups are dense, so this is the definition count). */
  fileCapacity(group: number): number {
    const g = this.groups.get(group);
    if (!g || g.fileIds.length === 0) return 0;
    return g.fileIds[g.fileIds.length - 1] + 1;
  }
}

/**
 * Splits a decoded multi-file group. Layout: [stripe data...][stripes * files * i32 size deltas][stripes u8].
 */
export function splitGroup(data: Uint8Array, fileCount: number): Uint8Array[] {
  if (fileCount === 1) return [data];
  const stripes = data[data.length - 1];
  const tableStart = data.length - 1 - stripes * fileCount * 4;
  if (tableStart < 0) throw new Error('group: bad stripe table');
  const p = new Packet(data, tableStart);
  const sizes = new Int32Array(fileCount);
  const stripeSizes: Int32Array[] = [];
  for (let s = 0; s < stripes; s++) {
    const row = new Int32Array(fileCount);
    let size = 0;
    for (let f = 0; f < fileCount; f++) {
      size += p.i32();
      row[f] = size;
      sizes[f] += size;
    }
    stripeSizes.push(row);
  }
  const out = Array.from({ length: fileCount }, (_, f) => new Uint8Array(sizes[f]));
  const written = new Int32Array(fileCount);
  let pos = 0;
  for (let s = 0; s < stripes; s++) {
    for (let f = 0; f < fileCount; f++) {
      const n = stripeSizes[s][f];
      out[f].set(data.subarray(pos, pos + n), written[f]);
      written[f] += n;
      pos += n;
    }
  }
  return out;
}
