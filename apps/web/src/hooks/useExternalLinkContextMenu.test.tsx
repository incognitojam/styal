import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("~/state/entities", () => ({ readThreadShell: () => harness.thread }));
vi.mock("./usePullRequestLinking", () => ({
  usePullRequestLinking: () => ({
    canLink: () => harness.canLink,
    isLinked: (thread: { linked: boolean } | null) => thread?.linked === true,
    changeLink: harness.changeLink,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: harness.show }, shell: { openExternal: vi.fn() } }),
}));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => harness.previewSupported,
}));
vi.mock("./useCopyToClipboard", () => ({ writeTextToClipboard: harness.copy }));

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
  const renderer = await act(() => create(<Consumer />));
  try {
    await run(() => open());
  } finally {
    await act(() => renderer.unmount());
  }
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
