import type { FromEngine, InventoryView, SkillView, ToEngine } from '../engine/protocol.ts';
import { IconRenderer } from './render/icon-renderer.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Stack sizes like the game: plain below 100K, "K" (white) below 10M, "M" (green) above. */
export function formatStack(n: number): { text: string; colour: string } {
  if (n < 100_000) return { text: String(n), colour: '#ffff00' };
  if (n < 10_000_000) return { text: `${Math.floor(n / 1000)}K`, colour: '#ffffff' };
  return { text: `${Math.floor(n / 1_000_000)}M`, colour: '#00ff80' };
}

/** Inventory + skills tabs. Item icons are rendered from the cache's item models on demand. */
export class SidePanel {
  private readonly icons = new IconRenderer();
  private readonly pendingIcons = new Set<number>();
  private inventory: InventoryView = { slots: new Array(28).fill(null) };
  private dragFrom = -1;

  constructor(
    private readonly send: (msg: ToEngine) => void,
    private readonly openMenu: (x: number, y: number, slot: number) => void,
  ) {
    for (const tab of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
      tab.addEventListener('click', () => this.show(tab.dataset.tab!));
    }
    this.buildInventoryGrid();
  }

  show(tab: string): void {
    for (const t of document.querySelectorAll<HTMLButtonElement>('#tabs button')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    for (const p of document.querySelectorAll<HTMLElement>('.tab-page')) p.hidden = p.id !== `page-${tab}`;
  }

  handle(msg: Extract<FromEngine, { t: 'inventory' | 'skills' | 'itemIcon' }>): void {
    if (msg.t === 'inventory') {
      this.inventory = msg.view;
      this.renderInventory();
    } else if (msg.t === 'skills') {
      this.renderSkills(msg.skills, msg.total);
    } else if (msg.t === 'itemIcon') {
      this.pendingIcons.delete(msg.id);
      if (msg.icon) this.icons.render(msg.icon);
      this.renderInventory();
    }
  }

  private buildInventoryGrid(): void {
    const grid = $('inventory');
    for (let i = 0; i < 28; i++) {
      const cell = document.createElement('div');
      cell.className = 'slot';
      cell.dataset.slot = String(i);
      cell.addEventListener('contextmenu', (e) => e.preventDefault());
      cell.addEventListener('pointerdown', (e) => {
        if (!this.inventory.slots[i]) return;
        if (e.button === 2) {
          this.openMenu(e.clientX, e.clientY, i);
        } else if (e.button === 0) {
          this.dragFrom = i;
          cell.setPointerCapture(e.pointerId);
        }
      });
      cell.addEventListener('pointerup', (e) => {
        if (e.button !== 0 || this.dragFrom < 0) return;
        const from = this.dragFrom;
        this.dragFrom = -1;
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.slot');
        const to = target ? Number(target.dataset.slot) : from;
        if (to !== from) {
          this.send({ t: 'action', action: { kind: 'moveItem', from, to } });
        } else {
          // Left-click: the item's first listed option (e.g. Wield, Eat, Bury).
          this.send({ t: 'itemClick', slot: from });
        }
      });
      grid.append(cell);
    }
  }

  private renderInventory(): void {
    const cells = $('inventory').children;
    this.inventory.slots.forEach((s, i) => {
      const cell = cells[i] as HTMLElement;
      cell.replaceChildren();
      cell.title = '';
      if (!s) return;
      cell.title = s.name;
      const url = this.icons.cache.get(s.id);
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = s.name;
        img.draggable = false;
        cell.append(img);
      } else {
        if (!this.pendingIcons.has(s.id)) {
          this.pendingIcons.add(s.id);
          this.send({ t: 'itemIcon', id: s.id });
        }
        const label = document.createElement('span');
        label.className = 'fallback';
        label.textContent = s.name;
        cell.append(label);
      }
      if (s.stackable || s.count > 1) {
        const { text, colour } = formatStack(s.count);
        const n = document.createElement('span');
        n.className = 'count';
        n.textContent = text;
        n.style.color = colour;
        cell.append(n);
      }
    });
  }

  private renderSkills(skills: SkillView[], total: number): void {
    const grid = $('skills');
    grid.replaceChildren();
    for (const s of skills) {
      const cell = document.createElement('div');
      cell.className = 'skill';
      const remaining = Math.max(0, s.nextXp - s.xp);
      cell.title = `${s.skill} XP: ${Math.floor(s.xp).toLocaleString()}\nNext level at: ${s.nextXp.toLocaleString()}\nRemaining XP: ${Math.ceil(remaining).toLocaleString()}`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.skill;
      const lvl = document.createElement('span');
      lvl.className = 'lvl';
      lvl.textContent = `${s.level}/${s.level}`;
      const bar = document.createElement('i');
      const span = Math.max(1, s.nextXp - s.levelXp);
      bar.style.width = `${s.level >= 99 ? 100 : Math.min(100, ((s.xp - s.levelXp) / span) * 100)}%`;
      cell.append(name, lvl, bar);
      grid.append(cell);
    }
    const tot = document.createElement('div');
    tot.className = 'skill total';
    tot.textContent = `Total level: ${total}`;
    grid.append(tot);
  }
}
