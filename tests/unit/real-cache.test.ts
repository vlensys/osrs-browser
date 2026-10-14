/**
 * Validation against a real OSRS cache. Skipped unless OSRS_CACHE_DIR points at a directory with
 * main_file_cache.dat2 / .idx* (e.g. an extracted OpenRS2 disk.zip). Caches are never committed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Cache } from '../../src/cache/cache.ts';
import { ConfigStore, decodeLoc, decodeOverlay, decodeUnderlay } from '../../src/defs/config.ts';
import { loadMapSquare } from '../../src/defs/mapsquare.ts';
import { decodeModel } from '../../src/defs/model.ts';
import { Game } from '../../src/engine/game.ts';
import { findPath } from '../../src/world/pathfinder.ts';
import { SceneBuilder } from '../../src/world/scene-builder.ts';
import { World } from '../../src/world/world.ts';
import { hasRealCache, openNodeCache, REAL_CACHE_DIR } from '../helpers/node-cache.ts';

describe.skipIf(!hasRealCache)('real cache', () => {
  let cache: Cache;
  beforeAll(() => {
    cache = openNodeCache(REAL_CACHE_DIR);
  });

  it('decodes every underlay, overlay and loc definition', async () => {
    for (const [id, d] of (await cache.files(2, 1))!) decodeUnderlay(id, d);
    for (const [id, d] of (await cache.files(2, 4))!) decodeOverlay(id, d);
    const locs = (await cache.files(2, 6))!;
    let named = 0;
    for (const [id, d] of locs) if (decodeLoc(id, d).name !== 'null') named++;
    expect(named).toBeGreaterThan(10_000);
  });

  it('decodes every map square (modern region groups, or named groups with XTEA keys)', async () => {
    let squares = 0;
    let locs = 0;
    for (let rx = 0; rx < 128; rx++) {
      for (let ry = 0; ry < 256; ry++) {
        const sq = await loadMapSquare(cache, rx, ry);
        if (!sq) continue;
        squares++;
        locs += sq.locs.length;
      }
    }
    expect(squares).toBeGreaterThan(1000);
    expect(locs).toBeGreaterThan(1_000_000);
  });

  it('decodes every model with exact stream accounting', async () => {
    const table = (await cache.table(7))!;
    let faces = 0;
    for (const id of table.groups.keys()) {
      const data = await cache.groupData(7, id);
      if (data) faces += decodeModel(data).faceCount;
    }
    expect(faces).toBeGreaterThan(1_000_000);
  });

  it('builds Lumbridge and pathfinds around its scenery', async () => {
    const configs = new ConfigStore(cache);
    await configs.init();
    const world = new World(cache, configs);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) await world.load(50 + dx, 50 + dy);
    const meshes = await new SceneBuilder(world).build(world.square(50, 50)!);
    expect(meshes.planes[0].opaque.vertexCount).toBeGreaterThan(100_000);
    // Into the castle hall through its east entrance, and north out of the courtyard.
    expect(findPath(world.collision, 0, { x: 3222, y: 3218 }, { x: 3215, y: 3218 }).at(-1)).toEqual({ x: 3215, y: 3218 });
    expect(findPath(world.collision, 0, { x: 3222, y: 3218 }, { x: 3222, y: 3240 }).at(-1)).toEqual({ x: 3222, y: 3240 });
    // A chair beside the hall's table is solid: walking onto it stops at the nearest reachable tile.
    const chair = findPath(world.collision, 0, { x: 3222, y: 3218 }, { x: 3208, y: 3220 }).at(-1)!;
    expect(chair).not.toEqual({ x: 3208, y: 3220 });
    expect(Math.max(Math.abs(chair.x - 3208), Math.abs(chair.y - 3220))).toBeLessThanOrEqual(3);
    const game = new Game(world, { chat: () => {}, locsChanged: () => {}, regionChanged: () => {} });
    expect(game.menu(0).at(-1)!.verb).toBe('Cancel');
  });
});
