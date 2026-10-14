import { Archive, ConfigGroup, type Cache } from '../cache/cache.ts';
import { Packet } from '../cache/packet.ts';
import { hslToRgb } from '../util/colour.ts';
import { decodeObj, type ObjDef } from './obj.ts';
import { decodeSprites } from './sprite.ts';

export class UnknownOpcodeError extends Error {
  constructor(kind: string, id: number, opcode: number, pos: number) {
    super(`${kind} ${id}: unknown opcode ${opcode} at ${pos}`);
  }
}

/** Parses a key/value param table (opcode 249 in most config types). */
export function readParams(p: Packet): Map<number, number | string> {
  const params = new Map<number, number | string>();
  const count = p.u8();
  for (let i = 0; i < count; i++) {
    const isString = p.u8() === 1;
    const key = p.u24();
    params.set(key, isString ? p.string() : p.i32());
  }
  return params;
}

export interface UnderlayDef {
  id: number;
  rgb: number;
}

export function decodeUnderlay(id: number, data: Uint8Array): UnderlayDef {
  const def: UnderlayDef = { id, rgb: 0 };
  const p = new Packet(data);
  for (;;) {
    const op = p.u8();
    if (op === 0) break;
    if (op === 1) def.rgb = p.u24();
    else throw new UnknownOpcodeError('underlay', id, op, p.pos - 1);
  }
  return def;
}

export interface OverlayDef {
  id: number;
  rgb: number;
  texture: number;
  hideUnderlay: boolean;
  secondaryRgb: number;
  waterColour: number;
}

export function decodeOverlay(id: number, data: Uint8Array): OverlayDef {
  const def: OverlayDef = { id, rgb: 0, texture: -1, hideUnderlay: true, secondaryRgb: -1, waterColour: -1 };
  const p = new Packet(data);
  for (;;) {
    const op = p.u8();
    if (op === 0) break;
    switch (op) {
      case 1:
        def.rgb = p.u24();
        break;
      case 2:
        def.texture = p.u8();
        break;
      case 5:
        def.hideUnderlay = false;
        break;
      case 7:
        def.secondaryRgb = p.u24();
        break;
      // Water/fog properties used by newer environment rendering; parsed so the stream stays aligned.
      case 8:
        break;
      case 9:
        p.u16(); // texture scale
        break;
      case 10:
        break;
      case 11:
        p.u8(); // texture shift
        break;
      case 12:
        break;
      case 13:
        def.waterColour = p.u24();
        break;
      case 14:
        p.u8(); // water opacity scale
        break;
      case 15:
        p.u16(); // water texture
        break;
      case 16:
        p.u8(); // water shift
        break;
      default:
        throw new UnknownOpcodeError('overlay', id, op, p.pos - 1);
    }
  }
  return def;
}

export interface LocDef {
  id: number;
  name: string;
  models: Int32Array | null;
  modelTypes: Uint8Array | null;
  sizeX: number;
  sizeY: number;
  /** 0 = walk-through, 1 = blocks only movement (interactable through), 2 = solid. */
  interactType: number;
  blocksProjectile: boolean;
  wallOrDoor: number;
  contourGround: number;
  mergeNormals: boolean;
  animation: number;
  decorOffset: number;
  ambient: number;
  contrast: number;
  ops: (string | null)[];
  recolFrom: Int16Array | null;
  recolTo: Int16Array | null;
  retexFrom: Int16Array | null;
  retexTo: Int16Array | null;
  mirror: boolean;
  shadow: boolean;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  mapScene: number;
  blockFlags: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  blocksGround: boolean;
  supportsItems: number;
  mapFunction: number;
  multiVarbit: number;
  multiVarp: number;
  multiLocs: Int32Array | null;
  category: number;
  params: Map<number, number | string> | null;
}

