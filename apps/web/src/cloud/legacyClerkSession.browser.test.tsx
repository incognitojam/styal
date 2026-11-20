import { managedRelayAuthLoadAtom, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  clerk: { signOut: vi.fn(async () => undefined) },
  useAuth: vi.fn(() => ({ isLoaded: true, isSignedIn: true, getToken: vi.fn() })),
  allowed: vi.fn(async () => false),
  exchange: vi.fn(),
  getToken: vi.fn(async () => "clerk-token"),
  runExchange: vi.fn(async () => ({ _tag: "Success" })),
}));
// Not spread from the original: loading the Clerk SDK is not needed for these tests.
vi.mock(import("@clerk/react"), () => ({
  ClerkProvider: (({ children }: import("react").PropsWithChildren) => children) as never,
  useAuth: state.useAuth as never,
  useClerk: (() => state.clerk) as never,
}));
vi.mock(import("../hostedPairing"), async (original) => ({
  ...(await original()),
  isHostedStaticApp: () => true,
}));
vi.mock(import("./publicConfig"), async (original) => ({
  ...(await original()),
  hasLegacyClerkConfig: () => true,
  resolveCloudPublicConfig: (() => ({ clerkPublishableKey: "synthetic-publishable-key" })) as never,
  resolveRelayClerkTokenOptions: (() => ({})) as never,
}));
vi.mock(import("./relaySession"), async (original) => ({
  ...(await original()),
  adoptClerkSession: state.exchange as never,
  setLegacyClerkSignOut: vi.fn(),
}));
vi.mock(import("../lib/runtime"), async (original) => ({
  ...(await original()),
  runtime: { runPromise: state.allowed, runPromiseExit: state.runExchange } as never,
}));

import BrowserManagedAuthShell from "../components/clerk/BrowserManagedAuthShell";
import { appAtomRegistry } from "../rpc/atomRegistry";

// main.tsx mounts the shell outside AppRoot and its registry provider, so this does too.
function mount() {
  return render(
    <BrowserManagedAuthShell publishableKey="synthetic-publishable-key">
      <p>Authorize CLI</p>
    </BrowserManagedAuthShell>,
    { router: false },
  );
}

// The component reads window.location.pathname, so each test moves the test page's URL
// with history.replaceState. Dispose restores the URL and the stubbed env.
function setup(pathname: string): Disposable {
  const previous = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", pathname);
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
  return {
    [Symbol.dispose]: () => {
      window.history.replaceState(window.history.state, "", previous);
      vi.unstubAllEnvs();
    },
  };
}

describe("legacy CLI authorization", () => {
  it("keeps Clerk sign-in intact on hosted /connect", async () => {
    using _setup = setup("/connect");
    await using screen = await mount();
    expect(state.useAuth).not.toHaveBeenCalled();
    expect(state.allowed).not.toHaveBeenCalled();
    expect(state.clerk.signOut).not.toHaveBeenCalled();
    await expect.element(screen.getByText("Authorize CLI")).toBeInTheDocument();
  });

  it("also excludes hosted /connect-agent", async () => {
    using _setup = setup("/connect-agent");
    await using _screen = await mount();
    expect(state.useAuth).not.toHaveBeenCalled();
    expect(state.clerk.signOut).not.toHaveBeenCalled();
  });

  it("continues retirement cleanup on ordinary app routes", async () => {
    using _setup = setup("/");
    await using _screen = await mount();
    expect(state.useAuth).toHaveBeenCalled();
    expect(state.allowed).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(state.clerk.signOut).toHaveBeenCalledOnce());
  });

  it.each(["insecure origin", "missing WebCrypto"])("skips adoption on %s", async (reason) => {
    using _setup = setup("/");
    state.allowed.mockResolvedValue(true);
    using _global =
      reason === "insecure origin"
        ? stubGlobal("isSecureContext", false)
        : stubGlobal("crypto", {});

    await using _screen = await mount();

    expect(state.allowed).not.toHaveBeenCalled();
    expect(state.getToken).not.toHaveBeenCalled();
    expect(state.exchange).not.toHaveBeenCalled();
    expect(state.clerk.signOut).not.toHaveBeenCalled();
  });

  it("keeps Clerk after a failed marker read and retries on the next launch", async () => {
    using _setup = setup("/");
    state.allowed.mockRejectedValueOnce(new Error("IndexedDB temporarily unavailable"));
    {
      await using _screen = await mount();
      await vi.waitFor(() => expect(state.allowed).toHaveBeenCalledOnce());
      expect(state.clerk.signOut).not.toHaveBeenCalled();
      expect(state.getToken).not.toHaveBeenCalled();
      expect(state.exchange).not.toHaveBeenCalled();
    }

    state.allowed.mockResolvedValue(true);
    await using _screen = await mount();

    await vi.waitFor(() => expect(state.runExchange).toHaveBeenCalledOnce());
    expect(state.allowed).toHaveBeenCalledTimes(2);
    expect(state.getToken).toHaveBeenCalledOnce();
    expect(state.exchange).toHaveBeenCalledWith("clerk-token");
  });
});
