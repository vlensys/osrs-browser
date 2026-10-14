import type { LocDef } from '../defs/config.ts';
import { findPath, type Tile } from '../world/pathfinder.ts';
import { Flag, SIDE_DX, SIDE_DY } from '../world/collision.ts';
import { decodePick } from '../world/mesh.ts';
import { allocUid, isWall, LocType, type LocInstance, type World } from '../world/world.ts';
import { AXES, PICKAXES, resourceFor, successChance, type Resource } from './gathering.ts';
import { Inventory, type Slot } from './inventory.ts';
import type { ActionRef, GroundItem, MenuOption, PlayerState } from './protocol.ts';
import { Skills } from './skills.ts';

export const TICK_MS = 600;
export const SPAWN = { x: 3222, y: 3218, plane: 0 };

export interface SaveGame {
  version: 1;
  x: number;
  y: number;
  plane: number;
  running: boolean;
  energy: number;
  ticks: number;
  /** Doors etc. the player has toggled: uid-independent key -> new rotation/offset. */
  toggledLocs: string[];
  /** XP per skill, in tenths. */
  skills?: Record<string, number>;
  inventory?: (Slot | null)[];
}

export interface GameEvents {
  chat(text: string, kind?: 'game' | 'system' | 'error'): void;
  /** A loc changed; the square containing it must be rebuilt. */
  locsChanged(squares: Set<number>): void;
  /** The player moved into a different map square or plane. */
  regionChanged(): void;
  inventoryChanged?(): void;
  skillsChanged?(): void;
  groundItemsChanged?(): void;
}

interface Gathering {
  loc: LocInstance;
  res: Resource;
  toolBonus: number;
  timer: number;
}

/** Ground items despawn after 3 minutes, like the game's public timer. */
const GROUND_ITEM_TICKS = 300;

interface Pending {
  loc: LocInstance;
  op: number;
}

const locKey = (l: { id: number; plane: number; x: number; y: number; type: number }) => `${l.id}:${l.plane}:${l.x}:${l.y}:${l.type}`;

/**
 * Authoritative single-player game state, advanced once per 600 ms tick: movement, doors, ladders and
 * stairs, skills, an inventory, woodcutting/mining and ground items. The cache carries no server-side
 * scripts, NPC spawns or drop tables, so other content isn't implemented.
 */
export class Game {
  x = SPAWN.x;
  y = SPAWN.y;
  plane = SPAWN.plane;
  running = false;
  energy = 10000;
  ticks = 0;
  facing = 0;
  private path: Tile[] = [];
  private dest: Tile | null = null;
  private pending: Pending | null = null;
  private stepsThisTick: Tile[] = [];
  /** Locs swung open/closed by the player, keyed by their original placement. */
  private toggled = new Set<string>();
  private dirty = false;
  readonly skills = new Skills();
  readonly inventory: Inventory;
  private gathering: Gathering | null = null;
  private readonly respawns: { at: number; loc: LocInstance; id: number }[] = [];
  readonly groundItems: GroundItem[] = [];

  constructor(
    readonly world: World,
    readonly events: GameEvents,
  ) {
    this.inventory = new Inventory((id) => this.world.configs.obj(id)?.stackable ?? false);
  }

  /** A new character starts with an axe and a pickaxe from the cache's item list. */
  newGame(): void {
    for (const name of ['Bronze axe', 'Bronze pickaxe']) {
      const obj = this.world.configs.objByName(name);
      if (obj) this.inventory.add(obj.id);
    }
    this.dirty = true;
  }

  load(save: SaveGame | undefined): void {
    if (!save || save.version !== 1) {
      this.newGame();
      return;
    }
    this.skills.load(save.skills);
    if (save.inventory) this.inventory.load(save.inventory);
    else this.newGame();
    this.x = save.x;
    this.y = save.y;
    this.plane = save.plane;
    this.running = save.running;
    this.energy = save.energy;
    this.ticks = save.ticks;
    this.toggled = new Set(save.toggledLocs);
  }

  save(): SaveGame {
    this.dirty = false;
    return {
      version: 1,
      x: this.x,
      y: this.y,
      plane: this.plane,
      running: this.running,
      energy: this.energy,
      ticks: this.ticks,
      toggledLocs: [...this.toggled],
      skills: this.skills.toJSON(),
      inventory: this.inventory.toJSON(),
    };
  }