export function newLocDef(id: number): LocDef {
  return {
    id,
    name: 'null',
    models: null,
    modelTypes: null,
    sizeX: 1,
    sizeY: 1,
    interactType: 2,
    blocksProjectile: true,
    wallOrDoor: -1,
    contourGround: -1,
    mergeNormals: false,
    animation: -1,
    decorOffset: 16,
    ambient: 0,
    contrast: 0,
    ops: [null, null, null, null, null],
    recolFrom: null,
    recolTo: null,
    retexFrom: null,
    retexTo: null,
    mirror: false,
    shadow: true,
    scaleX: 128,
    scaleY: 128,
    scaleZ: 128,
    mapScene: -1,
    blockFlags: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    blocksGround: false,
    supportsItems: -1,
    mapFunction: -1,
    multiVarbit: -1,
    multiVarp: -1,
    multiLocs: null,
    category: -1,
    params: null,
  };
}

function readRecolours(p: Packet): [Int16Array, Int16Array] {
  const n = p.u8();
  const from = new Int16Array(n);
  const to = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    from[i] = p.u16();
    to[i] = p.u16();
  }
  return [from, to];
}

function readMulti(p: Packet, withDefault: boolean): { varbit: number; varp: number; ids: Int32Array } {
  const varbit = p.u16Nullable();
  const varp = p.u16Nullable();
  const fallback = withDefault ? p.u16Nullable() : -1;
  const n = p.u8();
  const ids = new Int32Array(n + 2);
  for (let i = 0; i <= n; i++) ids[i] = p.u16Nullable();
  ids[n + 1] = fallback;
  return { varbit, varp, ids };
}

