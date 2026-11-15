/**
 * Cloudflare serves uploaded assets without running this Worker, so it only sees requests that
 * match no file. SPA fallback (`notFoundHandling`) answers page routes with index.html.
 */
export default {
  fetch: (request: Request, env: { ASSETS: Fetcher }) => {
    // A file this build lacks, usually requested by a tab opened before a deploy. index.html
    // would fail to load as a module anyway, and it must not be cached under an asset URL.
    if (new URL(request.url).pathname.startsWith("/assets/")) {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return env.ASSETS.fetch(request);
  },
};
