import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const files = vi.hoisted(() => ({
  contents: new Map<string, string>(),
  reads: 0,
}));

vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));

vi.mock("~/state/queries", () => ({ useProjectPathSearch: vi.fn() }));

vi.mock("~/state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  // Cached like the real query: revalidated when first read, kept for five minutes.
  const readFile = Atom.family((relativePath: string) =>
    Atom.make(
      Effect.sync(() => {
        files.reads += 1;
        const contents = files.contents.get(relativePath);
        return {
          relativePath,
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
      readFile: ({ input }: { input: { relativePath: string } }) => readFile(input.relativePath),
      optimisticFile: () => Atom.make(null),
    },
  };
});

import { useProjectConfigState } from "./useProjectConfig";

const environmentId = EnvironmentId.make("environment-1");

function Patterns() {
  const { config } = useProjectConfigState(environmentId, "/repo");
  return <p>{config?.worktreeCleanup?.join(" ") ?? "none"}</p>;
}

it("re-reads styal.json when a view opens it again and when the window regains focus", async () => {
  files.contents.set("styal.json", JSON.stringify({ worktreeCleanup: ["node_modules"] }));
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const view = (open: boolean) => (
    <RegistryContext.Provider value={registry}>
      {open ? <Patterns /> : null}
    </RegistryContext.Provider>
  );
  await using screen = await render(view(true));
  await expect.element(screen.getByText("node_modules")).toBeVisible();

  files.contents.set("styal.json", JSON.stringify({ worktreeCleanup: ["node_modules", "dist"] }));
  await screen.rerender(view(false));
  await screen.rerender(view(true));
  await expect.element(screen.getByText("node_modules dist")).toBeVisible();

  files.contents.set("styal.json", JSON.stringify({ worktreeCleanup: ["dist"] }));
  await act(() => window.dispatchEvent(new Event("focus")));
  await expect.element(screen.getByText("dist", { exact: true })).toBeVisible();

  const reads = files.reads;
  await screen.rerender(view(true));
  expect(files.reads).toBe(reads);
});
