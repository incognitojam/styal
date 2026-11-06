import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  // One URL per page: `/download/` and `/download` both served 200 before, which splits ranking signals.
  trailingSlash: false,
  redirects: [
    {
      source: "/app",
      destination: "https://app.t3.codes",
      permanent: true,
    },
  ],
};
