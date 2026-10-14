import { beforeAll, describe, expect, it } from 'vitest';
import { Cache } from '../../src/cache/cache.ts';
import { BufferSource, DiskStore } from '../../src/cache/disk-store.ts';
import { ReferenceTable, splitGroup } from '../../src/cache/reference-table.ts';
import { ConfigStore, decodeLoc } from '../../src/defs/config.ts';
import { decodeLocs, decodeTerrain, loadMapSquare, tileIndex } from '../../src/defs/mapsquare.ts';
import { decodeModel } from '../../src/defs/model.ts';
import { Game } from '../../src/engine/game.ts';
import { Flag } from '../../src/world/collision.ts';
import { SceneBuilder } from '../../src/world/scene-builder.ts';
import { World } from '../../src/world/world.ts';
import { buildFixtureCache, HOUSE, LOC, TREES } from '../../tools/fixture/content.ts';
import { DiskStoreWriter, encodeReferenceTable, packGroup } from '../../tools/fixture/writer.ts';

let cache: Cache;

beforeAll(async () => {
  const { dat2, indexes } = await buildFixtureCache();
  cache = new Cache(new DiskStore(new BufferSource(dat2), indexes));
});

describe('disk store and reference tables', () => {
  it('reads multi-sector groups and extended (>65535) group ids', async () => {
    const w = new DiskStoreWriter();
    const big = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255);
    w.write(3, 2, big);
    w.write(3, 70000, Uint8Array.of(1, 2, 3));
    const { dat2, indexes } = w.finish();
    const store = new DiskStore(new BufferSource(dat2), indexes);
    expect(await store.read(3, 2)).toEqual(big);
    expect(await store.read(3, 70000)).toEqual(Uint8Array.of(1, 2, 3));
    expect(await store.read(3, 1)).toBeNull();
    expect(await store.read(9, 0)).toBeNull();
  });

  it('round-trips reference tables and striped groups', () => {
    const files = new Map([
      [0, Uint8Array.of(1)],
      [4, Uint8Array.of(2, 3)],
      [9, new Uint8Array(0)],
    ]);
    const table = ReferenceTable.decode(encodeReferenceTable([{ id: 7, nameHash: 1234, files }], true));
    const g = table.groups.get(7)!;
    expect([...g.fileIds]).toEqual([0, 4, 9]);
    expect(table.groupIdByNameHash(1234)).toBe(7);
    const parts = splitGroup(packGroup([...files.values()]), 3);
    expect(parts.map((p) => [...p])).toEqual([[1], [2, 3], []]);
  });

  it('exposes the fixture archives', async () => {
    expect(cache.store.archives()).toEqual([2, 5, 7]);
    expect((await cache.table(2))!.groups.size).toBe(3);
    expect((await cache.files(2, 6))!.size).toBe(5);
  });
});

describe('definitions', () => {
  it('decodes locs with 16-bit and 32-bit model opcodes', async () => {
    const files = (await cache.files(2, 6))!;
    const wall = decodeLoc(LOC.Wall, files.get(LOC.Wall)!);
    expect(wall.name).toBe('Wall');
    expect([...wall.models!]).toEqual([0]);
    expect([...wall.modelTypes!]).toEqual([0]);
    const door = decodeLoc(LOC.Door, files.get(LOC.Door)!);
    expect(door.ops[0]).toBe('Open');
    expect([...door.models!]).toEqual([1]);
    const ladder = decodeLoc(LOC.LadderUp, files.get(LOC.LadderUp)!);
    expect(ladder.modelTypes).toBeNull();
    expect(ladder.ops[0]).toBe('Climb-up');
  });

  it('decodes legacy-format models', async () => {
    const m = decodeModel((await cache.groupData(7, 2))!);
    expect(m.vertexCount).toBe(24);
    expect(m.faceCount).toBe(36);
    expect(Math.min(...m.vy)).toBe(-360);
    for (let i = 0; i < m.faceCount; i++) expect(Math.max(m.fa[i], m.fb[i], m.fc[i])).toBeLessThan(m.vertexCount);
  });

  it('decodes modern map squares', async () => {
    const files = (await cache.files(5, (50 << 8) | 50))!;
    const t = decodeTerrain(files.get(0)!, true);
    const inside = tileIndex(0, HOUSE.x0 - 3200 + 1, HOUSE.y0 - 3200 + 1);
    expect(t.overlay[inside]).toBe(2); // floor overlay id 1, stored +1
    expect(t.settings[tileIndex(1, HOUSE.x0 - 3200, HOUSE.y0 - 3200)] & 4).toBe(4);
    const locs = decodeLocs(files.get(1)!);
    expect(locs.filter((l) => l.id === LOC.Tree)).toHaveLength(TREES.length);
    const sq = await loadMapSquare(cache, 50, 50);
    expect(sq!.locs.length).toBe(locs.length);
  });
});

