/// <reference lib="webworker" />
import { Cache } from '../cache/cache.ts';
import { BlobSource, DiskStore } from '../cache/disk-store.ts';
import type { XteaKey } from '../cache/xtea.ts';
import { ConfigStore } from '../defs/config.ts';
import { TileFlag, tileIndex } from '../defs/mapsquare.ts';
import { DAT2, indexId, loadStoredCacheFiles, storedCacheMeta } from '../storage/cache-import.ts';
import { idbGet, idbPut, STORE_SAVES } from '../storage/idb.ts';
import { meshTransferables } from '../world/mesh.ts';
import { SceneBuilder } from '../world/scene-builder.ts';
import { World, type Square } from '../world/world.ts';
import { Game, TICK_MS, type SaveGame } from './game.ts';
import type { FromEngine, InventoryView, SkillView, SquareMessage, ToEngine } from './protocol.ts';
import { XP_TABLE } from './skills.ts';

declare const self: DedicatedWorkerGlobalScope;

const SAVE_SLOT = 'default';

function post(msg: FromEngine, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

let world: World;
let builder: SceneBuilder;
let game: Game;
let drawRadius = 1;
const sentSquares = new Set<number>();
let regionWork: Promise<void> = Promise.resolve();
let regionDirty = false;

async function boot(radius: number): Promise<void> {
  drawRadius = radius;
  post({ t: 'status', message: 'Opening game cache…', fraction: 0.05 });
  const meta = await storedCacheMeta();
  if (!meta) throw new Error('No game cache imported yet.');
  const files = await loadStoredCacheFiles();
  const dat2 = files.get(DAT2);
  if (!dat2) throw new Error('Cache data file missing from browser storage — please re-import.');
  const indexes = new Map<number, Uint8Array>();
  for (const [name, blob] of files) {
    const id = indexId(name);
    if (id >= 0) indexes.set(id, new Uint8Array(await blob.arrayBuffer()));
  }
  const keys = new Map<number, XteaKey>();
  for (const [region, key] of Object.entries(meta.keys ?? {})) keys.set(Number(region), key);
  const cache = new Cache(new DiskStore(new BlobSource(dat2), indexes), keys);

  post({ t: 'status', message: 'Decoding definitions…', fraction: 0.2 });
  const configs = new ConfigStore(cache);
  await configs.init();
  post({ t: 'status', message: 'Decoding textures…', fraction: 0.3 });
  const atlas = await configs.textureAtlas();
  post({ t: 'textures', layers: atlas.layers, pixels: atlas.pixels, anim: atlas.anim }, [atlas.pixels.buffer, atlas.anim.buffer]);
  world = new World(cache, configs);
  builder = new SceneBuilder(world);

  game = new Game(world, {
    chat: (text, kind = 'game') => post({ t: 'chat', text, kind }),
    locsChanged: (squares) => {
      for (const key of squares) {
        const sq = world.square(key >> 8, key & 255);
        if (sq) regionWork = regionWork.then(() => sendSquare(sq));
      }
    },
    regionChanged: () => scheduleRegion(),
    inventoryChanged: () => postInventory(),
    skillsChanged: () => postSkills(),
    groundItemsChanged: () => scheduleGroundItems(),
  });
  try {
    game.load(await idbGet<SaveGame>(STORE_SAVES, SAVE_SLOT));
  } catch {
    post({ t: 'chat', text: 'Could not read your save; starting fresh.', kind: 'error' });
  }

  post({ t: 'status', message: 'Building the world…', fraction: 0.4 });
  await updateRegion((done, total) => post({ t: 'status', message: `Building the world… (${done}/${total})`, fraction: 0.4 + 0.6 * (done / total) }));
  if (!world.square(game.x >> 6, game.y >> 6)) {
    post({ t: 'chat', text: 'Your saved position is outside the map; returning to Lumbridge.', kind: 'system' });
    game.teleport(3222, 3218, 0);
    await regionWork;
  }
  postInventory();
  postSkills();
  post({ t: 'ready', revision: await cache.revision(), player: game.state() });
  post({ t: 'chat', text: 'Welcome to Old School RuneScape (offline, in your browser).', kind: 'system' });

  setInterval(() => {
    try {
      game.tick();
      post({ t: 'tick', tick: game.ticks, player: game.state() });
      if (game.needsSave && game.ticks % 5 === 0) void persist();
    } catch (e) {
      post({ t: 'chat', text: `Tick error: ${(e as Error).message}`, kind: 'error' });
    }
  }, TICK_MS);
}

function postInventory(): void {
  const view: InventoryView = {
    slots: game.inventory.slots.map((s) => {
      if (!s) return null;
      const obj = world.configs.obj(s.id);
      return { id: s.id, count: s.count, name: obj?.name ?? `Item ${s.id}`, stackable: obj?.stackable ?? false };
    }),
  };
  post({ t: 'inventory', view });
}

function postSkills(): void {
  const skills: SkillView[] = game.skills.snapshot().map(({ skill, level, xp }) => ({
    skill,
    level,
    xp,
    levelXp: XP_TABLE[level],
    nextXp: level < 99 ? XP_TABLE[level + 1] : XP_TABLE[99],
  }));
  post({ t: 'skills', skills, total: game.skills.totalLevel() });
}

let groundWork: Promise<void> = Promise.resolve();
let groundDirty = false;
function scheduleGroundItems(): void {
  if (groundDirty) return;
  groundDirty = true;
  groundWork = groundWork.then(async () => {
    groundDirty = false;
    const mesh = await builder.buildGroundItems(game.groundItems);
    post({ t: 'groundItems', mesh }, meshTransferables(mesh));
  });
}

async function persist(): Promise<void> {
  try {
    await idbPut(STORE_SAVES, SAVE_SLOT, game.save());
  } catch (e) {
    post({ t: 'chat', text: `Saving failed: ${(e as Error).message}`, kind: 'error' });
  }
}

function scheduleRegion(): void {
  if (regionDirty) return;
  regionDirty = true;
  regionWork = regionWork.then(async () => {
    regionDirty = false;
    await updateRegion();
  });
}

async function sendSquare(sq: Square): Promise<void> {
  const meshes = await builder.build(sq);
  const bridges = new Uint8Array(64 * 64);
  for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) bridges[x * 64 + y] = sq.terrain.settings[tileIndex(1, x, y)] & TileFlag.Bridge ? 1 : 0;
  const heights = sq.heights.slice();
  const msg: SquareMessage = { t: 'square', rx: sq.rx, ry: sq.ry, planes: meshes.planes, minimaps: meshes.minimaps, heights, bridges };
  const transfer: Transferable[] = [heights.buffer, bridges.buffer];
  for (const p of meshes.planes) transfer.push(...meshTransferables(p.opaque), ...meshTransferables(p.translucent));
  for (const m of meshes.minimaps) transfer.push(m.buffer as ArrayBuffer);
  post(msg, transfer);
  sentSquares.add(World.key(sq.rx, sq.ry));
}

