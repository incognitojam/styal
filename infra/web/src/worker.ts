/**
 * Serves the built styal web app. Cloudflare resolves each request against the
 * uploaded assets first; this entrypoint only exists because a Worker needs
 * one, and it hands everything straight to the assets binding.
 *
 * SPA fallback is asset configuration (`notFoundHandling`), not routing logic,
 * so there is deliberately nothing to branch on here.
 */
export default {
  fetch: (request: Request, env: { ASSETS: Fetcher }) => env.ASSETS.fetch(request),
};
