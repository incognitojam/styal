// @vitest-environment jsdom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ onboarding: vi.fn(() => null) }));
vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: object) => ({
    options,
    useRouteContext: () => ({ authGateState: { status: "hosted-static" } }),
  }),
  useLocation: () => "/welcome",
  Outlet: () => <button onClick={openRelaySignIn}>Sign in</button>,
  Link: "a",
  redirect: vi.fn(),
  useNavigate: vi.fn(),
  useRouter: vi.fn(),
}));
vi.mock("../components/AppSidebarLayout", () => ({ AppSidebarLayout: "aside" }));
vi.mock("../components/CommandPalette", () => ({ CommandPalette: "main" }));
vi.mock("../components/cloud/ConnectOnboardingDialog", () => ({
  ConnectOnboardingDialog: state.onboarding,
}));
vi.mock("../components/relay-auth/RelayAccountDialog", () => ({ RelayAccountDialog: () => null }));
vi.mock("../components/relay-auth/RelayEmailSignInForm", () => ({
  RelayEmailSignInForm: () => <p>Email code sign-in</p>,
}));
vi.mock("../components/ui/dialog", () => ({
  Dialog: "dialog",
  DialogDescription: "p",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogPopup: "article",
  DialogTitle: "h1",
}));
vi.mock("../components/ui/toast", () => ({
  ToastProvider: "section",
  AnchoredToastProvider: "section",
  stackedThreadToast: vi.fn(),
  toastManager: {},
}));
vi.mock("../cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => true,
  resolveCloudPublicConfig: () => ({ relayUrl: "https://relay.example.test" }),
  resolveRelayTracingConfig: () => null,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: object) => unknown) => select({}),
}));
vi.mock("../hooks/useTheme", () => ({ syncBrowserChromeTheme: vi.fn() }));
vi.mock("../hooks/useDefaultTheme", () => ({ useDefaultThemeAdoption: vi.fn() }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeSync: vi.fn() }));
vi.mock("../appearanceFonts", () => ({ applyAppearanceFontVariables: vi.fn() }));
vi.mock("../appearanceContrast", () => ({ applyAppearanceContrast: vi.fn() }));
vi.mock("../lib/desktopPasteAsText", () => ({ installDesktopPasteAsText: vi.fn() }));
vi.mock("../environments/primary", () => ({ resolveInitialServerAuthGateState: vi.fn() }));
vi.mock("../observability/clientTracing", () => ({ configureClientTracing: vi.fn() }));
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    primaryServerConfigAtom: Atom.make(null),
    primaryServerConfigEventAtom: Atom.make(null),
    primaryServerWelcomeAtom: Atom.make(null),
    serverEnvironment: { configValueAtom: Atom.make(null) },
  };
});
vi.mock("../state/environments", () => ({
  useEnvironments: vi.fn(),
  usePrimaryEnvironment: vi.fn(),
}));
vi.mock("../state/entities", () => ({
  readProject: vi.fn(),
  setActiveEnvironmentId: vi.fn(),
  useActiveEnvironmentId: vi.fn(),
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: vi.fn(),
  derivePhysicalProjectKeyFromPath: vi.fn(),
  selectProjectGroupingSettings: vi.fn(),
}));
vi.mock("../uiStateStore", () => ({ useUiStateStore: {} }));
vi.mock("../components/PermissionUpdateNotice", () => ({ PermissionUpdateNotice: () => null }));
vi.mock("../components/CustomSnoozeDialog", () => ({ CustomSnoozeDialogHost: () => null }));
vi.mock("../components/KeybindingsConfigWarning", () => ({ KeybindingsConfigWarning: () => null }));
vi.mock("../components/onboarding/FirstRunGate", () => ({ FirstRunGate: () => null }));
vi.mock("../components/cloud/RelayClientInstallDialog", () => ({
  RelayClientInstallDialog: () => null,
}));
vi.mock("../components/desktop/SshPasswordPromptDialog", () => ({
  SshPasswordPromptDialog: () => null,
}));
vi.mock("../components/desktop/DiscordPresenceSync", () => ({ DiscordPresenceSync: () => null }));
vi.mock("../components/desktop/SnapShotCoordinator", () => ({ SnapShotCoordinator: () => null }));
vi.mock("../components/desktop/DesktopAppActivationCoordinator", () => ({
  DesktopAppActivationCoordinator: () => null,
}));
vi.mock("../components/desktop/RunningThreadKeepAlive", () => ({
  RunningThreadKeepAlive: () => null,
}));
vi.mock("../components/ProviderUpdateLaunchNotification", () => ({
  ProviderUpdateLaunchNotification: () => null,
}));
vi.mock("../components/LegacyThreadMigrationToast", () => ({
  LegacyThreadMigrationToast: () => null,
}));
vi.mock("../components/ThreadNotificationCoordinator", () => ({
  ThreadNotificationCoordinator: () => null,
}));
vi.mock("../components/ReopenClosedViewShortcut", () => ({ ReopenClosedViewShortcut: () => null }));
vi.mock("../components/ProjectCloneToastCoordinator", () => ({
  ProjectCloneToastCoordinator: () => null,
}));
vi.mock("../components/SlowRpcRequestToastCoordinator", () => ({
  SlowRpcRequestToastCoordinator: () => null,
}));
vi.mock("../components/settings/ChatGptWelcomeCoordinator", () => ({
  ChatGptWelcomeCoordinator: () => null,
}));
vi.mock("../components/settings/ProviderAuthCallbackCoordinator", () => ({
  ProviderAuthCallbackCoordinator: () => null,
}));
vi.mock("../components/settings/ThemeEditorHost", () => ({ ThemeEditorHost: () => null }));

import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import {
  openRelaySignIn,
  relaySignInDialogOpenAtom,
} from "../components/relay-auth/relayAuthDialogs";
import { Route } from "./__root";

let renderer: ReactTestRenderer;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  appAtomRegistry.set(relaySignInDialogOpenAtom, false);
  state.onboarding.mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

describe("welcome route relay authentication", () => {
  it("opens email sign-in while keeping post-sign-in onboarding suspended", async () => {
    const Root = Route.options.component as import("react").ComponentType;
    await act(async () => {
      renderer = create(
        <AppAtomRegistryProvider>
          <Root />
        </AppAtomRegistryProvider>,
      );
    });
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(renderer.root.findByType("dialog").props.open).toBe(true);
    expect(
      renderer.root.findAllByType("p").some((node) => node.children.includes("Email code sign-in")),
    ).toBe(true);
    expect(state.onboarding).not.toHaveBeenCalled();
  });
});
