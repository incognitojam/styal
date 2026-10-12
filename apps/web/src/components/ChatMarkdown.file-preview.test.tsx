import { scopedThreadKey } from "@t3tools/client-runtime/environment";
// @vitest-environment jsdom

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const serverConfigAtom = vi.hoisted(() => ({}));
vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: () => vi.fn(),
  useAtomValue: (atom: unknown) =>
    atom === serverConfigAtom ? null : { _tag: "Initial", waiting: false },
}));
vi.mock("../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/server")>();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => serverConfigAtom },
  };
});
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: vi.fn(() => vi.fn()),
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import ChatMarkdown from "./ChatMarkdown";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { useRightPanelStore } from "../rightPanelStore";

const threadRef = {
  environmentId: EnvironmentId.make("preview-environment"),
  threadId: ThreadId.make("preview-thread"),
};
let renderer: ReactTestRenderer | undefined;

function visibleText(
  node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
): string {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(visibleText).join("");
  return (node.children ?? []).map(visibleText).join("");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {} });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
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
    await act(async () => {
      renderer = create(renderMarkdown(text));
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe("Organizing threads");
    expect(renderer!.root.findByType("strong").children).toEqual(["threads"]);

    await act(async () => {
      renderer!.root.findAllByType("a")[0]!.props.onClick({
        preventDefault() {},
        stopPropagation() {},
      });
    });
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:docs/thread-sidebar.md",
      surfaces: [{ kind: "file", relativePath: "docs/thread-sidebar.md" }],
    });
  });

  it("keeps explicit path references as chips while opening a requested line", async () => {
    await act(async () => {
      renderer = create(
        renderMarkdown("[docs/settings.ts:12](docs/settings.ts:12) and `src/main.ts`"),
      );
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe("settings.ts · L12 and main.ts");
    expect(renderer!.root.findAllByType("a")).toHaveLength(2);
    await act(async () => {
      renderer!.root.findAllByType("a")[0]!.props.onClick({
        preventDefault() {},
        stopPropagation() {},
      });
    });
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toMatchObject({
      activeSurfaceId: "file:docs/settings.ts",
      surfaces: [{ kind: "file", relativePath: "docs/settings.ts", revealLine: 12 }],
    });
  });

  it("updates between descriptive labels and path chips for the same destination", async () => {
    await act(async () => {
      renderer = create(renderMarkdown("[docs/settings.ts:12](docs/settings.ts:12)"));
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe("settings.ts · L12");
    await act(async () => {
      renderer!.update(renderMarkdown("[Default **settings**](docs/settings.ts:12)"));
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe("Default settings");
    await act(async () => {
      renderer!.update(renderMarkdown("[docs/settings.ts:12](docs/settings.ts:12)"));
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe("settings.ts · L12");
  });
});

describe("links in pending questions", () => {
  it("opens a project file without selecting, advancing, or dismissing the question", async () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    const onDismiss = vi.fn();
    await act(async () => {
      renderer = create(
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
    });
    const links = renderer!.root.findAllByType("a");
    const external = links.find((link) => link.props.href?.startsWith("https://example.com"));
    expect(external?.props.href).toBe("https://example.com/approval?request=demo_token");
    expect(visibleText(renderer!.toJSON())).toContain("the guide");
    await act(async () => {
      links
        .find((link) => link !== external)!
        .props.onClick({
          preventDefault() {},
          stopPropagation() {},
        });
    });
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toMatchObject({
      activeSurfaceId: "file:docs/settings.ts",
      surfaces: [{ kind: "file", relativePath: "docs/settings.ts", revealLine: 12 }],
    });
    expect(onToggleOption).not.toHaveBeenCalled();
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
