import { decodeContainer } from './container.ts';
import type { DiskStore } from './disk-store.ts';
import { nameHash } from './packet.ts';
import { ReferenceTable, splitGroup } from './reference-table.ts';
import type { XteaKey } from './xtea.ts';

/** OSRS archive ids. */
export const Archive = {
  Animations: 0,
  Skeletons: 1,
  Configs: 2,
  Interfaces: 3,
  SoundEffects: 4,
  Maps: 5,
  MusicTracks: 6,
  Models: 7,
  Sprites: 8,
  Textures: 9,
  Binary: 10,
  MusicJingles: 11,
  ClientScripts: 12,
  Fonts: 13,
  MusicSamples: 14,
  MusicPatches: 15,
  WorldMapGeography: 18,
  WorldMap: 19,
  WorldMapGround: 20,
  DbTableIndex: 21,
} as const;
export type Archive = (typeof Archive)[keyof typeof Archive];

/** Groups inside {@link Archive.Configs}. */
export const ConfigGroup = {
  Underlay: 1,
  IdentKit: 3,
  Overlay: 4,
  Inv: 5,
  Loc: 6,
  Enum: 8,
  Npc: 9,
  Obj: 10,
  Param: 11,
  Seq: 12,
  SpotAnim: 13,
  VarBit: 14,
  VarClient: 19,
  VarPlayer: 16,
  HitSplat: 32,
  HealthBar: 33,
  Struct: 34,
  Area: 35,
} as const;
export type ConfigGroup = (typeof ConfigGroup)[keyof typeof ConfigGroup];

/** Map-square XTEA keys keyed by region id ((x << 8) | y). */
export type KeyStore = Map<number, XteaKey>;

/**
 * High-level cache access: reference tables, group decoding and file splitting, with small caches so
 * repeated lookups (configs, neighbouring map squares) don't re-read the store.
 */
export class Cache {
  private readonly tables = new Map<number, ReferenceTable | null>();
  private readonly groupFiles = new Map<string, Promise<Map<number, Uint8Array> | null>>();
  private readonly maxCachedGroups = 512;

  constructor(
    readonly store: DiskStore,
    readonly keys: KeyStore = new Map(),
  ) {}

  async table(archive: number): Promise<ReferenceTable | null> {
    if (this.tables.has(archive)) return this.tables.get(archive)!;
    const raw = await this.store.read(255, archive);
    const table = raw ? ReferenceTable.decode(await decodeContainer(raw)) : null;
    this.tables.set(archive, table);
    return table;
  }

  /** Revision stamped into the config archive's reference table; a rough proxy for the game build. */
  async revision(): Promise<number> {
    return (await this.table(Archive.Configs))?.revision ?? 0;
  }

  async groupData(archive: number, group: number, key?: XteaKey | null): Promise<Uint8Array | null> {
    const raw = await this.store.read(archive, group);
    if (!raw) return null;
    return decodeContainer(raw, key);
  }

  /** All files of a group, keyed by file id. */
  async files(archive: number, group: number, key?: XteaKey | null): Promise<Map<number, Uint8Array> | null> {
    const cacheKey = `${archive}:${group}`;
    let pending = this.groupFiles.get(cacheKey);
    if (!pending) {
      pending = this.loadFiles(archive, group, key);
      if (this.groupFiles.size >= this.maxCachedGroups) {
        const oldest = this.groupFiles.keys().next().value!;
        this.groupFiles.delete(oldest);
      }
      this.groupFiles.set(cacheKey, pending);
      pending.catch(() => this.groupFiles.delete(cacheKey));
    }
    return pending;
  }

  private async loadFiles(archive: number, group: number, key?: XteaKey | null): Promise<Map<number, Uint8Array> | null> {
    const table = await this.table(archive);
    const entry = table?.groups.get(group);
    if (!entry) return null;
    const data = await this.groupData(archive, group, key);
    if (!data) return null;
    const parts = splitGroup(data, entry.fileIds.length);
    const out = new Map<number, Uint8Array>();
    entry.fileIds.forEach((id, i) => out.set(id, parts[i]));
    return out;
  }

  async file(archive: number, group: number, file: number): Promise<Uint8Array | null> {
    return (await this.files(archive, group))?.get(file) ?? null;
  }

  async groupIdByName(archive: number, name: string): Promise<number> {
    return (await this.table(archive))?.groupIdByNameHash(nameHash(name)) ?? -1;
  }

  /** Decodes a named group (e.g. "m50_50"), trying the region's XTEA key if one is known. */
  async namedGroup(archive: number, name: string, key?: XteaKey | null): Promise<Uint8Array | null> {
    const id = await this.groupIdByName(archive, name);
    if (id < 0) return null;
    return this.groupData(archive, id, key);
  }
}
