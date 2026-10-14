export const SKILLS = [
  'Attack',
  'Hitpoints',
  'Mining',
  'Strength',
  'Agility',
  'Smithing',
  'Defence',
  'Herblore',
  'Fishing',
  'Ranged',
  'Thieving',
  'Cooking',
  'Prayer',
  'Crafting',
  'Firemaking',
  'Magic',
  'Fletching',
  'Woodcutting',
  'Runecraft',
  'Slayer',
  'Farming',
  'Construction',
  'Hunter',
] as const;

export type Skill = (typeof SKILLS)[number];

export const MAX_LEVEL = 99;
export const MAX_XP = 200_000_000;

/** XP needed for each level 1..99 (index = level), using the game's published experience curve. */
export const XP_TABLE: number[] = (() => {
  const table = [0, 0];
  let points = 0;
  for (let lvl = 1; lvl < MAX_LEVEL; lvl++) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    table.push(Math.floor(points / 4));
  }
  return table;
})();

export function levelForXp(xp: number): number {
  let lvl = 1;
  while (lvl < MAX_LEVEL && xp >= XP_TABLE[lvl + 1]) lvl++;
  return lvl;
}

export class Skills {
  /** XP stored in tenths, like the game, so 37.5 xp drops stay exact. */
  private readonly xpTenths = new Map<Skill, number>();

  constructor() {
    for (const s of SKILLS) this.xpTenths.set(s, s === 'Hitpoints' ? XP_TABLE[10] * 10 : 0);
  }

  xp(skill: Skill): number {
    return this.xpTenths.get(skill)! / 10;
  }

  level(skill: Skill): number {
    return levelForXp(this.xp(skill));
  }

  /** Adds XP and returns the new level if it went up, else null. */
  addXp(skill: Skill, amount: number): number | null {
    const before = this.level(skill);
    const next = Math.min(MAX_XP * 10, this.xpTenths.get(skill)! + Math.round(amount * 10));
    this.xpTenths.set(skill, next);
    const after = this.level(skill);
    return after > before ? after : null;
  }

  totalLevel(): number {
    return SKILLS.reduce((sum, s) => sum + this.level(s), 0);
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.xpTenths);
  }

  load(data: Record<string, number> | undefined): void {
    if (!data) return;
    for (const s of SKILLS) if (typeof data[s] === 'number') this.xpTenths.set(s, Math.max(0, Math.min(MAX_XP * 10, data[s])));
  }

  snapshot(): { skill: Skill; level: number; xp: number }[] {
    return SKILLS.map((skill) => ({ skill, level: this.level(skill), xp: this.xp(skill) }));
  }
}
