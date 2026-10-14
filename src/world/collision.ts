/**
 * Per-tile movement flags stored per 64x64 map square and addressed in world coordinates.
 * Wall bits mark which edges of a tile are blocked; Full marks an impassable tile.
 * Tiles in squares that aren't loaded read as Full.
 */
export const Flag = {
  WallW: 0x1,
  WallN: 0x2,
  WallE: 0x4,
  WallS: 0x8,
  Full: 0x100,
} as const;

/** Wall side for a loc rotation: 0 = west, 1 = north, 2 = east, 3 = south. */
const SIDE = [Flag.WallW, Flag.WallN, Flag.WallE, Flag.WallS];
const OPPOSITE = [Flag.WallE, Flag.WallS, Flag.WallW, Flag.WallN];
export const SIDE_DX = [-1, 0, 1, 0];
export const SIDE_DY = [0, 1, 0, -1];

export interface StepChecker {
  canStep(plane: number, x: number, y: number, dx: number, dy: number): boolean;
}

export class CollisionMap implements StepChecker {
  private readonly squares = new Map<number, Uint16Array>();

  private static key(x: number, y: number): number {
    return ((x >> 6) << 8) | (y >> 6);
  }

  /** Allocates (cleared) storage for a square so its tiles become walkable unless flagged. */
  allocate(rx: number, ry: number): void {
    this.squares.set((rx << 8) | ry, new Uint16Array(4 * 64 * 64));
  }

  release(rx: number, ry: number): void {
    this.squares.delete((rx << 8) | ry);
  }

  has(rx: number, ry: number): boolean {
    return this.squares.has((rx << 8) | ry);
  }

  get(plane: number, x: number, y: number): number {
    const sq = this.squares.get(CollisionMap.key(x, y));
    if (!sq) return Flag.Full;
    return sq[(plane << 12) | ((x & 63) << 6) | (y & 63)];
  }

  add(plane: number, x: number, y: number, f: number): void {
    const sq = this.squares.get(CollisionMap.key(x, y));
    if (sq) sq[(plane << 12) | ((x & 63) << 6) | (y & 63)] |= f;
  }

  remove(plane: number, x: number, y: number, f: number): void {
    const sq = this.squares.get(CollisionMap.key(x, y));
    if (sq) sq[(plane << 12) | ((x & 63) << 6) | (y & 63)] &= ~f;
  }

  /** Straight wall on one side of a tile (and the matching side of its neighbour). */
  setWall(plane: number, x: number, y: number, rotation: number, present: boolean): void {
    const r = rotation & 3;
    if (present) {
      this.add(plane, x, y, SIDE[r]);
      this.add(plane, x + SIDE_DX[r], y + SIDE_DY[r], OPPOSITE[r]);
    } else {
      this.remove(plane, x, y, SIDE[r]);
      this.remove(plane, x + SIDE_DX[r], y + SIDE_DY[r], OPPOSITE[r]);
    }
  }

  setSolid(plane: number, x: number, y: number, sizeX: number, sizeY: number, present: boolean): void {
    for (let dx = 0; dx < sizeX; dx++) {
      for (let dy = 0; dy < sizeY; dy++) {
        if (present) this.add(plane, x + dx, y + dy, Flag.Full);
        else this.remove(plane, x + dx, y + dy, Flag.Full);
      }
    }
  }

  /** Whether a single step from (x, y) by (dx, dy) in {-1, 0, 1}² is allowed. */
  canStep(plane: number, x: number, y: number, dx: number, dy: number): boolean {
    if (dx !== 0 && dy !== 0) {
      // Diagonals need both orthogonal L-shaped routes to be legal (no corner cutting).
      return (
        this.canStep(plane, x, y, dx, 0) &&
        this.canStep(plane, x, y, 0, dy) &&
        this.canStep(plane, x + dx, y, 0, dy) &&
        this.canStep(plane, x, y + dy, dx, 0)
      );
    }
    if (this.get(plane, x + dx, y + dy) & Flag.Full) return false;
    const from = this.get(plane, x, y);
    if (dx === -1) return (from & Flag.WallW) === 0;
    if (dx === 1) return (from & Flag.WallE) === 0;
    if (dy === 1) return (from & Flag.WallN) === 0;
    if (dy === -1) return (from & Flag.WallS) === 0;
    return true;
  }
}
