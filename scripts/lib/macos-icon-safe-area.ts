import * as NodeZlib from "node:zlib";

import { BRAND_ASSET_PATHS } from "@t3tools/shared/brandAssets";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The classic macOS icon safe area, at 1024pt: an opaque 824x824 body inset 100px
 * on every side, with only a soft drop shadow extending into the margin.
 *
 * Icon Composer cannot export this. Its command line has no pre-Tahoe rendering,
 * and since macOS 27 the GUI's `macOS pre-Tahoe` preset exports full bleed. So the
 * body is exported by hand at 824pt and `addMacOsIconMargin` places it on the
 * canvas. A wrong export still yields a plausible PNG that looks fine in a diff,
 * which is why the tracked files are also checked against this safe area.
 */
export const MACOS_ICON_CANVAS_SIZE = 1024;
export const MACOS_ICON_BODY_SIZE = 824;
export const MACOS_ICON_BODY_INSET = 100;

/**
 * The drop shadow behind the body, fitted to the pre-Tahoe exports Icon Composer
 * produced on macOS 26: black, Gaussian blur, offset downward.
 */
const SHADOW_SIGMA = 16;
const SHADOW_OFFSET_Y = 8;
const SHADOW_OPACITY = 0.25;

/** Ancillary chunks that describe colour, carried over so a Display P3 export stays P3. */
const COLOUR_CHUNK_TYPES = new Set(["iCCP", "sRGB", "gAMA", "cHRM", "cICP"]);

export const MACOS_ICON_PATHS = [
  BRAND_ASSET_PATHS.developmentDesktopIconPng,
  BRAND_ASSET_PATHS.nightlyMacIconPng,
  BRAND_ASSET_PATHS.productionMacIconPng,
] as const;

export interface OpaqueBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface RgbaPng {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8 | 16;
  /** Unfiltered scanlines, four samples per pixel, big-endian when 16-bit. */
  readonly pixels: Buffer;
  /** Colour chunks exactly as they appeared in the file, including length and CRC. */
  readonly colourChunks: ReadonlyArray<Buffer>;
}

export function decodeRgbaPng(contents: Buffer): RgbaPng {
  if (
    contents.length < 33 ||
    !contents.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    contents.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Not a PNG file.");
  }
  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  const bitDepth = contents.readUInt8(24);
  const colorType = contents.readUInt8(25);
  if (colorType !== 6 || (bitDepth !== 8 && bitDepth !== 16)) {
    throw new Error(
      `Expected an 8- or 16-bit RGBA PNG, got colour type ${colorType} at ${bitDepth}-bit.`,
    );
  }
  if (contents.readUInt8(28) !== 0) {
    throw new Error("Interlaced PNGs are not supported.");
  }

  const imageData: Array<Buffer> = [];
  const colourChunks: Array<Buffer> = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= contents.length) {
    const length = contents.readUInt32BE(offset);
    const type = contents.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      imageData.push(contents.subarray(offset + 8, offset + 8 + length));
    } else if (COLOUR_CHUNK_TYPES.has(type)) {
      colourChunks.push(contents.subarray(offset, offset + 12 + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (imageData.length === 0) {
    throw new Error("PNG contains no image data.");
  }

  const bytesPerPixel = 4 * (bitDepth / 8);
  const pixels = unfilter(
    NodeZlib.inflateSync(Buffer.concat(imageData)),
    width,
    height,
    bytesPerPixel,
  );
  return { width, height, bitDepth, pixels, colourChunks };
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const dLeft = Math.abs(p - left);
  const dUp = Math.abs(p - up);
  const dUpLeft = Math.abs(p - upLeft);
  return dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
}

/** Reverses the per-scanline filter PNG applies before compression. */
function unfilter(raw: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(stride * height);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(position);
    if (filter > 4) throw new Error(`Unsupported PNG filter type ${filter}.`);
    position += 1;
    const line = raw.subarray(position, position + stride);
    position += stride;
    const target = out.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const value = line.readUInt8(x);
      const left = x >= bytesPerPixel ? target.readUInt8(x - bytesPerPixel) : 0;
      const up = previous ? previous.readUInt8(x) : 0;
      const upLeft = previous && x >= bytesPerPixel ? previous.readUInt8(x - bytesPerPixel) : 0;
      target.writeUInt8((value + predict(filter, left, up, upLeft)) & 0xff, x);
    }
  }
  return out;
}

/** The value a PNG filter type predicts from a byte's left, upper and upper-left neighbours. */
function predict(type: number, left: number, up: number, upLeft: number): number {
  switch (type) {
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      return 0;
  }
}

