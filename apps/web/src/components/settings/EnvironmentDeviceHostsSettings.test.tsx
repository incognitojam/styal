import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: string };
    serverConfig: { settings: unknown } | null;
  }>,
  disconnect: vi.fn(),
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: fixtures.environments }),
  useEnvironmentHttpBaseUrl: () => "https://synthetic.test",
  usePrimaryEnvironmentId: () => "atlas",
  useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
}));
vi.mock("../../state/device", () => ({
  deviceEnvironment: { disconnectEnvironment: "disconnect", connectEnvironment: "connect" },
  useDeviceState: () => ({
    loaded: true,
    state: { supportsEnvironmentHosts: true, supportsEnvironmentHostAddresses: true, hosts: [] },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => fixtures.disconnect,
}));
vi.mock("../../state/desktopNetworkAccess", () => ({ desktopNetworkAccessStateAtom: null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("~/uiStateStore", () => ({ useUiStateStore: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => ({
    scope: { kind: "all" },
    connectedEnvironments: fixtures.environments.filter(
      (entry) => entry.connection.phase === "connected",
    ),
  }),
}));

import { EnvironmentDeviceHostsSettings } from "./EnvironmentDeviceHostsSettings";
import { Switch } from "../ui/switch";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  fixtures.disconnect.mockReset();
  fixtures.environments = [
    {
      environmentId: "atlas",
      label: "Atlas",
      connection: { phase: "connected" },
      serverConfig: {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          environmentDeviceHosts: [
            {
              id: "environment-orion",
              label: "Orion",
              environmentId: "orion",
              url: "https://orion.test",
              sessionId: "synthetic-session",
            },
          ],
        },
      },
    },
  ];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("removes an offline owner's saved share with only the agent environment connected", async () => {
  fixtures.disconnect.mockImplementation(async () => {
    fixtures.environments[0]!.serverConfig = { settings: DEFAULT_SERVER_SETTINGS };
    return { _tag: "Success" };
  });
  await act(() => {
    renderer = create(<EnvironmentDeviceHostsSettings />);
  });
  const control = renderer!.root.findByType(Switch);
  expect(control.props.disabled).toBe(false);
  await act(async () => {
    control.props.onCheckedChange(false);
  });
  await act(() => {
    renderer!.update(<EnvironmentDeviceHostsSettings />);
  });
  expect(fixtures.disconnect).toHaveBeenCalledWith({
    environmentId: "atlas",
    input: { hostId: "environment-orion" },
  });
  expect(renderer!.root.findAllByType(Switch)).toHaveLength(0);
});

it("keeps the removal control available and reports a failed disconnect", async () => {
  fixtures.disconnect.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("synthetic failure")),
  });
  await act(() => {
    renderer = create(<EnvironmentDeviceHostsSettings />);
  });
  await act(async () => {
    renderer!.root.findByType(Switch).props.onCheckedChange(false);
  });
  expect(renderer!.root.findByType(Switch).props.disabled).toBe(false);
  expect(renderer!.root.findAll((entry) => entry.props.role === "status")).toHaveLength(1);
});

it("retains remote revocation guidance after the saved share is removed locally", async () => {
  const message = "Device host removed locally. Revoke the remaining grant in Connections.";
  fixtures.disconnect.mockImplementation(async () => {
    fixtures.environments[0]!.serverConfig = { settings: DEFAULT_SERVER_SETTINGS };
    return { _tag: "Failure", cause: Cause.fail(new Error(message)) };
  });
  await act(() => {
    renderer = create(<EnvironmentDeviceHostsSettings />);
  });
  await act(async () => {
    renderer!.root.findByType(Switch).props.onCheckedChange(false);
  });
  await act(() => {
    renderer!.update(<EnvironmentDeviceHostsSettings />);
  });
  expect(renderer!.root.findAllByType(Switch)).toHaveLength(0);
  expect(renderer!.root.findByProps({ role: "status" }).children).toContain(message);
});
