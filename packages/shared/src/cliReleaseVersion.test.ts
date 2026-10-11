import { describe, expect, it } from "vite-plus/test";
import { parseCliReleaseVersion } from "./cliReleaseVersion.ts";

describe("release version parsing", () => {
  it("preserves publication ordering beyond JavaScript's safe integers", () => {
    const before = parseCliReleaseVersion("1.2.3-nightly.20261011.9007199254740992");
    const after = parseCliReleaseVersion("1.2.3-nightly.20261011.9007199254740993");
    expect(before.channel).toBe("nightly");
    expect(after.parts[5] - before.parts[5]).toBe(1n);
    expect(parseCliReleaseVersion("1.2.3").parts[3]).toBeGreaterThan(before.parts[3]);
  });
});
