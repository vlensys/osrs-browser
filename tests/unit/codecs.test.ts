import { describe, expect, it } from 'vitest';
import { bunzip2, bunzip2Headerless } from '../../src/cache/bzip2.ts';
import { Compression, decodeContainer, encodeContainer } from '../../src/cache/container.ts';
import { nameHash, Packet } from '../../src/cache/packet.ts';
import { xteaDecrypt, xteaEncrypt, type XteaKey } from '../../src/cache/xtea.ts';
import { Writer } from '../../tools/fixture/writer.ts';

// bzip2 -1 of an original test string (generated with Python's bz2 module).
const BZ2 =
  'QlpoMTFBWSZTWbxRoQUAAWZ/////////////////////////////////////////////wAIuKAgQ//1VVAAAAAAAAAAAAAAAAAAAAAAmATAAAAAAAAAAAAAABMAATACTAATAAEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASYACYAAmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiqimmmJhNMpphMTQ0YaTAmJibQmNAT0mmmATQxpppMGk21GUMBMAJiYJkwBBhNMCZMmQBgmACYEDRkwAjBCQ/yAgaCIKgyDoQhKFIWhiGoch6IIiiSJooiqLIujCMo00Noj4TRWjNHfDaf4jAVCvAJLAJUJsBIICTACS4CYABJoBIYBKY01kmnPktPag1FqTU2qM5VWQYQCTICeW0FrDWWtPmNbZNrjXWvPmtfbA2FlGkqUpaRiAgJPTErU1TlPVBUVSVNVFVVZV1YVlWlbVxXW5PpNzfTfUfVbo3VuzLN3ZdvDMM2AkIASEAl7b4AnkAJAYACWQBIV+ZUASCAkmAkkw6CSoCTxmWHAS0AK39iWEAkEBMAzTFgCRoCRwCQwCQmKASNASHYydgJAASPASeseAkoAkQ2IBIkASHZFiAEjAEwLGAJQAEjgEiXwAEggJFACQWRcEzoBIsBJtiGQAScZVnLgwX2H2X2nBuEcK4Zw7iHCsMw7EMSxTFsY/1jWOY9kGRZJk2UZVlmXZhmWaZtnGdZ5n2gaFomjaRpWmadqGpapq2sa1rmvbBsWybNtG1bZt24blum7bxvW+b9wHBcJw3EcVxnHchyXKctzHNc5z3QdF0nTdR1XWdd2HZdp23cd13nfeB4XieN5Hlf88zzvQ9L1PW9j2vc974Pi+T5vo/99X2fd+H5fp+38f0XckU4UJC8UaEF';

function bz2Plain(): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const line = enc.encode('A browser-only engine walks the cobbled path past the mill. ');
  for (let i = 0; i < 40; i++) parts.push(...line);
  for (let r = 0; r < 3; r++) for (let b = 0; b < 256; b++) parts.push(b);
  parts.push(...enc.encode('z'.repeat(48) + ' end'));
  return Uint8Array.from(parts);
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe('Packet', () => {
  it('round-trips smarts, signed smarts and strings', () => {
    const w = new Writer();
    const smarts = [0, 1, 127, 128, 300, 32767];
    const signed = [-64, -1, 0, 63, 64, -65, 16000, -16000];
    for (const v of smarts) w.smart(v);
    for (const v of signed) w.sSmart(v);
    w.string('Climb-up').i32(-5).u24(0xabcdef);
    const p = new Packet(w.finish());
    expect(smarts.map(() => p.smart())).toEqual(smarts);
    expect(signed.map(() => p.sSmart())).toEqual(signed);
    expect(p.string()).toBe('Climb-up');
    expect(p.i32()).toBe(-5);
    expect(p.u24()).toBe(0xabcdef);
    expect(p.remaining).toBe(0);
    expect(() => p.u8()).toThrow(RangeError);
  });

  it('reads bigSmart and extendedSmart', () => {
    const p = new Packet(Uint8Array.of(0x00, 0x05, 0x80, 0x01, 0x00, 0x00, 0xff, 0xff, 0x03));
    expect(p.bigSmart()).toBe(5);
    expect(p.bigSmart()).toBe(0x10000);
    expect(p.extendedSmart()).toBe(0x7fff + 3);
  });

  it('hashes names like the cache', () => {
    expect(nameHash('m50_50')).toBe(nameHash('M50_50'));
    expect(nameHash('a')).toBe(97);
    expect(nameHash('ab')).toBe(97 * 31 + 98);
  });
});

describe('XTEA', () => {
  const key: XteaKey = [0x00010203, 0x04050607, 0x08090a0b, 0x0c0d0e0f];

  it('matches the reference test vector', () => {
    const block = Uint8Array.of(0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48);
    xteaEncrypt(block, 0, 8, key);
    expect([...block].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe('497df3d072612cb5');
    xteaDecrypt(block, 0, 8, key);
    expect(new TextDecoder().decode(block)).toBe('ABCDEFGH');
  });

  it('leaves a trailing partial block untouched', () => {
    const data = Uint8Array.from({ length: 21 }, (_, i) => i);
    const copy = data.slice();
    xteaEncrypt(data, 0, data.length, key);
    expect([...data.subarray(16)]).toEqual([...copy.subarray(16)]);
    xteaDecrypt(data, 0, data.length, key);
    expect([...data]).toEqual([...copy]);
  });
});

describe('bzip2', () => {
  it('decodes a standard stream', () => {
    expect(bunzip2(fromB64(BZ2))).toEqual(bz2Plain());
  });

  it('decodes the headerless form used in JS5 containers', () => {
    const plain = bz2Plain();
    expect(bunzip2Headerless(fromB64(BZ2).subarray(4), plain.length)).toEqual(plain);
  });

  it('rejects corrupt input', () => {
    const bad = fromB64(BZ2);
    bad[20] ^= 0xff;
    expect(() => bunzip2(bad)).toThrow();
  });
});

describe('containers', () => {
  it('round-trips uncompressed and gzip containers', async () => {
    const data = new TextEncoder().encode('hello cache '.repeat(100));
    for (const c of [Compression.None, Compression.Gzip] as const) {
      expect(await decodeContainer(await encodeContainer(data, c))).toEqual(data);
    }
  });

  it('decodes bzip2 containers', async () => {
    const plain = bz2Plain();
    const payload = fromB64(BZ2).subarray(4);
    const w = new Writer().u8(Compression.Bzip2).i32(payload.length).i32(plain.length).bytes(payload);
    expect(await decodeContainer(w.finish())).toEqual(plain);
  });

  it('decrypts XTEA-encrypted containers', async () => {
    const key: XteaKey = [1, -2, 3, -4];
    const data = new TextEncoder().encode('secret map locations '.repeat(10));
    const raw = await encodeContainer(data, Compression.Gzip);
    xteaEncrypt(raw, 5, raw.length, key);
    expect(await decodeContainer(raw, key)).toEqual(data);
    await expect(decodeContainer(raw)).rejects.toThrow();
  });
});
