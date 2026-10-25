import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

// Records which thread full PR links route through, without changing how they open.
vi.mock(import("~/lib/openPullRequestLink"), async (original) => {
  const actual = await original();
  return { ...actual, useOpenChangeRequestLink: vi.fn(actual.useOpenChangeRequestLink) };
});

import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import { GithubReferenceThreadContext } from "./chat/githubReferenceLinks";
import { AudioPreview } from "./files/AudioPreview";

it("keeps compact audio playback loaded across signed URL renewals", async () => {
  const original =
    "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
  const renewed = `${original}#renewed`;
  const preview = (src: string, revision = "clip-v1") => (
    <AudioPreview compact name="clip.wav" src={src} revision={revision} />
  );
  await using screen = await render(preview(original));
  const audio = screen.container.querySelector("audio")!;
  await act(() => {
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("play"));
  });
  await screen.rerender(preview(renewed));
  expect(screen.container.querySelector("audio")).toBe(audio);
  expect(audio.getAttribute("src")).toBe(original);
  await expect.element(screen.getByRole("button", { name: "Pause clip.wav" })).toBeEnabled();
  await screen.rerender(preview(renewed, "clip-v2"));
  expect(screen.container.querySelector("audio")).not.toBe(audio);
  expect(screen.container.querySelector("audio")?.getAttribute("src")).toBe(renewed);
});

