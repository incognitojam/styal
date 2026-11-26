import type { ReactNode } from "react";
import { act } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import type { IncomingShareDraft } from "../sharing/incoming-share-model";
import { makeThreadShellFixture } from "../../test-fixtures";
import { retargetSavedNewTaskDraft } from "../../state/use-composer-drafts";

const environmentId = EnvironmentId.make("env-1");

function project(id: string, workspaceRoot: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: "worktree",
    scripts: [],
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
}

const regular = project("app", "/repo/app");
const scratch = project("scratch", "/scratch");

const harness = vi.hoisted(() => ({
  share: null as IncomingShareDraft | null,
  threads: [] as EnvironmentThreadShell[],
  setProject: vi.fn(),
  openScratch: vi.fn(),
  selectDetail: vi.fn(),
  navigation: {
    goBack: vi.fn(),
    getState: () => ({
      routeNames: ["Thread", "NewTaskProject"],
      index: 1,
      routes: [{ name: "Thread", params: { draft: {} } }, { name: "NewTaskProject" }],
    }),
    getParent: () => undefined,
    canGoBack: () => true,
    dispatch: vi.fn(),
    navigate: vi.fn(),
  },
}));

vi.mock("../sharing/ShareToThreadSection", () => ({
  ShareToThreadSection: ({
    targets,
    showNewThreadHeading,
  }: {
    targets: ReadonlyArray<{ thread: { title: string } }>;
    showNewThreadHeading: boolean;
  }) => (
    <>
      {targets.map(({ thread }) => (
        <span key={thread.title}>{thread.title}</span>
      ))}
      {showNewThreadHeading ? <span>Start a new thread</span> : null}
    </>
  ),
  useShareToThreadSubtitle: () => null,
}));

vi.mock("react-native", () => ({
  Platform: { OS: process.env.T3_MOBILE_TEST_PLATFORM === "android" ? "android" : "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("gt-react-native", () => ({
  msg: (text: string) => text,
  T: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useGT: () => (text: string) => text,
  useMessages: () => (text: string) => text,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: (name: string) => ({ type: "PUSH", name }) },
  useFocusEffect: (effect: () => () => void) => React.useEffect(effect, [effect]),
  useIsFocused: () => true,
  useNavigation: () => harness.navigation,
}));
vi.mock("../../components/ui/NavigationRow", () => ({
  NavigationRow: (props: { title: string; disabled?: boolean; onPress?: () => void }) => (
    <button aria-label={props.title} disabled={props.disabled === true} onClick={props.onPress}>
      {props.title}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: ({ search }: { search: { value: string; onChangeText: (text: string) => void } }) => (
    <input
      aria-label="Project search"
      value={search.value}
      onInput={(event) => search.onChangeText(event.currentTarget.value)}
    />
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({
    children,
    contentContainerStyle,
  }: {
    children?: ReactNode;
    contentContainerStyle?: { justifyContent?: string };
  }) => (
    <div
      data-testid="project-list"
      style={{ justifyContent: contentContainerStyle?.justifyContent }}
    >
      {children}
    </div>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../connection/environmentStatusText", () => ({ runtimeConnectionErrorText: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [regular, scratch],
  useVisibleThreadShells: () => harness.threads,
  useServerConfigs: () => new Map([[environmentId, { scratchWorkspaceRoot: "/scratch" }]]),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { openScratch: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.openScratch }));
vi.mock("../../state/use-composer-drafts", () => ({ retargetSavedNewTaskDraft: vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId, connectionState: "connected" }],
  }),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: { hasReadyEnvironment: true } }),
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  useIncomingShare: () => ({ getShare: () => harness.share, releaseShareReservation: vi.fn() }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => harness.selectDetail,
}));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({
    projectScopes: [
      {
        key: "app",
        title: "app",
        representative: regular,
        projects: [regular],
        projectRefs: [],
        pinned: false,
        archived: false,
      },
    ],
    selectedEnvironmentId: environmentId,
    setProject: harness.setProject,
  }),
}));

import { NewTaskRouteScreen } from "./NewTaskRouteScreen";

it("keeps the project picked while No project was still opening", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opening = Promise.withResolvers<unknown>();
  harness.openScratch.mockReturnValue(opening.promise);

  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() => root.render(<NewTaskRouteScreen route={{ params: undefined } as never} />));
  const row = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

  act(() => row("No project").click());
  await act(async () => row("app").click());
  await act(async () => opening.resolve({ _tag: "Success", value: scratch }));

  expect(harness.setProject.mock.calls).toEqual([[regular]]);
  expect(harness.navigation.goBack).toHaveBeenCalledTimes(1);
});