/** Loads squares within drawRadius (+1 ring decoded for seams/collision), builds new ones, drops far ones. */
async function updateRegion(progress?: (done: number, total: number) => void): Promise<void> {
  const crx = game.x >> 6;
  const cry = game.y >> 6;
  const decodeR = drawRadius + 1;
  const loads: Promise<unknown>[] = [];
  for (let dx = -decodeR; dx <= decodeR; dx++) for (let dy = -decodeR; dy <= decodeR; dy++) loads.push(world.load(crx + dx, cry + dy));
  await Promise.all(loads);

  for (const sq of world.loadedSquares()) {
    if (!(sq as Square & { togglesApplied?: boolean }).togglesApplied) {
      game.applyToggles(sq.locs);
      (sq as Square & { togglesApplied?: boolean }).togglesApplied = true;
    }
  }

  // Nearest squares first so the player's surroundings appear quickly.
  const wanted: Square[] = [];
  for (let dx = -drawRadius; dx <= drawRadius; dx++) {
    for (let dy = -drawRadius; dy <= drawRadius; dy++) {
      const sq = world.square(crx + dx, cry + dy);
      if (sq && !sentSquares.has(World.key(sq.rx, sq.ry))) wanted.push(sq);
    }
  }
  wanted.sort((a, b) => Math.hypot(a.rx - crx, a.ry - cry) - Math.hypot(b.rx - crx, b.ry - cry));
  let done = 0;
  for (const sq of wanted) {
    await sendSquare(sq);
    progress?.(++done, wanted.length);
  }

  for (const key of [...sentSquares]) {
    const rx = key >> 8;
    const ry = key & 255;
    if (Math.abs(rx - crx) > drawRadius + 1 || Math.abs(ry - cry) > drawRadius + 1) {
      sentSquares.delete(key);
      post({ t: 'unload', rx, ry });
    }
  }
  for (const sq of world.loadedSquares()) {
    if (Math.abs(sq.rx - crx) > decodeR + 1 || Math.abs(sq.ry - cry) > decodeR + 1) world.unload(sq.rx, sq.ry);
  }
}

