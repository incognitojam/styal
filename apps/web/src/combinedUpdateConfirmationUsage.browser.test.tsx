import { EnvironmentId, FORK_CLIENT_USAGE_VERSION } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../test/render";

import { UpdateEverythingDialog } from "./components/sidebar/UpdateEverythingDialog";

type Config = { environment: { capabilities: { forkClientUsageVersion: number } } };
const state = vi.hoisted(() => ({
  primaryId: null as EnvironmentId | null,
  configs: new Map<EnvironmentId, Config>(),
  run: vi.fn(),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.primaryId,
}));
vi.mock("./state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("./state/entities", () => ({ useServerConfigs: () => state.configs }));
vi.mock("./rpc/atomRegistry", () => ({
  appAtomRegistry: { get: (id: EnvironmentId) => state.configs.get(id) },
}));
vi.mock("./state/server", () => ({
  serverEnvironment: {
    configValueAtom: (id: EnvironmentId) => id,
    reportForkClientUsage: { run: state.run },
  },
}));
vi.mock("./components/HostActivityThreadList", () => ({ HostActivityThreadList: () => null }));

const firstId = EnvironmentId.make("synthetic-first-environment");
const secondId = EnvironmentId.make("synthetic-second-environment");
const onConfirm = vi.fn();
const onOpenChange = vi.fn();

function support(id: EnvironmentId, version = FORK_CLIENT_USAGE_VERSION) {
  state.configs = new Map(state.configs).set(id, {
    environment: { capabilities: { forkClientUsageVersion: version } },
  });
}

function setup() {
  onConfirm.mockReset();
  onOpenChange.mockReset();
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.configs = new Map();
  state.primaryId = firstId;
  support(firstId);
}

function dialog(open: boolean, summary = "Update synthetic computers") {
  return (
    <StrictMode>
      <UpdateEverythingDialog
        open={open}
        onOpenChange={onOpenChange}
        summary={summary}
        lines={["Synthetic machine update"]}
        skipped={[]}
        activity={{
          lines: [],
          threadActivity: [],
          localVersion: "1.2.0",
          interrupts: true,
          servers: "",
        }}
        onConfirm={onConfirm}
      />
    </StrictMode>
  );
}

async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

function reports() {
  return state.run.mock.calls.map(([, input]) => input);
}

function report(action: "shown" | "confirmed" | "cancelled", environmentId = firstId) {
  return { environmentId, input: { feature: "combined-update-confirmation", action } };
}

it("counts one opening through StrictMode and rerenders, and one confirmation intent", async () => {
  setup();
  await using screen = await render(dialog(false));
  expect(reports()).toEqual([]);
  await screen.rerender(dialog(true, "Updated synthetic summary"));
  await screen.rerender(dialog(true));
  expect(reports()).toEqual([report("shown")]);
  await click("Update");
  expect(onConfirm).toHaveBeenCalledOnce();
  // A repeated click or subsequent close notification must not add a second decision.
  await click("Update");
  await click("Cancel");
  await screen.rerender(dialog(false));
  expect(reports()).toEqual([report("shown"), report("confirmed")]);
});

it("counts Cancel and Escape per opening, but no decision for a programmatic close", async () => {
  setup();
  await using screen = await render(dialog(true));
  await click("Cancel");
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  await screen.rerender(dialog(false));
  await screen.rerender(dialog(true));
  await userEvent.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenCalledTimes(2);
  await screen.rerender(dialog(false));
  await screen.rerender(dialog(true));
  await screen.rerender(dialog(false));
  expect(reports()).toEqual([
    report("shown"),
    report("cancelled"),
    report("shown"),
    report("cancelled"),
    report("shown"),
  ]);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("keeps the decision on the exposure's environment, then reselects on reopening", async () => {
  setup();
  support(secondId);
  await using screen = await render(dialog(true));
  state.primaryId = secondId;
  await screen.rerender(dialog(true));
  await click("Update");
  await screen.rerender(dialog(false));
  await screen.rerender(dialog(true));
  await click("Cancel");
  expect(reports()).toEqual([
    report("shown"),
    report("confirmed"),
    report("shown", secondId),
    report("cancelled", secondId),
  ]);
});

it("uses one supported paired environment on hosted web without a primary", async () => {
  setup();
  state.primaryId = null;
  support(firstId, FORK_CLIENT_USAGE_VERSION - 1);
  support(secondId);
  await using _screen = await render(dialog(true));
  await click("Update");
  expect(reports()).toEqual([report("shown", secondId), report("confirmed", secondId)]);
  expect(onConfirm).toHaveBeenCalledOnce();
});

it("keeps older and disconnected servers usable, and reports when support arrives while open", async () => {
  setup();
  state.configs.clear();
  await using screen = await render(dialog(true));
  await click("Cancel");
  await screen.rerender(dialog(false));
  support(firstId, FORK_CLIENT_USAGE_VERSION - 1);
  await screen.rerender(dialog(true));
  await click("Update");
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(reports()).toEqual([]);
  await screen.rerender(dialog(false));
  await screen.rerender(dialog(true));
  support(firstId);
  await screen.rerender(dialog(true));
  await click("Update");
  expect(reports()).toEqual([report("shown"), report("confirmed")]);
});

it("does not delay or retry decisions when reporting fails or remains pending", async () => {
  setup();
  state.run.mockRejectedValueOnce(new Error("Synthetic reporting failure"));
  state.run.mockImplementation(() => new Promise(() => {}));
  await using screen = await render(dialog(true));
  await screen.rerender(dialog(true));
  await click("Update");
  expect(onConfirm).toHaveBeenCalledOnce();
  await click("Update");
  expect(reports()).toEqual([report("shown"), report("confirmed")]);
});