  get needsSave(): boolean {
    return this.dirty;
  }

  /** Re-applies saved door states to freshly loaded locs. */
  applyToggles(locs: LocInstance[]): void {
    for (const loc of locs) if (this.toggled.has(locKey(loc))) this.swing(loc, false);
  }

  state(): PlayerState {
    return {
      x: this.x,
      y: this.y,
      plane: this.plane,
      running: this.running,
      energy: Math.floor(this.energy / 100),
      dest: this.dest,
      steps: this.stepsThisTick,
      facing: this.facing,
      maxPlane: this.world.maxVisiblePlane(this.plane, this.x, this.y),
      action: this.gathering ? (this.gathering.res.skill === 'Woodcutting' ? 'chop' : 'mine') : null,
    };
  }

  setRunning(on: boolean): void {
    this.running = on && this.energy > 0;
    this.dirty = true;
  }

  teleport(x: number, y: number, plane: number): void {
    this.x = x;
    this.y = y;
    this.plane = plane;
    this.path = [];
    this.dest = null;
    this.pending = null;
    this.stepsThisTick = [{ x, y }];
    this.dirty = true;
    // Plane changes alter what's visible even within the same square, so always refresh.
    this.events.regionChanged();
  }

  // --- menus ---------------------------------------------------------------------------------

  private activeDef(loc: LocInstance): LocDef | undefined {
    const def = this.world.locDef(loc.id);
    if (!def?.multiLocs) return def;
    const id = def.multiLocs[0] !== -1 ? def.multiLocs[0] : def.multiLocs[def.multiLocs.length - 1];
    return id === -1 ? undefined : this.world.locDef(id);
  }

  private locOps(loc: LocInstance): (string | null)[] {
    const def = this.activeDef(loc);
    if (!def) return [];
    const ops = [...def.ops];
    // Swung doors flip their Open/Close verb.
    if (this.toggled.has(locKey(this.original(loc)))) {
      for (let i = 0; i < ops.length; i++) {
        if (ops[i] === 'Open') ops[i] = 'Close';
        else if (ops[i] === 'Close') ops[i] = 'Open';
      }
    }
    return ops;
  }

  private original(loc: LocInstance): LocInstance {
    return (loc as LocInstance & { orig?: LocInstance }).orig ?? loc;
  }

  menu(pick: number): MenuOption[] {
    const p = decodePick(pick);
    const options: MenuOption[] = [];
    const ground = p.kind === 'loc' ? this.groundItems.find((g) => g.uid === p.uid) : undefined;
    if (ground) {
      const obj = this.world.configs.obj(ground.id);
      const name = obj?.name ?? 'item';
      options.push({ verb: 'Take', target: name, action: { kind: 'take', uid: ground.uid } });
      options.push({ verb: 'Walk here', target: '', action: { kind: 'walk', x: ground.x, y: ground.y } });
      options.push({ verb: 'Examine', target: name, action: { kind: 'examineObj', id: ground.id } });
    } else if (p.kind === 'loc') {
      const found = this.world.findLoc(p.uid);
      const def = found && this.activeDef(found.loc);
      if (found && def && def.name !== 'null') {
        this.locOps(found.loc).forEach((verb, op) => {
          if (verb) options.push({ verb, target: def.name, action: { kind: 'loc', uid: p.uid, op } });
        });
      }
      if (found) options.push({ verb: 'Walk here', target: '', action: { kind: 'walk', x: found.loc.x, y: found.loc.y } });
      if (found && def && def.name !== 'null') options.push({ verb: 'Examine', target: def.name, action: { kind: 'examine', uid: p.uid } });
    } else if (p.kind === 'tile') {
      for (const g of this.groundItems.filter((g) => g.plane === p.plane && g.x === p.x && g.y === p.y)) {
        options.push({ verb: 'Take', target: this.world.configs.obj(g.id)?.name ?? 'item', action: { kind: 'take', uid: g.uid } });
      }
      options.push({ verb: 'Walk here', target: '', action: { kind: 'walk', x: p.x, y: p.y } });
      for (const loc of this.world.locsAt(p.plane, p.x, p.y)) {
        const def = this.activeDef(loc);
        if (!def || def.name === 'null') continue;
        this.locOps(loc).forEach((verb, op) => {
          if (verb) options.push({ verb, target: def.name, action: { kind: 'loc', uid: loc.uid, op } });
        });
      }
    }
    options.push({ verb: 'Cancel', target: '', action: { kind: 'cancel' } });
    return options;
  }

