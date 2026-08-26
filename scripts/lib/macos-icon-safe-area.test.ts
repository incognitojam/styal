// @effect-diagnostics nodeBuiltinImport:off - Reads tracked brand PNGs synchronously; no Effect runtime needed.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
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
