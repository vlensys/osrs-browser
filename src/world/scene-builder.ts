import { Archive } from '../cache/cache.ts';
import type { LocDef } from '../defs/config.ts';
import { TileFlag, tileIndex } from '../defs/mapsquare.ts';
import { decodeModel, type ModelData } from '../defs/model.ts';
import { hslToRgb, rgbToHsl16, shadeHsl } from '../util/colour.ts';
import { encodeTilePick, MeshBuilder, type MeshData } from './mesh.ts';
import { isWallDecor, LocType, type LocInstance, type Square, type World } from './world.ts';

/** GL space: x = world x (tiles), y = up (tiles), z = -world y. 128 model units per tile. */
const UNIT = 1 / 128;
const INVISIBLE_RGB = 0xff00ff;

export interface SquareMeshes {
  rx: number;
  ry: number;
  /** One opaque and one translucent mesh per data plane. */
  planes: { opaque: MeshData; translucent: MeshData }[];
  /** 256x256 RGBA minimap per plane (4 px per tile, north up). */
  minimaps: Uint8ClampedArray[];
}

// Overlay shapes on a 3x3 grid of tile points, as triangles (overlay part, rest is underlay).
// Point indices: 0=SW 1=S 2=SE 3=E 4=NE 5=N 6=NW 7=W 8=centre.
const PX = [0, 0.5, 1, 1, 1, 0.5, 0, 0, 0.5];
const PY = [0, 0, 0, 0.5, 1, 1, 1, 0.5, 0.5];
type Tri = [number, number, number];
const FULL: Tri[] = [
  [0, 2, 4],
  [0, 4, 6],
];
// Each shape's overlay region (rotation 0) was fitted to the cache itself: for every (shape, rotation) we
// measured which neighbouring tiles carry the same overlay, so the overlay part reaches exactly those edges.
const TRI_W_S: Tri[] = [[0, 2, 6]];
const TRI_W_N: Tri[] = [[0, 4, 6]];
const TRI_N_E: Tri[] = [[6, 4, 2]];
const TRI_E_S: Tri[] = [[0, 2, 4]];
const SMALL_SW: Tri[] = [[0, 1, 7]];
const ALL_BUT_SW: Tri[] = [
  [1, 2, 4],
  [1, 4, 6],
  [1, 6, 7],
];
const SHAPES: { over: Tri[]; under: Tri[] }[] = [
  { over: FULL, under: [] },
  { over: TRI_W_S, under: [[2, 4, 6]] },
  { over: TRI_W_N, under: TRI_E_S },
  { over: TRI_N_E, under: [[6, 2, 0]] },
  { over: [[0, 2, 8], [2, 4, 8], [4, 6, 8]], under: [[0, 8, 6]] }, // all but a west wedge
  { over: [[0, 8, 6], [0, 2, 8], [4, 6, 8]], under: [[2, 4, 8]] }, // all but an east wedge
  { over: [[0, 1, 5], [0, 5, 6]], under: [[1, 2, 4], [1, 4, 5]] }, // west half
  { over: SMALL_SW, under: ALL_BUT_SW },
  { over: ALL_BUT_SW, under: SMALL_SW },
  { over: TRI_W_N, under: TRI_E_S },
  { over: TRI_E_S, under: TRI_W_N },
  { over: ALL_BUT_SW, under: SMALL_SW },
  { over: SMALL_SW, under: ALL_BUT_SW },
];

/** Rotates a ring point clockwise (viewed from above) by `r` quarter turns; the ring runs counter-clockwise. */
function rotatePoint(i: number, r: number): number {
  return i === 8 ? 8 : (i - r * 2 + 8) % 8;
}

/**
 * Texture coordinates for a face's corners by projecting them onto the plane spanned by the mapping
 * triangle: P is the texture origin, P→M the u axis and P→N the v axis (affine, so textures tile).
 */