function setup() {
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

describe("ChatMarkdown table layout", () => {
  it.each([
    { width: 36, timeline: true, fits: true },
    { width: 48, timeline: true, fits: true },
    { width: 35, timeline: true, fits: true },
    { width: 48, timeline: false, fits: true },
  ])(
    "wraps expanded cells with fit=$fits in a $width rem container (timeline=$timeline)",
    async ({ width, timeline, fits }) => {
      setup();
      await using screen = await render(
        <div style={{ width: `${width}rem` }}>
          <div className={timeline ? "@container/chat-lane chat-content-lane overflow-x-clip" : ""}>
            <ChatMarkdown
              cwd={undefined}
              text={[
                "| Change summary | Reason details | Verification status | Release impact | Followup actions |",
                "| --- | --- | --- | --- | --- |",
                "| Keep the complete explanation readable when the table is expanded in the conversation. | Allow each column to wrap its prose within the available space in the current chat lane. | Collapse and expand the table again to check that the text still fits and remains readable. | Keep the existing layout for narrow chat lanes and file previews. | Check the table again after resizing the conversation lane. |",
              ].join("\n")}
            />
          </div>
        </div>,
      );
      const { container } = screen;
      const table = container.querySelector("table")!;
      const viewport = table.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      const cell = table.tBodies[0]!.rows[0]!.cells[0]!;
      const collapse = () => buttonsLabelled(container, "Collapse table cells")[0];
      if (collapse()) await act(async () => collapse()!.click());

      const collapsedWidth = table.getBoundingClientRect().width;
      const collapsedHeight = cell.getBoundingClientRect().height;
      expect(viewport.clientWidth).toBeGreaterThan(0);
      expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
      expect(cell.scrollWidth).toBe(cell.clientWidth);

      await act(async () => buttonsLabelled(container, "Expand table cells")[0]!.click());
      const expandedWidth = table.getBoundingClientRect().width;
      const expandedHeight = cell.getBoundingClientRect().height;
      if (fits) {
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
        expect(expandedWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
      } else {
        expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        viewport.scrollLeft = 100;
        expect(viewport.scrollLeft).toBeGreaterThan(0);
      }
      expect(expandedHeight).toBeGreaterThan(collapsedHeight);

      await act(async () => collapse()!.click());
      expect(table.getBoundingClientRect().width).toBeCloseTo(collapsedWidth, 0);
      expect(cell.getBoundingClientRect().height).toBeCloseTo(collapsedHeight, 0);
      await act(async () => buttonsLabelled(container, "Expand table cells")[0]!.click());
      expect(table.getBoundingClientRect().width).toBeCloseTo(expandedWidth, 0);
      expect(cell.getBoundingClientRect().height).toBeCloseTo(expandedHeight, 0);
    },
  );
});

describe("ChatMarkdown table wrap toggle", () => {
  const table = (cell: string) => `| Name | Value |\n| --- | --- |\n| one | ${cell} |`;

  function renderTable(cell: string) {
    const container = document.createElement("div");
    container.style.width = "320px";
    return render(<ChatMarkdown cwd="/tmp/project" text={table(cell)} />, { container });
  }

  it("offers the toggle when the unwrapped table is wider than its scroll area", async () => {
    setup();
    await using screen = await renderTable("word ".repeat(80));
    const host = screen.container;

    // Word wrap is on by default, so the table starts wrapped.
    const [toggle] = buttonsLabelled(host, "Collapse table cells");
    expect(toggle).toBeDefined();
    await act(async () => toggle!.click());
    expect(buttonsLabelled(host, "Expand table cells")).toHaveLength(1);
  });

  it("hides the toggle when the table fits", async () => {
    setup();
    await using screen = await renderTable("short");
    const host = screen.container;

    expect(buttonsLabelled(host, "Expand table cells")).toHaveLength(0);
    expect(buttonsLabelled(host, "Collapse table cells")).toHaveLength(0);
  });
});

it("shows unavailable audio when a workspace embed has no thread", async () => {
  setup();
  await using screen = await renderText("![recording](clip.wav)");
  expect(screen.container.textContent).toContain("Audio unavailable");
  expect(screen.container.textContent).not.toContain("Loading audio");
  expect(screen.container.querySelector("audio")).toBeNull();
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

const surfaceThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("surface-thread"),
};
const chatThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("chat-thread"),
};

describe("ChatMarkdown PR link thread context", () => {
  const text = "[Next PR](https://github.com/example/project/pull/42)";

  it("routes full PR URLs using the surrounding PR tab's thread", async () => {
    setup();
    await using _screen = await render(
      <GithubReferenceThreadContext.Provider value={surfaceThreadRef}>
        <ChatMarkdown cwd="/workspace/project" text={text} />
      </GithubReferenceThreadContext.Provider>,
    );
    expect(useOpenChangeRequestLink).toHaveBeenLastCalledWith(surfaceThreadRef, undefined);
  });

  it("prefers the chat's explicit thread over the surrounding surface", async () => {
    setup();
    await using _screen = await render(
      <GithubReferenceThreadContext.Provider value={surfaceThreadRef}>
        <ChatMarkdown cwd="/workspace/project" text={text} threadRef={chatThreadRef} />
      </GithubReferenceThreadContext.Provider>,
    );
    expect(useOpenChangeRequestLink).toHaveBeenLastCalledWith(chatThreadRef, undefined);
  });

  it("keeps standalone PR pages without a thread target", async () => {
    setup();
    await using _screen = await render(<ChatMarkdown cwd="/workspace/project" text={text} />);
    expect(useOpenChangeRequestLink).toHaveBeenLastCalledWith(undefined, undefined);
  });
});

describe("ChatMarkdown shell scripts", () => {
  const onRunShellCommand = vi.fn();

  function setupScripts() {
    setup();
    onRunShellCommand.mockClear();
  }

  const renderScript = async (script: string) =>
    renderText(`\`\`\`bash\n${script}\n\`\`\``, { isStreaming: false, onRunShellCommand });
  const playButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Run "]');
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const dialogButton = (label: string) =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === label,
    );
  const click = (button: HTMLButtonElement | null | undefined) => {
    if (!button) throw new Error("Missing shell script button");
    return act(async () => button.click());
  };

  it("confirms a multi-line script before running it", async () => {
    setupScripts();
    const script = "vp i\ncat > .env <<'EOF'\nA=1\nEOF";
    await using screen = await renderScript(script);
    await click(playButton(screen.container));
    expect(dialog()?.textContent).toContain("Run 4 lines in terminal?");
    expect(onRunShellCommand).not.toHaveBeenCalled();

    await click(dialogButton("Run"));
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith(script);
  });

  it("does not run a multi-line script when the dialog is cancelled", async () => {
    setupScripts();
    await using screen = await renderScript("echo one\necho two");
    await click(playButton(screen.container));
    await click(dialogButton("Cancel"));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(onRunShellCommand).not.toHaveBeenCalled();
  });

  it("closes the dialog when the script changes after it opens", async () => {
    setupScripts();
    const message = (script: string) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={`\`\`\`bash\n${script}\n\`\`\``}
        isStreaming={false}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("echo one\necho two"));
    const { container, rerender } = screen;
    await click(playButton(container));
    await rerender(message("echo one\necho three"));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await rerender(message("echo one\necho two"));
    expect(dialog()).toBeNull();
    expect(onRunShellCommand).not.toHaveBeenCalled();
  });

  it.each(["echo one\necho two\\", "$ echo one\noutput", "echo one\necho \u202etwo", "echo\tone"])(
    "does not offer to run %j",
    async (script) => {
      setupScripts();
      await using screen = await renderScript(script);
      expect(playButton(screen.container)).toBeNull();
    },
  );
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () =>
      [...container.querySelectorAll("button")].filter((button) =>
        button.getAttribute("aria-label")?.startsWith("Run "),
      );
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });
});

