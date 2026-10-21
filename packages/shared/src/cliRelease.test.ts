import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseVersionFromDistTags,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
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
