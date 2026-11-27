import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { hasCloudPublicConfig } from "./publicConfig.ts";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("hasCloudPublicConfig", () => {
  it.each([undefined, "", "http://relay.example.test"])(
    "keeps Link off for missing or insecure relay configuration: %s",
    (url) => {
      vi.stubEnv("VITE_T3CODE_RELAY_URL", url);
      expect(hasCloudPublicConfig()).toBe(false);
    },
  );
  it.each(["http://localhost:3773", "https://machine.example.test", "styal://app"])(
    "uses the configured secure relay without a Clerk origin gate: %s",
    (origin) => {
      vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", undefined);
      vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", undefined);
      vi.stubGlobal("window", { location: new URL(origin) });
      expect(hasCloudPublicConfig()).toBe(true);
    },
  );
});
