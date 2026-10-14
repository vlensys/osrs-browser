import { Packet } from '../cache/packet.ts';

/** Decoded static mesh in model space (128 units per tile, -y is up). Animation data is skipped. */
export interface ModelData {
  vertexCount: number;
  vx: Int32Array;
  vy: Int32Array;
  vz: Int32Array;
  faceCount: number;
  fa: Int32Array;
  fb: Int32Array;
  fc: Int32Array;
  /** 16-bit Jagex HSL colour per face. */
  faceColour: Uint16Array;
  /** 0 = smooth, 1 = flat, 2 = hidden, 3 = flat-with-fixed-colour; null = all smooth. */
  faceRenderType: Uint8Array | null;
  /** Per-face transparency: 0 = opaque, 255 = invisible. */
  faceAlpha: Uint8Array | null;
  facePriority: Uint8Array | null;
  /** Texture id per face or -1. */
  faceTexture: Int16Array | null;
}

type Format = 'legacy' | 'v1' | 'v2' | 'v3';

export function modelFormat(d: Uint8Array): Format {
  if (d.length >= 2 && d[d.length - 2] === 0xff) {
    const t = d[d.length - 1];
    if (t === 0xff) return 'v1';
    if (t === 0xfe) return 'v2';
    if (t === 0xfd) return 'v3';
  }
  return 'legacy';
}

interface Header {
  vc: number;
  fc: number;
  tc: number;
  renderTypes: boolean;
  priority: number;
  alpha: boolean;
  faceSkins: boolean;
  textures: boolean;
  vertexSkins: boolean;
  animaya: boolean;
  xLen: number;
  yLen: number;
  zLen: number;
  idxLen: number;
  texCoordLen: number;
  skinLen: number;
  footer: number;
}

function readHeader(d: Uint8Array, fmt: Format): Header {
  const footer = fmt === 'legacy' ? 18 : fmt === 'v3' ? 26 : 23;
  if (d.length < footer) throw new Error('model: too short');
  const p = new Packet(d, d.length - footer);
  const h: Header = {
    vc: p.u16(),
    fc: p.u16(),
    tc: p.u8(),
    renderTypes: false,
    priority: 0,
    alpha: false,
    faceSkins: false,
    textures: false,
    vertexSkins: false,
    animaya: false,
    xLen: 0,
    yLen: 0,
    zLen: 0,
    idxLen: 0,
    texCoordLen: 0,
    skinLen: 0,
    footer,
  };
  h.renderTypes = p.u8() === 1;
  h.priority = p.u8();
  h.alpha = p.u8() === 1;
  h.faceSkins = p.u8() === 1;
  if (fmt === 'v1' || fmt === 'v3') h.textures = p.u8() === 1;
  h.vertexSkins = p.u8() === 1;
  if (fmt === 'v2' || fmt === 'v3') h.animaya = p.u8() === 1;
  h.xLen = p.u16();
  h.yLen = p.u16();
  h.zLen = p.u16();
  h.idxLen = p.u16();
  if (fmt === 'v1' || fmt === 'v3') h.texCoordLen = p.u16();
  if (fmt === 'v2' || fmt === 'v3') h.skinLen = p.u16();
  return h;
}

/** Sequentially lays out named sections and returns their start offsets plus the total size. */
function layout(parts: [string, number][]): { at: Record<string, number>; end: number } {
  const at: Record<string, number> = {};
  let pos = 0;
  for (const [name, len] of parts) {
    at[name] = pos;
    pos += len;
  }
  return { at, end: pos };
}

