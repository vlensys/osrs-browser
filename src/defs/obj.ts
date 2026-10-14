import { Packet } from '../cache/packet.ts';
import { readParams, UnknownOpcodeError } from './config.ts';

/** Item ("obj") definition — the parts a single-player engine needs: naming, stacking, icon model, ops. */
export interface ObjDef {
  id: number;
  name: string;
  examine: string | null;
  inventoryModel: number;
  zoom2d: number;
  xan2d: number;
  yan2d: number;
  zan2d: number;
  xOffset2d: number;
  yOffset2d: number;
  stackable: boolean;
  cost: number;
  members: boolean;
  wearPos: number;
  groundOps: (string | null)[];
  invOps: (string | null)[];
  recolFrom: Int16Array | null;
  recolTo: Int16Array | null;
  retexFrom: Int16Array | null;
  retexTo: Int16Array | null;
  notedId: number;
  notedTemplate: number;
  ambient: number;
  contrast: number;
  resizeX: number;
  resizeY: number;
  resizeZ: number;
  weight: number;
  tradeable: boolean;
  params: Map<number, number | string> | null;
}

function recolours(p: Packet): [Int16Array, Int16Array] {
  const n = p.u8();
  const a = new Int16Array(n);
  const b = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = p.u16();
    b[i] = p.u16();
  }
  return [a, b];
}

export function decodeObj(id: number, data: Uint8Array): ObjDef {
  const d: ObjDef = {
    id,
    name: 'null',
    examine: null,
    inventoryModel: -1,
    zoom2d: 2000,
    xan2d: 0,
    yan2d: 0,
    zan2d: 0,
    xOffset2d: 0,
    yOffset2d: 0,
    stackable: false,
    cost: 1,
    members: false,
    wearPos: -1,
    groundOps: [null, null, 'Take', null, null],
    invOps: [null, null, null, null, 'Drop'],
    recolFrom: null,
    recolTo: null,
    retexFrom: null,
    retexTo: null,
    notedId: -1,
    notedTemplate: -1,
    ambient: 0,
    contrast: 0,
    resizeX: 128,
    resizeY: 128,
    resizeZ: 128,
    weight: 0,
    tradeable: false,
    params: null,
  };
  const p = new Packet(data);
  for (;;) {
    const op = p.u8();
    if (op === 0) break;
    switch (op) {
      case 1:
        d.inventoryModel = p.u16();
        break;
      case 2:
        d.name = p.string();
        break;
      case 3:
        d.examine = p.string();
        break;
      case 4:
        d.zoom2d = p.u16();
        break;
      case 5:
        d.xan2d = p.u16();
        break;
      case 6:
        d.yan2d = p.u16();
        break;
      case 7:
        d.xOffset2d = p.i16();
        break;
      case 8:
        d.yOffset2d = p.i16();
        break;
      case 9:
        p.string(); // unknown label
        break;
      case 11:
        d.stackable = true;
        break;
      case 12:
        d.cost = p.i32();
        break;
      case 13:
        d.wearPos = p.u8();
        break;
      case 14:
      case 27:
        p.u8(); // secondary/tertiary wear slot
        break;
      case 15:
        break; // flag (unknown meaning)
      case 16:
        d.members = true;
        break;
      case 23:
      case 25:
        p.u16();
        p.u8(); // worn model + y offset (16-bit)
        break;
      case 24:
      case 26:
      case 78:
      case 79:
      case 90:
      case 91:
      case 92:
      case 93:
        p.u16(); // worn/head models (16-bit)
        break;
      case 30:
      case 31:
      case 32:
      case 33:
      case 34: {
        const s = p.string();
        d.groundOps[op - 30] = s.toLowerCase() === 'hidden' ? null : s;
        break;
      }
      case 35:
      case 36:
      case 37:
      case 38:
      case 39:
        d.invOps[op - 35] = p.string();
        break;
      case 40:
        [d.recolFrom, d.recolTo] = recolours(p);
        break;
      case 41:
        [d.retexFrom, d.retexTo] = recolours(p);
        break;
      case 42:
        p.i8(); // shift-click drop index
        break;
      case 43: {
        // Sub-menu for an inventory op (e.g. teleport destinations): slot, then (index, text) until index 0.
        p.u8();
        while (p.u8() !== 0) p.string();
        break;
      }
      // Builds ~240+: 32-bit model ids.
      case 44:
        d.inventoryModel = p.i32();
        break;
      case 45:
      case 48:
        p.i32();
        p.u8(); // primary worn model (32-bit), male / female, + y offset
        break;
      case 46:
      case 47:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
        p.i32(); // other worn/head models (32-bit)
        break;
      case 65:
        d.tradeable = true;
        break;
      case 69:
        p.i32(); // geValue
        break;
      case 75:
        d.weight = p.i16();
        break;
      case 94:
        p.u16(); // category
        break;
      case 95:
        d.zan2d = p.u16();
        break;
      case 97:
        d.notedId = p.u16();
        break;
      case 98:
        d.notedTemplate = p.u16();
        break;
      case 110:
        d.resizeX = p.u16();
        break;
      case 111:
        d.resizeY = p.u16();
        break;
      case 112:
        d.resizeZ = p.u16();
        break;
      case 113:
        d.ambient = p.i8();
        break;
      case 114:
        d.contrast = p.i8() * 5;
        break;
      case 115:
        p.u8(); // team
        break;
      case 139:
      case 140:
      case 148:
      case 149:
        p.u16(); // bought / placeholder links
        break;
      case 249:
        d.params = readParams(p);
        break;
      case 160:
        break; // flag (unknown meaning)
      case 251:
        break; // flag that follows "tradeable" in current builds
      default:
        if (op >= 100 && op < 110) {
          p.u16();
          p.u16(); // count variants (stack size -> obj)
          break;
        }
        throw new UnknownOpcodeError('obj', id, op, p.pos - 1);
    }
  }
  return d;
}
