import { Packet } from '../cache/packet.ts';

export interface Sprite {
  /** Frame size the sprite is positioned within. */
  maxWidth: number;
  maxHeight: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  /** RGBA pixels, width * height * 4 (alpha from the alpha plane when present). */
  pixels: Uint8ClampedArray;
  /** Per pixel: 0 where the palette index is 0 (transparent), else 255. Textures use this, not the alpha plane. */
  mask: Uint8Array;
}

/**
 * Sprite groups (archive 8): palette-indexed frames described by a footer:
 * [frame data...][palette (n-1) x u24][maxW u16][maxH u16][palette size - 1 u8][x[], y[], w[], h[] as u16][count u16].
 * Each frame starts with a flags byte (bit 0 = column-major order, bit 1 = separate alpha plane).
 */
export function decodeSprites(data: Uint8Array): Sprite[] {
  const p = new Packet(data, data.length - 2);
  const count = p.u16();
  const headerStart = data.length - 7 - count * 8;
  p.pos = headerStart;
  const maxWidth = p.u16();
  const maxHeight = p.u16();
  const paletteSize = p.u8() + 1;
  const xs = Array.from({ length: count }, () => p.u16());
  const ys = Array.from({ length: count }, () => p.u16());
  const ws = Array.from({ length: count }, () => p.u16());
  const hs = Array.from({ length: count }, () => p.u16());

  p.pos = headerStart - (paletteSize - 1) * 3;
  const palette = new Int32Array(paletteSize);
  for (let i = 1; i < paletteSize; i++) {
    palette[i] = p.u24();
    if (palette[i] === 0) palette[i] = 1; // 0 is reserved for "transparent"
  }

  p.pos = 0;
  const sprites: Sprite[] = [];
  for (let s = 0; s < count; s++) {
    const w = ws[s];
    const h = hs[s];
    const n = w * h;
    const indices = new Uint8Array(n);
    const alpha = new Uint8Array(n);
    const flags = p.u8();
    const columnMajor = (flags & 1) !== 0;
    const hasAlpha = (flags & 2) !== 0;
    const at = (x: number, y: number) => y * w + x;
    if (columnMajor) {
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) indices[at(x, y)] = p.u8();
    } else {
      for (let i = 0; i < n; i++) indices[i] = p.u8();
    }
    if (hasAlpha) {
      if (columnMajor) {
        for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) alpha[at(x, y)] = p.u8();
      } else {
        for (let i = 0; i < n; i++) alpha[i] = p.u8();
      }
    } else {
      for (let i = 0; i < n; i++) alpha[i] = indices[i] === 0 ? 0 : 255;
    }
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = indices[i] === 0 ? 0 : 255;
    const pixels = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const rgb = palette[indices[i]];
      pixels[i * 4] = (rgb >> 16) & 255;
      pixels[i * 4 + 1] = (rgb >> 8) & 255;
      pixels[i * 4 + 2] = rgb & 255;
      pixels[i * 4 + 3] = alpha[i];
    }
    sprites.push({ maxWidth, maxHeight, offsetX: xs[s], offsetY: ys[s], width: w, height: h, pixels, mask });
  }
  if (p.pos > headerStart - (paletteSize - 1) * 3) throw new Error('sprite: frame data overruns palette');
  return sprites;
}
