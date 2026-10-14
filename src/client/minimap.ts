import type { PlayerState, SquareMessage } from '../engine/protocol.ts';

const PX_PER_TILE = 4;

/** Draws the circular, camera-rotated minimap from per-square images produced by the engine. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly squares = new Map<number, (ImageBitmap | null)[]>();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  async addSquare(msg: SquareMessage): Promise<void> {
    const key = (msg.rx << 8) | msg.ry;
    const bitmaps = await Promise.all(
      msg.minimaps.map((px) => {
        // Skip planes with no content at all.
        let any = false;
        for (let i = 3; i < px.length; i += 4 * 97) if (px[i]) { any = true; break; }
        if (!any) return null;
        return createImageBitmap(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, 256, 256));
      }),
    );
    this.removeSquare(msg.rx, msg.ry);
    this.squares.set(key, bitmaps);
  }

  removeSquare(rx: number, ry: number): void {
    const key = (rx << 8) | ry;
    for (const b of this.squares.get(key) ?? []) b?.close();
    this.squares.delete(key);
  }

  /** Converts a click on the minimap to a world tile (or null outside the circle). */
  tileAt(clientX: number, clientY: number, player: { x: number; y: number }, yaw: number): { x: number; y: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const cx = clientX - r.left - r.width / 2;
    const cy = clientY - r.top - r.height / 2;
    if (Math.hypot(cx, cy) > r.width / 2) return null;
    const scale = this.canvas.width / r.width;
    const c = Math.cos(-yaw);
    const s = Math.sin(-yaw);
    const ux = (cx * c - cy * s) * scale;
    const uy = (cx * s + cy * c) * scale;
    return { x: Math.round(player.x + ux / PX_PER_TILE), y: Math.round(player.y - uy / PX_PER_TILE) };
  }

  draw(fx: number, fy: number, plane: number, yaw: number, player: PlayerState | null): void {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-yaw);
    ctx.imageSmoothingEnabled = false;
    for (const [key, planes] of this.squares) {
      const img = planes[plane] ?? planes[0];
      if (!img) continue;
      const rx = key >> 8;
      const ry = key & 255;
      // Image row 0 is the north edge (y = ry*64 + 63).
      const left = (rx * 64 - fx - 0.5) * PX_PER_TILE;
      const top = (fy + 0.5 - (ry * 64 + 64)) * PX_PER_TILE;
      ctx.drawImage(img, left, top);
    }
    if (player?.dest) {
      const dx = (player.dest.x - fx) * PX_PER_TILE;
      const dy = (fy - player.dest.y) * PX_PER_TILE;
      ctx.fillStyle = '#ff2020';
      ctx.fillRect(dx - 1, dy - 7, 2, 8);
      ctx.fillRect(dx + 1, dy - 7, 5, 4);
    }
    ctx.restore();
    // Player arrow (always points up = camera forward).
    ctx.fillStyle = '#fff';
    ctx.fillRect(w / 2 - 2, h / 2 - 2, 4, 4);
  }
}
