import type { APIRoute } from "astro";

import { buildStyalProjectFileJsonSchema } from "@t3tools/shared/styalProjectFile";

// Rendered at build time; published at https://styal.build/schema/styal.json so
// styal.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildStyalProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
