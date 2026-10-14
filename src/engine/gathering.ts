import type { Skill } from './skills.ts';

/** A gatherable scenery type, matched by the loc's name. Requirements and XP follow the game's published values. */
export interface Resource {
  skill: Skill;
  level: number;
  xp: number;
  product: string;
  /** Ticks between attempts. */
  interval: number;
  /** Chance the resource depletes after each success (1 = always). */
  depleteChance: number;
  /** Ticks until it grows back / respawns. */
  respawn: number;
  /** Base success chance at the requirement level. */
  baseChance: number;
}

const tree = (level: number, xp: number, product: string, depleteChance: number, respawn: number, baseChance: number): Resource => ({
  skill: 'Woodcutting',
  level,
  xp,
  product,
  interval: 4,
  depleteChance,
  respawn,
  baseChance,
});

const rock = (level: number, xp: number, product: string, respawn: number, baseChance: number): Resource => ({
  skill: 'Mining',
  level,
  xp,
  product,
  interval: 4,
  depleteChance: 1,
  respawn,
  baseChance,
});

export const RESOURCES: Record<string, Resource> = {
  Tree: tree(1, 25, 'Logs', 1, 60, 0.4),
  'Dead tree': tree(1, 25, 'Logs', 1, 60, 0.4),
  Evergreen: tree(1, 25, 'Logs', 1, 60, 0.4),
  'Oak tree': tree(15, 37.5, 'Oak logs', 1 / 8, 25, 0.3),
  'Willow tree': tree(30, 67.5, 'Willow logs', 1 / 8, 25, 0.28),
  'Teak tree': tree(35, 85, 'Teak logs', 1 / 8, 25, 0.26),
  'Maple tree': tree(45, 100, 'Maple logs', 1 / 8, 60, 0.22),
  'Mahogany tree': tree(50, 125, 'Mahogany logs', 1 / 8, 25, 0.2),
  'Yew tree': tree(60, 175, 'Yew logs', 1 / 8, 100, 0.15),
  'Magic tree': tree(75, 250, 'Magic logs', 1 / 8, 200, 0.1),
  'Clay rocks': rock(1, 5, 'Clay', 2, 0.5),
  'Copper rocks': rock(1, 17.5, 'Copper ore', 4, 0.45),
  'Tin rocks': rock(1, 17.5, 'Tin ore', 4, 0.45),
  'Iron rocks': rock(15, 35, 'Iron ore', 9, 0.4),
  'Silver rocks': rock(20, 40, 'Silver ore', 100, 0.3),
  'Coal rocks': rock(30, 50, 'Coal', 50, 0.3),
  'Gold rocks': rock(40, 65, 'Gold ore', 100, 0.25),
  'Mithril rocks': rock(55, 80, 'Mithril ore', 200, 0.2),
  'Adamantite rocks': rock(70, 95, 'Adamantite ore', 400, 0.15),
  'Runite rocks': rock(85, 125, 'Runite ore', 1200, 0.1),
};

/** Tools by name, best first: [name suffix match, level needed, success bonus]. */
export const AXES: [string, number, number][] = [
  ['Dragon axe', 61, 0.25],
  ['Rune axe', 41, 0.2],
  ['Adamant axe', 31, 0.15],
  ['Mithril axe', 21, 0.1],
  ['Black axe', 11, 0.07],
  ['Steel axe', 6, 0.05],
  ['Iron axe', 1, 0.02],
  ['Bronze axe', 1, 0],
];

export const PICKAXES: [string, number, number][] = [
  ['Dragon pickaxe', 61, 0.25],
  ['Rune pickaxe', 41, 0.2],
  ['Adamant pickaxe', 31, 0.15],
  ['Mithril pickaxe', 21, 0.1],
  ['Black pickaxe', 11, 0.07],
  ['Steel pickaxe', 6, 0.05],
  ['Iron pickaxe', 1, 0.02],
  ['Bronze pickaxe', 1, 0],
];

/** Per-attempt success chance: grows with levels above the requirement plus the tool's bonus. */
export function successChance(res: Resource, level: number, toolBonus: number): number {
  return Math.min(0.95, res.baseChance + (level - res.level) * 0.012 + toolBonus);
}

export function resourceFor(locName: string, op: string): Resource | null {
  const res = RESOURCES[locName];
  if (!res) return null;
  const lower = op.toLowerCase();
  if (res.skill === 'Woodcutting' && (lower === 'chop down' || lower === 'chop' || lower === 'chop-down')) return res;
  if (res.skill === 'Mining' && lower === 'mine') return res;
  return null;
}
