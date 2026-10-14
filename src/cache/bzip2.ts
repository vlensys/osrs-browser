/**
 * Minimal bzip2 decompressor. JS5 containers store bzip2 streams without the 4-byte "BZh?" header,
 * so {@link bunzip2Headerless} assumes level 1 (100k blocks), which is what the cache uses.
 */

class BitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(private readonly data: Uint8Array) {}

  bits(n: number): number {
    while (this.bitCount < n) {
      if (this.pos >= this.data.length) throw new Error('bzip2: unexpected end of input');
      this.bitBuf = ((this.bitBuf << 8) | this.data[this.pos++]) >>> 0;
      this.bitCount += 8;
    }
    this.bitCount -= n;
    const v = (this.bitBuf >>> this.bitCount) & ((1 << n) - 1);
    this.bitBuf &= (1 << this.bitCount) - 1;
    return v;
  }

  bit(): number {
    return this.bits(1);
  }
}

const MAX_GROUPS = 6;
const MAX_CODE_LEN = 20;
const GROUP_SIZE = 50;

export function bunzip2Headerless(data: Uint8Array, expectedLength: number): Uint8Array {
  return decodeStream(new BitReader(data), 1, expectedLength);
}

export function bunzip2(data: Uint8Array): Uint8Array {
  if (data[0] !== 0x42 || data[1] !== 0x5a || data[2] !== 0x68) throw new Error('bzip2: bad magic');
  const level = data[3] - 0x30;
  if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
  return decodeStream(new BitReader(data.subarray(4)), level, -1);
}

