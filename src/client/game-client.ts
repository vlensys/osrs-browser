import { TICK_MS } from '../engine/game.ts';
import type { FromEngine, MenuOption, PlayerState, SquareMessage, ToEngine } from '../engine/protocol.ts';
import { avatarPose, buildAvatarParts } from './render/avatar.ts';
import { Renderer } from './render/renderer.ts';
import { wheelPixels } from './capabilities.ts';
import { Minimap } from './minimap.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface HeightSquare {
  heights: Int32Array;
  bridges: Uint8Array;
}

// The client's camera pitch range is 128..383 of 2048 units per turn: 22.5° to ~67.3°.
const CAMERA_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
const PITCH_MIN = (128 / 2048) * Math.PI * 2;
const PITCH_MAX = (383 / 2048) * Math.PI * 2;
const ZOOM_MIN = 4;
const ZOOM_MAX = 26;

export interface ClientOptions {
  worker: Worker;
  onFatal(message: string): void;
  onStatus(message: string, fraction: number): void;
  onReady(): void;
  /** Inventory / skills / icon updates for the side panel. */
  onPanel?(msg: Extract<FromEngine, { t: 'inventory' | 'skills' | 'itemIcon' }>): void;
}

/** UI-thread side: renders what the engine worker sends and forwards player input to it. */
export class GameClient {
  readonly renderer: Renderer;
  readonly minimap: Minimap;
  private readonly heights = new Map<number, HeightSquare>();
  private player: PlayerState | null = null;
  /** Interpolation: path walked during the current tick, from the previous position. */
  private walkFrom = { x: 0, y: 0 };
  private walkSteps: { x: number; y: number }[] = [];
  private tickStart = 0;
  private facing = 0;
  private yaw = 0;
  private pitch = PITCH_MIN + (PITCH_MAX - PITCH_MIN) * 0.35;
  private zoom = 10;
  private readonly keys = new Set<string>();
  private dragging: { x: number; y: number; pointer: number } | null = null;
  private hoverSeq = 0;
  private menuSeq = 0;
  private lastHover = 0;
  private mouse = { x: -1, y: -1, inside: false };
  private showRoofs = false;
  private fps = { frames: 0, last: performance.now(), el: $('fps') };
  private ready = false;

  constructor(private readonly opts: ClientOptions) {
    this.renderer = new Renderer($('view'));
    this.renderer.setAvatarParts(buildAvatarParts());
    this.minimap = new Minimap($('minimap'));
    opts.worker.onmessage = (e: MessageEvent<FromEngine>) => this.onMessage(e.data);
    opts.worker.onerror = (e) => opts.onFatal(`Engine crashed: ${e.message || 'unknown error'}`);
    this.bindInput();
    this.bindHud();
    requestAnimationFrame((t) => this.frame(t));
  }

  send(msg: ToEngine): void {
    this.opts.worker.postMessage(msg);
  }

  // --- engine messages ---------------------------------------------------------------------

  private onMessage(msg: FromEngine): void {
    switch (msg.t) {
      case 'status':
        this.opts.onStatus(msg.message, msg.fraction);
        break;
      case 'fatal':
        this.opts.onFatal(msg.message);
        break;
      case 'ready':
        this.ready = true;
        this.setPlayer(msg.player, true);
        this.opts.onReady();
        $('view').focus();
        break;
      case 'textures':
        this.renderer.setTextures(msg);
        break;
      case 'square':
        this.addSquare(msg);
        break;
      case 'groundItems':
        this.renderer.setGroundItems(msg.mesh);
        break;
      case 'inventory':
      case 'skills':
      case 'itemIcon':
        this.opts.onPanel?.(msg);
        break;
      case 'unload':
        this.renderer.removeSquare(msg.rx, msg.ry);
        this.minimap.removeSquare(msg.rx, msg.ry);
        this.heights.delete((msg.rx << 8) | msg.ry);
        break;
      case 'tick':
        this.setPlayer(msg.player, false);
        break;
      case 'chat':
        this.chat(msg.text, msg.kind);
        break;
      case 'menu':
        if (msg.seq === this.menuSeq) this.openMenu(msg.options);
        break;
      case 'hover':
        if (msg.seq === this.hoverSeq) this.setHover(msg.option);
        break;
    }
  }

  private addSquare(msg: SquareMessage): void {
    this.heights.set((msg.rx << 8) | msg.ry, { heights: msg.heights, bridges: msg.bridges });
    this.renderer.addSquare(msg);
    void this.minimap.addSquare(msg);
  }