  /** The default (left-click) option: first loc op if any, else walk. */
  defaultOption(pick: number): MenuOption | null {
    const opts = this.menu(pick);
    return opts.find((o) => o.action.kind === 'loc' || o.action.kind === 'take') ?? opts.find((o) => o.action.kind === 'walk') ?? null;
  }

  /** Left-click on an inventory item: its first listed op, if any. */
  itemDefault(slot: number): void {
    const opt = this.itemMenu(slot).find((o) => o.action.kind === 'item');
    if (opt) this.act(opt.action);
  }

  /** Right-click options for an inventory slot: the item's own ops from the cache, then Examine. */
  itemMenu(slot: number): MenuOption[] {
    const s = this.inventory.slots[slot];
    if (!s) return [];
    const obj = this.world.configs.obj(s.id);
    const name = obj?.name ?? 'item';
    const options: MenuOption[] = [];
    (obj?.invOps ?? [null, null, null, null, 'Drop']).forEach((verb, op) => {
      if (verb) options.push({ verb, target: name, action: { kind: 'item', slot, op } });
    });
    options.push({ verb: 'Examine', target: name, action: { kind: 'examineObj', id: s.id } });
    options.push({ verb: 'Cancel', target: '', action: { kind: 'cancel' } });
    return options;
  }

  // --- actions -------------------------------------------------------------------------------

  act(action: ActionRef): { x: number; y: number; kind: 'walk' | 'interact' } | null {
    switch (action.kind) {
      case 'cancel':
        return null;
      case 'examineObj': {
        const obj = this.world.configs.obj(action.id);
        if (obj) this.events.chat(obj.examine ?? `It's ${/^[aeiou]/i.test(obj.name) ? 'an' : 'a'} ${obj.name.toLowerCase()}.`);
        return null;
      }
      case 'item':
        this.itemOp(action.slot, action.op);
        return null;
      case 'take': {
        const g = this.groundItems.find((i) => i.uid === action.uid);
        if (!g) return null;
        this.stopGathering();
        this.pendingTake = g.uid;
        this.pending = null;
        this.walkTo({ x: g.x, y: g.y });
        return { x: g.x, y: g.y, kind: 'interact' };
      }
      case 'moveItem':
        this.inventory.move(action.from, action.to);
        this.events.inventoryChanged?.();
        this.dirty = true;
        return null;
      case 'walk':
        this.stopGathering();
        this.pendingTake = -1;
        this.pending = null;
        this.walkTo({ x: action.x, y: action.y });
        return { x: action.x, y: action.y, kind: 'walk' };
      case 'examine': {
        const found = this.world.findLoc(action.uid);
        const def = found && this.activeDef(found.loc);
        if (def) this.events.chat(examineText(def));
        return null;
      }
      case 'loc': {
        const found = this.world.findLoc(action.uid);
        if (!found) return null;
        this.stopGathering();
        this.pendingTake = -1;
        this.pending = { loc: found.loc, op: action.op };
        this.walkTo({ x: found.loc.x, y: found.loc.y }, found.loc);
        if (this.canInteract(found.loc)) this.path = [];
        return { x: found.loc.x, y: found.loc.y, kind: 'interact' };
      }
    }
  }

  private pendingTake = -1;

  private itemOp(slot: number, op: number): void {
    const s = this.inventory.slots[slot];
    if (!s) return;
    const obj = this.world.configs.obj(s.id);
    const verb = (obj?.invOps[op] ?? (op === 4 ? 'Drop' : '')).toLowerCase();
    if (verb === 'drop' || verb === 'destroy') {
      this.inventory.removeSlot(slot);
      this.dropToFloor(s.id, s.count);
      this.events.inventoryChanged?.();
      this.dirty = true;
      return;
    }
    this.events.chat('Nothing interesting happens.');
  }

  private dropToFloor(id: number, count: number): void {
    this.groundItems.push({ uid: allocUid(), id, count, x: this.x, y: this.y, plane: this.plane, expires: this.ticks + GROUND_ITEM_TICKS });
    this.events.groundItemsChanged?.();
  }

  private stopGathering(): void {
    this.gathering = null;
  }

