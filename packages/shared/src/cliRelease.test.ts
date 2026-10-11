import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  cliReleaseChannelOf,
  cliReleaseVersionFromDistTags,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("names archives by version and platform, zip only on Windows", () => {
    expect(cliArchiveFileName("1.2.3-preview.20260911.4", "linux-x64")).toBe(
      "styal-1.2.3-preview.20260911.4-linux-x64.tar.gz",
    );
    expect(cliArchiveFileName("1.2.3", "win32-x64")).toBe("styal-1.2.3-win32-x64.zip");
  });

  it("only maps platforms and architectures that have a release archive", () => {
    expect(cliArchivePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cliArchivePlatformKey("win32", "x64")).toBe("win32-x64");
    // Node single-executables are unsupported on x64 macOS.
    expect(cliArchivePlatformKey("darwin", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(cliArchivePlatformKey("win32", "arm64")).toBe("win32-arm64");
    expect(cliArchivePlatformKey("freebsd", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("linux", "ia32")).toBeUndefined();
  });

  it("resolves download URLs under the tagged release, honoring a mirror", () => {
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
      "https://github.com/incognitojam/styal/releases/download/v1.2.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/styal/")).toBe(
      "https://mirror.example/styal/v1.2.3",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  styal-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *styal-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("styal-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("styal-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("derives the release channel from the version alone", () => {
    expect(cliReleaseChannelOf("1.2.3")).toBe("stable");
    expect(cliReleaseChannelOf("1.2.3-nightly.20260911.4")).toBe("nightly");
    expect(cliReleaseChannelOf("1.2.3-preview.20260911.4")).toBe("preview");
    // A prerelease that is not one of our trains is not silently a nightly.
    expect(cliReleaseChannelOf("1.2.3-rc.1")).toBe("stable");
  });
});

describe("npm release channels", () => {
  const tags = {
    latest: "1.2.3",
    nightly: "1.2.4-nightly.20261011.9",
    preview: "1.2.4-preview.20261010.2",
  };

  it.each(["stable", "nightly", "preview"] as const)("selects only %s", (channel) => {
    expect(cliReleaseVersionFromDistTags(tags, channel)).toBe(
      tags[channel === "stable" ? "latest" : channel],
    );
  });

  it.each([
    ["stable", { latest: tags.nightly }],
    ["nightly", { nightly: tags.latest }],
    ["nightly", { nightly: tags.preview }],
    ["preview", { preview: tags.nightly }],
  ] as const)("rejects a tag outside %s", (channel, input) => {
    expect(() => cliReleaseVersionFromDistTags(input, channel)).toThrow(
      `outside the ${channel} channel`,
    );
  });

  it.each([undefined, null, [], "1.2.3", {}, { nightly: tags.nightly }, { latest: 1 }])(
    "rejects malformed or missing stable tags",
    (input) => expect(() => cliReleaseVersionFromDistTags(input, "stable")).toThrow(),
  );

  it.each(["", "v1.2.3", "01.2.3", "1.2.3-rc.1", "1.2.3+build", "1.2.3-nightly.20261011.01"])(
    "rejects unsupported release version %s",
    (version) =>
      expect(() => cliReleaseVersionFromDistTags({ latest: version }, "stable")).toThrow(
        "Unsupported release version",
      ),
  );
});
