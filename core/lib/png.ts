/**
 * Just enough PNG to read the small masks a workflow saves: 8-bit, not
 * interlaced, grey / grey+alpha / RGB / RGBA. Returns one channel (the first).
 */

import { inflateSync } from 'node:zlib';

export interface GreyImage {
  width: number;
  height: number;
  /** One byte per pixel, row by row. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePngGrey(png: Uint8Array): GreyImage {
  if (!SIGNATURE.every((b, i) => png[i] === b)) throw new Error('Not a PNG file.');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0, channels = 0;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= png.length;) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      const depth = body[8], colour = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || !(colour in CHANNELS)) {
        throw new Error(`Unsupported PNG (bit depth ${depth}, colour type ${colour}, interlace ${interlace}).`);
      }
      channels = CHANNELS[colour];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (!width || !height) throw new Error('PNG without a header.');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * (stride + 1), (y + 1) * (stride + 1));
    const filter = row[0];
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = row[x + 1];
      switch (filter) {
        case 0: cur[x] = v; break;
        case 1: cur[x] = v + a; break;
        case 2: cur[x] = v + b; break;
        case 3: cur[x] = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          cur[x] = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Bad PNG filter ${filter}.`);
      }
    }
    for (let x = 0; x < width; x++) out[y * width + x] = cur[x * channels];
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}
