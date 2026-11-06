import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  account: { isSignedIn: false, accountId: null as string | null },
  accountListeners: new Set<() => void>(),
  optOut: { optOutAccounts: [] as Array<string> },
}));
// The account is an external store so a change re-renders the dialog, as the relay session atom does.
vi.mock(import("../../cloud/useRelayAccount"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.accountListeners.add(listener);
    return () => state.accountListeners.delete(listener);
  };
  const read = () => state.account;
  return {
    ...(await original()),
    useRelayAccount: (() => useSyncExternalStore(subscribe, read, read)) as never,
  };
});
vi.mock(import("../../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => true,
}));
vi.mock(import("../../cloud/useCloudLinkController"), async (original) => ({
  ...(await original()),
  useCloudLinkController: (() => ({
    linkState: { target: null, data: null, error: null },
    operationError: null,
  })) as never,
}));
vi.mock(import("../../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => [state.optOut, vi.fn()]) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ isReady: true, environments: [] })) as never,
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => false,
  readEnvironmentScope: () => false,
}));
vi.mock(import("./CloudEnvironmentConnectList"), async (original) => ({
  ...(await original()),
  CloudEnvironmentConnectRows: () => null,
}));

import { interactiveRelaySignInAtom } from "../../cloud/connectOnboarding";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { ConnectOnboardingDialog } from "./ConnectOnboardingDialog";

const view = () => (
  <AppAtomRegistryProvider>
    <ConnectOnboardingDialog />
  </AppAtomRegistryProvider>
);
function setAccount(account: typeof state.account) {
  state.account = account;
  for (const listener of state.accountListeners) listener();
}
const wizard = () => page.getByRole("dialog", { name: "Set up styal Link" });

// Starts signed out with no opt-outs and no interactive sign-in; dispose clears the sign-in atom.
function setup(): Disposable {
  state.accountListeners.clear();
  state.account = { isSignedIn: false, accountId: null };
  state.optOut = { optOutAccounts: [] };
  appAtomRegistry.set(interactiveRelaySignInAtom, null);
  return { [Symbol.dispose]: () => appAtomRegistry.set(interactiveRelaySignInAtom, null) };
}

describe("interactive Link onboarding", () => {
  it("stays closed after silent adoption, then opens after interactive sign-in", async () => {
    using _setup = setup();
    await using _screen = await render(view());
    await act(() => setAccount({ isSignedIn: true, accountId: "synthetic-account" }));
    expect(wizard().query()).toBeNull();

    await act(() =>
      appAtomRegistry.set(interactiveRelaySignInAtom, { accountId: "synthetic-account" }),
    );
    expect(wizard().query()).not.toBeNull();

    await act(() => setAccount({ isSignedIn: false, accountId: null }));
    await expect.element(wizard()).not.toBeInTheDocument();
  });

  it("does not replay a sign-in completed while onboarding was suspended on welcome", async () => {
    using _setup = setup();
    state.account = { isSignedIn: true, accountId: "synthetic-account" };
    appAtomRegistry.set(interactiveRelaySignInAtom, { accountId: "synthetic-account" });
    await using _screen = await render(view());
    expect(wizard().query()).toBeNull();
  });

  it("continues to honor the account's opt-out preference", async () => {
    using _setup = setup();
    state.optOut = { optOutAccounts: ["synthetic-account"] };
    await using _screen = await render(view());
    await act(() => {
      setAccount({ isSignedIn: true, accountId: "synthetic-account" });
      appAtomRegistry.set(interactiveRelaySignInAtom, { accountId: "synthetic-account" });
    });
    expect(wizard().query()).toBeNull();
  });
});
