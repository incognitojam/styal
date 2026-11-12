import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  dismissProviderStatusBannerForSession,
  getProviderStatusBannerKey,
  getProviderStatusDismissalKey,
  getProviderStatusMessage,
  resolveProviderBanner,
  isProviderStatusBannerDismissedForSession,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";
import { signInDialogProvider } from "./useProviderSignInBanner";

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

function shownAfterDismissing(dismissed: ServerProvider, shown: ServerProvider): boolean {
  return shouldShowProviderStatusBanner(
    shown,
    getProviderStatusBannerKey(shown) === getProviderStatusBannerKey(dismissed),
  );
}

describe("compatibility banners", () => {
  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusBanner(provider, false)).toBe(true);
    expect(shownAfterDismissing(provider, provider)).toBe(false);
    expect(shownAfterDismissing(provider, { ...provider, version: "1.0.1" })).toBe(true);
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
    expect(shouldShowProviderStatusBanner(broken, false)).toBe(true);
    const timeoutOnly: ServerProvider = {
      ...broken,
      compatibilityAdvisory: {
        ...broken.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(shownAfterDismissing(timeoutOnly, broken)).toBe(true);
    expect(shownAfterDismissing(broken, broken)).toBe(false);
    expect(
      shownAfterDismissing(broken, {
        ...broken,
        compatibilityAdvisory: { ...broken.compatibilityAdvisory!, message: "Use 1.14.20." },
      }),
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

describe("which banner a provider shows", () => {
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
    driver: ProviderDriverKind.make("codex"),
    setup: { canAuthenticate: false, canInstall: false },
  };
  const cursorApiKey: ServerProvider = {
    ...signedOut,
    driver: ProviderDriverKind.make("cursor"),
    setup: { canAuthenticate: false, canInstall: false },
  };
  const acp = ProviderDriverKind.make("acpRegistry");
  const acpWithSignIn: ServerProvider = { ...signedOut, driver: acp, status: "warning" };
  const acpWithoutSignIn: ServerProvider = {
    ...acpWithSignIn,
    setup: { canAuthenticate: false, canInstall: false },
  };
  const antigravityGoogle: ServerProvider = {
    ...signedOut,
    driver: ProviderDriverKind.make("antigravity"),
    status: "warning",
    setup: { canAuthenticate: true, canInstall: true },
  };
  const antigravityApiKey: ServerProvider = {
    ...antigravityGoogle,
    auth: { status: "unauthenticated", type: "gemini-api-key" },
  };
  const notInstalled: ServerProvider = {
    ...signedOut,
    installed: false,
    setup: { canAuthenticate: false, canInstall: true },
  };
  const advisory = (status: "broken" | "unsupported") => ({
    status,
    message: "Use 2.0.0.",
    recommendedVersion: "2.0.0",
    recommendedRange: null,
  });
  const brokenSignedOut: ServerProvider = {
    ...signedOut,
    compatibilityAdvisory: advisory("broken"),
  };
  const unsupportedSignedOut: ServerProvider = {
    ...signedOut,
    compatibilityAdvisory: advisory("unsupported"),
  };
  const unsupportedWarning: ServerProvider = { ...unsupportedSignedOut, status: "warning" };
  const dismissedSignedOut = getProviderStatusBannerKey(signedOut);
  const turnFailed = { failed: true, lastErrorCode: "provider_auth_required" };
  const noTurn = { failed: false, lastErrorCode: undefined };

  // [state, turn, provider of the failed turn, selected provider, dismissed key, expected banner]
  it.each([
    ["provider status still loading", noTurn, undefined, null, null, null],
    ["healthy", noTurn, undefined, healthy, null, null],
    ["signed out, sign-in dialog can fix it", noTurn, undefined, signedOut, null, "sign-in"],
    ["ACP agent with a sign-in method", noTurn, undefined, acpWithSignIn, null, "sign-in"],
    ["ACP agent without a sign-in method", noTurn, undefined, acpWithoutSignIn, null, "status"],
    ["Antigravity signed in with Google", noTurn, undefined, antigravityGoogle, null, "sign-in"],
    ["Antigravity with an API key", noTurn, undefined, antigravityApiKey, null, "status"],
    ["Cursor with an API key", noTurn, undefined, cursorApiKey, null, "status"],
    ["signed out, CLI login only", noTurn, undefined, cliOnly, null, "status"],
    ["not installed", noTurn, undefined, notInstalled, null, "status"],
    ["signed out on a broken version", noTurn, undefined, brokenSignedOut, null, "status"],
    [
      "signed out on an unsupported version",
      noTurn,
      undefined,
      unsupportedSignedOut,
      null,
      "status",
    ],
    ["warning on an unsupported version", noTurn, undefined, unsupportedWarning, null, "status"],
    ["signed out, dismissed", noTurn, undefined, signedOut, dismissedSignedOut, null],
    [
      "dismissed, then a broken version",
      noTurn,
      undefined,
      brokenSignedOut,
      dismissedSignedOut,
      "status",
    ],
    [
      "dismissed, then not installed",
      noTurn,
      undefined,
      notInstalled,
      dismissedSignedOut,
      "status",
    ],
    ["failed turn, provider reads signed in", turnFailed, healthy, healthy, null, "failed-turn"],
    ["failed turn, provider signed out", turnFailed, signedOut, signedOut, null, "failed-turn"],
    ["failed turn, CLI login only", turnFailed, cliOnly, cliOnly, null, "status"],
    [
      "turn failed for another reason, signed out",
      { failed: true, lastErrorCode: "provider_error" },
      signedOut,
      signedOut,
      null,
      "sign-in",
    ],
  ] as const)("%s", (_state, turn, turnProvider, selectedProvider, dismissedKey, expected) => {
    const dismissed =
      dismissedKey !== null && dismissedKey === getProviderStatusBannerKey(selectedProvider);
    if (!turn.failed) {
      expect(shouldShowProviderStatusBanner(selectedProvider, dismissed)).toBe(
        expected === "status",
      );
    }
    const banner = resolveProviderBanner({
      ...turn,
      turnProvider,
      selectedProvider,
      statusBannerDismissed: dismissed,
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

  it("acts only on the environment the sign-in dialog was opened for", () => {
    const opened = EnvironmentId.make("laptop");
    const target = {
      environmentId: opened,
      instanceId: signedOut.instanceId,
      entryPoint: "signed_out",
      open: true,
    } as const;
    expect(signInDialogProvider(target, opened, [signedOut])).toBe(signedOut);
    expect(signInDialogProvider(target, EnvironmentId.make("server"), [signedOut])).toBeUndefined();
  });
});

describe("banner dismissal", () => {
  const { compatibilityAdvisory: _advisory, ...healthy } = provider;
  const failing: ServerProvider = {
    ...healthy,
    instanceId: ProviderInstanceId.make("codex-dismissal"),
    status: "error",
    message: "Could not start Codex CLI.",
  };

  it("keeps a dismissed status hidden in other views until the status changes", () => {
    const key = getProviderStatusDismissalKey("environment-a", failing);
    expect(isProviderStatusBannerDismissedForSession(key)).toBe(false);

    dismissProviderStatusBannerForSession(key);

    expect(
      isProviderStatusBannerDismissedForSession(
        getProviderStatusDismissalKey("environment-a", failing),
      ),
    ).toBe(true);
    expect(
      isProviderStatusBannerDismissedForSession(
        getProviderStatusDismissalKey("environment-a", { ...failing, message: "Codex exited." }),
      ),
    ).toBe(false);
  });

  it("keeps a dismissal to the environment it was taken in", () => {
    dismissProviderStatusBannerForSession(getProviderStatusDismissalKey("environment-c", failing));

    expect(
      isProviderStatusBannerDismissedForSession(
        getProviderStatusDismissalKey("environment-d", failing),
      ),
    ).toBe(false);
  });
});
