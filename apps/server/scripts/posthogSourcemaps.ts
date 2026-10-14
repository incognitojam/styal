import type { PackUserConfig } from "vite-plus/pack";

/**
 * Bundle plugins that upload server source maps to PostHog error tracking.
 *
 * The PostHog plugin stamps each chunk with a stable chunk id, which the error
 * reporter attaches to that chunk's frames at runtime, then uploads the maps.
 * Release CI sets the key, project, and `posthog-cli` path; any other build
 * gets no plugins and bundles as before. The plugin package loads only then,
 * so reading this config does not need it installed, as in jobs that install
 * only the scripts workspace.
 */
export function posthogSourcemapPlugins(input: {
  readonly version: string;
  readonly executable: boolean;
}): PackUserConfig["plugins"] {
  const apiKey = process.env.POSTHOG_SOURCEMAPS_API_KEY?.trim();
  const projectId = process.env.POSTHOG_SOURCEMAPS_PROJECT_ID?.trim();
  const cliBinaryPath = process.env.POSTHOG_CLI_PATH?.trim();
  if (!apiKey || !projectId || !cliBinaryPath) return [];

  return import("@posthog/rollup-plugin").then(({ default: posthogSourcemaps }) => {
    const upload = posthogSourcemaps({
      personalApiKey: apiKey,
      projectId,
      host: process.env.POSTHOG_SOURCEMAPS_HOST?.trim() || "https://eu.posthog.com",
      cliBinaryPath,
      sourcemaps: {
        releaseName: "styal-server",
        releaseVersion: input.version,
        // The executable embeds its script, so its maps have no other use.
        deleteAfterUpload: input.executable,
      },
    });
    if (!input.executable) return [upload];

    return [
      upload,
      {
        name: "server-executable-sourcemaps",
        writeBundle: {
          order: "post",
          sequential: true,
          handler(_options, bundle) {
            // tsdown counts assets as chunks when validating an executable.
            // PostHog deletes uploaded maps from disk; remove their bundle
            // entries too, after the upload, leaving the embedded script.
            for (const [name, output] of Object.entries(bundle)) {
              if (output.type === "asset" && name.endsWith(".map")) delete bundle[name];
            }
          },
        },
      },
    ];
  });
}
