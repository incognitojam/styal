import * as Exit from "effect/Exit";
import { runtime } from "../../lib/runtime";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  cleanUpCloudRelayAccount,
  activateCloudRelayAccount,
  deactivateCloudRelayAccount,
} from "./CloudAuthProvider";
import { setAgentAwarenessRelayCredential } from "../agent-awareness/remoteRegistration";

vi.mock("@clerk/expo", () => ({
  ClerkProvider: vi.fn(),
  getClerkInstance: vi.fn(),
  useAuth: vi.fn(),
  useClerk: vi.fn(),
}));

vi.mock("./relaySessionStore", () => ({
  publishRelaySignIn: vi.fn(),
  relaySignInAtom: {},
}));

vi.mock("./relaySession", () => ({
  adoptClerkSession: vi.fn(),
  failClerkAdoption: vi.fn(),
  finishClerkAdoptionSignedOut: vi.fn(),
  restoreRelaySession: vi.fn(),
  setLegacyClerkSignOut: vi.fn(),
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn() },
}));

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: vi.fn(async () => undefined),
}));

vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: vi.fn(() => ({
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  hasLegacyClerkConfig: vi.fn(() => false),
  resolveRelayClerkTokenOptions: vi.fn(),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  releaseAgentAwarenessRelayCredential: vi.fn(),
  setAgentAwarenessRelayCredential: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

const session = {
  accountId: "account-1",
  email: "someone@example.com",
  credential: { accountId: "account-1", refreshToken: "styal_rt_session_secret" },
};

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
