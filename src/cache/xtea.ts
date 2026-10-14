const GOLDEN_RATIO = 0x9e3779b9 | 0;
const ROUNDS = 32;

export type XteaKey = readonly [number, number, number, number];

export function isZeroKey(key: XteaKey | undefined | null): boolean {
  return !key || (key[0] === 0 && key[1] === 0 && key[2] === 0 && key[3] === 0);
}

/** Decrypts whole 8-byte blocks of data[start, end) in place; trailing bytes are left as-is. */
export function xteaDecrypt(data: Uint8Array, start: number, end: number, key: XteaKey): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const blocks = Math.floor((end - start) / 8);
  for (let b = 0; b < blocks; b++) {
    const off = start + b * 8;
    let v0 = view.getInt32(off);
    let v1 = view.getInt32(off + 4);
    let sum = Math.imul(GOLDEN_RATIO, ROUNDS);
    for (let i = 0; i < ROUNDS; i++) {
      v1 = (v1 - ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + key[(sum >>> 11) & 3]))) | 0;
      sum = (sum - GOLDEN_RATIO) | 0;
      v0 = (v0 - ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + key[sum & 3]))) | 0;
    }
    view.setInt32(off, v0);
    view.setInt32(off + 4, v1);
  }
}

/** Inverse of {@link xteaDecrypt}; only used to build test fixtures. */
export function xteaEncrypt(data: Uint8Array, start: number, end: number, key: XteaKey): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const blocks = Math.floor((end - start) / 8);
  for (let b = 0; b < blocks; b++) {
    const off = start + b * 8;
    let v0 = view.getInt32(off);
    let v1 = view.getInt32(off + 4);
    let sum = 0;
    for (let i = 0; i < ROUNDS; i++) {
      v0 = (v0 + ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + key[sum & 3]))) | 0;
      sum = (sum + GOLDEN_RATIO) | 0;
      v1 = (v1 + ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + key[(sum >>> 11) & 3]))) | 0;
    }
    view.setInt32(off, v0);
    view.setInt32(off + 4, v1);
  }
}
