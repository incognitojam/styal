import { type Discovery } from "@t3tools/client-runtime/relay";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

type DiscoveredEnvironments = Discovery.RelayEnvironmentDiscoveryState["environments"];

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  listeners: new Set<() => void>(),
  refresh: vi.fn<() => Promise<AtomCommandResult<void, never>>>(),
  register: vi.fn(),
  listEnvironments: vi.fn<() => Promise<DiscoveredEnvironments>>(),
}));

vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { relayEnvironmentDiscovery } = await import("~/state/relay");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === relayEnvironmentDiscovery.refresh
        ? discovery.refresh
        : discovery.register) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    discovery.listeners.add(listener);
    return () => discovery.listeners.delete(listener);
  };
  const read = () => {
    if (discovery.state === null) throw new Error("Discovery fixture is not initialized");
    return discovery.state;
  };
  return {
    ...(await original()),
    useRelayEnvironmentDiscovery: () => useSyncExternalStore(subscribe, read, read),
  };
});

import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";

const newMachineId = EnvironmentId.make("new-computer");
const linkedMachines: DiscoveredEnvironments = new Map([
  [
    newMachineId,
    {
      environment: {
        environmentId: newMachineId,
        label: "Work laptop",
        endpoint: {
          httpBaseUrl: "https://relay.example.test",
          wsBaseUrl: "wss://relay.example.test/ws",
          providerKind: "manual",
        },
        linkedAt: "2026-09-05T12:00:00.000Z",
      },
      availability: "online",
      status: Option.none(),
      error: Option.none(),
    },
  ],
]);

let container: HTMLDivElement;
let visibility: DocumentVisibilityState;

function publish(state: Discovery.RelayEnvironmentDiscoveryState) {
  discovery.state = state;
  for (const listener of discovery.listeners) listener();
}

const renderRows = (element: ReactElement) => render(element, { container });

function setup() {
  using stack = new DisposableStack();
  stack.use(fakeTimers());
  visibility = "visible";
  stack.use(vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility));
  container = document.createElement("div");
  discovery.listeners.clear();
  discovery.state = {
    environments: new Map(),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.listEnvironments.mockReset().mockResolvedValue(new Map());
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  discovery.refresh.mockReset().mockImplementation(async () => {
    publish({ environments: new Map(), refreshing: true, offline: false, error: Option.none() });
    const environments = await discovery.listEnvironments();
    publish({ environments, refreshing: false, offline: false, error: Option.none() });
    return AsyncResult.success(undefined);
  });
  return stack.move();
}

describe("cloud onboarding discovery", () => {
  it("waits for selection before connecting and preserves deselection across discovery refreshes", async () => {
    using _environment = setup();
    const offlineMachineId = EnvironmentId.make("offline-computer");
    const onlineMachine = linkedMachines.get(newMachineId)!;
    const machines: DiscoveredEnvironments = new Map([
      ...linkedMachines,
      [
        offlineMachineId,
        {
          ...onlineMachine,
          environment: {
            ...onlineMachine.environment,
            environmentId: offlineMachineId,
            label: "Home desktop",
          },
          availability: "offline",
        },
      ],
    ]);
    discovery.listEnvironments.mockResolvedValue(machines);
    function Setup() {
      const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId>>(new Set());
      return (
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={[]}
          showSavedEnvironments
          selection={{
            selectedIds,
            onChange: (id, checked) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              }),
          }}
        />
      );
    }
    await using _screen = await renderRows(<Setup />);

    expect(discovery.register).not.toHaveBeenCalled();
    const checkboxes = () => [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')];
    const checkedStates = () =>
      checkboxes().map((element) => element.getAttribute("aria-checked") === "true");
    expect(checkedStates()).toEqual([false, false]);
    await act(async () => checkboxes()[0]!.click());
    expect(discovery.register).toHaveBeenCalledTimes(1);
    expect(discovery.register.mock.calls[0]![0].target.environmentId).toBe(newMachineId);
    expect(checkedStates()).toEqual([true, false]);
    await act(async () => checkboxes()[0]!.click());
    await act(async () => {
      publish({ ...discovery.state!, environments: new Map(machines) });
    });
    expect(checkedStates()).toEqual([false, false]);
    expect(discovery.register).toHaveBeenCalledTimes(1);
  });
});
