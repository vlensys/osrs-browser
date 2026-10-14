import type { ItemIcon } from '../../engine/protocol.ts';

const VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColour;
uniform vec4 uFit; // centre x, centre y, scale x, scale y
out vec4 vColour;
void main() {
  gl_Position = vec4((aPos.x - uFit.x) * uFit.z, (aPos.y - uFit.y) * uFit.w, 0.5 - aPos.z * 0.01, 1.0);
  vColour = aColour;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec4 vColour;
out vec4 outColour;
void main() { outColour = vColour; }`;

/**
 * Renders item models (sent by the engine) to small inventory icons in a private offscreen WebGL2 context,
 * then caches them as data URLs. Orthographic, framed to the model's bounds, with a dark outline like the game.
 */
export class IconRenderer {
  private readonly canvas = document.createElement('canvas');
  private readonly gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null = null;
  private fit: WebGLUniformLocation | null = null;
  readonly cache = new Map<number, string>();

  constructor(readonly width = 72, readonly height = 64) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (this.gl) this.init(this.gl);
  }

  private init(gl: WebGL2RenderingContext): void {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    this.program = p;
    this.fit = gl.getUniformLocation(p, 'uFit');
  }

  render(icon: ItemIcon): string | null {
    const gl = this.gl;
    if (!gl || !this.program) return null;
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    const [x0, y0] = icon.min;
    const [x1, y1] = icon.max;
    const w = Math.max(1e-3, x1 - x0);
    const h = Math.max(1e-3, y1 - y0);
    // Fit the larger extent into ~85% of the slot, keeping proportions.
    const s = 1.7 / Math.max(w / (this.width / this.height), h);
    gl.uniform4f(this.fit, (x0 + x1) / 2, (y0 + y1) / 2, s / (this.width / this.height), s);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, icon.mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const col = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, col);
    gl.bufferData(gl.ARRAY_BUFFER, icon.mesh.colours, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, icon.mesh.vertexCount);
    gl.bindVertexArray(null);
    gl.deleteBuffer(pos);
    gl.deleteBuffer(col);
    gl.deleteVertexArray(vao);

    // Read back and add the 1px dark outline the game draws around inventory icons.
    const px = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new ImageData(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      const srcRow = (this.height - 1 - y) * this.width; // GL rows are bottom-up
      for (let x = 0; x < this.width; x++) {
        const s4 = (srcRow + x) * 4;
        const d4 = (y * this.width + x) * 4;
        out.data[d4] = px[s4];
        out.data[d4 + 1] = px[s4 + 1];
        out.data[d4 + 2] = px[s4 + 2];
        out.data[d4 + 3] = px[s4 + 3] ? 255 : 0;
      }
    }
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < this.width && y < this.height && out.data[(y * this.width + x) * 4 + 3] === 255;
    const outline: number[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (solid(x, y)) continue;
        if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) outline.push((y * this.width + x) * 4);
      }
    }
    for (const o of outline) {
      out.data[o] = 0;
      out.data[o + 1] = 0;
      out.data[o + 2] = 1;
      out.data[o + 3] = 255;
    }
    const c2 = document.createElement('canvas');
    c2.width = this.width;
    c2.height = this.height;
    c2.getContext('2d')!.putImageData(out, 0, 0);
    const url = c2.toDataURL('image/png');
    this.cache.set(icon.id, url);
    return url;
  }
}
