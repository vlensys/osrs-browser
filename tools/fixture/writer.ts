/**
 * Builds a small, valid JS5 disk cache from original content so CI and contributors can exercise the full
 * pipeline (store → containers → reference tables → configs/maps/models → renderer) without Jagex data.
 */
import { encodeContainer, Compression } from '../../src/cache/container.ts';

export class Writer {
  private buf = new Uint8Array(256);
  pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf);
    this.buf = b;
  }
  u8(v: number): this {
    this.ensure(1);
    this.buf[this.pos++] = v & 255;
    return this;
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v);
  }
  u24(v: number): this {
    return this.u8(v >> 16).u8(v >> 8).u8(v);
  }
  i32(v: number): this {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  /** Inverse of Packet.smart (values 0..32767). */
  smart(v: number): this {
    return v < 128 ? this.u8(v) : this.u16(v + 0x8000);
  }
  /** Inverse of Packet.sSmart (values -16384..16383). */
  sSmart(v: number): this {
    return v >= -64 && v < 64 ? this.u8(v + 64) : this.u16(v + 0xc000);
  }
  string(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this.u8(0);
  }
  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

/** Packs several files into one group with a single stripe. */
export function packGroup(files: Uint8Array[]): Uint8Array {
  if (files.length === 1) return files[0];
  const w = new Writer();
  for (const f of files) w.bytes(f);
  let prev = 0;
  for (const f of files) {
    w.i32(f.length - prev);
    prev = f.length;
  }
  w.u8(1);
  return w.finish();
}

export interface GroupSpec {
  id: number;
  nameHash?: number;
  files: Map<number, Uint8Array>;
}

/** Protocol 7 reference table (optionally named). */
export function encodeReferenceTable(groups: GroupSpec[], named: boolean, revision = 1): Uint8Array {
  const w = new Writer();
  const bigSmart = (v: number) => (v < 0x8000 ? w.u16(v) : w.i32(v | 0x80000000));
  w.u8(7).i32(revision).u8(named ? 1 : 0);
  const sorted = [...groups].sort((a, b) => a.id - b.id);
  bigSmart(sorted.length);
  let prev = 0;
  for (const g of sorted) {
    bigSmart(g.id - prev);
    prev = g.id;
  }
  if (named) for (const g of sorted) w.i32(g.nameHash ?? 0);
  for (let i = 0; i < sorted.length; i++) w.i32(0); // crc
  for (let i = 0; i < sorted.length; i++) w.i32(1); // version
  for (const g of sorted) bigSmart(g.files.size);
  for (const g of sorted) {
    let p = 0;
    for (const id of [...g.files.keys()].sort((a, b) => a - b)) {
      bigSmart(id - p);
      p = id;
    }
  }
  if (named) for (const g of sorted) for (let i = 0; i < g.files.size; i++) w.i32(0);
  return w.finish();
}

/** Writes dat2 + idx files for archives of (already containerised) groups. */
export class DiskStoreWriter {
  private readonly dat = new Writer();
  private readonly entries = new Map<number, Map<number, [size: number, sector: number]>>();
  private nextSector = 1;

  constructor() {
    // Sector 0 is reserved.
    this.dat.bytes(new Uint8Array(520));
  }

  write(archive: number, group: number, data: Uint8Array): void {
    const entries = this.entries.get(archive) ?? new Map();
    this.entries.set(archive, entries);
    entries.set(group, [data.length, this.nextSector]);

    const extended = group > 0xffff;
    const chunkSize = extended ? 510 : 512;
    let written = 0;
    let chunk = 0;
    while (written < data.length) {
      const sector = this.nextSector++;
      const n = Math.min(chunkSize, data.length - written);
      const next = written + n < data.length ? this.nextSector : 0;
      if (extended) this.dat.i32(group);
      else this.dat.u16(group);
      this.dat.u16(chunk).u24(next).u8(archive);
      this.dat.bytes(data.subarray(written, written + n));
      // Pad so the next sector starts on a 520-byte boundary.
      while (this.dat.pos < (sector + 1) * 520) this.dat.u8(0);
      written += n;
      chunk++;
    }
  }

  async writeArchive(archive: number, groups: GroupSpec[], named = false): Promise<void> {
    for (const g of groups) {
      const ids = [...g.files.keys()].sort((a, b) => a - b);
      const packed = packGroup(ids.map((id) => g.files.get(id)!));
      this.write(archive, g.id, await encodeContainer(packed, Compression.Gzip));
    }
    this.write(255, archive, await encodeContainer(encodeReferenceTable(groups, named), Compression.Gzip));
  }

  finish(): { dat2: Uint8Array; indexes: Map<number, Uint8Array> } {
    const out = new Map<number, Uint8Array>();
    for (const [archive, entries] of this.entries) {
      const max = Math.max(...entries.keys());
      const idx = new Writer();
      for (let g = 0; g <= max; g++) {
        const e = entries.get(g);
        idx.u24(e ? e[0] : 0).u24(e ? e[1] : 0);
      }
      out.set(archive, idx.finish());
    }
    return { dat2: this.dat.finish(), indexes: out };
  }
}
