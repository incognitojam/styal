import { describe, expect, it, vi } from "vite-plus/test";

import { type HostFocusElement, keepHostFocusDuringGuestInput } from "./previewHostFocus";

const TAB = "runtime-tab";

const element = (tagName: string, previewTab: string | null = null) => {
  const focus = vi.fn<(options?: FocusOptions) => void>();
  const blur = vi.fn<() => void>();
  let connected = true;
  const node = {
    tagName,
    get isConnected() {
      return connected;
    },
    getAttribute: (name: string) => (name === "data-preview-tab" ? previewTab : null),
    focus,
    blur,
  } satisfies HostFocusElement;
  const detach = () => {
    connected = false;
  };
  return { node, focus, blur, detach };
};

const focusTracker = (initial: HostFocusElement | null) => {
  let active = initial;
  return {
    read: () => active,
    move: (next: HostFocusElement | null) => {
      active = next;
    },
  };
};

describe("keepHostFocusDuringGuestInput", () => {
  it("returns focus to the composer when the click moved it into the clicked webview", async () => {
    const composer = element("TEXTAREA");
    const webview = element("WEBVIEW", TAB);
    const focus = focusTracker(composer.node);

    const result = await keepHostFocusDuringGuestInput(TAB, focus.read, async () => {
      focus.move(webview.node);
      return "clicked";
    });

    expect(result).toBe("clicked");
    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(webview.blur).not.toHaveBeenCalled();
  });

  it("blurs the webview when nothing in the app had focus before the click", async () => {
    const body = element("BODY");
    const webview = element("WEBVIEW", TAB);
    const focus = focusTracker(body.node);

    await keepHostFocusDuringGuestInput(TAB, focus.read, async () => {
      focus.move(webview.node);
    });

    expect(webview.blur).toHaveBeenCalledOnce();
    expect(body.focus).not.toHaveBeenCalled();
  });

  it("blurs the webview when the previously focused element left the page", async () => {
    const composer = element("TEXTAREA");
    const webview = element("WEBVIEW", TAB);
    const focus = focusTracker(composer.node);

    await keepHostFocusDuringGuestInput(TAB, focus.read, async () => {
      composer.detach();
      focus.move(webview.node);
    });

    expect(composer.focus).not.toHaveBeenCalled();
    expect(webview.blur).toHaveBeenCalledOnce();
  });

  it("leaves focus in the page when the user was already typing there", async () => {
    const webview = element("WEBVIEW", TAB);
    const focus = focusTracker(webview.node);

    await keepHostFocusDuringGuestInput(TAB, focus.read, async () => undefined);

    expect(webview.focus).not.toHaveBeenCalled();
    expect(webview.blur).not.toHaveBeenCalled();
  });

  it("keeps a selection the user made somewhere else during the click", async () => {
    const composer = element("TEXTAREA");
    const search = element("INPUT");
    const focus = focusTracker(composer.node);

    await keepHostFocusDuringGuestInput(TAB, focus.read, async () => {
      focus.move(search.node);
    });

    expect(composer.focus).not.toHaveBeenCalled();
    expect(search.blur).not.toHaveBeenCalled();
  });

  it("ignores focus in a different preview tab", async () => {
    const composer = element("TEXTAREA");
    const otherWebview = element("WEBVIEW", "other-tab");
    const focus = focusTracker(composer.node);

    await keepHostFocusDuringGuestInput(TAB, focus.read, async () => {
      focus.move(otherWebview.node);
    });

    expect(composer.focus).not.toHaveBeenCalled();
    expect(otherWebview.blur).not.toHaveBeenCalled();
  });

  it("restores focus when the click fails and rethrows the failure", async () => {
    const composer = element("TEXTAREA");
    const webview = element("WEBVIEW", TAB);
    const focus = focusTracker(composer.node);

    await expect(
      keepHostFocusDuringGuestInput(TAB, focus.read, async () => {
        focus.move(webview.node);
        throw new Error("click failed");
      }),
    ).rejects.toThrow("click failed");

    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
