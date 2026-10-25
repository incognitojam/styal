/**
 * A Worker needs an entrypoint; Cloudflare serves uploaded assets first, and SPA fallback is
 * asset configuration (`notFoundHandling`), so there is nothing to route here.
 */
export default {
  fetch: (request: Request, env: { ASSETS: Fetcher }) => env.ASSETS.fetch(request),
};
