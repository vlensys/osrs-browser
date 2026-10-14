import type { MeshData } from '../world/mesh.ts';

/** Messages between the UI thread and the engine worker. Everything is structured-cloneable. */

export interface MenuOption {
  /** Verb, e.g. "Walk here", "Open". */
  verb: string;
  /** Target, e.g. "Door" (rendered in the target colour). */
  target: string;
  action: ActionRef;
}

export type ActionRef =
  | { kind: 'walk'; x: number; y: number }
  | { kind: 'loc'; uid: number; op: number }
  | { kind: 'examine'; uid: number }
  | { kind: 'cancel' };

export interface PlayerState {
  x: number;
  y: number;
  plane: number;
  running: boolean;
  /** 0..100 */
  energy: number;
  /** Destination flag, if walking. */
  dest: { x: number; y: number } | null;
  /** Tiles moved this tick (for interpolation), oldest first, ending at the current position. */
  steps: { x: number; y: number }[];
  /** Facing angle in radians (0 = north, clockwise). */
  facing: number;
  /** Highest plane to render (lower when indoors so roofs and upper floors are hidden). */
  maxPlane: number;
}

export type ToEngine =
  | { t: 'init'; drawRadius: number }
  | { t: 'menu'; seq: number; pick: number }
  | { t: 'hover'; seq: number; pick: number }
  | { t: 'click'; pick: number }
  | { t: 'action'; action: ActionRef }
  | { t: 'run'; enabled: boolean }
  | { t: 'command'; text: string }
  | { t: 'drawRadius'; radius: number }
  | { t: 'save' };

export interface SquareMessage {
  t: 'square';
  rx: number;
  ry: number;
  planes: { opaque: MeshData; translucent: MeshData }[];
  minimaps: Uint8ClampedArray[];
  /** Tile-corner heights, 4 planes x 64 x 64 (model units, negative = up). */
  heights: Int32Array;
  /** Bridge flags (plane 1 settings & 2), 64 x 64. */
  bridges: Uint8Array;
}

export type FromEngine =
  | { t: 'status'; message: string; fraction: number }
  | { t: 'fatal'; message: string }
  | { t: 'ready'; revision: number; player: PlayerState }
  | { t: 'textures'; layers: number; pixels: Uint8Array; anim: Float32Array }
  | SquareMessage
  | { t: 'unload'; rx: number; ry: number }
  | { t: 'tick'; tick: number; player: PlayerState }
  | { t: 'chat'; text: string; kind: 'game' | 'system' | 'error' }
  | { t: 'menu'; seq: number; options: MenuOption[] }
  | { t: 'hover'; seq: number; option: MenuOption | null };
