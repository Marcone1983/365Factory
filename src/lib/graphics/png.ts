import zlib from 'node:zlib';

/**
 * Minimal, complete PNG encoder (RGBA8, non-interlaced) built on the Node zlib
 * deflate stream. Produces standards-compliant files that any image decoder,
 * Android resource pipeline or WebGL texture loader accepts.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = (CRC_TABLE[(c ^ (buffer[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * Chooses a per-scanline filter using the standard minimum-sum-of-absolute-
 * differences heuristic from the PNG specification, which materially reduces
 * output size for gradients and noise fields.
 */
function filterScanlines(rgba: Uint8Array, width: number, height: number): Buffer {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const prior = new Uint8Array(stride);
  const candidates = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = rgba[rowStart + x] as number;
      const left = x >= bpp ? (rgba[rowStart + x - bpp] as number) : 0;
      const up = prior[x] as number;
      const upLeft = x >= bpp ? (prior[x - bpp] as number) : 0;
      (candidates[0] as Uint8Array)[x] = raw;
      (candidates[1] as Uint8Array)[x] = (raw - left) & 0xff;
      (candidates[2] as Uint8Array)[x] = (raw - up) & 0xff;
      (candidates[3] as Uint8Array)[x] = (raw - ((left + up) >> 1)) & 0xff;
      (candidates[4] as Uint8Array)[x] = (raw - paeth(left, up, upLeft)) & 0xff;
    }

    let best = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let f = 0; f < 5; f += 1) {
      const row = candidates[f] as Uint8Array;
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const v = row[x] as number;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }

    const outStart = y * (stride + 1);
    out[outStart] = best;
    Buffer.from((candidates[best] as Uint8Array).buffer, 0, stride).copy(out, outStart + 1);
    prior.set(rgba.subarray(rowStart, rowStart + stride));
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, received ${rgba.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: truecolour with alpha
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const filtered = filterScanlines(rgba, width, height);
  const compressed = zlib.deflateSync(filtered, { level: 9 });

  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/**
 * PNG decoder for 8-bit greyscale, RGB, palette, greyscale+alpha and RGBA
 * images (non-interlaced) — the shapes produced by every image API the platform
 * integrates with. Needed so remote artwork can be resampled to the exact
 * densities Android and the web manifest require.
 */
export function decodePng(data: Buffer): DecodedImage {
  const info = readPngInfo(data);
  if (info.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${info.bitDepth}`);

  let offset = 8;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  let interlace = 0;

  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') interlace = body.readUInt8(12);
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'PLTE') palette = Buffer.from(body);
    else if (type === 'tRNS') transparency = Buffer.from(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (idat.length === 0) throw new Error('malformed PNG (no IDAT)');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[info.colorType as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`unsupported PNG colour type ${info.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = info.width * channels;
  const pixels = Buffer.alloc(stride * info.height);
  let prior = Buffer.alloc(stride);

  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const rawByte = row[x] as number;
      const a = x >= channels ? (out[x - channels] as number) : 0;
      const b = prior[x] as number;
      const c = x >= channels ? (prior[x - channels] as number) : 0;
      let value: number;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
    prior = Buffer.from(out);
  }

  const rgba = new Uint8Array(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i += 1) {
    const src = i * channels;
    const dst = i * 4;
    switch (info.colorType) {
      case 0:
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = pixels[src] as number;
        rgba[dst + 3] = 255;
        break;
      case 2:
        rgba[dst] = pixels[src] as number;
        rgba[dst + 1] = pixels[src + 1] as number;
        rgba[dst + 2] = pixels[src + 2] as number;
        rgba[dst + 3] = 255;
        break;
      case 3: {
        if (!palette) throw new Error('palette PNG without PLTE chunk');
        const idx = (pixels[src] as number) * 3;
        rgba[dst] = palette[idx] as number;
        rgba[dst + 1] = palette[idx + 1] as number;
        rgba[dst + 2] = palette[idx + 2] as number;
        rgba[dst + 3] = transparency ? (transparency[pixels[src] as number] ?? 255) : 255;
        break;
      }
      case 4:
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = pixels[src] as number;
        rgba[dst + 3] = pixels[src + 1] as number;
        break;
      default:
        rgba[dst] = pixels[src] as number;
        rgba[dst + 1] = pixels[src + 1] as number;
        rgba[dst + 2] = pixels[src + 2] as number;
        rgba[dst + 3] = pixels[src + 3] as number;
        break;
    }
  }

  return { width: info.width, height: info.height, rgba };
}

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
}

/** Validates the PNG container and returns its header. Used by asset validation. */
export function readPngInfo(data: Buffer): PngInfo {
  if (data.length < 24 || !data.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)');
  }
  if (data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('malformed PNG (missing IHDR)');
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data.readUInt8(24),
    colorType: data.readUInt8(25),
  };
}
