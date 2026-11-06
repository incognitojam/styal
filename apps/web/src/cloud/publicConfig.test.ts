import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, hasLegacyClerkConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hasCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("keeps styal Link sign-in on private browser origins", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubGlobal("window", { location: new URL("http://localhost:3773") });

    expect(hasCloudPublicConfig()).toBe(true);
  });
});

describe("hasLegacyClerkConfig", () => {
  describe("browser origins", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
      vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
      vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    });

    it.each(["https://example.com", "https://nightly.app.example.com:443"])(
      "enables moving a Clerk sign-in on the configured root and subdomains: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasLegacyClerkConfig()).toBe(true);
      },
    );

    it.each(["http://localhost:3773", "https://machine.example.ts.net"])(
      "disables moving a Clerk sign-in on private browser origins: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasLegacyClerkConfig()).toBe(false);
      },
    );

    it.each(["http://app.example.com:443", "https://app.example.com:3773"])(
      "rejects unsupported schemes and ports even on the configured domain: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasLegacyClerkConfig()).toBe(false);
      },
    );

    it.each(["https://notexample.com", "https://example.com.evil.test"])(
      "rejects domain lookalikes: %s",
      (origin) => {
        vi.stubGlobal("window", { location: new URL(origin) });

        expect(hasLegacyClerkConfig()).toBe(false);
      },
    );

    it.each([
      ["https://tenant.clerk.accounts.dev", true],
      ["https://other.clerk.accounts.dev", false],
    ])("keeps a provider hostname scoped to its own instance: %s", (origin, expected) => {
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("tenant.clerk.accounts.dev$")}`);
      vi.stubGlobal("window", { location: new URL(origin) });

      expect(hasLegacyClerkConfig()).toBe(expected);
    });

    it("keeps production keys available in the Electron auth shell", () => {
      vi.stubGlobal("window", { location: new URL("file:///app/index.html"), desktopBridge: {} });

      expect(hasLegacyClerkConfig()).toBe(true);
    });
  });
});
