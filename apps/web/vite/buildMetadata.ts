import type { Plugin } from "vite-plus";

/** The manifest and browser bundle must identify the same build, including rebuilds of one commit. */
export function buildMetadataPlugin(buildId: string): Plugin {
  return {
    name: "styal:build-metadata",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build.json",
        source: JSON.stringify({ buildId }),
      });
    },
  };
}
