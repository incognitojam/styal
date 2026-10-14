import { ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { externalSignInStatus, supportsInAppSignIn } from "./providerAccountStatus";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

function provider(overrides: Record<string, unknown> = {}) {
  return decodeProvider({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-14T00:00:00.000Z",
    models: [],
    ...overrides,
  });
}

describe("supportsInAppSignIn", () => {
  it("requires an explicit in-app sign-in capability", () => {
    expect(supportsInAppSignIn(provider())).toBe(false);
    expect(
      supportsInAppSignIn(provider({ setup: { canAuthenticate: false, canInstall: false } })),
    ).toBe(false);
    expect(
      supportsInAppSignIn(provider({ setup: { canAuthenticate: true, canInstall: false } })),
    ).toBe(true);
  });

  it("offers sign-in for installed ACP registry agents", () => {
    expect(supportsInAppSignIn(provider({ driver: "acpRegistry" }))).toBe(true);
    expect(supportsInAppSignIn(provider({ driver: "acpRegistry", installed: false }))).toBe(false);
  });
});

describe("externalSignInStatus", () => {
  it("names the CLI that owns the login and the plan it reports", () => {
    expect(
      externalSignInStatus(provider({ auth: { status: "authenticated", label: "Claude Max" } })),
    ).toBe("Signed in with the Claude CLI (Claude Max).");
    expect(externalSignInStatus(provider({ auth: { status: "unauthenticated" } }))).toBe(
      "Not signed in. Sign in with the Claude CLI on this environment.",
    );
  });

  it("explains why an unavailable provider has no account", () => {
    expect(externalSignInStatus(provider({ enabled: false }))).toBe("Turned off in Settings.");
    expect(externalSignInStatus(provider({ installed: false }))).toBe(
      "Not installed on this environment.",
    );
  });
});
