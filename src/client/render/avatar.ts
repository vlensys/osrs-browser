import { MeshBuilder, type MeshData } from '../../world/mesh.ts';

/**
 * The player avatar: an original, procedurally built low-poly adventurer (the game's own character models
 * are intentionally not used). Built from parts so limbs can swing. Units are tiles; origin at the feet,
 * facing -z (forward). Each part rotates about its pivot around the x axis.
 */
export interface AvatarPart {
  name: 'body' | 'legL' | 'legR' | 'armL' | 'armR';
  mesh: MeshData;
  pivot: [number, number, number];
}

type Builder = MeshBuilder;

function shade(rgb: number, k: number): number {
  const r = Math.min(255, Math.round(((rgb >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((rgb >> 8) & 255) * k));
  const b = Math.min(255, Math.round((rgb & 255) * k));
  return (r << 16) | (g << 8) | b;
}

function box(m: Builder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, rgb: number): void {
  const quad = (a: number[], b: number[], c: number[], d: number[], k: number) => {
    const col = shade(rgb, k);
    for (const v of [a, b, c, a, c, d]) m.vertex(v[0], v[1], v[2], col, 255, 0);
  };
  const p = (x: number, y: number, z: number) => [x, y, z];
  quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), 1.1); // top
  quad(p(x0, y0, z1), p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), 0.5); // bottom
  quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), 0.75); // back (+z)
  quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), 1.0); // front (-z)
  quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), 0.7); // left
  quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), 0.9); // right
}

function pyramid(m: Builder, cx: number, y0: number, cz: number, r: number, h: number, rgb: number): void {
  const tip = [cx, y0 + h, cz];
  const c = [
    [cx - r, y0, cz - r],
    [cx + r, y0, cz - r],
    [cx + r, y0, cz + r],
    [cx - r, y0, cz + r],
  ];
  const ks = [1.0, 0.85, 0.7, 0.9];
  for (let i = 0; i < 4; i++) {
    const col = shade(rgb, ks[i]);
    for (const v of [c[(i + 1) % 4], c[i], tip]) m.vertex(v[0], v[1], v[2], col, 255, 0);
  }
}

const BOOTS = 0x3b2a1a;
const TROUSERS = 0x4a4f63;
const TUNIC = 0x2f8f83;
const BELT = 0x6b4a22;
const SKIN = 0xd9a77a;
const HAT = 0x5d8a2e;

export function buildAvatarParts(): AvatarPart[] {
  const body = new MeshBuilder();
  box(body, -0.2, 0.6, -0.1, 0.2, 0.68, 0.1, BELT);
  box(body, -0.21, 0.68, -0.11, 0.21, 1.1, 0.11, TUNIC);
  box(body, -0.12, 1.1, -0.12, 0.12, 1.36, 0.12, SKIN);
  box(body, -0.08, 1.2, -0.125, -0.04, 1.24, -0.12, 0x222222); // eyes
  box(body, 0.04, 1.2, -0.125, 0.08, 1.24, -0.12, 0x222222);
  box(body, -0.18, 1.34, -0.18, 0.18, 1.38, 0.18, HAT);
  pyramid(body, 0, 1.38, 0.02, 0.13, 0.28, HAT);

  const leg = (x0: number, x1: number) => {
    const m = new MeshBuilder();
    box(m, x0, 0.12, -0.07, x1, 0.62, 0.07, TROUSERS);
    box(m, x0 - 0.01, 0, -0.1, x1 + 0.01, 0.12, 0.08, BOOTS);
    return m.finish();
  };
  const arm = (x0: number, x1: number) => {
    const m = new MeshBuilder();
    box(m, x0, 0.66, -0.07, x1, 1.08, 0.07, TUNIC);
    box(m, x0 + 0.01, 0.56, -0.06, x1 - 0.01, 0.66, 0.06, SKIN);
    return m.finish();
  };
  return [
    { name: 'body', mesh: body.finish(), pivot: [0, 0, 0] },
    { name: 'legL', mesh: leg(-0.16, -0.03), pivot: [-0.095, 0.62, 0] },
    { name: 'legR', mesh: leg(0.03, 0.16), pivot: [0.095, 0.62, 0] },
    { name: 'armL', mesh: arm(-0.31, -0.21), pivot: [-0.26, 1.05, 0] },
    { name: 'armR', mesh: arm(0.21, 0.31), pivot: [0.26, 1.05, 0] },
  ];
}

export interface AvatarPose {
  legL: number;
  legR: number;
  armL: number;
  armR: number;
  /** Small vertical bob of the whole body while walking. */
  bob: number;
}

/** Procedural animation: walk/run cycle from movement, and tool swings while chopping or mining. */
export function avatarPose(time: number, moving: boolean, running: boolean, action: 'chop' | 'mine' | null): AvatarPose {
  if (moving) {
    const speed = running ? 11 : 7;
    const swing = Math.sin(time * speed) * (running ? 0.75 : 0.5);
    return { legL: swing, legR: -swing, armL: -swing * 0.8, armR: swing * 0.8, bob: Math.abs(Math.cos(time * speed)) * 0.03 };
  }
  if (action) {
    // One swing per game tick-cycle (4 ticks = 2.4 s): wind up slowly, strike fast.
    const t = (time % 1.2) / 1.2;
    const raise = action === 'mine' ? 2.6 : 1.9;
    const angle = t < 0.7 ? (t / 0.7) * raise : raise * (1 - (t - 0.7) / 0.3);
    return { legL: 0.15, legR: -0.1, armL: angle * 0.85, armR: angle, bob: 0 };
  }
  const breathe = Math.sin(time * 1.6) * 0.03;
  return { legL: 0, legR: 0, armL: breathe, armR: -breathe, bob: 0 };
}