describe("ChatMarkdown descriptive file links", () => {
  const copyMarkdown = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-markdown-copy]")].map((element) =>
      element.getAttribute("data-markdown-copy"),
    );

  it.each([true, false])(
    "preserves descriptive file link text with parseRawHtml=%s",
    async (parseRawHtml) => {
      const href = "/workspace/project/.scratch/review.md";
      const label = "corrected the packet and reassessed the chain";
      setup();
      await using screen = await renderText(
        `I've [${label}](${href}). My recommendation follows.`,
        { cwd: "/workspace/project", environmentId: surfaceThreadRef.environmentId, parseRawHtml },
      );
      const { container } = screen;
      const links = [...container.querySelectorAll("a")];
      expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
        [href, label],
      ]);
      expect(container.textContent).toContain(`${label}. My recommendation follows.`);
      expect(copyMarkdown(container)).toContain(`[${label}](${href})`);
      expect(container.querySelector(".chat-markdown-file-link")).toBeNull();
    },
  );

  it("preserves emphasis and inline code inside descriptive file links", async () => {
    setup();
    await using screen = await renderText(
      "[Read **the updated** `docs/review.md` report](/workspace/project/review.md)",
      { cwd: "/workspace/project" },
    );
    const { container } = screen;
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-haspopup")).toBe("menu");
    expect(buttons[0]!.innerHTML).toContain(
      'Read <strong>the updated</strong> <code dir="ltr">docs/review.md</code> report',
    );
    expect(copyMarkdown(container)).toContain(
      "[Read **the updated** `docs/review.md` report](/workspace/project/review.md)",
    );
  });

  it("keeps reference-link labels with line numbers in the destination", async () => {
    setup();
    await using screen = await renderText(
      "See the [**schema**][settings].\n\n[settings]: /workspace/project/settings.ts:157",
      { cwd: "/workspace/project", environmentId: surfaceThreadRef.environmentId },
    );
    const { container } = screen;
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a strong")?.textContent).toBe("schema");
    expect(container.textContent).not.toContain("settings.ts · L157");
    expect(copyMarkdown(container)).toContain("[**schema**](/workspace/project/settings.ts:157)");
  });

  it.each(["review.md", "review.md:12", "docs/review.md", "/workspace/project/docs/review.md"])(
    "keeps path label %s as a compact file chip",
    async (label) => {
      setup();
      await using screen = await renderText(`[${label}](/workspace/project/docs/review.md:12)`, {
        cwd: "/workspace/project",
      });
      const { container } = screen;
      expect(container.querySelector(".chat-markdown-file-link")).not.toBeNull();
      expect(container.querySelector(".chat-markdown-file-reference")).toBeNull();
      expect(container.textContent).toContain("review.md · L12");
    },
  );
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown headings", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});
