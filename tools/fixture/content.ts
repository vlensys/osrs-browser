/**
 * Original test-world content (no Jagex assets): a hillside with a path, a small house with a door and a
 * ladder to an upper floor, and a few trees, all inside map square 50_50 around the default spawn.
 */
import { DiskStoreWriter, Writer, type GroupSpec } from './writer.ts';

// --- models (legacy format) -------------------------------------------------------------------

interface Mesh {
  v: [number, number, number][];
  f: [number, number, number, number][]; // a, b, c, hsl colour
}

function box(m: Mesh, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, hsl: number): void {
  const b = m.v.length;
  for (const [x, y, z] of [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ]) m.v.push([x, y, z]);
  const q = (a: number, c: number, d: number, e: number, col: number) => {
    m.f.push([b + a, b + c, b + d, col], [b + a, b + d, b + e, col]);
  };
  const dark = (hsl & 0xff80) | Math.max(2, (hsl & 127) - 14);
  q(0, 1, 2, 3, dark);
  q(4, 7, 6, 5, hsl);
  q(0, 4, 5, 1, hsl);
  q(1, 5, 6, 2, dark);
  q(2, 6, 7, 3, hsl);
  q(3, 7, 4, 0, dark);
}

/** Encodes the pre-2014 model layout (18-byte footer, no marker). */
export function encodeLegacyModel(m: Mesh): Uint8Array {
  const vflags = new Writer();
  const xs = new Writer();
  const ys = new Writer();
  const zs = new Writer();
  let px = 0;
  let py = 0;
  let pz = 0;
  for (const [x, y, z] of m.v) {
    vflags.u8(7);
    xs.sSmart(x - px);
    ys.sSmart(y - py);
    zs.sSmart(z - pz);
    px = x;
    py = y;
    pz = z;
  }
  const fcomp = new Writer();
  const idx = new Writer();
  const colours = new Writer();
  let last = 0;
  for (const [a, b, c, col] of m.f) {
    fcomp.u8(1);
    idx.sSmart(a - last).sSmart(b - a).sSmart(c - b);
    last = c;
    colours.u16(col);
  }
  const parts = [vflags, fcomp, idx, colours, xs, ys, zs].map((w) => w.finish());
  const out = new Writer();
  for (const p of parts) out.bytes(p);
  out.u16(m.v.length).u16(m.f.length).u8(0); // vertices, faces, textured triangles
  out.u8(0).u8(0).u8(0).u8(0).u8(0); // render types, priority, alpha, face skins, vertex skins
  out.u16(parts[4].length).u16(parts[5].length).u16(parts[6].length).u16(parts[2].length);
  return out.finish();
}

const HSL = {
  stone: (8 << 10) | (1 << 7) | 70,
  wood: (7 << 10) | (4 << 7) | 40,
  bark: (6 << 10) | (3 << 7) | 30,
  leaves: (18 << 10) | (5 << 7) | 40,
  rung: (7 << 10) | (3 << 7) | 55,
};

// Model space: x east, z north, -y up, 128 units per tile, origin at the loc's centre.
function wallModel(): Mesh {
  const m: Mesh = { v: [], f: [] };
  box(m, -64, 0, -64, -50, -240, 64, HSL.stone);
  return m;
}
function doorModel(): Mesh {
  const m: Mesh = { v: [], f: [] };
  box(m, -62, 0, -60, -54, -200, 60, HSL.wood);
  return m;
}
function treeModel(): Mesh {
  const m: Mesh = { v: [], f: [] };
  box(m, -14, 0, -14, 14, -170, 14, HSL.bark);
  box(m, -70, -150, -70, 70, -300, 70, HSL.leaves);
  box(m, -40, -290, -40, 40, -360, 40, HSL.leaves);
  return m;
}
function ladderModel(): Mesh {
  const m: Mesh = { v: [], f: [] };
  box(m, -40, 0, 30, -30, -300, 40, HSL.wood);
  box(m, 30, 0, 30, 40, -300, 40, HSL.wood);
  for (let y = -30; y > -300; y -= 50) box(m, -30, y, 32, 30, y - 8, 38, HSL.rung);
  return m;
}

