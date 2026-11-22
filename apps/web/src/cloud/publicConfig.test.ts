import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hasCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("keeps styal Link sign-in on private browser origins", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubGlobal("window", { location: new URL("http://localhost:3773") });

    expect(hasCloudPublicConfig()).toBe(true);
  });
});
