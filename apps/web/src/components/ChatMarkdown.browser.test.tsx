import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { remarkEnableOrderedListNumbers } from "@t3tools/shared/markdownPipeline";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { HostImageUrlContext } from "./chat/hostImageUrl";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
const parsedSources = vi.hoisted(() => [] as string[]);
vi.mock(import("mdast-util-from-markdown"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    fromMarkdown: ((source: string, ...rest: never[]) => {
      parsedSources.push(String(source));
      return (actual.fromMarkdown as (...args: unknown[]) => unknown)(source, ...rest);
    }) as typeof actual.fromMarkdown,
  };
});

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
  const modelsConfig = Atom.make({
    environment: { platform: { os: "darwin" } },
    availableEditors: [],
    settings: { providerInstances: {} },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        models: [{ slug: "gpt-6.1", name: "GPT-6.1", isCustom: false, capabilities: {} }],
      },
    ],
  });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: ((environmentId: string) =>
        environmentId === "models" ? modelsConfig : noConfig) as never,
    },
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
const appearance = vi.hoisted(() => ({
  value: "light" as "light" | "dark",
  listeners: new Set<() => void>(),
}));
vi.mock(import("../hooks/useTheme"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    appearance.listeners.add(listener);
    return () => appearance.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useRenderedAppearance: () => useSyncExternalStore(subscribe, () => appearance.value),
  };
});

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
import {
  ChatGithubRepositoryContext,
  GithubReferenceThreadContext,
} from "./chat/githubReferenceLinks";
import { serializeRenderedMarkdownFragment } from "../markdown-clipboard";
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

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

function setup() {
  appearance.value = "light";
  parsedSources.length = 0;
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

const SOURCE_NUMBER_PLUGINS = [remarkEnableOrderedListNumbers];

it("keeps decimal markers in nested user lists while documents keep their counter styles", async () => {
  setup();
  const text = "1. Outer\n   1. Nested\n   7. Skipped\n      1. Deeper\n      4. Fourth";
  await using screen = await render(
    <div className="grid grid-cols-2 gap-8 p-8">
      <section>
        <h2>User message</h2>
        <ChatMarkdown
          cwd={undefined}
          text={text}
          className="user-message-markdown"
          extraRemarkPlugins={SOURCE_NUMBER_PLUGINS}
        />
      </section>
      <section>
        <h2>Markdown preview</h2>
        <ChatMarkdown cwd={undefined} text={text} />
      </section>
    </div>,
  );
  await expect.element(screen.getByText("User message", { exact: true })).toBeVisible();
  const [message, preview] = screen.container.querySelectorAll(".chat-markdown");
  expect(
    [...message!.querySelectorAll("ol")].map((list) => getComputedStyle(list).listStyleType),
  ).toEqual(["decimal", "decimal", "decimal"]);
  expect(
    [...preview!.querySelectorAll("ol")].map((list) => getComputedStyle(list).listStyleType),
  ).toEqual(["decimal", "lower-alpha", "lower-roman"]);
});

it("shows unavailable audio when a workspace embed has no thread", async () => {
  setup();
  await using screen = await renderText("![recording](clip.wav)");
  expect(screen.container.textContent).toContain("Audio unavailable");
  expect(screen.container.textContent).not.toContain("Loading audio");
  expect(screen.container.querySelector("audio")).toBeNull();
});

it("loads a host image through the page's own route when there is no environment", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = vi.fn((_path: string) => pixel);
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown cwd={undefined} text="![Shot](</work/my shot.png>)" />
    </HostImageUrlContext>,
  );
  await expect.element(screen.getByAltText("Shot")).toHaveAttribute("src", pixel);
  expect(new Set(hostImageUrl.mock.calls.map(([path]) => path))).toEqual(
    new Set(["/work/my shot.png"]),
  );
  const renewed = `${pixel}#renewed`;
  await screen.rerender(
    <HostImageUrlContext value={() => renewed}>
      <ChatMarkdown cwd={undefined} text="![Shot](</work/my shot.png>)" />
    </HostImageUrlContext>,
  );
  await expect.element(screen.getByAltText("Shot")).toHaveAttribute("src", renewed);
});

it("loads the <picture> source for the current theme through the image route", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = (path: string) => `${pixel}#${path}`;
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown
        cwd={undefined}
        text={
          '<picture><source media="(prefers-color-scheme: dark)" srcset="/work/dark.png"><img src="/work/light.png" alt="Shot"></picture>'
        }
      />
    </HostImageUrlContext>,
  );
  await expect
    .element(screen.getByAltText("Shot"))
    .toHaveAttribute("src", `${pixel}#/work/light.png`);

  await act(() => {
    appearance.value = "dark";
    for (const listener of appearance.listeners) listener();
  });
  await expect
    .element(screen.getByAltText("Shot"))
    .toHaveAttribute("src", `${pixel}#/work/dark.png`);
});

