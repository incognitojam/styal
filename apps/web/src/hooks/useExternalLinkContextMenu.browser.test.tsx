import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

import { useExternalLinkContextMenu } from "./useExternalLinkContextMenu";

const harness = vi.hoisted(() => ({
  thread: { linked: false } as { linked: boolean } | null,
  canLink: true,
  previewSupported: false,
  selection: null as string | null,
  show: vi.fn(
    async (
      _items: ReadonlyArray<{ id: string; label: string }>,
      _position: { x: number; y: number },
    ): Promise<string | null> => harness.selection,
  ),
  changeLink: vi.fn(async (_ref: unknown, _url: string, linked: boolean) => {
    harness.thread = { linked };
  }),
  copy: vi.fn(async () => {}),
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => harness.thread) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("./usePullRequestLinking"), async (original) => ({
  ...(await original()),
  usePullRequestLinking: (() => ({
    canLink: () => harness.canLink,
    isLinked: (thread: { linked: boolean } | null) => thread?.linked === true,
    changeLink: harness.changeLink,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({
    contextMenu: { show: harness.show },
    shell: { openExternal: vi.fn() },
  })) as never,
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  isPreviewSupportedInRuntime: () => harness.previewSupported,
}));
vi.mock(import("./useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: harness.copy as never,
}));

const threadRef = {
  environmentId: EnvironmentId.make("menu-environment"),
  threadId: ThreadId.make("menu-thread"),
};
const url = "https://github.com/example/project/pull/42";

async function withMenu(
  ref: typeof threadRef | undefined,
  run: (open: () => void) => Promise<void>,
) {
  let open = () => {};
  function Consumer() {
    const { onContextMenu } = useExternalLinkContextMenu(ref);
    useLayoutEffect(() => {
      open = () =>
        onContextMenu(
          { preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 8 } as Parameters<
            typeof onContextMenu
          >[0],
          url,
        );
    }, [onContextMenu]);
    return null;
  }
  await using _screen = await render(<Consumer />);
  await run(() => open());
}

describe("shared link menu thread state", () => {
  it("links and unlinks against the latest thread state without rerendering", async () => {
    harness.thread = { linked: false };
    harness.canLink = true;
    harness.previewSupported = false;
    harness.changeLink.mockClear();
    harness.show.mockClear();
    await withMenu(threadRef, async (open) => {
      harness.selection = "link-to-thread";
      await act(open);
      expect(harness.thread?.linked).toBe(true);
      expect(harness.changeLink).toHaveBeenLastCalledWith(threadRef, url, true);
      expect(harness.show.mock.calls.at(-1)?.[0]).toContainEqual({
        id: "link-to-thread",
        label: "Link to thread",
      });
      harness.selection = "unlink-from-thread";
      await act(open);
      expect(harness.thread?.linked).toBe(false);
      expect(harness.changeLink).toHaveBeenLastCalledWith(threadRef, url, false);
      expect(harness.show.mock.calls.at(-1)?.[0]).toContainEqual({
        id: "unlink-from-thread",
        label: "Unlink from thread",
      });
    });
  });

  it.each([undefined, threadRef])(
    "keeps copying available without a linkable thread (%s)",
    async (ref) => {
      harness.thread = null;
      harness.canLink = false;
      harness.previewSupported = true;
      harness.selection = "copy-link";
      harness.copy.mockClear();
      await withMenu(ref, async (open) => {
        await act(open);
        expect(harness.copy).toHaveBeenCalledWith(url, "link");
        const items = harness.show.mock.calls.at(-1)?.[0];
        expect(items).not.toContainEqual({ id: "link-to-thread", label: "Link to thread" });
        expect(items).not.toContainEqual({ id: "unlink-from-thread", label: "Unlink from thread" });
        expect(items?.some((item: { id: string }) => item.id === "open-in-preview")).toBe(
          Boolean(ref),
        );
      });
    },
  );
});
