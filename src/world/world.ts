import type { Cache } from '../cache/cache.ts';
import type { ConfigStore, LocDef } from '../defs/config.ts';
import { loadMapSquare, SQUARE, TileFlag, tileIndex, type Terrain } from '../defs/mapsquare.ts';
import { CollisionMap } from './collision.ts';

export const LocType = {
  WallStraight: 0,
  WallDiagonalCorner: 1,
  WallL: 2,
  WallSquareCorner: 3,
  WallDecorStraight: 4,
  WallDecorOffset: 5,
  WallDecorDiagonalOut: 6,
  WallDecorDiagonalIn: 7,
  WallDecorDiagonalBoth: 8,
  WallDiagonal: 9,
  Centrepiece: 10,
  CentrepieceDiagonal: 11,
  RoofFirst: 12,
  RoofLast: 21,
  GroundDecor: 22,
} as const;

export const isWall = (type: number) => type <= LocType.WallSquareCorner;
export const isWallDecor = (type: number) => type >= LocType.WallDecorStraight && type <= LocType.WallDecorDiagonalBoth;

/** A loc placed in the world (mutable: doors swing open, etc.). Coordinates are world tiles. */
export interface LocInstance {
  uid: number;
  id: number;
  /** Plane the loc is stored on in the map data (its heights come from this plane). */
  dataPlane: number;
  /** Plane it occupies for movement/interaction after bridge adjustment (-1 = under a bridge). */
  plane: number;
  x: number;
  y: number;
  type: number;
  rotation: number;
}

export interface Square {
  rx: number;
  ry: number;
  terrain: Terrain;
  heights: Int32Array; // per plane, 64x64 tile SW-corner heights (model units, negative = up)
  locs: LocInstance[];
}

let nextUid = 1;

/** Unique id for anything clickable that isn't a tile (locs, ground items). */
export function allocUid(): number {
  return nextUid++;
}

/** Deterministic smooth noise for tiles whose height is procedurally generated. */
function noise2(x: number, y: number): number {
  let n = Math.imul(x, 0x1b873593) ^ Math.imul(y, 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 15), 0x27d4eb2d);
  return ((n ^ (n >>> 13)) & 0xffff) / 0xffff;
}

