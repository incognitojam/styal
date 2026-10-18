import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  current: null as unknown,
  accountListeners: new Set<() => void>(),
  pending: [] as Array<{ resolve: (value: unknown[]) => void }>,
  runExit: null as null | ((effect: unknown) => Promise<unknown>),
}));
// The account is an external store so a change re-renders the dialog, as the relay session atom does.
vi.mock(import("../../cloud/useRelayAccount"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.accountListeners.add(listener);
    return () => state.accountListeners.delete(listener);
  };
  const read = () => state.current;
  return {
    ...(await original()),
    useRelayAccount: (() => useSyncExternalStore(subscribe, read, read)) as never,
  };
});
vi.mock(import("../../cloud/relaySession"), async (original) => ({
  ...(await original()),
  signOutOfRelay: null as never,
  deleteRelayAccount: null as never,
}));
vi.mock(import("../../lib/runtime"), async (original) => ({
  ...(await original()),
  runtime: { runPromiseExit: (effect: unknown) => state.runExit!(effect) } as never,
}));
// Not spread from the original: loading these pages' real modules alongside the runtime mock
// makes vitest fail to resolve the mocks for this file.
vi.mock(import("../clerk/T3ConnectUserProfilePage"), () => ({
  T3ConnectUserProfilePage: (() => null) as never,
}));
vi.mock(import("../clerk/MobileClientsUserProfilePage"), () => ({
  MobileClientsUserProfilePage: (() => null) as never,
}));
// The real refresh button is disabled while a load is pending; this one stays clickable so a
// second load can start before the first finishes.
vi.mock(import("../clerk/ClerkUserProfilePage"), async (original) => ({
  ...(await original()),
  ClerkUserProfileRefreshButton: (({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      Refresh
    </button>
  )) as never,
}));

import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { RelayAccountDialog } from "./RelayAccountDialog";
import { relayAccountDialogOpenAtom } from "./relayAuthDialogs";

function account(id: string) {
  return {
    isSignedIn: true,
    email: `${id}@example.test`,
    session: { accountId: id, credential: { accountId: id, refreshToken: `synthetic-${id}` } },
  };
}
function device(id: string) {
  return {
    sessionId: `session-${id}`,
    clientId: "t3-web",
    label: `Synthetic device ${id}`,
    current: false,
    lastUsedAt: "2026-10-18T12:00:00Z",
  };
}

const view = () => (
  <AppAtomRegistryProvider>
    <RelayAccountDialog />
  </AppAtomRegistryProvider>
);
const renderedText = () => document.body.textContent ?? "";
async function resolve(index: number, entries: unknown[]) {
  await act(async () => {
    state.pending[index]!.resolve(entries);
  });
}
async function switchAccount(id: string) {
  await act(() => {
    state.current = account(id);
    for (const listener of state.accountListeners) listener();
  });
}

// Opens the dialog for "old-account". Each runtime call stays pending until the test resolves it
// by index. Dispose closes the dialog.
function setup(): Disposable {
  state.accountListeners.clear();
  state.pending = [];
  appAtomRegistry.set(relayAccountDialogOpenAtom, true);
  state.current = account("old-account");
  state.runExit = () =>
    new Promise((complete) => {
      state.pending.push({ resolve: (value) => complete({ _tag: "Success", value }) });
    });
  return { [Symbol.dispose]: () => appAtomRegistry.set(relayAccountDialogOpenAtom, false) };
}

describe("signed-in device listing", () => {
  it("ignores an old account's delayed device listing", async () => {
    using _setup = setup();
    await using _screen = await render(view());
    await switchAccount("new-account");
    await resolve(1, [device("new-account")]);
    await resolve(0, [device("old-account")]);
    expect(renderedText()).toContain("new-account@example.test");
    expect(renderedText()).not.toContain("Synthetic device old-account");
    expect(renderedText()).toContain("Synthetic device new-account");
  });

  it("clears the previous identity's devices before the next load completes", async () => {
    using _setup = setup();
    await using _screen = await render(view());
    await resolve(0, [device("old-account")]);
    expect(renderedText()).toContain("Synthetic device old-account");
    await switchAccount("new-account");
    expect(renderedText()).not.toContain("Synthetic device old-account");
    expect(state.pending).toHaveLength(2);
  });

  it("ignores an obsolete load for the same identity", async () => {
    using _setup = setup();
    await using _screen = await render(view());
    await userEvent.click(page.getByRole("button", { name: "Refresh" }));
    await resolve(1, [device("latest")]);
    await resolve(0, [device("obsolete")]);
    expect(renderedText()).toContain("Synthetic device latest");
    expect(renderedText()).not.toContain("Synthetic device obsolete");
  });

  it("does not reload an old identity after its pending revoke finishes", async () => {
    using _setup = setup();
    await using _screen = await render(view());
    await resolve(0, [device("old-account")]);
    await userEvent.click(page.getByRole("listitem").getByRole("button", { name: "Sign out" }));
    await switchAccount("new-account");
    await resolve(2, [device("new-account")]);
    await resolve(1, []);
    expect(state.pending).toHaveLength(3);
    expect(renderedText()).toContain("Synthetic device new-account");
    expect(renderedText()).not.toContain("Synthetic device old-account");
  });
});