export function decodeLoc(id: number, data: Uint8Array): LocDef {
  const def = newLocDef(id);
  const p = new Packet(data);
  let explicitInteract = false;
  for (;;) {
    const op = p.u8();
    if (op === 0) break;
    switch (op) {
      case 1: {
        const n = p.u8();
        def.models = new Int32Array(n);
        def.modelTypes = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          def.models[i] = p.u16();
          def.modelTypes[i] = p.u8();
        }
        break;
      }
      case 2:
        def.name = p.string();
        break;
      case 5: {
        const n = p.u8();
        def.models = new Int32Array(n);
        def.modelTypes = null;
        for (let i = 0; i < n; i++) def.models[i] = p.u16();
        break;
      }
      case 6: {
        // Since build ~240: typed models with 32-bit ids.
        const n = p.u8();
        def.models = new Int32Array(n);
        def.modelTypes = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          def.models[i] = p.i32();
          def.modelTypes[i] = p.u8();
        }
        break;
      }
      case 7: {
        const n = p.u8();
        def.models = new Int32Array(n);
        def.modelTypes = null;
        for (let i = 0; i < n; i++) def.models[i] = p.i32();
        break;
      }
      case 14:
        def.sizeX = p.u8();
        break;
      case 15:
        def.sizeY = p.u8();
        break;
      case 17:
        def.interactType = 0;
        def.blocksProjectile = false;
        explicitInteract = true;
        break;
      case 18:
        def.blocksProjectile = false;
        break;
      case 19:
        def.wallOrDoor = p.u8();
        break;
      case 21:
        def.contourGround = 0;
        break;
      case 22:
        def.mergeNormals = true;
        break;
      case 23:
        break; // occludes
      case 24:
        def.animation = p.u16Nullable();
        break;
      case 27:
        def.interactType = 1;
        explicitInteract = true;
        break;
      case 28:
        def.decorOffset = p.u8();
        break;
      case 29:
        def.ambient = p.i8();
        break;
      case 39:
        def.contrast = p.i8() * 25;
        break;
      case 30:
      case 31:
      case 32:
      case 33:
      case 34: {
        const s = p.string();
        def.ops[op - 30] = s.toLowerCase() === 'hidden' ? null : s;
        break;
      }
      case 40:
        [def.recolFrom, def.recolTo] = readRecolours(p);
        break;
      case 41:
        [def.retexFrom, def.retexTo] = readRecolours(p);
        break;
      case 61:
        def.category = p.u16();
        break;
      case 62:
        def.mirror = true;
        break;
      case 64:
        def.shadow = false;
        break;
      case 65:
        def.scaleX = p.u16();
        break;
      case 66:
        def.scaleY = p.u16();
        break;
      case 67:
        def.scaleZ = p.u16();
        break;
      case 68:
        def.mapScene = p.u16();
        break;
      case 69:
        def.blockFlags = p.u8();
        break;
      case 70:
        def.offsetX = p.i16();
        break;
      case 71:
        def.offsetY = p.i16();
        break;
      case 72:
        def.offsetZ = p.i16();
        break;
      case 73:
        def.blocksGround = true;
        break;
      case 74:
        def.interactType = 0;
        def.blocksProjectile = false;
        explicitInteract = true;
        break; // "hollow": treated as walk-through
      case 75:
        def.supportsItems = p.u8();
        break;
      case 77:
      case 92: {
        const m = readMulti(p, op === 92);
        def.multiVarbit = m.varbit;
        def.multiVarp = m.varp;
        def.multiLocs = m.ids;
        break;
      }
      case 78:
        p.u16(); // ambient sound
        p.u8(); // distance
        p.u8(); // retain
        break;
      case 79: {
        p.u16();
        p.u16();
        p.u8();
        p.u8();
        const n = p.u8();
        p.skip(n * 2);
        break;
      }
      case 81:
        def.contourGround = p.u8() * 256;
        break;
      case 82:
        def.mapFunction = p.u16();
        break;
      case 89:
        break; // randomise animation start
      case 90:
        break; // defer animation change
      case 91:
        p.u8(); // sound distance fade curve
        break;
      case 93:
        p.u8();
        p.u16();
        p.u8();
        p.u16();
        break; // sound fade in/out curves
      case 94:
        break; // unknown boolean
      case 95:
        p.u8(); // sound visibility
        break;
      case 96:
        p.u8(); // raise/lower
        break;
      case 100:
        // Sub-option label: slot, sub-index, text.
        p.u8();
        p.u8();
        p.string();
        break;
      case 102:
        // Sub-option visibility condition: slot, sub-index, varbit, varp, min, max.
        p.u8();
        p.u16();
        p.u16();
        p.u16();
        p.i32();
        p.i32();
        break;
      case 101:
        // Conditional sub-option (e.g. spirit tree destinations): slot, varbit, varp, min, max, text.
        p.u8();
        p.u16();
        p.u16();
        p.i32();
        p.i32();
        p.string();
        break;
      case 249:
        def.params = readParams(p);
        break;
      default:
        throw new UnknownOpcodeError('loc', id, op, p.pos - 1);
    }
  }
  if (!explicitInteract && def.wallOrDoor === -1) {
    def.wallOrDoor = def.models !== null && (def.modelTypes === null || def.modelTypes[0] === 10) ? 1 : 0;
    if (def.ops.some((o) => o !== null)) def.wallOrDoor = 1;
  }
  return def;
}

export interface TextureDef {
  id: number;
  averageRgb: number;
  opaque: boolean;
  sprites: Int32Array;
  animDirection: number;
  animSpeed: number;
}

/** Modern (2022+) texture definitions: a single sprite plus animation info. */
export function decodeTexture(id: number, data: Uint8Array): TextureDef {
  const p = new Packet(data);
  const sprite = p.u16();
  const averageRgb = p.u16();
  const opaque = p.u8() === 1;
  const animDirection = p.u8();
  const animSpeed = p.u8();
  return { id, averageRgb, opaque, sprites: Int32Array.of(sprite), animDirection, animSpeed };
}

export const TEXTURE_SIZE = 128;

/** Every texture as one 128x128 RGBA layer of a texture array, plus per-layer animation (du, dv per second). */
export interface TextureAtlas {
  layers: number;
  pixels: Uint8Array;
  anim: Float32Array;
}