  private setPlayer(p: PlayerState, snap: boolean): void {
    const prev = this.player;
    this.player = p;
    if (snap || !prev || p.steps.length === 0 || Math.abs(prev.x - p.x) + Math.abs(prev.y - p.y) > 4) {
      this.walkFrom = { x: p.x, y: p.y };
      this.walkSteps = [];
    } else {
      this.walkFrom = this.interpolated();
      this.walkSteps = p.steps;
    }
    this.tickStart = performance.now();
    $('run-energy').textContent = String(p.energy);
    $('run-orb').setAttribute('aria-pressed', String(p.running));
    $('coords').textContent = `${p.x}, ${p.y}, ${p.plane}`;
  }

  /** Current interpolated tile position (fractional) along this tick's steps. */
  private interpolated(): { x: number; y: number } {
    if (!this.player) return { x: 0, y: 0 };
    if (this.walkSteps.length === 0) return { x: this.player.x, y: this.player.y };
    const t = Math.min(1, (performance.now() - this.tickStart) / TICK_MS);
    const pts = [this.walkFrom, ...this.walkSteps];
    const seg = t * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(seg));
    const f = seg - i;
    const a = pts[i];
    const b = pts[i + 1];
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  /** Bilinear ground height at a fractional tile position on a logical plane, in GL units. */
  private groundY(fx: number, fy: number, plane: number): number {
    const corner = (x: number, y: number) => {
      const sq = this.heights.get(((x >> 6) << 8) | (y >> 6));
      if (!sq) return 0;
      const lx = x & 63;
      const ly = y & 63;
      const dataPlane = Math.min(3, plane + (sq.bridges[lx * 64 + ly] ? 1 : 0));
      return sq.heights[(dataPlane * 64 + lx) * 64 + ly];
    };
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const tx = fx - x;
    const ty = fy - y;
    const a = corner(x, y) + (corner(x + 1, y) - corner(x, y)) * tx;
    const b = corner(x, y + 1) + (corner(x + 1, y + 1) - corner(x, y + 1)) * tx;
    return -(a + (b - a) * ty) / 128;
  }

  // --- frame -------------------------------------------------------------------------------

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const canvas = this.renderer.canvas;
    const rect = canvas.getBoundingClientRect();
    this.renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    this.applyKeys();
    if (!this.player) return;

    const pos = this.interpolated();
    // Tile centres: a tile (x, y) spans [x, x+1] in GL x and [-y-1, -y] in GL z.
    const gx = pos.x + 0.5;
    const gy = pos.y + 0.5;
    const ground = this.groundY(gx, gy, this.player.plane);
    if (this.walkSteps.length) {
      const last = this.walkSteps[this.walkSteps.length - 1];
      const from = this.walkSteps.length > 1 ? this.walkSteps[this.walkSteps.length - 2] : this.walkFrom;
      if (last.x !== from.x || last.y !== from.y) this.facing = Math.atan2(last.x - from.x, last.y - from.y);
    } else {
      this.facing = this.player.facing;
    }
    this.renderer.setCamera([gx, ground + 1.1, -gy], this.yaw, this.pitch, this.zoom);
    const maxPlane = this.showRoofs ? 3 : this.player.maxPlane;
    this.renderer.fogRange = [this.fogStart(), this.fogStart() + 22];
    const moving = this.walkSteps.length > 0 && performance.now() - this.tickStart < 600;
    const pose = avatarPose(now / 1000, moving, this.player.running, this.player.action);
    this.renderer.render(maxPlane, [gx, ground, -gy], this.facing, pose);
    this.minimap.draw(pos.x, pos.y, this.player.plane, this.yaw, this.player);
    ($('compass').firstElementChild as HTMLElement).style.transform = `rotate(${-this.yaw}rad)`;

    if (this.mouse.inside && !this.dragging && now - this.lastHover > 120 && $('context-menu').hidden) {
      this.lastHover = now;
      const dpr = canvas.width / rect.width;
      const id = this.renderer.pick(this.mouse.x * dpr, this.mouse.y * dpr, maxPlane);
      this.send({ t: 'hover', seq: ++this.hoverSeq, pick: id });
    }