function renderWithSavedDraft() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opening = Promise.withResolvers<unknown>();
  const retargeting = Promise.withResolvers<boolean>();
  harness.openScratch.mockReturnValue(opening.promise);
  vi.mocked(retargetSavedNewTaskDraft)
    .mockReset()
    .mockImplementation((_draftId, target) =>
      target.projectId === scratch.id ? retargeting.promise : Promise.resolve(true),
    );
  harness.selectDetail.mockClear();

  const container = document.createElement("div");
  const root = createRoot(container);
  const route = { params: { draftId: "existing-draft" } } as never;
  act(() => root.render(<NewTaskRouteScreen key="first" route={route} />));
  return {
    opening,
    retargeting,
    root,
    route,
    row: (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

const appDraftSelection = [
  [
    {
      name: "Thread",
      params: { draft: { environmentId, projectId: regular.id, draftId: "existing-draft" } },
    },
  ],
];

it("keeps the picked project after backing out and reopening while No project is pending", async () => {
  using screen = renderWithSavedDraft();

  act(() => screen.row("No project").click());
  act(() => screen.root.render(null));
  act(() => screen.root.render(<NewTaskRouteScreen key="second" route={screen.route} />));
  await act(async () => screen.row("app").click());
  await act(async () => {
    screen.opening.resolve({ _tag: "Success", value: scratch });
    screen.retargeting.resolve(true);
  });

  expect(harness.selectDetail.mock.calls).toEqual(appDraftSelection);
});

it("cancels the No project draft retarget when another project is picked", async () => {
  using screen = renderWithSavedDraft();

  act(() => screen.row("No project").click());
  await act(async () => screen.opening.resolve({ _tag: "Success", value: scratch }));
  const scratchSignal = vi
    .mocked(retargetSavedNewTaskDraft)
    .mock.calls.find(([, target]) => target.projectId === scratch.id)?.[2];
  expect(scratchSignal?.aborted).toBe(false);
  await act(async () => screen.row("app").click());
  expect(scratchSignal?.aborted).toBe(true);
  await act(async () => screen.retargeting.resolve(true));

  expect(harness.selectDetail.mock.calls).toEqual(appDraftSelection);
});

it("shows the project search empty state only when no thread or project matches", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.share = {
    schemaVersion: 1,
    id: "share-search",
    createdAt: "2026-06-02T00:00:00Z",
    text: "Shared note",
    attachments: [],
    warnings: [],
  };
  harness.threads = [
    makeThreadShellFixture({
      id: ThreadId.make("thread-search"),
      environmentId,
      projectId: regular.id,
      title: "Layout review",
    }),
  ];
  using _fixture = {
    [Symbol.dispose]: () => {
      harness.share = null;
      harness.threads = [];
    },
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(
      <NewTaskRouteScreen route={{ params: { incomingShareId: "share-search" } } as never} />,
    ),
  );
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Project search"]')!;
  const type = (query: string) =>
    act(() => {
      search.value = query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  type("layout");
  expect(container.textContent).toContain("Layout review");
  expect(container.textContent).not.toContain("No matching projects");
  type("app");
  expect(container.querySelector('[aria-label="app"]')).not.toBeNull();
  expect(container.textContent).not.toContain("No matching projects");
  type("missing");
  expect(container.textContent).toContain("No matching projects");
  expect(container.textContent).not.toContain("Layout review");
});

it.each([false, true])("filters No project by its title in the chooser (share: %s)", (sharing) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.share = sharing
    ? {
        schemaVersion: 1,
        id: "share-scratch-search",
        createdAt: "2026-06-02T00:00:00Z",
        text: "Shared note",
        attachments: [],
        warnings: [],
      }
    : null;
  using _fixture = {
    [Symbol.dispose]: () => {
      harness.share = null;
    },
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() =>
    root.render(
      <NewTaskRouteScreen
        route={
          { params: sharing ? { incomingShareId: "share-scratch-search" } : undefined } as never
        }
      />,
    ),
  );
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Project search"]')!;
  const type = (query: string) =>
    act(() => {
      search.value = query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const noProject = () => container.querySelector('[aria-label="No project"]');
  const list = container.querySelector<HTMLElement>('[data-testid="project-list"]')!;
  expect(noProject()).not.toBeNull();
  type("app");
  expect(noProject()).toBeNull();
  expect(container.querySelector('[aria-label="app"]')).not.toBeNull();
  type("  NO pRo  ");
  expect(noProject()).not.toBeNull();
  if (process.env.T3_MOBILE_TEST_PLATFORM === "android") {
    expect(list.style.justifyContent).not.toBe("center");
  }
  expect(container.textContent).not.toContain("No matching projects");
  if (sharing) expect(container.textContent).toContain("Start a new thread");
  type("missing");
  expect(noProject()).toBeNull();
  expect(container.textContent).toContain("No matching projects");
  expect(container.textContent).not.toContain("Start a new thread");
  if (process.env.T3_MOBILE_TEST_PLATFORM === "android") {
    expect(list.style.justifyContent).toBe("center");
  }
  type("");
  expect(noProject()).not.toBeNull();
});