function handleCommand(text: string): void {
  const [cmd, ...args] = text.trim().replace(/^::/, '').split(/\s+/);
  switch (cmd.toLowerCase()) {
    case 'tele': {
      const [x, y, z = '0'] = args.map(String);
      const nx = Number(x);
      const ny = Number(y);
      const nz = Number(z);
      if (!Number.isInteger(nx) || !Number.isInteger(ny) || !(nz >= 0 && nz <= 3)) {
        post({ t: 'chat', text: 'Usage: ::tele x y [plane]', kind: 'error' });
        return;
      }
      game.teleport(nx, ny, nz);
      post({ t: 'chat', text: `Teleported to ${nx}, ${ny}, ${nz}.`, kind: 'system' });
      return;
    }
    case 'pos':
      post({ t: 'chat', text: `You are at ${game.x}, ${game.y}, plane ${game.plane} (square ${game.x >> 6}_${game.y >> 6}).`, kind: 'system' });
      return;
    case 'home':
      game.teleport(3222, 3218, 0);
      return;
    default:
      post({ t: 'chat', text: `Unknown command: ${cmd}. Try ::pos, ::home or ::tele x y [plane].`, kind: 'error' });
  }
}

self.onmessage = (e: MessageEvent<ToEngine>) => {
  const msg = e.data;
  if (msg.t === 'init') {
    boot(msg.drawRadius).catch((err) => post({ t: 'fatal', message: (err as Error).message ?? String(err) }));
    return;
  }
  if (!game) return;
  switch (msg.t) {
    case 'menu':
      post({ t: 'menu', seq: msg.seq, options: game.menu(msg.pick) });
      break;
    case 'hover': {
      const option = msg.pick ? game.defaultOption(msg.pick) : null;
      post({ t: 'hover', seq: msg.seq, option });
      break;
    }
    case 'click': {
      const option = game.defaultOption(msg.pick);
      if (option) game.act(option.action);
      break;
    }
    case 'action':
      game.act(msg.action);
      break;
    case 'run':
      game.setRunning(msg.enabled);
      break;
    case 'command':
      handleCommand(msg.text);
      break;
    case 'drawRadius':
      drawRadius = Math.max(1, Math.min(3, msg.radius));
      scheduleRegion();
      break;
    case 'save':
      void persist();
      break;
    case 'itemClick':
      game.itemDefault(msg.slot);
      break;
    case 'itemMenu':
      post({ t: 'menu', seq: msg.seq, options: game.itemMenu(msg.slot) });
      break;
    case 'itemIcon':
      void builder.itemMesh(msg.id, true).then((im) => {
        if (!im) {
          post({ t: 'itemIcon', id: msg.id, icon: null });
          return;
        }
        post({ t: 'itemIcon', id: msg.id, icon: { id: msg.id, mesh: im.mesh, min: im.min, max: im.max } }, meshTransferables(im.mesh));
      });
      break;
  }
};
