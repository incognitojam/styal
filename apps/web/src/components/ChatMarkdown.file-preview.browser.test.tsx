import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const serverConfigAtom = vi.hoisted(() => ({}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomRefresh: (() => vi.fn()) as never,
  useAtomValue: ((atom: unknown) =>
    atom === serverConfigAtom ? null : { _tag: "Initial", waiting: false }) as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => serverConfigAtom) as never,
    },
  };
});
vi.mock(import("../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: (() => ({ resolvedTheme: "dark" })) as never,
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => vi.fn()) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: (() => ({ _tag: "Loading" })) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: (() => ({ state: { mode: "local-exec" }, isResolved: true })) as never,
}));
vi.mock(import("../editorPreferences"), async (original) => ({
  ...(await original()),
  useOpenInPreferredEditor: (() => vi.fn()) as never,
  usePreferredEditor: (() => [null, vi.fn()]) as never,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: vi.fn(() => vi.fn()) as never,
}));

import ChatMarkdown from "./ChatMarkdown";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { useRightPanelStore } from "../rightPanelStore";

const threadRef = {
  environmentId: EnvironmentId.make("preview-environment"),
  threadId: ThreadId.make("preview-thread"),
};
let root: Root;
let container: HTMLDivElement;

async function render(element: ReactNode) {
  await act(async () => root.render(element));
}

function visibleText() {
  return container.textContent ?? "";
}

function links() {
  return [...container.querySelectorAll("a")];
}

async function click(link: HTMLAnchorElement) {
  await act(async () => link.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useRightPanelStore.setState({ byThreadKey: {} });
  vi.unstubAllGlobals();
});

describe.each(["chat", "preview"])("Markdown file links in %s", (surface) => {
  const renderMarkdown = (text: string) =>
    surface === "chat" ? (
      <ChatMarkdown cwd="/workspace/project" text={text} threadRef={threadRef} />
    ) : (
      <FileMarkdownPreview
        cwd="/workspace/project"
        relativePath="README.md"
        text={text}
        threadRef={threadRef}
      />
    );
  it.each([
    "[Organizing **threads**](docs/thread-sidebar.md)",
    "- [Organizing **threads**](docs/thread-sidebar.md)",
    "1. [Organizing **threads**][guide]\n\n[guide]: docs/thread-sidebar.md",
  ])("keeps authored text and opens the linked file: %s", async (text) => {
    await render(renderMarkdown(text));
    expect(visibleText().trim()).toBe("Organizing threads");
    expect(container.querySelectorAll("strong")).toHaveLength(1);
    expect(container.querySelector("strong")!.textContent).toBe("threads");

    await click(links()[0]!);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:docs/thread-sidebar.md",
      surfaces: [{ kind: "file", relativePath: "docs/thread-sidebar.md" }],
    });
  });

  it("keeps explicit path references as chips while opening a requested line", async () => {
    await render(renderMarkdown("[docs/settings.ts:12](docs/settings.ts:12) and `src/main.ts`"));
    expect(visibleText().trim()).toBe("settings.ts · L12 and main.ts");
    expect(links()).toHaveLength(2);
    await click(links()[0]!);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toMatchObject({
      activeSurfaceId: "file:docs/settings.ts",
      surfaces: [{ kind: "file", relativePath: "docs/settings.ts", revealLine: 12 }],
    });
  });

  it("updates between descriptive labels and path chips for the same destination", async () => {
    await render(renderMarkdown("[docs/settings.ts:12](docs/settings.ts:12)"));
    expect(visibleText().trim()).toBe("settings.ts · L12");
    await render(renderMarkdown("[Default **settings**](docs/settings.ts:12)"));
    expect(visibleText().trim()).toBe("Default settings");
    await render(renderMarkdown("[docs/settings.ts:12](docs/settings.ts:12)"));
    expect(visibleText().trim()).toBe("settings.ts · L12");
  });
});

describe("links in pending questions", () => {
  it("opens a project file without selecting, advancing, or dismissing the question", async () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    const onDismiss = vi.fn();
    await render(
      <ComposerPendingUserInputPanel
        cwd="/workspace/project"
        threadRef={threadRef}
        pendingUserInputs={[
          {
            requestId: RuntimeRequestId.make("question-links-request"),
            createdAt: "2026-10-11T00:00:00.000Z",
            responseCapability: "live",
            dismissible: true,
            questions: [
              {
                id: "review",
                header: "Review",
                question:
                  "Review https://example.com/approval?request=demo_token and [the guide](docs/settings.ts:12).",
                options: [{ label: "Approved", description: "Continue the request" }],
                multiSelect: false,
              },
            ],
          },
        ]}
        respondingRequestIds={[]}
        answers={{ review: { selectedOptionValues: [], customAnswer: "Keep this draft" } }}
        questionIndex={0}
        onToggleOption={onToggleOption}
        onAdvance={onAdvance}
        onDismiss={onDismiss}
      />,
    );
    const external = links().find((link) =>
      link.getAttribute("href")?.startsWith("https://example.com"),
    );
    expect(external?.getAttribute("href")).toBe("https://example.com/approval?request=demo_token");
    expect(visibleText()).toContain("the guide");
    await click(links().find((link) => link !== external)!);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toMatchObject({
      activeSurfaceId: "file:docs/settings.ts",
      surfaces: [{ kind: "file", relativePath: "docs/settings.ts", revealLine: 12 }],
    });
    expect(onToggleOption).not.toHaveBeenCalled();
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
