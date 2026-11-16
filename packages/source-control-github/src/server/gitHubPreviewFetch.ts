// @effect-diagnostics nodeBuiltinImport:off -- HTTPS needs a pinned lookup to prevent DNS rebinding.
import * as NodeHttps from "node:https";
import { publicAddresses } from "@t3tools/shared/publicAddresses";
import { GITHUB_CREDENTIALED_MEDIA_HOSTS, gitHubMediaUrl } from "../shared/gitHubMedia.ts";

const REDIRECT_HOSTS = new Set([
  ...GITHUB_CREDENTIALED_MEDIA_HOSTS,
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
]);

export async function gitHubPreviewFetch(url: string, bearer: string | null, signal: AbortSignal) {
  let target = new URL(url);
  if (!gitHubMediaUrl(target)) throw new Error("Unsupported source");
  for (let hop = 0; hop <= 3; hop++) {
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      (target.port && target.port !== "443") ||
      !REDIRECT_HOSTS.has(target.hostname) ||
      (target.hostname === "github-production-user-asset-6210df.s3.amazonaws.com" &&
        !/^\/\d+\/\d+-[a-zA-Z0-9_.-]+$/.test(target.pathname))
    ) {
      throw new Error("Unsupported destination");
    }
    const addresses = await publicAddresses(target.hostname);
    if (!addresses) throw new Error("Non-public destination");
    const result = await new Promise<
      { location: string } | { bytes: Uint8Array; contentType: string }
    >((resolve, reject) => {
      const request = NodeHttps.get(
        target,
        {
          signal,
          agent: false,
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, addresses)
              : callback(null, addresses[0]!.address, addresses[0]!.family),
          headers: {
            "accept-encoding": "identity",
            ...(bearer && GITHUB_CREDENTIALED_MEDIA_HOSTS.has(target.hostname)
              ? { authorization: `Bearer ${bearer}` }
              : {}),
          },
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.destroy();
            resolve({ location: response.headers.location });
            return;
          }
          const maxBytes = 20 * 1024 * 1024;
          if (status !== 200 || Number(response.headers["content-length"] ?? 0) > maxBytes) {
            response.destroy();
            reject(new Error("Source refused"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) response.destroy(new Error("Source too large"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              bytes: Buffer.concat(chunks),
              contentType: response.headers["content-type"]?.split(";")[0] ?? "",
            }),
          );
        },
      );
      request.on("error", reject);
    });
    if (!("location" in result)) return result;
    target = new URL(result.location, target);
  }
  throw new Error("Too many redirects");
}