it("reuses the parse of a streaming reply's finished blocks when it remounts", async () => {
  setup();
  const message = (
    <ChatMarkdown cwd="/tmp/project" text={"Finished block\n\nStill growing"} isStreaming />
  );
  {
    await using _first = await render(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Still growing")).toBeVisible();
  expect(parsedSources.filter((source) => source.includes("Finished block"))).toHaveLength(1);
});

it("reuses the parse of a remounted message that has stable extra plugins", async () => {
  setup();
  const parsed = vi.fn();
  const countingPlugins = [() => () => void parsed()];
  const message = (
    <ChatMarkdown cwd="/tmp/project" text="Cached text" extraRemarkPlugins={countingPlugins} />
  );
  {
    await using _first = await render(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Cached text")).toBeVisible();
  expect(parsed).toHaveBeenCalledTimes(1);
});

it("highlights a code block's own source when an earlier block of the same length was cached", async () => {
  setup();
  const highlightedText = (container: HTMLElement) =>
    container.querySelector(".chat-markdown-shiki")?.textContent?.trim();
  // These two lines share a 32-bit FNV-1a hash and a length.
  const first = 'const commitSha = "f36a6d8fe0aa";';
  const second = 'const commitSha = "cb06f8d135b3";';
  {
    await using screen = await renderText(`\`\`\`ts\n${first}\n\`\`\``);
    await vi.waitFor(() => expect(highlightedText(screen.container)).toBe(first));
  }
  await using screen = await renderText(`\`\`\`ts\n${second}\n\`\`\``);
  await vi.waitFor(() => expect(highlightedText(screen.container)).toBe(second));
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

describe("ChatMarkdown external link labels", () => {
  it("keeps a leading emoji whole", async () => {
    setup();
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text="[😀 Read the documentation](https://example.com)" />,
    );
    await vi.waitFor(() => {
      const link = screen.container.querySelector("a");
      expect(link?.textContent).toContain("😀 Read");
      const walker = document.createTreeWalker(link!, NodeFilter.SHOW_TEXT);
      const textNodes: string[] = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode.nodeValue ?? "");
      expect(textNodes.filter((node) => /\p{Surrogate}/u.test(node))).toEqual([]);
    });
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

describe("ChatMarkdown GitHub URL labels", () => {
  const text = [
    "https://github.com/example/project/pull/42",
    "https://github.com/other/repo/issues/7#issuecomment-1",
    "https://github.com/example/project/pull/42/files",
    "[the fix](https://github.com/example/project/pull/43)",
  ].join("\n\n");
  const labels = (container: HTMLElement) =>
    [...container.querySelectorAll("a")].map((anchor) => anchor.textContent);

  it("labels bare issue and pull request URLs as GitHub shorthand and copies the URL", async () => {
    setup();
    await using screen = await render(
      <ChatGithubRepositoryContext value={{ host: "github.com", repository: "example/project" }}>
        <ChatMarkdown cwd="/workspace/project" text={text} />
      </ChatGithubRepositoryContext>,
    );
    expect(labels(screen.container)).toEqual([
      "#42",
      "other/repo#7 (comment)",
      "https://github.com/example/project/pull/42/files",
      "the fix",
    ]);
    expect(screen.container.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/example/project/pull/42",
    );
    expect(serializeRenderedMarkdownFragment(screen.container)).toContain(
      "https://github.com/example/project/pull/42\n",
    );
  });

  it("names the repository outside a GitHub project", async () => {
    setup();
    await using screen = await render(<ChatMarkdown cwd="/workspace/project" text={text} />);
    expect(labels(screen.container).slice(0, 2)).toEqual([
      "example/project#42",
      "other/repo#7 (comment)",
    ]);
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
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);
    expect(checkboxes()[1]!.checked).toBe(false);
  });

  it.each([
    ["read-only", undefined],
    ["editable", () => {}],
  ])(
    "unchecks the remaining %s task when the checked row above it is removed",
    async (_, onTaskListChange) => {
      setup();
      const message = (text: string) => (
        <ChatMarkdown cwd="/tmp/project" text={text} onTaskListChange={onTaskListChange} />
      );
      await using screen = await render(message("- [x] Completed item\n- [ ] Pending item"));
      await screen.rerender(message("- [ ] Pending item"));
      const checkboxes =
        screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(checkboxes).toHaveLength(1);
      expect(checkboxes[0]!.checked).toBe(false);
    },
  );
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

  // regression: #18358 a missing slashed path opens the one indexed file ending with it
  it("opens a missing slashed path at its unique indexed suffix", async () => {
    setup();
    workspaceSearch.mockResolvedValue(
      AsyncResult.success({
        entries: [
          { path: "other/GROUPS_PLAN.md", kind: "file" },
          { path: "BudgetLens/mydocs/GROUPS_PLAN.md", kind: "file" },
          { path: "BudgetLens/docs/GROUPS_PLAN.md", kind: "file" },
        ],
        truncated: true,
      }),
    );
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText("[Plan](docs/GROUPS_PLAN.md:12)", {
      cwd: "/work",
      threadRef,
    });
    await act(async () => screen.container.querySelector("a")!.click());

    expect(filesystemMetadata).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: { paths: ["/work/docs/GROUPS_PLAN.md"] },
    });
    expect(openFile).toHaveBeenCalledExactlyOnceWith(
      threadRef,
      "BudgetLens/docs/GROUPS_PLAN.md",
      12,
    );
  });

  it("falls back to the original suffix when a repeated workspace prefix has no exact match", async () => {
    setup();
    workspaceSearch.mockResolvedValue(
      AsyncResult.success({
        entries: [{ path: "nested/project/docs/plan.md", kind: "file" }],
        truncated: false,
      }),
    );
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText("[Plan](project/docs/plan.md:12)", {
      cwd: "/work/project",
      threadRef,
    });
    await act(async () => screen.container.querySelector("a")!.click());
    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "nested/project/docs/plan.md", 12);
  });

  it.each(["file", "directory"] as const)(
    "opens an existing slashed %s path without searching the workspace",
    async (kind) => {
      setup();
      filesystemMetadata.mockResolvedValue(AsyncResult.success({ entries: [{ kind }] }));
      using openFile = vi
        .spyOn(useRightPanelStore.getState(), "openFile")
        .mockImplementation(() => {});
      await using screen = await renderText("[Plan](docs/GROUPS_PLAN.md:12)", {
        cwd: "/work",
        threadRef,
      });
      await act(async () => screen.container.querySelector("a")!.click());

      expect(workspaceSearch).not.toHaveBeenCalled();
      expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "docs/GROUPS_PLAN.md", 12);
    },
  );
});

describe("ChatMarkdown skill chips", () => {
  it("shows the skill's details and opens its instructions", async () => {
    setup();
    const threadRef = {
      environmentId: EnvironmentId.make("workspace"),
      threadId: ThreadId.make("thread"),
    };
    await using screen = await renderText("Run $review now", {
      threadRef,
      skills: [
        {
          name: "review",
          displayName: "Review",
          description: "Reviews the current branch.",
          path: "/skills/review/SKILL.md",
          enabled: true,
        },
      ],
    });
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});

    await userEvent.click(screen.getByRole("button", { name: "Skill Review. Show details" }));
    await expect.element(page.getByText("Reviews the current branch.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "View instructions" }));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/skills/review/SKILL.md");
  });

  it("names a mentioned model as its provider does, without a thread", async () => {
    setup();
    await using screen = await renderText("Ask (model:codex/gpt-6.1), not model:openai/gpt-4o.", {
      environmentId: EnvironmentId.make("models"),
    });

    await expect
      .element(screen.getByRole("button", { name: "Model GPT-6.1. Show details" }))
      .toBeVisible();
    expect(buttonsLabelled(screen.container, "Model gpt-4o. Show details")).toEqual([]);
    expect(screen.container.textContent).toBe("Ask (GPT-6.1), not model:openai/gpt-4o.");
  });
});

describe("ChatMarkdown headings", () => {
  it("keeps insight streaming, reference links, and heading anchors in one message", async () => {
    setup();
    const rule = "─".repeat(20);
    const text = `## Setup\n\nBefore [source][src].\n\n★ Insight ${rule}\nA **streaming** note.`;
    const message = (text: string, isStreaming: boolean) => (
      <ChatMarkdown
        cwd={undefined}
        text={text}
        renderInsights
        lineBreaks
        isStreaming={isStreaming}
      />
    );
    await using screen = await render(message(text, true));
    await expect.element(screen.getByRole("note")).toHaveTextContent("Insight A streaming note.");
    await screen.rerender(
      message(
        `${text}\n${rule}\n\n## Setup\n\nAfter [source][src].\n\n[src]:\n  https://example.com`,
        false,
      ),
    );
    await expect.element(screen.getByRole("note")).toHaveTextContent("Insight A streaming note.");
    expect([...screen.container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
    ]);
    expect(
      [...screen.container.querySelectorAll("a")].filter(
        (link) => link.href === "https://example.com/",
      ),
    ).toHaveLength(2);
    await expect.element(screen.getByRole("note")).not.toHaveTextContent("After");
  });

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

describe("ChatMarkdown inline code selection", () => {
  it("selects the whole inline code span on double-click, but only a word in fenced code", async () => {
    setup();
    await using screen = await renderText(
      "Run `migration-gate --dry-run` first.\n\n```txt\nfenced-block word\n```",
    );
    await userEvent.dblClick(screen.getByText("migration-gate --dry-run"));
    expect(window.getSelection()?.toString()).toBe("migration-gate --dry-run");

    window.getSelection()?.removeAllRanges();
    const fenced = screen.container.querySelector("pre code")!;
    await userEvent.dblClick(fenced, { position: { x: 4, y: 4 } });
    expect(window.getSelection()?.toString()).toBe("fenced");
  });

  it("selects the whole line on triple-click beside a favicon link or a file chip", async () => {
    setup();
    await using screen = await renderText(
      "Before [docs](https://example.com/docs) after words\n\nBefore [App.tsx](/tmp/project/src/App.tsx) after words",
    );
    const tripleClickWord = async (paragraph: HTMLElement, word: string) => {
      const text = [...paragraph.childNodes].find((node) => node.textContent?.includes(word))!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.indexOf(word));
      range.setEnd(text, text.textContent!.indexOf(word) + word.length);
      const wordBox = range.getBoundingClientRect();
      const paragraphBox = paragraph.getBoundingClientRect();
      window.getSelection()?.removeAllRanges();
      await userEvent.tripleClick(paragraph, {
        position: {
          x: wordBox.left - paragraphBox.left + wordBox.width / 2,
          y: wordBox.top - paragraphBox.top + wordBox.height / 2,
        },
      });
      return window.getSelection()?.toString().trim();
    };

    const paragraphs = screen.container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    const selections = [];
    const lines = [];
    for (const paragraph of paragraphs) {
      lines.push(paragraph.textContent?.trim(), paragraph.textContent?.trim());
      selections.push(
        await tripleClickWord(paragraph, "Before"),
        await tripleClickWord(paragraph, "after"),
      );
    }
    expect(selections).toEqual(lines);
  });
});

describe("ChatMarkdown file chip tooltips", () => {
  it("wraps a long path so its file name stays inside the tooltip", async () => {
    setup();
    const path =
      "/tmp/project/packages/client-runtime/src/state/generated/environment-connection-handshake-retry-policy-fixtures.ts";
    // A descriptive label keeps its text without a chip, so the label names the file.
    await using screen = await renderText(
      `See [environment-connection-handshake-retry-policy-fixtures.ts](${path}).`,
    );

    await userEvent.hover(screen.container.querySelector(".chat-markdown-file-link")!);
    const tooltip = page.getByText(path);
    await expect.element(tooltip).toBeVisible();

    const popup = tooltip.element().closest("[data-side]")!;
    const pathEnd = document.createRange();
    pathEnd.selectNodeContents(tooltip.element());
    expect(pathEnd.getBoundingClientRect().right).toBeLessThanOrEqual(
      popup.getBoundingClientRect().right,
    );
  });
});

describe("ChatMarkdown editor deep links", () => {
  const hrefs = (container: HTMLElement) =>
    [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));

  it("keeps local editor file links", async () => {
    setup();
    await using screen = await renderText(
      "[file.md line 3](cursor://file/Users/me/repo/file.md:3) and [same](vscode://file/Users/me/repo/file.md:3:7)",
    );
    expect(hrefs(screen.container)).toEqual([
      "cursor://file/Users/me/repo/file.md:3",
      "vscode://file/Users/me/repo/file.md:3:7",
    ]);
  });

  it("still drops other editor links and unknown schemes", async () => {
    setup();
    await using screen = await renderText(
      "[prompt](cursor://anysphere.cursor-deeplink/prompt?text=hi) [user](cursor://me@file/Users/me/file.md) [unknown](foo://file/Users/me/file.md)",
    );
    expect(screen.container.innerHTML).not.toContain("://");
    expect(hrefs(screen.container).filter(Boolean)).toEqual([]);
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