function smoothNoise(x: number, y: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = noise2(x0, y0);
  const b = noise2(x0 + 1, y0);
  const c = noise2(x0, y0 + 1);
  const d = noise2(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function proceduralHeight(x: number, y: number): number {
  const n = smoothNoise(x + 45365, y + 91923, 8) * 0.6 + smoothNoise(x + 10294, y + 37821, 4) * 0.3 + smoothNoise(x, y, 2) * 0.1;
  return -Math.round(35 + n * 60) * 8;
}

export class World {
  readonly collision = new CollisionMap();
  private readonly squares = new Map<number, Square | null>();
  private readonly loading = new Map<number, Promise<Square | null>>();

  constructor(
    readonly cache: Cache,
    readonly configs: ConfigStore,
  ) {}

  static key(rx: number, ry: number): number {
    return (rx << 8) | ry;
  }

  square(rx: number, ry: number): Square | null | undefined {
    return this.squares.get(World.key(rx, ry));
  }

  loadedSquares(): Square[] {
    return [...this.squares.values()].filter((s): s is Square => s !== null);
  }

  async load(rx: number, ry: number): Promise<Square | null> {
    const key = World.key(rx, ry);
    if (this.squares.has(key)) return this.squares.get(key)!;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.decode(rx, ry).then((sq) => {
        this.squares.set(key, sq);
        this.loading.delete(key);
        if (sq) this.applyCollision(sq);
        return sq;
      });
      this.loading.set(key, pending);
    }
    return pending;
  }

  unload(rx: number, ry: number): void {
    this.squares.delete(World.key(rx, ry));
    this.collision.release(rx, ry);
  }

  private async decode(rx: number, ry: number): Promise<Square | null> {
    const ms = await loadMapSquare(this.cache, rx, ry);
    if (!ms) return null;
    const t = ms.terrain;
    const heights = new Int32Array(4 * SQUARE * SQUARE);
    for (let z = 0; z < 4; z++) {
      for (let x = 0; x < SQUARE; x++) {
        for (let y = 0; y < SQUARE; y++) {
          const i = tileIndex(z, x, y);
          const raw = t.rawHeight[i];
          const below = z === 0 ? 0 : heights[tileIndex(z - 1, x, y)];
          if (raw < 0) {
            heights[i] = z === 0 ? proceduralHeight(rx * 64 + x, ry * 64 + y) : below - 240;
          } else {
            const h = raw === 1 ? 0 : raw;
            heights[i] = z === 0 ? -h * 8 : below - h * 8;
          }
        }
      }
    }
    const baseX = rx * 64;
    const baseY = ry * 64;
    const locs: LocInstance[] = [];
    for (const l of ms.locs) {
      // Bridges: content stored one plane up renders there but is walked on from the plane below.
      const bridged = (t.settings[tileIndex(1, l.x, l.y)] & TileFlag.Bridge) !== 0;
      // -1 = underneath a bridge: drawn on plane 0 but never collides or gets clicked.
      const plane = bridged ? l.plane - 1 : l.plane;
      locs.push({ uid: nextUid++, id: l.id, dataPlane: l.plane, plane, x: baseX + l.x, y: baseY + l.y, type: l.type, rotation: l.rotation });
    }
    return { rx, ry, terrain: t, heights, locs };
  }

  private applyCollision(sq: Square): void {
    this.collision.allocate(sq.rx, sq.ry);
    const t = sq.terrain;
    const baseX = sq.rx * 64;
    const baseY = sq.ry * 64;
    for (let z = 0; z < 4; z++) {
      for (let x = 0; x < SQUARE; x++) {
        for (let y = 0; y < SQUARE; y++) {
          if ((t.settings[tileIndex(z, x, y)] & TileFlag.Blocked) === 0) continue;
          const bridged = (t.settings[tileIndex(1, x, y)] & TileFlag.Bridge) !== 0;
          const plane = bridged ? z - 1 : z;
          if (plane >= 0) this.collision.setSolid(plane, baseX + x, baseY + y, 1, 1, true);
        }
      }
    }
    for (const loc of sq.locs) this.setLocCollision(loc, true);
    // Walls on our border may belong to neighbours that loaded first; re-apply theirs onto our tiles.
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const n = this.square(sq.rx + dx, sq.ry + dy);
      if (!n) continue;
      for (const loc of n.locs) {
        if (loc.type <= LocType.WallL || loc.type === LocType.Centrepiece || loc.type === LocType.CentrepieceDiagonal) {
          this.setLocCollision(loc, true);
        }
      }
    }
  }

  locDef(id: number): LocDef | undefined {
    return this.configs.loc(id);
  }

  /** Footprint in tiles after rotation. */
  footprint(loc: LocInstance): [number, number] {
    const def = this.locDef(loc.id);
    if (!def) return [1, 1];
    return loc.rotation & 1 ? [def.sizeY, def.sizeX] : [def.sizeX, def.sizeY];
  }

  setLocCollision(loc: LocInstance, present: boolean): void {
    const def = this.locDef(loc.id);
    if (!def || def.interactType === 0 || loc.plane < 0) return;
    const c = this.collision;
    switch (loc.type) {
      case LocType.WallStraight:
        c.setWall(loc.plane, loc.x, loc.y, loc.rotation, present);
        break;
      case LocType.WallL:
        c.setWall(loc.plane, loc.x, loc.y, loc.rotation, present);
        c.setWall(loc.plane, loc.x, loc.y, loc.rotation + 1, present);
        break;
      case LocType.WallDiagonal:
      case LocType.Centrepiece:
      case LocType.CentrepieceDiagonal: {
        const [sx, sy] = loc.type === LocType.WallDiagonal ? [1, 1] : this.footprint(loc);
        c.setSolid(loc.plane, loc.x, loc.y, sx, sy, present);
        break;
      }
      case LocType.GroundDecor:
        if (def.interactType === 1) c.setSolid(loc.plane, loc.x, loc.y, 1, 1, present);
        break;
      default:
        break;
    }
  }

  /** Height (model units, negative = up) of a tile's SW corner, or 0 if the square isn't loaded. */
  cornerHeight(plane: number, x: number, y: number): number {
    const sq = this.square(x >> 6, y >> 6);
    if (sq) return sq.heights[tileIndex(plane, x & 63, y & 63)];
    // Unloaded neighbour: reuse the nearest loaded tile so seams don't tear.
    const near = this.square((x - 1) >> 6, y >> 6) ?? this.square(x >> 6, (y - 1) >> 6) ?? this.square((x - 1) >> 6, (y - 1) >> 6);
    if (!near) return 0;
    const cx = Math.min(Math.max(x, near.rx * 64), near.rx * 64 + 63);
    const cy = Math.min(Math.max(y, near.ry * 64), near.ry * 64 + 63);
    return near.heights[tileIndex(plane, cx & 63, cy & 63)];
  }

  /** Bilinear height at a fractional world position (in tiles). */
  heightAt(plane: number, fx: number, fy: number): number {
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const tx = fx - x;
    const ty = fy - y;
    const h00 = this.cornerHeight(plane, x, y);
    const h10 = this.cornerHeight(plane, x + 1, y);
    const h01 = this.cornerHeight(plane, x, y + 1);
    const h11 = this.cornerHeight(plane, x + 1, y + 1);
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * ty;
  }

  /** Render plane for a logical plane at a tile (bridges lift the walkable surface one data plane up). */
  dataPlaneAt(plane: number, x: number, y: number): number {
    const sq = this.square(x >> 6, y >> 6);
    if (!sq || plane >= 3) return plane;
    return sq.terrain.settings[tileIndex(1, x & 63, y & 63)] & TileFlag.Bridge ? plane + 1 : plane;
  }

  /**
   * Highest plane to draw for a player standing here: when the tile above has the roof-removal flag
   * (the player is indoors) only floors up to the player's own are drawn, like the game's roof hiding.
   */
  maxVisiblePlane(plane: number, x: number, y: number): number {
    const sq = this.square(x >> 6, y >> 6);
    if (!sq) return 3;
    for (let z = plane + 1; z < 4; z++) {
      const dz = this.dataPlaneAt(plane, x, y) + (z - plane);
      if (dz > 3) break;
      if (sq.terrain.settings[tileIndex(dz, x & 63, y & 63)] & TileFlag.RoofRemoval) return plane;
      // Something solid overhead (a floor or roof) also means we're inside.
      if (sq.terrain.overlay[tileIndex(dz, x & 63, y & 63)] || sq.terrain.underlay[tileIndex(dz, x & 63, y & 63)]) return plane;
    }
    return 3;
  }

  locsAt(plane: number, x: number, y: number): LocInstance[] {
    const out: LocInstance[] = [];
    for (let dx = -4; dx <= 0; dx++) {
      for (let dy = -4; dy <= 0; dy++) {
        const sq = this.square((x + dx) >> 6, (y + dy) >> 6);
        if (!sq) continue;
        for (const l of sq.locs) {
          if (l.plane !== plane || l.x !== x + dx || l.y !== y + dy) continue;
          const [sx, sy] = this.footprint(l);
          if (x < l.x + sx && y < l.y + sy) out.push(l);
        }
      }
    }
    return out;
  }

  /** Swaps a loc's definition in place (tree → stump, ore → empty rock, -1 = removed); returns squares to rebuild. */
  replaceLoc(loc: LocInstance, id: number): Set<number> {
    this.setLocCollision(loc, false);
    loc.id = id;
    this.setLocCollision(loc, true);
    return new Set([((loc.x >> 6) << 8) | (loc.y >> 6)]);
  }

  findLoc(uid: number): { loc: LocInstance; square: Square } | null {
    for (const sq of this.squares.values()) {
      if (!sq) continue;
      const loc = sq.locs.find((l) => l.uid === uid);
      if (loc) return { loc, square: sq };
    }
    return null;
  }
}
