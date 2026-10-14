/**
 * Big-endian byte reader with the variable-length integer encodings used throughout the cache.
 */
export class Packet {
  readonly data: Uint8Array;
  pos: number;

  constructor(data: Uint8Array, pos = 0) {
    this.data = data;
    this.pos = pos;
  }

  get length(): number {
    return this.data.length;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  private check(n: number): void {
    if (this.pos + n > this.data.length) {
      throw new RangeError(`read of ${n} byte(s) at ${this.pos} past end (${this.data.length})`);
    }
  }

  u8(): number {
    this.check(1);
    return this.data[this.pos++];
  }

  i8(): number {
    return (this.u8() << 24) >> 24;
  }

  peekU8(): number {
    this.check(1);
    return this.data[this.pos];
  }

  u16(): number {
    this.check(2);
    const d = this.data;
    const v = (d[this.pos] << 8) | d[this.pos + 1];
    this.pos += 2;
    return v;
  }

  i16(): number {
    return (this.u16() << 16) >> 16;
  }

  u24(): number {
    this.check(3);
    const d = this.data;
    const v = (d[this.pos] << 16) | (d[this.pos + 1] << 8) | d[this.pos + 2];
    this.pos += 3;
    return v;
  }

  i32(): number {
    this.check(4);
    const d = this.data;
    const v = (d[this.pos] << 24) | (d[this.pos + 1] << 16) | (d[this.pos + 2] << 8) | d[this.pos + 3];
    this.pos += 4;
    return v;
  }

  u32(): number {
    return this.i32() >>> 0;
  }

  /** 1 byte if < 128 (value), else 2 bytes (value - 32768). */
  smart(): number {
    return this.peekU8() < 128 ? this.u8() : this.u16() - 0x8000;
  }

  /** Signed smart: 1 byte (value - 64) or 2 bytes (value - 49152). */
  sSmart(): number {
    return this.peekU8() < 128 ? this.u8() - 64 : this.u16() - 0xc000;
  }

  /** 2 bytes if the top bit is clear, else 4 bytes with the top bit masked. Used by protocol 7 reference tables. */
  bigSmart(): number {
    return this.peekU8() < 128 ? this.u16() : this.i32() & 0x7fffffff;
  }

  /** Like {@link bigSmart} but 0x7fff in the short form means "none" (-1). */
  bigSmartNullable(): number {
    if (this.peekU8() < 128) {
      const v = this.u16();
      return v === 0x7fff ? -1 : v;
    }
    return this.i32() & 0x7fffffff;
  }

  /** Repeated 1/2-byte smarts summed while each part equals 32767. */
  extendedSmart(): number {
    let total = 0;
    let part = this.smart();
    while (part === 0x7fff) {
      total += 0x7fff;
      part = this.smart();
    }
    return total + part;
  }

  /** u16 where 65535 means -1. */
  u16Nullable(): number {
    const v = this.u16();
    return v === 0xffff ? -1 : v;
  }

  /** NUL-terminated CP-1252 string. */
  string(): string {
    const start = this.pos;
    const d = this.data;
    while (this.pos < d.length && d[this.pos] !== 0) this.pos++;
    if (this.pos >= d.length) throw new RangeError('unterminated string');
    const s = decodeCp1252(d, start, this.pos);
    this.pos++;
    return s;
  }

  bytes(n: number): Uint8Array {
    this.check(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    this.check(n);
    this.pos += n;
  }
}

const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

export function decodeCp1252(d: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) {
    const c = d[i];
    if (c >= 0x80 && c < 0xa0) {
      const m = CP1252_HIGH[c - 0x80];
      s += String.fromCharCode(m === 0 ? 0x3f : m);
    } else {
      s += String.fromCharCode(c);
    }
  }
  return s;
}

/** Java-style String.hashCode over lowercase chars; used for group/file names in reference tables. */
export function nameHash(name: string): number {
  let h = 0;
  const s = name.toLowerCase();
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