// --- configs ---------------------------------------------------------------------------------

function underlay(rgb: number): Uint8Array {
  return new Writer().u8(1).u24(rgb).u8(0).finish();
}
function overlay(rgb: number): Uint8Array {
  return new Writer().u8(1).u24(rgb).u8(0).finish();
}

interface LocSpec {
  name: string;
  /** Model ids; with types → typed list. */
  models: number[];
  types?: number[];
  wide?: boolean; // use the 32-bit model id opcodes (6/7)
  ops?: string[];
  interact?: 0 | 1 | 2;
}

function loc(s: LocSpec): Uint8Array {
  const w = new Writer();
  if (s.types) {
    w.u8(s.wide ? 6 : 1).u8(s.models.length);
    s.models.forEach((id, i) => (s.wide ? w.i32(id) : w.u16(id)).u8(s.types![i]));
  } else {
    w.u8(s.wide ? 7 : 5).u8(s.models.length);
    for (const id of s.models) s.wide ? w.i32(id) : w.u16(id);
  }
  w.u8(2).string(s.name);
  (s.ops ?? []).forEach((op, i) => w.u8(30 + i).string(op));
  if (s.interact === 0) w.u8(17);
  return w.u8(0).finish();
}

export const LOC = { Wall: 0, Door: 1, Tree: 2, LadderUp: 3, LadderDown: 4 } as const;

// --- map square 50_50 ------------------------------------------------------------------------

export const REGION_X = 50;
export const REGION_Y = 50;
export const BASE_X = REGION_X * 64;
export const BASE_Y = REGION_Y * 64;
/** House footprint (world tiles, inclusive) and its door. */
export const HOUSE = { x0: 3226, y0: 3214, x1: 3229, y1: 3217, doorX: 3227, doorY: 3214, ladderX: 3228, ladderY: 3216 };
export const TREES = [
  { x: 3218, y: 3222 },
  { x: 3215, y: 3213 },
  { x: 3231, y: 3225 },
];

const UNDERLAY_GRASS = 0;
const UNDERLAY_DIRT = 1;
const OVERLAY_PATH = 0;
const OVERLAY_FLOOR = 1;

function terrain(): Uint8Array {
  const w = new Writer();
  const inHouse = (x: number, y: number) => x >= HOUSE.x0 && x <= HOUSE.x1 && y >= HOUSE.y0 && y <= HOUSE.y1;
  for (let z = 0; z < 4; z++) {
    for (let lx = 0; lx < 64; lx++) {
      for (let ly = 0; ly < 64; ly++) {
        const x = BASE_X + lx;
        const y = BASE_Y + ly;
        if (z === 0) {
          const path = x >= 3221 && x <= 3223;
          if (path) w.u16(2).u16(OVERLAY_PATH + 1); // opcode 2 = overlay (shape 0, rotation 0), ids are 1-based
          if (inHouse(x, y)) w.u16(2).u16(OVERLAY_FLOOR + 1);
          w.u16(82 + ((lx * 7 + ly * 3) % 11 === 0 ? UNDERLAY_DIRT : UNDERLAY_GRASS));
          const h = Math.max(2, Math.round(14 + 5 * Math.sin(lx / 7) + 4 * Math.cos(ly / 9)));
          w.u16(1).u8(inHouse(x, y) ? 14 : h);
        } else if (z === 1 && inHouse(x, y)) {
          w.u16(49 + 4); // settings: roof-removal (we're indoors below this)
          w.u16(2).u16(OVERLAY_FLOOR + 1);
          w.u16(0);
        } else {
          w.u16(0);
        }
      }
    }
  }
  w.u8(0); // modern squares carry a trailing (empty) extension byte
  return w.finish();
}

interface Placement {
  id: number;
  plane: number;
  x: number;
  y: number;
  type: number;
  rotation: number;
}

