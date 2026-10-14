import { Archive, type Cache } from '../cache/cache.ts';
import { Packet } from '../cache/packet.ts';

export const PLANES = 4;
export const SQUARE = 64;
const TILES = PLANES * SQUARE * SQUARE;

export const tileIndex = (plane: number, x: number, y: number) => (plane * SQUARE + x) * SQUARE + y;

/** Tile settings flags. */
export const TileFlag = {
  Blocked: 0x1,
  Bridge: 0x2,
  RoofRemoval: 0x4,
  ForceLowestPlane: 0x8,
  Hidden: 0x10,
} as const;

export interface Terrain {
  /** Raw height opcode payload; -1 means "procedural" (opcode 0). */
  rawHeight: Int16Array;
  overlay: Int16Array; // 1-based overlay id as stored in the map (config id + 1), 0 = none
  shape: Uint8Array;
  rotation: Uint8Array;
  settings: Uint8Array;
  underlay: Int16Array; // 1-based underlay id (config id + 1), 0 = none
}

/**
 * Terrain: for each plane, x, y a sequence of opcodes terminated by 0 (procedural height) or 1 (explicit height).
 * Builds since late 2022 use u16 opcodes and i16 overlay ids; older ones use u8 opcodes and u8 overlay ids.
 */
export function decodeTerrain(data: Uint8Array, wide: boolean): Terrain {
  const t: Terrain = {
    rawHeight: new Int16Array(TILES).fill(-1),
    overlay: new Int16Array(TILES),
    shape: new Uint8Array(TILES),
    rotation: new Uint8Array(TILES),
    settings: new Uint8Array(TILES),
    underlay: new Int16Array(TILES),
  };
  const p = new Packet(data);
  for (let i = 0; i < TILES; i++) {
    for (;;) {
      const op = wide ? p.u16() : p.u8();
      if (op === 0) break;
      if (op === 1) {
        t.rawHeight[i] = p.u8();
        break;
      }
      if (op <= 49) {
        t.overlay[i] = wide ? p.i16() : p.u8();
        t.shape[i] = (op - 2) >> 2;
        t.rotation[i] = (op - 2) & 3;
      } else if (op <= 81) {
        t.settings[i] = op - 49;
      } else {
        t.underlay[i] = op - 81;
      }
    }
  }
  // Modern squares end with a trailing extension block (a single 0 byte when empty); it carries nothing we need.
  return t;
}

export interface LocPlacement {
  id: number;
  plane: number;
  x: number;
  y: number;
  type: number;
  rotation: number;
}

export function decodeLocs(data: Uint8Array): LocPlacement[] {
  const out: LocPlacement[] = [];
  const p = new Packet(data);
  let id = -1;
  for (;;) {
    const idDelta = p.extendedSmart();
    if (idDelta === 0) break;
    id += idDelta;
    let pos = 0;
    for (;;) {
      const posDelta = p.smart();
      if (posDelta === 0) break;
      pos += posDelta - 1;
      const attrs = p.u8();
      out.push({
        id,
        plane: (pos >> 12) & 3,
        x: (pos >> 6) & 63,
        y: pos & 63,
        type: attrs >> 2,
        rotation: attrs & 3,
      });
    }
  }
  if (p.remaining !== 0) throw new Error(`locs: ${p.remaining} trailing bytes`);
  return out;
}

export interface MapSquare {
  regionX: number;
  regionY: number;
  terrain: Terrain;
  locs: LocPlacement[];
}

export const regionId = (rx: number, ry: number) => (rx << 8) | ry;

/**
 * Loads a 64x64 map square from either layout:
 *  - modern (unnamed archive): group = region id, file 0 = terrain, file 1 = locs, u16 terrain opcodes;
 *  - legacy (named archive): groups "m{x}_{y}" and "l{x}_{y}", locs XTEA-encrypted with per-region keys.
 */
export async function loadMapSquare(cache: Cache, rx: number, ry: number): Promise<MapSquare | null> {
  const table = await cache.table(Archive.Maps);
  if (!table) return null;
  const id = regionId(rx, ry);

  if (!table.named) {
    const files = await cache.files(Archive.Maps, id);
    const terrainData = files?.get(0);
    if (!terrainData) return null;
    const locData = files!.get(1);
    try {
      return { regionX: rx, regionY: ry, terrain: decodeTerrain(terrainData, true), locs: locData ? decodeLocs(locData) : [] };
    } catch {
      // A few groups in this archive aren't regular map squares (e.g. instance templates): treat as empty.
      return null;
    }
  }

  const terrainData = await cache.namedGroup(Archive.Maps, `m${rx}_${ry}`);
  if (!terrainData) return null;
  let terrain: Terrain;
  try {
    terrain = decodeTerrain(terrainData, true);
  } catch {
    try {
      terrain = decodeTerrain(terrainData, false); // pre-2022 builds use 8-bit opcodes
    } catch {
      return null;
    }
  }
  let locs: LocPlacement[] = [];
  try {
    const locData = await cache.namedGroup(Archive.Maps, `l${rx}_${ry}`, cache.keys.get(id));
    if (locData) locs = decodeLocs(locData);
  } catch {
    // Missing/incorrect XTEA key: render the terrain without scenery rather than failing the region.
  }
  return { regionX: rx, regionY: ry, terrain, locs };
}
