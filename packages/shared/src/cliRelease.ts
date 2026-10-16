/**
 * Naming shared by the release workflow, the runtime installers, and
 * install scripts for the per-platform CLI archives attached to GitHub
 * Releases. Every consumer derives the same file names from a version and a
 * platform key, so a rename here is a release-breaking change.
 */

import * as Schema from "effect/Schema";
import { CLI_PACKAGE_NAME } from "./cliPackage.ts";
import { parseCliReleaseVersion } from "./cliReleaseVersion.ts";

const CLI_RELEASE_REPOSITORY = "incognitojam/styal";
export const CLI_NPM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${CLI_PACKAGE_NAME}/dist-tags`;
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
/** Overrides the download origin for mirrors and air-gapped installs. */
export const CLI_RELEASE_BASE_URL_ENV = "STYAL_RELEASE_BASE_URL";

/**
 * The archives a release attaches. Kept in step with the build_linux_cli
 * matrix in .github/workflows/fork-cli-archives.yml: a key here without a build there produces
 * download URLs that 404, and a build there without a key here is
 * unreachable from every installer.
 */
// Intel macOS is outside the supported platform set.
const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/**
 * The tar to extract a release archive with. Windows ships bsdtar in
 * System32, which reads both formats; a Git-for-Windows GNU tar earlier on
 * PATH cannot open the zip, so the system copy is named by absolute path.
 */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `styal-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

/** Directory that `releases/download/<tag>/<asset>` lives under. */
export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

/**
 * The checksums asset of a release. The release workflows move the npm tag
 * only after the GitHub release that hosts the archives is published, but
 * update checks still confirm this exists before offering a version: a
 * mirror set through the base URL can lag behind npm.
 */
export function cliReleaseChecksumsUrl(version: string, baseUrl?: string): string {
  return `${cliReleaseDownloadBaseUrl(version, baseUrl)}/${CLI_RELEASE_CHECKSUMS_FILE}`;
}

export function cliReleasePendingMessage(version: string): string {
  return `styal ${version} is still being published. Try again in a few minutes.`;
}

/**
 * Parses the `sha256sum` style checksum file attached to each release.
 * Lines are `<hex>  <file>`; a leading `*` marks binary mode and is ignored.
 */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = [
  "stable",
  "nightly",
  "preview",
];

const decodeDistTags = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));

/** Resolve one channel without letting npm's initial latest tag cross release trains. */
export function cliReleaseVersionFromDistTags(input: unknown, channel: CliReleaseChannel) {
  let tags;
  try {
    tags = decodeDistTags(input);
  } catch {
    throw new Error("The npm dist-tags response had an unexpected shape.");
  }
  const tag = channel === "stable" ? "latest" : channel;
  const version = tags[tag];
  if (version === undefined) throw new Error(`No published ${channel} release was found.`);
  if (parseCliReleaseVersion(version).channel !== channel) {
    throw new Error(`npm tag ${tag} points to a release outside the ${channel} channel.`);
  }
  return version;
}

/** The release train a version was published on, derived from its prerelease tag. */
export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}
