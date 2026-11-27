import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthAdministrativeClientScopes,
  AuthRelayConfigureScope,
  EnvironmentId,
  type EnvironmentCloudLinkStateResult,
} from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay-session";
import {
  RelayEnvironmentLinkLimitExceededError,
  type RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const testState = vi.hoisted(() => ({
  scopes: new Set<string>(),
  snapshot: null as EnvironmentCloudLinkStateResult | null,
  renderedSnapshot: null as EnvironmentCloudLinkStateResult | null,
  relayProviderKind: null as RelayManagedEndpointProviderKind | null,
  getCredential: vi.fn<() => { accountId: string; refreshToken: string } | null>(),
  link: vi.fn(),
  unlink: vi.fn(),
  preferences: vi.fn(),
  refreshDiscovery: vi.fn(),
  refreshLink: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({
    environments: new Map(
      testState.relayProviderKind === null
        ? []
        : [
            [
              "service",
              { environment: { endpoint: { providerKind: testState.relayProviderKind } } },
            ],
          ],
    ),
  })) as never,
}));
vi.mock(import("./useRelayAccount"), () => ({
  useRelayAccount: () =>
    ({
      isLoaded: true,
      isSignedIn: true,
      session: {
        get credential() {
          return testState.getCredential();
        },
      },
    }) as never,
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } as never };
});
vi.mock(import("../state/relay"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    relayEnvironmentDiscovery: {
      ...actual.relayEnvironmentDiscovery,
      refresh: testState.refreshDiscovery,
    } as never,
  };
});
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (_environmentId, scope) => testState.scopes.has(scope),
  readEnvironmentCanConfigureRelay: () => testState.scopes.has(AuthRelayConfigureScope),
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("./linkEnvironmentAtoms"), async (original) => ({
  ...(await original()),
  linkEnvironment: testState.link as never,
  unlinkEnvironment: testState.unlink as never,
  updateEnvironmentPreferences: testState.preferences as never,
}));
vi.mock(import("./cloudLinkState"), async (original) => ({
  ...(await original()),
  readCachedCloudLinkState: () => testState.snapshot,
  useCloudLinkState: ((environmentId: EnvironmentId | null) => ({
    target: environmentId === null ? null : { environmentId },
    data: testState.renderedSnapshot,
    error: null,
    isPending: false,
    refresh: testState.refreshLink,
  })) as never,
}));

import { CloudEnvironmentLinkError } from "./linkEnvironment";
import { useCloudLinkController, type CloudLinkDesiredState } from "./useCloudLinkController";

const target = { environmentId: EnvironmentId.make("service") };
const linkedState: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "account-1",
  relayUrl: "https://relay.example.com",
  relayIssuer: "https://relay.example.com",
  managedTunnelActive: true,
  publishAgentActivity: false,
};

type Controller = ReturnType<typeof useCloudLinkController>;

function ControllerProbe({ onRender }: { onRender: (controller: Controller) => void }) {
  const value = useCloudLinkController(target.environmentId);
  useLayoutEffect(() => {
    onRender(value);
  });
  return null;
}

async function mountController() {
  let controller: Controller | null = null;
  const screen = await render(
    <ControllerProbe
      onRender={(value) => {
        controller = value;
      }}
    />,
  );
  return Object.assign(screen, {
    // Object.assign would copy a getter's value once, so read the latest render through a function.
    controller: () => controller,
    async reconcile(desired: CloudLinkDesiredState) {
      let succeeded = false;
      await act(async () => {
        if (controller === null) throw new Error("Controller is not mounted.");
        succeeded = await controller.reconcileCloudState(desired);
      });
      return succeeded;
    },
  });
}

function expectNoMutations() {
  expect(testState.link).not.toHaveBeenCalled();
  expect(testState.unlink).not.toHaveBeenCalled();
  expect(testState.preferences).not.toHaveBeenCalled();
}

function setup() {
  testState.scopes = new Set(AuthAdministrativeClientScopes);
  testState.snapshot = linkedState;
  testState.renderedSnapshot = linkedState;
  testState.relayProviderKind = null;
  testState.getCredential
    .mockReset()
    .mockReturnValue({ accountId: "account-1", refreshToken: "synthetic-refresh" });
  for (const command of [
    testState.link,
    testState.unlink,
    testState.preferences,
    testState.refreshDiscovery,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success({}));
  }
  testState.refreshLink.mockReset();
  testState.toast.mockReset();
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("useCloudLinkController", () => {
  it.each([AuthRelayReadScope, AuthRelayWriteScope])(
    "does not mutate without %s, even with a cached link snapshot",
    async (scope) => {
      using _setup = setup();
      await using screen = await mountController();
      testState.scopes.delete(scope);

      expect(await screen.reconcile({ managedTunnel: true, publish: true })).toBe(false);
      expectNoMutations();
    },
  );

  it("does not interpret unavailable link state as an unlinked environment", async () => {
    using _setup = setup();
    testState.snapshot = null;
    await using screen = await mountController();

    expect(await screen.reconcile({ managedTunnel: false, publish: true })).toBe(false);
    expectNoMutations();
  });

  it.each([AuthRelayReadScope, AuthRelayWriteScope])(
    "rechecks %s after reading the relay credential",
    async (scope) => {
      using _setup = setup();
      await using screen = await mountController();
      testState.getCredential.mockImplementationOnce(() => {
        testState.scopes.delete(scope);
        return { accountId: "account-1", refreshToken: "synthetic-refresh" };
      });

      expect(await screen.reconcile({ managedTunnel: false, publish: false })).toBe(false);
      expectNoMutations();
    },
  );

  it("stops if the link-state read fails while reading the relay credential", async () => {
    using _setup = setup();
    await using screen = await mountController();
    testState.getCredential.mockImplementationOnce(() => {
      testState.snapshot = null;
      return { accountId: "account-1", refreshToken: "synthetic-refresh" };
    });

    expect(await screen.reconcile({ managedTunnel: true, publish: true })).toBe(false);
    expectNoMutations();
  });

  it("still lets an authorized user unlink when the relay credential is unavailable", async () => {
    using _setup = setup();
    await using screen = await mountController();
    testState.getCredential.mockReturnValueOnce(null);

    expect(await screen.reconcile({ managedTunnel: false, publish: false })).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, credential: null });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
  });

  it("reports a relay tunnel cap refusal as tunnelLimit instead of an error", async () => {
    using _setup = setup();
    testState.snapshot = { ...linkedState, linked: false, managedTunnelActive: false };
    testState.link.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new CloudEnvironmentLinkError({
            message: "environment-links failed",
            cause: new ManagedRelay.ManagedRelayRequestFailedError({
              action: "link relay environment",
              cause: null,
              relayError: new RelayEnvironmentLinkLimitExceededError({
                code: "environment_link_limit_exceeded",
                maxTunnels: 3,
                traceId: "trace-1",
              }),
            }),
          }),
        ),
      ),
    );
    await using screen = await mountController();

    expect(await screen.reconcile({ managedTunnel: true, publish: false })).toBe(false);
    expect(screen.controller()?.tunnelLimit).toBe(3);
    expect(screen.controller()?.operationError).toBeNull();
    expect(testState.toast).not.toHaveBeenCalled();
  });
});
