import { EnvironmentId, ProviderInstanceId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { StrictMode, act } from "react";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  keybindings: {} as unknown,
  providers: {} as unknown,
  presentations: new Map(),
  refreshProviders: vi.fn(async () => undefined),
  metric: "limits",
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (atom: unknown) =>
    atom === state.keybindings
      ? DEFAULT_RESOLVED_KEYBINDINGS
      : atom === state.providers
        ? new Map(
            [...state.presentations].map(([id, presentation]) => [
              id,
              presentation.serverConfig.providers,
            ]),
          )
        : state.presentations,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
  useCanGoBack: () => false,
}));
vi.mock(import("../../state/presentation"), async (original) => ({
  ...(await original()),
  environmentPresentations: {
    presentationsAtom: null,
    presentationsWithProvidersAtom: null,
    providersByEnvironmentAtom: state.providers,
  } as never,
}));
vi.mock(import("../../state/server"), async (original) => ({
  ...(await original()),
  serverEnvironment: { refreshProviders: null } as never,
  primaryServerKeybindingsAtom: state.keybindings as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.refreshProviders) as never,
}));
vi.mock(import("../../env"), async (original) => ({
  ...(await original()),
  isElectron: false,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettings: (() => "24h") as never,
}));
vi.mock(import("../../state/usage"), async (original) => ({
  ...(await original()),
  useUsage: (() => ({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments: [
      {
        environmentId: EnvironmentId.make("test"),
        label: "Test",
        isPending: false,
        error: null,
        summary: null,
      },
    ],
    selectedEnvironments: [
      {
        environmentId: EnvironmentId.make("test"),
        label: "Test",
        isPending: false,
        error: null,
        summary: null,
      },
    ],
    isPending: false,
    shown: null,
    isPartial: false,
    refresh: async () => undefined,
  })) as never,
}));
vi.mock(import("./usagePagePreferences"), async (original) => ({
  ...(await original()),
  readUsagePagePreferences: (() => ({ metric: state.metric, windowDays: 30 })) as never,
  saveUsagePagePreferences: vi.fn(),
}));

import { UsagePage } from "./UsagePage";

let renderer: Root;
let container: HTMLDivElement;
const pageText = () => document.body.textContent ?? "";
const selectMetric = (metric: string) =>
  act(async () => {
    const label = metric === "limits" ? "Limits" : "Tokens";
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    button!.click();
  });
let environmentNumber = 0;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-11T12:00:00Z"));
  environmentNumber += 1;
  state.metric = "limits";
  state.refreshProviders.mockClear();
  state.presentations = new Map([
    [
      EnvironmentId.make(`test-${environmentNumber}`),
      {
        entry: { target: { label: "Test" } },
        connection: { phase: "connected" },
        serverConfig: {
          providers: [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              enabled: true,
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-09-11T12:00:00Z",
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: {
                checkedAt: "2026-09-11T12:00:00Z",
                windows: [
                  {
                    id: "five_hour",
                    kind: "session",
                    label: "Session",
                    usedPercent: 40,
                    windowDurationMins: 300,
                    resetsAt: "2026-09-11T14:00:00Z",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  ]);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([0, 1])(
  "refreshes the visible limits countdown with refresh button %i without switching tabs, even when quota is unchanged",
  async (buttonIndex) => {
    await act(() => {
      renderer.render(<UsagePage />);
    });
    expect(pageText()).toContain("in 2h 0m");
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T12:30:00Z"));
    await act(async () =>
      document
        .querySelectorAll<HTMLButtonElement>('button[aria-label="Refresh limits"]')
        .item(buttonIndex)
        .click(),
    );
    expect(state.refreshProviders).toHaveBeenCalledWith({
      environmentId: `test-${environmentNumber}`,
      input: {},
    });
    expect(pageText()).toContain("in 1h 30m");
    expect(pageText()).not.toContain("in 2h 0m");
  },
);

it("uses the current time when returning to limits from tokens", async () => {
  await act(() => {
    renderer.render(<UsagePage />);
  });
  await selectMetric("tokens");
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T13:00:00Z"));
  await selectMetric("limits");
  expect(pageText()).toContain("in 1h 0m");
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
});

it("refreshes once on opening Limits and suppresses rapid returns and remounts", async () => {
  state.metric = "tokens";
  await act(() => {
    renderer.render(
      <StrictMode>
        <UsagePage />
      </StrictMode>,
    );
  });
  expect(state.refreshProviders).not.toHaveBeenCalled();
  await selectMetric("limits");
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await selectMetric("tokens");
  await selectMetric("limits");
  await act(() => renderer.unmount());
  state.metric = "limits";
  renderer = createRoot(container);
  await act(() => {
    renderer.render(
      <StrictMode>
        <UsagePage />
      </StrictMode>,
    );
  });
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await selectMetric("tokens");
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-11T12:05:00Z"));
  await selectMetric("limits");
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
});

it("waits for connection and refreshes new environments during a slow refresh", async () => {
  const [id, presentation] = [...state.presentations][0]!;
  state.presentations = new Map([[id, { ...presentation, connection: { phase: "disconnected" } }]]);
  await act(() => {
    renderer.render(<UsagePage />);
  });
  expect(state.refreshProviders).not.toHaveBeenCalled();
  let finishRefresh!: () => void;
  state.refreshProviders.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        finishRefresh = () => resolve(undefined);
      }),
  );
  state.presentations = new Map([[id, presentation]]);
  await act(() => renderer.render(<UsagePage />));
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  const nextId = EnvironmentId.make(`${id}-next`);
  state.presentations = new Map([...state.presentations, [nextId, presentation]]);
  await act(() => renderer.render(<UsagePage />));
  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
  expect(state.refreshProviders).toHaveBeenLastCalledWith({ environmentId: nextId, input: {} });
  await act(() => finishRefresh());
});

it("keeps manual refresh busy until the already-running automatic check settles", async () => {
  let finishRefresh!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    finishRefresh = () => resolve(undefined);
  });
  state.refreshProviders.mockImplementationOnce(() => pending);
  await act(() => {
    renderer.render(<UsagePage />);
  });
  const button = () =>
    page.getByRole("button", { name: "Refresh limits", exact: true }).first().element();
  expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  await userEvent.click(button());
  try {
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(state.refreshProviders).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => {
      finishRefresh();
      await pending;
    });
  }
  expect(button().getAttribute("aria-busy")).toBe("false");
});