  private bestTool(tools: [string, number, number][], skill: Resource['skill']): [string, number, number] | null {
    const level = this.skills.level(skill);
    for (const t of tools) {
      const obj = this.world.configs.objByName(t[0]);
      if (obj && this.inventory.count(obj.id) > 0 && level >= t[1]) return t;
    }
    return null;
  }

  private startGathering(loc: LocInstance, res: Resource, name: string): void {
    const woodcutting = res.skill === 'Woodcutting';
    if (this.skills.level(res.skill) < res.level) {
      this.events.chat(`You need a ${res.skill} level of ${res.level} to ${woodcutting ? 'chop down this tree' : 'mine this rock'}.`);
      return;
    }
    const tool = this.bestTool(woodcutting ? AXES : PICKAXES, res.skill);
    if (!tool) {
      this.events.chat(woodcutting ? 'You do not have an axe which you have the woodcutting level to use.' : 'You need a pickaxe to mine this rock. You do not have a pickaxe which you have the Mining level to use.');
      return;
    }
    if (this.inventory.freeSlots() === 0 && !this.world.configs.objByName(res.product)?.stackable) {
      this.events.chat(`Your inventory is too full to hold any more ${res.product.toLowerCase()}.`);
      return;
    }
    this.events.chat(woodcutting ? 'You swing your axe at the tree.' : 'You swing your pick at the rock.');
    void name;
    this.gathering = { loc, res, toolBonus: tool[2], timer: res.interval };
  }

  private tickGathering(): void {
    const g = this.gathering;
    if (!g) return;
    if (!this.world.findLoc(g.loc.uid) || this.world.locDef(g.loc.id)?.name === undefined || !resourceFor(this.world.locDef(g.loc.id)!.name, g.res.skill === 'Woodcutting' ? 'Chop down' : 'Mine')) {
      this.gathering = null;
      return;
    }
    if (--g.timer > 0) return;
    g.timer = g.res.interval;
    if (Math.random() >= successChance(g.res, this.skills.level(g.res.skill), g.toolBonus)) return;
    const product = this.world.configs.objByName(g.res.product);
    if (!product) {
      this.events.chat(`(No item named "${g.res.product}" in this cache.)`, 'error');
      this.gathering = null;
      return;
    }
    if (this.inventory.add(product.id) > 0) {
      this.events.chat(`Your inventory is too full to hold any more ${g.res.product.toLowerCase()}.`);
      this.gathering = null;
      return;
    }
    const woodcutting = g.res.skill === 'Woodcutting';
    const what = g.res.product.toLowerCase();
    this.events.chat(woodcutting ? `You get some ${what}.` : `You manage to mine some ${what.replace(/ ore$/, '')}.`);
    const levelled = this.skills.addXp(g.res.skill, g.res.xp);
    if (levelled) {
      const article = /^[AEIOU]/.test(g.res.skill) ? 'an' : 'a';
      this.events.chat(`Congratulations, you've just advanced ${article} ${g.res.skill} level. You are now level ${levelled}.`, 'system');
    }
    this.events.inventoryChanged?.();
    this.events.skillsChanged?.();
    this.dirty = true;
    if (Math.random() < g.res.depleteChance) {
      this.deplete(g.loc, g.res);
      this.gathering = null;
      if (!woodcutting) return;
    }
    if (this.inventory.freeSlots() === 0 && !product.stackable) {
      this.events.chat(`Your inventory is too full to hold any more ${what}.`);
      this.gathering = null;
    }
  }

  private deplete(loc: LocInstance, res: Resource): void {
    const original = loc.id;
    const into = this.world.configs.depletedFor(original);
    this.events.locsChanged(this.world.replaceLoc(loc, into));
    this.respawns.push({ at: this.ticks + res.respawn, loc, id: original });
  }