function placements(): Placement[] {
  const out: Placement[] = [];
  const { x0, y0, x1, y1 } = HOUSE;
  for (let y = y0; y <= y1; y++) {
    out.push({ id: LOC.Wall, plane: 0, x: x0, y, type: 0, rotation: 0 });
    out.push({ id: LOC.Wall, plane: 0, x: x1, y, type: 0, rotation: 2 });
  }
  for (let x = x0; x <= x1; x++) {
    out.push({ id: LOC.Wall, plane: 0, x, y: y1, type: 0, rotation: 1 });
    if (x === HOUSE.doorX) out.push({ id: LOC.Door, plane: 0, x, y: y0, type: 0, rotation: 3 });
    else out.push({ id: LOC.Wall, plane: 0, x, y: y0, type: 0, rotation: 3 });
  }
  out.push({ id: LOC.LadderUp, plane: 0, x: HOUSE.ladderX, y: HOUSE.ladderY, type: 10, rotation: 0 });
  out.push({ id: LOC.LadderDown, plane: 1, x: HOUSE.ladderX, y: HOUSE.ladderY, type: 10, rotation: 0 });
  for (const t of TREES) out.push({ id: LOC.Tree, plane: 0, x: t.x, y: t.y, type: 10, rotation: 0 });
  return out;
}

export function encodeLocs(list: Placement[]): Uint8Array {
  const w = new Writer();
  const byId = new Map<number, Placement[]>();
  for (const p of list) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
  let lastId = -1;
  for (const id of [...byId.keys()].sort((a, b) => a - b)) {
    w.smart(id - lastId);
    lastId = id;
    const ps = byId
      .get(id)!
      .map((p) => ({ p, pos: (p.plane << 12) | ((p.x - BASE_X) << 6) | (p.y - BASE_Y) }))
      .sort((a, b) => a.pos - b.pos);
    let prev = 0;
    for (const { p, pos } of ps) {
      w.smart(pos - prev + 1);
      prev = pos;
      w.u8((p.type << 2) | p.rotation);
    }
    w.smart(0);
  }
  w.smart(0);
  return w.finish();
}

export async function buildFixtureCache(): Promise<{ dat2: Uint8Array; indexes: Map<number, Uint8Array> }> {
  const store = new DiskStoreWriter();
  const one = (id: number, data: Uint8Array): GroupSpec => ({ id, files: new Map([[0, data]]) });

  // Archive 2: configs (underlay 1, overlay 4, loc 6).
  await store.writeArchive(2, [
    { id: 1, files: new Map([[UNDERLAY_GRASS, underlay(0x4f8a2b)], [UNDERLAY_DIRT, underlay(0x7a5c34)]]) },
    { id: 4, files: new Map([[OVERLAY_PATH, overlay(0x8c8577)], [OVERLAY_FLOOR, overlay(0x6e4b2a)]]) },
    {
      id: 6,
      files: new Map([
        [LOC.Wall, loc({ name: 'Wall', models: [0], types: [0] })],
        [LOC.Door, loc({ name: 'Door', models: [1], types: [0], wide: true, ops: ['Open'] })],
        [LOC.Tree, loc({ name: 'Tree', models: [2], ops: ['Chop down'] })],
        [LOC.LadderUp, loc({ name: 'Ladder', models: [3], wide: true, ops: ['Climb-up'] })],
        [LOC.LadderDown, loc({ name: 'Ladder', models: [3], wide: true, ops: ['Climb-down'] })],
      ]),
    },
  ]);

  // Archive 5: maps, modern layout (group = region id, file 0 terrain, file 1 locs).
  await store.writeArchive(5, [
    {
      id: (REGION_X << 8) | REGION_Y,
      files: new Map([
        [0, terrain()],
        [1, encodeLocs(placements())],
      ]),
    },
  ]);

  // Archive 7: models.
  await store.writeArchive(7, [wallModel(), doorModel(), treeModel(), ladderModel()].map((m, i) => one(i, encodeLegacyModel(m))));

  return store.finish();
}
