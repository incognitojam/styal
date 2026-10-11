/** Version formats emitted by the release workflows, ordered without number truncation. */
export function parseCliReleaseVersion(version: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(nightly|preview)\.(\d{8})\.(0|[1-9]\d*))?$/.exec(
      version,
    );
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  return {
    channel: match[4] === "nightly" ? "nightly" : match[4] === "preview" ? "preview" : "stable",
    parts: [
      BigInt(match[1]!),
      BigInt(match[2]!),
      BigInt(match[3]!),
      match[4] === undefined ? 1n : 0n,
      BigInt(match[5] ?? 0),
      BigInt(match[6] ?? 0),
    ],
  } as const;
}
