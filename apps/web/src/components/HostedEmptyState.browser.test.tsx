import type { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

type DiscoveredEnvironments = Discovery.RelayEnvironmentDiscoveryState["environments"];
type Availability = "checking" | "online";

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  listeners: new Set<() => void>(),
  register: vi.fn(),
}));

vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => ({ isLoaded: true, isSignedIn: true })) as never,
}));
vi.mock(import("./clerk/useT3ConnectAuthPrompt"), () => ({
  useT3ConnectAuthPrompt: () => ({ authPrompt: null, openAuthPrompt: vi.fn() }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { relayEnvironmentDiscovery } = await import("~/state/relay");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === relayEnvironmentDiscovery.refresh
        ? async () => AsyncResult.success(undefined)
        : discovery.register) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    discovery.listeners.add(listener);
    return () => discovery.listeners.delete(listener);
  };
  const read = () => discovery.state!;
  return {
    ...(await original()),
    useRelayEnvironmentDiscovery: () => useSyncExternalStore(subscribe, read, read),
  };
});

import { T3ConnectSteps } from "./HostedEmptyState";

const laptopId = EnvironmentId.make("laptop");
const desktopId = EnvironmentId.make("desktop");

function linked(availability: Record<string, Availability>): DiscoveredEnvironments {
  return new Map(
    [laptopId, desktopId].map((environmentId) => [
      environmentId,
      {
        environment: {
          environmentId,
          label: environmentId,
          endpoint: {
            httpBaseUrl: "https://relay.example.test",
            wsBaseUrl: "wss://relay.example.test/ws",
            providerKind: "manual",
          },
          linkedAt: "2026-10-19T12:00:00.000Z",
        },
        availability: availability[environmentId]!,
        status: Option.none(),
        error: Option.none(),
      },
    ]),
  );
}

async function publish(environments: DiscoveredEnvironments) {
  discovery.state = { environments, refreshing: false, offline: false, error: Option.none() };
  await act(async () => {
    for (const listener of discovery.listeners) listener();
  });
}

const registeredIds = () =>
  discovery.register.mock.calls.map(([registration]) => registration.target.environmentId);

function setup() {
  discovery.listeners.clear();
  discovery.state = {
    environments: new Map(),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
}

// The fork connects a linked computer only when the user selects it.
it("adds a linked computer only when it is selected", async () => {
  setup();
  await using screen = await render(<T3ConnectSteps />);

  await publish(linked({ [laptopId]: "checking", [desktopId]: "checking" }));
  await publish(linked({ [laptopId]: "online", [desktopId]: "online" }));
  expect(discovery.register).not.toHaveBeenCalled();

  const laptopCheckbox = [...screen.container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes(laptopId))
    ?.querySelector<HTMLElement>('[role="checkbox"]');
  expect(laptopCheckbox).toBeTruthy();
  await act(async () => laptopCheckbox!.click());
  expect(registeredIds()).toEqual([laptopId]);
});