    this.fps.frames++;
    if (now - this.fps.last > 1000) {
      const s = this.renderer.stats();
      this.fps.el.textContent = `${this.fps.frames} fps · ${s.squares} squares · ${(s.vertices / 3 / 1000).toFixed(0)}k tris`;
      this.fps.frames = 0;
      this.fps.last = now;
    }
  }

  private drawRadius = 1;

  private fogStart(): number {
    return 20 + (this.drawRadius - 1) * 64;
  }

  private applyKeys(): void {
    const k = this.keys;
    const step = 0.035;
    if (k.has('ArrowLeft') || k.has('KeyA')) this.yaw -= step;
    if (k.has('ArrowRight') || k.has('KeyD')) this.yaw += step;
    if (k.has('ArrowUp') || k.has('KeyW')) this.pitch = Math.min(PITCH_MAX, this.pitch + step * 0.6);
    if (k.has('ArrowDown') || k.has('KeyS')) this.pitch = Math.max(PITCH_MIN, this.pitch - step * 0.6);
  }

  // --- input -------------------------------------------------------------------------------

  private canvasPick(e: { clientX: number; clientY: number }): number {
    const canvas = this.renderer.canvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const maxPlane = this.showRoofs ? 3 : (this.player?.maxPlane ?? 3);
    return this.renderer.pick((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr, maxPlane);
  }

  private bindInput(): void {
    const canvas = this.renderer.canvas;
    // Right-click is the game's context menu everywhere on the view.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      this.closeMenu();
      canvas.focus();
      if (!this.ready) return;
      if (e.button === 1) {
        // Middle button: camera drag. preventDefault stops Windows autoscroll and Linux paste.
        e.preventDefault();
        this.dragging = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button === 0) {
        const pick = this.canvasPick(e);
        if (pick) {
          this.send({ t: 'click', pick });
          this.clickFx(e.clientX, e.clientY, '#ffff00');
        }
      } else if (e.button === 2) {
        const pick = this.canvasPick(e);
        this.menuAt = { x: e.clientX, y: e.clientY };
        this.send({ t: 'menu', seq: ++this.menuSeq, pick });
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top, inside: true };
      if (this.dragging && e.pointerId === this.dragging.pointer) {
        const dx = e.clientX - this.dragging.x;
        const dy = e.clientY - this.dragging.y;
        this.dragging.x = e.clientX;
        this.dragging.y = e.clientY;
        this.yaw += dx * 0.008;
        this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitch + dy * 0.006));
      }
    });
    const endDrag = (e: PointerEvent) => {
      if (this.dragging && e.pointerId === this.dragging.pointer) this.dragging = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', () => {
      this.mouse.inside = false;
      this.setHover(null);
    });
    // Firefox needs auxclick suppressed too, or middle-click can trigger autoscroll/paste handlers.
    canvas.addEventListener('auxclick', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * Math.exp(wheelPixels(e) * 0.0012)));
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
        if (e.key === 'Escape') target.blur();
        return;
      }
      // Physical key positions (e.code), so WASD sits in the same place on AZERTY/QWERTZ layouts too.
      if (CAMERA_KEYS.has(e.code)) {
        e.preventDefault();
        this.keys.add(e.code);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        $('chat-input').focus();
      } else if (e.key === 'Escape') {
        this.closeMenu();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // Alt-Tab / focus loss on Windows can swallow keyup events: never leave the camera spinning.
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.keys.clear();
        this.send({ t: 'save' });
      }
    });
    window.addEventListener('pagehide', () => this.send({ t: 'save' }));
    document.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('#context-menu') && e.target !== canvas) this.closeMenu();
    });
  }

  private bindHud(): void {
    const minimap = this.minimap.canvas;
    minimap.addEventListener('contextmenu', (e) => e.preventDefault());
    minimap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.player) return;
      const pos = this.interpolated();
      const tile = this.minimap.tileAt(e.clientX, e.clientY, pos, this.yaw);
      if (tile) this.send({ t: 'action', action: { kind: 'walk', x: tile.x, y: tile.y } });
    });
    $('compass').addEventListener('click', () => (this.yaw = 0));
    $('run-orb').addEventListener('click', () => {
      if (this.player) this.send({ t: 'run', enabled: !this.player.running });
    });
    $('btn-settings').addEventListener('click', () => ($('settings').hidden = !$('settings').hidden));
    const radius = $<HTMLSelectElement>('opt-radius');
    radius.addEventListener('change', () => {
      this.drawRadius = Number(radius.value);
      this.send({ t: 'drawRadius', radius: this.drawRadius });
      try {
        localStorage.setItem('osrs-browser.radius', radius.value);
      } catch {
        /* storage may be blocked */
      }
    });
    try {
      const saved = localStorage.getItem('osrs-browser.radius');
      if (saved) {
        radius.value = saved;
        this.drawRadius = Number(saved);
      }
    } catch {
      /* storage may be blocked */
    }
    $<HTMLInputElement>('opt-roofs').addEventListener('change', (e) => (this.showRoofs = (e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('opt-fps').addEventListener('change', (e) => ($('fps').hidden = !(e.target as HTMLInputElement).checked));
    $('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>('chat-input');
      const text = input.value.trim();
      input.value = '';
      input.blur();
      if (!text) return;
      if (text.startsWith('::')) this.send({ t: 'command', text });
      else this.chat(`You: ${text}`, 'game');
    });
  }

  /** Opens the game's context menu for an inventory slot at a screen position. */
  openItemMenu(x: number, y: number, slot: number): void {
    this.menuAt = { x, y };
    this.send({ t: 'itemMenu', seq: ++this.menuSeq, slot });
  }

  /** Test/debug hooks (exposed as window.__game). */
  debug() {
    const self = this;
    return {
      player: () => this.player,
      stats: () => this.renderer.stats(),
      /** Screen position (client coords) of a point `lift` tiles above a tile's centre. */
      projectTile(x: number, y: number, plane: number, lift = 0.2, dx = 0.5, dy = 0.5) {
        const p = self.renderer.project([x + dx, self.groundY(x + dx, y + dy, plane) + lift, -(y + dy)]);
        if (!p) return null;
        const rect = self.renderer.canvas.getBoundingClientRect();
        return { x: rect.left + p.x, y: rect.top + p.y };
      },
      /** Renders a frame now and samples a 5x5 grid of pixels. */
      sample() {
        const maxPlane = self.showRoofs ? 3 : (self.player?.maxPlane ?? 3);
        const pos = self.interpolated();
        const ground = self.groundY(pos.x + 0.5, pos.y + 0.5, self.player?.plane ?? 0);
        self.renderer.render(maxPlane, [pos.x + 0.5, ground, -(pos.y + 0.5)], self.facing, avatarPose(0, false, false, null));
        const pts: [number, number][] = [];
        for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) pts.push([i / 6, j / 6]);
        return self.renderer.sample(pts);
      },
      setCamera(yaw: number, pitch: number, zoom: number) {
        self.yaw = yaw;
        self.pitch = pitch;
        self.zoom = zoom;
      },
    };
  }

  get initialRadius(): number {
    return this.drawRadius;
  }

  // --- menus / hud -------------------------------------------------------------------------

  private menuAt = { x: 0, y: 0 };

  private optionHtml(o: MenuOption): DocumentFragment {
    const f = document.createDocumentFragment();
    f.append(o.verb);
    if (o.target) {
      const t = document.createElement('span');
      t.className = 'target';
      t.textContent = ` ${o.target}`;
      f.append(t);
    }
    return f;
  }

  private openMenu(options: MenuOption[]): void {
    const menu = $('context-menu');
    menu.replaceChildren();
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Choose Option';
    menu.append(title);
    for (const o of options) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.append(this.optionHtml(o));
      b.addEventListener('click', () => {
        this.closeMenu();
        if (o.action.kind !== 'cancel') {
          this.send({ t: 'action', action: o.action });
          this.clickFx(this.menuAt.x, this.menuAt.y, o.action.kind === 'walk' ? '#ffff00' : '#ff0000');
        }
      });
      menu.append(b);
    }
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const x = Math.min(window.innerWidth - w - 2, Math.max(2, this.menuAt.x - w / 2));
    const y = Math.min(window.innerHeight - h - 2, Math.max(2, this.menuAt.y - 8));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.addEventListener('pointerleave', () => this.closeMenu(), { once: true });
  }

  private closeMenu(): void {
    $('context-menu').hidden = true;
  }

  private setHover(option: MenuOption | null): void {
    const el = $('hover-text');
    el.replaceChildren();
    if (option) el.append(this.optionHtml(option));
  }

  private clickFx(x: number, y: number, colour: string): void {
    const el = $('click-fx');
    el.classList.remove('show');
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.color = colour;
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
  }

  chat(text: string, kind: 'game' | 'system' | 'error' = 'game'): void {
    const log = $('chat-log');
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = text;
    log.append(li);
    while (log.children.length > 100) log.firstElementChild!.remove();
    log.scrollTop = log.scrollHeight;
  }
}
