/**
 * Growable triangle-soup buffers: position (f32 x3), colour (u8 x4), pick id (u8 x4) and texture
 * coordinates (f32 x3: u, v, texture layer; layer -1 = untextured, colour only).
 */
export class MeshBuilder {
  private pos = new Float32Array(3 * 4096);
  private col = new Uint8Array(4 * 4096);
  private pick = new Uint8Array(4 * 4096);
  private tex = new Float32Array(3 * 4096);
  count = 0;

  private grow(): void {
    const cap = this.pos.length / 3;
    const pos = new Float32Array(cap * 2 * 3);
    pos.set(this.pos);
    const col = new Uint8Array(cap * 2 * 4);
    col.set(this.col);
    const pick = new Uint8Array(cap * 2 * 4);
    pick.set(this.pick);
    const tex = new Float32Array(cap * 2 * 3);
    tex.set(this.tex);
    this.pos = pos;
    this.col = col;
    this.pick = pick;
    this.tex = tex;
  }

  vertex(x: number, y: number, z: number, rgb: number, alpha: number, pickId: number, u = 0, v = 0, layer = -1): void {
    if (this.count * 3 >= this.pos.length) this.grow();
    const p = this.count * 3;
    this.pos[p] = x;
    this.pos[p + 1] = y;
    this.pos[p + 2] = z;
    const c = this.count * 4;
    this.col[c] = (rgb >> 16) & 255;
    this.col[c + 1] = (rgb >> 8) & 255;
    this.col[c + 2] = rgb & 255;
    this.col[c + 3] = alpha;
    this.pick[c] = (pickId >>> 24) & 255;
    this.pick[c + 1] = (pickId >>> 16) & 255;
    this.pick[c + 2] = (pickId >>> 8) & 255;
    this.pick[c + 3] = pickId & 255;
    this.tex[p] = u;
    this.tex[p + 1] = v;
    this.tex[p + 2] = layer;
    this.count++;
  }

  finish(): MeshData {
    return {
      vertexCount: this.count,
      positions: this.pos.slice(0, this.count * 3),
      colours: this.col.slice(0, this.count * 4),
      picks: this.pick.slice(0, this.count * 4),
      texcoords: this.tex.slice(0, this.count * 3),
    };
  }
}

export interface MeshData {
  vertexCount: number;
  positions: Float32Array;
  colours: Uint8Array;
  picks: Uint8Array;
  texcoords: Float32Array;
}

export function meshTransferables(m: MeshData): ArrayBuffer[] {
  return [m.positions.buffer as ArrayBuffer, m.colours.buffer as ArrayBuffer, m.picks.buffer as ArrayBuffer, m.texcoords.buffer as ArrayBuffer];
}

/** Pick ids: high bit set = terrain tile (plane, x, y); otherwise a loc uid; 0 = nothing. */
export const PICK_TILE = 0x80000000;

export function encodeTilePick(plane: number, x: number, y: number): number {
  return (PICK_TILE | (plane << 28) | ((x & 0x3fff) << 14) | (y & 0x3fff)) >>> 0;
}

export function decodePick(id: number): { kind: 'none' } | { kind: 'tile'; plane: number; x: number; y: number } | { kind: 'loc'; uid: number } {
  if (id === 0) return { kind: 'none' };
  if (id & PICK_TILE) return { kind: 'tile', plane: (id >>> 28) & 3, x: (id >>> 14) & 0x3fff, y: id & 0x3fff };
  return { kind: 'loc', uid: id };
}
