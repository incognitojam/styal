import * as NodeZlib from "node:zlib";

import { BRAND_ASSET_PATHS } from "@t3tools/shared/brandAssets";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The classic macOS icon safe area, at 1024pt: an opaque 824x824 body inset 100px
 * on every side, with only Icon Composer's shadow extending into the margin.
 *
 * Icon Composer's command line cannot produce this — its `macOS` platform exports
 * full bleed, and the `macOS pre-Tahoe` preset is GUI-only. So the tracked macOS
 * PNGs are the one brand asset a human exports by hand, which is exactly why they
 * need a check: a wrong preset still yields a 1024x1024 PNG and looks fine in a
 * diff, but ships an app icon with no margin.
 */
export const MACOS_ICON_CANVAS_SIZE = 1024;
export const MACOS_ICON_BODY_SIZE = 824;
export const MACOS_ICON_BODY_INSET = 100;

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

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
}

function readHeader(contents: Buffer): PngHeader {
  if (
    contents.length < 33 ||
    !contents.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    contents.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Not a PNG file.");
  }
  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
    bitDepth: contents.readUInt8(24),
    colorType: contents.readUInt8(25),
    interlace: contents.readUInt8(28),
  };
}

function concatImageData(contents: Buffer): Buffer {
  const chunks: Array<Buffer> = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= contents.length) {
    const length = contents.readUInt32BE(offset);
    const type = contents.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      chunks.push(contents.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (chunks.length === 0) {
    throw new Error("PNG contains no image data.");
  }
  return Buffer.concat(chunks);
}

/** Reverses the per-scanline filter PNG applies before compression. */
function unfilter(raw: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(stride * height);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(position);
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
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const dLeft = Math.abs(p - left);
          const dUp = Math.abs(p - up);
          const dUpLeft = Math.abs(p - upLeft);
          restored =
            value + (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft);
          break;
        }
        default:
          throw new Error(`Unsupported PNG filter type ${filter}.`);
      }
      target.writeUInt8(restored & 0xff, x);
    }
  }
  return out;
}

/**
 * Bounding box of fully opaque pixels. Icon Composer's shadow is partially
 * transparent, so thresholding at full opacity isolates the icon body from it.
 */
export function readOpaqueBounds(contents: Buffer): OpaqueBounds {
  const header = readHeader(contents);
  if (header.colorType !== 6 || (header.bitDepth !== 8 && header.bitDepth !== 16)) {
    throw new Error(
      `Expected an 8- or 16-bit RGBA PNG, got colour type ${header.colorType} at ${header.bitDepth}-bit.`,
    );
  }
  if (header.interlace !== 0) {
    throw new Error("Interlaced PNGs are not supported.");
  }

  const sampleBytes = header.bitDepth / 8;
  const bytesPerPixel = 4 * sampleBytes;
  const pixels = unfilter(
    NodeZlib.inflateSync(concatImageData(contents)),
    header.width,
    header.height,
    bytesPerPixel,
  );
  const opaque = header.bitDepth === 16 ? 0xffff : 0xff;
  const stride = header.width * bytesPerPixel;

  let left = header.width;
  let top = header.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < header.height; y += 1) {
    for (let x = 0; x < header.width; x += 1) {
      const alphaOffset = y * stride + x * bytesPerPixel + 3 * sampleBytes;
      const alpha =
        sampleBytes === 2 ? pixels.readUInt16BE(alphaOffset) : pixels.readUInt8(alphaOffset);
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