/** Lazily decoded, memoised config tables. */
export class ConfigStore {
  private underlays: Map<number, UnderlayDef> | null = null;
  private overlays: Map<number, OverlayDef> | null = null;
  private locFiles: Map<number, Uint8Array> | null = null;
  private readonly locs = new Map<number, LocDef>();
  private textures: Map<number, TextureDef> | null = null;
  private objFiles: Map<number, Uint8Array> | null = null;
  private readonly objs = new Map<number, ObjDef>();
  private objNames: Map<string, number> | null = null;
  private depleted = new Map<number, number>();
  private locIndex: { name: string; id: number; model: number; sizeX: number; sizeY: number }[] | null = null;

  constructor(readonly cache: Cache) {}

  async init(): Promise<void> {
    const [under, over, locs] = await Promise.all([
      this.cache.files(Archive.Configs, ConfigGroup.Underlay),
      this.cache.files(Archive.Configs, ConfigGroup.Overlay),
      this.cache.files(Archive.Configs, ConfigGroup.Loc),
    ]);
    this.underlays = new Map([...(under ?? [])].map(([id, d]) => [id, decodeUnderlay(id, d)]));
    this.overlays = new Map([...(over ?? [])].map(([id, d]) => [id, decodeOverlay(id, d)]));
    this.locFiles = locs ?? new Map();
    this.objFiles = (await this.cache.files(Archive.Configs, ConfigGroup.Obj)) ?? new Map();
    this.textures = new Map();
    const texFiles = await this.cache.files(Archive.Textures, 0);
    for (const [id, d] of texFiles ?? []) {
      try {
        this.textures.set(id, decodeTexture(id, d));
      } catch {
        // Unknown legacy texture layout; faces fall back to their base colour.
      }
    }
  }

  underlay(id: number): UnderlayDef | undefined {
    return this.underlays!.get(id);
  }

  overlay(id: number): OverlayDef | undefined {
    return this.overlays!.get(id);
  }

  texture(id: number): TextureDef | undefined {
    return this.textures!.get(id);
  }

