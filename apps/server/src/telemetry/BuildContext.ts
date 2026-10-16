/** Classify the running process without guessing from a development package version. */
export function resolveBuildContext(input: {
  readonly releaseBuild: boolean;
  readonly developmentServer: boolean;
  readonly testProcess: boolean;
  readonly version: string;
}) {
  const buildKind = input.testProcess
    ? "test"
    : input.releaseBuild && !input.developmentServer
      ? "release"
      : "development";
  const releaseChannel =
    buildKind !== "release"
      ? "unknown"
      : input.version.includes("-nightly.")
        ? "nightly"
        : input.version.includes("-pr.") || input.version.includes("-preview.")
          ? "preview"
          : /^\d+\.\d+\.\d+$/.test(input.version)
            ? "stable"
            : "unknown";
  return { buildKind, releaseChannel } as const;
}
