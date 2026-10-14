import { describe, expect, it } from 'vitest';
import { CollisionMap, Flag } from '../../src/world/collision.ts';
import { findPath } from '../../src/world/pathfinder.ts';

function open(): CollisionMap {
  const c = new CollisionMap();
  for (let rx = 49; rx <= 51; rx++) for (let ry = 49; ry <= 51; ry++) c.allocate(rx, ry);
  return c;
}

describe('pathfinder', () => {
  it('walks straight and diagonally on open ground', () => {
    const c = open();
    const path = findPath(c, 0, { x: 3200, y: 3200 }, { x: 3205, y: 3205 });
    expect(path).toHaveLength(5);
    expect(path.at(-1)).toEqual({ x: 3205, y: 3205 });
  });

  it('routes around walls and never cuts corners', () => {
    const c = open();
    // A north-south wall line on the west edge of x = 3205 for y in 3195..3205.
    for (let y = 3195; y <= 3205; y++) c.setWall(0, 3205, y, 0, true);
    const path = findPath(c, 0, { x: 3203, y: 3200 }, { x: 3207, y: 3200 });
    expect(path.at(-1)).toEqual({ x: 3207, y: 3200 });
    expect(path.length).toBeGreaterThan(10);
    let prev = { x: 3203, y: 3200 };
    for (const step of path) {
      expect(c.canStep(0, prev.x, prev.y, step.x - prev.x, step.y - prev.y)).toBe(true);
      prev = step;
    }
  });

  it('stops at the closest reachable tile when the destination is enclosed', () => {
    const c = open();
    c.setSolid(0, 3210, 3210, 1, 1, true);
    const path = findPath(c, 0, { x: 3200, y: 3210 }, { x: 3210, y: 3210 });
    expect(path.at(-1)).toEqual({ x: 3209, y: 3210 });
  });

  it('treats unloaded squares as blocked', () => {
    const c = new CollisionMap();
    c.allocate(50, 50);
    expect(c.get(0, 3199, 3200)).toBe(Flag.Full);
    expect(c.canStep(0, 3200, 3200, -1, 0)).toBe(false);
  });

  it('accepts custom reach conditions (interaction targets)', () => {
    const c = open();
    c.setSolid(0, 3210, 3210, 2, 2, true);
    const path = findPath(c, 0, { x: 3200, y: 3211 }, { x: 3210, y: 3210 }, (x, y) => x === 3209 && (y === 3210 || y === 3211));
    expect(path.at(-1)!.x).toBe(3209);
  });
});