function planarUv(px: Float32Array, py: Float32Array, pz: Float32Array, P: number, M: number, N: number, corners: number[]): number[] {
  const ex = px[M] - px[P];
  const ey = py[M] - py[P];
  const ez = pz[M] - pz[P];
  const fx = px[N] - px[P];
  const fy = py[N] - py[P];
  const fz = pz[N] - pz[P];
  // Solve d = u·e + v·f in the least-squares sense (Gram matrix of the two axes).
  const ee = ex * ex + ey * ey + ez * ez;
  const ff = fx * fx + fy * fy + fz * fz;
  const ef = ex * fx + ey * fy + ez * fz;
  const det = ee * ff - ef * ef;
  const out: number[] = [];
  for (const c of corners) {
    const dx = px[c] - px[P];
    const dy = py[c] - py[P];
    const dz = pz[c] - pz[P];
    const de = dx * ex + dy * ey + dz * ez;
    const df = dx * fx + dy * fy + dz * fz;
    if (Math.abs(det) < 1e-12) {
      out.push(0, 0);
      continue;
    }
    out.push((de * ff - df * ef) / det, (df * ee - de * ef) / det);
  }
  return out;
}

export class SceneBuilder {
  private readonly models = new Map<number, ModelData | null>();
  private readonly light: [number, number, number];

  constructor(readonly world: World) {
    // The game lights scenes from model-space (-50, -10, -50): west, slightly above, south. In GL space
    // (y up, z = -north) that is (-50, 10, 50).
    const l = [-50, 10, 50];
    const n = Math.hypot(l[0], l[1], l[2]);
    this.light = [l[0] / n, l[1] / n, l[2] / n];
  }

  async model(id: number): Promise<ModelData | null> {
    if (this.models.has(id)) return this.models.get(id)!;
    let m: ModelData | null = null;
    try {
      const data = await this.world.cache.groupData(Archive.Models, id);
      if (data) m = decodeModel(data);
    } catch {
      m = null;
    }
    if (this.models.size > 6000) this.models.clear();
    this.models.set(id, m);
    return m;
  }

  /** Resolves the active loc id for multi-locs (varbit-driven variants) using default state 0. */
  resolve(def: LocDef): LocDef | undefined {
    if (!def.multiLocs) return def;
    const id = def.multiLocs[0] !== -1 ? def.multiLocs[0] : def.multiLocs[def.multiLocs.length - 1];
    return id === -1 ? undefined : this.world.locDef(id);
  }

  /** Model ids for a loc type, following the cache's typed/untyped model lists. */
  modelIdsFor(def: LocDef, type: number): number[] {
    if (!def.models) return [];
    const t = type === LocType.CentrepieceDiagonal ? LocType.Centrepiece : isWallDecor(type) ? LocType.WallDecorStraight : type;
    if (!def.modelTypes) return t === LocType.Centrepiece ? [...def.models] : [];
    const out: number[] = [];
    for (let i = 0; i < def.models.length; i++) if (def.modelTypes[i] === t) out.push(def.models[i]);
    return out;
  }

  async build(sq: Square): Promise<SquareMeshes> {
    // Prefetch every model this square needs so the build itself is synchronous.
    const needed = new Set<number>();
    for (const loc of sq.locs) {
      const def = this.world.locDef(loc.id);
      const active = def && this.resolve(def);
      if (active) for (const m of this.modelIdsFor(active, loc.type)) needed.add(m);
    }
    await Promise.all([...needed].map((m) => this.model(m)));

    // Meshes are grouped by *walkable* plane: on bridge tiles the data one plane up belongs to the plane
    // below (and what's under the bridge stays on plane 0), so hiding upper floors never hides bridges.
    const planes: SquareMeshes['planes'] = [];
    for (let level = 0; level < 4; level++) {
      const opaque = new MeshBuilder();
      const translucent = new MeshBuilder();
      for (let z = level; z <= Math.min(3, level + 1); z++) this.buildTerrain(sq, z, level, opaque);
      for (const loc of sq.locs) if (Math.max(0, loc.plane) === level) this.buildLoc(loc, opaque, translucent);
      planes.push({ opaque: opaque.finish(), translucent: translucent.finish() });
    }
    const minimaps = [0, 1, 2, 3].map((z) => this.buildMinimap(sq, z));
    return { rx: sq.rx, ry: sq.ry, planes, minimaps };
  }

  // --- terrain -------------------------------------------------------------------------------

