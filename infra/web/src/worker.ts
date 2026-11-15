/**
 * Cloudflare serves uploaded assets without running this Worker, so it only sees requests that
 * match no file. SPA fallback (`notFoundHandling`) answers page routes with index.html.
 */
export default {
  fetch: async (request: Request, env: { ASSETS: Fetcher; OLD_ASSETS: R2Bucket }) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/assets/")) return env.ASSETS.fetch(request);

    // A file this build lacks, usually requested by a tab opened before a deploy.
    const object =
      request.method === "GET" || request.method === "HEAD"
        ? await env.OLD_ASSETS.get(pathname.slice(1))
        : null;
    if (!object) {
      // index.html would fail to load as a module, and must not be cached under an asset URL.
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const headers = new Headers({ "Cache-Control": "public, max-age=31536000, immutable" });
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};
