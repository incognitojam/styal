import type { PullRequestLabel } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Candidate = { name: string; isApplied: boolean };

const state = vi.hoisted(() => ({
  labels: [] as ReadonlyArray<PullRequestLabel>,
  read: null as unknown,
  catalogue: null as unknown,
  setLabels: (() => Promise.resolve()) as (...args: ReadonlyArray<unknown>) => Promise<unknown>,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FlatList: (props: {
    data: ReadonlyArray<Candidate>;
    renderItem: (entry: { item: Candidate; index: number }) => ReactElement;
    ListEmptyComponent?: ReactElement;
    ListFooterComponent?: ReactElement;
  }) => (
    <div>
      {props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item, index) => (
            <div key={item.name}>{props.renderItem({ item, index })}</div>
          ))}
      {props.ListFooterComponent}
    </div>
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <div role="progressbar" />,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title }: { title: string }) => <p>{title}</p>,
}));
vi.mock("../../components/ui/SelectionRow", () => ({
  SelectionRow: (props: { title: string; selected: boolean; onPress: () => void }) => (
    <button type="button" role="checkbox" aria-checked={props.selected} onClick={props.onPress}>
      {props.title}
    </button>
  ),
}));
vi.mock("./PullRequestLabelDot", () => ({ PullRequestLabelDot: () => null }));
vi.mock("./pullRequestList", () => ({ pullRequestLabelColor: () => null }));
vi.mock("./PullRequestSearchSheet", () => ({
  PullRequestSearchSheet: ({
    children,
  }: {
    children: (layout: { paddingBottom: number }) => ReactNode;
  }) => <>{children({ paddingBottom: 0 })}</>,
}));
vi.mock("./usePullRequestConnected", () => ({ usePullRequestConnected: () => true }));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: { environmentId: string }) => ({
    environmentId: params.environmentId,
    input: { projectId: "project", repository: "acme/web", number: 2 },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.setLabels,
}));
vi.mock("../../state/pull-requests", () => ({
  composerPullRequests: {
    detail: () =>
      Atom.make(
        AsyncResult.success({
          labels: state.labels,
          capabilities: { labels: true },
          viewerPermissions: { labels: true },
        }),
      ),
    labelCandidates: () =>
      Atom.make(state.read === null ? AsyncResult.initial(true) : AsyncResult.success(state.read)),
    repositoryLabelCandidates: () => Atom.make(state.catalogue),
    setLabels: { permissionAtom: () => Atom.make(true) },
  },
}));

import { PullRequestLabelsScreen } from "./PullRequestLabelsScreen";

function setup(options: {
  labels: ReadonlyArray<PullRequestLabel>;
  catalogue: unknown;
  setLabels?: (...args: ReadonlyArray<unknown>) => Promise<unknown>;
}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.labels = options.labels;
  state.read = null;
  state.catalogue = options.catalogue;
  state.setLabels = options.setLabels ?? (() => Promise.resolve(AsyncResult.success(undefined)));
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <PullRequestLabelsScreen
        route={
          {
            params: { environmentId: "environment" },
          } as Parameters<typeof PullRequestLabelsScreen>[0]["route"]
        }
      />,
    ),
  );
  const rows = () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].map((row) => ({
      name: row.textContent,
      applied: row.getAttribute("aria-checked") === "true",
      row,
    }));
  return {
    container,
    rows,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("shows another pull request's cached catalogue while this one's read loads", () => {
  using screen = setup({
    labels: [
      { name: "outside-page", color: null },
      { name: "documentation", color: null },
    ],
    catalogue: {
      candidates: [
        { name: "bug", color: null, description: null },
        { name: "documentation", color: null, description: null },
      ],
      truncated: true,
    },
  });
  expect(screen.container.querySelector('[role="progressbar"]')).toBeNull();
  expect(screen.rows().map(({ name, applied }) => ({ name, applied }))).toEqual([
    { name: "outside-page", applied: true },
    { name: "bug", applied: false },
    { name: "documentation", applied: true },
  ]);
  expect(screen.container.textContent).toContain("more labels than are listed here");
});

it("shows a spinner when no catalogue has been fetched for the repository", () => {
  using screen = setup({ labels: [{ name: "bug", color: null }], catalogue: null });
  expect(screen.container.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(screen.rows()).toEqual([]);
});

it("sends further label edits while an earlier one is still pending", () => {
  const calls: Array<{ input: { labels: ReadonlyArray<string>; applied: boolean } }> = [];
  using screen = setup({
    labels: [{ name: "documentation", color: null }],
    catalogue: {
      candidates: [
        { name: "bug", color: null, description: null },
        { name: "documentation", color: null, description: null },
      ],
      truncated: false,
    },
    setLabels: (target) => {
      calls.push(target as (typeof calls)[number]);
      return new Promise(() => {});
    },
  });
  const [bug, documentation] = screen.rows();
  act(() => bug!.row.click());
  act(() => documentation!.row.click());
  expect(calls.map(({ input }) => ({ labels: input.labels, applied: input.applied }))).toEqual([
    { labels: ["bug"], applied: true },
    { labels: ["documentation"], applied: false },
  ]);
});
