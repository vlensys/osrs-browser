export const INVENTORY_SIZE = 28;

export interface Slot {
  id: number;
  count: number;
}

/** A 28-slot backpack. Stackable items share one slot; everything else takes a slot each. */
export class Inventory {
  readonly slots: (Slot | null)[] = new Array(INVENTORY_SIZE).fill(null);

  constructor(private readonly isStackable: (id: number) => boolean) {}

  freeSlots(): number {
    return this.slots.filter((s) => s === null).length;
  }

  count(id: number): number {
    return this.slots.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0);
  }

  has(pred: (id: number) => boolean): boolean {
    return this.slots.some((s) => s !== null && pred(s.id));
  }

  /** Adds items; returns how many didn't fit. */
  add(id: number, count = 1): number {
    if (this.isStackable(id)) {
      const existing = this.slots.find((s) => s?.id === id);
      if (existing) {
        existing.count = Math.min(2_147_483_647, existing.count + count);
        return 0;
      }
      const free = this.slots.indexOf(null);
      if (free < 0) return count;
      this.slots[free] = { id, count };
      return 0;
    }
    let left = count;
    while (left > 0) {
      const free = this.slots.indexOf(null);
      if (free < 0) break;
      this.slots[free] = { id, count: 1 };
      left--;
    }
    return left;
  }

  removeSlot(index: number): Slot | null {
    const s = this.slots[index] ?? null;
    this.slots[index] = null;
    return s;
  }

  /** Swaps two slots (drag and drop). */
  move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= INVENTORY_SIZE || to >= INVENTORY_SIZE) return;
    const a = this.slots[from];
    this.slots[from] = this.slots[to];
    this.slots[to] = a;
  }

  toJSON(): (Slot | null)[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  load(data: (Slot | null)[] | undefined): void {
    if (!Array.isArray(data)) return;
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = data[i];
      this.slots[i] = s && Number.isInteger(s.id) && s.count > 0 ? { id: s.id, count: s.count } : null;
    }
  }
}