export function decodeModel(d: Uint8Array): ModelData {
  const fmt = modelFormat(d);
  const h = readHeader(d, fmt);
  const { vc, fc, tc } = h;

  // Texture-mapping triangle kinds (v1/v3): 0 = simple PMN, 1..3 = complex projections with extra data.
  let simpleTex = tc;
  let complexTex = 0;
  let cubeTex = 0;
  const texKinds = new Uint8Array(tc);
  if (fmt === 'v1' || fmt === 'v3') {
    simpleTex = 0;
    for (let i = 0; i < tc; i++) {
      const k = d[i];
      texKinds[i] = k;
      if (k === 0) simpleTex++;
      else if (k >= 1 && k <= 3) complexTex++;
      if (k === 2) cubeTex++;
    }
  }

  const rt = h.renderTypes ? fc : 0;
  const pri = h.priority === 255 ? fc : 0;
  const fskin = h.faceSkins ? fc : 0;
  const alpha = h.alpha ? fc : 0;
  let parts: [string, number][];
  if (fmt === 'legacy' || fmt === 'v2') {
    const vskin = fmt === 'v2' ? h.skinLen : h.vertexSkins ? vc : 0;
    parts = [
      ['vflags', vc],
      ['fcomp', fc],
      ['pri', pri],
      ['fskin', fskin],
      ['rtype', rt],
      ['vskin', vskin],
      ['alpha', alpha],
      ['idx', h.idxLen],
      ['colour', fc * 2],
      ['tex', tc * 6],
      ['x', h.xLen],
      ['y', h.yLen],
      ['z', h.zLen],
    ];
  } else {
    const vskin = fmt === 'v3' ? h.skinLen : h.vertexSkins ? vc : 0;
    parts = [
      ['tkind', tc],
      ['vflags', vc],
      ['rtype', rt],
      ['fcomp', fc],
      ['pri', pri],
      ['fskin', fskin],
      ['vskin', vskin],
      ['alpha', alpha],
      ['idx', h.idxLen],
      ['ftex', h.textures ? fc * 2 : 0],
      ['tcoord', h.texCoordLen],
      ['colour', fc * 2],
      ['x', h.xLen],
      ['y', h.yLen],
      ['z', h.zLen],
      ['tsimple', simpleTex * 6],
      ['tcomplex', complexTex * 6],
      ['tscale', complexTex * 6],
      ['trot', complexTex * 2],
      ['tdir', complexTex],
      ['tspeed', complexTex * 2 + cubeTex * 2],
    ];
  }
  const { at, end } = layout(parts);
  // Builds from 2024 onward append an optional extension block (flag byte(s) + per-face data) between the
  // last section and the footer; it holds nothing a static renderer needs, so only an overrun is an error.
  if (end > d.length - h.footer) {
    throw new Error(`model(${fmt}): sections end at ${end}, past footer at ${d.length - h.footer}`);
  }

  // Vertices: per-vertex flag byte selects which of the x/y/z delta streams advance.
  const vx = new Int32Array(vc);
  const vy = new Int32Array(vc);
  const vz = new Int32Array(vc);
  {
    const flags = new Packet(d, at.vflags);
    const px = new Packet(d, at.x);
    const py = new Packet(d, at.y);
    const pz = new Packet(d, at.z);
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < vc; i++) {
      const f = flags.u8();
      if (f & 1) x += px.sSmart();
      if (f & 2) y += py.sSmart();
      if (f & 4) z += pz.sSmart();
      vx[i] = x;
      vy[i] = y;
      vz[i] = z;
    }
    if (px.pos !== at.x + h.xLen || py.pos !== at.y + h.yLen || pz.pos !== at.z + h.zLen) {
      throw new Error(`model(${fmt}): vertex streams misaligned`);
    }
  }

  // Faces: compression type per face, deltas in the index stream.
  const fa = new Int32Array(fc);
  const fb = new Int32Array(fc);
  const fcc = new Int32Array(fc);
  {
    const types = new Packet(d, at.fcomp);
    const idx = new Packet(d, at.idx);
    let a = 0;
    let b = 0;
    let c = 0;
    let last = 0;
    for (let i = 0; i < fc; i++) {
      switch (types.u8()) {
        case 1:
          a = idx.sSmart() + last;
          b = idx.sSmart() + a;
          c = idx.sSmart() + b;
          last = c;
          break;
        case 2:
          b = c;
          c = idx.sSmart() + last;
          last = c;
          break;
        case 3:
          a = c;
          c = idx.sSmart() + last;
          last = c;
          break;
        case 4: {
          const t = a;
          a = b;
          b = t;
          c = idx.sSmart() + last;
          last = c;
          break;
        }
        default:
          throw new Error('model: bad face compression type');
      }
      if (a < 0 || b < 0 || c < 0 || a >= vc || b >= vc || c >= vc) throw new Error('model: face index out of range');
      fa[i] = a;
      fb[i] = b;
      fcc[i] = c;
    }
    if (idx.pos !== at.idx + h.idxLen) throw new Error(`model(${fmt}): face index stream misaligned`);
  }

  const faceColour = new Uint16Array(fc);
  for (let i = 0, o = at.colour; i < fc; i++, o += 2) faceColour[i] = (d[o] << 8) | d[o + 1];

  const faceRenderType = rt ? d.slice(at.rtype, at.rtype + fc) : null;
  const facePriority = pri ? d.slice(at.pri, at.pri + fc) : null;
  const faceAlpha = alpha ? d.slice(at.alpha, at.alpha + fc) : null;

  let faceTexture: Int16Array | null = null;
  if (fmt === 'v1' || fmt === 'v3') {
    if (h.textures) {
      faceTexture = new Int16Array(fc);
      for (let i = 0, o = at.ftex; i < fc; i++, o += 2) faceTexture[i] = ((d[o] << 8) | d[o + 1]) - 1;
    }
  } else if (faceRenderType) {
    // Legacy/v2: bit 1 of the render type marks a textured face whose "colour" is the texture id.
    for (let i = 0; i < fc; i++) {
      const t = faceRenderType[i];
      if (t & 2) {
        faceTexture ??= new Int16Array(fc).fill(-1);
        faceTexture[i] = faceColour[i];
        faceColour[i] = 127;
      }
      faceRenderType[i] = t & 1;
    }
  }

  return {
    vertexCount: vc,
    vx,
    vy,
    vz,
    faceCount: fc,
    fa,
    fb,
    fc: fcc,
    faceColour,
    faceRenderType,
    faceAlpha,
    facePriority,
    faceTexture,
  };
}
