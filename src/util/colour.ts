/** Jagex 16-bit HSL: 6 bits hue, 3 bits saturation, 7 bits lightness. */

const BRIGHTNESS = 0.8;
const HSL_TO_RGB = new Int32Array(65536);

function hslToRgbFloat(h: number, s: number, l: number): number {
  let r = l;
  let g = l;
  let b = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (6 * t < 1) return p + (q - p) * 6 * t;
      if (2 * t < 1) return q;
      if (3 * t < 2) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = channel(h + 1 / 3);
    g = channel(h);
    b = channel(h - 1 / 3);
  }
  const ri = Math.round(Math.pow(r, BRIGHTNESS) * 255);
  const gi = Math.round(Math.pow(g, BRIGHTNESS) * 255);
  const bi = Math.round(Math.pow(b, BRIGHTNESS) * 255);
  return (ri << 16) | (gi << 8) | bi;
}

for (let c = 0; c < 65536; c++) {
  const h = ((c >> 10) & 63) / 64 + 1 / 128;
  const s = ((c >> 7) & 7) / 8 + 1 / 16;
  const l = (c & 127) / 128;
  HSL_TO_RGB[c] = hslToRgbFloat(h, s, l);
}

export function hslToRgb(hsl: number): number {
  return HSL_TO_RGB[hsl & 0xffff];
}

export interface Hsl {
  h: number; // 0..1
  s: number; // 0..1
  l: number; // 0..1
}

export function rgbToHsl(rgb: number): Hsl {
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

/** Packs float HSL into the 16-bit form, so terrain colours go through the same palette as models. */
export function packHsl(h: number, s: number, l: number): number {
  const hi = Math.min(63, Math.max(0, Math.floor(h * 64)));
  const si = Math.min(7, Math.max(0, Math.floor(s * 8)));
  const li = Math.min(127, Math.max(0, Math.floor(l * 128)));
  return (hi << 10) | (si << 7) | li;
}

export function rgbToHsl16(rgb: number): number {
  const { h, s, l } = rgbToHsl(rgb);
  return packHsl(h, s, l);
}

/** Adjusts the lightness of a 16-bit HSL colour (used for baked terrain lighting). */
export function shadeHsl(hsl: number, light: number): number {
  const l = Math.min(127, Math.max(2, ((hsl & 127) * light) | 0));
  return (hsl & 0xff80) | l;
}
