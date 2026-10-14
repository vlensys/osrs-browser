import type { StepChecker } from './collision.ts';

export interface Tile {
  x: number;
  y: number;
}

const DIRS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

const SEARCH = 128;
const FALLBACK_RADIUS = 10;

/**
 * Breadth-first search inside a 128x128 window centred on the start tile, like the game client.
 * If the destination is unreachable, walks to the reachable tile closest to it (within 10 tiles).
 * `reached(x, y)` lets callers accept any tile adjacent to an interaction target.
 * Returns the steps excluding the start tile (empty if already there / nowhere to go).
 */
export function findPath(
  map: StepChecker,
  plane: number,
  start: Tile,
  dest: Tile,
  reached: (x: number, y: number) => boolean = (x, y) => x === dest.x && y === dest.y,
): Tile[] {
  const originX = start.x - SEARCH / 2;
  const originY = start.y - SEARCH / 2;
  const dist = new Int32Array(SEARCH * SEARCH).fill(-1);
  const prev = new Int32Array(SEARCH * SEARCH).fill(-1);
  const queue = new Int32Array(SEARCH * SEARCH);
  const idx = (x: number, y: number) => (x - originX) * SEARCH + (y - originY);
  const inWindow = (x: number, y: number) => x >= originX && y >= originY && x < originX + SEARCH && y < originY + SEARCH;

  let head = 0;
  let tail = 0;
  const s = idx(start.x, start.y);
  dist[s] = 0;
  queue[tail++] = s;
  let found = -1;

  while (head < tail) {
    const cur = queue[head++];
    const cx = Math.floor(cur / SEARCH) + originX;
    const cy = (cur % SEARCH) + originY;
    if (reached(cx, cy)) {
      found = cur;
      break;
    }
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inWindow(nx, ny)) continue;
      const n = idx(nx, ny);
      if (dist[n] !== -1) continue;
      if (!map.canStep(plane, cx, cy, dx, dy)) continue;
      dist[n] = dist[cur] + 1;
      prev[n] = cur;
      queue[tail++] = n;
    }
  }

  if (found < 0) {
    // Closest reachable tile to the destination, ties broken by shortest walk.
    let best = -1;
    let bestDist = Infinity;
    let bestCost = Infinity;
    for (let dx = -FALLBACK_RADIUS; dx <= FALLBACK_RADIUS; dx++) {
      for (let dy = -FALLBACK_RADIUS; dy <= FALLBACK_RADIUS; dy++) {
        const x = dest.x + dx;
        const y = dest.y + dy;
        if (!inWindow(x, y)) continue;
        const i = idx(x, y);
        if (dist[i] < 0) continue;
        const d = dx * dx + dy * dy;
        if (d < bestDist || (d === bestDist && dist[i] < bestCost)) {
          best = i;
          bestDist = d;
          bestCost = dist[i];
        }
      }
    }
    found = best;
  }
  if (found < 0 || found === s) return [];

  const path: Tile[] = [];
  for (let c = found; c !== s; c = prev[c]) {
    path.push({ x: Math.floor(c / SEARCH) + originX, y: (c % SEARCH) + originY });
  }
  return path.reverse();
}
