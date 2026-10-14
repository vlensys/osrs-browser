import { MeshBuilder, type MeshData } from '../../world/mesh.ts';

/**
 * An original, procedurally built low-poly adventurer used as the player avatar (the game's own
 * character models are intentionally not used). Units are tiles; origin at the feet, facing -z.
 */
export function buildAvatar(): MeshData {
  const m = new MeshBuilder();
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, rgb: number) => {
    const shade = (k: number) => {
      const r = Math.min(255, ((rgb >> 16) & 255) * k);
      const g = Math.min(255, ((rgb >> 8) & 255) * k);
      const b = Math.min(255, (rgb & 255) * k);
      return (r << 16) | (g << 8) | b;
    };
    const quad = (a: number[], b: number[], c: number[], d: number[], k: number) => {
      const col = shade(k);
      for (const v of [a, b, c, a, c, d]) m.vertex(v[0], v[1], v[2], col, 255, 0);
    };
    const p = (x: number, y: number, z: number) => [x, y, z];
    quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), 1.1); // top
    quad(p(x0, y0, z1), p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), 0.5); // bottom
    quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), 0.8); // back (+z)
    quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), 1.0); // front (-z)
    quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), 0.7); // left
    quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), 0.9); // right
  };
  const pyramid = (cx: number, y0: number, cz: number, r: number, h: number, rgb: number) => {
    const tip = [cx, y0 + h, cz];
    const c = [
      [cx - r, y0, cz - r],
      [cx + r, y0, cz - r],
      [cx + r, y0, cz + r],
      [cx - r, y0, cz + r],
    ];
    const ks = [1.0, 0.85, 0.7, 0.9];
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      const k = ks[i];
      const col = (Math.min(255, ((rgb >> 16) & 255) * k) << 16) | (Math.min(255, ((rgb >> 8) & 255) * k) << 8) | Math.min(255, (rgb & 255) * k);
      for (const v of [b, a, tip]) m.vertex(v[0], v[1], v[2], col, 255, 0);
    }
  };

  const boots = 0x3b2a1a;
  const trousers = 0x4a4f63;
  const tunic = 0x2f8f83;
  const belt = 0x6b4a22;
  const skin = 0xd9a77a;
  const hat = 0x5d8a2e;
  box(-0.17, 0, -0.1, -0.03, 0.12, 0.08, boots);
  box(0.03, 0, -0.1, 0.17, 0.12, 0.08, boots);
  box(-0.16, 0.12, -0.07, -0.03, 0.62, 0.07, trousers);
  box(0.03, 0.12, -0.07, 0.16, 0.62, 0.07, trousers);
  box(-0.2, 0.6, -0.1, 0.2, 0.68, 0.1, belt);
  box(-0.21, 0.68, -0.11, 0.21, 1.1, 0.11, tunic);
  box(-0.31, 0.66, -0.07, -0.21, 1.08, 0.07, tunic);
  box(0.21, 0.66, -0.07, 0.31, 1.08, 0.07, tunic);
  box(-0.3, 0.56, -0.06, -0.22, 0.66, 0.06, skin);
  box(0.22, 0.56, -0.06, 0.3, 0.66, 0.06, skin);
  box(-0.12, 1.1, -0.12, 0.12, 1.36, 0.12, skin);
  box(-0.18, 1.34, -0.18, 0.18, 1.38, 0.18, hat);
  pyramid(0, 1.38, 0.02, 0.13, 0.28, hat);
  return m.finish();
}
