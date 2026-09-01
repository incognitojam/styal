import { describe, expect, it } from "vite-plus/test";

import config, { VARIANT_CONFIG } from "../app.config";

describe("mobile app identity", () => {
  it("uses an independent styal identity for every variant", () => {
    expect(VARIANT_CONFIG).toMatchObject({
      development: {
        appName: "styal Dev",
        scheme: "styal-dev",
        iosBundleIdentifier: "build.styal.app.dev",
        androidPackage: "build.styal.app.dev",
      },
      preview: {
        appName: "styal Preview",
        scheme: "styal-preview",
        iosBundleIdentifier: "build.styal.app.preview",
        androidPackage: "build.styal.app.preview",
      },
      production: {
        appName: "styal",
        scheme: "styal",
        iosBundleIdentifier: "build.styal.app",
        androidPackage: "build.styal.app",
      },
    });
    expect(config.slug).toBe("styal");
  });

  it("does not fall back to the upstream Expo project", () => {
    expect(config.owner).not.toBe("pingdotgg");
    expect(config.updates?.url).not.toBe("https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454");
    expect(config.extra?.eas?.projectId).not.toBe("d763fcb8-d37c-41ea-a773-b54a0ab4a454");
  });

  it("does not use upstream Apple or Clerk identity", () => {
    expect(config.ios?.appleTeamId).not.toBe("ARK85ZXQ4Z");
    expect(config.ios?.associatedDomains).not.toContain("applinks:clerk.t3.codes");
    expect(config.ios?.associatedDomains).not.toContain("webcredentials:clerk.t3.codes");
    expect(config.ios?.infoPlist?.NSLocalNetworkUsageDescription).toContain("styal");
  });
});
