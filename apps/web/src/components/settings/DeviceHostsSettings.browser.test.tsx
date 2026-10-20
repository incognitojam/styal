import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";

const { update } = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "update-settings" ? update : vi.fn()),
}));
vi.mock("~/state/server", async (original) => {
  const actual = await original<typeof import("~/state/server")>();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, updateSettings: "update-settings" },
  };
});
vi.mock("~/state/device", () => ({
  deviceEnvironment: { list: "list", testHost: "test-host" },
  useDeviceState: () => ({ state: { hosts: [], hostStatuses: {} }, loaded: true }),
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("./SettingsScopeContext", async (original) => ({
  ...(await original<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    environment: {
      environmentId,
      label: "Build server",
      displayUrl: null,
      serverConfig: { settings: { ...DEFAULT_SERVER_SETTINGS, deviceHosts: hosts } },
    },
  }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SettingsRow: ({ children }: { children?: ReactNode }) => children,
}));

import { DeviceHostsSettings } from "./DeviceHostsSettings";

const environmentId = EnvironmentId.make("build-server");
let hosts: SshDeviceHostConfig[];

function setup() {
  hosts = [];
  update.mockReset().mockImplementation(async (command) => {
    hosts = command.input.patch.deviceHosts;
    return { _tag: "Success", value: undefined };
  });
}

it("hides empty SSH setup and edits then removes a saved host on its owning environment", async () => {
  setup();
  await using screen = await render(<DeviceHostsSettings environmentId={environmentId} />);
  const { container } = screen;
  expect(container.textContent).toBe("");
  hosts = [
    {
      kind: "ssh",
      id: "saved-host",
      label: "Simulator host",
      target: "builder@device.example.test",
    },
  ];
  await screen.rerender(<DeviceHostsSettings environmentId={environmentId} />);
  const section = container.querySelector("button")!;
  expect(section.textContent).toContain("Existing SSH device hosts");
  await userEvent.click(section);
  const options = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Simulator host options"]',
  )!;
  await userEvent.click(options);
  const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Edit",
  )!;
  await userEvent.click(edit);
  await userEvent.fill(
    document.querySelector<HTMLInputElement>('input[placeholder="Mac mini"]')!,
    "Renamed simulator",
  );
  await page.getByRole("button", { name: "Save host", exact: true }).click();
  expect(hosts).toEqual([
    {
      kind: "ssh",
      id: "saved-host",
      label: "Renamed simulator",
      target: "builder@device.example.test",
    },
  ]);
  expect(update).toHaveBeenCalledWith({ environmentId, input: { patch: { deviceHosts: hosts } } });

  await screen.rerender(<DeviceHostsSettings environmentId={environmentId} />);
  await userEvent.click(
    container.querySelector<HTMLButtonElement>('button[aria-label="Renamed simulator options"]')!,
  );
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Remove",
  )!;
  await userEvent.click(remove);
  await screen.rerender(<DeviceHostsSettings environmentId={environmentId} />);
  expect(hosts).toEqual([]);
  expect(container.textContent).toBe("");
  expect(update).toHaveBeenLastCalledWith({ environmentId, input: { patch: { deviceHosts: [] } } });
});
