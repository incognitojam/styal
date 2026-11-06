import { describe, expect, it, vi } from "vite-plus/test";

import { hasLegacyClerkConfig, resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("needs Clerk settings only to move an older Clerk sign-in", () => {
    const relayOnly = resolveCloudPublicConfig({ relay: { url: "https://relay.example.test" } });
    expect(hasLegacyClerkConfig(relayOnly)).toBe(false);
    expect(
      hasLegacyClerkConfig(
        resolveCloudPublicConfig({
          clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
          relay: { url: "https://relay.example.test" },
        }),
      ),
    ).toBe(true);
  });
});
