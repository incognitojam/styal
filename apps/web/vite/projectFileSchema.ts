import { buildStyalProjectFileJsonSchema } from "@t3tools/shared/projectFile";
import type { Plugin } from "vite-plus";

/**
 * Publishes the styal.json JSON schema with the hosted app. styal.json files
 * reference https://styal.build/schema/styal.json, which Cloudflare redirects
 * to this asset on the app's origin.
 */
export function projectFileSchemaPlugin(): Plugin {
  return {
    name: "styal:project-file-schema",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "schema/styal.json",
        source: `${JSON.stringify(buildStyalProjectFileJsonSchema(), null, 2)}\n`,
      });
    },
  };
}
