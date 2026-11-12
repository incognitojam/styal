import * as DateTime from "effect/DateTime";
import { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentPresentation } from "~/state/environments";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const fixture = vi.hoisted(() => ({
  machines: [] as EnvironmentPresentation[],
  links: new Map<string, unknown[]>(),
  discovered: new Map<string, { environment: { environmentId: string; label: string } }>(),
  command: vi.fn(),
  linkable: vi.fn(() => []),
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: fixture.machines })) as never,
  useRelayEnvironmentDiscovery: (() => ({ environments: fixture.discovered })) as never,
}));
vi.mock(import("~/cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => true,
}));
vi.mock(import("~/state/relay"), () => ({ relayEnvironmentDiscovery: { refresh: {} } as never }));
vi.mock(import("~/state/peerLinks"), () => ({
  peerLinkEnvironment: {
    list: ({ environmentId }: { environmentId: string }) => environmentId,
    unlink: { permissionAtom: () => false },
  } as never,
  workTogether: {} as never,
  useLinkableMachines: fixture.linkable,
}));
vi.mock(import("~/state/query"), () => ({
  useEnvironmentQuery: ((id: string | null) => ({
    data: id === null ? null : { links: fixture.links.get(id) ?? [] },
    error: null,
  })) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  usePreparedConnection: (() => ({ _tag: "None" })) as never,
}));
vi.mock(import("~/state/use-atom-command"), () => ({ useAtomCommand: () => fixture.command }));
vi.mock(import("~/state/device"), () => ({
  useDeviceState: (() => ({ settled: true, state: { supportsEnvironmentHosts: false } })) as never,
}));
vi.mock(import("./EnvironmentDeviceHostsSettings"), () => ({
  useDeviceSharingAddresses: (() => ({ addresses: [] })) as never,
}));
vi.mock(import("./EnvironmentRow"), () => ({ useEnvironmentTransportLabel: () => "styal Link" }));
vi.mock(import("../cloud/CloudEnvironmentConnectList"), () => ({
  CloudEnvironmentConnectRows: () => null,
}));

import { WorkTogetherSettings } from "./WorkTogetherSettings";

function machine(id: string, label: string): EnvironmentPresentation {
  return {
    environmentId: EnvironmentId.make(id),
    label,
    entry: { enabled: true, target: { _tag: "PrimaryConnectionTarget", label } },
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        label,
        platform: { machine: "desktop", os: "linux", arch: "x64" },
        capabilities: { peerLinks: true },
      },
      settings: { linkedEnvironmentsEnabled: true, environmentDeviceHosts: [] },
    },
  } as unknown as EnvironmentPresentation;
}

it("deduplicates tab machines from links and adds from the selected machine", async () => {
  const alpha = machine("alpha", "Alpha");
  const beta = machine("beta", "Beta");
  fixture.machines = [alpha, beta];
  fixture.command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  fixture.links = new Map([
    [
      "alpha",
      [
        {
          environmentId: beta.environmentId,
          label: "Beta",
          status: "reachable",
          expiresAt: DateTime.makeUnsafe("2030-01-01"),
          urls: [],
          access: "full",
        },
        {
          environmentId: EnvironmentId.make("gamma"),
          label: "Gamma",
          status: "reachable",
          expiresAt: DateTime.makeUnsafe("2030-01-01"),
          urls: [],
          access: "full",
        },
      ],
    ],
  ]);
  fixture.discovered = new Map([
    [beta.environmentId, { environment: { environmentId: beta.environmentId, label: "Beta" } }],
    [
      EnvironmentId.make("gamma"),
      { environment: { environmentId: EnvironmentId.make("gamma"), label: "Gamma" } },
    ],
  ]);
  await using screen = await render(
    <WorkTogetherSettings
      listedEnvironments={[beta]}
      primaryEnvironment={alpha}
      localSetting={null}
      headerAction={null}
      renderConnectionRow={() => null}
    />,
  );
  await expect.poll(() => screen.getByRole("tab").all().length).toBe(3);
  await expect.poll(() => screen.getByRole("tab", { name: /Beta/ }).all().length).toBe(1);
  await expect
    .poll(() => screen.getByRole("heading", { name: "Beta", exact: true }).all().length)
    .toBe(1);
  await expect.poll(() => screen.getByRole("tab", { name: /Gamma/ }).all().length).toBe(1);
  expect(screen.getByRole("heading", { name: "Gamma", exact: true }).all()).toHaveLength(0);
  await screen.getByRole("tab", { name: /Beta/ }).click();
  await expect.poll(() => screen.getByText("Beta", { exact: true }).all().length).toBe(1);
  fixture.linkable.mockClear();
  await screen.getByRole("button", { name: "Add machine", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Add a machine for agents on Beta", exact: true }))
    .toBeInTheDocument();
  expect(fixture.linkable).toHaveBeenLastCalledWith(beta.environmentId, true);
});
