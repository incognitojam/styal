import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";

const state = vi.hoisted(() => ({
  detail: {
    state: "open",
    isDraft: false,
    headSha: "fresh-head",
    capabilities: { actions: ["merge"], mergeMethods: ["squash"], stackActions: true },
    viewerPermissions: { actions: ["merge"] },
    mergeCapabilities: { merge: false, squash: true, rebase: false },
  },
  stack: null as { layers: [] } | null,
  detailRead: vi.fn(),
  runAction: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/state/pullRequests", async () => {
  const { Effect } = await import("effect");
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    pullRequestEnvironment: {
      runAction: {},
      detail: (input: unknown) => {
        state.detailRead(input);
        return Atom.make(Effect.sync(() => state.detail));
      },
    },
    pullRequestStackAtom: () => Atom.make(Effect.sync(() => state.stack)),
  };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.runAction }));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => null }));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => undefined,
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("~/lib/sourceControlActions", () => ({ usePreparePullRequestThreadAction: () => ({}) }));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: { getState: () => ({ pullRequestMergeMethod: "merge" }) },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, undefined, children),
  TooltipPopup: () => null,
}));

import { PullRequestSpeedActions } from "./PullRequestSpeedActions";

const entry: EnvironmentPullRequestEntry = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  provider: "github",
  host: "github.com",
  repository: "example/project",
  number: 1,
  title: "Example change",
  url: "https://github.com/example/project/pull/1",
  author: { login: "example-author", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  viewerReviewRequested: false,
  labels: [],
};

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.stack = null;
  state.detailRead.mockClear();
  state.runAction.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.toast.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function merge() {
  act(() => {
    renderer = create(<PullRequestSpeedActions entry={entry} visible onActed={vi.fn()} />);
  });
  expect(state.detailRead).not.toHaveBeenCalled();
  await act(async () => {
    renderer.root.findByProps({ "aria-label": "Merge #1" }).props.onClick();
  });
}

it("merges the freshly read head with an allowed method and a host-enforced head guard", async () => {
  await merge();
  expect(state.detailRead).toHaveBeenCalledWith({
    environmentId: entry.environmentId,
    input: {
      projectId: entry.projectId,
      host: entry.host,
      repository: entry.repository,
      number: entry.number,
      allowStale: false,
    },
  });
  expect(state.runAction).toHaveBeenCalledWith({
    environmentId: entry.environmentId,
    input: {
      projectId: entry.projectId,
      host: entry.host,
      repository: entry.repository,
      number: entry.number,
      action: "merge",
      mergeMethod: "squash",
      expectedHeadSha: "fresh-head",
    },
  });
  expect(state.toast).toHaveBeenCalledWith({ type: "success", title: "Merge requested" });
});

it("refuses a single merge when the fresh lookup discovers a stack", async () => {
  state.stack = { layers: [] };
  await merge();
  expect(state.runAction).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      description: "Open this pull request to merge its stack.",
    }),
  );
});
