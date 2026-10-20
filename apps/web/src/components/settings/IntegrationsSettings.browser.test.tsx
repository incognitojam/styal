import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
} from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import type { EnvironmentPresentation } from "../../state/environments";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { act, render } from "../../../test/render";

const { listBrowserImportSources } = vi.hoisted(() => ({
  listBrowserImportSources: vi.fn().mockResolvedValue([]),
}));

vi.mock(import("../preview/previewBridge"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    previewBridge: { ...actual.previewBridge, listBrowserImportSources } as never,
  };
});
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments, isReady: true })) as never,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdatePrimarySettings: (() => vi.fn()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  })) as never,
  useOptionalSettingsScope: () => null,
}));

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";

let environments: EnvironmentPresentation[];

function setup() {
  listBrowserImportSources.mockClear();
  environments = [];
}

async function openSettings() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <StrictMode>
        <IntegrationsSettingsPanel />
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(screen.container.querySelector("section#browser")).not.toBeNull());
  stack.move();
  return screen;
}

describe("Integrations browser discovery", () => {
  it("keeps client browser preferences, including search engine, in one folded section", async () => {
    setup();
    await using screen = await openSettings();

    expect(screen.container.querySelectorAll("section#browser")).toHaveLength(1);
    await act(async () => page.getByRole("button", { name: /Browser preferences/ }).click());
    const searchEngine = page.getByRole("combobox", { name: "Search engine", exact: true });
    await expect.element(searchEngine).toBeVisible();
    expect(searchEngine.element().closest("section")).toBe(
      screen.container.querySelector("section#browser"),
    );
  });

  it("does not scan browser files when entering or revisiting settings", async () => {
    setup();
    await using first = await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();

    await first.unmount();
    await using _second = await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();
  });
});

it("distinguishes a saved connection from an offline environment and links to connection management", async () => {
  setup();
  environments = (["available", "offline", "reconnecting"] as const).map((phase) => {
    const environmentId = EnvironmentId.make(phase);
    return {
      environmentId,
      label: `Device host ${phase}`,
      displayUrl: null,
      relayManaged: false,
      entry: {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: `Device host ${phase}`,
          httpBaseUrl: "http://localhost:1234",
          wsBaseUrl: "ws://localhost:1234",
        }),
        profile: Option.none(),
        enabled: phase !== "available",
      },
      connection: { phase, error: null, traceId: null },
      serverConfig: null,
    } satisfies EnvironmentPresentation;
  });
  await using screen = await openSettings();
  const { container } = screen;

  const saved = container.querySelector("#integration-environment-available")!;
  expect(saved.textContent).toContain("Not connected");
  expect(saved.textContent).not.toContain("Offline");
  expect(saved.textContent).toContain("Connect this environment");
  expect(saved.querySelector("a")?.getAttribute("href")).toBe("/settings/connections");
  expect(container.querySelector("#integration-environment-offline")?.textContent).toContain(
    "Offline",
  );
  expect(container.querySelector("#integration-environment-reconnecting")?.textContent).toContain(
    "Connecting",
  );
  expect(container.querySelectorAll("section[aria-label$='integrations']")).toHaveLength(3);
});
