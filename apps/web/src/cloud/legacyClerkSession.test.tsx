import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { managedRelayAuthLoadAtom, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  clerk: { signOut: vi.fn(async () => undefined) },
  useAuth: vi.fn(() => ({ isLoaded: true, isSignedIn: true, getToken: vi.fn() })),
  allowed: vi.fn(async () => false),
  exchange: vi.fn(),
  getToken: vi.fn(async () => "clerk-token"),
  runExchange: vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: import("react").PropsWithChildren) => children,
  useAuth: state.useAuth,
  useClerk: () => state.clerk,
}));
vi.mock("../hostedPairing", () => ({ isHostedStaticApp: () => true }));
vi.mock("./publicConfig", () => ({
  trimNonEmpty: (value: string | undefined) => value?.trim() || null,
  hasLegacyClerkConfig: () => true,
  resolveCloudPublicConfig: () => ({ clerkPublishableKey: "synthetic-publishable-key" }),
  resolveRelayClerkTokenOptions: () => ({}),
}));
vi.mock("./relaySession", () => ({
  adoptClerkSession: state.exchange,
  setLegacyClerkSignOut: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({
  runtime: { runPromise: state.allowed, runPromiseExit: state.runExchange },
}));

import BrowserManagedAuthShell from "../components/clerk/BrowserManagedAuthShell";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";

let renderer: ReactTestRenderer;
async function mount() {
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <BrowserManagedAuthShell publishableKey="synthetic-publishable-key">
          <p>Authorize CLI</p>
        </BrowserManagedAuthShell>
      </AppAtomRegistryProvider>,
    );
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("window", { location: { pathname: "/" }, isSecureContext: true });
  vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "synthetic-cli-app");
  state.clerk.signOut.mockClear();
  state.getToken.mockReset().mockResolvedValue("clerk-token");
  state.useAuth.mockReset().mockImplementation(() => ({
    isLoaded: true,
    isSignedIn: true,
    getToken: state.getToken,
  }));
  state.allowed.mockReset().mockResolvedValue(false);
  state.exchange.mockReset();
  state.runExchange.mockClear();
  appAtomRegistry.set(managedRelaySessionAtom, null);
  appAtomRegistry.set(managedRelayAuthLoadAtom, "loaded");
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("legacy CLI authorization", () => {
  it("keeps Clerk sign-in intact on hosted /connect", async () => {
    window.location.pathname = "/connect";
    await mount();
    expect(state.useAuth).not.toHaveBeenCalled();
    expect(state.allowed).not.toHaveBeenCalled();
    expect(state.clerk.signOut).not.toHaveBeenCalled();
    expect(renderer.root.findByType("p").children).toEqual(["Authorize CLI"]);
  });

  it("also excludes hosted /connect-agent", async () => {
    window.location.pathname = "/connect-agent";
    await mount();
    expect(state.useAuth).not.toHaveBeenCalled();
    expect(state.clerk.signOut).not.toHaveBeenCalled();
  });

  it("continues retirement cleanup on ordinary app routes", async () => {
    await mount();
    expect(state.useAuth).toHaveBeenCalled();
    expect(state.allowed).toHaveBeenCalledOnce();
    expect(state.clerk.signOut).toHaveBeenCalledOnce();
  });

  it.each(["insecure origin", "missing WebCrypto"])("skips adoption on %s", async (reason) => {
    state.allowed.mockResolvedValue(true);
    if (reason === "insecure origin")
      vi.stubGlobal("window", { location: { pathname: "/" }, isSecureContext: false });
    else vi.stubGlobal("crypto", {});

    await mount();

    expect(state.allowed).not.toHaveBeenCalled();
    expect(state.getToken).not.toHaveBeenCalled();
    expect(state.exchange).not.toHaveBeenCalled();
    expect(state.clerk.signOut).not.toHaveBeenCalled();
  });

  it("keeps Clerk after a failed marker read and retries on the next launch", async () => {
    state.allowed.mockRejectedValueOnce(new Error("IndexedDB temporarily unavailable"));
    await mount();
    expect(state.clerk.signOut).not.toHaveBeenCalled();
    expect(state.getToken).not.toHaveBeenCalled();
    expect(state.exchange).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
    state.allowed.mockResolvedValue(true);
    await mount();

    expect(state.allowed).toHaveBeenCalledTimes(2);
    expect(state.getToken).toHaveBeenCalledOnce();
    expect(state.exchange).toHaveBeenCalledWith("clerk-token");
    expect(state.runExchange).toHaveBeenCalledOnce();
  });
});
