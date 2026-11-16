import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const files = vi.hoisted(() => ({
  contents: new Map<string, string>(),
  reads: new Map<string, number>(),
}));

vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));

vi.mock("~/state/queries", () => ({ useProjectPathSearch: vi.fn() }));

vi.mock("~/state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  // Cached like the real query: revalidated when first read, kept for five minutes, and
  // answered asynchronously like a request to the server.
  const readFile = Atom.family((key: string) =>
    Atom.make(
      Effect.promise(async () => {
        files.reads.set(key, (files.reads.get(key) ?? 0) + 1);
        await Promise.resolve();
        const contents = files.contents.get(key);
        return {
          relativePath: key.slice(key.lastIndexOf(":") + 1),
          contents: contents ?? "",
          byteLength: contents?.length ?? 0,
          truncated: false,
          ...(contents === undefined ? { exists: false } : {}),
        };
      }),
    ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }), Atom.setIdleTTL(300_000)),
  );
  return {
    projectEnvironment: {
      readFile: (target: { environmentId: string; input: { relativePath: string } }) =>
        readFile(`${target.environmentId}:${target.input.relativePath}`),
      optimisticFile: () => Atom.make(null),
    },
  };
});

import { useProjectConfigState } from "./useProjectConfig";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

function setup() {
  files.contents.clear();
  files.reads.clear();
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

function writeStyalJson(environmentId: EnvironmentId, patterns: readonly string[]) {
  files.contents.set(`${environmentId}:styal.json`, JSON.stringify({ worktreeCleanup: patterns }));
}

const reads = (environmentId: EnvironmentId) => ({
  styal: files.reads.get(`${environmentId}:styal.json`) ?? 0,
  t3: files.reads.get(`${environmentId}:t3.json`) ?? 0,
});

function Patterns({ environmentId, label }: { environmentId: EnvironmentId; label: string }) {
  const { config } = useProjectConfigState(environmentId, "/repo");
  return <p>{`${label}: ${config?.worktreeCleanup?.join(" ") ?? "none"}`}</p>;
}

it("re-reads styal.json when a view opens it again and when the window regains focus", async () => {
  using test = setup();
  writeStyalJson(environmentA, ["node_modules"]);
  const view = (open: boolean) => (
    <RegistryContext.Provider value={test.registry}>
      {open ? <Patterns environmentId={environmentA} label="A" /> : null}
    </RegistryContext.Provider>
  );
  await using screen = await render(view(true));
  await expect.element(screen.getByText("A: node_modules")).toBeVisible();

  writeStyalJson(environmentA, ["node_modules", "dist"]);
  await screen.rerender(view(false));
  await screen.rerender(view(true));
  await expect.element(screen.getByText("A: node_modules dist")).toBeVisible();

  writeStyalJson(environmentA, ["dist"]);
  await act(() => window.dispatchEvent(new Event("focus")));
  await expect.element(screen.getByText("A: dist")).toBeVisible();

  const before = reads(environmentA);
  await screen.rerender(view(true));
  expect(reads(environmentA)).toEqual(before);
});

it("reads each file once per focus when several views show the same project", async () => {
  using test = setup();
  writeStyalJson(environmentA, ["node_modules"]);
  await using screen = await render(
    <RegistryContext.Provider value={test.registry}>
      <Patterns environmentId={environmentA} label="chat" />
      <Patterns environmentId={environmentA} label="details" />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("details: node_modules")).toBeVisible();
  expect(reads(environmentA)).toEqual({ styal: 1, t3: 1 });

  writeStyalJson(environmentA, ["dist"]);
  await act(() => window.dispatchEvent(new Event("focus")));
  await expect.element(screen.getByText("chat: dist")).toBeVisible();
  await expect.element(screen.getByText("details: dist")).toBeVisible();
  expect(reads(environmentA)).toEqual({ styal: 2, t3: 2 });
});

it("re-reads styal.json when the view switches environment on the same path", async () => {
  using test = setup();
  writeStyalJson(environmentA, ["a-only"]);
  writeStyalJson(environmentB, ["node_modules"]);
  const view = (environmentId: EnvironmentId) => (
    <RegistryContext.Provider value={test.registry}>
      <Patterns environmentId={environmentId} label="project" />
    </RegistryContext.Provider>
  );
  await using screen = await render(view(environmentB));
  await expect.element(screen.getByText("project: node_modules")).toBeVisible();
  await screen.rerender(view(environmentA));
  await expect.element(screen.getByText("project: a-only")).toBeVisible();

  writeStyalJson(environmentB, ["node_modules", "dist"]);
  await screen.rerender(view(environmentB));
  await expect.element(screen.getByText("project: node_modules dist")).toBeVisible();
});
