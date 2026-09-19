const packages = [
  "@styal/cli",
  ...["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].map(
    (key) => `@styal/cli-${key}`,
  ),
];

// These are the two version formats emitted by the fork release workflows.
function releaseParts(version: string): bigint[] {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.(\d{8})\.(0|[1-9]\d*))?$/.exec(version);
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  return [
    BigInt(match[1]!),
    BigInt(match[2]!),
    BigInt(match[3]!),
    match[4] === undefined ? 1n : 0n,
    BigInt(match[4] ?? 0),
    BigInt(match[5] ?? 0),
  ];
}

export async function checkCliReleaseFreshness(
  version: string,
  tag: string,
  request: typeof fetch = fetch,
) {
  if (tag !== "latest" && tag !== "nightly") throw new Error(`Unsupported release tag: ${tag}`);
  const target = releaseParts(version);
  if ((tag === "nightly") !== version.includes("-nightly.")) {
    throw new Error(`Release version ${version} does not belong to ${tag}`);
  }

  // Preflight the entire set before accepting existing bytes or publishing anything.
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
    const published = releaseParts(current);
    const difference = target.findIndex((part, index) => part !== published[index]);
    if (difference !== -1 && target[difference]! < published[difference]!) {
      throw new Error(`Stale release: ${name}@${tag} is ${current}, newer than ${version}`);
    }
  }
}

if (import.meta.main) {
  await checkCliReleaseFreshness(process.env.RELEASE_VERSION ?? "", process.env.DIST_TAG ?? "");
}
