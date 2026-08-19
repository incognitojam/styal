import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { withPreservedPreviewAutomationFocus } from "./previewAutomationFocus";

class MockHTMLElement {
  isConnected = true;
  readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;
const originalWindow = globalThis.window;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window & typeof globalThis }).window;
  } else {
    globalThis.window = originalWindow;
  }
});

function setupFocusDocument(runtimeTabIds: ReadonlyArray<string> = ["runtime-tab"]) {
  const body = new MockHTMLElement("BODY");
  const composer = new MockHTMLElement("DIV");
  const otherControl = new MockHTMLElement("BUTTON");
  const webviews = runtimeTabIds.map((runtimeTabId) => {
    const webview = new MockHTMLElement("WEBVIEW");
    webview.attributes.set("data-preview-tab", runtimeTabId);
    return webview;
  });
  const focusInListeners = new Set<() => void>();
  const pointerDownListeners = new Set<(event: PointerEvent) => void>();
  const emitFocusIn = () => {
    for (const listener of Array.from(focusInListeners)) listener();
  };
  const documentStub = {
    activeElement: composer as unknown as Element,
    body,
    querySelectorAll: vi.fn(() => webviews),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === "focusin") focusInListeners.add(listener as () => void);
      if (type === "pointerdown") {
        pointerDownListeners.add(listener as (event: PointerEvent) => void);
      }
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === "focusin") focusInListeners.delete(listener as () => void);
      if (type === "pointerdown") {
        pointerDownListeners.delete(listener as (event: PointerEvent) => void);
      }
    }),
  };
  const focus = vi.fn(() => {
    documentStub.activeElement = composer as unknown as Element;
    emitFocusIn();
  });
  Object.assign(composer, { focus });

  globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
  globalThis.document = documentStub as unknown as Document;
  globalThis.window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  } as unknown as Window & typeof globalThis;

  return {
    composer,
    otherControl,
    webview: webviews[0]!,
    webviews,
    focus,
    documentStub,
    emitFocusIn,
    emitPointerDown: (target: MockHTMLElement) => {
      const event = { isTrusted: true, composedPath: () => [target] } as unknown as PointerEvent;
      for (const listener of Array.from(pointerDownListeners)) listener(event);
    },
  };
}

describe("withPreservedPreviewAutomationFocus", () => {
  it("restores a connected control when delayed focus lands on the automated webview", async () => {
    const fixture = setupFocusDocument();

    await withPreservedPreviewAutomationFocus("runtime-tab", async () => undefined);
    fixture.documentStub.activeElement = fixture.webview as unknown as Element;
    fixture.emitFocusIn();

    expect(fixture.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fixture.documentStub.activeElement).toBe(fixture.composer);
    vi.advanceTimersByTime(250);
    expect(fixture.documentStub.removeEventListener).toHaveBeenCalled();
  });

  it("restores the control immediately when the webview focuses during automation", async () => {
    const fixture = setupFocusDocument();
    let finishOperation: (() => void) | undefined;
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const guarded = withPreservedPreviewAutomationFocus("runtime-tab", () => operation);

    fixture.documentStub.activeElement = fixture.webview as unknown as Element;
    fixture.emitFocusIn();

    expect(fixture.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fixture.documentStub.activeElement).toBe(fixture.composer);
    finishOperation?.();
    await guarded;
  });

  it("does not override a focus change to another T3 control", async () => {
    const fixture = setupFocusDocument();
    let finishOperation: (() => void) | undefined;
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const guarded = withPreservedPreviewAutomationFocus("runtime-tab", () => operation);

    fixture.documentStub.activeElement = fixture.otherControl as unknown as Element;
    fixture.emitFocusIn();
    finishOperation?.();
    await guarded;
    fixture.documentStub.activeElement = fixture.webview as unknown as Element;
    fixture.emitFocusIn();

    expect(fixture.focus).not.toHaveBeenCalled();
  });

  it("allows an intentional user pointer interaction with the automated webview", async () => {
    const fixture = setupFocusDocument();
    let finishOperation: (() => void) | undefined;
    const guarded = withPreservedPreviewAutomationFocus(
      "runtime-tab",
      () =>
        new Promise<void>((resolve) => {
          finishOperation = resolve;
        }),
    );

    fixture.emitPointerDown(fixture.webview);
    fixture.documentStub.activeElement = fixture.webview as unknown as Element;
    fixture.emitFocusIn();
    finishOperation?.();
    await guarded;

    expect(fixture.focus).not.toHaveBeenCalled();
    expect(fixture.documentStub.activeElement).toBe(fixture.webview);
  });

  it("does not restore a control that disconnected while automation ran", async () => {
    const fixture = setupFocusDocument();

    await withPreservedPreviewAutomationFocus("runtime-tab", async () => undefined);
    fixture.composer.isConnected = false;
    fixture.documentStub.activeElement = fixture.webview as unknown as Element;
    fixture.emitFocusIn();

    expect(fixture.focus).not.toHaveBeenCalled();
  });

  it("preserves both guards when two tabs focus and complete in reverse order", async () => {
    const fixture = setupFocusDocument(["runtime-a", "runtime-b"]);
    let finishA: (() => void) | undefined;
    let finishB: (() => void) | undefined;
    const guardedA = withPreservedPreviewAutomationFocus(
      "runtime-a",
      () =>
        new Promise<void>((resolve) => {
          finishA = resolve;
        }),
    );
    const guardedB = withPreservedPreviewAutomationFocus(
      "runtime-b",
      () =>
        new Promise<void>((resolve) => {
          finishB = resolve;
        }),
    );

    fixture.documentStub.activeElement = fixture.webviews[1] as unknown as Element;
    fixture.emitFocusIn();
    expect(fixture.documentStub.activeElement).toBe(fixture.composer);

    finishB?.();
    await guardedB;

    fixture.documentStub.activeElement = fixture.webviews[0] as unknown as Element;
    fixture.emitFocusIn();
    expect(fixture.documentStub.activeElement).toBe(fixture.composer);

    finishA?.();
    await guardedA;
    expect(fixture.focus).toHaveBeenCalledTimes(2);
  });

  it("retains the focus guard when the automation operation fails", async () => {
    const fixture = setupFocusDocument();
    const failure = new Error("click failed");

    await expect(
      withPreservedPreviewAutomationFocus("runtime-tab", () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    fixture.documentStub.activeElement = fixture.webview as unknown as Element;
    fixture.emitFocusIn();

    expect(fixture.focus).toHaveBeenCalledWith({ preventScroll: true });
    vi.advanceTimersByTime(250);
    expect(fixture.documentStub.removeEventListener).toHaveBeenCalled();
  });
});
