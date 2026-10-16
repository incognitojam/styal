import { parseCliReleaseVersion } from "../packages/shared/src/cliReleaseVersion.ts";

// Only the launcher gets new versions. The `@styal/cli-<platform>` packages
// earlier releases published keep their old versions and channel tags.
const packages = ["@styal/cli"];

export async function checkCliReleaseFreshness(
  version: string,
  tag: string,
  request: typeof fetch = fetch,
) {
  if (tag !== "latest" && tag !== "nightly") throw new Error(`Unsupported release tag: ${tag}`);
  const targetRelease = parseCliReleaseVersion(version);
  const target = targetRelease.parts;
  if (targetRelease.channel !== (tag === "latest" ? "stable" : "nightly")) {
    throw new Error(`Release version ${version} does not belong to ${tag}`);
  }

  // Preflight before accepting existing bytes or publishing anything.
  // Callers serialize releases per channel for the duration of publication.
  for (const name of packages) {
    const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Cannot check ${name}: HTTP ${response.status}`);
    const metadata: unknown = await response.json();
    const tags =
      metadata && typeof metadata === "object" && "dist-tags" in metadata
        ? metadata["dist-tags"]
        : undefined;
    if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
      throw new Error(`Invalid dist-tags for ${name}`);
    }
    const current: unknown = tag in tags ? Reflect.get(tags, tag) : undefined;
    if (current === undefined) continue;
    if (typeof current !== "string") throw new Error(`Invalid ${tag} version for ${name}`);
    const published = parseCliReleaseVersion(current).parts;
    const difference = target.findIndex((part, index) => part !== published[index]);
    if (difference !== -1 && target[difference]! < published[difference]!) {
      throw new Error(`Stale release: ${name}@${tag} is ${current}, newer than ${version}`);
    }
  }
}

if (import.meta.main) {
  await checkCliReleaseFreshness(process.env.RELEASE_VERSION ?? "", process.env.DIST_TAG ?? "");
}
