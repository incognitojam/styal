// @effect-diagnostics nodeBuiltinImport:off - Reads tracked brand PNGs synchronously; no Effect runtime needed.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import {
  addMacOsIconMargin,
  decodeRgbaPng,
  MACOS_ICON_BODY_INSET,
  MACOS_ICON_BODY_SIZE,
  MACOS_ICON_CANVAS_SIZE,
  MACOS_ICON_PATHS,
  readOpaqueBounds,
} from "./macos-icon-safe-area.ts";

const repositoryRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));

describe("macOS icon safe area", () => {
  it.each(MACOS_ICON_PATHS)("keeps the pre-Tahoe safe area in %s", (relativePath) => {
    const bounds = readOpaqueBounds(NodeFS.readFileSync(`${repositoryRoot}${relativePath}`));
    expect({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    }).toEqual({
      left: MACOS_ICON_BODY_INSET,
      top: MACOS_ICON_BODY_INSET,
      width: MACOS_ICON_BODY_SIZE,
      height: MACOS_ICON_BODY_SIZE,
    });
    expect(bounds.right).toBe(MACOS_ICON_CANVAS_SIZE - MACOS_ICON_BODY_INSET - 1);
    expect(bounds.bottom).toBe(MACOS_ICON_CANVAS_SIZE - MACOS_ICON_BODY_INSET - 1);
  });
});

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(NodeZlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGBA PNG of `size`, opaque `rgb` except for a transparent `border`. */
function bodyPng(size: number, border: number, rgb: readonly number[], extra: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = border; y < size - border; y += 1) {
    for (let x = border; x < size - border; x += 1) {
      raw.set([...rgb, 255], y * stride + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    extra,
    pngChunk("IDAT", NodeZlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("addMacOsIconMargin", () => {
  const profile = pngChunk(
    "iCCP",
    Buffer.concat([Buffer.from("Display P3\0\0"), Buffer.from("x")]),
  );
  const finished = addMacOsIconMargin(bodyPng(MACOS_ICON_BODY_SIZE, 0, [30, 140, 149], profile));
  const image = decodeRgbaPng(finished);
  const pixel = (x: number, y: number) => {
    const offset = (y * image.width + x) * 8;
    return [0, 2, 4, 6].map((channel) => image.pixels.readUInt16BE(offset + channel) >> 8);
  };

  it("places the export in the classic safe area", () => {
    expect([image.width, image.height, image.bitDepth]).toEqual([
      MACOS_ICON_CANVAS_SIZE,
      MACOS_ICON_CANVAS_SIZE,
      16,
    ]);
    expect(readOpaqueBounds(finished)).toMatchObject({
      left: MACOS_ICON_BODY_INSET,
      top: MACOS_ICON_BODY_INSET,
      width: MACOS_ICON_BODY_SIZE,
      height: MACOS_ICON_BODY_SIZE,
    });
  });

  it("keeps the body's colours and colour profile", () => {
    expect(pixel(512, 512)).toEqual([30, 140, 149, 255]);
    expect(image.colourChunks).toEqual([profile]);
  });

  it("casts a black shadow that falls below the body and fades out", () => {
    const [red, green, blue, below] = pixel(512, 930);
    const above = pixel(512, 93)[3]!;
    expect([red, green, blue]).toEqual([0, 0, 0]);
    expect(below).toBeGreaterThan(above);
    expect(above).toBeGreaterThan(0);
    expect(pixel(512, 1000)[3]).toBe(0);
    expect(pixel(0, 0)[3]).toBe(0);
  });

  it("rejects an export that is not 824pt", () => {
    expect(() =>
      addMacOsIconMargin(bodyPng(MACOS_ICON_CANVAS_SIZE, 0, [0, 0, 0], Buffer.alloc(0))),
    ).toThrow(/824x824/);
  });
});