/** Filters each scanline with whichever PNG filter leaves the smallest residuals. */
function filter(pixels: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc((stride + 1) * height);
  const residuals = (line: Buffer, previous: Buffer | null, type: number, target?: Buffer) => {
    let score = 0;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? line[x - bytesPerPixel]! : 0;
      const up = previous ? previous[x]! : 0;
      const upLeft = previous && x >= bytesPerPixel ? previous[x - bytesPerPixel]! : 0;
      const residual = (line[x]! - predict(type, left, up, upLeft)) & 0xff;
      if (target) target[x + 1] = residual;
      score += residual < 128 ? residual : 256 - residual;
    }
    return score;
  };
  for (let y = 0; y < height; y += 1) {
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    let bestType = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let type = 0; type <= 4; type += 1) {
      const score = residuals(line, previous, type);
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
      }
    }
    const row = out.subarray(y * (stride + 1), (y + 1) * (stride + 1));
    row[0] = bestType;
    residuals(line, previous, bestType, row);
  }
  return out;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(NodeZlib.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function encodeRgba16Png(
  pixels: Buffer,
  width: number,
  height: number,
  colourChunks: ReadonlyArray<Buffer>,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(16, 8);
  header.writeUInt8(6, 9);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    ...colourChunks,
    pngChunk("IDAT", NodeZlib.deflateSync(filter(pixels, width, height, 8), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Separable Gaussian blur of a single-channel square image, treating outside as zero. */
function gaussianBlur(values: Float32Array, size: number, sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = weight;
    total += weight;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i]! /= total;

  const horizontal = new Float32Array(values.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = x + k;
        if (sx >= 0 && sx < size) sum += values[y * size + sx]! * kernel[k + radius]!;
      }
      horizontal[y * size + x] = sum;
    }
  }
  const out = new Float32Array(values.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = y + k;
        if (sy >= 0 && sy < size) sum += horizontal[sy * size + x]! * kernel[k + radius]!;
      }
      out[y * size + x] = sum;
    }
  }
  return out;
}

/**
 * Places an 824x824 macOS icon body, exported full bleed from Icon Composer, on the
 * 1024x1024 canvas with the classic inset and drop shadow. The body's pixels and
 * colour profile are kept as exported; the result is always 16-bit RGBA.
 */
export function addMacOsIconMargin(contents: Buffer): Buffer {
  const body = decodeRgbaPng(contents);
  if (body.width !== MACOS_ICON_BODY_SIZE || body.height !== MACOS_ICON_BODY_SIZE) {
    throw new Error(
      `Expected an ${MACOS_ICON_BODY_SIZE}x${MACOS_ICON_BODY_SIZE} export, got ${body.width}x${body.height}.`,
    );
  }

  const size = MACOS_ICON_CANVAS_SIZE;
  const inset = MACOS_ICON_BODY_INSET;
  const sampleBytes = body.bitDepth / 8;
  const maxSample = body.bitDepth === 16 ? 0xffff : 0xff;
  const sample = (x: number, y: number, channel: number) => {
    const offset = ((y * body.width + x) * 4 + channel) * sampleBytes;
    return (
      (sampleBytes === 2 ? body.pixels.readUInt16BE(offset) : body.pixels[offset]!) / maxSample
    );
  };

  const bodyAlpha = (x: number, y: number) => {
    const bx = x - inset;
    const by = y - inset;
    return bx >= 0 && by >= 0 && bx < body.width && by < body.height ? sample(bx, by, 3) : 0;
  };
  const offsetAlpha = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      offsetAlpha[y * size + x] = bodyAlpha(x, y - SHADOW_OFFSET_Y);
    }
  }
  const shadow = gaussianBlur(offsetAlpha, size, SHADOW_SIGMA);

  const out = Buffer.alloc(size * size * 8);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = bodyAlpha(x, y);
      const shadowAlpha = shadow[y * size + x]! * SHADOW_OPACITY;
      // Body over a black shadow, in straight (non-premultiplied) alpha.
      const outAlpha = alpha + shadowAlpha * (1 - alpha);
      const offset = (y * size + x) * 8;
      if (outAlpha > 0 && alpha > 0) {
        const scale = alpha / outAlpha;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = sample(x - inset, y - inset, channel) * scale;
          out.writeUInt16BE(Math.round(value * 0xffff), offset + channel * 2);
        }
      }
      out.writeUInt16BE(Math.round(outAlpha * 0xffff), offset + 6);
    }
  }
  return encodeRgba16Png(out, size, size, body.colourChunks);
}

/**
 * Bounding box of fully opaque pixels. The shadow is partially transparent, so
 * thresholding at full opacity isolates the icon body from it.
 */
export function readOpaqueBounds(contents: Buffer): OpaqueBounds {
  const { width, height, bitDepth, pixels } = decodeRgbaPng(contents);
  const sampleBytes = bitDepth / 8;
  const bytesPerPixel = 4 * sampleBytes;
  const opaque = bitDepth === 16 ? 0xffff : 0xff;
  const stride = width * bytesPerPixel;

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alphaOffset = y * stride + x * bytesPerPixel + 3 * sampleBytes;
      const alpha = sampleBytes === 2 ? pixels.readUInt16BE(alphaOffset) : pixels[alphaOffset]!;
      if (alpha < opaque) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0 || bottom < 0) {
    throw new Error("PNG has no fully opaque pixels.");
  }
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}