  private underlayRgb(z: number, x: number, y: number): number {
    const sq = this.world.square(x >> 6, y >> 6);
    if (!sq) return -1;
    const u = sq.terrain.underlay[tileIndex(z, x & 63, y & 63)];
    if (u === 0) return -1;
    return this.world.configs.underlay(u - 1)?.rgb ?? -1;
  }

  /** Averages underlay colours over an 11x11 window, matching the game's soft ground blending. */
  private blendedUnderlay(z: number, baseX: number, baseY: number): Int32Array {
    const size = 66; // tiles -1..64 (corners need the neighbour on each side)
    const out = new Int32Array(size * size).fill(-1);
    const R = 5;
    const w = size + 2 * R;
    const rs = new Float64Array(w * w);
    const gs = new Float64Array(w * w);
    const bs = new Float64Array(w * w);
    const ns = new Float64Array(w * w);
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < w; j++) {
        const rgb = this.underlayRgb(z, baseX - 1 - R + i, baseY - 1 - R + j);
        if (rgb < 0) continue;
        const k = i * w + j;
        rs[k] = (rgb >> 16) & 255;
        gs[k] = (rgb >> 8) & 255;
        bs[k] = rgb & 255;
        ns[k] = 1;
      }
    }
    // Summed-area tables make the window average O(1) per tile.
    const sat = (a: Float64Array) => {
      const s = new Float64Array((w + 1) * (w + 1));
      for (let i = 0; i < w; i++) for (let j = 0; j < w; j++) s[(i + 1) * (w + 1) + j + 1] = a[i * w + j] + s[i * (w + 1) + j + 1] + s[(i + 1) * (w + 1) + j] - s[i * (w + 1) + j];
      return s;
    };
    const [sr, sg, sb, sn] = [sat(rs), sat(gs), sat(bs), sat(ns)];
    const box = (s: Float64Array, i0: number, j0: number, i1: number, j1: number) =>
      s[i1 * (w + 1) + j1] - s[i0 * (w + 1) + j1] - s[i1 * (w + 1) + j0] + s[i0 * (w + 1) + j0];
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const n = box(sn, i, j, i + 2 * R + 1, j + 2 * R + 1);
        if (n === 0) continue;
        const r = box(sr, i, j, i + 2 * R + 1, j + 2 * R + 1) / n;
        const g = box(sg, i, j, i + 2 * R + 1, j + 2 * R + 1) / n;
        const b = box(sb, i, j, i + 2 * R + 1, j + 2 * R + 1) / n;
        out[i * size + j] = rgbToHsl16((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b));
      }
    }
    return out;
  }

  private overlayHsl(id: number): number {
    const def = this.world.configs.overlay(id);
    if (!def) return -1;
    if (def.texture >= 0) {
      const tex = this.world.configs.texture(def.texture);
      if (tex) return tex.averageRgb;
    }
    if (def.rgb === INVISIBLE_RGB) return -1;
    return rgbToHsl16(def.rgb);
  }

  /** Terrain lightness multiplier at a tile corner: ambient 96/128 plus a diffuse term from the height field. */
  private tileLight(z: number, x: number, y: number): number {
    const w = this.world;
    const dx = w.cornerHeight(z, x + 1, y) - w.cornerHeight(z, x - 1, y);
    const dy = w.cornerHeight(z, x, y + 1) - w.cornerHeight(z, x, y - 1);
    // Height-field normal in GL space (heights are negative-up, 128 units per tile, central differences).
    const nx = dx / 256;
    const nz = dy / 256;
    const len = Math.hypot(nx, 1, nz);
    const [lx, ly, lz] = this.light;
    const cos = (nx * lx + ly + nz * lz) / len;
    return Math.min(126, Math.max(2, 96 + 80 * cos)) / 128;
  }

  private buildTerrain(sq: Square, z: number, level: number, mesh: MeshBuilder): void {
    const t = sq.terrain;
    const baseX = sq.rx * 64;
    const baseY = sq.ry * 64;
    const blend = this.blendedUnderlay(z, baseX, baseY);
    const B = 66;
    const w = this.world;
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        const i = tileIndex(z, x, y);
        const under = t.underlay[i];
        const over = t.overlay[i];
        if (under === 0 && over === 0) continue;
        const wx = baseX + x;
        const wy = baseY + y;
        const bridged = (t.settings[tileIndex(1, x, y)] & TileFlag.Bridge) !== 0;
        const walkPlane = Math.max(0, bridged ? z - 1 : z);
        if (walkPlane !== level) continue;
        const pick = encodeTilePick(walkPlane, wx, wy);
        const h = [w.cornerHeight(z, wx, wy), w.cornerHeight(z, wx + 1, wy), w.cornerHeight(z, wx + 1, wy + 1), w.cornerHeight(z, wx, wy + 1)];
        const heightAt = (px: number, py: number) => {
          const a = h[0] + (h[1] - h[0]) * px;
          const b = h[3] + (h[2] - h[3]) * px;
          return a + (b - a) * py;
        };
        // Underlay colour per corner from the blended grid, lit per corner.
        const cornerHsl = (cx: number, cy: number) => {
          const v = blend[(cx + 1) * B + (cy + 1)];
          if (v < 0) return -1;
          return shadeHsl(v, this.tileLight(z, baseX + cx, baseY + cy));
        };
        const uc = under ? [cornerHsl(x, y), cornerHsl(x + 1, y), cornerHsl(x + 1, y + 1), cornerHsl(x, y + 1)] : null;
        const underAt = (px: number, py: number) => {
          if (!uc || uc[0] < 0) return -1;
          // Bilinear in RGB space between the four corners.
          const c = uc.map((v) => hslToRgb(v < 0 ? uc[0] : v));
          const mix = (s: number) => {
            const ch = (k: number) => (c[k] >> s) & 255;
            const a = ch(0) + (ch(1) - ch(0)) * px;
            const b = ch(3) + (ch(2) - ch(3)) * px;
            return Math.round(a + (b - a) * py);
          };
          return (mix(16) << 16) | (mix(8) << 8) | mix(0);
        };

        const shape = over ? SHAPES[t.shape[i]] ?? SHAPES[0] : { over: [] as Tri[], under: FULL };
        const overDef = over ? this.world.configs.overlay(over - 1) : undefined;
        const overTex = overDef && overDef.texture >= 0 && this.world.configs.texture(overDef.texture) ? overDef.texture : -1;
        const overHsl = over ? this.overlayHsl(over - 1) : -1;
        const lightAt = (px: number, py: number) => {
          const a = this.tileLight(z, wx, wy) + (this.tileLight(z, wx + 1, wy) - this.tileLight(z, wx, wy)) * px;
          const b = this.tileLight(z, wx, wy + 1) + (this.tileLight(z, wx + 1, wy + 1) - this.tileLight(z, wx, wy + 1)) * px;
          return a + (b - a) * py;
        };
        const overAt = (px: number, py: number) => {
          if (overHsl < 0) return -1;
          if (overTex >= 0) {
            // Textured: vertex colour carries only the light level that modulates the texture.
            const g = Math.min(255, Math.round(lightAt(px, py) * 255));
            return (g << 16) | (g << 8) | g;
          }
          return hslToRgb(shadeHsl(overHsl, lightAt(px, py)));
        };
        const rot = t.rotation[i];
        const emit = (tris: Tri[], colourAt: (px: number, py: number) => number, layer: number) => {
          for (const tri of tris) {
            const pts = tri.map((p) => rotatePoint(p, rot));
            const cols = pts.map((p) => colourAt(PX[p], PY[p]));
            if (cols.some((c) => c < 0)) continue;
            // Wind counter-clockwise when viewed from above (GL z = -world y).
            for (const k of [0, 2, 1]) {
              const p = pts[k];
              mesh.vertex(wx + PX[p], -heightAt(PX[p], PY[p]) * UNIT, -(wy + PY[p]), cols[k], 255, pick, PX[p], 1 - PY[p], layer);
            }
          }
        };
        emit(shape.over, overAt, overTex);
        if (under || over === 0) emit(shape.under, underAt, -1);
      }
    }
  }

  // --- locs ----------------------------------------------------------------------------------

  private buildLoc(loc: LocInstance, opaque: MeshBuilder, translucent: MeshBuilder): void {
    const base = this.world.locDef(loc.id);
    const def = base && this.resolve(base);
    if (!def) return;
    const ids = this.modelIdsFor(def, loc.type);
    if (ids.length === 0) return;
    const w = this.world;
    const [sx, sy] = w.footprint(loc);
    const cx = loc.x + sx / 2;
    const cy = loc.y + sy / 2;
    const z = loc.dataPlane;
    const baseHeight =
      (w.cornerHeight(z, loc.x, loc.y) + w.cornerHeight(z, loc.x + sx, loc.y) + w.cornerHeight(z, loc.x, loc.y + sy) + w.cornerHeight(z, loc.x + sx, loc.y + sy)) / 4;

    // Placements: walls of type 2 are two straight pieces; decorations sit offset from the wall.
    const placements: { rotation: number; mirror: boolean; angle: number; ox: number; oy: number }[] = [];
    const r = loc.rotation & 3;
    if (loc.type === LocType.WallL) {
      placements.push({ rotation: r, mirror: true, angle: 0, ox: 0, oy: 0 });
      placements.push({ rotation: (r + 1) & 3, mirror: false, angle: 0, ox: 0, oy: 0 });
    } else if (loc.type === LocType.CentrepieceDiagonal) {
      placements.push({ rotation: r, mirror: false, angle: Math.PI / 4, ox: 0, oy: 0 });
    } else if (isWallDecor(loc.type)) {
      let ox = 0;
      let oy = 0;
      if (loc.type === LocType.WallDecorOffset) {
        const d = def.decorOffset * UNIT;
        ox = [d, 0, -d, 0][r];
        oy = [0, -d, 0, d][r];
      }
      const diag = loc.type >= LocType.WallDecorDiagonalOut;
      placements.push({ rotation: r, mirror: false, angle: diag ? Math.PI / 4 : 0, ox, oy });
    } else {
      placements.push({ rotation: r, mirror: false, angle: 0, ox: 0, oy: 0 });
    }

    for (const id of ids) {
      const model = this.models.get(id);
      if (!model) continue;
      for (const pl of placements) this.emitModel(model, def, loc, pl, cx, cy, baseHeight, opaque, translucent);
    }
  }

  private emitModel(
    m: ModelData,
    def: LocDef,
    loc: LocInstance,
    pl: { rotation: number; mirror: boolean; angle: number; ox: number; oy: number },
    cx: number,
    cy: number,
    baseHeight: number,
    opaque: MeshBuilder,
    translucent: MeshBuilder,
  ): void {
    const n = m.vertexCount;
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const pz = new Float32Array(n);
    const mirror = def.mirror !== pl.mirror;
    const cosA = Math.cos(pl.angle);
    const sinA = Math.sin(pl.angle);
    const contour = def.contourGround >= 0;
    for (let i = 0; i < n; i++) {
      // Model space: x east, z north, -y up.
      let x = (m.vx[i] * def.scaleX) / 128;
      let y = (m.vy[i] * def.scaleY) / 128;
      let zz = (m.vz[i] * def.scaleZ) / 128;
      if (mirror) zz = -zz;
      for (let k = 0; k < pl.rotation; k++) {
        const t = x;
        x = zz;
        zz = -t;
      }
      if (pl.angle !== 0) {
        const t = x * cosA + zz * sinA;
        zz = -x * sinA + zz * cosA;
        x = t;
      }
      x += def.offsetX;
      y -= def.offsetY;
      zz += def.offsetZ;
      const wx = cx + x * UNIT + pl.ox;
      const wy = cy + zz * UNIT + pl.oy;
      let h = baseHeight + y;
      if (contour) h += this.world.heightAt(loc.dataPlane, wx, wy) - baseHeight;
      px[i] = wx;
      py[i] = -h * UNIT;
      pz[i] = -wy;
    }

    const recolFrom = def.recolFrom;
    const recolTo = def.recolTo;
    const retexFrom = def.retexFrom;
    const retexTo = def.retexTo;
    const [lx, ly, lz] = this.light;
    // Same lighting model as the client: lightness = ambient + 65536·cosθ / contrast, applied to HSL lightness.
    const ambient = 64 + def.ambient;
    const contrast = 768 + def.contrast;
    const flip = mirror ? 1 : 0;
    const fcount = m.faceCount;

    // Face normals (GL space) and smooth per-vertex normals from faces that use smooth shading.
    const fnx = new Float32Array(fcount);
    const fny = new Float32Array(fcount);
    const fnz = new Float32Array(fcount);
    const vnx = new Float32Array(n);
    const vny = new Float32Array(n);
    const vnz = new Float32Array(n);
    for (let f = 0; f < fcount; f++) {
      const a = m.fa[f];
      const b = flip ? m.fc[f] : m.fb[f];
      const c = flip ? m.fb[f] : m.fc[f];
      const ux = px[b] - px[a];
      const uy = py[b] - py[a];
      const uz = pz[b] - pz[a];
      const vx = px[c] - px[a];
      const vy = py[c] - py[a];
      const vz = pz[c] - pz[a];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      // Model faces wind the other way from GL's convention; flip so normals point outwards.
      fnx[f] = -nx;
      fny[f] = -ny;
      fnz[f] = -nz;
      if ((m.faceRenderType ? m.faceRenderType[f] : 0) === 0) {
        for (const v of [a, b, c]) {
          vnx[v] += fnx[f];
          vny[v] += fny[f];
          vnz[v] += fnz[f];
        }
      }
    }
    const lightness = (nx: number, ny: number, nz: number) => {
      const len = Math.hypot(nx, ny, nz) || 1;
      const cos = (nx * lx + ny * ly + nz * lz) / len;
      return Math.min(126, Math.max(2, ambient + (65536 * cos) / contrast));
    };

    for (let f = 0; f < fcount; f++) {
      const rt = m.faceRenderType ? m.faceRenderType[f] : 0;
      if (rt === 2) continue;
      const alphaIn = m.faceAlpha ? m.faceAlpha[f] : 0;
      if (alphaIn >= 254) continue;
      let hsl = m.faceColour[f];
      if (recolFrom) {
        const k = recolFrom.indexOf(hsl);
        if (k >= 0) hsl = recolTo![k] & 0xffff;
      }
      let tex = m.faceTexture ? m.faceTexture[f] : -1;
      if (tex >= 0 && retexFrom) {
        const k = retexFrom.indexOf(tex);
        if (k >= 0) tex = retexTo![k];
      }
      if (tex >= 0 && !this.world.configs.texture(tex)) tex = -1;
      const corners = [m.fa[f], flip ? m.fc[f] : m.fb[f], flip ? m.fb[f] : m.fc[f]];

      // Texture plane: the face's mapping triangle (P, M, N), or the face itself.
      let uv: number[] | null = null;
      if (tex >= 0) {
        const tc = m.faceTexCoord ? m.faceTexCoord[f] : -1;
        const [P, M, N] = tc >= 0 && tc < m.texP.length ? [m.texP[tc], m.texM[tc], m.texN[tc]] : [m.fa[f], m.fb[f], m.fc[f]];
        uv = planarUv(px, py, pz, P, M, N, corners);
      }

      const alpha = 255 - alphaIn;
      // Non-opaque textures (water, glass, sparkles) blend over what's behind them, like the client.
      const blended = alpha < 255 || (tex >= 0 && !this.world.configs.texture(tex)!.opaque);
      const target = blended ? translucent : opaque;
      for (let k = 0; k < 3; k++) {
        const v = corners[k];
        const smooth = rt === 0 || rt === 3;
        const L = smooth && (vnx[v] || vny[v] || vnz[v]) ? lightness(vnx[v], vny[v], vnz[v]) : lightness(fnx[f], fny[f], fnz[f]);
        let rgb: number;
        if (tex >= 0) {
          const g = Math.min(255, Math.round((L / 128) * 255));
          rgb = (g << 16) | (g << 8) | g;
        } else {
          rgb = hslToRgb(shadeHsl(hsl, L / 128));
        }
        if (uv) target.vertex(px[v], py[v], pz[v], rgb, alpha, loc.uid, uv[k * 2], uv[k * 2 + 1], tex);
        else target.vertex(px[v], py[v], pz[v], rgb, alpha, loc.uid);
      }
    }
  }

  // --- items ----------------------------------------------------------------------------------

  /**
   * An item's inventory model, rotated by its icon angles (2048 units per turn) and lit, in model units.
   * Used both for inventory icons and (lying on the floor) for ground items.
   */
  async itemMesh(objId: number, forIcon: boolean): Promise<{ mesh: MeshData; min: [number, number, number]; max: [number, number, number] } | null> {
    const obj = this.world.configs.obj(objId);
    if (!obj || obj.inventoryModel < 0) return null;
    const m = await this.model(obj.inventoryModel);
    if (!m) return null;
    const toRad = (u: number) => (u / 2048) * Math.PI * 2;
    // Icons use the item's stored view angles; on the floor items lie flat with a fixed yaw.
    const ax = forIcon ? toRad(obj.xan2d) : 0;
    const ay = forIcon ? toRad(obj.yan2d) : 0;
    const az = forIcon ? toRad(obj.zan2d) : 0;
    const n = m.vertexCount;
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const pz = new Float32Array(n);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      // Model space → y-up space, scaled.
      let x = (m.vx[i] * obj.resizeX) / 128;
      let y = (-m.vy[i] * obj.resizeY) / 128;
      let z = (m.vz[i] * obj.resizeZ) / 128;
      // Roll (z), yaw (y), then pitch (x), like the client's icon renderer.
      let t = x * Math.cos(az) - y * Math.sin(az);
      y = x * Math.sin(az) + y * Math.cos(az);
      x = t;
      t = x * Math.cos(ay) + z * Math.sin(ay);
      z = -x * Math.sin(ay) + z * Math.cos(ay);
      x = t;
      t = y * Math.cos(ax) - z * Math.sin(ax);
      z = y * Math.sin(ax) + z * Math.cos(ax);
      y = t;
      px[i] = x;
      py[i] = y;
      pz[i] = z;
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
      max[2] = Math.max(max[2], z);
    }
    const out = new MeshBuilder();
    const [lx, ly, lz] = forIcon ? [-0.4, 0.75, 0.55] : this.light;
    const ambient = 64 + obj.ambient;
    const contrast = 768 + obj.contrast;
    for (let f = 0; f < m.faceCount; f++) {
      if ((m.faceRenderType ? m.faceRenderType[f] : 0) === 2) continue;
      if ((m.faceAlpha ? m.faceAlpha[f] : 0) >= 254) continue;
      let hsl = m.faceColour[f];
      if (obj.recolFrom) {
        const k = obj.recolFrom.indexOf(hsl);
        if (k >= 0) hsl = obj.recolTo![k] & 0xffff;
      }
      let tex = m.faceTexture ? m.faceTexture[f] : -1;
      if (tex >= 0 && obj.retexFrom) {
        const k = obj.retexFrom.indexOf(tex);
        if (k >= 0) tex = obj.retexTo![k];
      }
      const t = tex >= 0 ? this.world.configs.texture(tex) : undefined;
      if (t) hsl = t.averageRgb;
      const a = m.fa[f];
      const b = m.fb[f];
      const c = m.fc[f];
      const ux = px[b] - px[a];
      const uy = py[b] - py[a];
      const uz = pz[b] - pz[a];
      const vx = px[c] - px[a];
      const vy = py[c] - py[a];
      const vz = pz[c] - pz[a];
      const nx = -(uy * vz - uz * vy);
      const ny = -(uz * vx - ux * vz);
      const nz = -(ux * vy - uy * vx);
      const len = Math.hypot(nx, ny, nz) || 1;
      const cos = (nx * lx + ny * ly + nz * lz) / len / (Math.hypot(lx, ly, lz) || 1);
      const L = Math.min(126, Math.max(2, ambient + (65536 * Math.abs(cos)) / contrast));
      const rgb = hslToRgb(shadeHsl(hsl, L / 128));
      for (const v of [a, b, c]) out.vertex(px[v] * UNIT, py[v] * UNIT, -pz[v] * UNIT, rgb, 255, 0);
    }
    return {
      mesh: out.finish(),
      min: [min[0] * UNIT, min[1] * UNIT, -max[2] * UNIT],
      max: [max[0] * UNIT, max[1] * UNIT, -min[2] * UNIT],
    };
  }

  /** All ground items as one mesh: each item's model lying at its tile centre. Pick id = the item's uid. */
  async buildGroundItems(items: { uid: number; id: number; x: number; y: number; plane: number }[]): Promise<MeshData> {
    const out = new MeshBuilder();
    for (const g of items) {
      const im = await this.itemMesh(g.id, false);
      if (!im) continue;
      const dataPlane = this.world.dataPlaneAt(g.plane, g.x, g.y);
      const ground = -this.world.heightAt(dataPlane, g.x + 0.5, g.y + 0.5) * UNIT;
      const m = im.mesh;
      // Ground items are drawn smaller than in-hand and centred on the tile.
      const cx = (im.min[0] + im.max[0]) / 2;
      const cz = (im.min[2] + im.max[2]) / 2;
      const s = 0.5;
      for (let i = 0; i < m.vertexCount; i++) {
        const x = (m.positions[i * 3] - cx) * s + g.x + 0.5;
        const y = (m.positions[i * 3 + 1] - im.min[1]) * s + ground + 0.01;
        const z = (m.positions[i * 3 + 2] - cz) * s - (g.y + 0.5);
        const rgb = (m.colours[i * 4] << 16) | (m.colours[i * 4 + 1] << 8) | m.colours[i * 4 + 2];
        out.vertex(x, y, z, rgb, 255, g.uid);
      }
    }
    return out.finish();
  }

  // --- minimap -------------------------------------------------------------------------------

  private buildMinimap(sq: Square, z: number): Uint8ClampedArray {
    const S = 4;
    const img = new Uint8ClampedArray(64 * S * 64 * S * 4);
    const t = sq.terrain;
    const baseX = sq.rx * 64;
    const baseY = sq.ry * 64;
    const put = (px: number, py: number, rgb: number) => {
      if (px < 0 || py < 0 || px >= 64 * S || py >= 64 * S) return;
      const o = (py * 64 * S + px) * 4;
      img[o] = (rgb >> 16) & 255;
      img[o + 1] = (rgb >> 8) & 255;
      img[o + 2] = rgb & 255;
      img[o + 3] = 255;
    };
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        // Draw this plane, falling back to lower planes so upstairs maps keep their surroundings.
        let rgb = -1;
        for (let pz = z; pz >= 0 && rgb < 0; pz--) {
          const i = tileIndex(pz, x, y);
          const over = t.overlay[i];
          if (over) {
            const def = this.world.configs.overlay(over - 1);
            if (def) {
              const tex = def.texture >= 0 ? this.world.configs.texture(def.texture) : undefined;
              if (tex) rgb = hslToRgb(tex.averageRgb);
              else if (def.secondaryRgb >= 0) rgb = def.secondaryRgb;
              else if (def.rgb !== INVISIBLE_RGB) rgb = def.rgb;
            }
          }
          if (rgb < 0 && t.underlay[i]) rgb = this.underlayRgb(pz, baseX + x, baseY + y);
          if (pz < z && rgb >= 0) rgb = (rgb >> 1) & 0x7f7f7f;
        }
        if (rgb < 0) continue;
        for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) put(x * S + i, (63 - y) * S + j, rgb);
      }
    }
    // Walls: white lines, doors (walls with actions) red.
    for (const loc of sq.locs) {
      if (loc.plane !== z || !(loc.type === LocType.WallStraight || loc.type === LocType.WallL || loc.type === LocType.WallDiagonal)) continue;
      const def = this.world.locDef(loc.id);
      if (!def || def.interactType === 0) continue;
      const colour = def.ops.some((o) => o !== null) ? 0xee0000 : 0xeeeeee;
      const lx = loc.x - baseX;
      const ly = 63 - (loc.y - baseY);
      const side = (r: number) => {
        for (let k = 0; k < S; k++) {
          if (r === 0) put(lx * S, ly * S + k, colour);
          else if (r === 1) put(lx * S + k, ly * S, colour);
          else if (r === 2) put(lx * S + S - 1, ly * S + k, colour);
          else put(lx * S + k, ly * S + S - 1, colour);
        }
      };
      if (loc.type === LocType.WallDiagonal) {
        for (let k = 0; k < S; k++) put(lx * S + k, loc.rotation & 1 ? ly * S + k : ly * S + S - 1 - k, colour);
      } else {
        side(loc.rotation & 3);
        if (loc.type === LocType.WallL) side((loc.rotation + 1) & 3);
      }
    }
    return img;
  }
}
