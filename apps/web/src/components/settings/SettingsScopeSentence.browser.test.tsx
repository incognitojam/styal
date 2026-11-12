import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    label: string;
    displayUrl: string;
    connection: { phase: string };
    serverConfig: null;
  }>,
  discovered: new Map<string, { environment: { environmentId: string; label: string } }>(),
  singleEnvironment: false,
  selectScope: (() => {}) as (next: unknown) => void,
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  useRelayEnvironmentDiscovery: () => ({ environments: state.discovered }),
}));

vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => ({
    search: {},
    scope: { kind: "all" },
    groups: [],
    singleEnvironment: state.singleEnvironment,
    selectScope: state.selectScope,
  }),
}));

import { SettingsScopeSentence } from "./SettingsScopeSentence";

function setup({
  machines,
  notAdded = [],
  singleEnvironment = false,
}: {
  machines: string[];
  notAdded?: string[];
  singleEnvironment?: boolean;
}) {
  state.singleEnvironment = singleEnvironment;
  state.environments = machines.map((label, index) => ({
    environmentId: `machine-${index}`,
    label,
    displayUrl: `http://192.0.2.${index + 1}:3773`,
    connection: { phase: "connected" },
    serverConfig: null,
  }));
  state.discovered = new Map(
    [...machines, ...notAdded].map((label, index) => [
      index < machines.length ? `machine-${index}` : `link-${index}`,
      {
        environment: {
          environmentId: index < machines.length ? `machine-${index}` : `link-${index}`,
          label,
        },
      },
    ]),
  );
  const selectScope = vi.fn();
  state.selectScope = selectScope;
  return { selectScope };
}

describe("settings machine picker", () => {
  it("lists machines by name and counts only Link machines this app hasn't added", async () => {
    setup({ machines: ["Studio Mac", "homelab"], notAdded: ["work-pc"] });
    await using screen = await render(<SettingsScopeSentence />, { router: "/settings/threads" });
    await userEvent.click(page.getByRole("button", { name: /Environment scope/ }));
    await expect.element(page.getByRole("menuitemradio", { name: "homelab" })).toBeVisible();
    expect(screen.container.ownerDocument.body.textContent).not.toContain("192.0.2.");
    await expect.element(page.getByText("work-pc isn't added yet")).toBeVisible();
  });

  it("counts several machines that aren't added, also on single-environment pages", async () => {
    setup({
      machines: ["Studio Mac", "homelab"],
      notAdded: ["work-pc", "laptop"],
      singleEnvironment: true,
    });
    await using _screen = await render(<SettingsScopeSentence />, { router: "/settings/threads" });
    await userEvent.click(page.getByRole("button", { name: /Environment scope/ }));
    await expect.element(page.getByText("2 machines aren't added yet")).toBeVisible();
    await expect.element(page.getByText("Manage machines…")).toBeVisible();
  });

  it("offers to add a machine when there is only one, and opens machine settings", async () => {
    const { selectScope } = setup({ machines: ["Studio Mac"], singleEnvironment: true });
    await using screen = await render(<SettingsScopeSentence />, { router: "/settings/threads" });
    await userEvent.click(page.getByRole("button", { name: /Environment scope/ }));
    await userEvent.click(page.getByRole("menuitem", { name: "Add a machine…" }));
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/settings/connections"),
    );
    expect(selectScope).not.toHaveBeenCalled();
  });

  it("keeps the entry last in the searchable list and opens machine settings from it", async () => {
    const { selectScope } = setup({
      machines: ["Studio Mac", "homelab", "work-pc", "laptop", "nas", "pi", "build-box"],
    });
    await using screen = await render(<SettingsScopeSentence />, { router: "/settings/threads" });
    await userEvent.click(page.getByLabelText(/Environment scope/));
    await userEvent.type(page.getByPlaceholder("Search environments"), "zzz");
    const options = page.getByRole("option");
    await expect.element(options.first()).toHaveTextContent("Manage machines…");
    expect(options.all()).toHaveLength(1);
    await userEvent.click(options.first());
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/settings/connections"),
    );
    expect(selectScope).not.toHaveBeenCalled();
  });
});
