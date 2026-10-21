import { EnvironmentId, LOCAL_DEVICE_HOST_ID, type DeviceServiceState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "list" ? list : vi.fn()),
}));
vi.mock("~/state/device", () => ({
  deviceEnvironment: { list: "list", configure: "configure" },
  useDeviceState: () => ({ state: deviceState, loaded: true }),
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useUpdateScopedSettings: () => vi.fn(),
}));
// Rows resolve scope and permissions; only their controls matter here.
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsRow: ({ control, children }: { control?: ReactNode; children?: ReactNode }) => (
    <>
      {control}
      {children}
    </>
  ),
}));
// The version popover holds the Update button; render the button in place of the popover.
vi.mock("../device/DeviceToolVersions", () => ({
  DeviceToolVersions: ({ action }: { action?: ReactNode }) => action ?? null,
}));
vi.mock("./DeviceHostsSettings", () => ({ DeviceHostsSettings: () => null }));
vi.mock("./EnvironmentDeviceHostsSettings", () => ({ EnvironmentDeviceHostsSettings: () => null }));

import { DeviceIntegrationControls } from "./IntegrationsSettings";

const environmentId = EnvironmentId.make("environment-1");
const initialDeviceState = {
  supportsToolUpdate: true,
  supportsHostRetry: true,
  hosts: [
    {
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "This computer",
      platforms: [],
      tools: {
        hub: { requiredVersion: "0.12.0", installedVersions: [], runningVersion: null },
        agent: { requiredVersion: "1.0.0", installedVersions: ["1.0.0"], runningVersion: null },
      },
      hubInstalled: false,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "idle",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: false,
  hubBasePath: "/device-hub",
  revision: 1,
} satisfies DeviceServiceState;
let deviceState: DeviceServiceState;

function setup() {
  list.mockReset();
  deviceState = structuredClone(initialDeviceState);
}

it.each(["installing", "starting", "failed"] as const)(
  "keeps %s feedback visible with maintenance collapsed",
  async (status) => {
    setup();
    const detail =
      status === "failed" ? "Device tools could not install." : "Preparing device tools…";
    deviceState = {
      ...deviceState,
      hostStatus: status,
      hostStatuses: { [LOCAL_DEVICE_HOST_ID]: { status, detail } },
    };
    list.mockResolvedValue({ _tag: "Success", value: deviceState });
    await using screen = await render(
      <DeviceIntegrationControls
        environmentId={environmentId}
        enabled
        agentAccessEnabled={false}
      />,
    );
    const { container } = screen;

    const maintenance = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Device maintenance"),
    );
    expect(maintenance?.getAttribute("aria-expanded")).toBe("false");
    const feedback = [
      ...container.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]'),
    ].find((element) => element.textContent?.includes(detail));
    expect(feedback?.checkVisibility()).toBe(true);
    if (status === "failed") {
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry",
      );
      expect(retry?.checkVisibility()).toBe(true);
      await act(async () => retry!.click());
      expect(list).toHaveBeenCalledWith({
        environmentId,
        input: { retryHostId: LOCAL_DEVICE_HOST_ID },
      });
    }
  },
);
