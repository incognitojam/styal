import { describe, expect, it } from "vite-plus/test";
import { BRAND_ASSET_PATHS } from "@t3tools/shared/brandAssets";

import { AUTHORED_WEB_ICON_SOURCE_PATHS, resolveWebIconOverrides } from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps production web assets into the server package", () => {
    expect(resolveWebIconOverrides("production", "dist/client")).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: "dist/client/favicon.ico",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconSvg,
        targetRelativePath: "dist/client/favicon.svg",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: "dist/client/favicon-16x16.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: "dist/client/favicon-32x32.png",
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: "dist/client/apple-touch-icon.png",
      },
    ]);
  });

  it("treats every vector favicon as hand-authored rather than rendered", () => {
    expect([...AUTHORED_WEB_ICON_SOURCE_PATHS]).toEqual([
      BRAND_ASSET_PATHS.developmentWebFaviconSvg,
      BRAND_ASSET_PATHS.nightlyWebFaviconSvg,
      BRAND_ASSET_PATHS.productionWebFaviconSvg,
    ]);
    for (const sourcePath of AUTHORED_WEB_ICON_SOURCE_PATHS) {
      expect(sourcePath.endsWith(".svg")).toBe(true);
    }
  });
});
