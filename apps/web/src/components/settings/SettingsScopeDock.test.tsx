// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const motion = vi.hoisted(() => ({
  start: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel: vi.fn() })),
  reducedMotion: false,
  pathname: "/settings/general",
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: motion.pathname }),
}));

vi.mock("./SettingsScopeSentence", () => ({
  SETTINGS_DEVICE_ONLY_PATHS: new Set(["/settings/appearance"]),
  SettingsScopeSentence: function Sentence({ compact }: { compact: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(!open)}>
          {compact ? "Project" : "Applying settings for"}
        </button>
        {open ? <input aria-label="Project menu search" /> : null}
      </>
    );
  },
}));

import {
  SettingsScopeDockProvider,
  SettingsScopeInline,
  SettingsScopeToolbar,
} from "./SettingsScopeDock";

let root: Root;
let container: HTMLDivElement;
let resize: () => void;
let sourceTop: number;
let sourceHeight: number;
let disconnect: ReturnType<typeof vi.fn>;

function fixture(pageKey = "initial") {
  return (
    <SettingsScopeDockProvider>
      <header>
        <SettingsScopeToolbar />
      </header>
      <div key={pageKey} data-settings-page-scroll>
        <SettingsScopeInline />
      </div>
    </SettingsScopeDockProvider>
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  disconnect = vi.fn();
  sourceTop = 24;
  sourceHeight = 24;
  motion.reducedMotion = false;
  motion.pathname = "/settings/general";
  motion.start.mockClear();
  vi.stubGlobal("matchMedia", () => ({ matches: motion.reducedMotion }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroll = container.querySelector<HTMLElement>("[data-settings-page-scroll]");
    // A pinned height wins over the sentence's natural height, as in layout.
    return this.hasAttribute("data-settings-scope-source")
      ? new DOMRect(
          0,
          sourceTop - (scroll?.scrollTop ?? 0),
          400,
          Number.parseFloat(this.style.height) || sourceHeight,
        )
      : new DOMRect(0, 0, 400, 600);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => {
    root.render(fixture());
  });
  const host = container.querySelector("[data-settings-scope-source]")!.firstElementChild!;
  Object.assign(host, { animate: motion.start });
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function scrollTo(top: number) {
  await act(() => {
    const scroll = container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
    scroll.scrollTop = top;
    scroll.dispatchEvent(new Event("scroll"));
  });
}

describe("settings scope docking", () => {
  it("replaces page content without entrance motion and still animates subsequent scrolling", async () => {
    const button = container.querySelector("button")!;
    for (const page of ["general", "providers", "general-again"]) {
      await act(() => root.render(fixture(page)));
      expect(container.querySelector("[data-settings-scope-source]")!.contains(button)).toBe(true);
    }
    expect(motion.start).not.toHaveBeenCalled();

    await scrollTo(50);
    expect(container.querySelector("header")!.contains(button)).toBe(true);
    expect(motion.start).toHaveBeenCalledOnce();

    await act(() => root.render(fixture("replacement-while-docked")));
    expect(container.querySelector("[data-settings-scope-source]")!.contains(button)).toBe(true);
    expect(motion.start).toHaveBeenCalledOnce();
    await scrollTo(50);
    expect(motion.start).toHaveBeenCalledTimes(2);
  });

  it("establishes placement after layout changes without animating", async () => {
    sourceTop = -60;
    await act(() => resize());
    expect(container.querySelector("header")!.contains(container.querySelector("button"))).toBe(
      true,
    );
    sourceTop = 24;
    await act(() => resize());
    expect(
      container
        .querySelector("[data-settings-scope-source]")!
        .contains(container.querySelector("button")),
    ).toBe(true);
    expect(motion.start).not.toHaveBeenCalled();
  });

  it("animates only threshold crossings and cancels interrupted motion", async () => {
    expect(motion.start).not.toHaveBeenCalled();
    await scrollTo(850);
    expect(motion.start).toHaveBeenCalledOnce();
    const [frames] = motion.start.mock.calls[0]!;
    expect(frames[0]?.transform).toBe("translateY(8px)");
    const first = motion.start.mock.results[0]!.value;

    await scrollTo(900);
    expect(motion.start).toHaveBeenCalledOnce();

    await scrollTo(0);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(motion.start).toHaveBeenCalledTimes(2);
    const second = motion.start.mock.results[1]!.value;
    await act(() => root.render(null));
    expect(second.cancel).toHaveBeenCalledOnce();
  });

  it("moves the controls immediately in both directions with reduced motion", async () => {
    motion.reducedMotion = true;
    const button = container.querySelector("button")!;
    await scrollTo(50);
    expect(container.querySelector("header")!.contains(button)).toBe(true);
    await scrollTo(0);
    expect(container.querySelector("[data-settings-scope-source]")!.contains(button)).toBe(true);
    expect(motion.start).not.toHaveBeenCalled();
  });

  it("moves the same controls into the toolbar and back without losing their state", async () => {
    const button = container.querySelector("button")!;
    const source = container.querySelector<HTMLElement>("[data-settings-scope-source]")!;
    expect(source.contains(button)).toBe(true);

    await act(() => button.click());
    const search = container.querySelector<HTMLInputElement>("input")!;
    search.value = "demo";
    search.focus();

    await scrollTo(50);

    expect(container.querySelector("header")!.contains(button)).toBe(true);
    expect(container.querySelector("input")).toBe(search);
    expect(search.value).toBe("demo");
    expect(document.activeElement).toBe(search);
    expect(source.style.height).toBe("24px");

    await scrollTo(0);

    expect(source.contains(button)).toBe(true);
    expect(container.querySelector("input")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(source.style.height).toBe("");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("keeps the original position while visible or below the viewport and disconnects on unmount", async () => {
    const source = container.querySelector("[data-settings-scope-source]")!;
    await scrollTo(30);
    expect(source.contains(container.querySelector("button"))).toBe(true);
    sourceTop = 800;
    await act(() => resize());
    expect(source.contains(container.querySelector("button"))).toBe(true);

    await act(() => root.render(null));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("updates the docking threshold when the inline sentence wraps", async () => {
    const source = container.querySelector("[data-settings-scope-source]")!;
    sourceHeight = 52;
    await act(() => resize());

    await scrollTo(60);
    expect(source.contains(container.querySelector("button"))).toBe(true);

    await scrollTo(80);
    expect(container.querySelector("header")!.contains(container.querySelector("button"))).toBe(
      true,
    );
    expect((source as HTMLElement).style.height).toBe("52px");
  });

  it("unpins the sentence when scrolling crosses back before the controls move", async () => {
    const source = container.querySelector<HTMLElement>("[data-settings-scope-source]")!;
    await act(() => {
      const scroll = container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
      scroll.scrollTop = 50;
      scroll.dispatchEvent(new Event("scroll"));
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event("scroll"));
    });
    expect(source.contains(container.querySelector("button"))).toBe(true);
    expect(source.style.height).toBe("");
    expect(motion.start).not.toHaveBeenCalled();
  });

  it("keeps the content still when the sentence changed height while docked", async () => {
    const source = container.querySelector<HTMLElement>("[data-settings-scope-source]")!;
    const scroll = container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
    sourceHeight = 52;
    await act(() => resize());
    await scrollTo(80);
    expect(source.style.height).toBe("52px");

    // Widening the window lets the sentence fit on one line again.
    sourceHeight = 24;
    await act(() => resize());
    await scrollTo(70);

    expect(source.contains(container.querySelector("button"))).toBe(true);
    expect(source.style.height).toBe("");
    expect(scroll.scrollTop).toBe(42);
    await act(() => resize());
    expect(source.contains(container.querySelector("button"))).toBe(true);
  });

  it("releases the toolbar on pages without a scope", async () => {
    await scrollTo(50);
    const toolbar = container.querySelector<HTMLElement>("[data-settings-scope-toolbar]")!;
    expect(toolbar.className).not.toContain("hidden");

    motion.pathname = "/settings/appearance";
    await act(() => root.render(fixture("appearance")));

    expect(container.querySelector("[data-settings-scope-source]")).toBeNull();
    expect(toolbar.className).toContain("hidden");
    expect(container.querySelector("button")).toBeNull();
  });
});
