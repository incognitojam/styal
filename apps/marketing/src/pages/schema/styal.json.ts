import type { APIRoute } from "astro";

import { buildStyalProjectFileJsonSchema } from "@t3tools/shared/projectFile";

// Rendered at build time for https://styal.build/schema/styal.json, so
// styal.json files can reference it via "$schema" for editor completion.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildStyalProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
