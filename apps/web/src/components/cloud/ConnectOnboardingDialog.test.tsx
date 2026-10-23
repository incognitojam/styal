import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  account: { isSignedIn: false, accountId: null as string | null },
  optOut: { optOutAccounts: [] as Array<string> },
}));
vi.mock("../../cloud/useRelayAccount", () => ({ useRelayAccount: () => state.account }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => true }));
vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({ linkState: { target: null, data: null } }),
}));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [state.optOut, vi.fn()] }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: [] }),
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../state/session", () => ({
  environmentSession: {},
  useEnvironmentScope: () => false,
  readEnvironmentScope: () => false,
}));
vi.mock("./CloudEnvironmentConnectList", () => ({ CloudEnvironmentConnectRows: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/dialog", () => ({ Dialog: "dialog" }));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/wizard", () => ({
  WizardSteps: "nav",
  WizardPopup: "main",
  WizardHeader: "header",
  WizardPanel: "section",
  WizardFooter: "footer",
}));

import { interactiveRelaySignInAtom } from "../../cloud/connectOnboarding";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { ConnectOnboardingDialog } from "./ConnectOnboardingDialog";

let renderer: ReactTestRenderer;
const view = () => (
  <AppAtomRegistryProvider>
    <ConnectOnboardingDialog />
  </AppAtomRegistryProvider>
);
async function mount() {
  await act(async () => {
    renderer = create(view());
  });
}
function isOpen() {
  return renderer.root.findByType("dialog").props.open;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.account = { isSignedIn: false, accountId: null };
  state.optOut = { optOutAccounts: [] };
  appAtomRegistry.set(interactiveRelaySignInAtom, null);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

describe("interactive Link onboarding", () => {
  it("stays closed after silent adoption, then opens after interactive sign-in", async () => {
    await mount();
    state.account = { isSignedIn: true, accountId: "synthetic-account" };
    await act(async () => renderer.update(view()));
    expect(isOpen()).toBe(false);
    await act(async () =>
      appAtomRegistry.set(interactiveRelaySignInAtom, { accountId: "synthetic-account" }),
    );
    expect(isOpen()).toBe(true);
    state.account = { isSignedIn: false, accountId: null };
    await act(async () => renderer.update(view()));
    expect(isOpen()).toBe(false);
  });

  it("does not replay a sign-in completed while onboarding was suspended on welcome", async () => {
    state.account = { isSignedIn: true, accountId: "synthetic-account" };
    appAtomRegistry.set(interactiveRelaySignInAtom, { accountId: "synthetic-account" });
    await mount();
    expect(isOpen()).toBe(false);
  });

  it("continues to honor the account's opt-out preference", async () => {
    state.optOut = { optOutAccounts: ["synthetic-account"] };
    await mount();
    state.account = { isSignedIn: true, accountId: "synthetic-account" };
    await act(async () => {
      renderer.update(view());
      appAtomRegistry.set(interactiveRelaySignInAtom, { accountId: "synthetic-account" });
    });
    expect(isOpen()).toBe(false);
  });
});
