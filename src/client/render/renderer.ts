import type { SquareMessage } from '../../engine/protocol.ts';
import type { MeshData } from '../../world/mesh.ts';
import { identity, lookAt, multiply, perspective, translationRotationY, type Mat4 } from './mat4.ts';

const VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColour;
layout(location = 2) in vec4 aPick;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec3 uEye;
out vec4 vColour;
flat out vec4 vPick;
out float vDist;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  gl_Position = uViewProj * world;
  vColour = aColour;
  vPick = aPick;
  vDist = distance(world.xz, uEye.xz);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 vColour;
flat in vec4 vPick;
in float vDist;
uniform int uPickPass;
uniform vec3 uFogColour;
uniform vec2 uFog;
out vec4 outColour;
void main() {
  if (uPickPass == 1) {
    outColour = vPick;
    return;
  }
  float f = clamp((vDist - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0);
  outColour = vec4(mix(vColour.rgb, uFogColour, f), vColour.a);
}`;

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  /** CPU copy kept so meshes can be re-uploaded after a lost WebGL context. */
  data: MeshData;
}

interface GpuSquare {
  rx: number;
  ry: number;
  planes: { opaque: GpuMesh | null; translucent: GpuMesh | null }[];
}

export class WebGLUnavailableError extends Error {}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private uniforms!: Record<string, WebGLUniformLocation | null>;
  private readonly squares = new Map<number, GpuSquare>();
  private avatar: GpuMesh | null = null;
  private avatarData: MeshData | null = null;
  private pickFbo: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private pickSize = [0, 0];
  private viewProj: Mat4 = identity();
  private eye = [0, 0, 0];
  private lost = false;
  fogColour: [number, number, number] = [0, 0, 0];
  fogRange: [number, number] = [40, 62];

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new WebGLUnavailableError(
        'WebGL 2 is not available. In Chrome enable "Use graphics acceleration when available" (Settings → System); ' +
          'in Firefox make sure webgl.disabled is false in about:config and hardware acceleration is on.',
      );
    }
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => {
      // Windows GPU driver resets and tab backgrounding can drop the context; keep CPU copies and wait.
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => this.restore());
    this.init();
  }

  get contextLost(): boolean {
    return this.lost;
  }

  private init(): void {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`);
    this.program = p;
    this.uniforms = {};
    for (const u of ['uViewProj', 'uModel', 'uEye', 'uPickPass', 'uFogColour', 'uFog']) this.uniforms[u] = gl.getUniformLocation(p, u);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // Map data mixes winding orders, so draw both faces.
    gl.disable(gl.CULL_FACE);
    this.pickFbo = null;
  }

  private restore(): void {
    this.lost = false;
    this.init();
    for (const sq of this.squares.values()) {
      for (const pl of sq.planes) {
        if (pl.opaque) pl.opaque = this.upload(pl.opaque.data);
        if (pl.translucent) pl.translucent = this.upload(pl.translucent.data);
      }
    }
    if (this.avatarData) this.avatar = this.upload(this.avatarData);
  }

  private upload(data: MeshData): GpuMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const mk = (arr: ArrayBufferView, loc: number, size: number, type: number, normalized: boolean) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
      return b;
    };
    const buffers = [
      mk(data.positions, 0, 3, gl.FLOAT, false),
      mk(data.colours, 1, 4, gl.UNSIGNED_BYTE, true),
      mk(data.picks, 2, 4, gl.UNSIGNED_BYTE, true),
    ];
    gl.bindVertexArray(null);
    return { vao, buffers, count: data.vertexCount, data };
  }

  private free(mesh: GpuMesh | null): void {
    if (!mesh) return;
    this.gl.deleteVertexArray(mesh.vao);
    for (const b of mesh.buffers) this.gl.deleteBuffer(b);
  }

  addSquare(msg: SquareMessage): void {
    this.removeSquare(msg.rx, msg.ry);
    const planes = msg.planes.map((p) => ({
      opaque: p.opaque.vertexCount ? this.upload(p.opaque) : null,
      translucent: p.translucent.vertexCount ? this.upload(p.translucent) : null,
    }));
    this.squares.set((msg.rx << 8) | msg.ry, { rx: msg.rx, ry: msg.ry, planes });
  }

  removeSquare(rx: number, ry: number): void {
    const key = (rx << 8) | ry;
    const sq = this.squares.get(key);
    if (!sq) return;
    for (const p of sq.planes) {
      this.free(p.opaque);
      this.free(p.translucent);
    }
    this.squares.delete(key);
  }

  setAvatar(data: MeshData): void {
    this.free(this.avatar);
    this.avatarData = data;
    this.avatar = this.upload(data);
  }

  /** Keeps the drawing buffer matched to CSS size × devicePixelRatio (Windows 125%/150% scaling etc.). */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  setCamera(target: number[], yaw: number, pitch: number, distance: number): void {
    const cp = Math.cos(pitch);
    // yaw 0 = camera south of the target looking north (GL -z is world north).
    this.eye = [target[0] - Math.sin(yaw) * cp * distance, target[1] + Math.sin(pitch) * distance, target[2] + Math.cos(yaw) * cp * distance];
    const aspect = this.canvas.width / this.canvas.height;
    const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 200);
    this.viewProj = multiply(proj, lookAt(this.eye, target, [0, 1, 0]));
  }

  private drawScene(maxPlane: number, pickPass: boolean, avatarModel: Mat4 | null): void {
    const gl = this.gl;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    gl.uniform3fv(u.uEye, this.eye);
    gl.uniform1i(u.uPickPass, pickPass ? 1 : 0);
    gl.uniform3fv(u.uFogColour, this.fogColour);
    gl.uniform2fv(u.uFog, this.fogRange);
    const ident = identity();
    gl.uniformMatrix4fv(u.uModel, false, ident);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const sq of this.squares.values()) {
      for (let z = 0; z <= maxPlane; z++) {
        const m = sq.planes[z]?.opaque;
        if (!m) continue;
        gl.bindVertexArray(m.vao);
        gl.drawArrays(gl.TRIANGLES, 0, m.count);
      }
    }
    if (this.avatar && avatarModel && !pickPass) {
      gl.uniformMatrix4fv(u.uModel, false, avatarModel);
      gl.bindVertexArray(this.avatar.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.avatar.count);
      gl.uniformMatrix4fv(u.uModel, false, ident);
    }
    if (!pickPass) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    }
    for (const sq of this.squares.values()) {
      for (let z = 0; z <= maxPlane; z++) {
        const m = sq.planes[z]?.translucent;
        if (!m) continue;
        gl.bindVertexArray(m.vao);
        gl.drawArrays(gl.TRIANGLES, 0, m.count);
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  render(maxPlane: number, avatarPos: number[] | null, avatarFacing: number): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(this.fogColour[0], this.fogColour[1], this.fogColour[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const model = avatarPos ? translationRotationY(avatarPos[0], avatarPos[1], avatarPos[2], -avatarFacing + Math.PI) : null;
    this.drawScene(maxPlane, false, model);
  }

  private ensurePickTarget(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.pickFbo && this.pickSize[0] === w && this.pickSize[1] === h) return;
    if (this.pickFbo) {
      gl.deleteFramebuffer(this.pickFbo);
      gl.deleteTexture(this.pickTex);
      gl.deleteRenderbuffer(this.pickDepth);
    }
    this.pickTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.pickDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
    this.pickSize = [w, h];
  }

  /** Renders ids offscreen and returns the 32-bit pick id under a canvas pixel (0 = nothing). */
  pick(px: number, py: number, maxPlane: number): number {
    if (this.lost) return 0;
    const gl = this.gl;
    this.ensurePickTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // Only the pixel under the cursor matters.
    gl.enable(gl.SCISSOR_TEST);
    const x = Math.min(this.canvas.width - 1, Math.max(0, Math.floor(px)));
    const y = Math.min(this.canvas.height - 1, Math.max(0, this.canvas.height - 1 - Math.floor(py)));
    gl.scissor(x, y, 1, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawScene(maxPlane, true, null);
    const out = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ((out[0] << 24) | (out[1] << 16) | (out[2] << 8) | out[3]) >>> 0;
  }

  /** Projects a GL-space point to CSS pixels relative to the canvas (null if behind the camera). */
  project(p: number[]): { x: number; y: number } | null {
    const m = this.viewProj;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    return { x: ((x / w + 1) / 2) * rect.width, y: ((1 - y / w) / 2) * rect.height };
  }

  /** Reads back a few framebuffer pixels right after drawing (used by smoke tests to prove WebGL output). */
  sample(points: [number, number][]): number[][] {
    const gl = this.gl;
    const out: number[][] = [];
    const px = new Uint8Array(4);
    for (const [fx, fy] of points) {
      gl.readPixels(Math.floor(fx * (this.canvas.width - 1)), Math.floor(fy * (this.canvas.height - 1)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push([...px]);
    }
    return out;
  }

  stats(): { squares: number; vertices: number } {
    let vertices = 0;
    for (const sq of this.squares.values()) for (const p of sq.planes) vertices += (p.opaque?.count ?? 0) + (p.translucent?.count ?? 0);
    return { squares: this.squares.size, vertices };
  }
}