  private tickWorld(): void {
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i];
      if (this.ticks < r.at) continue;
      this.respawns.splice(i, 1);
      if (this.world.findLoc(r.loc.uid)) this.events.locsChanged(this.world.replaceLoc(r.loc, r.id));
    }
    const before = this.groundItems.length;
    for (let i = this.groundItems.length - 1; i >= 0; i--) if (this.groundItems[i].expires <= this.ticks) this.groundItems.splice(i, 1);
    if (this.groundItems.length !== before) this.events.groundItemsChanged?.();
  }

  private tryTake(): void {
    if (this.pendingTake < 0 || this.path.length) return;
    const idx = this.groundItems.findIndex((g) => g.uid === this.pendingTake);
    this.pendingTake = -1;
    if (idx < 0) return;
    const g = this.groundItems[idx];
    if (g.x !== this.x || g.y !== this.y || g.plane !== this.plane) {
      this.events.chat("I can't reach that!");
      return;
    }
    const left = this.inventory.add(g.id, g.count);
    if (left === g.count) {
      this.events.chat("You don't have enough inventory space to hold that item.");
      return;
    }
    if (left > 0) g.count = left;
    else this.groundItems.splice(idx, 1);
    this.events.inventoryChanged?.();
    this.events.groundItemsChanged?.();
    this.dirty = true;
  }

  private walkTo(dest: Tile, target?: LocInstance): void {
    const reached = target ? (x: number, y: number) => this.adjacentTo(target, x, y) : undefined;
    this.path = findPath(this.world.collision, this.plane, { x: this.x, y: this.y }, dest, reached);
    this.dest = this.path.length ? this.path[this.path.length - 1] : null;
  }

  /** Can the player standing at (x, y) interact with the loc? */
  private adjacentTo(loc: LocInstance, x: number, y: number): boolean {
    const [sx, sy] = this.world.footprint(loc);
    if (isWall(loc.type) || loc.type === LocType.WallDecorStraight) {
      // Walls/doors: from the wall's own tile or the tile on the other side of the wall edge.
      const r = loc.rotation & 3;
      if (x === loc.x && y === loc.y) return true;
      return x === loc.x + SIDE_DX[r] && y === loc.y + SIDE_DY[r];
    }
    const def = this.world.locDef(loc.id);
    if (def && def.interactType === 0) {
      return x >= loc.x - 1 && x <= loc.x + sx && y >= loc.y - 1 && y <= loc.y + sy;
    }
    // Orthogonally adjacent to the footprint (not inside, not diagonal corners).
    const insideX = x >= loc.x && x < loc.x + sx;
    const insideY = y >= loc.y && y < loc.y + sy;
    if (insideX && (y === loc.y - 1 || y === loc.y + sy)) return true;
    if (insideY && (x === loc.x - 1 || x === loc.x + sx)) return true;
    return false;
  }

  private canInteract(loc: LocInstance): boolean {
    return loc.plane === this.plane && this.adjacentTo(loc, this.x, this.y);
  }

  // --- tick ----------------------------------------------------------------------------------

  tick(): void {
    this.ticks++;
    const fromSquare = ((this.x >> 6) << 8) | (this.y >> 6);
    this.stepsThisTick = [];
    const startX = this.x;
    const startY = this.y;

    const stepsAllowed = this.running && this.energy > 0 && this.path.length > 1 ? 2 : 1;
    let moved = 0;
    for (let i = 0; i < stepsAllowed && this.path.length; i++) {
      const next = this.path.shift()!;
      const dx = Math.sign(next.x - this.x);
      const dy = Math.sign(next.y - this.y);
      if (!this.world.collision.canStep(this.plane, this.x, this.y, dx, dy)) {
        this.path = [];
        break;
      }
      this.x += dx;
      this.y += dy;
      this.facing = Math.atan2(dx, dy);
      this.stepsThisTick.push({ x: this.x, y: this.y });
      moved++;
    }
    if (moved === 2) {
      this.energy = Math.max(0, this.energy - 67);
      if (this.energy === 0) {
        this.running = false;
        this.events.chat('You have run out of energy.');
      }
    } else {
      this.energy = Math.min(10000, this.energy + (moved ? 25 : 45));
    }
    if (!this.path.length) this.dest = null;
    if (moved) {
      this.dirty = true;
      this.gathering = null;
    }
    this.tryTake();
    this.tickWorld();
    if (!moved) this.tickGathering();

    if (this.pending && !this.path.length) {
      const { loc, op } = this.pending;
      if (this.canInteract(loc)) {
        this.pending = null;
        this.facing = Math.atan2(loc.x - startX, loc.y - startY);
        this.interact(loc, op);
      } else if (!moved) {
        this.pending = null;
        this.events.chat("I can't reach that!");
      }
    }

    const toSquare = ((this.x >> 6) << 8) | (this.y >> 6);
    if (toSquare !== fromSquare) this.events.regionChanged();
  }

  private interact(loc: LocInstance, op: number): void {
    const verb = (this.locOps(loc)[op] ?? '').toLowerCase();
    const def = this.activeDef(loc);
    const name = def?.name ?? 'that';
    const res = def ? resourceFor(def.name, verb) : null;
    if (res) {
      this.startGathering(loc, res, name);
      return;
    }
    if (verb === 'open' || verb === 'close') {
      if (isWall(loc.type) || loc.type === LocType.WallDiagonal) {
        this.toggleDoor(loc);
        return;
      }
      this.events.chat(verb === 'open' ? `You open the ${name.toLowerCase()}.` : `You close the ${name.toLowerCase()}.`);
      return;
    }
    if (verb.startsWith('climb')) {
      const up = verb === 'climb-up' || (verb === 'climb' && this.plane < 3);
      const down = verb === 'climb-down';
      const target = up && !down ? this.plane + 1 : this.plane - 1;
      if (target < 0 || target > 3) {
        this.events.chat('Nothing interesting happens.');
        return;
      }
      this.changePlane(loc, target, up);
      return;
    }
    if (verb === 'walk-up' || verb === 'walk-down') {
      this.changePlane(loc, verb === 'walk-up' ? this.plane + 1 : this.plane - 1, verb === 'walk-up');
      return;
    }
    this.events.chat('Nothing interesting happens.');
  }

  /** Moves to another plane next to a ladder/staircase, picking a walkable tile around it. */
  private changePlane(loc: LocInstance, target: number, up: boolean): void {
    if (target < 0 || target > 3) return;
    const [sx, sy] = this.world.footprint(loc);
    const c = this.world.collision;
    const candidates: Tile[] = [{ x: this.x, y: this.y }];
    for (let r = 1; r <= 3; r++) {
      for (let dx = -r; dx < sx + r; dx++) {
        candidates.push({ x: loc.x + dx, y: loc.y - r }, { x: loc.x + dx, y: loc.y + sy - 1 + r });
      }
      for (let dy = -r; dy < sy + r; dy++) {
        candidates.push({ x: loc.x - r, y: loc.y + dy }, { x: loc.x + sx - 1 + r, y: loc.y + dy });
      }
    }
    const free = (t: Tile) => (c.get(target, t.x, t.y) & Flag.Full) === 0;
    const spot = candidates.find(free);
    if (!spot) {
      this.events.chat("You can't go that way.");
      return;
    }
    this.events.chat(up ? 'You climb up.' : 'You climb down.');
    this.teleport(spot.x, spot.y, target);
  }

  private toggleDoor(loc: LocInstance): void {
    const opening = !this.toggled.has(locKey(this.original(loc)));
    this.swing(loc, true);
    const def = this.activeDef(loc);
    const name = (def?.name ?? 'door').toLowerCase();
    this.events.chat(opening ? `You open the ${name}.` : `You close the ${name}.`);
  }

  /**
   * Swings a wall-mounted door 90°: it moves to the neighbouring edge, stops blocking the old edge and
   * becomes walk-through on the new one, like an opened door in the game.
   */
  private swing(loc: LocInstance, record: boolean): void {
    const anyLoc = loc as LocInstance & { orig?: LocInstance };
    const orig = anyLoc.orig ?? { ...loc };
    const key = locKey(orig);
    const opening = !this.toggled.has(key) || !record;
    this.world.setLocCollision(loc, false);
    const squares = new Set<number>([((loc.x >> 6) << 8) | (loc.y >> 6)]);
    if (opening && record) this.toggled.add(key);
    else if (record) this.toggled.delete(key);
    if (opening) {
      anyLoc.orig = orig;
      loc.rotation = (orig.rotation + 1) & 3;
      // Opened doors hinge into the neighbouring tile on the wall's side.
      const r = orig.rotation & 3;
      loc.x = orig.x + SIDE_DX[r];
      loc.y = orig.y + SIDE_DY[r];
      // Open doors don't block movement.
    } else {
      loc.rotation = orig.rotation;
      loc.x = orig.x;
      loc.y = orig.y;
      delete anyLoc.orig;
      this.world.setLocCollision(loc, true);
    }
    squares.add(((loc.x >> 6) << 8) | (loc.y >> 6));
    this.dirty = true;
    if (record) this.events.locsChanged(squares);
  }
}

export function examineText(def: LocDef): string {
  const name = def.name;
  const article = /^[aeiou]/i.test(name) ? 'an' : 'a';
  return name.endsWith('s') ? `Some ${name.toLowerCase()}.` : `It's ${article} ${name.toLowerCase()}.`;
}
