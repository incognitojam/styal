import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  resolveProviderBanner,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-22T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
  compatibilityAdvisory: {
    status: "unsupported",
    message: "Unsupported version. Use 2.0.0.",
    recommendedVersion: "2.0.0",
    recommendedRange: null,
  },
};

describe("compatibility banners", () => {
  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusBanner(provider, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(provider, getProviderStatusBannerKey(provider))).toBe(
      false,
    );
    expect(
      shouldShowProviderStatusBanner(
        { ...provider, version: "1.0.1" },
        getProviderStatusBannerKey(provider),
      ),
    ).toBe(true);
    const relaxed: ServerProvider = {
      ...provider,
      compatibilityAdvisory: {
        ...provider.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(getProviderStatusBannerKey(relaxed)).toBeNull();
    expect(getProviderStatusBannerKey({ ...provider, status: "disabled" })).toBeNull();
    expect(
      getProviderStatusBannerKey({
        ...provider,
        compatibilityAdvisory: { ...provider.compatibilityAdvisory!, status: "graceful" },
      }),
    ).toBeNull();
  });

  it("shows downgrade guidance instead of a broken OpenCode inventory timeout", () => {
    const message = "This provider version is known to be incompatible. Use 1.14.19.";
    const broken: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("opencode"),
      version: "2.0.3",
      status: "error",
      auth: { status: "unknown" },
      message: "Failed to load OpenCode provider inventory: Timed out waiting for server start.",
      compatibilityAdvisory: {
        status: "broken",
        message,
        recommendedVersion: "1.14.19",
        recommendedRange: ">=1.14.19 <2.0.0",
      },
    };
    expect(shouldShowProviderStatusBanner(broken, null)).toBe(true);
    const timeoutOnly: ServerProvider = {
      ...broken,
      compatibilityAdvisory: {
        ...broken.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(timeoutOnly))).toBe(
      true,
    );
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(broken))).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        {
          ...broken,
          compatibilityAdvisory: { ...broken.compatibilityAdvisory!, message: "Use 1.14.20." },
        },
        getProviderStatusBannerKey(broken),
      ),
    ).toBe(true);
    expect(getProviderStatusMessage(broken)).toBe(message);
    expect(
      getProviderStatusMessage({
        ...broken,
        compatibilityAdvisory: {
          ...broken.compatibilityAdvisory!,
          status: "supported",
          message: null,
        },
      }),
    ).toBe(broken.message);
    expect(getProviderStatusMessage({ ...broken, auth: { status: "unauthenticated" } })).toBe(
      broken.message,
    );
  });
});

describe("resolveProviderBanner", () => {
  const { compatibilityAdvisory: _advisory, ...base } = provider;
  const healthy: ServerProvider = {
    ...base,
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    setup: { canAuthenticate: true, canInstall: false },
  };
  const signedOut: ServerProvider = {
    ...healthy,
    status: "error",
    auth: { status: "unauthenticated" },
    message: "Claude Code is not authenticated.",
  };
  const cliOnly: ServerProvider = {
    ...signedOut,
    setup: { canAuthenticate: false, canInstall: false },
  };
  const acpSignedOut: ServerProvider = {
    ...signedOut,
    driver: ProviderDriverKind.make("acpRegistry"),
    setup: { canAuthenticate: false, canInstall: false },
  };
  const antigravitySignedOut: ServerProvider = {
    ...signedOut,
    driver: ProviderDriverKind.make("antigravity"),
    status: "warning",
    setup: { canAuthenticate: true, canInstall: true },
  };
  const notInstalled: ServerProvider = {
    ...signedOut,
    installed: false,
    setup: { canAuthenticate: false, canInstall: true },
  };
  const brokenSignedOut: ServerProvider = {
    ...signedOut,
    status: "warning",
    compatibilityAdvisory: { ...provider.compatibilityAdvisory!, status: "broken" },
  };
  const turnFailed = { failed: true, lastErrorCode: "provider_auth_required" };
  const noTurn = { failed: false, lastErrorCode: undefined };

  it.each([
    ["new thread, signed out, styal can sign in", noTurn, undefined, signedOut, null, "sign-in"],
    ["new thread, ACP agent signed out", noTurn, undefined, acpSignedOut, null, "sign-in"],
    [
      "new thread, Antigravity signed out",
      noTurn,
      undefined,
      antigravitySignedOut,
      null,
      "sign-in",
    ],
    ["new thread, signed out, CLI sign-in only", noTurn, undefined, cliOnly, null, "status"],
    ["new thread, not installed", noTurn, undefined, notInstalled, null, "status"],
    [
      "new thread, signed out on a broken version",
      noTurn,
      undefined,
      brokenSignedOut,
      null,
      "status",
    ],
    ["new thread, healthy", noTurn, undefined, healthy, null, null],
    [
      "failed turn, provider still reads signed in",
      turnFailed,
      healthy,
      healthy,
      null,
      "failed-turn",
    ],
    ["failed turn, provider signed out", turnFailed, signedOut, signedOut, null, "failed-turn"],
    ["failed turn, CLI sign-in only", turnFailed, cliOnly, cliOnly, null, "status"],
    [
      "failed turn for another reason, signed out",
      { failed: true, lastErrorCode: "provider_error" },
      signedOut,
      signedOut,
      null,
      "sign-in",
    ],
    [
      "signed out, dismissed",
      noTurn,
      undefined,
      signedOut,
      getProviderStatusBannerKey(signedOut),
      null,
    ],
  ] as const)("%s", (_state, turn, turnProvider, selectedProvider, dismissed, expected) => {
    const banner = resolveProviderBanner({
      ...turn,
      turnProvider,
      selectedProvider,
      dismissedStatusBannerKey: dismissed,
    });
    expect(
      banner === null
        ? null
        : banner.kind === "status"
          ? "status"
          : banner.afterFailedTurn
            ? "failed-turn"
            : "sign-in",
    ).toBe(expected);
  });
});
