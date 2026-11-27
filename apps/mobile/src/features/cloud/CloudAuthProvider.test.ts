import * as Exit from "effect/Exit";
import { runtime } from "../../lib/runtime";
import {
  managedRelayAuthLoadAtom,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay-session";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  activateCloudRelayAccount,
  cleanUpCloudRelayAccount,
  cloudAccountService,
  deactivateCloudRelayAccount,
  relaySignInSource,
} from "./cloudAccountService";
import { setAgentAwarenessRelayCredential } from "../agent-awareness/remoteRegistration";
import { requestConnectOnboarding } from "./connectOnboarding";
import { publishRelaySignIn, relaySignInAtom } from "./relaySessionStore";
import { restoreCloudComposerDrafts } from "../../state/use-composer-drafts";

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "after-first-unlock-this-device-only",
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("./connectOnboarding", () => ({
  clearConnectOnboardingRequest: vi.fn(),
  requestConnectOnboarding: vi.fn(),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: vi.fn(async () => undefined),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  releaseAgentAwarenessRelayCredential: vi.fn(),
  setAgentAwarenessRelayCredential: vi.fn(),
}));

const session = {
  accountId: "account-1",
  email: "someone@example.com",
  credential: { accountId: "account-1", refreshToken: "styal_rt_session_secret" },
};

function publish(next: typeof session | null) {
  publishRelaySignIn(
    next === null
      ? null
      : {
          version: 1,
          relayUrl: "https://relay.example.test",
          thumbprint: "test-key",
          accountId: next.accountId,
          email: next.email,
          refreshToken: next.credential.refreshToken,
        },
  );
}

afterEach(() => {
  appAtomRegistry.set(relaySignInAtom, { status: "loading" });
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("resets cached relay access tokens even if the draft archive fails", async () => {
    vi.mocked(runtime.runPromiseExit).mockResolvedValue(Exit.succeed(undefined));
    const archiveError = new Error("Draft archive is unreadable");
    await expect(
      cleanUpCloudRelayAccount(async () => {
        throw archiveError;
      }),
    ).rejects.toBe(archiveError);
    expect(runtime.runPromiseExit).toHaveBeenCalledTimes(1);
  });

  it("publishes the session to relay requests and device registration, and clears both", () => {
    activateCloudRelayAccount(session);
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toEqual(session);
    expect(vi.mocked(setAgentAwarenessRelayCredential)).toHaveBeenLastCalledWith(
      session.credential,
    );

    deactivateCloudRelayAccount();

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayCredential)).toHaveBeenLastCalledWith(null);
  });
});

describe("cloudAccountService", () => {
  it("cleans up an authoritative signed-out restore before a fresh sign-in", async () => {
    vi.mocked(runtime.runPromiseExit).mockResolvedValue(Exit.succeed(undefined));
    appAtomRegistry.set(managedRelayAuthLoadAtom, "loading");
    using _detach = { [Symbol.dispose]: cloudAccountService.attach(relaySignInSource) };
    publish(null);
    await vi.waitFor(() => expect(cloudAccountService.getState()._tag).toBe("SignedOut"));
    expect(appAtomRegistry.get(managedRelayAuthLoadAtom)).toBe("loaded");
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    await vi.waitFor(() => expect(runtime.runPromiseExit).toHaveBeenCalled());
    publish(session);
    await vi.waitFor(() => expect(cloudAccountService.getState()._tag).toBe("Active"));
    expect(requestConnectOnboarding).toHaveBeenCalledWith(session.accountId);
  });

  it("activates the signed-in account once its drafts are restored", async () => {
    publish(session);
    using _detach = { [Symbol.dispose]: cloudAccountService.attach(relaySignInSource) };

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    await vi.waitFor(() => expect(appAtomRegistry.get(managedRelaySessionAtom)).toEqual(session));
    expect(vi.mocked(restoreCloudComposerDrafts)).toHaveBeenCalledWith("account-1");
    // The account was already signed in when observation started, so this is not a fresh sign-in.
    expect(vi.mocked(requestConnectOnboarding)).not.toHaveBeenCalled();
  });

  it("does not treat loading the saved sign-in as a sign-out", async () => {
    using _detach = { [Symbol.dispose]: cloudAccountService.attach(relaySignInSource) };

    expect(cloudAccountService.getState()._tag).toBe("Unobserved");
    publish(session);
    await vi.waitFor(() => expect(cloudAccountService.getState()._tag).toBe("Active"));
    expect(runtime.runPromiseExit).not.toHaveBeenCalled();
  });

  it("uses a new sign-in of the active account without cleaning up its data", async () => {
    vi.mocked(runtime.runPromiseExit).mockResolvedValue(Exit.succeed(undefined));
    publish(session);
    using _detach = { [Symbol.dispose]: cloudAccountService.attach(relaySignInSource) };
    await vi.waitFor(() => expect(cloudAccountService.getState()._tag).toBe("Active"));

    const nextSession = {
      ...session,
      credential: { accountId: "account-1", refreshToken: "styal_rt_second_session" },
    };
    publish(nextSession);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toEqual(nextSession);
    expect(vi.mocked(setAgentAwarenessRelayCredential)).toHaveBeenLastCalledWith(
      nextSession.credential,
    );
    expect(runtime.runPromiseExit).not.toHaveBeenCalled();
  });

  it("retries a failed activation on foreground without a new saved-session emission", async () => {
    vi.mocked(restoreCloudComposerDrafts).mockRejectedValueOnce(new Error("Storage busy."));
    appAtomRegistry.set(managedRelayAuthLoadAtom, "loading");
    publish(session);
    using _detach = { [Symbol.dispose]: cloudAccountService.attach(relaySignInSource) };

    await vi.waitFor(() => expect(cloudAccountService.getState()._tag).toBe("Failed"));
    expect(appAtomRegistry.get(managedRelayAuthLoadAtom)).toBe("loaded");
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();

    publish(session);
    expect(cloudAccountService.getState()._tag).toBe("Failed");
    cloudAccountService.retry();
    await vi.waitFor(() => expect(appAtomRegistry.get(managedRelaySessionAtom)).toEqual(session));
  });
});
