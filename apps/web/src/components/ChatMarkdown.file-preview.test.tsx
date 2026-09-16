import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: () => vi.fn(),
  useAtomValue: () => ({ _tag: "Initial", waiting: false }),
}));
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
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: vi.fn(() => vi.fn()),
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import ChatMarkdown from "./ChatMarkdown";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";
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

describe("Markdown file preview links", () => {
  it.each([
    "[Organizing **threads**](docs/thread-sidebar.md)",
    "- [Organizing **threads**](docs/thread-sidebar.md)",
    "1. [Organizing **threads**][guide]\n\n[guide]: docs/thread-sidebar.md",
  ])("keeps authored text and opens the linked file: %s", async (text) => {
    await act(async () => {
      renderer = create(
        <FileMarkdownPreview
          cwd="/workspace/project"
          relativePath="README.md"
          text={text}
          threadRef={threadRef}
        />,
      );
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe("Organizing threads");
    expect(renderer!.root.findByType("strong").children).toEqual(["threads"]);

    await act(async () => {
      renderer!.root.findByType("a").props.onClick({
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

  it("keeps path labels and inline code as authored while opening a requested line", async () => {
    await act(async () => {
      renderer = create(
        <FileMarkdownPreview
          cwd="/workspace/project"
          relativePath="README.md"
          text="[docs/settings.ts:12](docs/settings.ts:12) and `src/main.ts`"
          threadRef={threadRef}
        />,
      );
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe("docs/settings.ts:12 and src/main.ts");
    expect(renderer!.root.findAllByType("a")).toHaveLength(1);
    expect(renderer!.root.findByType("code").children).toEqual(["src/main.ts"]);
    await act(async () => {
      renderer!.root.findByType("a").props.onClick({
        preventDefault() {},
        stopPropagation() {},
      });
    });
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toMatchObject({
      activeSurfaceId: "file:docs/settings.ts",
      surfaces: [{ kind: "file", relativePath: "docs/settings.ts", revealLine: 12 }],
    });
  });

  it("switches between chat chips and document text without changing the Markdown", async () => {
    const text = "- [Organizing threads](docs/thread-sidebar.md) and `src/main.ts`";
    await act(async () => {
      renderer = create(
        <ChatMarkdown cwd="/workspace/project" text={text} threadRef={threadRef} />,
      );
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe(
      "Organizing threads thread-sidebar.md and main.ts",
    );
    await act(async () => {
      renderer!.update(
        <ChatMarkdown
          cwd="/workspace/project"
          text={text}
          threadRef={threadRef}
          fileLinkStyle="text"
        />,
      );
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe("Organizing threads and src/main.ts");
    await act(async () => {
      renderer!.update(<ChatMarkdown cwd="/workspace/project" text={text} threadRef={threadRef} />);
    });
    expect(visibleText(renderer!.toJSON()).trim()).toBe(
      "Organizing threads thread-sidebar.md and main.ts",
    );
  });
});