  /** Decodes every texture's sprite into a single atlas (texture id = layer). */
  async textureAtlas(): Promise<TextureAtlas> {
    const ids = [...this.textures!.keys()];
    const layers = ids.length ? Math.max(...ids) + 1 : 1;
    const S = TEXTURE_SIZE;
    const pixels = new Uint8Array(layers * S * S * 4);
    const anim = new Float32Array(layers * 2);
    for (const [id, tex] of this.textures!) {
      const data = await this.cache.groupData(Archive.Sprites, tex.sprites[0]).catch(() => null);
      if (!data) continue;
      let frame;
      try {
        frame = decodeSprites(data)[0];
      } catch {
        continue;
      }
      if (!frame) continue;
      // Place the frame in its full canvas, then scale the canvas (64 or 128 px) to 128 px, nearest-neighbour.
      const cw = frame.maxWidth || frame.width;
      const ch = frame.maxHeight || frame.height;
      const base = id * S * S * 4;
      // Flowing-water textures are mostly empty sparkle layers: give their empty texels the texture's own
      // average colour, semi-transparent, so the surface reads as water. Static cut-outs (fences, leaves) stay
      // see-through. (Heuristic: the client's exact compositing of these isn't documented in the cache.)
      const fill = !tex.opaque && tex.animDirection > 0 ? hslToRgb(tex.averageRgb) : -1;
      if (fill >= 0) {
        for (let i = 0; i < S * S; i++) {
          pixels[base + i * 4] = (fill >> 16) & 255;
          pixels[base + i * 4 + 1] = (fill >> 8) & 255;
          pixels[base + i * 4 + 2] = fill & 255;
          pixels[base + i * 4 + 3] = 170;
        }
      }
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const fx = Math.floor((x * cw) / S) - frame.offsetX;
          const fy = Math.floor((y * ch) / S) - frame.offsetY;
          if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) continue;
          const src = (fy * frame.width + fx) * 4;
          const dst = base + (y * S + x) * 4;
          if (fill >= 0 && frame.mask[src / 4] === 0) continue;
          pixels[dst] = frame.pixels[src];
          pixels[dst + 1] = frame.pixels[src + 1];
          pixels[dst + 2] = frame.pixels[src + 2];
          // Like the classic renderer: only palette index 0 is see-through in a texture.
          pixels[dst + 3] = frame.mask[src / 4];
        }
      }
      // Scrolling textures (water, lava, portals): direction 1-4, speed in texture-widths per ~50 s.
      const rate = tex.animSpeed / 50;
      const dirs: Record<number, [number, number]> = { 1: [0, rate], 2: [-rate, 0], 3: [0, -rate], 4: [rate, 0] };
      const [du, dv] = dirs[tex.animDirection] ?? [0, 0];
      anim[id * 2] = du;
      anim[id * 2 + 1] = dv;
    }
    return { layers, pixels, anim };
  }

  loc(id: number): LocDef | undefined {
    let def = this.locs.get(id);
    if (def) return def;
    const data = this.locFiles!.get(id);
    if (!data) return undefined;
    try {
      def = decodeLoc(id, data);
    } catch (e) {
      // A newer build may add opcodes we don't know yet: keep the world loading, just without this loc.
      console.warn(String(e));
      def = newLocDef(id);
      def.interactType = 0;
    }
    this.locs.set(id, def);
    return def;
  }

  obj(id: number): ObjDef | undefined {
    let def = this.objs.get(id);
    if (def) return def;
    const data = this.objFiles?.get(id);
    if (!data) return undefined;
    try {
      def = decodeObj(id, data);
    } catch (e) {
      console.warn(String(e));
      return undefined;
    }
    this.objs.set(id, def);
    return def;
  }

  /** The canonical (unnoted, non-placeholder, has an icon model) item with this exact name. */
  objByName(name: string): ObjDef | undefined {
    if (!this.objNames) {
      this.objNames = new Map();
      for (const id of [...(this.objFiles?.keys() ?? [])].sort((a, b) => a - b)) {
        const d = this.obj(id);
        if (!d || d.name === 'null' || d.notedTemplate >= 0 || d.inventoryModel < 0) continue;
        const key = d.name.toLowerCase();
        if (!this.objNames.has(key)) this.objNames.set(key, id);
      }
    }
    const id = this.objNames.get(name.toLowerCase());
    return id === undefined ? undefined : this.obj(id);
  }

  /**
   * What a gathered tree/rock turns into: a "Tree stump" of the same footprint for trees, or the plain "Rocks"
   * that shares the ore rock's model (ore rocks are recoloured empty rocks). -1 = simply remove it.
   */
  depletedFor(locId: number): number {
    const cached = this.depleted.get(locId);
    if (cached !== undefined) return cached;
    if (!this.locIndex) {
      this.locIndex = [];
      for (const id of this.locFiles!.keys()) {
        const d = this.loc(id);
        if (d && d.models && d.models.length) this.locIndex.push({ name: d.name, id, model: d.models[0], sizeX: d.sizeX, sizeY: d.sizeY });
      }
    }
    const def = this.loc(locId);
    let out = -1;
    if (def?.models?.length) {
      if (/tree|evergreen/i.test(def.name)) {
        out = this.locIndex.find((l) => l.name === 'Tree stump' && l.sizeX === def.sizeX && l.sizeY === def.sizeY)?.id ?? -1;
      } else if (/rocks$/i.test(def.name)) {
        out = this.locIndex.find((l) => l.name === 'Rocks' && l.model === def.models![0] && l.id !== locId)?.id ?? -1;
      }
    }
    this.depleted.set(locId, out);
    return out;
  }

  locCount(): number {
    return this.locFiles!.size;
  }
}
