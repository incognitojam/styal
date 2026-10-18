import { managedRelayAuthLoadAtom, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({ removeEnvironments: vi.fn(async () => ({ _tag: "Success" })) }));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.removeEnvironments) as never,
}));
vi.mock(import("../connection/catalog"), () => ({
  environmentCatalog: { removeRelayEnvironments: {} } as never,
}));
vi.mock(import("../lib/runtime"), async (original) => ({
  ...(await original()),
  runtime: { runPromiseExit: vi.fn(async () => ({ _tag: "Success" })) } as never,
}));
vi.mock(import("./relaySession"), async (original) => ({
  ...(await original()),
  restoreRelaySession: vi.fn(async () => undefined),
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { ManagedRelayAuthProvider } from "./managedAuth";

describe("ManagedRelayAuthProvider", () => {
  it("removes relay environments when the account signs out, mounted outside AppRoot", async () => {
    state.removeEnvironments.mockClear();
    appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
    appAtomRegistry.set(managedRelaySessionAtom, {
      accountId: "account-1",
      email: null,
      credential: { accountId: "account-1", refreshToken: "styal_rt_synthetic" },
    });
    await using _screen = await render(
      <ManagedRelayAuthProvider>
        <p>App</p>
      </ManagedRelayAuthProvider>,
      { router: false },
    );
    expect(state.removeEnvironments).not.toHaveBeenCalled();

    act(() => appAtomRegistry.set(managedRelaySessionAtom, null));

    await vi.waitFor(() => expect(state.removeEnvironments).toHaveBeenCalledOnce());
  });
});