function decodeStream(br: BitReader, level: number, expectedLength: number): Uint8Array {
  const maxBlock = level * 100000;
  let out = new Uint8Array(expectedLength >= 0 ? expectedLength : maxBlock);
  let outPos = 0;
  const tt = new Uint32Array(maxBlock);

  const ensure = (n: number) => {
    if (outPos + n <= out.length) return;
    let cap = out.length * 2;
    while (cap < outPos + n) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(out.subarray(0, outPos));
    out = grown;
  };

  for (;;) {
    const m1 = br.bits(24);
    const m2 = br.bits(24);
    if (m1 === 0x177245 && m2 === 0x385090) {
      br.bits(32); // stream CRC
      break;
    }
    if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block magic');
    br.bits(32); // block CRC
    if (br.bit()) throw new Error('bzip2: randomised blocks are not supported');
    const origPtr = br.bits(24);

    // Symbol map.
    const used = br.bits(16);
    const seqToUnseq = new Uint8Array(256);
    let nInUse = 0;
    for (let i = 0; i < 16; i++) {
      if (used & (0x8000 >>> i)) {
        const bits = br.bits(16);
        for (let j = 0; j < 16; j++) if (bits & (0x8000 >>> j)) seqToUnseq[nInUse++] = i * 16 + j;
      }
    }
    if (nInUse === 0) throw new Error('bzip2: no symbols in use');
    const alphaSize = nInUse + 2;

    const nGroups = br.bits(3);
    if (nGroups < 2 || nGroups > MAX_GROUPS) throw new Error('bzip2: bad group count');
    const nSelectors = br.bits(15);
    if (nSelectors < 1) throw new Error('bzip2: bad selector count');

    // Selectors are MTF-coded unary numbers.
    const mtfGroups = [0, 1, 2, 3, 4, 5].slice(0, nGroups);
    const selectors = new Uint8Array(nSelectors);
    for (let i = 0; i < nSelectors; i++) {
      let j = 0;
      while (br.bit()) {
        j++;
        if (j >= nGroups) throw new Error('bzip2: bad selector');
      }
      const v = mtfGroups[j];
      mtfGroups.splice(j, 1);
      mtfGroups.unshift(v);
      selectors[i] = v;
    }

    // Delta-coded code lengths per table, converted to canonical Huffman decode tables.
    const limits: Int32Array[] = [];
    const bases: Int32Array[] = [];
    const perms: Int32Array[] = [];
    const minLens: number[] = [];
    for (let t = 0; t < nGroups; t++) {
      const lens = new Uint8Array(alphaSize);
      let cur = br.bits(5);
      for (let s = 0; s < alphaSize; s++) {
        for (;;) {
          if (cur < 1 || cur > MAX_CODE_LEN) throw new Error('bzip2: bad code length');
          if (!br.bit()) break;
          cur += br.bit() ? -1 : 1;
        }
        lens[s] = cur;
      }
      let minLen = 32;
      let maxLen = 0;
      for (let s = 0; s < alphaSize; s++) {
        if (lens[s] > maxLen) maxLen = lens[s];
        if (lens[s] < minLen) minLen = lens[s];
      }
      const perm = new Int32Array(alphaSize);
      let pp = 0;
      for (let l = minLen; l <= maxLen; l++) for (let s = 0; s < alphaSize; s++) if (lens[s] === l) perm[pp++] = s;
      const count = new Int32Array(MAX_CODE_LEN + 2);
      for (let s = 0; s < alphaSize; s++) count[lens[s]]++;
      const limit = new Int32Array(MAX_CODE_LEN + 2).fill(-1);
      const base = new Int32Array(MAX_CODE_LEN + 2);
      let code = 0;
      let idx = 0;
      for (let l = minLen; l <= maxLen; l++) {
        base[l] = idx - code; // perm index = code + base[l]
        code += count[l];
        idx += count[l];
        limit[l] = code - 1;
        code <<= 1;
      }
      limits.push(limit);
      bases.push(base);
      perms.push(perm);
      minLens.push(minLen);
    }

    // Huffman + RUNA/RUNB + MTF decode into tt[], counting byte frequencies for the inverse BWT.
    const mtf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) mtf[i] = i;
    const unzftab = new Int32Array(256);
    const EOB = nInUse + 1;
    let nblock = 0;
    let groupIdx = -1;
    let groupLeft = 0;
    let limit = limits[0];
    let base = bases[0];
    let perm = perms[0];
    let minLen = minLens[0];
    let runLength = 0;
    let runWeight = 1;

    const nextSym = (): number => {
      if (groupLeft === 0) {
        groupIdx++;
        if (groupIdx >= nSelectors) throw new Error('bzip2: ran out of selectors');
        const g = selectors[groupIdx];
        limit = limits[g];
        base = bases[g];
        perm = perms[g];
        minLen = minLens[g];
        groupLeft = GROUP_SIZE;
      }
      groupLeft--;
      let len = minLen;
      let code = br.bits(len);
      while (len <= MAX_CODE_LEN) {
        if (code <= limit[len]) return perm[code + base[len]];
        code = (code << 1) | br.bit();
        len++;
      }
      throw new Error('bzip2: bad Huffman code');
    };

    const flushRun = () => {
      if (runLength === 0) return;
      const b = seqToUnseq[mtf[0]];
      if (nblock + runLength > maxBlock) throw new Error('bzip2: block overflow');
      unzftab[b] += runLength;
      for (let i = 0; i < runLength; i++) tt[nblock++] = b;
      runLength = 0;
      runWeight = 1;
    };

    for (;;) {
      const sym = nextSym();
      if (sym === 0 || sym === 1) {
        // RUNA / RUNB: bijective base-2 run length of the front MTF symbol.
        runLength += (sym + 1) * runWeight;
        runWeight <<= 1;
        continue;
      }
      flushRun();
      if (sym === EOB) break;
      const k = sym - 1;
      const v = mtf[k];
      mtf.copyWithin(1, 0, k);
      mtf[0] = v;
      const b = seqToUnseq[v];
      if (nblock >= maxBlock) throw new Error('bzip2: block overflow');
      unzftab[b]++;
      tt[nblock++] = b;
    }
    if (origPtr >= nblock) throw new Error('bzip2: bad origPtr');

    // Inverse BWT: tt[cftab[b]++] |= i << 8 links each position to its successor.
    const cftab = new Int32Array(256);
    for (let i = 0, sum = 0; i < 256; i++) {
      cftab[i] = sum;
      sum += unzftab[i];
    }
    for (let i = 0; i < nblock; i++) {
      const b = tt[i] & 0xff;
      tt[cftab[b]++] |= i << 8;
    }

    // Walk the chain and undo the initial run-length encoding (4 equal bytes + count).
    let p = tt[origPtr] >>> 8;
    let last = -1;
    let same = 0;
    for (let i = 0; i < nblock; i++) {
      const entry = tt[p];
      const b = entry & 0xff;
      p = entry >>> 8;
      if (same === 4) {
        ensure(b);
        out.fill(last, outPos, outPos + b);
        outPos += b;
        same = 0;
        last = -1;
        continue;
      }
      if (b === last) same++;
      else {
        same = 1;
        last = b;
      }
      ensure(1);
      out[outPos++] = b;
    }
  }

  if (expectedLength >= 0 && outPos !== expectedLength) {
    throw new Error(`bzip2: expected ${expectedLength} bytes, got ${outPos}`);
  }
  return outPos === out.length ? out : out.slice(0, outPos);
}