describe('world, scene and game', () => {
  async function setup() {
    const configs = new ConfigStore(cache);
    await configs.init();
    const world = new World(cache, configs);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) await world.load(50 + dx, 50 + dy);
    const chat: string[] = [];
    const changed: number[] = [];
    const game = new Game(world, { chat: (t) => chat.push(t), locsChanged: (s) => changed.push(...s), regionChanged: () => {} });
    return { world, game, chat, changed };
  }

  it('builds non-empty meshes and a minimap', async () => {
    const { world } = await setup();
    const meshes = await new SceneBuilder(world).build(world.square(50, 50)!);
    expect(meshes.planes[0].opaque.vertexCount).toBeGreaterThan(64 * 64 * 6);
    expect(meshes.planes[0].opaque.vertexCount % 3).toBe(0);
    expect(meshes.planes[1].opaque.vertexCount).toBeGreaterThan(0); // upper floor + ladder
    expect(meshes.minimaps[0].some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
  });

  it('applies wall and tree collision', async () => {
    const { world } = await setup();
    const c = world.collision;
    expect(c.get(0, HOUSE.x0, HOUSE.y0 + 1) & Flag.WallW).toBeTruthy();
    expect(c.canStep(0, HOUSE.x0 - 1, HOUSE.y0 + 1, 1, 0)).toBe(false);
    expect(c.get(0, TREES[0].x, TREES[0].y) & Flag.Full).toBeTruthy();
    expect(c.canStep(0, HOUSE.doorX, HOUSE.doorY - 1, 0, 1)).toBe(false); // closed door
  });

  it('walks, opens the door, enters and climbs the ladder', async () => {
    const { game, chat, changed, world } = await setup();
    const tick = (n: number) => {
      for (let i = 0; i < n; i++) game.tick();
    };
    game.teleport(HOUSE.doorX, HOUSE.doorY - 3, 0);
    // Walk-here into the house is impossible while the door is closed: we stop outside.
    game.act({ kind: 'walk', x: HOUSE.ladderX, y: HOUSE.ladderY - 1 });
    tick(20);
    expect(game.y).toBeLessThan(HOUSE.doorY);

    const door = world.locsAt(0, HOUSE.doorX, HOUSE.doorY).find((l) => l.id === LOC.Door)!;
    const openIdx = game.menu(door.uid).findIndex((o) => o.verb === 'Open');
    expect(openIdx).toBeGreaterThanOrEqual(0);
    game.act({ kind: 'loc', uid: door.uid, op: 0 });
    tick(10);
    expect(chat).toContain('You open the door.');
    expect(changed.length).toBeGreaterThan(0);
    expect(game.menu(door.uid).some((o) => o.verb === 'Close')).toBe(true);

    const ladder = world.locsAt(0, HOUSE.ladderX, HOUSE.ladderY).find((l) => l.id === LOC.LadderUp)!;
    game.act({ kind: 'loc', uid: ladder.uid, op: 0 });
    tick(20);
    expect(game.plane).toBe(1);
    expect(chat).toContain('You climb up.');
    expect(game.state().maxPlane).toBe(3); // upstairs nothing is overhead

    const save = game.save();
    expect(save.toggledLocs).toHaveLength(1);
  });

  it('runs two tiles per tick and drains energy', async () => {
    const { game } = await setup();
    game.teleport(3215, 3200, 0);
    game.setRunning(true);
    game.act({ kind: 'walk', x: 3215, y: 3210 });
    game.tick();
    expect(game.state().steps).toHaveLength(2);
    expect(game.energy).toBeLessThan(10000);
  });
});
